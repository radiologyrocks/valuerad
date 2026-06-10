# Reimbursement & the practice hypergraph

How ValueRad knows **what you get paid as you read**, and how it models the whole
practice as a hypergraph to **predict income under change**. Everything is
config-driven and customizable per practice; Connecticut/Medicare defaults ship
and are fully overridable.

## What "what I get paid" actually requires
For one study the number depends on:
- **Code + component** — the read is the **professional component (-26)**; the
  scanner is **technical (-TC)**; **global** is both. `defaultComponent` in the
  config is `'26'` for a reading radiologist.
- **RVUs × GPCI × conversion factor** — Medicare allowed =
  `Σ(componentRVU × matching GPCI) × CF`.
- **Payer rate** — resolved relative to Medicare: your contract (% of Medicare or
  an explicit fee schedule), or the Medicare amount itself.
- **MPPR** — multiple imaging in one session reduces subsequent procedures
  (PC −5%, TC −50% by default; configurable).
- **POS** (facility vs office) and the patient's **benefit status** (deductible).

`domain/reimbursement.js` implements all of this; `POST /api/practice/estimate`
returns `{ wRvu, medicareAllowed, allowed, source }` for one study in real time.

## Data sources to feed it (by payer)
The shipped numbers are **defaults** — replace them with these authoritative feeds.

| Payer | Source (authoritative) | How | Gotchas |
|---|---|---|---|
| **Medicare** | CMS **Physician Fee Schedule** RVU file, **GPCI** by locality, **conversion factor** | Free quarterly CMS downloads / PFS Look-Up API; `data.cms.gov` | The backbone; most payers price relative to it. CT is its own locality. |
| **Medicaid (CT)** | CT DSS Medicaid fee schedule | State portal download | Per-state; managed-Medicaid MCOs differ. Often a % of Medicare. |
| **Commercial** | **Your signed contracts** (truth) + **Transparency-in-Coverage MRFs** | Load your rate sheets; MRFs via payers or a vendor (Turquoise, Serif) | Raw MRFs are huge/messy — your contract wins. |
| **Workers' Comp (CT)** | CT WC medical fee schedule | State DWC; aggregators (Mitchell, Optum) | Per-state; some states pay UCR. Auto/no-fault (PIP) is separate. |
| **Patient reality** | Eligibility **270/271**, remits **835 ERA** | Clearinghouse (Availity, Optum, Waystar, pVerify) | 271 = live plan + deductible; 835 = actual paid (ground-truth feedback). |
| **Will it pay** | **NCCI/MUE edits, LCD/NCD** coverage | CMS (free) | Bundling + dx coverage → full vs $0. |

> **AMA CPT license**: numeric codes + RVUs are usable; CPT **long descriptions**
> are AMA-copyrighted and need a license to display at scale. Budget for it.

The loop closes with the BI engine: estimate at read → match the **835** at remit
→ the gap surfaces as **payer leakage** (`domain/bi.js`).

## The practice as a hypergraph
`domain/hypergraph.js` is a true hypergraph (edges join *any* number of nodes),
because one economic event ties many entities together.

- **Nodes:** `examType`, `payer`, `referrer`, `site`, `scanner`, `radiologist`.
- **Hyperedges:**
  - `volume` — [examType, payer, (referrer), site] → monthly studies
  - `capacity` — [scanner, site] → available scanner-minutes
  - `staffing` — [radiologist, site] → wRVU read capacity

`computePnL` traverses `volume` edges, prices each with the reimbursement engine,
**throttles by scanner capacity** (lost-revenue surfaces), subtracts variable +
fixed costs, and returns revenue / net / margin / wRVU / utilization, broken down
by payer and modality.

## Predicting income under change (scenario engine)
`projectScenario(model, levers)` clones the graph, applies levers, recomputes, and
diffs vs baseline. Levers today:

| Lever | Effect |
|---|---|
| `setContract` | renegotiate a payer's rate (% of Medicare or fee schedule) |
| `scaleVolume` | grow/shrink volume by payer / code / modality / referrer / site |
| `addVolume` | model a new referrer or service line |
| `dropPayer` / `dropExam` | walk away from a payer or modality |
| `addScanner` | add capacity (recovers capacity-lost revenue) |
| `addRadiologist` | add read capacity |
| `setConversionFactor` / `setGpci` | model fee-schedule or locality changes |

`POST /api/practice/scenario` returns `{ baseline, projected, delta }`.

## Customizing per practice
- `GET/PUT /api/practice/config` reads/persists the per-practice config (warehouse
  dataset `practice_config`). Override `gpci`, `conversionFactor`, `examCatalog`
  (load the real PFS RVU file), `payers` (your contracts), `scanners`,
  `radiologists`, and cost lines.
- Defaults are CT today; pass a different `state` or full config to retarget. The
  intent is **auto-configure on setup, fully editable after**.

## Honest boundary
The math, the hypergraph, and the scenario engine are implemented and tested. The
seed RVU/GPCI/CF/contract numbers are **illustrative defaults** — exactness comes
from loading the CMS PFS file, your signed contracts, state Medicaid/WC schedules,
and a clearinghouse for live eligibility/835. Those are data feeds, not code.
