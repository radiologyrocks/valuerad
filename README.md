# ValueRad

A radiology practice command center that runs itself under governance:
scheduling, eligibility, prior auth, worklist routing, executive BI, supply
chain — operated by guardrailed agents, extended by **living software**
(features users request in plain language, generated as data, tested against
golden fixtures, and activated only by a human).

Every line of this codebase was written by an agent under human direction.
The governance machinery that makes that safe — tiered generation, golden
evidence, canary promotion, signed attestations, an append-only audit log —
*is* the product.

## What's here

| Path | What it is |
|---|---|
| `src/` | React/Vite storefront + the Command Center dashboard (agents, BI, living features, supplies — with phone-camera UDI scanning) |
| `server/` | Express backend: SMART-on-FHIR Epic launch, encrypted token store, RBAC + service principals, audit log, the agents, the definition engine, the MCP surface. See [`server/README.md`](server/README.md) |
| `docs/` | Strategy + architecture, written before the code that implements them |
| `CLAUDE.md` | Agent onboarding: conventions and the invariants that must never break |

## Quickstart (dev, no credentials needed)

```bash
# backend — in-memory store, all 137 tests offline
cd server && npm install && npm test && npm run dev   # :3001

# frontend
npm install && npm run dev                            # VITE_API_BASE=http://localhost:3001

# optional: drive the whole command center from Claude Code
claude mcp add valuerad -- node server/mcp.js
```

Agents run on an `ANTHROPIC_API_KEY`, or — dev only — on a Claude Pro/Max
subscription via `claude /login` (see `server/README.md` → Agent auth).

## The documents

| Doc | The question it answers |
|---|---|
| [`docs/COMMAND_CENTER_ASSESSMENT.md`](docs/COMMAND_CENTER_ASSESSMENT.md) | Where does a radiology P&L actually bleed, and what should an agent run? |
| [`docs/STAGE_0_ARCHITECTURE.md`](docs/STAGE_0_ARCHITECTURE.md) | What substrate must exist before any agent touches PHI? |
| [`docs/LIVING_SOFTWARE.md`](docs/LIVING_SOFTWARE.md) | How do users grow their own features, safely, with provenance? |
| [`docs/FUTURE_PROOFING.md`](docs/FUTURE_PROOFING.md) | Where is software development going, and is this the right shape? |
| [`docs/SUPPLY_CHAIN.md`](docs/SUPPLY_CHAIN.md) | UDI/GS1 scanning (phone vs. scanner) and gated automated ordering |
| [`docs/TENANCY.md`](docs/TENANCY.md) | The multi-tenant design, written before customer #2 makes it expensive |
| [`docs/EPIC_HYPERSPACE.md`](docs/EPIC_HYPERSPACE.md) | How this loads inside Epic for schedulers and auth staff |
| [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) | The honest blueprint→code map, including what still needs live wiring |

## Production posture

The software is ready for integration, not yet integrated: it needs a
HIPAA-eligible host with a BAA, a real IdP, production Epic registration,
payer channels, and an Anthropic key (with BAA before PHI reaches the ops
agent). Those are deployment and contractual steps — the seams are built and
tested. `NODE_ENV=production` refuses to start without a durable encrypted
store, refuses dev-header auth, and refuses subscription-auth agents.
