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
| POST | `/api/bi/snapshot` | executive BI snapshot (executive/admin role) |

## Stages implemented

Beyond Stage 0, the domain logic and agent for Stages 1–4 are implemented and
unit-tested (`domain/`, `agent/`). See `../docs/IMPLEMENTATION_STATUS.md` for the
blueprint→code map and what still needs live wiring (production Epic, payer
channels, a data warehouse, an Anthropic key + BAA).

The agent uses `claude-opus-4-8` with adaptive thinking and a manual,
guardrail-gated tool loop. It defaults to **recommend mode** (proposes, never
mutates) and graduates to **autonomous** per capability once trusted.

## Production checklist (not in code)

- Host on a **HIPAA-eligible cloud with a signed BAA** — not GitHub Pages, not a
  generic VPS without a BAA.
- Set `DATABASE_URL`, `TOKEN_ENC_KEY`, `NODE_ENV=production`, real `EPIC_*`.
- Front with TLS; put secrets in a managed vault, not `.env`.
- Replace the dev-only header auth in `lib/rbac.js` with a real IdP.
