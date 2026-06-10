# ValueRad — Radiology Command Center Assessment

**Audience:** the CEO who wants this repo to become an AI agent that runs the
radiology business — schedules, secures payer approvals, connects to the EMR,
cuts waste, and grows the book.

**Assessed by three lenses, deliberately in tension:**
1. **The Radiology CEO** — where the money, the waste, and the risk actually live.
2. **The Computer Scientist** — what is really in this repo versus the brochure.
3. **The AI / Healthcare-Integration Architect** — how to make the agent real,
   safe, and EMR-native from day one.

Date of assessment: 2026-06-10.

---

## 0. The one-paragraph truth

You do not have a command center. You have a **marketing landing page** that
*claims* a scheduling product exists, a genuinely useful but **read-only**
Epic/SMART-on-FHIR connector skeleton, and a **dead Vite scaffold** taking up
space. The "MVP to automate scheduling" is not built — there is no database, no
scheduling engine, no agent, no LLM, no prior-authorization logic, and no
write-back to any EMR. The good news: the hardest *trust* problem in healthcare
software — getting a clean OAuth/PKCE handshake into an EHR — is already
half-solved in `server/`. That is the seed. Everything else is greenfield, which
means we can build it correctly instead of refactoring someone else's mistakes.

---

## 1. Ground truth — what is actually in this repo

| Path | What it really is | Verdict |
|---|---|---|
| `src/` | React/Vite/Tailwind **landing page**. Hardcoded metrics, fake testimonials, "Request demo" form that only fires a toast (`HomePage.jsx:153`) and posts nowhere. | Keep as the **storefront**, but stop letting it imply product that doesn't exist. |
| `server/` | Express **SMART App Launch** backend: PKCE, state nonce, SMART discovery, token exchange, and a FHIR proxy. | **The crown jewel.** Real, standards-correct plumbing. But **read-only** and **in-memory** — not yet a product. |
| `server/lib/fhir.js` | Thin FHIR R4 client: Patient, Encounter, ServiceRequest, DiagnosticReport, Appointment — all `GET`. | Solid start. **No writes** = cannot schedule, cannot submit auth. |
| `server/routes/smart.js:24` | `const sessions = new Map()` — sessions live in process memory. | Single-instance only; restart = total session loss. Not production, not HIPAA-durable. |
| `valuerad-frontend/` | Default Vite "Count is {count}" template. | **Pure waste. Delete it.** (See §6 — your own anti-waste mandate.) |
| `.github/workflows/deploy.yml` | Builds `src/` and deploys to **GitHub Pages** (static only). | The Express server **cannot run on Pages.** The deploy ships a brochure, not the product. |

**Architecturally honest summary:** this is ~15% of a Stage-1 foundation. The
EMR doorway is framed; the house is not.

---

## 2. The CEO lens — where the business actually bleeds

You said it perfectly: run it more efficiently than the CEO, remove wasted time,
wasted personnel, wasted capacity. Here is where a radiology P&L actually leaks,
ranked by dollars, because the agent must be pointed at the biggest leaks first —
not the easiest features.

