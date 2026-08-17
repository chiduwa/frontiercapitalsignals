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

-- Daily options-implied-volatility archive (Deribit's DVOL index — BTC/ETH
-- only, the two currencies Deribit actually publishes it for). Same shape
-- and same job as funding_rate_daily: lets a technique ask "is implied
-- vol high *for this asset specifically, relative to its own history*,"
-- not against a fixed global number. Confirmed live: real daily history
-- back to 2023-11-14 available in a single call (Deribit caps each
-- request at 1000 points), so the first daily-refresh run bootstraps
-- ~2.75 years at once rather than accumulating forward one day at a time.
CREATE TABLE IF NOT EXISTS iv_daily (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  dvol REAL NOT NULL,
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

-- Frequency tally, not a return statistic (distinct shape from
-- time_of_day_stats, which tracks mean/stdev of RETURNS around a slot —
-- this tracks how often a slot IS the day's actual high or low). Bootstrapped
-- once from ~2 years of Yahoo hourly bars (scripts/archive.mjs), then
-- appended to daily from asset_price_log's own retained history (see
-- daily-refresh.mjs) — same methodology both ways: bucket by UTC calendar
-- day, find that day's max-close hour and min-close hour, tally their
-- slots (see slotsForTimestamp in worker.js).
CREATE TABLE IF NOT EXISTS swing_time_stats (
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  slot TEXT NOT NULL,
  extreme_type TEXT NOT NULL, -- 'high' | 'low'
  count INTEGER NOT NULL DEFAULT 0,
  total_days INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, slot, extreme_type)
);

-- Hack/exploit events (DeFiLlama's public tracker — see fetchDefiLlamaHacks
-- in archive.mjs), matched to a tracked symbol only on a strong name match;
-- symbol is NULL for records that didn't clearly match anything we track
-- (kept for later review, never guessed at). Consumed by the 'eventshock'
-- technique in worker.js.
CREATE TABLE IF NOT EXISTS asset_events (
  symbol TEXT,
  event_date TEXT NOT NULL,
  event_type TEXT NOT NULL,
  severity_usd REAL,
  description TEXT NOT NULL, -- DeFiLlama's incident name, e.g. "Super Sushi Samurai" — part of the key since (date, name) is what's actually unique per record, not date alone
  source TEXT NOT NULL,
  PRIMARY KEY (event_date, description)
);

-- Time-of-day / day-of-week behavioral profile per asset: does this asset
-- systematically move in a consistent direction in the `horizon_hours`
-- after a specific clock slot (see slotsForTimestamp in worker.js — UTC
-- hour-of-day, NY-local hour-of-day (DST-aware, so this alone captures
-- midnight ET, NYSE's 9am/4pm hours, without any hardcoded session list),
-- and UTC day-of-week)? Computed every hour by reliability.mjs's
-- evaluateTimeOfDay directly from asset_price_log's own already-logged
-- prices (this run's price vs. the price from `horizon_hours` ago) — both
-- endpoints already exist by the time this runs, so unlike technique_votes
-- there's nothing to wait for or mark evaluated. Same running-sum/sum-of-
-- squares shape as asset_move_stats, just with an added `slot` dimension.
CREATE TABLE IF NOT EXISTS time_of_day_stats (
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  slot TEXT NOT NULL,
  horizon_hours INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  sum_pct REAL NOT NULL DEFAULT 0,
  sum_pct_sq REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, slot, horizon_hours)
);

-- Category -> sector membership (see mapCategoriesToSectors in worker.js
-- and replaceAssetSectors in archive.mjs), recomputed wholesale each day
-- from CoinGecko's per-coin `categories` field — the same call already
-- made for the 'sentiment' technique, so this costs no extra fetches. Feeds
-- computeSectorComposites, which writes SECTOR:<name> composite pseudo-
-- symbols into asset_daily_bars so the existing lead/lag engine
-- (lead_lag_signals above) picks up sector-vs-sector and sector-vs-asset
-- relationships with no engine-level changes.
CREATE TABLE IF NOT EXISTS asset_sectors (
  symbol TEXT NOT NULL,
  sector TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, sector)
);

