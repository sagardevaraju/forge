CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  zip3 TEXT NOT NULL,
  county TEXT,
  lat REAL, lon REAL,
  tiv REAL NOT NULL,
  build_year INTEGER,
  build_type TEXT,
  flood_zone TEXT,
  elevation_m REAL,
  premium_annual REAL,
  cv_features TEXT,  -- JSON: 8-dim risk vector
  synthetic INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_policies_zip3 ON policies(zip3);

CREATE TABLE IF NOT EXISTS adjusters (
  id INTEGER PRIMARY KEY,
  name TEXT,
  home_lat REAL, home_lon REAL,
  skills TEXT,  -- JSON: ["wind", "flood", "hail"]
  daily_capacity INTEGER
);

CREATE TABLE IF NOT EXISTS staging_zones (
  id INTEGER PRIMARY KEY,
  name TEXT, lat REAL, lon REAL,
  capacity INTEGER
);

CREATE TABLE IF NOT EXISTS storm_events (
  id INTEGER PRIMARY KEY,
  event_id TEXT UNIQUE,
  year INTEGER, state TEXT, county TEXT,
  event_type TEXT, peak_wind REAL,
  damage_property REAL, source TEXT
);

-- Task P2.33 — Operator pin mechanism.
-- A human operator can override the MIP's recommended action for a specific
-- policy. PRIMARY KEY (policy_id) gives UPSERT semantics: one pin per policy;
-- DELETE to unpin. Pins persist across solves until removed.
CREATE TABLE IF NOT EXISTS pins (
  policy_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  operator TEXT NOT NULL,
  ts TEXT NOT NULL,
  rationale TEXT NOT NULL,
  PRIMARY KEY (policy_id)
);
CREATE INDEX IF NOT EXISTS idx_pins_operator ON pins(operator);
CREATE INDEX IF NOT EXISTS idx_pins_ts ON pins(ts);

-- Task P2.29 — Severity diff vs last refresh.
-- One row per policy_id; each /claims render upserts the current severity
-- (expected loss). The next render compares against this snapshot to render
-- a ↑/↓/= column. Last-write-wins per policy is sufficient for Phase 2; a
-- full audit trail would require a composite PK + retention policy (Phase 3).
CREATE TABLE IF NOT EXISTS claims_history (
  policy_id INTEGER PRIMARY KEY,
  severity REAL NOT NULL,
  snapshot_ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_history_ts ON claims_history(snapshot_ts);

-- Task P2.36 — Content-addressed audit log for chat turns.
-- Each row is keyed by SHA-256(prompt_hash + tool_calls_json + final_hash),
-- so inserting the same turn twice is idempotent (UPSERT semantics via
-- ON CONFLICT DO NOTHING). We store hashes of the prompt and final assistant
-- text plus canonical-JSON of the tool-call sequence (name + args, NOT
-- results) so the table size stays bounded and no sensitive tool-result
-- content lands in the audit. WORM enforcement / retention / UI are P3.
CREATE TABLE IF NOT EXISTS chat_audit (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  user_id TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  tool_calls_json TEXT NOT NULL,
  final_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_audit_ts ON chat_audit(ts);
CREATE INDEX IF NOT EXISTS idx_chat_audit_user_id ON chat_audit(user_id);