1. **Denied / missing prior authorizations (the #1 revenue leak).**
   MRI, CT, PET, and many ultrasounds require payer pre-auth. Every scan
   performed without a valid auth is a **write-off** — the work is done, the film
   is read, and the claim is denied. This is why your **Stage 2 instinct is
   correct and arguably should be Stage 1-and-a-half**: auth automation protects
   revenue you are *already earning and losing*.

2. **Scanner idle time (your most expensive fixed asset).**
   An MRI magnet costs millions and depreciates whether or not a patient is on
   the table. Every empty slot from a no-show, a late cancel, or a gap the
   scheduler couldn't backfill is margin that evaporates and never returns.
   This is the true target of "automate scheduling" — not booking convenience,
   but **utilization of the magnet.**

3. **No-shows and late cancellations.** Industry no-show rates of 10–20% are
   common. Each is a wasted slot *and* a delayed diagnosis. Reminders help, but
   the real win is **intelligent overbooking + instant waitlist backfill**, which
   requires the agent to act, not just notify.

4. **Radiologist read throughput & worklist routing.** Your most expensive
   *people* are the radiologists. Mis-routed studies, STAT reads buried under
   routine, and subspecialty mismatches waste RVUs. A command center should
   load-balance the worklist, not just the front desk.

5. **Administrative drag (your "wasted personnel").** Front-desk staff on the
   phone for benefits checks, eligibility, faxing auth forms, and rescheduling is
   the single most automatable cost line. This is where headcount is *redeployed*
   (to patient care and growth), not eliminated for its own sake.

6. **Payer contract terms & leakage.** Underpriced contracts, downcoded claims,
   and modality mix that skews toward low-margin work are invisible without BI.
   This is your **Stage 4**, and it is where the agent stops *running* the
   business and starts *growing* it: modeling contract proposals, spotting
   referral-pattern shifts, and flagging when a payer is systematically
   underpaying versus contract.

7. **Referral capture & growth.** Referring physicians are the lifeblood.
   Leakage to competitors, slow report turnaround (referrers leave when reports
   are slow), and no feedback loop on referral volume is lost growth.

**CEO verdict on the roadmap you proposed:**
- **Scheduling MVP** → correct first move, but frame it as *magnet utilization*,
  not *booking UI*.
- **Stage 2 (MRI/CT/US insurance approvals)** → this is where the money is.
  Strongly consider pulling the *eligibility + benefits check* portion forward
  into Stage 1, since you cannot responsibly schedule a high-cost scan you can't
  get paid for.
- **EMR "all along the way"** → **100% correct, and the single most important
  instruction you gave.** An agent disconnected from the EMR is a chatbot. An
  agent native to the EMR is a command center. This must be the spine, not a
  later integration.
- **Stage 3 (automate everything) / Stage 4 (BI)** → right sequence. BI is the
  reward for having clean, EMR-native operational data; it is worthless on top of
  fabricated metrics like the ones currently on the landing page.

---

## 3. The Computer Scientist lens — what must be true before any agent touches a patient

Today's repo cannot safely run a business. Here are the hard gaps, in priority
order, with the *why* spelled out.

1. **There is no system of record.** A `Map()` in Node memory (`smart.js:24`) is
   not a database. You need durable, encrypted storage (Postgres) for sessions,
   audit logs, scheduling state, and auth requests. Without it there is no
   history, no recovery, and no audit trail.

2. **The connector is read-only.** `fhir.js` only does `GET`. To *schedule* you
   need FHIR write/transaction support (`Appointment.create`,
   `$find`/`$book` slot operations, or vendor scheduling APIs — Epic's scheduling
   often lives outside plain FHIR write and needs the Epic scheduling APIs).
   **No writes = no automation, only observation.**

3. **HIPAA is not a feature you add later — it is the substrate.** PHI flows the
   moment you read a `Patient`. You need, minimally: encryption at rest and in
   transit, a complete and immutable **audit log** of every read/write, access
   controls and least-privilege scopes, BAAs with every vendor (including the LLM
   provider), data-retention policy, and breach procedures. The current code
   logs errors to `console` and stores PHI in memory — neither is acceptable for
   production PHI.

4. **The deploy target is wrong for the product.** GitHub Pages serves static
   files; it cannot host the Express server, a database, or background jobs. The
   backend needs a real runtime (a HIPAA-eligible cloud — AWS/GCP/Azure with a
   signed BAA), behind a proper domain with TLS.

5. **No identity for *your* users.** SMART logs in the *clinician via Epic*, but
   there is no notion of ValueRad staff accounts, roles (scheduler vs. admin vs.
   radiologist vs. CEO), or permissions. The command center needs its own
   authz layer on top of EHR context.

6. **No async/event backbone.** Auth approvals, payer responses, and reminders
   are inherently asynchronous and long-running (auths can take days). You need a
   job queue + webhook intake + state machine, not request/response handlers.

7. **No tests, no observability, no secrets management.** A system that books
   real patients and submits real money-bearing requests needs CI tests,
   structured logging (PHI-safe), metrics, and a secrets store — none exist yet.

**CS verdict:** the right next commit is *not* an AI feature. It is the
**data + write + audit + auth substrate**. The agent is only as trustworthy as
the floor it stands on, and right now there is no floor.

---

## 4. The AI / Integration Architect lens — how this becomes an agent that runs the business

The vision — "an AI agent with all the information it needs to run a radiology
business" — is achievable, but only with a specific architecture. A single
prompt with database access is a liability in healthcare. The command center
should be a **constrained agentic system** built from five planes:

### 4.1 The five planes

1. **Data plane (the agent's senses).** EMR-native via FHIR + vendor APIs:
   patients, orders (`ServiceRequest`), encounters, appointments, slots, prior
   reports, and — added next — coverage/eligibility (`Coverage`), and claims.
   Everything the agent knows comes from here, never from training-data guesses.

2. **Action plane (the agent's hands) — as typed, audited tools, not free SQL.**
   Each capability is a discrete tool with a schema, validation, and a permission
   gate: `find_open_slots`, `book_appointment`, `check_eligibility`,
   `submit_prior_auth`, `check_auth_status`, `send_patient_reminder`,
   `route_worklist_study`, `escalate_to_human`. The LLM *chooses and fills* tools;
   it never directly mutates the EMR.

3. **Policy / guardrail plane (the agent's conscience).** Hard rules that sit
   *between* the model and the action plane: never book a high-cost scan without
   verified eligibility; never auto-cancel without human sign-off above a dollar
   threshold; never expose PHI outside the BAA boundary; every clinical-adjacent
   decision is logged and reversible. This is where "the agent runs it better
   than the CEO" stays *safe* — judgment is bounded by policy.

4. **Memory / state plane (the agent's record).** Durable Postgres: every
   decision, every payer interaction, every reschedule, with full audit lineage.
   This is also the raw material for Stage 4 BI — real operational truth, not the
   fabricated metrics currently on the homepage.

5. **Orchestration plane (the agent's nervous system).** An event-driven loop:
   triggers (new order in EMR, payer webhook, no-show detected) → agent reasons →
   proposes tool calls → guardrails approve/deny → execute → record → notify.
   Long-running auths live as state machines, not chat turns.

### 4.2 Build the LLM layer on the latest Claude models

Use the most capable current Claude models (the Opus 4.x / Fable 5 family) via
the Anthropic API, with **tool use** for the action plane and a signed **BAA**
covering PHI. Key patterns: tool-use for every mutation, structured outputs for
extraction (e.g., pulling auth requirements from payer policy text), prompt
caching for the large, stable policy/context blocks, and a cheaper model (Haiku
class) for high-volume classification (e.g., triaging which orders need auth).
**Do not** put PHI into any model or vendor without a BAA in place first.

### 4.3 Human-in-the-loop is a feature, not a weakness

The CEO mandate is efficiency, but the fastest path to a shutdown is one
auto-cancelled cancer follow-up. Start every capability in **"recommend" mode**
(agent drafts, human approves), measure accuracy, and graduate each capability to
**"autonomous"** only once it earns trust on real data. This also makes adoption
political-cost-free with your existing staff.

---

## 5. The staged roadmap, re-cut for reality (EMR as the spine throughout)

Your stages are right. Here they are with the substrate work made explicit and
EMR woven through every one, as you instructed.

### Stage 0 — Foundation (must exist before Stage 1 means anything)
- Add Postgres (sessions, audit log, domain state). Kill the in-memory `Map`.
- Move the backend to a HIPAA-eligible host with a BAA; retire the Pages-hosts-
  the-product assumption.
- Add ValueRad user identity + roles (scheduler, admin, radiologist, CEO).
- Add encryption, immutable audit logging, secrets management, CI tests.
- **EMR:** harden the existing SMART connector; add token refresh and durable
  token storage.

### Stage 1 — Scheduling MVP (reframed as *magnet utilization*)
- Add FHIR/vendor **write**: slot search + `book_appointment`.
- No-show prediction + automated reminders (multi-channel) + **waitlist backfill**.
- Agent in **recommend mode**: proposes optimal slots and backfills; staff approve.
- **EMR:** read orders (`ServiceRequest`) → write `Appointment`; close the loop.

### Stage 1.5 — Eligibility (pulled forward from your Stage 2)
- `check_eligibility` / benefits verification *before* booking high-cost scans.
- Rationale: never schedule a scan you can't get paid for. Protects revenue at
  the moment of booking.
- **EMR:** read `Coverage`; persist eligibility results to the audit record.

### Stage 2 — Prior-authorization automation (MRI / CT / Ultrasound)
- `submit_prior_auth`, `check_auth_status`, payer-rule extraction, async state
  machine for multi-day approvals, escalation to humans on denial/ambiguity.
- This is the **biggest dollar protection** in the whole plan — treat it as such.
- **EMR:** attach auth status to the order and appointment so nothing scans
  without a valid auth.

### Stage 3 — Automate everything tractable
- Worklist routing / radiologist load-balancing, referrer report-turnaround SLAs,
  rescheduling cascades, cancellation backfill, patient comms end-to-end.
- Graduate proven capabilities from recommend → autonomous, one at a time.
- **EMR:** bi-directional, EMR-native by default — the agent operates *inside*
  the clinical data, not beside it.

### Stage 4 — Business intelligence & growth
- Now that operational data is real and clean: utilization dashboards, payer
  leakage detection, modality mix margin analysis, referral-pattern shifts,
  contract-proposal modeling for negotiations, expansion/site-selection analysis.
- This is where the agent stops running the business and starts **growing** it.
- **EMR:** BI is built on the EMR-native operational record accumulated in
  Stages 1–3 — not on the fabricated metrics in today's landing page.

---

## 6. Waste to cut *now* (your anti-waste mandate, applied to the repo itself)

You want every wasted thing removed. Start with the codebase:

1. **Delete `valuerad-frontend/`** — it is the default Vite scaffold and adds
   nothing but confusion and dependency surface.
2. **Stop shipping fabricated metrics.** The "42% fewer no-shows," the named
   testimonials, and the "4.7/5" are invented. They are a compliance and
   credibility liability the moment a real buyer or auditor looks. Replace with
   honest "what it will do" framing until you have real numbers from Stage 1.
3. **Make the demo form actually capture leads** (`HomePage.jsx:153` posts
   nowhere) or remove it — a button that pretends to work is waste.
4. **Fix the deploy story** — the workflow advertises a product it cannot host.

---

## 7. The single most important decision

Pick the **wedge**. The repo's brochure says "scheduling"; the P&L says "prior
auth." Both are right, but you can only build one foundation first. The
recommendation from all three lenses combined:

> **Build the EMR-native substrate (Stage 0) now, ship scheduling + eligibility
> together as the wedge (Stages 1 + 1.5), and aim the very next dollar of
> engineering at prior-auth (Stage 2) — because that is the revenue you are
> already losing today.**

Everything else — the autonomy, the BI, the "runs it better than the CEO" — is
earned on top of that floor, one trustworthy capability at a time.

---

*This document is an assessment and strategic charter, not an implementation. No
PHI, payer, or scheduling logic has been built. The only production-grade asset
in the repo today is the SMART-on-FHIR connector skeleton in `server/`, and even
that is read-only and in-memory.*
