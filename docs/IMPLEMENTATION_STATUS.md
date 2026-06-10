# Implementation Status — blueprint → code

Maps every stage of the command-center blueprint to the modules and tests that
now implement it. "In code" means the logic exists and is unit-tested; "Needs
live wiring" means the seam exists but requires external credentials/infra
(production Epic, payer connections, a HIPAA host, an Anthropic key) that can't
live in the repo.

## Stage 0 — Foundation ✅ in code
| Capability | Module | Tests |
|---|---|---|
| Durable encrypted store (Postgres + dev memory) | `lib/store.js`, `db/schema.sql`, `lib/db.js` | `test/store.test.js` |
| Token encryption at rest (AES-256-GCM) | `lib/crypto.js` | `test/crypto.test.js` |
| Append-only audit log | `lib/store.js` (`audit`) | `test/store.test.js` |
| FHIR write capability + scheduling seam | `lib/fhir.js` | — |
| Automatic SMART token refresh | `lib/smart.js`, `routes/smart.js` | — |
| RBAC for ValueRad users + agent identity | `lib/rbac.js` | exercised in routes |
| Async job backbone | `lib/jobs.js` | `test/jobs.test.js` |
| Lead capture | `routes/leads.js` | — |
| Production guard (no PHI without DB + encryption) | `index.js` | — |

**Needs live wiring:** a HIPAA-eligible host + BAA, real `DATABASE_URL` /
`TOKEN_ENC_KEY` / `EPIC_*`, a real IdP behind `lib/rbac.js`.

## Stage 1 — Scheduling (magnet utilization) ✅ in code
| Capability | Module | Tests |
|---|---|---|
| Explainable no-show risk | `domain/scheduling.js` (`noShowRisk`) | `test/domain.test.js` |
| Utilization-first slot ranking | `domain/scheduling.js` (`rankSlots`) | `test/domain.test.js` |
| Waitlist backfill | `domain/scheduling.js` (`bestBackfill`) | `test/domain.test.js` |
| Booking via scheduling seam | `agent/tools.js` (`book_appointment`) | `test/agent.test.js` |

**Needs live wiring:** Epic scheduling API behind `SchedulingClient`
(`lib/fhir.js`) — Epic scheduling is often not plain FHIR `Appointment.create`.

## Stage 1.5 — Eligibility ✅ in code
| Capability | Module | Tests |
|---|---|---|
| Benefits evaluation before high-cost booking | `domain/eligibility.js` | `test/domain.test.js` |

**Needs live wiring:** FHIR `Coverage` reads (the read path exists in `lib/fhir.js`).

## Stage 2 — Prior authorization ✅ in code
| Capability | Module | Tests |
|---|---|---|
| Auth-required rules | `domain/priorauth.js` (`authRequired`) | `test/domain.test.js` |
| Lifecycle state machine | `domain/priorauth.js` (`transition`) | `test/domain.test.js` |
| "Nothing high-cost scans without a valid auth" | `domain/priorauth.js` (`safeToPerform`) + `agent/policy.js` | `test/domain.test.js`, `test/agent.test.js` |
| Async submission/polling | `agent/tools.js` (`submit_prior_auth`) + `lib/jobs.js` | `test/jobs.test.js` |

**Needs live wiring:** payer connections (clearinghouse / payer portals), and
per-contract auth rules to extend `PAYER_EXCEPTIONS`.

## Stage 3 — Automate everything tractable ✅ in code
| Capability | Module | Tests |
|---|---|---|
| Radiologist worklist routing / load-balancing | `domain/worklist.js` | `test/bi.test.js` |
| Reminders, backfill, escalation as agent tools | `agent/tools.js` | `test/agent.test.js` |

## Stage 4 — Business intelligence ✅ in code
| Capability | Module | Tests |
|---|---|---|
| Utilization, no-show, auth, modality mix, payer leakage, exec snapshot | `domain/bi.js` | `test/bi.test.js` |
| Executive endpoint (RBAC-gated) | `routes/bi.js` | smoke-tested |

**Needs live wiring:** a data warehouse feeding `domain/bi.js` from the
operational record accumulated in Stages 1–3.

## The agent (five planes) ✅ in code
| Plane | Module | Tests |
|---|---|---|
| Data (senses) | FHIR reads + domain data injected as `services` | — |
| Action (typed, audited tools) | `agent/tools.js` | `test/agent.test.js` |
| Guardrails (conscience) | `agent/policy.js` | `test/agent.test.js` |
| Memory (record) | `lib/store.js` audit + jobs | `test/store.test.js` |
| Orchestration (nervous system) | `agent/runner.js` — manual loop on `claude-opus-4-8`, adaptive thinking, recommend mode default | `test/agent.test.js` (injected client) |

**Needs live wiring:** `ANTHROPIC_API_KEY` + a signed BAA with the LLM provider
before any PHI reaches the model. The runner is built and tested with an
injected client; `POST /api/agent/run` returns 503 until the key is set.

## Living software (docs/LIVING_SOFTWARE.md) ✅ in code
| Capability | Module | Tests |
|---|---|---|
| Definition DSL + interpreter over the metric library | `domain/dsl.js` | `test/dsl.test.js` |
| Tier policy, lifecycle state machine, content hash, golden harness | `domain/feature.js` | `test/features.test.js` |
| Synthetic golden fixtures (the builder's only data) | `domain/fixtures.js` | used throughout |
| Versioned feature registry (Postgres + dev memory) | `lib/features.js`, `db/schema.sql` | `test/features.test.js` |
| Certified catalog (reports, export, rule pack, mapper) | `domain/catalog.js` | `test/features.test.js` |
| Builder agent (validate → propose; can never activate) | `agent/builder.js` | `test/builder.test.js` |
| Lifecycle/run/canary/rollback/revalidate API, audited | `routes/features.js` | smoke-tested |
| Payer rule packs feeding the auth guardrail | `domain/priorauth.js`, `agent/policy.js`, `routes/agent.js` | `test/features.test.js` |
| Ingest mappers applied at `/api/bi/ingest` | `routes/bi.js` + `domain/dsl.js` (`applyMapper`) | `test/dsl.test.js` |
| Request box, approval queue, gallery, run/rollback UI | `src/pages/CommandCenter.jsx` | — |
| MCP surface (16 tools, thin client over the audited API) | `mcp.js` | `test/mcp.test.js` |
| Outcome rubrics captured + graded at activation | `agent/builder.js`, `routes/features.js` | `test/features.test.js` |
| Service principals (machine identities, hashed tokens) | `lib/principals.js`, `lib/rbac.js`, `routes/principals.js` | `test/principals.test.js` |
| Signed attestations at activation (Ed25519) | `lib/attest.js` | `test/attest.test.js` |
| Eval suite: metric coverage + catalog regression + seams | `domain/evals.js`, `npm run eval` | `test/evals.test.js` |
| Subscription dev transports for both agents | `agent/runnerDev.js`, `agent/builderDev.js` | `test/runnerDev.test.js`, `test/builderDev.test.js` |

**Needs live wiring:** `ANTHROPIC_API_KEY` for the builder (no BAA needed on
this path — the builder only ever sees schema docs and synthetic fixtures),
and the same IdP/Postgres production prerequisites as Stage 0.

## Honest boundary
Every piece of business logic and the full agent architecture are implemented
and tested in-repo. What remains is **integration and infrastructure**, not
design: connect production Epic, payer channels, a data warehouse, a HIPAA host,
an IdP, and an Anthropic key with a BAA. Those are deployment/contractual steps —
the software is ready for them via the seams above.
