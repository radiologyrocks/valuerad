/**
 * Supply store — items, expiry-tracked lots, the append-only movement
 * ledger, and orders. Postgres + memory backends behind one interface,
 * like every other store in lib/.
 */

import { pool, databaseEnabled } from './db.js';

class PostgresSupplies {
  async upsertItem(item) {
    const { rows } = await pool.query(
      `INSERT INTO supply_items (gtin, name, category, unit, pack_size, unit_cost, par_level, reorder_point, lead_time_days, vendor, restricted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (gtin) DO UPDATE SET
         name=EXCLUDED.name, category=EXCLUDED.category, unit=EXCLUDED.unit,
         pack_size=EXCLUDED.pack_size, unit_cost=EXCLUDED.unit_cost,
         par_level=EXCLUDED.par_level, reorder_point=EXCLUDED.reorder_point,
         lead_time_days=EXCLUDED.lead_time_days, vendor=EXCLUDED.vendor,
         restricted=EXCLUDED.restricted
       RETURNING *`,
      [
        item.gtin, item.name, item.category ?? null, item.unit ?? null,
        item.pack_size ?? 1, item.unit_cost ?? 0, item.par_level ?? 0,
        item.reorder_point ?? 0, item.lead_time_days ?? 7, item.vendor ?? null,
        Boolean(item.restricted),
      ]
    );
    return rows[0];
  }

  async getItemByGtin(gtin) {
    const { rows } = await pool.query('SELECT * FROM supply_items WHERE gtin = $1', [gtin]);
    return rows[0] ?? null;
  }

  async getItem(id) {
    const { rows } = await pool.query('SELECT * FROM supply_items WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async listItems() {
    const { rows } = await pool.query('SELECT * FROM supply_items WHERE is_active ORDER BY name');
    return rows;
  }

  async adjustLot(itemId, lot, expiry, delta) {
    // A negative delta (consume) is a conditional decrement: only succeeds if
    // the lot has enough on hand. Zero rows back ⇒ insufficient stock. This,
    // plus CHECK(qty>=0), prevents the oversell race two concurrent scans
    // would otherwise cause. (Receives use the upsert path.)
    if (delta < 0) {
      const { rows } = await pool.query(
        `UPDATE supply_lots SET qty = qty + $4, updated_at = now()
         WHERE item_id = $1 AND lot = $2 AND expiry IS NOT DISTINCT FROM $3 AND qty + $4 >= 0
         RETURNING *`,
        [itemId, lot ?? '', expiry ?? null, delta]
      );
      if (!rows[0]) throw new Error('insufficient_stock');
      return rows[0];
    }
    const { rows } = await pool.query(
      `INSERT INTO supply_lots (item_id, lot, expiry, qty) VALUES ($1,$2,$3,$4)
       ON CONFLICT (item_id, lot, expiry)
       DO UPDATE SET qty = supply_lots.qty + EXCLUDED.qty, updated_at = now()
       RETURNING *`,
      [itemId, lot ?? '', expiry ?? null, delta]
    );
    return rows[0];
  }

  async lotsForItem(itemId) {
    const { rows } = await pool.query(
      'SELECT id, lot, expiry::text AS expiry, qty FROM supply_lots WHERE item_id = $1 AND qty <> 0 ORDER BY expiry NULLS LAST',
      [itemId]
    );
    return rows;
  }

  async recordEvent(event) {
    await pool.query(
      `INSERT INTO supply_events (item_id, lot, action, qty, actor, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
      [event.itemId, event.lot ?? null, event.action, event.qty, event.actor ?? null, event.detail ?? null]
    );
  }

  async eventsForItem(itemId, windowDays = 60) {
    const { rows } = await pool.query(
      `SELECT at, action, qty FROM supply_events
       WHERE item_id = $1 AND at >= now() - ($2::int * interval '1 day') ORDER BY at`,
      [itemId, windowDays]
    );
    return rows;
  }

  async createOrder(order) {
    const { rows } = await pool.query(
      `INSERT INTO supply_orders (status, lines, total_cost, vendor, created_by, history)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        order.status ?? 'proposed', JSON.stringify(order.lines), order.total_cost,
        order.vendor ?? null, order.created_by ?? null, JSON.stringify(order.history ?? []),
      ]
    );
    return rows[0];
  }

