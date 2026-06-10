/**
 * Supply chain endpoints — scan-driven inventory + gated automated ordering.
 *
 *   POST /api/supplies/scan            { code, action: receive|use, qty? } — the single intake
 *                                      for phone-camera scans, wedge scanners, and manual entry
 *   GET  /api/supplies                 items with stock status, expiring lots, open orders
 *   POST /api/supplies/items           register/configure an item (par, reorder point, cost…)
 *   GET  /api/supplies/orders?status=
 *   POST /api/supplies/orders/propose  scan the shelf: propose orders for everything below reorder
 *   POST /api/supplies/orders/:id/approve | place | receive | cancel
 *
 * The automation contract: scans and the propose sweep CREATE proposals;
 * the gates (domain/supply.js#evaluateSupplyOrder) decide whether a human
 * must confirm. Auto-approval of in-gate orders is opt-in
 * (SUPPLY_AUTO_APPROVE=true) and never covers restricted or high-dollar
 * lines. Placing enqueues the vendor job (the EDI/punchout seam). Every
 * mutation is audited.
 */

import { Router } from 'express';
import { requireRole, ROLES } from '../lib/rbac.js';
import { store } from '../lib/store.js';
import { queue } from '../lib/jobs.js';
import { supplies, suppliesBackend } from '../lib/supplies.js';
import {
  parseGs1, stockStatus, fefoPick, proposeReorder,
  ORDER_STATES, transitionOrder, evaluateSupplyOrder,
} from '../domain/supply.js';

const router = Router();
const staff = requireRole(ROLES.SCHEDULER, ROLES.AUTH_SPECIALIST, ROLES.RADIOLOGIST, ROLES.ADMIN, ROLES.EXECUTIVE);
const approver = requireRole(ROLES.ADMIN, ROLES.EXECUTIVE);

async function audit(req, action, resource, detail = {}, outcome = 'success') {
  await store.audit({ actor: req.user?.id ?? 'system', action, resource, outcome, detail });
}

/** Create a proposal for one item if it's below reorder and not already on order. */
async function maybePropose(req, item) {
  const [lots, events, openIds] = await Promise.all([
    supplies.lotsForItem(item.id),
    supplies.eventsForItem(item.id),
    supplies.openOrderItemIds(),
  ]);
  const line = proposeReorder(item, lots, events);
  if (!line) return null;

  const draft = { lines: [line], total_cost: line.lineTotal };
  const decision = evaluateSupplyOrder(draft, { openOrderItemIds: openIds });
  if (!decision.allow) return null; // duplicate open order etc. — nothing to do

  const order = await supplies.createOrder({
    ...draft,
    vendor: item.vendor,
    created_by: 'system:reorder',
    history: [{ from: null, to: 'proposed', at: new Date().toISOString(), trigger: req.user?.id, reason: decision.reason }],
  });
  await audit(req, 'supply.order_proposed', `supply_order/${order.id}`, { item: item.name, qty: line.qty, total: line.lineTotal, gate: decision.reason });

  // Opt-in auto-approval: only when the gates say no human confirmation is
  // needed. Restricted/high-dollar always waits for a person.
  if (!decision.requiresHumanApproval && process.env.SUPPLY_AUTO_APPROVE === 'true') {
    const updates = transitionOrder(order, ORDER_STATES.APPROVED, { by: 'system:gates', gate: decision.reason });
    const approved = await supplies.updateOrder(order.id, { ...updates, approved_by: 'system:gates' });
    await audit(req, 'supply.order_approved', `supply_order/${order.id}`, { by: 'system:gates' });
    return approved;
  }
  return order;
}

// ---------------------------------------------------------------------------
// Scanning — one intake for camera, wedge scanner, and manual entry
// ---------------------------------------------------------------------------

