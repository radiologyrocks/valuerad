# Radiology Billing-Exception Automation

Automates the tedious loop a radiologist runs today when the billing company
(MBMS) rejects a claim because the **image/charge doesn't match the dictation or
technique** (e.g. a CT billed *with and without* contrast when the report says
*without* only, or a missing laterality).

**Today:** log into a separate MBMS portal → read the exception → hand-type the
exception/accession number into PowerScribe → find the report → read it → dictate
an addendum.

**With ValueRad:** the MBMS feed lands in an app embedded in Epic. The
radiologist clicks an exception; the app pulls the signed report from
PowerScribe, drafts an addendum with Claude (grounded in what was actually
dictated), and — after the radiologist reviews/edits — pushes the draft back to
PowerScribe for signature and marks the exception resolved. One screen, no
re-keying.

## Flow

```
 MBMS exceptions ──▶  Worklist (embedded in Epic via SMART on FHIR)
                          │  click an exception
                          ▼
        accession ──▶ PowerScribe: fetch signed report text
                          │
                          ▼
            Claude (Opus 4.8) drafts an addendum from the report + the
            flagged mismatch  ──▶  radiologist reviews / edits
                          │
                          ▼
        PowerScribe: create DRAFT addendum (never auto-signed)
                          │
                          ▼
                  MBMS: mark exception resolved
```

The accession number is the key that joins all three systems (MBMS exception ↔
PowerScribe report ↔ Epic study).

## Components

| Piece | File | Notes |
|---|---|---|
| MBMS adapter | `server/lib/mbms.js` | Normalizes exceptions to one shape. `mock` / `file` / `waystar` / `api` sources. |
| File/835 parsers | `server/lib/mbms-parsers.js` | Parse CSV exports and X12 835 ERA denial files into the same shape. |
| PowerScribe adapter | `server/lib/powerscribe.js` | Read report text; create **draft** addendum; build study launch URL. `api` or `mock`. |
| Addendum drafting | `server/lib/addendum.js` | Claude (`@anthropic-ai/sdk`, Opus 4.8, adaptive thinking, structured output). Draft only — a human always signs. |
| FHIR/Epic resolution | `server/lib/fhir.js` | `diagnosticReportByAccession` / `imagingStudyByAccession` for in-Epic context. |
| Routes | `server/routes/billing.js` | `/billing/exceptions…` — see below. |
| SMART launch | `server/routes/smart.js` | Existing Epic App Launch; callback now lands on `/app`. |
| Worklist UI | `src/pages/BillingWorklist.jsx` | Embedded app at `/app`. |
| API client | `src/lib/api.js` | Sends SMART session + user headers. |

## API

| Method & path | Purpose |
|---|---|
| `GET /billing/exceptions[?status=open]` | Worklist |
| `GET /billing/exceptions/:id` | Exception + PowerScribe report + launch URL (+ Epic context if a SMART session header is present) |
| `GET /billing/exceptions/:id/launch` | Study launch URL + Epic `ImagingStudy` |
| `POST /billing/exceptions/:id/draft-addendum` | Claude-drafted addendum `{ addendum, needsReview, reviewReason, model }` |
| `POST /billing/exceptions/:id/push-addendum` | Push reviewed draft to PowerScribe `{ text }` |
| `POST /billing/exceptions/:id/resolve` | Mark resolved in MBMS |

Optional request headers: `x-valuerad-session` (SMART handle, enables Epic
resolution), `x-valuerad-user` (attribution).

## Running locally

```sh
# Backend (mock MBMS + PowerScribe; no external creds needed)
cd server && npm install && cp .env.example .env && npm run dev

# Frontend (Vite proxies /billing and /epic to :3001)
npm install && npm run dev
# open http://localhost:5173/app
```

Set `ANTHROPIC_API_KEY` in `server/.env` to exercise real addendum drafting;
without it the draft endpoint returns a clear `503` and the rest of the workflow
still runs on mock data.

## Going to production — what to confirm

Everything ships behind adapters with `mock` defaults so the workflow is
demonstrable now. To connect the real systems:

1. **MBMS feed** — MBMS (mbms.net) has **no public API**; their platform
   (Resolve) exposes a portal, so the realistic channels are, in order of
   likelihood:
   - **`MBMS_SOURCE=file`** — drop CSV exports and/or X12 835 ERA files into
     `MBMS_FILE_DIR` (an SFTP landing folder or portal-export dir). Parsers live
     in `mbms-parsers.js`; override CSV headers with `MBMS_CSV_COLUMNS` and
     extend `CARC_TEXT` / REF handling against real files.
   - **`MBMS_SOURCE=waystar`** — MBMS uses the Waystar clearinghouse, which
     *does* publish a denial/claim-status REST API. Set `WAYSTAR_API_BASE_URL`,
     `WAYSTAR_CLIENT_ID`, `WAYSTAR_CLIENT_SECRET`; confirm endpoint paths against
     Waystar's API docs and your account's enablement.
   - **`MBMS_SOURCE=api`** — only if MBMS ever provisions a direct REST API for
     your account; set `MBMS_API_BASE_URL` / `MBMS_API_KEY` / `MBMS_AUTH_HEADER`
     and adjust `MbmsApiSource`.

   Ask your MBMS rep: (a) API access or portal/SFTP only? (b) can we get a
   scheduled CSV/835 export to an SFTP endpoint? (c) do you run denials through
   Waystar, and can we get account-scoped Waystar API credentials?
2. **PowerScribe** (`POWERSCRIBE_SOURCE=api`). Work with the Nuance/site
   integration team to get the Reporting web-services endpoint + credentials.
   Fill in the report-lookup and addendum-create calls in
   `PowerScribeApiSource`. Set `POWERSCRIBE_LAUNCH_SCHEME` (desktop URI) or
   `POWERSCRIBE_LAUNCH_URL` so **Launch study** opens the exam directly.
3. **Epic** — register the SMART app, set `EPIC_CLIENT_ID` / `EPIC_REDIRECT_URI`,
   and set `ACCESSION_IDENTIFIER_SYSTEM` to the FHIR identifier system Epic uses
   for accessions at your site.
4. **Session store** — `server/lib/sessions.js` is in-process; move to Redis/DB
   before running more than one instance. The FHIR access token lives here and
   must never reach the browser.

## Safety / PHI

- **No auto-signing.** Addenda are created as drafts; a radiologist reviews,
  edits, and signs in PowerScribe.
- **Grounded drafting.** The prompt forbids inventing findings, contrast,
  laterality, etc. If the report can't resolve the mismatch, the model sets
  `needsReview` and drafts a clarification request instead of guessing.
- **PHI handling.** Report text and patient identifiers transit to the Claude
  API for drafting — ensure a BAA and appropriate data-handling review are in
  place before using real PHI. Mock mode uses synthetic data only.
