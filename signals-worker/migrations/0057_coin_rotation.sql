-- Coin rotation on paper (scripts/coin-rotation.mjs, coin-rotation-v1). Each
-- UTC day, for each horizon (2 and 40 days), the 100 most-traded Binance coins
-- split into laggards (long) and leaders (short) by their move against the
-- rest of the market, logged with entry closes BEFORE the days they are judged
-- on, and scored in place when those days have passed. Nothing is traded.
-- docs/CADENCE.md, sections 4 and 7, has the evidence.
CREATE TABLE IF NOT EXISTS coin_rotation_cohorts (
  model_version TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  formed_on TEXT NOT NULL,              -- the UTC day whose close forms the cohort
  matures_on TEXT NOT NULL,
  universe_n INTEGER NOT NULL,
  longs_json TEXT NOT NULL,             -- [[symbol, entry close, relative move], ...] laggards first
  shorts_json TEXT NOT NULL,            -- the leaders
  created_at TEXT NOT NULL,
  long_ret REAL,
  short_ret REAL,
  spread REAL,
  net_spread REAL,                      -- spread less 0.2% (both legs, round trip)
  universe_ret REAL,
  laggards_excess REAL,                 -- long leg less 0.2% less the universe: the long-only version
  n_scored INTEGER,
  scored_at TEXT,
  PRIMARY KEY (model_version, horizon_days, formed_on)
);
CREATE INDEX IF NOT EXISTS idx_coin_rotation_open ON coin_rotation_cohorts(model_version, scored_at, matures_on);

CREATE TABLE IF NOT EXISTS coin_rotation_runs (
  run_at TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  formed INTEGER NOT NULL,
  scored INTEGER NOT NULL
);

-- Whether each horizon's live record is clearing its costs, so the push fires
-- once when it starts to and not on every run while it does.
CREATE TABLE IF NOT EXISTS coin_rotation_alerts (
  model_version TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('paying', 'not')),
  changed_at TEXT NOT NULL,
  detail TEXT,
  PRIMARY KEY (model_version, horizon_days)
);
