/**
 * Supply chain — UDI/GS1-native inventory and gated automated ordering.
 *
 * Pure pieces, in the house style:
 *   1. A GS1 parser — every FDA-regulated medical product carries a UDI
 *      barcode (usually GS1 DataMatrix) encoding GTIN + expiry + lot. One
 *      parser serves BOTH capture methods: a phone camera (BarcodeDetector)
 *      and any dedicated scanner (which acts as a keyboard and "types" the
 *      same string). Hardware choice becomes a non-decision.
 *   2. Stock math — on-hand by lot, usage rate, days of supply, expiry
 *      alerting, FEFO (first-expiry-first-out) picking, reorder proposals.
 *   3. An order lifecycle state machine + the GATES: automated ordering
 *      proposes; policy decides whether a human must confirm. Restricted
 *      items and high-dollar orders always require approval; duplicate open
 *      orders and budget breaches are blocked outright.
 */

// ---------------------------------------------------------------------------
// GS1 / UDI parsing
// ---------------------------------------------------------------------------

const GS = String.fromCharCode(29); // FNC1 group separator in raw scans

// Application Identifiers we care about: fixed length or variable (null).
const AIS = {
  '01': { field: 'gtin', len: 14 },
  '11': { field: 'producedOn', len: 6 },
  '17': { field: 'expiry', len: 6 },
  '10': { field: 'lot', len: null },
  '21': { field: 'serial', len: null },
  '30': { field: 'qty', len: null, max: 8 },
};

