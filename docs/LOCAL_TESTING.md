# Local Testing

How to run the whole product on your own machine — no cloud, no database, no
API key, no PHI. This is the right setup for hands-on testing.

## Run it

```bash
# 1. Backend (terminal 1) — in-memory store, boots in seconds
cd server
npm install
npm run dev                 # http://localhost:3001

# 2. Seed realistic demo data (terminal 2) — so the dashboard isn't empty
npm run seed                # ingests BI data, installs 2 features, stocks supplies

# 3. Frontend (terminal 3)
cd ..                       # repo root
npm install
npm run dev                 # http://localhost:5173  (proxies to :3001)
```

Open http://localhost:5173 → the Command Center. With the seed run you'll see
a populated BI scorecard, two active (signed) living features, four stocked
supply items, and one auto-proposed reorder waiting for your confirmation.

Everything runs against the **in-memory dev store** — restart wipes it, which
is what you want for testing. `/health` shows `store: memory`.

## What you can test without any credentials

- **BI**: load the CEO scorecard, ingest your own CSV extracts, see metrics.
- **Living features**: request a feature in plain language (needs the agent —
  see below), install/approve from the certified catalog, run a report,
  grade a rubric on approval, roll back.
- **Supplies**: scan barcodes (see below), watch a consume trip the reorder
  point and auto-propose a gated order, confirm/place it.
- **Operations agent** (needs the agent — see below): ask it to work a
  scheduling/eligibility task in **recommend mode** (it proposes, never acts).

## Running the agent on your Claude subscription (no API key)

The agents fall back to your Claude Pro/Max login when no `ANTHROPIC_API_KEY`
is set:

```bash
claude /login                     # once, with your Pro/Max account
# leave ANTHROPIC_API_KEY UNSET (a set key overrides subscription auth)
```

Then "Request feature" and "Run agent" work, drawing on your plan's monthly
Agent SDK credits instead of per-token billing. Dev-only by design.

## Barcode scanning — phone vs. laptop

The supply scanner reads UDI/GS1 barcodes. Capture works three ways through
one input (the field also accepts a hardware wedge scanner or typed codes):

- **Laptop webcam:** works on `http://localhost` out of the box — browsers
  treat localhost as a secure context, so the camera is available. Just click
  **Camera** in the Supplies card. (Try the seeded GTIN `00380740000011`.)
- **Your phone:** a phone can't reach your laptop's `localhost`, and over the
  LAN (`http://192.168.x.x`) the browser blocks the camera (not HTTPS). To
  scan a real box with your phone you need HTTPS — easiest is a tunnel:

  ```bash
  # one command, gives an https URL that reaches your local server
  npx cloudflared tunnel --url http://localhost:5173
  # (or: ngrok http 5173)
  ```

  Open the printed `https://…` URL on your phone, allow the camera, scan.
- **No camera at all:** type or paste a code into the field and press Enter.
  Bracketed GS1 works too, e.g. `(01)00380740000011(17)270331(10)LOT42`.

## Identity in dev

The frontend sends dev headers (`X-ValueRad-User` / `X-ValueRad-Roles`,
defaults `executive,admin,…`) — see `src/lib/api.js`. This is **dev-only**;
production rejects header auth and requires a real IdP. Approvals you click in
the dashboard are recorded as a human approver (which is why they work);
the MCP/service-principal path is a *machine* identity and is correctly
refused at approval gates.

## Tests & checks (offline)

```bash
cd server && npm test     # unit suite (memory backends), ~140 tests
cd server && npm run eval # deterministic eval suite
npm run lint              # from repo root — ESLint over src + server
```
