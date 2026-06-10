/**
 * Stage 3 — radiologist worklist routing / load-balancing.
 *
 * Your most expensive *people* are the radiologists. Mis-routed studies, STAT
 * reads buried under routine, and subspecialty mismatches waste RVUs. This
 * routes a study to the best available radiologist. Pure and testable.
 */

/**
 * @param {object} study - { modality, subspecialty?, urgency? ('stat'|'routine') }
 * @param {Array}  radiologists - [{ id, subspecialties:[], currentLoad, capacity, onShift }]
 * @returns {{ radiologistId: string|null, reason: string, score: number } | null}
 */
export function routeStudy(study = {}, radiologists = []) {
  const available = radiologists.filter((r) => r.onShift !== false && (r.currentLoad ?? 0) < (r.capacity ?? Infinity));
  if (available.length === 0) return null;

  const scored = available.map((r) => {
    let score = 0;
    const reasons = [];

    // Subspecialty match is the strongest signal (read quality + speed).
    if (study.subspecialty && (r.subspecialties ?? []).includes(study.subspecialty)) {
      score += 100;
      reasons.push('subspecialty_match');
    }

    // Prefer the least-loaded radiologist to balance throughput.
    const load = r.currentLoad ?? 0;
    const capacity = r.capacity ?? 1;
    const headroom = (capacity - load) / capacity; // 0..1
    score += headroom * 30;

    // STAT studies prefer whoever can start soonest = most headroom.
    if (study.urgency === 'stat') score += headroom * 20;

    return { radiologistId: r.id, score, reason: reasons.join(',') || 'load_balanced' };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}