  async getOrder(id) {
    const { rows } = await pool.query('SELECT * FROM supply_orders WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async listOrders({ status } = {}) {
    const { rows } = status
      ? await pool.query('SELECT * FROM supply_orders WHERE status = $1 ORDER BY id DESC', [status])
      : await pool.query('SELECT * FROM supply_orders ORDER BY id DESC');
    return rows;
  }

  async updateOrder(id, patch) {
    const sets = [];
    const args = [id];
    for (const [col, val] of Object.entries(patch)) {
      args.push(col === 'history' || col === 'lines' ? JSON.stringify(val) : val);
      sets.push(`${col} = $${args.length}`);
    }
    const { rows } = await pool.query(
      `UPDATE supply_orders SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      args
    );
    return rows[0] ?? null;
  }

  /** Item ids appearing in any open (proposed/approved/placed) order. */
  async openOrderItemIds() {
    const { rows } = await pool.query(
      `SELECT lines FROM supply_orders WHERE status IN ('proposed','approved','placed')`
    );
    return rows.flatMap((r) => (r.lines ?? []).map((l) => Number(l.itemId)));
  }
}

class MemorySupplies {
  constructor() {
    this.items = [];
    this.lots = [];
    this.events = [];
    this.orders = [];
    this._seq = { item: 0, lot: 0, order: 0 };
  }

  async upsertItem(item) {
    const defaults = {
      category: null, unit: null, pack_size: 1, unit_cost: 0, par_level: 0,
      reorder_point: 0, lead_time_days: 7, vendor: null, restricted: false,
    };
    const existing = this.items.find((i) => i.gtin === item.gtin);
    if (existing) {
      Object.assign(existing, defaults, item, { id: existing.id, is_active: true });
      return { ...existing };
    }
    const row = { id: ++this._seq.item, is_active: true, created_at: new Date(), ...defaults, ...item, restricted: Boolean(item.restricted) };
    this.items.push(row);
    return { ...row };
  }

  async getItemByGtin(gtin) {
    const row = this.items.find((i) => i.gtin === gtin);
    return row ? { ...row } : null;
  }

  async getItem(id) {
    const row = this.items.find((i) => i.id === Number(id));
    return row ? { ...row } : null;
  }

  async listItems() {
    return this.items.filter((i) => i.is_active).map((i) => ({ ...i })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async adjustLot(itemId, lot, expiry, delta) {
    const key = (l) => l.item_id === Number(itemId) && l.lot === (lot ?? '') && (l.expiry ?? null) === (expiry ?? null);
    let row = this.lots.find(key);
    if (!row) {
      row = { id: ++this._seq.lot, item_id: Number(itemId), lot: lot ?? '', expiry: expiry ?? null, qty: 0 };
      this.lots.push(row);
    }
    // Mirror the PG CHECK(qty>=0) so the unit suite catches oversell, not just
    // the integration suite (the backends must agree on this invariant).
    if (row.qty + delta < 0) throw new Error('insufficient_stock');
    row.qty += delta;
    row.updated_at = new Date();
    return { ...row };
  }

  async lotsForItem(itemId) {
    return this.lots
      .filter((l) => l.item_id === Number(itemId) && l.qty !== 0)
      .map((l) => ({ ...l }))
      .sort((a, b) => (a.expiry ?? '9999') < (b.expiry ?? '9999') ? -1 : 1);
  }

  async recordEvent(event) {
    this.events.push({ at: new Date(), ...event, itemId: Number(event.itemId) });
  }

  async eventsForItem(itemId, windowDays = 60) {
    const cutoff = Date.now() - windowDays * 86_400_000;
    return this.events
      .filter((e) => e.itemId === Number(itemId) && new Date(e.at).getTime() >= cutoff)
      .map((e) => ({ ...e }));
  }

  async createOrder(order) {
    const row = {
      id: ++this._seq.order,
      status: order.status ?? 'proposed',
      lines: order.lines,
      total_cost: order.total_cost,
      vendor: order.vendor ?? null,
      created_by: order.created_by ?? null,
      approved_by: null,
      history: order.history ?? [],
      created_at: new Date(),
      updated_at: new Date(),
    };
    this.orders.push(row);
    return { ...row };
  }

  async getOrder(id) {
    const row = this.orders.find((o) => o.id === Number(id));
    return row ? { ...row } : null;
  }

  async listOrders({ status } = {}) {
    return this.orders.filter((o) => !status || o.status === status).map((o) => ({ ...o })).reverse();
  }

  async updateOrder(id, patch) {
    const row = this.orders.find((o) => o.id === Number(id));
    if (!row) return null;
    Object.assign(row, patch, { updated_at: new Date() });
    return { ...row };
  }

  async openOrderItemIds() {
    return this.orders
      .filter((o) => ['proposed', 'approved', 'placed'].includes(o.status))
      .flatMap((o) => o.lines.map((l) => Number(l.itemId)));
  }
}

export const supplies = databaseEnabled && pool ? new PostgresSupplies() : new MemorySupplies();
export const suppliesBackend = databaseEnabled && pool ? 'postgres' : 'memory';