-- Nullable, populated only for the synthetic 'composite' technique_id rows
-- (see compositeCall's docs in worker.js) — the raw 0-100ish confidence
-- score behind a composite call, not just its direction. Read back inside
-- evaluateMatured (reliability.mjs) at the exact point that row's
-- correctness is already being computed, bucketed into score_calibration
-- below, before the row is pruned by technique_votes' own retention.
--
-- Not wrapped in IF NOT EXISTS: D1's SQLite version doesn't support
-- `ADD COLUMN IF NOT EXISTS` (confirmed live — syntax error). Applied once
-- directly against production; re-running this file on a database that
-- already has the column will error on this line specifically, same as
-- any other non-idempotent ALTER would. Every CREATE TABLE around it stays
-- safely idempotent.
ALTER TABLE technique_votes ADD COLUMN score REAL;

-- Nullable, populated on every real technique vote (not just composite) —
-- the asset's own swing-structure regime ('trending' when m.structure is
-- 1 or -1, 'choppy' when 0, null when there wasn't enough history yet to
-- compute structure at all) AT THE MOMENT the vote was cast, not
-- recomputed later — regime can (and does) change between when a call is
-- made and when it matures, so evaluateMatured needs the frozen value, not
-- a fresh one. Same non-idempotent-ALTER caveat as the score column above.
ALTER TABLE technique_votes ADD COLUMN regime TEXT;

-- Calibration curve: does a composite call's own confidence score actually
-- predict its real-world hit rate? `bucket` is a decile of the 0-100 score
-- (0-9, covering 0-10% through 90-100%). Permanent aggregate, not pruned —
-- mirrors technique_reliability's own shape (running correct/total), just
-- keyed by score bucket instead of (symbol, technique_id).
CREATE TABLE IF NOT EXISTS score_calibration (
  bucket INTEGER NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bucket)
);

-- Phase 5: which technique PAIRS agreed on direction (both fired the same
-- dir, in the same run, on the same symbol) and how often that pair's
-- shared call was actually right — mined for free inside evaluateMatured's
-- existing due-rows pass over technique_votes, zero extra D1 reads.
-- technique_a/technique_b are canonicalized (alphabetically sorted) so a
-- given pair only ever accumulates under one key, never double-counted as
-- both A+B and B+A. Read-only for now (see evaluateMatured's comments) —
-- consuming a proven-strong pair's weight in evaluateTechniques/confluence
-- is a deliberate v2, not built in this phase.
CREATE TABLE IF NOT EXISTS technique_combo_reliability (
  symbol TEXT NOT NULL,
  technique_a TEXT NOT NULL,
  technique_b TEXT NOT NULL,
  horizon_hours INTEGER NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  accuracy REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, technique_a, technique_b, horizon_hours)
);

-- Phase 6: a technique's own accuracy split by market regime (trending vs.
-- choppy, via the asset's own swing-structure read — see the `regime`
-- column added to technique_votes above) rather than one blended number
-- across both. Same shape as technique_reliability plus the regime column;
-- a separate table rather than widening technique_reliability itself so
-- the existing blended rows/primary key never need to change — loadReliability
-- keeps working exactly as before, this is purely additive.
CREATE TABLE IF NOT EXISTS technique_regime_reliability (
  symbol TEXT NOT NULL,
  technique_id TEXT NOT NULL,
  horizon_hours INTEGER NOT NULL,
  regime TEXT NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  accuracy REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, technique_id, horizon_hours, regime)
);

-- ------------------------- INTRADAY DAY-TRADING SIGNAL ----------------------
-- A separate, higher-frequency pipeline for short (minutes-to-hours)
-- horizons — everything above this line runs on the hourly-ish buildPayload
-- cadence (asset_price_log is written once per build, real-world gap
-- confirmed live at 20-90+ minutes even on a 5-minute cron), which is too
-- sparse for intraday day-trading calls. scripts/intraday.mjs and the
-- dedicated signals-intraday.yml workflow write and read these tables;
-- worker.js's buildPayload/evaluateTechniques engine never touches them.

-- One row per (tick_at, symbol): a cheap live price sample for the curated
-- day-trading watchlist (see selectIntradayWatchlist, scripts/intraday.mjs —
-- top crypto by open interest among symbols with a real USDT perpetual,
-- plus a fixed handful of mega-cap equities). Pruned aggressively by the
-- tick job itself (~30h retention, 48h hard cap) since nothing here needs
-- depth beyond a rolling day.
CREATE TABLE IF NOT EXISTS intraday_price_ticks (
  tick_at TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  price REAL NOT NULL,
  PRIMARY KEY (tick_at, symbol)
);
CREATE INDEX IF NOT EXISTS idx_intraday_ticks_symbol_time ON intraday_price_ticks(symbol, tick_at);

