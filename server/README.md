# ValueRad Command Center — Backend

Stage 0 foundation: SMART-on-FHIR with a durable, encrypted, audited system of
record. See `../docs/STAGE_0_ARCHITECTURE.md` for the full blueprint.

## What's implemented

- **SMART App Launch** (Epic): PKCE launch → callback → token exchange.
- **Durable store** (`lib/store.js`): Postgres when `DATABASE_URL` is set,
  otherwise a **non-durable in-memory** store for local dev.
- **Encrypted tokens at rest** (`lib/crypto.js`, AES-256-GCM via `TOKEN_ENC_KEY`).
- **Append-only audit log**: every FHIR read and write is recorded.
- **FHIR write capability** (`lib/fhir.js`): `create` / `update`, plus a
  `SchedulingClient` seam for Stage 1 (Epic scheduling isn't plain FHIR write).
- **Automatic token refresh** before expiry.
- **RBAC scaffold** (`lib/rbac.js`) for ValueRad's own users (and, later, the agent).
- **Lead capture** (`POST /api/leads`) for the storefront form.
- **Async job table** seam (`jobs`) for Stage 2 prior-auth state machines.

## Run locally

```bash
cp .env.example .env      # fill in EPIC_* ; DATABASE_URL/TOKEN_ENC_KEY optional in dev
npm install
npm run dev               # http://localhost:3001
npm test                  # node:test unit tests
```

Without `DATABASE_URL`/`TOKEN_ENC_KEY` the server boots in dev mode (in-memory,
unencrypted) and **says so** at `/health`. In `NODE_ENV=production` it refuses to
start without both — you cannot accidentally handle PHI without a durable,
encrypted store.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | `/health` | status + active store/encryption mode |
| GET  | `/epic/launch` | EHR-launched SMART entry point |
| GET  | `/epic/callback` | OAuth redirect; exchanges code for tokens |
| GET  | `/epic/context` | safe session context for the SPA (no tokens) |
| GET  | `/epic/fhir/:resource/:id?` | audited read proxy |
| POST | `/epic/fhir/:resource` | audited create |
| PUT  | `/epic/fhir/:resource/:id` | audited update |
| POST | `/api/leads` | storefront lead capture |
| POST | `/api/agent/run` | run the command-center agent (recommend mode default; 503 without `ANTHROPIC_API_KEY`) |
| POST | `/api/bi/ingest` | ingest a dataset from CSV or JSON into the warehouse (executive/admin) |
| GET  | `/api/bi/warehouse` | row counts per dataset |
| POST | `/api/bi/snapshot` | executive BI snapshot (inline body or `{source:"warehouse"}`) |
| POST | `/api/bi/scorecard` | CEO KPI scorecard with targets, variance, and exception alerts |
| POST | `/api/bi/report` | full CEO report (snapshot + denials, A/R, referrals, turnaround, productivity, funnel) |
| GET  | `/api/features` | living-feature registry (any staff role) |
| GET  | `/api/features/catalog` | certified feature catalog |
| POST | `/api/features` | propose a hand-written definition (validated + golden-tested) |
| POST | `/api/features/catalog/:key/install` | install a certified definition as proposed |
| POST | `/api/features/request` | natural-language request → builder agent (503 without `ANTHROPIC_API_KEY`) |
| POST | `/api/features/:id/approve` | tier 1 → active; tier 2 → canary, then → active |
| POST | `/api/features/:id/canary` | shadow-evaluate a tier-2 feature; stores the divergence/preview report |
| POST | `/api/features/:id/run` | execute a report/export (or dry-run a mapper), RBAC per definition |
| POST | `/api/features/:id/rollback` | re-activate the prior version (re-attested) |
| POST | `/api/features/:id/reject` · `/retire` | lifecycle |
| GET  | `/api/features/:id/attestation` | signed provenance record + verification result |
| POST | `/api/features/revalidate` | re-run golden tests on all active features (upgrade gate) |
| GET  | `/api/evals` | deterministic eval suite: metric coverage + catalog output regression + seam coverage |
| GET/POST | `/api/principals` · `/:id/revoke` | service principals — first-class machine identities (admin) |
| POST | `/api/supplies/scan` | UDI/GS1 scan intake (phone camera, wedge scanner, or manual — one parser) |
| GET  | `/api/supplies` | stock by lot: on-hand, days of supply, expiring, open orders |
| POST | `/api/supplies/items` | register/configure an item (par, reorder point, restricted…) |
| POST | `/api/supplies/orders/propose` | sweep the shelf: gated reorder proposals |
| POST | `/api/supplies/orders/:id/approve` · `/place` · `/receive` · `/cancel` | order lifecycle (gates re-run at confirmation; placing enqueues the vendor job) |

BI works two ways from the same metric engine (`domain/bi.js`): **CSV/JSON
extracts** (no integrations needed — upload RCM/RIS/payer-remit exports) and a
**durable warehouse** (`lib/warehouse.js`, Postgres or dev-memory). Datasets:
`claims`, `appointments`, `studies`, `slots`, `referrals`, `referrals_prior`.

## Stages implemented

Beyond Stage 0, the domain logic and agent for Stages 1–4 are implemented and
unit-tested (`domain/`, `agent/`). See `../docs/IMPLEMENTATION_STATUS.md` for the
blueprint→code map and what still needs live wiring (production Epic, payer
channels, a data warehouse, an Anthropic key + BAA).

The agent uses `claude-opus-4-8` with adaptive thinking and a manual,
guardrail-gated tool loop. It defaults to **recommend mode** (proposes, never
mutates) and graduates to **autonomous** per capability once trusted.

## Living software

Users request features in natural language; the **builder agent**
(`agent/builder.js`) composes a declarative definition (`domain/dsl.js` —
configuration for a trusted engine, never code), tests it against synthetic
golden fixtures (`domain/fixtures.js`), and registers it as **proposed**.
Activation is always a human decision; every lifecycle step is an audit row.
Tier 1 (reports/exports) is read-only over the warehouse; Tier 2 (payer
rule packs, ingest mappers) configures platform seams and must pass a
**canary** shadow-evaluation before promotion; Tier 3 (guardrails, FHIR
writes, crypto, RBAC, audit) is never generated. The builder's tools have no
code path to real data — generation runs outside the BAA boundary. See
`../docs/LIVING_SOFTWARE.md`.

### Agent auth: API key, or a Claude subscription for development

Both agents (operations runner and feature builder) support two transports,
with identical tools, guardrails, and audit:

- **`ANTHROPIC_API_KEY` set** → Messages API (pay-per-token). Required in
  production.
- **No key, dev only** → fall back to the **Claude Agent SDK**
  (`agent/runnerDev.js`, `agent/builderDev.js`), which uses Claude Code's
  login. Run `claude /login` once with a Claude Pro/Max subscription and
  leave `ANTHROPIC_API_KEY` unset (a set key overrides subscription auth).
  Agent SDK usage draws from the plan's monthly credit pool instead of
  per-token billing. Per Anthropic's terms this is for personal development
  only — `NODE_ENV=production` refuses the fallback.

On the subscription transport the guardrail plane is enforced *inside* every
tool handler (same `executeToolCall` as the production loop), so recommend
mode still never mutates and policy blocks still apply. Two extra gates:
the operations agent **refuses live EHR sessions** on this transport (no BAA
on a personal subscription — demo/synthetic data only), and the builder
never sees real data by construction. `AGENT_DEV_MODEL` / `BUILDER_DEV_MODEL`
optionally override the model.

## The MCP surface — the command center as a tool surface for agents

`server/mcp.js` exposes the governed API as an MCP server (stdio): feature
lifecycle (request → approve with rubric grading → run → rollback), the
certified catalog, attestations, the ops agent, BI report, CSV ingest, and
the eval suite — 21 tools. It is a **thin client over the HTTP API**, so
every call flows through the same RBAC, guardrails, and audit log as the
dashboard and adds no authority of its own.

```bash
npm run dev                                    # the API
claude mcp add valuerad -- node server/mcp.js  # then talk to the app from Claude Code
```

Auth: set `VALUERAD_SERVICE_TOKEN` to a service-principal token
(`POST /api/principals`, admin — token returned once; the principal's roles
bound what the surface may do). Without it, dev headers are used
(`VALUERAD_DEV_USER`/`VALUERAD_DEV_ROLES`), which production rejects.
`VALUERAD_API_BASE` points at a non-local API.

## Provenance & verification

- **Outcome rubrics**: feature requests capture "what does done look like";
  activation requires the approver to grade each criterion
  (`rubricResults`), recorded in the evidence and audit trail.
- **Signed attestations** (`lib/attest.js`): every activation is
  Ed25519-signed — content hash, engine version, evidence hash, approver,
  timestamp. Set `ATTESTATION_PRIVATE_KEY` (PKCS#8 PEM) in production;
  without it attestations are stamped `ephemeral-dev`.
- **Eval suite** (`npm run eval`, `domain/evals.js`): metric coverage,
  certified-catalog output regression against pinned baselines
  (`npm run eval:update` to re-pin after deliberate changes), and rule-pack /
  mapper seam coverage. Runs in CI via the test suite.

## Production checklist (not in code)

- Host on a **HIPAA-eligible cloud with a signed BAA** — not GitHub Pages, not a
  generic VPS without a BAA.
- Set `DATABASE_URL`, `TOKEN_ENC_KEY`, `NODE_ENV=production`, real `EPIC_*`.
- Front with TLS; put secrets in a managed vault, not `.env`.
- Replace the dev-only header auth in `lib/rbac.js` with a real IdP.