/** GS1 date YYMMDD → ISO. Years 00-50 → 20xx, 51-99 → 19xx; DD=00 → month end. */
function gs1Date(s) {
  if (!/^\d{6}$/.test(s)) return null;
  const yy = Number(s.slice(0, 2));
  const year = yy <= 50 ? 2000 + yy : 1900 + yy;
  const month = Number(s.slice(2, 4));
  let day = Number(s.slice(4, 6));
  if (month < 1 || month > 12) return null;
  if (day === 0) day = new Date(Date.UTC(year, month, 0)).getUTCDate(); // last day of month
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function finish(fields) {
  if (!fields.gtin) return null;
  return {
    gtin: fields.gtin,
    expiry: fields.expiry ? gs1Date(fields.expiry) : null,
    lot: fields.lot ?? null,
    serial: fields.serial ?? null,
    qty: fields.qty != null && /^\d+$/.test(fields.qty) ? Number(fields.qty) : null,
  };
}

/**
 * Parse a scanned code: raw GS1 (with FNC1/GS separators), human-readable
 * bracketed GS1 "(01)...(17)...(10)...", or a plain GTIN/UPC/EAN.
 * Returns { gtin, expiry, lot, serial, qty } or null if unrecognized.
 */
export function parseGs1(code) {
  let s = String(code ?? '').trim();
  if (!s) return null;
  // Strip symbology identifiers a camera API may include.
  s = s.replace(/^\](d2|C1|Q3|e0)/, '');

  // Plain GTIN-12/13/14 (UPC-A / EAN-13 / case code) → normalize to GTIN-14.
  if (/^\d{12,14}$/.test(s)) {
    return finish({ gtin: s.padStart(14, '0') });
  }

  // Human-readable bracketed form.
  if (s.startsWith('(')) {
    const fields = {};
    for (const m of s.matchAll(/\((\d{2,4})\)([^(]*)/g)) {
      const ai = AIS[m[1]];
      if (ai) fields[ai.field] = m[2].trim();
    }
    return finish(fields);
  }

  // Raw concatenated form: walk AIs; fixed-length read n chars, variable
  // read to the next GS separator (or end of string).
  if (/^\d{2}/.test(s)) {
    const fields = {};
    let i = 0;
    while (i < s.length - 1) {
      if (s[i] === GS) { i++; continue; }
      const ai = AIS[s.slice(i, i + 2)];
      if (!ai) break;
      i += 2;
      let value;
      if (ai.len != null) {
        value = s.slice(i, i + ai.len);
        i += ai.len;
      } else {
        const end = s.indexOf(GS, i);
        value = end === -1 ? s.slice(i) : s.slice(i, end);
        if (ai.max) value = value.slice(0, ai.max);
        i = end === -1 ? s.length : end;
      }
      fields[ai.field] = value;
    }
    return finish(fields);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Stock math
// ---------------------------------------------------------------------------

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function onHand(lots = []) {
  return lots.reduce((s, l) => s + num(l.qty), 0);
}

/** Average daily consumption from `use` events over a trailing window. */
export function dailyUsage(events = [], windowDays = 30) {
  const cutoff = Date.now() - windowDays * 86_400_000;
  const used = events
    .filter((e) => e.action === 'use' && new Date(e.at).getTime() >= cutoff)
    .reduce((s, e) => s + Math.abs(num(e.qty)), 0);
  return used / windowDays;
}

/** Lots expiring within `withinDays` (and already expired), soonest first. */
export function expiringLots(lots = [], withinDays = 90, now = new Date()) {
  const horizon = now.getTime() + withinDays * 86_400_000;
  return lots
    .filter((l) => l.expiry && num(l.qty) > 0 && new Date(l.expiry).getTime() <= horizon)
    .map((l) => ({ ...l, expired: new Date(l.expiry).getTime() < now.getTime() }))
    .sort((a, b) => new Date(a.expiry) - new Date(b.expiry));
}

/** FEFO: allocate `qty` from the lots expiring first. Returns [{lot, expiry, take}]. */
export function fefoPick(lots = [], qty) {
  const usable = lots
    .filter((l) => num(l.qty) > 0)
    .sort((a, b) => {
      if (!a.expiry && !b.expiry) return 0;
      if (!a.expiry) return 1; // undated lots last
      if (!b.expiry) return -1;
      return new Date(a.expiry) - new Date(b.expiry);
    });
  const picks = [];
  let remaining = qty;
  for (const l of usable) {
    if (remaining <= 0) break;
    const take = Math.min(num(l.qty), remaining);
    picks.push({ lot: l.lot, expiry: l.expiry, take });
    remaining -= take;
  }
  return { picks, short: Math.max(0, remaining) };
}

/** Roll an item's lots + usage into the status the dashboard (and agent) read. */
export function stockStatus(item, lots = [], events = [], now = new Date()) {
  const have = onHand(lots);
  const use = dailyUsage(events);
  return {
    itemId: item.id,
    gtin: item.gtin,
    name: item.name,
    onHand: have,
    dailyUse: Number(use.toFixed(2)),
    daysOfSupply: use > 0 ? Number((have / use).toFixed(1)) : null,
    belowReorder: have <= num(item.reorder_point),
    expiring: expiringLots(lots, 90, now),
    restricted: Boolean(item.restricted),
  };
}

/**
 * Reorder proposal: bring stock back to par PLUS expected consumption over
 * the vendor lead time, rounded up to whole packs. Null when above the
 * reorder point.
 */
export function proposeReorder(item, lots = [], events = []) {
  const have = onHand(lots);
  if (have > num(item.reorder_point)) return null;
  const use = dailyUsage(events);
  const target = num(item.par_level) + use * num(item.lead_time_days);
  const deficit = Math.max(0, target - have);
  if (deficit === 0) return null;
  const pack = Math.max(1, num(item.pack_size));
  const qty = Math.ceil(deficit / pack) * pack;
  const unitCost = num(item.unit_cost);
  return {
    itemId: item.id,
    gtin: item.gtin,
    name: item.name,
    qty,
    unitCost,
    lineTotal: Number((qty * unitCost).toFixed(2)),
    restricted: Boolean(item.restricted),
  };
}

// ---------------------------------------------------------------------------
// Order lifecycle
// ---------------------------------------------------------------------------

export const ORDER_STATES = Object.freeze({
  PROPOSED: 'proposed',   // system- or agent-generated, awaiting gates/human
  APPROVED: 'approved',   // confirmed (by a human, or by gates when allowed)
  PLACED: 'placed',       // sent to the vendor (async job seam)
  RECEIVED: 'received',   // stock arrived (incremented via receive scans)
  CANCELLED: 'cancelled',
});

const ORDER_TRANSITIONS = {
  proposed: ['approved', 'cancelled'],
  approved: ['placed', 'cancelled'],
  placed: ['received', 'cancelled'],
  received: [],
  cancelled: [],
};

export function canTransitionOrder(from, to) {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

export function transitionOrder(order, to, detail = {}) {
  const from = order.status ?? ORDER_STATES.PROPOSED;
  if (!canTransitionOrder(from, to)) {
    throw new Error(`illegal order transition ${from} -> ${to}`);
  }
  return {
    status: to,
    history: [...(order.history ?? []), { from, to, at: new Date().toISOString(), ...detail }],
  };
}

// ---------------------------------------------------------------------------
// The gates — automated ordering proposes; policy decides who confirms.
// Mirrors agent/policy.js: a pure decision the route/agent layer enforces.
// ---------------------------------------------------------------------------

export const SUPPLY_APPROVAL_DOLLARS = 500;

/**
 * @param {object} order - { lines: [{itemId, qty, unitCost, lineTotal, restricted}], total_cost }
 * @param {object} ctx   - { openOrderItemIds?: Set|array, periodSpend?: number, budgetCap?: number }
 * @returns {{ allow, requiresHumanApproval, reason }}
 */
export function evaluateSupplyOrder(order, ctx = {}) {
  const lines = order.lines ?? [];
  const total = num(order.total_cost ?? lines.reduce((s, l) => s + num(l.lineTotal), 0));

  // Hard blocks first.
  const open = new Set([...(ctx.openOrderItemIds ?? [])].map(Number));
  if (lines.some((l) => open.has(Number(l.itemId)))) {
    return { allow: false, requiresHumanApproval: false, reason: 'duplicate_open_order' };
  }
  if (ctx.budgetCap != null && num(ctx.periodSpend) + total > num(ctx.budgetCap)) {
    return { allow: false, requiresHumanApproval: false, reason: 'budget_cap_exceeded' };
  }
  if (!lines.length || lines.some((l) => num(l.qty) <= 0)) {
    return { allow: false, requiresHumanApproval: false, reason: 'invalid_lines' };
  }

  // Confirmation gates.
  if (lines.some((l) => l.restricted)) {
    return { allow: true, requiresHumanApproval: true, reason: 'restricted_item' };
  }
  if (total >= SUPPLY_APPROVAL_DOLLARS) {
    return { allow: true, requiresHumanApproval: true, reason: 'high_value_order' };
  }
  return { allow: true, requiresHumanApproval: false, reason: 'within_auto_limits' };
}
