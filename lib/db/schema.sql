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
