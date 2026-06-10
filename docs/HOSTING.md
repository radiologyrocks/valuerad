# Hosting decision record — tunnel → VPS

**Status:** Cloudflare tunnel to a Mac is fine for development. Move to a
HIPAA-eligible host *before* the first of these triggers — whichever comes first.

## Move when ANY of these is true

1. **Real PHI touches the system** — i.e. you connect to a *production* Epic
   instance with real patients. A personal Mac is not a defensible HIPAA
   boundary (not a controlled, encrypted-at-rest, access-audited server; it
   sleeps, moves, joins untrusted networks), and the Cloudflare free tunnel is
   not covered by a BAA for PHI. Until then, **Epic sandbox over the tunnel is
   fine.**
2. **Always-on background jobs** — Stage 2 prior-auth polling and reminders run
   24/7. A laptop that sleeps kills the job queue mid-auth. The `jobs` table is
   the flag: the day a worker loop starts, you need a host that never sleeps.
3. **A second person or first pilot** — shared, durable infra with a stable
   public callback URL beats "works while my laptop is awake."

## Critical caveat

"VPS" must mean **a HIPAA-eligible host with a signed BAA** (AWS / GCP / Azure,
or a HIPAA-specific host). A generic VPS with no BAA is *worse* than the Mac for
compliance. "Move to a VPS" and "become HIPAA-defensible" are the same step —
do not separate them.

## Recommended path

- Stay on the tunnel through Stage 0–1 against the **Epic sandbox** (cheap, fast).
- Stand up the HIPAA-eligible host — Postgres + `TOKEN_ENC_KEY` in a real secrets
  manager, TLS, `NODE_ENV=production` — as the deploy target **before** you
  (a) point at production Epic, or (b) turn on Stage 2 job workers.
- Those two events are the hard cut-over line.

## What the host needs

| Need | Why |
|---|---|
| Managed Postgres | durable system of record (sessions, tokens, audit, jobs) |
| Secrets manager | `TOKEN_ENC_KEY`, `EPIC_*`, `DATABASE_URL`, `ANTHROPIC_API_KEY` |
| Always-on compute | job workers (auth polling, reminders) |
| TLS + stable domain | Epic redirect URI, patient-facing links |
| Signed BAA | every vendor that can touch PHI — including the LLM provider |
