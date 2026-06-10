# ValueRad — agent onboarding

Radiology command center: React/Vite storefront + dashboard (`src/`), Express
backend (`server/`) with SMART-on-FHIR Epic launch, an operations agent, and a
living-software layer (user-requested features, generated as data, governed).

## Commands

```bash
# backend (server/)
npm install && npm test        # node:test, no network/DB needed
npm run dev                    # http://localhost:3001 (in-memory dev store)

# frontend (repo root)
npm install && npm run dev     # Vite; VITE_API_BASE=http://localhost:3001
npm run build
```

Dev identity: requests need `X-ValueRad-User` / `X-ValueRad-Roles` headers
(see `src/lib/api.js`); RBAC roles in `server/lib/rbac.js`.

## Architecture map

- `server/domain/` — pure, dependency-free business logic. Unit-test everything here.
  - `bi.js` metric library · `dsl.js` definition engine · `feature.js` lifecycle/tier/harness
  - `priorauth.js`, `scheduling.js`, `eligibility.js`, `worklist.js` · `fixtures.js` golden data
  - `supply.js` GS1/UDI parsing, stock math, order lifecycle + gates (docs/SUPPLY_CHAIN.md)
- `server/agent/` — the agents. `runner.js`/`builder.js` (Messages API),
  `runnerDev.js`/`builderDev.js` (dev-only Claude-subscription transport via Agent SDK).
  `tools.js` action plane · `policy.js` guardrail plane.
- `server/lib/` — store, db, warehouse, features registry, rbac, principals
  (machine identities), attest (signed provenance), crypto, jobs, fhir.
  Every store has a Postgres backend (when `DATABASE_URL` set) and a memory dev backend.
- `server/routes/` — Express routers; RBAC-gated; every mutation audited.
- `server/mcp.js` — the MCP tool surface: a thin client over the HTTP API
  (adds no authority). `npm run eval` runs the deterministic eval suite;
  re-pin catalog baselines with `npm run eval:update` only for deliberate changes.
- `docs/` — strategy + architecture. Read `LIVING_SOFTWARE.md` before touching
  the feature layer; `FUTURE_PROOFING.md` for direction; `STAGE_0_ARCHITECTURE.md` for substrate.

## Invariants — do not violate

1. **Tier 3 is never generated or user-modifiable**: `agent/policy.js`,
   `domain/priorauth.js#safeToPerform`, `lib/fhir.js` writes, `lib/crypto.js`,
   `lib/rbac.js`, the audit log. Generated features are *data* interpreted by
   `domain/dsl.js` — never executable code.
2. **Every mutation goes through a guardrail and lands in the audit log.**
   Model proposes, policy disposes. Recommend mode never mutates. Feature
   activation always requires a human with admin/executive role.
3. **No PHI to models without a BAA.** The builder sees only schema docs +
   synthetic fixtures (`domain/fixtures.js`), never warehouse rows or FHIR.
   The subscription dev transports refuse production and refuse live EHR
   sessions — keep those gates.
4. **Lifecycle changes use the state machines** (`domain/priorauth.js`,
   `domain/feature.js#transitionFeature`) — never set status fields directly.
   Registry rows are versioned, never overwritten; rollback re-points.
5. **Audit log is append-only.** No UPDATE/DELETE paths, ever.
6. **Engine changes bump `ENGINE_VERSION`** (`domain/dsl.js`) and must keep
   the certified catalog (`domain/catalog.js`) passing golden tests — the
   features test suite enforces this.

## Conventions

- ES modules, no TypeScript, no build step on the server. Dependency-light on
  purpose (express, pg, zod, SDKs) — don't add frameworks.
- Domain modules stay pure (no env, no I/O); routes/lib do the wiring.
- Tests: `node:test` + `assert/strict`. Unit tests use the memory backends —
  **never run the unit suite with `DATABASE_URL` set**: the `delete
  process.env.DATABASE_URL` line in test files runs *after* ESM imports
  resolve, so a set var silently points unit tests at the real database.
  Postgres coverage lives in `test/integration/` (skips without
  `DATABASE_URL`; CI scopes the var to that step only). Agents are tested
  with injected fake clients/SDKs — see `test/agent.test.js`,
  `test/builderDev.test.js`.
- File headers carry a short design rationale; match the existing voice.
- New behavior ships as data behind the engine when possible, code only when
  necessary.
