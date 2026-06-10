import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;

import {
  parseGs1, onHand, dailyUsage, expiringLots, fefoPick, stockStatus,
  proposeReorder, ORDER_STATES, canTransitionOrder, transitionOrder,
  evaluateSupplyOrder, SUPPLY_APPROVAL_DOLLARS,
} from '../domain/supply.js';
import { supplies } from '../lib/supplies.js';
import { TOOLS } from '../agent/tools.js';

const GS = String.fromCharCode(29);

// ---- GS1 / UDI parsing — one parser for camera, wedge scanner, and manual entry ----
test('parseGs1: bracketed human-readable UDI', () => {
  assert.deepEqual(parseGs1('(01)00380740000011(17)270331(10)A123B(21)SN9(30)5'), {
    gtin: '00380740000011', expiry: '2027-03-31', lot: 'A123B', serial: 'SN9', qty: 5,
  });
});

test('parseGs1: raw concatenated with FNC1/GS separators (what a DataMatrix scan emits)', () => {
  const raw = `]d201003807400000111727033110A123B${GS}215N9`;
  const parsed = parseGs1(raw);
  assert.equal(parsed.gtin, '00380740000011');
  assert.equal(parsed.expiry, '2027-03-31');
  assert.equal(parsed.lot, 'A123B');
  assert.equal(parsed.serial, '5N9');
});

test('parseGs1: plain GTIN/UPC/EAN normalizes to GTIN-14', () => {
  assert.equal(parseGs1('380740000011').gtin, '00380740000011');  // UPC-A 12
  assert.equal(parseGs1('5012345678900').gtin, '05012345678900'); // EAN-13
  assert.equal(parseGs1('10380740000018').gtin, '10380740000018'); // GTIN-14 case code
});

test('parseGs1: GS1 date rules — DD=00 means end of month; YY>50 means 19xx', () => {
  assert.equal(parseGs1('(01)00380740000011(17)270200').expiry, '2027-02-28');
  assert.equal(parseGs1('(01)00380740000011(17)990101').expiry, '1999-01-01');
});

test('parseGs1: garbage and missing GTIN are rejected', () => {
  assert.equal(parseGs1('hello world'), null);
  assert.equal(parseGs1(''), null);
  assert.equal(parseGs1('(10)LOTONLY'), null);
});

// ---- stock math ----
const LOTS = [
  { lot: 'A', expiry: '2026-07-01', qty: 4 },
  { lot: 'B', expiry: '2026-12-01', qty: 10 },
  { lot: 'C', expiry: null, qty: 3 },
];

test('onHand sums lots; expiringLots flags within-horizon and expired, soonest first', () => {
  assert.equal(onHand(LOTS), 17);
  const now = new Date('2026-06-10');
  const exp = expiringLots([...LOTS, { lot: 'X', expiry: '2026-06-01', qty: 1 }], 90, now);
  assert.deepEqual(exp.map((l) => [l.lot, l.expired]), [['X', true], ['A', false]]);
});

test('fefoPick allocates earliest expiry first, undated last, reports shortfall', () => {
  const { picks, short } = fefoPick(LOTS, 12);
  assert.deepEqual(picks.map((p) => [p.lot, p.take]), [['A', 4], ['B', 8]]);
  assert.equal(short, 0);
  assert.equal(fefoPick(LOTS, 20).short, 3);
});

test('dailyUsage averages use events over the window', () => {
  const now = Date.now();
  const events = [
    { at: new Date(now - 5 * 86_400_000), action: 'use', qty: 15 },
    { at: new Date(now - 10 * 86_400_000), action: 'use', qty: 15 },
    { at: new Date(now - 50 * 86_400_000), action: 'use', qty: 99 }, // outside window
    { at: new Date(now - 2 * 86_400_000), action: 'receive', qty: 99 }, // not consumption
  ];
  assert.equal(dailyUsage(events, 30), 1);
});

test('proposeReorder: below reorder point → par + lead-time demand, rounded to packs', () => {
  const item = { id: 1, gtin: 'g', name: 'Contrast', pack_size: 10, unit_cost: 25, par_level: 30, reorder_point: 12, lead_time_days: 5, restricted: true };
  const lots = [{ lot: 'A', expiry: null, qty: 10 }];
  const events = [{ at: new Date(), action: 'use', qty: 60 }]; // 2/day over 30d window
  const line = proposeReorder(item, lots, events);
  // target = 30 + 2*5 = 40; deficit 30; packs of 10 → 30
  assert.equal(line.qty, 30);
  assert.equal(line.lineTotal, 750);
  assert.equal(line.restricted, true);
  // above reorder point → no proposal
  assert.equal(proposeReorder(item, [{ lot: 'A', expiry: null, qty: 13 }], events), null);
});

test('stockStatus rolls up on-hand, usage, days of supply, and flags', () => {
  const item = { id: 1, gtin: 'g', name: 'X', reorder_point: 5, restricted: false };
  const s = stockStatus(item, [{ lot: 'A', expiry: null, qty: 6 }], [{ at: new Date(), action: 'use', qty: 30 }]);
  assert.equal(s.onHand, 6);
  assert.equal(s.dailyUse, 1);
  assert.equal(s.daysOfSupply, 6);
  assert.equal(s.belowReorder, false);
});

