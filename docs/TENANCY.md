# Tenancy — design (pre-implementation)

**Status: design draft, deliberately written before customer #2 exists.**
Everything in the repo today is single-tenant. One pilot practice can run on
it as-is; a second cannot share an instance safely. This document fixes the
shape now, while the cost is a design review instead of a data migration.

Companion to `STAGE_0_ARCHITECTURE.md` (substrate) and `LIVING_SOFTWARE.md`
(the feature layer that makes tenancy interesting: tenants *grow their own
features*, and the marketplace flywheel moves features between tenants).

---

## 1. Model choice: shared schema, `org_id` column, RLS as backstop

| Option | Verdict |
|---|---|
| Database-per-tenant | Operationally heavy for a solo founder; kills cross-tenant catalog analytics; defer until a buyer demands physical isolation. |
| Schema-per-tenant | Migration fan-out (N schemas × every change); fights the idempotent single-file `schema.sql` approach. |
| **Shared schema + `org_id` + Postgres RLS** | **Chosen.** One migration path, dependency-light, the memory dev backends mirror it trivially, and RLS gives defense-in-depth below the app layer. |

Two enforcement layers, because PHI:

1. **App layer** — every store method takes an `orgId`; routes resolve it from
   the authenticated identity (never from a request parameter).
2. **Database layer** — RLS policies on every tenant table keyed to a
   per-transaction `SET LOCAL app.org_id`. A bug in layer 1 hits a wall in
   layer 2 instead of another tenant's data.

## 2. The org object and identity

```sql
CREATE TABLE orgs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       TEXT UNIQUE NOT NULL,          -- 'valley-radiology'
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',-- active | suspended
  settings   JSONB NOT NULL DEFAULT '{}',   -- per-org Epic client ids/endpoints, targets, branding
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- **Humans**: `user_roles` becomes `(user_id, org_id, role)` — roles are
  *memberships*, and a person (a consultant, our own support) can hold
  different roles in different orgs. The IdP authenticates identity; org
  membership stays ours.
- **Service principals**: gain `org_id NOT NULL` — a machine identity belongs
  to exactly one org, so a leaked MCP token is bounded to one tenant. The
  token format and hash lookup are unchanged; resolution returns the org.
- **Dev headers**: gain `X-ValueRad-Org` (dev only, as today).
- **Epic/SMART**: each org owns its EHR connection — client IDs, FHIR base,
  scheduling quirks live in `orgs.settings`, not env vars.

## 3. What gets an `org_id` (and what stays global)

| Scoped per org | Global (vendor-owned) |
|---|---|
| `sessions`, `oauth_tokens` (via session) | the engine (`domain/dsl.js`) + `ENGINE_VERSION` |
| `wh_facts` (the warehouse) | the certified catalog (`domain/catalog.js`) |
| `living_features` — uniqueness becomes `(org_id, feature_key, version)` | golden fixtures + eval baselines |
| `service_principals`, `jobs`, `leads` | `schema.sql`, RBAC role definitions |
| `audit_log.org_id` (nullable: system events) | attestation signing key (one vendor key signs all) |

Living-software consequences, which are the point:

- **Catalog install copies into the org** (already the behavior — install
  creates a registry row; it just gains the org id). Tenants then version
  their copy independently.
- **Marketplace promotion is the reverse arrow**: a tenant-grown feature is
  promoted to the global catalog carrying its attestation chain — provenance
  shows which org grew it, who approved it, and what evidence it shipped with.
- **Rule packs load per org**: `loadActiveRulePack(orgId)` — each practice's
  payer contracts feed only its own booking guardrail.
- **Attestations and audit rows carry the org**, so a compliance export for
  one practice is a filter, not a forensic exercise.

## 4. Request scoping (the seam)

```
authenticate (IdP / principal)            → identity
resolve org (membership / principal.org)  → req.org        (NEVER from query/body)
requireRole(org, ...roles)                → authorization
store call (orgId, ...)  +  SET LOCAL app.org_id            (RLS backstop)
```

`requireRole` grows an org dimension; everything else is mechanical
plumbing of `req.org.id` into the `lib/` stores. The memory backends key
their Maps by org. Single-org deployments resolve a default org and notice
nothing.

## 5. Migration plan (three reversible phases)

1. **Additive** — create `orgs`, seed a `default` org, add nullable `org_id`
   columns everywhere, backfill to the default org. Code reads org when
   present, assumes default otherwise. Zero behavior change; ships dark.
2. **Enforce** — `org_id` NOT NULL; swap unique indexes
   (`living_features (org_id, feature_key, version)`,
   `service_principals (org_id, name)`); route/store signatures take org
   explicitly; dev header + principal resolution wired.
3. **Backstop** — enable RLS policies per table; app role loses the ability
   to query across orgs without `app.org_id` set. Cross-tenant vendor
   analytics use a separate privileged role, read-only, audited.

Each phase is independently shippable and testable against both backends;
the integration suite (`test/integration/`) grows an org-isolation pass
(two orgs, assert zero bleed) in phase 2.

## 6. Non-goals (for now)

- No per-tenant infrastructure, schemas, or databases.
- No billing/metering — `audit_log` + `agent.*` events already carry enough
  to derive usage when pricing needs it.
- No cross-org feature sharing *except* through catalog promotion — tenant →
  vendor → catalog → other tenants, never tenant → tenant directly; the
  certification gate is the support-surface throttle (`LIVING_SOFTWARE.md` §6).
- No org switcher UI until a human actually belongs to two orgs.
