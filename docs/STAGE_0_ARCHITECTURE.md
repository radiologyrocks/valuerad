# Stage 0 — Foundation Architecture

**The substrate the agent stands on.** Nothing in Stages 1–4 is safe or real
until this exists. This document is the technical blueprint for turning the
read-only Epic connector in `server/` into a HIPAA-durable, write-capable,
auditable platform.

Companion to `COMMAND_CENTER_ASSESSMENT.md`. Scope here is **infrastructure and
data**, deliberately *before* any AI feature.

---

## Why Stage 0 comes first

The current backend (`server/`) does three things well — SMART/PKCE launch, token
exchange, read-only FHIR — and three things that make it a prototype, not a
product:

- **Sessions live in `new Map()`** (`server/routes/smart.js:24`). Restart = every
  session and token gone. No history, no recovery, no audit.
- **The FHIR client only does `GET`** (`server/lib/fhir.js`). You can *watch* the
  EMR; you cannot *act* in it. No scheduling, no auth submission.
- **PHI handling is prototype-grade.** PHI sits in memory, errors go to
  `console`, there is no audit trail, no encryption story, no access control.

Stage 0 fixes exactly these, and nothing more. Resist adding features here.

---

## Target architecture (single diagram, in words)

```
                          ┌─────────────────────────────┐
   Clinician (via Epic)   │   ValueRad Command Center    │
   ───────────────────►   │                              │
   SMART App Launch       │  ┌────────────────────────┐  │
                          │  │  API (Express/Node)     │  │
   ValueRad staff         │  │  - auth + RBAC          │  │
   ───────────────────►   │  │  - SMART launch/callback│  │
   own login + roles      │  │  - FHIR read+write      │  │
                          │  │  - lead capture         │  │
                          │  └───────┬────────────────┘  │
                          │          │                    │
                          │   ┌──────▼───────┐  ┌──────┐  │
                          │   │ Postgres     │  │ Job  │  │
                          │   │ - sessions   │  │ queue│  │
                          │   │ - tokens(enc)│  │ (BgQ)│  │
                          │   │ - audit log  │  └──────┘  │
                          │   │ - domain     │            │
                          │   └──────────────┘            │
                          └──────────┬───────────────────┘
                                     │  (Bearer, per-session)
                                     ▼
                          ┌────────────────────────┐
                          │  Epic / EHR  (FHIR R4)  │
                          │  read + write + slots   │
                          └────────────────────────┘
```

Hosted on a **HIPAA-eligible cloud with a signed BAA** (AWS/GCP/Azure) — **not**
GitHub Pages, which can only serve the static storefront.

---

## The five foundational workstreams

### S0.1 — Durable, encrypted system of record (Postgres)

Replace the in-memory `Map` with Postgres. Minimum tables:

| Table | Purpose | Sensitivity |
|---|---|---|
| `sessions` | active SMART sessions, short-lived handle → context | references PHI |
| `oauth_tokens` | access/refresh tokens, **encrypted at rest** (app-level envelope encryption, not just disk) | secret |
| `audit_log` | append-only: who/what/when for every PHI read & every write | compliance-critical |
| `users` | ValueRad staff accounts | PII |
| `roles` / `user_roles` | RBAC (see S0.3) | — |
| `leads` | demo/waitlist captures from the storefront | PII (low) |
| `fhir_cache` (optional) | short-TTL cache of read resources to cut EHR load | references PHI |

Rules: tokens **never** returned to the browser (the current code already gets
this right at `smart.js:160`); `audit_log` is append-only (no `UPDATE`/`DELETE`
grant for the app role); connection over TLS; encryption at rest enabled.

### S0.2 — FHIR **write** capability (turns observation into action)

Extend `FhirClient` (`server/lib/fhir.js`) beyond `GET`:

- `create(resource, body)` → `POST {base}/{resource}` with
  `Content-Type: application/fhir+json`.
- `update(resource, id, body)` → `PUT`.
- Slot/scheduling: implement against the EHR's scheduling surface. **Note:**
  Epic scheduling frequently is *not* plain FHIR `Appointment.create` — it uses
  Epic's scheduling APIs / `$find`-style slot operations and open-scheduling
  endpoints. Build a `SchedulingClient` abstraction so Stage 1 doesn't hardcode
  one vendor's quirks.
- Every write goes through a single choke point that writes an `audit_log` row
  **before** returning. No write bypasses the audit.

### S0.3 — Identity & RBAC for ValueRad's own users

SMART authenticates the *clinician via Epic*; it says nothing about *who at
ValueRad* may act. Add:

- Staff login (start with a vetted identity provider; do not roll your own crypto).
- Roles: `scheduler`, `auth_specialist`, `radiologist`, `admin`, `executive`.
- Every API route declares the role(s) it requires; default-deny.
- This is also the seam where, later, the **agent** becomes a "user" with a
  tightly-scoped role and its own audit identity — so every autonomous action is
  attributable.

### S0.4 — Async job backbone (because payers are slow)

Prior auths take **days**; reminders fire on schedules; payer webhooks arrive
whenever. Request/response handlers cannot model this. Add:

- A job queue (e.g., a Postgres-backed queue like `pg-boss`, or BullMQ/SQS) for
  long-running and scheduled work.
- A webhook intake endpoint (signed, verified) for payer/EHR callbacks.
- State machines for multi-step flows (auth: `draft → submitted → pending →
  approved|denied → escalated`). This is the skeleton Stage 2 hangs on.

### S0.5 — Compliance & operational hygiene (the substrate of trust)

- **Audit logging**: every PHI read and every write, immutable, queryable.
- **Encryption**: in transit (TLS everywhere) and at rest (DB + token envelope).
- **Secrets**: out of code and `.env`-in-repo; use a secrets manager. The current
  `EPIC_CLIENT_ID`/`SECRET` defaults in `smart.js:26-28` must come from the vault.
- **PHI-safe logging**: replace `console.error(...)` with structured logging that
  never emits PHI; ship logs to a managed, access-controlled sink.
- **BAAs**: signed with the cloud host *and* — critically — with the LLM provider
  before any PHI reaches a model in later stages.
- **CI**: tests + lint on every PR (today there are none, and `deploy.yml` only
  builds the static front end).

---

## Concrete first-PR-after-this checklist (smallest safe slice)

1. Stand up Postgres; migrate `sessions` + `oauth_tokens` (encrypted) out of the
   `Map`. Add `audit_log` and write to it on every FHIR read.
2. Add token **refresh** + durable token storage (today a restart logs everyone
   out).
3. Add `create`/`update` to `FhirClient` behind the audited write choke point —
   no scheduling logic yet, just the safe capability.
4. Add a real `leads` table + `POST /api/leads` so the storefront form captures
   instead of pretending (see waste cleanup).
5. Move the backend to a HIPAA-eligible host; put secrets in a vault; add CI.

Each item is independently shippable and independently auditable. Do them in
order; do not skip to Stage 1 scheduling until S0.1–S0.2 are real.

---

## What Stage 0 explicitly does NOT include

No agent. No LLM. No scheduling optimization. No prior-auth logic. No BI. Those
are Stages 1–4, and every one of them is *safer and cheaper* to build once this
floor exists. The discipline of Stage 0 is the difference between a command
center and a liability.
