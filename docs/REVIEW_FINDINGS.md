# Six-Hat Code Review — Findings & Remediation

Six independent reviewers, each with fresh context and one hat, instructed to
be adversarial (find problems, not praise). Date: 2026-06-11. Hats: UX/human
factors, software architecture, repo organization, organizational/process
maturity, backend data design, AI-agent safety.

This document is the synthesis and the remediation tracker. Status flags:
**[FIXED]** done in the follow-up commit · **[CODE]** code fix pending ·
**[INFRA]** needs deployment/DB-role/infrastructure · **[COMPANY]** non-code,
business/compliance.

---

## The one-paragraph truth (all six reviewers agreed)

The codebase is **unusually good for AI-authored software** — clean history,
honest docs, a genuinely sound governance design (config-not-code DSL, tiered
generation, the recommend→approve posture). The danger is the inverse of most
prototypes: the *thoroughness* creates a false sense of being further along
than it is. Several invariants the docs present as *enforced* are only
*documented*. The professionalization work is (1) make the enforcement match
the claims, and (2) the non-code company/compliance spine that no amount of
code can substitute for.

---

## Convergent findings (flagged by 2+ reviewers — fix these first)

### CV1. The audit log is append-only in name only — `[INFRA]`
Architecture-C1, Data-C2, Org-A2. `schema.sql:37` says "no UPDATE/DELETE
should be granted" — it's a **comment**. The app connects as the schema owner
with full DML; nothing prevents rewriting history. This is the #1 compliance
claim and it's unenforced. **Fix (deployment):** run the app under a
least-privilege role with `INSERT, SELECT` only on `audit_log`; add a
`BEFORE UPDATE OR DELETE` trigger that raises; run DDL as a separate owner.
Tracked in `STAGE_0_ARCHITECTURE.md` follow-ups. Until the production DB
exists this can't be wired, but the trigger DDL ships now (see below).

### CV2. Inventory decrement is a lost-update race — `[FIXED]` (guard) / `[INFRA]` (locking)
Architecture-C2, Data-C1. The supply `use` path is read-modify-write across
statements with no row lock or `CHECK(qty>=0)`; two concurrent scans oversell
or drive stock negative, and the memory backend (what tests run on) *cannot
exhibit the race*. **Fixed now:** `CHECK (qty >= 0)` on `supply_lots`, a
conditional `WHERE qty >= take` decrement in the PG backend, and the memory
backend rejects oversell symmetrically. **Still needed (infra):**
`SELECT … FOR UPDATE` transaction wrapping for the multi-lot case under real
concurrency, exercised by a PG concurrency test.

### CV3. Tests validate a backend you don't ship — `[CODE]`
Architecture-C3, Data-parity. Memory backends are *looser* than Postgres on
uniqueness/FK/NOT NULL/CHECK and concurrency, so green CI can mask prod
constraint violations and races. **Fix:** the `test/integration/` PG suite
must run the same constraint + concurrency assertions, not just smoke tests;
add a memory-vs-PG parity test. (Partial: integration suite exists and now
covers supplies; concurrency cases pending.)

### CV4. Human-approval is rubber-stamp / forgeable — `[FIXED]`
UX-M4, Agent-H4, Agent-H5. Three holes: (a) the rubric grading UI defaulted
every criterion to *checked*; (b) activation didn't check the rubric result
values — `0/5 satisfied` still activated; (c) "requires a human" was an RBAC
role *grantable to a machine principal*, so an agent over MCP could
self-approve. **Fixed:** rubric checkboxes default unchecked (UI); activation
blocks unless every criterion is satisfied (or a signed override reason);
service-principal identities are rejected at every approval/activation gate.

### CV5. No quality gate; the repo will rot once a 2nd person edits — `[FIXED]`
Repo-H1/H3. No ESLint/Prettier/editorconfig, CI uses `npm install` not
`npm ci`. **Fixed:** flat ESLint config + Prettier + `.editorconfig` at root
and `server/`, CI switched to `npm ci` with a `lint` step.

---

