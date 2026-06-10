# Supply Chain — UDI-native tracking and gated automated ordering

How a radiology practice's consumables (contrast media, catheters, syringes,
PPE) get tracked and reordered without a person counting shelves or a
purchasing clerk re-keying orders. Implemented in `server/domain/supply.js`
(pure logic), `server/lib/supplies.js` (store), `server/routes/supplies.js`
(API), plus agent tools and MCP tools.

---

## 1. Capture method: phone, scanner — or rather, both, for free

**The decision: phone camera first, and the question dissolves on contact
with how barcodes actually work.**

- Every FDA-regulated medical product already carries a **UDI** (Unique
  Device Identification) barcode — almost always a **GS1 DataMatrix** — that
  encodes the GTIN *plus expiry date and lot number* in one square. The data
  you want for inventory and recall-readiness is printed on every box today;
  nothing needs labeling.
- A **phone camera** reads DataMatrix natively in Chromium browsers via the
  `BarcodeDetector` API — zero hardware cost, every tech already carries
  one, and the Command Center is already a web app. This is the current
  state of practice.
- A **dedicated scanner** (Zebra/Honeywell, USB or Bluetooth) is just a
  keyboard: it "types" the decoded string and presses Enter — the HID wedge.
  So the same text input that accepts manual entry accepts a hardware
  scanner with no integration whatsoever. High-volume receiving docks can
  add one for $150 whenever speed matters.
- **RFID** is the step beyond — cabinet-level passive tracking for
  high-value cath-lab consignment stock. Real, but it's vendor-managed
  hardware and a different price class; the event ledger here is the
  substrate it would feed into. Not now.

So the architecture is **one intake, three input paths**:

```
phone camera (BarcodeDetector)  ┐
wedge scanner (types + Enter)   ├──→ one GS1 parser ──→ movement ledger
manual entry                    ┘    (GTIN + lot + expiry + qty)
```

The parser (`parseGs1`) handles raw scans with FNC1/GS separators, the
human-readable bracketed form, and plain GTIN/UPC/EAN — normalized to
GTIN-14. Lot and expiry come along free, which buys FEFO picking
(first-expiry-first-out), expiry alerting, and lot-level recall lookup.

## 2. The flow

- **Receive**: scan the box → lot/expiry-tracked stock increments; every
  movement is an append-only `supply_events` row with the actor (the same
  attribution discipline as everything else here).
- **Use**: scan at consumption → FEFO decrement (the scanned lot wins when
  it has stock); overdraw is refused, not silently negative.
- **Status**: on-hand by lot, trailing-30-day usage rate, days of supply,
  below-reorder and expiring flags — on the dashboard, and as an ops-agent
  sense (`check_supply_levels`) and MCP tool (`supply_status`).

## 3. Automated ordering — propose freely, gate the money

The same model-proposes/policy-disposes shape as the rest of the platform:

1. **Triggers**: a `use` scan that drops an item to its reorder point
   auto-creates a PROPOSED order (par level + lead-time demand, rounded to
   whole packs); `POST /api/supplies/orders/propose` sweeps the whole shelf;
   the ops agent can propose via `propose_supply_order` (a write tool — in
   recommend mode even the proposal is only proposed).
2. **The gates** (`evaluateSupplyOrder`, pure):
   - `restricted` items (contrast agents, anything pharmacy-adjacent) →
     **always require human confirmation**, no auto path exists;
   - totals ≥ $500 → human confirmation;
   - an open order already covering the item → **blocked** (duplicate);
   - a period budget cap breach → **blocked**;
   - otherwise: within auto limits.
3. **Confirmation**: approving re-runs the gates at decision time and is
   admin/executive-only, audited. Optional `SUPPLY_AUTO_APPROVE=true` lets
   within-limits orders self-approve — restricted and high-dollar lines can
   never take that path.
4. **Placement**: `placed` enqueues a `place_supply_order` job — the vendor
   integration seam (EDI 850, punchout, or a plain email to the distributor
   rep) lives behind the queue, not in the request path.
5. **Receiving closes the loop**: the order is marked received; actual stock
   enters via receive *scans*, so the ledger never trusts paperwork over
   the shelf.

Lifecycle: `proposed → approved → placed → received`, with `cancelled` from
any pre-received state — a state machine (`transitionOrder`) with history,
like every other lifecycle in the repo.

## 4. What this is not (yet)

- No vendor connectivity — the job seam is where EDI/punchout lands.
- No purchase-order accounting/three-way match — the audit ledger holds the
  raw material when that matters.
- No RFID — the event ledger is the substrate it would feed.
- Tenancy: supply tables join the org_id pass like everything else
  (`TENANCY.md`).
