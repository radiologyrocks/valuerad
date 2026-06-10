# Loading ValueRad inside Epic Hyperspace

How the command center appears for schedulers and prior-authorization staff
inside Epic, and exactly what to register and test. The OAuth/PKCE handshake is
already implemented in `server/routes/smart.js` — what remains is registration
and the health system's Hyperspace build.

## How it renders
Epic Hyperspace (current client: **Hyperdrive**, Chromium-based) embeds a
SMART-on-FHIR app as an **activity** in a web view. When a user opens it, Epic
calls your **Launch URL** with `?iss=<FHIR base>&launch=<token>`. That drives:

```
Epic activity  →  GET /epic/launch?iss=…&launch=…   (discovers OAuth, redirects)
               →  Epic authorize  (user already signed into Hyperspace)
               →  GET /epic/callback?code=…&state=…  (exchanges tokens)
               →  redirect to  /?session=<id>#/command-center
               →  Command Center loads, calls /epic/context, then drives the
                  agent + BI with X-ValueRad-Session → tools read the live chart
```

The post-launch landing path is configurable via `APP_BASE_URL`
(`server/routes/smart.js`); it defaults to the Command Center.

## Part 1 — What the vendor (you) registers
1. **Host the backend on a public HTTPS URL** reachable from the hospital
   network. Cloudflare tunnel is fine for *sandbox* testing; a HIPAA-eligible
   host + BAA is required for production (see `HOSTING.md`).
2. **Register at `fhir.epic.com`** (Epic developer / vendor services):
   - App type **SMART on FHIR**, **EHR launch (provider-facing)**.
   - **Launch URL** `https://YOURHOST/epic/launch`
   - **Redirect URI** `https://YOURHOST/epic/callback` (exact match)
   - **Scopes**: those in `smart.js` plus `Coverage.read` (eligibility) and
     scheduling **write** for booking.
   - Copy the **Client ID** → set `EPIC_CLIENT_ID` and `EPIC_REDIRECT_URI`.
3. **Test against the Epic sandbox** with the SMART launcher on `fhir.epic.com`
   *before* any real Hyperspace — it sends the same `iss`/`launch` Hyperspace
   does. (Sandbox FHIR base + a test patient are provided there.)
4. **Distribute**: list on **Epic Showroom** (formerly App Orchard), or do a
   **private/direct connection** with a pilot customer (faster, no public
   listing).

## Part 2 — What the health system's Epic team builds (you guide, they do)
5. **Install** the app in their environment; it gets that environment's own
   production Client ID.
6. **Surface it in Hyperspace** for the right roles, gated by security points:
   - **Schedulers** → in the **Appointment Desk** workflow (or a toolbar activity).
   - **Prior-auth staff** → in **Referral / Authorization & Certification**.
7. **Pick the launch context** — patient/appointment-scoped (from a chart or the
   desk) or a non-patient **worklist** launch for back-office queues. `/epic/launch`
   handles whatever context token Epic sends.

## Part 3 — Background workers (separate auth)
The prior-auth polling and reminder jobs run with no logged-in user, so they
cannot use EHR launch. Register a separate **Epic Backend Services** app
(OAuth 2.0 client-credentials with a JWT-signed public key) for system-level
access. This is a second registration on `fhir.epic.com`.

## Quick local test of the embedded flow (no Epic needed)
You can exercise the post-launch landing without Epic by simulating a session:

1. Start the backend and serve the built SPA from the same origin (or set
   `VITE_API_BASE`).
2. Hit `/epic/launch` against the **Epic sandbox** `iss` via the fhir.epic.com
   launcher; on success you land on `/?session=…#/command-center` and the banner
   shows the sandbox patient.

## What is and isn't code
Registration (Part 1), the Hyperspace build (Part 2), and Showroom/security
review are **configuration and contracts** — they require a health system to
enable the app in their environment; there is no code path that bypasses that.
Everything on the application side (launch, token exchange, context, the
embedded Command Center landing, live EHR reads through the session) is
implemented in this repo.
