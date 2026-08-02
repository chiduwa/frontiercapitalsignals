-- Reliability-learning schema for the confluence engine. Applied once via:
--   npx wrangler d1 execute frontier-capital-signals-reliability --file=scripts/schema.sql --remote
-- Idempotent (IF NOT EXISTS) so re-running it is harmless.

CREATE TABLE IF NOT EXISTS asset_price_log (
  run_at TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  price REAL NOT NULL,
  PRIMARY KEY (run_at, symbol)
);

CREATE TABLE IF NOT EXISTS technique_votes (
  run_at TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  technique_id TEXT NOT NULL,
  dir INTEGER NOT NULL,
  evaluated_24 INTEGER NOT NULL DEFAULT 0,
  evaluated_168 INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_at, symbol, technique_id)
);

CREATE TABLE IF NOT EXISTS technique_reliability (
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  technique_id TEXT NOT NULL,
  horizon_hours INTEGER NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  accuracy REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, technique_id, horizon_hours)
);

CREATE INDEX IF NOT EXISTS idx_technique_votes_run_at ON technique_votes(run_at);

-- Realized move size per asset per horizon (mean/stdev via running sum and
-- sum-of-squares), independent of any technique — a fixed aggregate keyed
-- by (symbol, horizon), not append-only, so it doesn't need pruning.
CREATE TABLE IF NOT EXISTS asset_move_stats (
  symbol TEXT NOT NULL,
  horizon_hours INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  sum_pct REAL NOT NULL DEFAULT 0,
  sum_pct_sq REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, horizon_hours)
);

-- The predicted [low, high] band for every asset, logged every run at two
-- fixed horizons (24h and 168h, matching HORIZONS_HOURS in reliability.mjs)
-- regardless of which horizon the dashboard happens to display that hour —
-- so scoring is always an apples-to-apples 1-day-band-vs-1-day-later and
-- 7-day-band-vs-7-day-later comparison. Unlike technique_votes, each row
-- only ever matures once (its own horizon_hours), so there's no
-- evaluated_* flag: a row is scored then deleted in the same pass.
CREATE TABLE IF NOT EXISTS range_log (
  run_at TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon_hours INTEGER NOT NULL,
  low REAL NOT NULL,
  high REAL NOT NULL,
  PRIMARY KEY (run_at, symbol, horizon_hours)
);

-- Hit rate for range_log: was the realized price at maturity actually
-- inside the predicted band, not just on the right side of it. Mirrors
-- technique_reliability's shape (hits/total/accuracy instead of
-- correct/total/accuracy, since "hit" here means band containment, not
-- directional agreement).
CREATE TABLE IF NOT EXISTS range_reliability (
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon_hours INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  accuracy REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, horizon_hours)
);

-- ===========================================================================
-- Permanent historical archive. Deliberately separate from the operational
-- tables above (asset_price_log etc.), which are short-retention by design
-- (see reliability.mjs's RETENTION_HOURS/HARD_CAP_HOURS — they exist only to
-- score predictions once they mature, not to remember history). These tables
-- are daily-grain, never pruned, and are what "as far back as possible"
-- actually means going forward: populated once by scripts/backfill-history.mjs
-- (as deep as Yahoo/CoinGecko/Bybit allow today) then appended to once a day
-- by scripts/daily-refresh.mjs, so real depth keeps growing every day after.
-- ===========================================================================

-- One row per (symbol, calendar day). `source` records which upstream this
-- bar came from (yahoo | coingecko) since the two have different depth
-- guarantees (see backfill-history.mjs) — useful when auditing coverage.
CREATE TABLE IF NOT EXISTS asset_daily_bars (
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  date TEXT NOT NULL,
  close REAL NOT NULL,
  high REAL,
  low REAL,
  volume REAL,
  source TEXT NOT NULL,
  PRIMARY KEY (symbol, date)
);

-- Daily funding-rate + open-interest archive for perpetual contracts, from
-- Bybit (both the live-snapshot ticker endpoint already used in worker.js
-- and the separate funding/history + open-interest endpoints backfill-
-- history.mjs pulls). Unlike the live `funding` field already used in the
-- 'positioning' technique (a single current value), this is what lets a
-- technique ask "is today's funding high *for this asset specifically*,"
-- not just "is it above a fixed global number."
CREATE TABLE IF NOT EXISTS funding_rate_daily (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  funding_rate REAL,
  open_interest REAL,
  source TEXT NOT NULL,
  PRIMARY KEY (symbol, date)
);

-- Daily sentiment archive, market-wide and per-asset. Market-wide fields
-- (Fear & Greed from both alternative.me and CoinMarketCap, VIX range
-- position) are carried on the symbol='' sentinel row for that date;
-- per-asset fields (CoinGecko's community up-vote %, CryptoPanic's
-- bullish/bearish post balance) are carried on that symbol's own row.
-- Nullable throughout since CMC/CryptoPanic are optional (gated on
-- CMC_API_KEY/CRYPTOPANIC_API_TOKEN being set — see daily-refresh.mjs).
CREATE TABLE IF NOT EXISTS sentiment_daily (
  date TEXT NOT NULL,
  symbol TEXT NOT NULL DEFAULT '',
  fear_greed_altme INTEGER,
  fear_greed_cmc INTEGER,
  vix_range_pos REAL,
  coingecko_up_pct REAL,
  cryptopanic_score REAL,
  PRIMARY KEY (date, symbol)
);

-- Cross-asset lead/lag relationships, recomputed daily from asset_daily_bars
-- by scripts/daily-refresh.mjs (see computeLeadLag in reliability.mjs). Each
-- row says "leader_symbol's return tends to predict follower_symbol's return
-- `lag_days` later, at correlation `corr`, measured over `samples` days" —
-- overwritten wholesale each run (a relationship that stops working should
-- disappear, not linger), which is why this is a plain UPSERT-by-pair table
-- rather than an append-only log like the tables above.
CREATE TABLE IF NOT EXISTS lead_lag_signals (
  leader_symbol TEXT NOT NULL,
  follower_symbol TEXT NOT NULL,
  lag_days INTEGER NOT NULL,
  corr REAL NOT NULL,
  window_days INTEGER NOT NULL,
  samples INTEGER NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (leader_symbol, follower_symbol)
);

-- Daily snapshot of assetPredictionScore() per symbol (see worker.js) — the
-- existing score is a single cumulative all-time number; this turns it into
-- a real trend line so a degrading/improving asset can actually be detected
-- rather than only ever seeing "the score right now."
CREATE TABLE IF NOT EXISTS asset_score_snapshots (
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  score INTEGER NOT NULL,
  samples INTEGER NOT NULL,
  PRIMARY KEY (symbol, snapshot_date)
);