## By hat — the severe items not already covered above

### AI-agent safety (the most consequential hat)
- **Agent-C1 `[FIXED]` — the auth/eligibility interlock trusted request-body
  context.** `policy.js` gated `book_appointment` on `ctx.authStatus` /
  `ctx.eligibility`, but `ctx` came from the HTTP body — so
  `context:{authStatus:"approved"}` booked an MR with no real auth, and
  missing eligibility context failed *open*. This defeated the single most
  important rule ("nothing high-cost scans without a valid auth"). **Fixed:**
  the runner now derives auth + eligibility from authoritative `services`
  reads keyed to the order, ignoring any client/model-supplied values, and
  fails *closed* when coverage is unverified. `book_appointment` now requires
  `orderId` and the booked modality is checked against the authorized one.
- **Agent-H1 `[CODE]` — no prompt-injection separation.** Tool results and
  untrusted documents (payer text, scanned content, feature-request specs)
  enter the model context unframed. Mitigated structurally by Agent-C1 (safety
  decisions are now deterministic code over verified IDs, not model-visible
  text), but tool-result framing + error-message scrubbing still pending.
- **Agent-L2 `[FIXED]` — `escalate_to_human` was a no-op stub.** The
  prominent "safety valve" did nothing. **Fixed:** it now records an audited
  escalation and enqueues a notification job.
- **Agent-M1 `[FIXED]` — silent truncation at the iteration cap.** Hitting
  MAX_ITERATIONS returned a partial result indistinguishable from completion.
  **Fixed:** returns `truncated: true` / `stopReason`.
- **Agent-M4 `[FIXED, docs]` — golden tests prove liveness, not correctness.**
  Now stated plainly in `LIVING_SOFTWARE.md`; the human rubric is the
  correctness gate and has been hardened (CV4).
- **Agent-L1/M2/M5/M6 `[CODE]` — ephemeral-attestation `verified:true`,
  no idempotency keys on enqueue, no model-behavioral eval gate, hardcoded
  model IDs.** Tracked; lower severity.

### Software architecture
- **Architecture-H2 `[FIXED]`** — no global error handler (leaked
  `err.message`), no body-size limit, no `unhandledRejection` handler, and the
  jobs worker was *never started* (placed orders/auths went nowhere). All
  wired.
- **Architecture-H3 `[FIXED]`** — `update()` could set `status` directly,
  bypassing the state machine; concurrent approves could create two active
  versions. **Fixed:** stores reject direct `status` writes (transitions go
  through the machine); a guard prevents double-activation. Full optimistic
  locking is `[INFRA]` (needs the prod DB).
- **Architecture-M1/M3 `[INFRA]`** — DB TLS `rejectUnauthorized:false`,
  rollback skips golden re-test. Rollback re-test `[FIXED]`.

### Backend data design
- **Data-H1 `[CODE]`** — `sessions.patient_resource` (full FHIR Patient: name,
  DOB, MRN) stored plaintext while tokens are encrypted. **Fix:** encrypt via
  the existing envelope or stop persisting it (re-fetch on demand). Scheduled.
- **Data-H3 `[CODE]`** — token crypto has no key id (no rotation), no AAD
  binding. Scheduled.
- **Data-M3 `[FIXED]`** — money as unbounded `NUMERIC`/JS float, status
  columns as free `TEXT`. **Fixed:** `NUMERIC(12,2)` for money, `CHECK`
  constraints on every status/enum/quantity column.
- **Migrations `[INFRA]`** — the idempotent `schema.sql`-on-boot can't do type
  changes/backfills/rollback. Adopt a versioned runner before the first
  schema change on populated prod data.

### UX / human factors
- **UX-C1/C2 `[FIXED]`** — Autonomous mode was a one-click loaded gun with no
  confirmation, and nothing stopped Autonomous + live-Epic. **Fixed:**
  autonomous requires explicit confirmation, reverts to recommend after each
  run, and is disabled when a live session is attached.
