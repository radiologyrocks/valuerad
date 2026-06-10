/**
 * Stage 1 — scheduling domain logic (magnet utilization, not just booking).
 *
 * Pure, deterministic, testable functions. No I/O, no EHR calls. The routes /
 * agent tools call these and then act through the SchedulingClient.
 *
 * The goal is utilization of the scanner, so the logic optimizes for filling
 * the most expensive idle capacity, not merely "find any slot".
 */

// ---------------------------------------------------------------------------
// No-show risk — a transparent, explainable heuristic (NOT a black-box model).
// Returns { score: 0..1, band: 'low'|'medium'|'high', factors: [...] }.
// Every factor is human-readable so a scheduler can see *why*.
// ---------------------------------------------------------------------------
export function noShowRisk(patient = {}) {
  const factors = [];
  let score = 0.1; // base rate

  const priorNoShows = Number(patient.priorNoShows ?? 0);
  if (priorNoShows > 0) {
    const add = Math.min(0.4, priorNoShows * 0.15);
    score += add;
    factors.push({ factor: 'prior_no_shows', value: priorNoShows, weight: add });
  }

  const leadDays = Number(patient.leadTimeDays ?? 7);
  if (leadDays > 21) {
    score += 0.15;
    factors.push({ factor: 'long_lead_time', value: leadDays, weight: 0.15 });
  }

  const priorReschedules = Number(patient.priorReschedules ?? 0);
  if (priorReschedules >= 2) {
    score += 0.1;
    factors.push({ factor: 'frequent_reschedules', value: priorReschedules, weight: 0.1 });
  }

  if (patient.confirmedReminder === false) {
    score += 0.1;
    factors.push({ factor: 'no_reminder_confirmation', value: true, weight: 0.1 });
  }

  // Early-morning and late-Friday slots historically miss more often.
  if (patient.slotHour != null && (patient.slotHour < 8 || patient.slotHour >= 17)) {
    score += 0.05;
    factors.push({ factor: 'edge_of_day_slot', value: patient.slotHour, weight: 0.05 });
  }

  score = Math.max(0, Math.min(1, score));
  const band = score >= 0.5 ? 'high' : score >= 0.25 ? 'medium' : 'low';
  return { score: Number(score.toFixed(3)), band, factors };
}

// ---------------------------------------------------------------------------
// Slot selection for utilization. Given free slots and a requested study,
// rank slots to (a) fit the required duration, (b) minimize idle gaps by
// packing against existing booked slots, (c) prefer the earliest qualifying
// slot (faster diagnosis + sooner revenue).
//
// slots: [{ id, start (ISO), end (ISO), modality }]
// request: { modality, durationMin, earliest?, latest? }
// neighbors: booked [{ start, end }] used to score gap-packing (optional)
// ---------------------------------------------------------------------------
export function rankSlots(slots, request, neighbors = []) {
  const durMs = (request.durationMin ?? 30) * 60_000;
  const earliest = request.earliest ? Date.parse(request.earliest) : -Infinity;
  const latest = request.latest ? Date.parse(request.latest) : Infinity;

  const candidates = slots
    .filter((s) => !request.modality || s.modality === request.modality)
    .map((s) => ({ ...s, _start: Date.parse(s.start), _end: Date.parse(s.end) }))
    .filter((s) => s._end - s._start >= durMs)
    .filter((s) => s._start >= earliest && s._start <= latest);

  const scored = candidates.map((s) => {
    // Earlier is better (sooner care + revenue): normalize by recency.
    const earlierScore = -s._start;
    // Gap-packing: reward slots adjacent to an existing booking (less idle time).
    const adjacency = neighbors.some(
      (n) => Math.abs(Date.parse(n.end) - s._start) <= 5 * 60_000 ||
             Math.abs(s._end - Date.parse(n.start)) <= 5 * 60_000
    )
      ? 1
      : 0;
    return { slot: s, adjacency, earlierScore };
  });

  scored.sort((a, b) => b.adjacency - a.adjacency || b.earlierScore - a.earlierScore);
  return scored.map((x) => ({ id: x.slot.id, start: x.slot.start, end: x.slot.end, adjacency: x.adjacency }));
}

// ---------------------------------------------------------------------------
// Waitlist backfill — when a slot opens (cancel/no-show), find the best
// waitlisted patient who can take it. Maximizes utilization recovery.
//
// openSlot: { start, end, modality }
// waitlist: [{ patientId, modality, availableFrom?, availableTo?, priority?, addedAt }]
// ---------------------------------------------------------------------------
export function bestBackfill(openSlot, waitlist) {
  const slotStart = Date.parse(openSlot.start);
  const slotEnd = Date.parse(openSlot.end);

  const eligible = waitlist.filter((w) => {
    if (openSlot.modality && w.modality && w.modality !== openSlot.modality) return false;
    if (w.availableFrom && Date.parse(w.availableFrom) > slotStart) return false;
    if (w.availableTo && Date.parse(w.availableTo) < slotEnd) return false;
    return true;
  });

  if (eligible.length === 0) return null;

  // Higher clinical priority first, then longest-waiting (FIFO fairness).
  eligible.sort(
    (a, b) =>
      (b.priority ?? 0) - (a.priority ?? 0) ||
      Date.parse(a.addedAt ?? 0) - Date.parse(b.addedAt ?? 0)
  );
  return eligible[0];
}