-- One row per (tick_at, symbol, horizon_minutes): intradaySignal (worker.js)
-- computed once per symbol per tick, logged simultaneously against three
-- candidate horizons (15/30/60 min) — the same "compute once, log at
-- several horizons" shape range_log already uses for the 1-day/7-day
-- range predictions. `evaluated` flips once evaluateIntradayMatured has
-- scored the row against the realized price at tick_at + horizon_minutes.
CREATE TABLE IF NOT EXISTS intraday_signal_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick_at TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon_minutes INTEGER NOT NULL,
  dir INTEGER NOT NULL,
  entry_price REAL NOT NULL,
  peaked INTEGER NOT NULL DEFAULT 0,
  bottomed INTEGER NOT NULL DEFAULT 0,
  evaluated INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intraday_signal_log_unique ON intraday_signal_log(tick_at, symbol, horizon_minutes);
CREATE INDEX IF NOT EXISTS idx_intraday_signal_log_due ON intraday_signal_log(horizon_minutes, evaluated, tick_at);

-- Mirrors technique_reliability's shape, keyed by (symbol, horizon_minutes)
-- instead of (symbol, technique_id, horizon_hours) — this is one
-- purpose-built calculation, not competing techniques, so there's no
-- technique-id dimension. reliabilityMultiplier's exact significance gate
-- (worker.js) is reused to decide when a horizon's accuracy is trustworthy
-- enough to display, same as everywhere else.
CREATE TABLE IF NOT EXISTS intraday_reliability (
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon_minutes INTEGER NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  accuracy REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, horizon_minutes)
);

-- Simulated $100-margin position, opened off this pipeline's own
-- directional calls (the 15-minute-horizon intraday_signal_log row —
-- signal_log_id is that row's FK) and closed on liquidation or the
-- horizon elapsing, whichever comes first. One open trade per symbol at a
-- time (see openPaperTrades, scripts/intraday.mjs) — a fresh signal while
-- one's already open is ignored, not queued. status/closed_reason are
-- separate columns rather than one combined enum so "how did it end" is
-- always queryable even while still open (both null).
CREATE TABLE IF NOT EXISTS paper_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_log_id INTEGER NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  dir INTEGER NOT NULL,
  horizon_minutes INTEGER NOT NULL,
  entry_at TEXT NOT NULL,
  entry_price REAL NOT NULL,
  exit_at TEXT,
  exit_price REAL,
  status TEXT NOT NULL DEFAULT 'open',
  closed_reason TEXT,
  leveraged_return_pct REAL,
  pnl_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_paper_trades_open ON paper_trades(status, symbol);

-- Aggregate track record, rolled up incrementally (ON CONFLICT DO UPDATE,
-- same pattern as technique_reliability) so raw paper_trades rows can be
-- pruned on a retention window without losing the history. `bucket` is the
-- UTC close date (YYYY-MM-DD) — mirrors asset_score_snapshots' per-day
-- shape rather than one eternally-blended lifetime row, so a future pass
-- can see whether performance is drifting, not just what it's ever been.
-- The all-time transparency number shown on the dashboard (Phase 4) sums
-- across every bucket for the asset_class.
CREATE TABLE IF NOT EXISTS paper_trade_stats (
  asset_class TEXT NOT NULL,
  bucket TEXT NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  sum_return_pct REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (asset_class, bucket)
);

-- ------------------------- DEEP HISTORICAL BACKFILL --------------------------
-- Sub-daily OHLCV+volume history — asset_daily_bars above is daily-grain
-- only. Crypto-only this round, sourced from Binance.US (binance.com is
-- geo-blocked from this project's US-based infrastructure; Binance.US
-- confirmed live and reachable instead — see backfill-history.mjs's
-- Binance leg). Feeds two things: the time-of-day bootstrap (deeper/more
-- regime-diverse than the Yahoo-hourly leg above, which already covers
-- the whole universe for free) and the correlation-research phases.
CREATE TABLE IF NOT EXISTS asset_hourly_bars (
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  bar_at TEXT NOT NULL,
  close REAL NOT NULL,
  high REAL,
  low REAL,
  volume REAL,
  source TEXT NOT NULL,
  PRIMARY KEY (symbol, bar_at)
);
CREATE INDEX IF NOT EXISTS idx_asset_hourly_bars_symbol ON asset_hourly_bars(symbol, bar_at);