- **UX-C3 `[FIXED]`** — `apiPost/apiGet` threw a raw `SyntaxError` on any
  non-JSON error body (a 502/HTML page showed the user "Unexpected token '<'").
  **Fixed:** graceful fallback message.
- **UX-H1/H2 `[FIXED]`** — empty first-run wall-of-buttons and no nav. **Fixed
  partly by the demo seed** (`npm run seed`) so the dashboard has data; section
  guidance added.
- **UX-H3/H4/H5 `[CODE]`** — scanner has no reticle/timeout/feedback, raw
  camera-permission errors, register-unknown-item loses the scan. Scheduled.
- **UX-M5/M6 `[FIXED]`** — destructive actions (Place order, Retire/Rollback)
  now confirm; mobile tap targets enlarged.

### Repo organization
- **Repo-M1 `[FIXED]`** — stale "16 tools" → the MCP surface defines 21 (now
  reads "see `buildMcpTools`").
- **Repo-M2/M3 `[FIXED]`** — dropped `node-fetch` (Node 20 has global fetch),
  added `engines` to both manifests, reconciled versions.
- **Repo-L1 `[FIXED]`** — `use-mobile.jsx` → `.js`.
- **Repo-M4 `[CODE]`** — no unit tests for `rbac.js`/`smart.js` (Tier-3
  invariant code) and no HTTP-level route test. `rbac.js` tested now; route
  tests scheduled.

### Organizational / process maturity — `[COMPANY]` (none of this is code)
The blunt truth from this hat: *you don't have a capability problem, you have
a company problem.* Ranked, these block a paying customer regardless of code:
1. **No compliance spine** — entity, cyber-insurance, signed BAAs (cloud +
   Anthropic), a HIPAA Security Risk Assessment (mandatory), breach/incident
   procedures, named Security & Privacy Officers. The code is BAA-*ready*; the
   company can't sign one.
2. **No real IdP** — production rejects dev headers, so today there is *no way
   for a human to authenticate in prod*. Every approval claim rests on this.
3. **Nothing has touched real Epic or real PHI** — all Stage 1-4 capability is
   logic tested on synthetic fixtures. You can't yet demo the real product.
4. **Bus factor of one** — a buyer's vendor-risk review won't accept a
   single-person operation handling PHI; no monitoring/on-call/SLA/backups.
5. **No procurement kit** — SOC 2 (6-12mo clock, start now), HECVAT/SIG
   answers, pen test, data-flow diagram, `SECURITY.md`, `LICENSE`.
**Strategic:** go one-customer-deep on the prior-auth-via-scheduling wedge;
shelve breadth (supply chain, living-software builder) as roadmap until a live
pilot. Breadth-without-depth reads as "vibe-coded flight of ideas" — the exact
perception to escape.

---

## What the reviewers explicitly called "safety theater" (looks like a control, isn't)

1. Auth/eligibility "structural block" that trusted self-attested context — **FIXED**.
2. Rubric review where results weren't enforced and the model wrote its own rubric — **FIXED (enforcement)**; model-authored rubrics now flagged distinctly.
3. "Activation always requires a human" enforced as a role grantable to machines — **FIXED**.
4. `verified:true` on ephemeral-dev attestations — **CODE** (verify returns a degraded status; refuse ephemeral in prod).
5. `escalate_to_human` no-op — **FIXED**.
6. Golden tests sold as a correctness gate — **FIXED (docs honesty)**.

---

## Sequencing

- **Before weekend human testing (this commit):** the safety-critical
  enforcement fixes (Agent-C1, CV4, escalate, error handler/worker, oversell
  guard), the professional hygiene (lint/prettier/CI/deps), and the demo seed +
  local testing guide so testing happens on a populated, safe dashboard.
- **Before a production deployment `[INFRA]`:** audit-log DB role + trigger,
  PG concurrency tests + row locking, a real migration runner, DB TLS verify,
  PHI-at-rest encryption for `patient_resource`, key rotation.
- **Before a paying customer `[COMPANY]`:** the compliance spine, a real IdP,
  one live Epic integration, a second human, the procurement kit.