router.post('/supplies/scan', staff, async (req, res) => {
  const { code, action = 'receive', qty } = req.body ?? {};
  const parsed = parseGs1(code);
  if (!parsed) return res.status(400).json({ error: 'unrecognized_code', detail: 'not a GS1/UDI barcode or GTIN' });
  if (!['receive', 'use'].includes(action)) return res.status(400).json({ error: "action must be 'receive' or 'use'" });

  try {
    const item = await supplies.getItemByGtin(parsed.gtin);
    if (!item) {
      // Unknown product: hand the parsed payload back so the UI can register it.
      return res.status(404).json({ error: 'unknown_item', parsed });
    }

    const count = Number(qty ?? parsed.qty ?? 1);
    if (!Number.isInteger(count) || count <= 0) return res.status(400).json({ error: 'qty must be a positive integer' });

    if (action === 'receive') {
      await supplies.adjustLot(item.id, parsed.lot, parsed.expiry, count);
      await supplies.recordEvent({ itemId: item.id, lot: parsed.lot, action: 'receive', qty: count, actor: req.user.id });
    } else {
      // FEFO consume — prefer the scanned lot when stock exists there.
      const lots = await supplies.lotsForItem(item.id);
      const scannedLot = parsed.lot != null ? lots.find((l) => l.lot === parsed.lot) : null;
      const { picks, short } = scannedLot && scannedLot.qty >= count
        ? { picks: [{ lot: scannedLot.lot, expiry: scannedLot.expiry, take: count }], short: 0 }
        : fefoPick(lots, count);
      if (short > 0) return res.status(409).json({ error: 'insufficient_stock', onHand: count - short });
      for (const p of picks) {
        await supplies.adjustLot(item.id, p.lot, p.expiry, -p.take);
        await supplies.recordEvent({ itemId: item.id, lot: p.lot, action: 'use', qty: p.take, actor: req.user.id });
      }
    }
    await audit(req, `supply.${action}`, `supply_item/${item.gtin}`, { name: item.name, qty: count, lot: parsed.lot, expiry: parsed.expiry });

    const [lots, events] = await Promise.all([supplies.lotsForItem(item.id), supplies.eventsForItem(item.id)]);
    const status = stockStatus(item, lots, events);
    // Consumption can trip the reorder point — that's the automation trigger.
    const reorder = action === 'use' && status.belowReorder ? await maybePropose(req, item) : null;
    return res.json({ parsed, item: { id: item.id, name: item.name }, action, qty: count, stock: status, ...(reorder ? { reorder } : {}) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Items + stock
// ---------------------------------------------------------------------------

router.get('/supplies', staff, async (_req, res) => {
  try {
    const items = await supplies.listItems();
    const stock = [];
    for (const item of items) {
      const [lots, events] = await Promise.all([supplies.lotsForItem(item.id), supplies.eventsForItem(item.id)]);
      stock.push({ ...stockStatus(item, lots, events), parLevel: item.par_level, reorderPoint: item.reorder_point, unitCost: Number(item.unit_cost) });
    }
    const openOrders = (await supplies.listOrders()).filter((o) => ['proposed', 'approved', 'placed'].includes(o.status));
    return res.json({ backend: suppliesBackend, items: stock, openOrders });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/supplies/items', approver, async (req, res) => {
  const { gtin, name } = req.body ?? {};
  const normalized = parseGs1(gtin)?.gtin;
  if (!normalized) return res.status(400).json({ error: 'gtin must be a valid GTIN or GS1 code' });
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  try {
    const item = await supplies.upsertItem({ ...req.body, gtin: normalized });
    await audit(req, 'supply.item_configured', `supply_item/${item.gtin}`, { name: item.name, par: item.par_level, reorder: item.reorder_point, restricted: item.restricted });
    return res.status(201).json({ item });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Orders — propose, confirm (gates), place, receive
// ---------------------------------------------------------------------------

router.get('/supplies/orders', staff, async (req, res) => {
  try {
    return res.json({ orders: await supplies.listOrders({ status: req.query.status }) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/supplies/orders/propose', approver, async (req, res) => {
  try {
    const proposals = [];
    for (const item of await supplies.listItems()) {
      const order = await maybePropose(req, item);
      if (order) proposals.push(order);
    }
    return res.json({ proposed: proposals });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

async function loadOrder(req, res) {
  const order = await supplies.getOrder(req.params.id);
  if (!order) {
    res.status(404).json({ error: 'order not found' });
    return null;
  }
  return order;
}

router.post('/supplies/orders/:id/approve', approver, async (req, res) => {
  try {
    const order = await loadOrder(req, res);
    if (!order) return;
    // Re-run the gates at confirmation time: stock and budgets move.
    const openIds = (await supplies.openOrderItemIds()).filter(
      (id) => !order.lines.some((l) => Number(l.itemId) === id) // exclude this order itself
    );
    const decision = evaluateSupplyOrder(order, { openOrderItemIds: openIds, ...req.body?.ctx });
    if (!decision.allow) {
      await audit(req, 'supply.order_blocked', `supply_order/${order.id}`, { reason: decision.reason }, 'error');
      return res.status(422).json({ error: decision.reason });
    }
    const updates = transitionOrder(order, ORDER_STATES.APPROVED, { by: req.user.id, gate: decision.reason });
    const updated = await supplies.updateOrder(order.id, { ...updates, approved_by: req.user.id });
    await audit(req, 'supply.order_approved', `supply_order/${order.id}`, { gate: decision.reason, total: order.total_cost });
    return res.json({ order: updated, gate: decision });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/supplies/orders/:id/place', approver, async (req, res) => {
  try {
    const order = await loadOrder(req, res);
    if (!order) return;
    const updates = transitionOrder(order, ORDER_STATES.PLACED, { by: req.user.id });
    const updated = await supplies.updateOrder(order.id, updates);
    // The vendor integration seam: EDI/punchout/email lives behind the job queue.
    const jobId = await queue.enqueue('place_supply_order', { orderId: order.id, vendor: order.vendor, lines: order.lines });
    await audit(req, 'supply.order_placed', `supply_order/${order.id}`, { jobId, vendor: order.vendor });
    return res.json({ order: updated, jobId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/supplies/orders/:id/receive', staff, async (req, res) => {
  try {
    const order = await loadOrder(req, res);
    if (!order) return;
    const updates = transitionOrder(order, ORDER_STATES.RECEIVED, { by: req.user.id });
    const updated = await supplies.updateOrder(order.id, updates);
    await audit(req, 'supply.order_received', `supply_order/${order.id}`, {});
    // Stock itself increments via receive scans — the order just closes the loop.
    return res.json({ order: updated, note: 'scan items in with action=receive to add stock' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/supplies/orders/:id/cancel', approver, async (req, res) => {
  try {
    const order = await loadOrder(req, res);
    if (!order) return;
    const updates = transitionOrder(order, ORDER_STATES.CANCELLED, { by: req.user.id, reason: req.body?.reason });
    const updated = await supplies.updateOrder(order.id, updates);
    await audit(req, 'supply.order_cancelled', `supply_order/${order.id}`, { reason: req.body?.reason });
    return res.json({ order: updated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export { router as suppliesRouter };
