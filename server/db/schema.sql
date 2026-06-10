-- Stage 0 schema — the durable, encrypted system of record.
-- Applied idempotently on boot by lib/db.js when DATABASE_URL is set.

-- Short-lived SMART launch handshakes (state -> PKCE verifier + endpoints).
CREATE TABLE IF NOT EXISTS launch_states (
  state         TEXT PRIMARY KEY,
  data          JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);

-- Authenticated sessions / EHR context, keyed by an opaque session id.
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  fhir_base_url TEXT NOT NULL,
  token_endpoint TEXT,
  patient_id    TEXT,
  encounter_id  TEXT,
  patient_resource JSONB,
  scope         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);

-- OAuth tokens, encrypted at rest (see lib/crypto.js). One row per session.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  session_id        TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  access_token_enc  TEXT NOT NULL,
  refresh_token_enc TEXT,
  token_type        TEXT,
  scope             TEXT,
  expires_at        TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only audit log: every PHI read and every write.
-- No UPDATE/DELETE should ever be granted to the application role.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor       TEXT,            -- ValueRad user / agent id, or 'system'
  session_id  TEXT,
  action      TEXT NOT NULL,   -- e.g. fhir.read, fhir.write, token.refresh
  resource    TEXT,            -- e.g. Patient/123
  outcome     TEXT NOT NULL,   -- success | error
  detail      JSONB
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at);
CREATE INDEX IF NOT EXISTS audit_log_session_idx ON audit_log (session_id);

-- ValueRad's own staff/users and roles (RBAC). The agent later gets a row here
-- too, so every autonomous action is attributable.
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT UNIQUE NOT NULL,
  display_name TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,  -- scheduler | auth_specialist | radiologist | admin | executive | agent
  PRIMARY KEY (user_id, role)
);

-- Async job backbone seam (Stage 2 hangs prior-auth state machines here).
CREATE TABLE IF NOT EXISTS jobs (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed
  run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (status, run_after);

-- Storefront lead capture.
CREATE TABLE IF NOT EXISTS leads (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  organization TEXT NOT NULL,
  message      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- BI warehouse — a generic fact store. Each row is one record (claim,
-- appointment, study, referral, slot) tagged by `dataset`, ingested from CSV
-- extracts or direct JSON. The metric engine (domain/bi.js) queries by dataset.
CREATE TABLE IF NOT EXISTS wh_facts (
  id          BIGSERIAL PRIMARY KEY,
  dataset     TEXT NOT NULL,
  payload     JSONB NOT NULL,
  source      TEXT,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wh_facts_dataset_idx ON wh_facts (dataset);

-- Living-feature registry — the system of record for user-requested,
-- system-built features (docs/LIVING_SOFTWARE.md). Rows are versioned and
-- never overwritten: a new version is a new row; rollback re-points the
-- active version. `definition` is declarative DSL data (domain/dsl.js),
-- never code. `test_evidence` is the golden-test attestation bundle.
CREATE TABLE IF NOT EXISTS living_features (
  id             BIGSERIAL PRIMARY KEY,
  feature_key    TEXT NOT NULL,
  version        INT NOT NULL DEFAULT 1,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL,   -- report | export | rule_pack | ingest_mapper
  tier           INT NOT NULL,    -- 1 declarative read-only | 2 constrained config
  spec           TEXT,            -- the natural-language request it was built from
  definition     JSONB NOT NULL,
  status         TEXT NOT NULL DEFAULT 'proposed', -- proposed|canary|active|retired|rejected
  content_hash   TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  created_by     TEXT,
  approved_by    TEXT,
  test_evidence  JSONB,
  history        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (feature_key, version)
);
CREATE INDEX IF NOT EXISTS living_features_status_idx ON living_features (status, kind);

