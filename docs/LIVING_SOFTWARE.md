# Living Software in ValueRad — Assessment

**The question:** users request features in-app and the system builds them.
What does it take to make that *integral* to the ValueRad ecosystem — not a
demo bolted on the side?

**The thesis, carried over from the same analysis applied elsewhere:**
self-building features are rapidly becoming table stakes; the durable value is
everything *around* the generation — the sandbox, the tests, the rollback, the
audit trail, the upgrade path. **The moat of living software is governance.**

That thesis lands differently here than anywhere else, because ValueRad has
already built the governance planes — for a different agent. This document maps
what exists, what's missing, and the order to build it.

Companion to `COMMAND_CENTER_ASSESSMENT.md` (the five-planes architecture) and
`IMPLEMENTATION_STATUS.md` (what's real in code). Date: 2026-06-10.

---

## 1. Why ValueRad is unusually well-positioned for this

The hard part of living software is not generation — it's making generated
artifacts *trustworthy in a regulated environment*. ValueRad already has, in
code and tested, the substrate a living-software layer needs:

| Governance asset | Where it lives | What it gives living software |
|---|---|---|
| Append-only audit log | `db/schema.sql` (`audit_log`), `lib/store.js` | The attestation ledger. Every feature event (proposed, tested, approved, executed, retired) becomes an immutable row. |
| Guardrail plane | `agent/policy.js` | The model-proposes / policy-disposes pattern, ready to be extended with feature-lifecycle rules. |
| Recommend → autonomous graduation | `agent/runner.js` (`mode`) | Exactly the trust ladder a generated feature needs: *proposed* until a human approves, every time, by default. |
| RBAC with an `agent` role, default-deny | `lib/rbac.js` | Generated features execute under a role; outputs are gated like any other endpoint. The builder gets its own attributable identity. |
| Typed, schema'd tool registry | `agent/tools.js` | The pattern for a plugin surface: discrete, validated, audited capabilities — never free code execution. |
| Schemaless fact warehouse | `wh_facts` (JSONB), `lib/warehouse.js` | Generated reports need **no migrations**. Any dataset shape a practice uploads is already queryable. |
| Pure, composable metric library | `domain/bi.js` | The standard library a report DSL compiles against: `utilization`, `denialAnalytics`, `arAging`, `referralAnalytics`, `turnaroundTime`, `productivity`, `schedulingFunnel`, `scorecard`. All pure functions, all unit-tested. |
| State-machine discipline | `domain/priorauth.js` (`transition`) | The lifecycle pattern for a feature registry (draft → proposed → testing → active → retired), with history for audit. |
| Async job backbone | `lib/jobs.js` | Scheduled report generation, re-validation runs, canary windows. |

Two details in the existing code are, in effect, **living-software embryos**:

- `POST /api/bi/scorecard` already accepts a `targets` override
  (`routes/bi.js`). A *custom scorecard* is just a stored
  `{targets, datasets, layout}` object — the first generated feature type
  already half-exists.
- `domain/priorauth.js` says it out loud: *"Real config comes from contract
  data; this is the seam"* (`PAYER_EXCEPTIONS`). Payer rules as data, per
  contract, per practice — that is a Tier-2 living feature waiting for a
  registry to live in.

---

## 2. The tier map, translated to radiology

The discipline that makes this sellable (and HIPAA-survivable) is the same
tiering that makes it sellable to a CISO: **what may be generated is bounded by
tier, and the core is never user-vibed.**

### Tier 1 — declarative, read-only over warehouse data → **build this**
Definitions are *data*, executed by an interpreter over `domain/bi.js`
primitives. Never generated executable JS. Examples a practice will actually
ask for:

- "A referrer scorecard I can print for my top-10 referring practices, with
  their turnaround times." (referrals + studies datasets, grouped, formatted)
- "Denials by payer for Q2 as the CSV my billing company's portal imports."
  (denialAnalytics + a column mapping)
- "A board pack: scorecard plus A/R trend, monthly, emailed as PDF."
  (scorecard + arAging + a schedule via `jobs`)
- "Flag any payer whose net collection drops 3% month over month."
  (payerLeakage + a custom target + an exception rule)

High value, zero risk to the operational core, zero new PHI exposure (outputs
inherit RBAC). Today every one of these is a feature request that dies in a
backlog — or a professional-services engagement.

### Tier 2 — constrained config behind existing seams → **later, after Tier 1 earns trust**
Still data, not code, but it *influences operations*, so it ships with golden
tests, canary, and one-click rollback:

- **Payer auth-rule packs** — `PAYER_EXCEPTIONS` and modality rules per
  contract, per practice. This is the marketplace flywheel: every practice's
  payer contracts differ, and a certified rule pack for a regional payer is
  reusable across every practice that holds that contract.
- **Ingest mappers** — every RIS/RCM/clearinghouse exports a different CSV.
  A generated mapping from "their columns" to a warehouse dataset turns
  onboarding from a services task into a same-day self-serve step.
- **Reminder cadence / escalation policies** — schedules and thresholds, not
  message-sending code.

### Tier 3 — never user-generated, ever
`agent/policy.js`, `safeToPerform`, the FHIR write path (`lib/fhir.js`),
`lib/crypto.js`, `lib/rbac.js`, the audit log. A healthcare platform that
rewrites its own safety guardrails is unsellable to a health system and
indefensible to an auditor — the radiology version of a security scanner that
vibe-codes its own scanning core. The tier boundary is itself a policy rule,
enforced in code, not a convention.

---

## 3. The PHI twist — and why it's an advantage

The crypto-governance version of this worries about a CISO objection. The
ValueRad version has a sharper constraint and a cleaner answer:

> **The builder never sees PHI.** Feature generation runs against the
> *schema* of the warehouse plus **synthetic fixture data** (the same fixtures
> the test suite uses). The generated definition then executes **server-side,
> under RBAC, against real data** — the model is never in that loop.

Consequences, all favorable:

1. **No BAA required for the generation path.** The Stage-4 blocker ("no PHI
   to a model without a signed BAA") does not apply to the builder, because no
   PHI reaches it. Living software can ship *before* the operational agent's
   BAA is signed.
2. The attestation story writes itself: spec → definition → test evidence on
   synthetic data → human approval → activation, every step an `audit_log`
   row. **The app writes its own change-management paperwork** — which is
   precisely what a HIPAA security-rule review or SOC 2 change-control audit
   asks for, and what no static competitor can show.
3. Execution risk collapses to interpreter risk: one sandboxed evaluator to
   harden, not N generated programs to review.

---

## 4. Gap analysis — what actually needs to be built

Seven components. None is research; all follow patterns already in the repo.

### A. Feature registry (the system of record)
A `living_features` table: `id, name, kind, spec (the natural-language
request), definition (JSONB), version, status, content_hash, engine_version,
created_by, approved_by, test_evidence (JSONB), created_at`. Status lifecycle
reuses the `transition()` pattern from `domain/priorauth.js`:
`draft → proposed → testing → active → retired`, history retained, rollback =
re-point to a prior version row (never mutate). Append-only like the audit
log.

### B. Definition DSL + interpreter (the execution surface — the key design decision)
A small declarative schema: *select datasets → apply metric primitives from
`domain/bi.js` → group/filter/compose → targets/exceptions → output format
(json | csv | table layout)*. One interpreter executes it; `domain/bi.js` is
its entire instruction set. This is the single most important boundary in the
whole design: **the model emits configuration for a trusted engine, not
code.** Validation is JSON-schema on the definition, exactly as
`agent/tools.js` validates tool input.

### C. The builder agent (the second runner)
A sibling of `agent/runner.js` — same manual loop, same
proposed/executed/blocked accounting — with its own tool set:
`inspect_warehouse_schema`, `sample_synthetic_data`, `draft_feature_spec`,
`generate_definition`, `run_golden_tests`, `propose_feature`. It runs in
recommend mode permanently for activation: a feature can be *generated*
autonomously but only *activated* by a human with the right role. The builder
gets its own actor identity so every generated artifact is attributable.

### D. Feature policy (guardrail-plane extension)
The living-software analog of `agent/policy.js`: tier classification of every
proposed definition; default-deny anything referencing a write tool or a
Tier-3 module; output-role assignment (a referrer scorecard is
`executive`-gated like the BI routes it derives from); resource limits on the
interpreter (row caps, timeouts).

### E. Test harness + evidence
Synthetic fixture datasets in-repo (the BI tests already imply them — promote
them to named golden fixtures). Every proposed feature must: validate against
the definition schema, execute cleanly on fixtures, and produce a snapshot
that is stored as `test_evidence` in the registry. No evidence, no approval
button.

### F. Attestation + upgrade re-validation (the moat)
Every lifecycle transition writes `audit_log` rows (`feature.proposed`,
`feature.approved`, `feature.executed`, …) with the content hash and evidence
reference. Stamp every definition with the `engine_version` of `domain/bi.js`
it was built against; on upgrade, a CI step + a `jobs` task re-run every
active feature against fixtures and flag breakage for regeneration —
**"your custom features survive our upgrades"** is the renewal argument, and
it's a batch job, not a consulting engagement.

### G. Surface in the Command Center
Three UI elements in `src/pages/CommandCenter.jsx`: a request box ("describe
the report you need"), an approval queue (admin/executive — mirrors how agent
proposals should surface), and a feature gallery (run / schedule / retire /
roll back). Plus routes: `POST /api/features/request`, `GET /api/features`,
`POST /api/features/:id/approve`, `POST /api/features/:id/run`,
`POST /api/features/:id/rollback` — all RBAC-gated, all audited.

### Blocking prerequisites (already on the Stage-0 checklist, now load-bearing)
- **A real IdP behind `lib/rbac.js`.** An approval is only worth its audit row
  if the approver's identity is verified. Dev-header auth cannot gate feature
  activation.
- **Durable Postgres in production.** A feature registry in the dev memory
  store is a contradiction in terms.
- `ANTHROPIC_API_KEY` for the builder — but **not** a BAA, per §3, as long as
  the no-PHI-to-builder rule is enforced in code (the feature policy should
  make it structural: the builder's tools simply have no path to real rows).

---

## 5. Sequencing — each phase independently shippable

**Phase A — the execution surface, no LLM (smallest safe slice).**
Registry table + definition schema + interpreter over `domain/bi.js` +
`/api/features` CRUD with approval + audit + fixtures. Hand-write the first
two or three definitions (a custom scorecard, a referrer report, a CSV
export). This proves the surface, and it's independently useful: saved custom
reports are a real feature even before anything generates them.

**Phase B — the builder.**
The builder agent (C) + feature policy (D) + request box and approval queue
(G). Natural-language request → generated definition → evidence → human
approval → active. This is the "living" moment, and it ships with its
attestation trail on day one.

**Phase C — Tier 2, one seam at a time.**
Payer rule packs first (the revenue argument: per-contract auth rules feed
`authRequired`, which feeds the single most important guardrail), then ingest
mappers (the onboarding argument). Each gets canary + rollback before the
next opens.

**Never:** Tier 3. Write it into the policy plane and the sales deck in the
same sentence.

---

## 6. Business mechanics, translated

- **What it replaces:** the bespoke-report and onboarding-services line items.
  The price comparison for a generated, certified, maintained report pack is a
  services SOW, not API tokens.
- **Recurring revenue is maintenance:** features auto-revalidated across every
  engine upgrade (§4F). Static competitors accumulate consulting backlogs;
  ValueRad runs a batch job.
- **Marketplace flywheel:** practice-built features promote to a certified
  catalog — payer rule packs and RIS ingest mappers are naturally reusable
  across practices. Two support tiers: *generated* (best-effort) vs
  *certified* (SLA). The request stream is free roadmap telemetry.
- **Solo-founder support reality:** launch Tier 1 only. N practices ×
  divergent Tier-2 rule packs is a support surface that can eat one person;
  the certification gate is the throttle.

---

## 7. The honest boundary

Living software here is a **capability, not a pivot** — the same conclusion as
everywhere else this model has been assessed, and it holds doubly in
healthcare. The wedge remains scheduling + eligibility + prior auth; nothing
in this document should delay the Stage-0 production checklist (HIPAA host,
IdP, BAA for the *operational* agent). What's different in ValueRad's case is
the cost side: because the audit log, guardrail plane, RBAC, state machines,
warehouse, and metric library already exist and are tested, the living-software
layer is mostly *composition* — one new table, one interpreter, one more
runner, one policy extension, three UI panels. The governance harness that
everyone else would have to build first is the part that's already done.