// ---- order lifecycle ----
test('order transitions: legal paths allowed, illegal throw', () => {
  assert.ok(canTransitionOrder('proposed', 'approved'));
  assert.ok(canTransitionOrder('approved', 'placed'));
  assert.ok(canTransitionOrder('placed', 'received'));
  assert.ok(!canTransitionOrder('received', 'proposed'));
  assert.ok(!canTransitionOrder('cancelled', 'approved'));
  const updated = transitionOrder({ status: 'proposed', history: [] }, 'approved', { by: 'x' });
  assert.equal(updated.status, 'approved');
  assert.equal(updated.history[0].by, 'x');
  assert.throws(() => transitionOrder({ status: 'received' }, 'placed'), /illegal order transition/);
});

// ---- the gates ----
test('gates: restricted items and high-dollar orders require human confirmation', () => {
  const restricted = evaluateSupplyOrder({ lines: [{ itemId: 1, qty: 2, lineTotal: 50, restricted: true }], total_cost: 50 });
  assert.deepEqual(restricted, { allow: true, requiresHumanApproval: true, reason: 'restricted_item' });

  const big = evaluateSupplyOrder({ lines: [{ itemId: 1, qty: 100, lineTotal: SUPPLY_APPROVAL_DOLLARS, restricted: false }], total_cost: SUPPLY_APPROVAL_DOLLARS });
  assert.equal(big.requiresHumanApproval, true);
  assert.equal(big.reason, 'high_value_order');

  const small = evaluateSupplyOrder({ lines: [{ itemId: 1, qty: 5, lineTotal: 60, restricted: false }], total_cost: 60 });
  assert.deepEqual(small, { allow: true, requiresHumanApproval: false, reason: 'within_auto_limits' });
});

test('gates: duplicates and budget breaches are blocked outright', () => {
  const dup = evaluateSupplyOrder(
    { lines: [{ itemId: 7, qty: 1, lineTotal: 10 }], total_cost: 10 },
    { openOrderItemIds: [7] }
  );
  assert.deepEqual(dup, { allow: false, requiresHumanApproval: false, reason: 'duplicate_open_order' });

  const broke = evaluateSupplyOrder(
    { lines: [{ itemId: 1, qty: 1, lineTotal: 300 }], total_cost: 300 },
    { periodSpend: 900, budgetCap: 1000 }
  );
  assert.equal(broke.allow, false);
  assert.equal(broke.reason, 'budget_cap_exceeded');

  assert.equal(evaluateSupplyOrder({ lines: [], total_cost: 0 }).allow, false);
});

// ---- the store + agent tools, end to end on the memory backend ----
test('supply store flow: register, receive lots, FEFO use, agent proposes a gated order', async () => {
  const item = await supplies.upsertItem({
    gtin: '00380740000011', name: 'Iohexol 350 50ml', category: 'contrast',
    pack_size: 10, unit_cost: 25, par_level: 30, reorder_point: 12, lead_time_days: 5, restricted: true,
  });
  await supplies.adjustLot(item.id, 'A123', '2026-08-01', 10);
  await supplies.recordEvent({ itemId: item.id, lot: 'A123', action: 'receive', qty: 10, actor: 't' });
  await supplies.recordEvent({ itemId: item.id, lot: 'A123', action: 'use', qty: 6, actor: 't' });
  await supplies.adjustLot(item.id, 'A123', '2026-08-01', -6);

  // agent senses
  const levels = await TOOLS.check_supply_levels.handler({ services: { supplies } });
  assert.equal(levels.belowReorder.length, 1);
  assert.equal(levels.belowReorder[0].onHand, 4);

  // agent hands: proposes; restricted → requires human approval, never auto
  const result = await TOOLS.propose_supply_order.handler({ input: { gtin: item.gtin }, services: { supplies } });
  assert.equal(result.proposed, true);
  assert.equal(result.requiresHumanApproval, true);
  assert.equal(result.gate, 'restricted_item');

  const order = await supplies.getOrder(result.orderId);
  assert.equal(order.status, 'proposed'); // money has not moved
  assert.equal(order.created_by, 'agent');

  // a second proposal for the same item is blocked as a duplicate
  const dup = await TOOLS.propose_supply_order.handler({ input: { gtin: item.gtin }, services: { supplies } });
  assert.equal(dup.blocked, true);
  assert.equal(dup.reason, 'duplicate_open_order');

  // human confirms → approve → place
  const approved = await supplies.updateOrder(order.id, { ...transitionOrder(order, ORDER_STATES.APPROVED, { by: 'human' }), approved_by: 'human' });
  assert.equal(approved.status, 'approved');
  const placed = await supplies.updateOrder(order.id, transitionOrder(approved, ORDER_STATES.PLACED, { by: 'human' }));
  assert.equal(placed.status, 'placed');
  assert.equal(placed.history.length, 3);
});
