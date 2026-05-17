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
