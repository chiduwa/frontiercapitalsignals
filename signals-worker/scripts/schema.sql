-- Point-in-time full-schema snapshot for a BRAND-NEW, EMPTY D1 database.
-- Applied once via:
--   npx wrangler d1 execute frontier-capital-signals-reliability --file=scripts/schema.sql --remote
-- Then seed Wrangler's migration journal with scripts/current-schema-baseline.sql.
-- Existing databases must be upgraded with `wrangler d1 migrations apply`;
-- CREATE TABLE IF NOT EXISTS cannot add later columns to an older table.

CREATE TABLE IF NOT EXISTS asset_price_log (
  run_at TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  price REAL NOT NULL,
  PRIMARY KEY (run_at, symbol)
);

-- The PK leads with run_at, but the dominant read shape across reliability.mjs
-- and notify.mjs is "most recent price for these symbols" (WHERE symbol IN
-- (...) ORDER BY run_at DESC) — a shape the PK can't serve, forcing a full
-- table scan every time it ran. This index matches that shape directly.
CREATE INDEX IF NOT EXISTS idx_asset_price_log_symbol_run_at ON asset_price_log(symbol, run_at DESC);

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
  -- Directional mix of this record's own votes, so noSkillBaseline() can work
  -- out the null accuracy THIS technique should be judged against rather than
  -- assuming 0.5 (see migrations/0003_direction_baseline.sql for why 0.5 is
  -- wrong once outcomes are three-way).
  votes_up INTEGER NOT NULL DEFAULT 0,
  votes_down INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, technique_id, horizon_hours)
);

-- Realized up/flat/down frequencies per asset class and horizon: the no-skill
-- line a directional call actually has to beat. Deduped per (symbol, run_at)
-- so correlated same-hour votes count as the one price move they describe.
-- See migrations/0003_direction_baseline.sql for the full rationale and the
-- measured values that motivated it.
CREATE TABLE IF NOT EXISTS direction_baseline (
  asset_class TEXT NOT NULL,
  horizon_hours INTEGER NOT NULL,
  n_up INTEGER NOT NULL DEFAULT 0,
  n_flat INTEGER NOT NULL DEFAULT 0,
  n_down INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (asset_class, horizon_hours)
);

CREATE INDEX IF NOT EXISTS idx_technique_votes_run_at ON technique_votes(run_at);

-- Partial indexes for evaluateMatured's maturity scan (reliability.mjs,
-- WHERE run_at <= ? AND evaluated_24/168 = 0). idx_technique_votes_run_at
-- above only narrows by time, still forcing a scan of every retained row
-- (most already evaluated) to find the few still pending; these contain
-- only not-yet-matured rows and shrink automatically as rows get evaluated.
CREATE INDEX IF NOT EXISTS idx_technique_votes_pending_24 ON technique_votes(run_at) WHERE evaluated_24 = 0;
CREATE INDEX IF NOT EXISTS idx_technique_votes_pending_168 ON technique_votes(run_at) WHERE evaluated_168 = 0;

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

-- Independent, append-only scored-outcome ledger. Live aggregation uses this
-- as its idempotency boundary: no overlapping forecast windows, and no
-- increment can commit without the row being marked aggregated in the same D1
-- batch transaction. See migrations/0009_independent_retry_safe_outcomes.sql.
CREATE TABLE IF NOT EXISTS forecast_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon_minutes INTEGER NOT NULL,
  series_kind TEXT NOT NULL CHECK (series_kind IN ('technique', 'combo', 'market', 'range', 'intraday')),
  series_key TEXT NOT NULL,
  dir INTEGER,
  actual_dir INTEGER,
  correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
  score REAL,
  regime TEXT,
  return_pct REAL,
  target_at TEXT,
  observed_at TEXT,
  entry_price REAL CHECK (entry_price IS NULL OR entry_price > 0),
  exit_price REAL CHECK (exit_price IS NULL OR exit_price > 0),
  path_high_pct REAL,
  path_low_pct REAL,
  minutes_to_high REAL CHECK (minutes_to_high IS NULL OR minutes_to_high >= 0),
  minutes_to_low REAL CHECK (minutes_to_low IS NULL OR minutes_to_low >= 0),
  model_version TEXT NOT NULL DEFAULT 'confluence-v7',
  label_version TEXT NOT NULL DEFAULT 'direction-deadband-0.5pct-v1',
  evaluated_at TEXT NOT NULL,
  aggregated INTEGER NOT NULL DEFAULT 0 CHECK (aggregated IN (-1, 0, 1)),
  -- 'live' = cast by a scheduled build against the market as it stood.
  -- 'replay' = cast by scripts/replay-history.mjs against archive bars using
  -- only information available at its own anchor date. Both are read by the
  -- loaders; the column keeps the two populations separable so the claim that
  -- they agree stays checkable (migration 0038).
  provenance TEXT NOT NULL DEFAULT 'live',
  CHECK (horizon_minutes > 0),
  CHECK (dir IS NULL OR dir IN (-1, 0, 1)),
  CHECK (actual_dir IS NULL OR actual_dir IN (-1, 0, 1)),
  CHECK (observed_at IS NULL OR target_at IS NULL OR observed_at >= target_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_forecast_outcomes_unique
  ON forecast_outcomes(run_at, asset_class, symbol, horizon_minutes, series_kind, series_key);
CREATE INDEX IF NOT EXISTS idx_forecast_outcomes_latest
  ON forecast_outcomes(asset_class, symbol, horizon_minutes, series_kind, series_key, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_outcomes_provenance
  ON forecast_outcomes(provenance, model_version, series_kind, series_key, run_at DESC);

-- Resume point for the walk-forward replay, one row per (class, horizon, model
-- version). The replay walks anchors forward in time, so newest_anchor_done is
-- the high-water mark and the next run starts strictly after it.
CREATE TABLE IF NOT EXISTS replay_checkpoints (
  asset_class TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  oldest_anchor_done TEXT,
  newest_anchor_done TEXT,
  anchors_done INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  model_version TEXT NOT NULL,
  last_run_at TEXT,
  PRIMARY KEY (asset_class, horizon_days, model_version)
);
CREATE INDEX IF NOT EXISTS idx_forecast_outcomes_pending
  ON forecast_outcomes(aggregated, id) WHERE aggregated = 0;

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
--
-- Legacy constraint: this key predates asset_class and therefore cannot hold
-- two instruments with the same ticker. DASH exposed that defect (Dash crypto
-- versus DoorDash equity). Migration 0012 clears the contaminated series and
-- the runtime now quarantines any crypto ticker present in STOCK_WATCHLIST
-- before it can be logged. That deliberately sacrifices coverage for the
-- colliding crypto until all dependent keys can be widened; it never permits
-- an interleaved series to masquerade as a market pattern.
CREATE TABLE IF NOT EXISTS asset_daily_bars (
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  date TEXT NOT NULL,
  -- Added 2026-08-30 to make the close-to-open ("overnight") effect testable.
  -- Nullable: it did not exist for the first ~694k rows, and the CoinGecko
  -- fallback path never provides it. Backfilled opportunistically by
  -- upsertDailyBars' COALESCE, never invented.
  open REAL,
  close REAL NOT NULL,
  high REAL,
  low REAL,
  volume REAL,
  source TEXT NOT NULL,
  PRIMARY KEY (symbol, date)
);

-- computeMarketComposite/computeOutperformanceRotations/computeLongTerm-
-- BottomCandidates (archive.mjs, run daily) each filter this table by
-- asset_class = 'crypto' (one also OR's in symbol = 'MCAP:BROAD') with
-- nothing to use but the (symbol, date) PK — full scans of the whole table
-- on every run. Can't dedupe these into one shared read the way lead-lag/
-- support-resistance already do (daily-refresh.mjs) since each depends on
-- data the previous one just wrote, so an index is the safe fix here.
CREATE INDEX IF NOT EXISTS idx_asset_daily_bars_asset_class ON asset_daily_bars(asset_class, symbol, date);

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

-- Perp-vs-spot basis (user-requested, 2026-08-21: "binance perpetuals...
-- price suddenly spike or dip... before major pivots" -- investigate, add
-- if it holds). No historical basis is available anywhere (CoinGecko's
-- /derivatives, worker.js's getFundingMap, is a live-snapshot-only
-- endpoint, same reason funding_rate_daily above only ever grows one real
-- day at a time rather than being backfilled) and Binance.com's own perp
-- API is geo-blocked from this project's infra (see archive.mjs's
-- Binance.US docs) -- so this can't be tested retroactively against the
-- archive today. Computed as (perp price / spot index - 1) * 100 from
-- getFundingMap's own price/index fields, NOT CoinGecko's own reported
-- "basis" field, whose exact formula didn't reconcile against price/index
-- in a live spot-check (plausibly annualized or otherwise adjusted) and
-- isn't documented -- this way the number this project stores has a
-- formula we actually understand. Archived daily going forward
-- (backfill-history.mjs, same run that already writes funding_rate_daily
-- from the same getFundingMap() snapshot, zero new fetches) so
-- correlation-research.mjs can actually test the "basis spikes before a
-- pivot" hypothesis in a few weeks once real history exists, rather than
-- fabricating a finding from data that doesn't exist yet.
-- Not wrapped in IF NOT EXISTS, same non-idempotent-ALTER caveat as this
-- file's other added columns — applied once directly against production.
ALTER TABLE funding_rate_daily ADD COLUMN basis_pct REAL;

-- Outperformer-rotation detection (user-requested, 2026-08-21: "every few
-- years there seems to be a new crypto that seems to outperform the rest
-- and moves into the top 10, like solana a few years back, and what now
-- seems to be happening to hyperliquid"). One row per symbol CURRENTLY (or
-- as of the last recomputation) showing a sustained multi-month
-- outperformance streak vs the broad-market composite (detectOutperformance
-- Rotation, worker.js) -- validated live against SOL's own real archive
-- before shipping: correctly found all 4 of its real, independently-
-- documented breakout phases (the 2021-03/06 rally to $37, the 2021-09/12
-- rally to $230, and the 2023-11/2024-05 post-FTX-collapse recovery) with
-- no hand-tuning to SOL specifically. Wholesale replace each day (computeOutperformanceRotations,
-- archive.mjs), same "a relationship that no longer holds should
-- disappear" reasoning as lead_lag_signals -- this is current status, not
-- an append-only log.
CREATE TABLE IF NOT EXISTS asset_rotation_status (
  symbol TEXT PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  checkpoints INTEGER NOT NULL,
  peak_rel_pct REAL NOT NULL,
  updated_at TEXT NOT NULL
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

-- Utility/community fundamentals (added 2026-08-21, user-requested "spot
-- crypto with the most useful utility and community"), piggybacked on the
-- SAME per-coin CoinGecko detail call coingeckoSentiment() already makes
-- for coingecko_up_pct/categories above (community_data=true&
-- developer_data=true instead of false — zero new fetches, just a bigger
-- response). Confirmed live these vary hugely and are often genuinely
-- zero/null per coin (e.g. Hyperliquid has no linked GitHub repo at all
-- on CoinGecko, all-zero developer_data, vs. Ethereum's 44k stars/906 PR
-- contributors) — not a bug, just real, uneven coverage; worker.js's
-- computeQualityScores handles this by cross-sectional percentile rank
-- (this asset vs. every other tracked asset THAT DAY), not an absolute
-- score, and only over whichever of the three groups below have enough
-- non-null coverage that day to rank at all.
-- Not wrapped in IF NOT EXISTS, same non-idempotent-ALTER caveat as
-- technique_votes' score/regime columns above — applied once directly
-- against production.
ALTER TABLE sentiment_daily ADD COLUMN github_commits_4w REAL;
ALTER TABLE sentiment_daily ADD COLUMN github_pr_contributors REAL;
ALTER TABLE sentiment_daily ADD COLUMN community_reach REAL; -- telegram_channel_user_count + reddit_subscribers, comparable "people in a project channel" units
ALTER TABLE sentiment_daily ADD COLUMN watchlist_users REAL; -- CoinGecko's own watchlist_portfolio_users -- a distinct "people tracking this" interest signal

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

-- The more precise companion to score_calibration. It lets alert confidence
-- distinguish crypto from equities, upward from downward calls, and 24h from
-- 168h outcomes. score_calibration remains the warm-up fallback because this
-- table necessarily starts with fewer observations per cell.
CREATE TABLE IF NOT EXISTS score_calibration_detail (
  asset_class TEXT NOT NULL,
  dir INTEGER NOT NULL CHECK (dir IN (-1, 1)),
  horizon_hours INTEGER NOT NULL CHECK (horizon_hours IN (24, 168)),
  bucket INTEGER NOT NULL CHECK (bucket BETWEEN 0 AND 9),
  correct INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (asset_class, dir, horizon_hours, bucket)
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
-- No secondary index here: (symbol, bar_at) is already this table's own
-- PRIMARY KEY. A duplicate idx_asset_hourly_bars_symbol(symbol, bar_at)
-- index used to exist too — same columns, same order, zero read benefit
-- over the PK, but still costing one extra written row on every insert.
-- Dropped 2026-08-25.
DROP INDEX IF EXISTS idx_asset_hourly_bars_symbol;

-- Backtest-seeds the live intraday_reliability table's own numbers by
-- replaying replayIntradaySignal (worker.js) against ~2 years of Binance
-- 15-minute klines (scripts/backtest-intraday.mjs) — deliberately a
-- SEPARATE table, not merged into intraday_reliability or wired into
-- buildIntradayDisplayPayload's adaptive-horizon selection: backtested
-- accuracy on dense, regular candles isn't automatically comparable to
-- live accuracy on genuinely irregular real-world ticks without its own
-- scrutiny first. Replaced (not accumulated) on each run — see
-- backtest-intraday.mjs for why an appending/incrementing shape doesn't
-- fit an occasional re-run over a shifting historical window.
-- Pooled hypothesis-test findings from scripts/correlation-research.mjs —
-- volume-surge, stablecoin-depeg, and (Phase 5) sentiment-extreme correlations against
-- forward returns, tested pooled across the universe (not per-symbol —
-- see the module's own docs for why that avoids the multiple-testing
-- trap) and only recorded once a candidate has independently cleared the
-- significance bar in BOTH chronological halves of history, not just the
-- pooled whole. Empty is a complete, valid research outcome — this table
-- is a log of what was FOUND, not a queue of things still to search for.
CREATE TABLE IF NOT EXISTS correlation_research_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hypothesis TEXT NOT NULL,
  asset_class TEXT,
  horizon_days INTEGER,
  n INTEGER NOT NULL,
  effect_size REAL,
  z REAL,
  split_consistent INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL,
  notes TEXT
);

-- wrong_opposite/wrong_flat (added alongside the intraday polarity check,
-- correlation-research.mjs's intraday_reversal_* findings): splits what
-- used to be a single "wrong" bucket into a genuine reversal (the market
-- moved, just not the way the call predicted) vs. a flat market (the
-- market never moved enough either way) — the distinction the polarity
-- check itself is built on. See replayIntradaySignal's own docs.
CREATE TABLE IF NOT EXISTS intraday_backtest_reliability (
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon_minutes INTEGER NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  wrong_opposite INTEGER NOT NULL DEFAULT 0,
  wrong_flat INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  accuracy REAL NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, horizon_minutes)
);

-- trading-bot/ (../trading-bot/src/*) — a separate deployable, run as a
-- one-shot script every N minutes by .github/workflows/trading-bot-cycle.yml
-- rather than a persistent daemon, so it has no local disk to persist
-- state on between runs. These three tables are its entire state layer
-- (see trading-bot/src/state.mjs) — everything else (balance, open
-- positions) is always re-read fresh from Binance each cycle, never
-- trusted from here, so stale/lost state here can't cause a double-open.
CREATE TABLE IF NOT EXISTS trading_execution_leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (expires_at > acquired_at)
);

CREATE INDEX IF NOT EXISTS idx_trading_execution_leases_expiry
  ON trading_execution_leases(expires_at);

CREATE TABLE IF NOT EXISTS trading_bot_equity_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), -- single row, upsert-only
  peak_equity REAL,
  day_start_equity REAL,
  day_start_date TEXT
);

CREATE TABLE IF NOT EXISTS trading_bot_last_closed (
  symbol TEXT PRIMARY KEY,
  closed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trading_bot_open_orders (
  symbol TEXT PRIMARY KEY,
  side TEXT NOT NULL,
  entry_price REAL NOT NULL,
  margin_used REAL NOT NULL,
  leverage INTEGER NOT NULL,
  range_low REAL,
  range_high REAL,
  -- Exit geometry, resolved once at entry and persisted. Under confluence-v7
  -- the take-profit is no longer derivable from the range alone (it may come
  -- from measured path evidence instead), and the time exit has no other
  -- representation, so a later cycle could not otherwise reconstruct either.
  target_price REAL,
  stop_price REAL,
  time_exit_after_ms REAL,
  source TEXT,
  opened_at TEXT NOT NULL
);

-- The bot's own track record, kept strictly separate from the engine's.
-- Under v7 the engine withholds every direction until independent evidence
-- rebuilds, so a correctly-gated bot places nothing for days or weeks. Every
-- candidate that clears each gate the BOT owns, and fails only because the
-- engine has not authorized a call, is recorded here with the exact entry,
-- stop and target it would have used, and resolved by later cycles against
-- real subsequent prices. Nothing in this table places an order or feeds a
-- sizing decision. See trading-bot/src/paper.mjs and migration 0015.
CREATE TABLE IF NOT EXISTS trading_bot_shadow_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at TEXT NOT NULL,
  signal_generated_at TEXT,
  -- shadow = engine had not authorized; dry = authorized but DRY_RUN;
  -- live = authorized and executed. Never pooled across modes.
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'dry', 'live')),
  source TEXT NOT NULL CHECK (source IN ('confluence-v7', 'research-confirmed')),
  symbol TEXT NOT NULL,
  signal_symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  entry_price REAL NOT NULL CHECK (entry_price > 0),
  stop_price REAL CHECK (stop_price IS NULL OR stop_price > 0),
  target_price REAL CHECK (target_price IS NULL OR target_price > 0),
  position_pct REAL NOT NULL,
  leverage REAL NOT NULL,
  extreme_boost INTEGER NOT NULL DEFAULT 0 CHECK (extreme_boost IN (0, 1)),
  withheld_reason TEXT,
  horizon_hours REAL,
  time_exit_after_ms REAL,
  edge REAL,
  holding_n INTEGER,
  holding_mfe_pct REAL,
  holding_mae_pct REAL,
  holding_hours_to_peak REAL,
  -- Extremes seen since entry, carried forward each cycle: a stop breached
  -- and then recovered between two cycles is a closed trade, and scoring on
  -- the latest price alone would silently drop exactly the losers.
  running_high REAL,
  running_low REAL,
  resolved_at TEXT,
  exit_price REAL CHECK (exit_price IS NULL OR exit_price > 0),
  exit_reason TEXT CHECK (exit_reason IS NULL OR exit_reason IN ('target', 'stop', 'time', 'horizon')),
  -- Signed, leveraged, GROSS of fees and funding: a cost assumption belongs
  -- in the analysis that reads this, not baked into the stored observation.
  return_pct REAL
);

CREATE INDEX IF NOT EXISTS idx_trading_bot_shadow_open
  ON trading_bot_shadow_trades(resolved_at, opened_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_trading_bot_shadow_symbol
  ON trading_bot_shadow_trades(symbol, opened_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_bot_shadow_one_open
  ON trading_bot_shadow_trades(symbol, mode) WHERE resolved_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shadow_signal_identity
  ON trading_bot_shadow_trades(mode, source, symbol, side, signal_generated_at)
  WHERE signal_generated_at IS NOT NULL;

-- ------------------------- SUPPORT/RESISTANCE (srbreak) ---------------------
-- Added 2026-08-20 after a post-mortem on the 08-19 crypto pump: BTC's
-- composite score sat at 10-19 through the entire ~7% breakout because
-- every technique voting bullish that day (macd, momentum, range, rsi,
-- sentiment) carries badly subpar *blended* accuracy specifically on BTC
-- from a long prior chop (technique_reliability), and BTC had zero logged
-- `trending`-regime samples for technique_regime_reliability's escape hatch
-- to fall back on. Rather than touch that weighting (it's working as
-- designed — see reliabilityMultiplier's docs, worker.js), this adds a
-- technique with no chop-era baggage: a fresh technique_id starts at
-- baseline weight and earns its own track record from real level-break
-- outcomes, computed daily by archive.mjs off asset_daily_bars.

-- Current key levels per symbol, recomputed daily (see
-- computeSrLevels/archive.mjs) from swing-pivot highs/lows in
-- asset_daily_bars — a level only lands here once price has reversed off
-- it more than once (touches >= 2), which is what makes it "key" rather
-- than an arbitrary N-bar high/low (the existing `range` technique's plain
-- 20-bar Donchian channel, worker.js, stays as-is and unrelated). Replaced
-- wholesale each run per symbol (a level that's since been invalidated —
-- e.g. superseded by a fresher, closer pivot — should disappear, not
-- linger), same rationale as lead_lag_signals' own replace-not-append shape.
CREATE TABLE IF NOT EXISTS asset_sr_levels (
  symbol TEXT NOT NULL,
  level REAL NOT NULL,
  level_type TEXT NOT NULL, -- 'support' | 'resistance'
  touches INTEGER NOT NULL DEFAULT 2,
  first_seen TEXT NOT NULL,
  last_touched TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, level_type, level)
);

-- Realized move size following a confirmed break of a tracked level —
-- same running mean/stdev accumulator shape as asset_move_stats, just
-- conditioned on "this specific kind of event" instead of every hour.
-- bucket_key is `symbol` once that symbol has enough of its own break
-- history (>= MIN_RELIABILITY_SAMPLES, worker.js), else a pooled
-- `<asset_class>|<level_type>` key so the calibration is usable long
-- before any single symbol has broken enough of its own levels — the same
-- historical-if-enough-samples-else-pooled-fallback discipline
-- bestVolLookback/horizonEstimate/predictedRange already use elsewhere in
-- this engine, needed here because per-symbol break events are inherently
-- sparse for a long time.
CREATE TABLE IF NOT EXISTS sr_break_stats (
  bucket_key TEXT NOT NULL,
  horizon_hours INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  sum_pct REAL NOT NULL DEFAULT 0,
  sum_pct_sq REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bucket_key, horizon_hours)
);

-- Call-flip tracking (added 2026-08-22, user-requested -- the WLFI case:
-- called a bottom, switched to breakdown risk a few hours later). Not a
-- new log of the composite call itself -- that's already recorded every
-- run in technique_votes (technique_id='composite', see logRun) for the
-- calibration curve. This is a small, PERMANENT record of just the
-- moments that history reversed direction (detectAndLogCallFlips reads
-- technique_votes' rolling ~200h window and appends here; see
-- detectCallFlips, worker.js, for the pure detection logic), so flip
-- history survives long after the raw votes it was derived from age out
-- of technique_votes' own retention window. outcome is filled in ~24h
-- later by evaluateCallFlips: did the NEW direction hold, revert back
-- toward the old one (whipsaw noise), or was the move too small to call
-- either way. Informational only, same as quality/rotation -- surfaced on
-- the dashboard as a caution note, never fed back into score/dir.
CREATE TABLE IF NOT EXISTS call_flip_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  prior_dir INTEGER NOT NULL,
  prior_score INTEGER NOT NULL,
  prior_run_at TEXT NOT NULL,
  new_dir INTEGER NOT NULL,
  new_score INTEGER NOT NULL,
  flip_run_at TEXT NOT NULL,
  hours_between REAL NOT NULL,
  outcome TEXT, -- NULL until evaluated, then 'held' | 'reverted' | 'flat'
  outcome_checked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_flip_log_unique ON call_flip_log(symbol, flip_run_at);
CREATE INDEX IF NOT EXISTS idx_call_flip_log_pending ON call_flip_log(outcome, flip_run_at);

-- Push-notification dedup state (added 2026-08-24, user-requested: alert
-- on a peak/bottom signal, and immediately on disruptive/extremely good
-- news like a hack). One row per (kind, symbol) holding the last value
-- actually alerted on -- see notifyOnChange, scripts/notify.mjs. Not an
-- audit log (no history kept, just current state): the only question
-- this needs to answer is "does the CURRENT occurrence differ from the
-- last one we already sent," so a state that just keeps holding doesn't
-- re-notify every run.
CREATE TABLE IF NOT EXISTS notification_state (
  kind TEXT NOT NULL,
  symbol TEXT NOT NULL,
  last_value TEXT NOT NULL,
  last_sent_at TEXT NOT NULL,
  PRIMARY KEY (kind, symbol)
);

-- The actual permanent history notification_state deliberately doesn't
-- keep -- one row per notification actually sent, read by the Worker's
-- /api/feed RSS route (worker.js). User-requested 2026-08-24: "a sort of
-- rss feed on the side for the news and notifications," a persistent,
-- browsable complement to the ntfy push channel (which only shows what's
-- live right now, nothing to look back through once it's gone).
CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  symbol TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  priority TEXT NOT NULL,
  click_url TEXT,
  sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_log_sent_at ON notification_log(sent_at);

-- "Long-term potential" category (added 2026-08-24, user-requested:
-- research cryptos like ZEC that bottomed a year or two ago then did
-- 10x+, find patterns spottable in advance, build a category for them).
-- Real research (correlation-research.mjs) found a genuine 38% base
-- rate for an isolated multi-month/year low going on to >=10x within
-- ~3 years (56 of 146 real cases) -- but found NO tested signal
-- (drawdown depth, pre-low volatility compression, or market-wide
-- coincidence, which actually ran BACKWARDS: moonshot troughs were
-- LESS commonly coincident with other assets' own troughs than
-- ordinary ones, not more) that reliably predicts which specific
-- troughs succeed. computeLongTermBottomCandidates/
-- replaceLongTermBottomCandidates (archive.mjs) refresh this daily
-- from detectPossibleLongTermBottom (worker.js), the live, forward-
-- looking counterpart to the retrospective research. One row per
-- symbol CURRENTLY qualifying; wholesale-replaced each run, same
-- reasoning as asset_rotation_status (a candidate that has since
-- rallied away, or been undercut by a newer low, should not linger).
-- Purely descriptive. Not financial advice.
CREATE TABLE IF NOT EXISTS long_term_bottom_status (
  symbol TEXT NOT NULL,
  low_close REAL NOT NULL,
  low_date TEXT NOT NULL,
  days_since_low INTEGER NOT NULL,
  current_close REAL NOT NULL,
  pct_above_low REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol)
);

-- Median daily range (high - low) per asset: the yardstick for "has this
-- asset already moved enough today?", which is the question a day-trade entry
-- actually turns on. User-requested 2026-08-30.
--
-- Median, not mean, deliberately. This archive has a documented, recurring
-- data-quality problem -- Yahoo occasionally reports a stuck near-zero price
-- for several days and then jumps (UNI-USD, CC, GRAM, WLD, AAVE all confirmed;
-- see computeSectorComposites' notes) -- and a single such bar would drag a
-- mean permanently. A median ignores it. The same reasoning is why p80 is
-- stored rather than "mean + k*stdev": both figures come from the asset's own
-- realized distribution instead of assuming one.
--
-- p80_range_pct exists so "extended" can be defined against this asset's OWN
-- distribution rather than an arbitrary multiplier of the median. An asset
-- whose daily range is usually tight but occasionally explodes has a very
-- different p80/median ratio from one that grinds the same distance daily.
--
-- Symbols whose bars carry no high/low at all (the CoinGecko fallback path
-- gives close only -- HYPE is currently in exactly this state) simply get no
-- row here, and every consumer abstains for them rather than inventing a
-- range. Same abstain-rather-than-guess rule as the rest of the engine.
--
-- Idempotent by construction: CREATE TABLE IF NOT EXISTS only. Migration 0003
-- learned this the hard way -- signals-refresh.yml runs `d1 migrations apply`
-- as its FIRST step, so a migration that cannot be re-run takes down the
-- hourly build, not just the deploy.
CREATE TABLE IF NOT EXISTS asset_daily_range (
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  median_range_pct REAL NOT NULL,
  p80_range_pct REAL NOT NULL,
  samples INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol)
);

-- Per-asset, per-hour forward-return edge: the "best time to buy / best time
-- to sell" read. User-requested 2026-08-30 off the well-documented equity
-- overnight anomaly (buy the close, sell the open).
--
-- Deliberately NOT built on time_of_day_stats. That table is a running sum
-- with no timestamps, so it cannot be split chronologically -- and it was
-- found inflated ~29x for equities (see migrations note in
-- backfill-history.mjs / getTimeOfDayCoverage). This table is recomputed from
-- asset_hourly_bars each day, which keeps real timestamps and therefore
-- supports the split-half guardrail the rest of this engine's research uses.
--
-- Measured live at creation, 20:00 UTC = 16:00 ET = the US equity close:
--   BNB +0.068%/hr t=4.42 | BTC +0.045% t=3.41 | ADA +0.072% t=3.38
--   ETH +0.056% t=3.37 | BCH +0.058% t=2.82 | XRP +0.121% t=2.39
-- All seven tracked coins positive at that hour, six of seven holding the same
-- sign in both chronological halves (DOGE flips +0.188 -> -0.069 and is
-- correctly excluded by the consistency bar).
--
-- Two honesty constraints are built into how this gets consumed:
--   * These assets are highly correlated, so "7 of 7 agree" is nowhere near
--     seven independent confirmations. The significance bar is set for the
--     number of hypotheses tested, not relaxed because several agree.
--   * The effect is ~0.05%/hour while a retail round trip costs 0.1-0.2% in
--     fees and spread. Real does not mean tradeable, and the UI says so.
CREATE TABLE IF NOT EXISTS time_of_day_edge (
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  slot TEXT NOT NULL,
  n INTEGER NOT NULL,
  mean_pct REAL NOT NULL,
  t_stat REAL NOT NULL,
  win_rate REAL NOT NULL,
  h1_mean REAL,
  h2_mean REAL,
  consistent INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, slot)
);

-- Continuous, self-validating research (user-requested 2026-08-30: "look for
-- useful correlations/observations, notify me, and learn from it so the
-- predictions keep getting better").
--
-- correlation_research_findings stays exactly as it is: an append-only audit
-- log of what every run measured. This registry is the different thing that
-- was missing — one row per hypothesis carrying its LIFECYCLE, so a pattern
-- can be tracked over time instead of re-discovered from scratch each run.
--
-- The lifecycle is the whole point, and it exists because of a specific
-- failure mode. A scan over many hypotheses will always turn up some that look
-- significant in the data used to find them; that is what searching does. The
-- only real defence is to re-test a finding on data that did not exist when it
-- was discovered:
--
--   provisional  cleared the family-corrected pooled bar AND held its sign
--                independently in both chronological halves at discovery time.
--                NOT notified: at this stage it is still in-sample.
--   confirmed    has since held up on bars recorded AFTER discovered_at, which
--                is genuine out-of-sample evidence. Notified.
--   decayed      stopped holding. Also notified — a pattern that quietly stops
--                working is more dangerous than one that was never found, and
--                the engine has to be told to stop trusting it.
--
-- tests_in_family records how many hypotheses were tested to surface this one,
-- so the correction applied is auditable after the fact rather than implicit.
CREATE TABLE IF NOT EXISTS research_registry (
  hypothesis TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  asset_class TEXT,
  symbol TEXT,
  horizon_days INTEGER,
  status TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  discovery_n INTEGER NOT NULL,
  discovery_effect REAL NOT NULL,
  discovery_z REAL NOT NULL,
  tests_in_family INTEGER NOT NULL DEFAULT 1,
  oos_n INTEGER NOT NULL DEFAULT 0,
  oos_effect REAL,
  oos_z REAL,
  oos_checks INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  status_changed_at TEXT,
  notified_at TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_research_registry_status ON research_registry(status, family);

-- Quant execution/risk layer for each discovered hypothesis (migration 0010).
-- Statistical significance and tradeability are deliberately separate: only
-- a `confirmed` trade_decision has survived genuine post-discovery data AND a
-- conservative after-cost confidence bar. Everything else abstains.
CREATE TABLE IF NOT EXISTS research_strategy_metrics (
  hypothesis TEXT PRIMARY KEY,
  strategy_direction TEXT NOT NULL CHECK (strategy_direction IN ('long', 'short', 'abstain')),
  assumed_round_trip_cost_pct REAL NOT NULL CHECK (assumed_round_trip_cost_pct >= 0),
  discovery_trade_n INTEGER NOT NULL DEFAULT 0,
  discovery_gross_mean_pct REAL,
  discovery_net_mean_pct REAL,
  discovery_net_lower_95_pct REAL,
  discovery_win_rate_pct REAL,
  discovery_profit_factor REAL,
  discovery_compound_return_pct REAL,
  discovery_max_drawdown_pct REAL,
  discovery_worst_trade_pct REAL,
  walk_forward_verdict TEXT NOT NULL DEFAULT 'insufficient'
    CHECK (walk_forward_verdict IN ('passed', 'failed', 'insufficient')),
  walk_forward_folds INTEGER NOT NULL DEFAULT 0,
  walk_forward_positive_folds INTEGER NOT NULL DEFAULT 0,
  walk_forward_net_mean_pct REAL,
  walk_forward_net_lower_95_pct REAL,
  walk_forward_max_drawdown_pct REAL,
  oos_trade_n INTEGER NOT NULL DEFAULT 0,
  oos_checkpoint_n INTEGER NOT NULL DEFAULT 0,
  oos_gross_mean_pct REAL,
  oos_net_mean_pct REAL,
  oos_net_lower_95_pct REAL,
  oos_win_rate_pct REAL,
  oos_profit_factor REAL,
  oos_compound_return_pct REAL,
  oos_max_drawdown_pct REAL,
  oos_worst_trade_pct REAL,
  trade_decision TEXT NOT NULL DEFAULT 'abstain'
    CHECK (trade_decision IN ('abstain', 'provisional', 'confirmed')),
  decision_reason TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (hypothesis) REFERENCES research_registry(hypothesis) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_research_strategy_decision
  ON research_strategy_metrics(trade_decision, oos_net_lower_95_pct DESC);

CREATE TABLE IF NOT EXISTS research_strategy_metric_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hypothesis TEXT NOT NULL,
  trade_decision TEXT NOT NULL,
  decision_reason TEXT NOT NULL,
  oos_trade_n INTEGER NOT NULL DEFAULT 0,
  oos_checkpoint_n INTEGER NOT NULL DEFAULT 0,
  oos_net_mean_pct REAL,
  oos_net_lower_95_pct REAL,
  oos_compound_return_pct REAL,
  oos_max_drawdown_pct REAL,
  computed_at TEXT NOT NULL,
  FOREIGN KEY (hypothesis) REFERENCES research_registry(hypothesis) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_research_strategy_history
  ON research_strategy_metric_history(hypothesis, computed_at DESC);

-- Market-cycle inputs are archived as context, not pre-approved signals.
-- `known_at` is essential: a historical provider reconstruction ingested
-- today may be used to discover a provisional hypothesis, but it must never
-- masquerade as information the engine possessed on that historical date.
CREATE TABLE IF NOT EXISTS market_context_daily (
  metric TEXT NOT NULL,
  context_date TEXT NOT NULL,
  value REAL NOT NULL,
  source_timestamp TEXT NOT NULL,
  known_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  provider TEXT NOT NULL,
  method_version TEXT NOT NULL,
  raw_hash TEXT NOT NULL,
  training_percentile REAL,
  training_n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (metric, provider, method_version, context_date)
);

CREATE INDEX IF NOT EXISTS idx_market_context_latest
  ON market_context_daily(metric, provider, method_version, context_date DESC);
CREATE INDEX IF NOT EXISTS idx_market_context_known
  ON market_context_daily(metric, known_at, context_date);
-- Automatic retrospective (scripts/retrospective.mjs) + the stablecoin
-- research lane. User-requested 2026-08-31.
--
-- Two separate concerns that arrived in the same request and stay
-- separate here:
--
--   retrospective_misses / retrospective_patterns
--     "what moved, and why didn't we call it" — a permanent, append-only
--     record of every large move alongside what the engine believed at
--     the time, so the failure MODE can be counted rather than argued
--     about. The aggregate table is what turns a pile of individual
--     misses into an instruction about what to fix next.
--
--   stable_value_observations
--     pegs are excluded from every directional board (a $1 asset has no
--     breakout to call, and showing USDG "⏳ Consolidating" was the bug
--     that started all this) — but excluded is not the same as ignored.
--     A stablecoin's supply and turnover going quiet or surging is
--     plausibly information about where the money that is NOT sitting in
--     it is about to go, and that hypothesis cannot be tested without
--     first accumulating the series. This table is that accumulation.
--     It is raw observation only; nothing reads it into a live signal
--     until correlation-research.mjs says the relationship survives
--     out-of-sample (see research_registry, migration 0006).
--
-- Idempotent by construction: CREATE TABLE IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS retrospective_misses (
  run_at TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT,
  asset_class TEXT NOT NULL,
  -- Rank AS OBSERVED, which for a big gainer is measured after the move
  -- and therefore flatters where it sat before it (ARB read 85 at +34%,
  -- having started the day near the rank-100 universe boundary). Stored
  -- as seen rather than adjusted, so the caveat lives in the docs and the
  -- data stays a plain record of what was true at write time.
  mcap_rank INTEGER,
  move_pct REAL NOT NULL,
  move_dir INTEGER NOT NULL,
  in_universe INTEGER NOT NULL,
  passed_floors INTEGER NOT NULL,
  -- What the engine actually said, from the composite votes the hourly
  -- build had already written before the move — not a reconstruction.
  engine_dir INTEGER,
  engine_score REAL,
  engine_first_seen_at TEXT,
  -- One of MISS_CAUSES (worker.js). A closed vocabulary specifically so
  -- causes can be counted; free text cannot be aggregated.
  cause TEXT NOT NULL,
  -- Whether a volume/participation tell existed at all before the move.
  -- 0 is a real and useful answer: a move with no warning is the one
  -- class of miss no amount of engine tuning can recover, and separating
  -- those out keeps them from inflating the fixable backlog.
  detected INTEGER,
  detectable_at TEXT,
  detectable_price REAL,
  surge_ratio REAL,
  trade_ratio REAL,
  lead_hours REAL,
  gain_to_peak_pct REAL,
  max_drawdown_pct REAL,
  -- Migration 0022: why this episode entered the retrospective. The broad
  -- universe still uses the global threshold; an always-tracked favorite
  -- may use a lower value only when its lagged history cleared the baseline
  -- sample gate.
  always_tracked INTEGER NOT NULL DEFAULT 0,
  trigger_threshold_pct REAL,
  trigger_basis TEXT,
  baseline_samples INTEGER,
  baseline_fit_through TEXT,
  -- All feature rows used to explain this episode must predate this cutoff.
  feature_cutoff_at TEXT,
  -- Exact pre-window publication state (migration 0026). The older
  -- in_universe/passed_floors fields remain endpoint observations for legacy
  -- compatibility and are never used to grade new rows.
  prewindow_in_universe INTEGER CHECK (prewindow_in_universe IN (0, 1)),
  publication_snapshot_at TEXT,
  publication_state TEXT CHECK (publication_state IN (
    'published', 'conflicted', 'withheld', 'not-surfaced', 'not-in-universe'
  )),
  state_basis TEXT,
  PRIMARY KEY (run_at, symbol)
);

CREATE INDEX IF NOT EXISTS idx_retrospective_misses_cause ON retrospective_misses(cause, run_at);
CREATE INDEX IF NOT EXISTS idx_retrospective_misses_symbol ON retrospective_misses(symbol, run_at);

-- Exact post-sanitizer state written alongside each reliability run. The
-- retrospective reads this instead of reconstructing side-specific/public
-- boards from the full-universe composite learning log.
CREATE TABLE IF NOT EXISTS signal_publication_snapshots (
  run_at TEXT NOT NULL,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('crypto', 'stock')),
  universe_json TEXT NOT NULL CHECK (json_valid(universe_json)),
  boards_json TEXT NOT NULL CHECK (json_valid(boards_json)),
  universe_count INTEGER NOT NULL CHECK (universe_count >= 0),
  PRIMARY KEY (run_at, asset_class)
);
CREATE INDEX IF NOT EXISTS idx_signal_publication_snapshots_latest
  ON signal_publication_snapshots(asset_class, run_at DESC);

-- Recomputed wholesale from the ledger each run (not incremented), so it
-- can never drift from the rows it summarises.
CREATE TABLE IF NOT EXISTS retrospective_patterns (
  cause TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  share REAL NOT NULL,
  avg_move_pct REAL,
  -- Average % still available from the first detectable tell to the peak.
  -- The number that decides whether a miss actually cost anything: a
  -- missed move that was only detectable at its own top is not a miss in
  -- any sense worth acting on.
  avg_available_pct REAL,
  avg_lead_hours REAL,
  n_detected INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Asset-relative unusual-move thresholds for pinned favorites. Inputs end
-- before the 24h outcome window begins; estimates are append-only so an
-- episode can always be matched to the threshold used at the time.
CREATE TABLE IF NOT EXISTS retrospective_asset_baselines (
  computed_at TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  fit_through TEXT,
  samples INTEGER NOT NULL,
  abs_return_p80_pct REAL,
  daily_range_p50_pct REAL,
  realized_volatility_pct REAL,
  candidate_threshold_pct REAL,
  effective_threshold_pct REAL NOT NULL,
  global_threshold_pct REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('adaptive', 'global', 'insufficient')),
  method_version TEXT NOT NULL,
  PRIMARY KEY (computed_at, asset_class, symbol),
  CHECK (samples >= 0),
  CHECK (effective_threshold_pct > 0),
  CHECK (global_threshold_pct > 0)
);
CREATE INDEX IF NOT EXISTS idx_retrospective_asset_baselines_latest
  ON retrospective_asset_baselines(asset_class, symbol, computed_at DESC);

-- Point-in-time technique state from before each selected move. Alignment is
-- descriptive only because episodes are chosen after their outcomes are
-- known; this table is deliberately disconnected from live scoring.
CREATE TABLE IF NOT EXISTS retrospective_feature_snapshots (
  run_at TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  feature_cutoff_at TEXT NOT NULL,
  source_run_at TEXT NOT NULL,
  technique_id TEXT NOT NULL,
  technique_dir INTEGER NOT NULL CHECK (technique_dir IN (-1, 1)),
  technique_score REAL,
  move_pct REAL NOT NULL,
  move_dir INTEGER NOT NULL CHECK (move_dir IN (-1, 1)),
  aligned INTEGER NOT NULL CHECK (aligned IN (0, 1)),
  regime TEXT NOT NULL,
  time_bucket TEXT NOT NULL,
  source_lag_hours REAL NOT NULL CHECK (source_lag_hours >= 0),
  method_version TEXT NOT NULL,
  PRIMARY KEY (run_at, asset_class, symbol, technique_id, method_version),
  CHECK (source_run_at < feature_cutoff_at)
);
CREATE INDEX IF NOT EXISTS idx_retrospective_feature_snapshots_cell
  ON retrospective_feature_snapshots(asset_class, symbol, technique_id, regime, time_bucket, run_at);

-- Multiple-testing-aware summaries of the outcome-conditioned snapshots.
-- Even a notable cell is research-only and cannot become a live weight until
-- a separate prospective study measures every trigger, including failures.
CREATE TABLE IF NOT EXISTS retrospective_feature_correlations (
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  technique_id TEXT NOT NULL,
  regime TEXT NOT NULL,
  time_bucket TEXT NOT NULL,
  n INTEGER NOT NULL,
  independent_dates INTEGER NOT NULL,
  alignment_rate REAL,
  correlation REAL,
  fisher_z REAL,
  first_half_correlation REAL,
  second_half_correlation REAL,
  tests_in_family INTEGER NOT NULL,
  corrected_z_threshold REAL,
  status TEXT NOT NULL CHECK (status IN ('insufficient', 'descriptive-only', 'notable-retrospective-only')),
  live_edge_eligible INTEGER NOT NULL DEFAULT 0 CHECK (live_edge_eligible = 0),
  updated_at TEXT NOT NULL,
  method_version TEXT NOT NULL,
  PRIMARY KEY (asset_class, symbol, technique_id, regime, time_bucket, method_version),
  CHECK (n >= 0),
  CHECK (independent_dates >= 0),
  CHECK (tests_in_family >= 1)
);

-- Migration 0023: unlike retrospective_feature_snapshots above, this lane is
-- not selected on the outcome. It records every eligible daily return once,
-- with compact predictor frames frozen strictly before that return window, so
-- lead/lag and seasonal hypotheses include quiet days and failed triggers.
CREATE TABLE IF NOT EXISTS retrospective_lead_lag_daily (
  observation_date TEXT NOT NULL,
  run_at TEXT NOT NULL,
  window_start_at TEXT NOT NULL,
  window_end_at TEXT NOT NULL,
  outcome_provider TEXT NOT NULL,
  outcomes_json TEXT NOT NULL CHECK (json_valid(outcomes_json)),
  predictors_json TEXT NOT NULL CHECK (json_valid(predictors_json)),
  method_version TEXT NOT NULL,
  PRIMARY KEY (observation_date, method_version),
  CHECK (window_start_at < window_end_at),
  CHECK (run_at = window_end_at)
);
CREATE INDEX IF NOT EXISTS idx_retrospective_lead_lag_daily_window
  ON retrospective_lead_lag_daily(method_version, observation_date);

-- Research evidence across individual techniques, pre-registered technique
-- pairs, cross-asset composites, market breadth, and causally normalized cycle
-- metrics at fixed lead horizons. Calendar and frozen-regime cells share one
-- multiple-testing family. Discovery is checkpointed and alpha-spent, then
-- frozen before genuinely later OOS observations. This table is deliberately
-- impossible to activate directly: promotion belongs to the separate after-
-- cost research lifecycle.
CREATE TABLE IF NOT EXISTS retrospective_seasonal_lead_lag (
  asset_class TEXT NOT NULL,
  target_symbol TEXT NOT NULL,
  feature_kind TEXT NOT NULL,
  source_symbol TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  indicator_role TEXT NOT NULL,
  lag_hours REAL NOT NULL CHECK (lag_hours >= 0),
  context_type TEXT NOT NULL,
  context_value TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n >= 0),
  correlation REAL,
  hac_z REAL,
  mean_actual_lead_hours REAL,
  discovery_n INTEGER NOT NULL DEFAULT 0 CHECK (discovery_n >= 0),
  discovery_correlation REAL,
  discovery_hac_z REAL,
  holdout_n INTEGER NOT NULL DEFAULT 0 CHECK (holdout_n >= 0),
  holdout_correlation REAL,
  holdout_hac_z REAL,
  discovery_tests_in_family INTEGER,
  corrected_z_threshold REAL,
  family_alpha_spent REAL,
  next_checkpoint_n INTEGER,
  walk_forward_verdict TEXT NOT NULL CHECK (walk_forward_verdict IN ('insufficient', 'passed', 'failed')),
  walk_forward_folds INTEGER NOT NULL DEFAULT 0 CHECK (walk_forward_folds >= 0),
  walk_forward_positive_folds INTEGER NOT NULL DEFAULT 0 CHECK (walk_forward_positive_folds >= 0),
  discovered_at TEXT,
  discovery_fit_through TEXT,
  oos_n INTEGER NOT NULL DEFAULT 0 CHECK (oos_n >= 0),
  oos_correlation REAL,
  oos_hac_z REAL,
  oos_tests_in_family INTEGER,
  oos_corrected_z_threshold REAL,
  oos_alpha_spent REAL,
  oos_next_checkpoint_n INTEGER,
  status TEXT NOT NULL CHECK (status IN ('insufficient', 'descriptive-only', 'provisional-research-only', 'replicated-research-only', 'decayed-research-only')),
  live_edge_eligible INTEGER NOT NULL DEFAULT 0 CHECK (live_edge_eligible = 0),
  updated_at TEXT NOT NULL,
  method_version TEXT NOT NULL,
  PRIMARY KEY (asset_class, target_symbol, feature_kind, source_symbol, feature_id,
               lag_hours, context_type, context_value, method_version),
  CHECK (discovery_tests_in_family IS NULL OR discovery_tests_in_family >= 1),
  CHECK (family_alpha_spent IS NULL OR (family_alpha_spent > 0 AND family_alpha_spent < 1)),
  CHECK (next_checkpoint_n IS NULL OR next_checkpoint_n > 0),
  CHECK (oos_tests_in_family IS NULL OR oos_tests_in_family >= 1),
  CHECK (oos_alpha_spent IS NULL OR (oos_alpha_spent > 0 AND oos_alpha_spent < 1)),
  CHECK (oos_next_checkpoint_n IS NULL OR oos_next_checkpoint_n > 0),
  CHECK (mean_actual_lead_hours IS NULL OR mean_actual_lead_hours >= lag_hours),
  CHECK ((discovered_at IS NULL AND discovery_fit_through IS NULL)
      OR (discovered_at IS NOT NULL AND discovery_fit_through IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_retrospective_seasonal_lead_lag_status
  ON retrospective_seasonal_lead_lag(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_retrospective_seasonal_lead_lag_target
  ON retrospective_seasonal_lead_lag(target_symbol, context_type, context_value,
                                     lag_hours, updated_at DESC);

-- Keyed by DATE, not by run timestamp, for three reasons that all point
-- the same way. It bounds the table (~26 rows/day rather than ~26/hour,
-- so ~9.5K rows/year instead of 228K, with no pruning job needed at all).
-- It matches the grain of the question: net mint/redeem is a daily-scale
-- flow, and hourly wobble in a peg's market cap is mostly noise on the
-- anchor. And it makes these rows directly joinable with the stablecoin
-- depeg research already in correlation-research.mjs, which keys its own
-- series by calendar date.
--
-- The hourly build upserts into the day's row, so most columns hold the
-- most recent observation. peak_deviation_pct is the exception and is
-- accumulated with MAX() across the day — a depeg is an intraday spike,
-- and last-write-wins would be exactly the wrong summary for it.
CREATE TABLE IF NOT EXISTS stable_value_observations (
  obs_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT,
  price REAL,
  -- Supply proxy: for a peg, market cap IS net mint/redeem, which is the
  -- flow variable the hypothesis is actually about.
  mcap REAL,
  volume REAL,
  -- Median absolute bar-over-bar return (see pegBehaviour). Doubles as
  -- the peg-tightness measure a depeg-stress study needs, and as an audit
  -- trail for why this asset was excluded from the boards.
  median_bar_pct REAL,
  chg24h REAL,
  -- Largest absolute % gap from this asset's own anchor seen during the
  -- day. Accumulated with MAX, never overwritten.
  peak_deviation_pct REAL,
  -- 'known' (name/ticker list) or 'behaviour' (price series). Lets a
  -- wrong exclusion be found later instead of staying invisible.
  basis TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (obs_date, symbol)
);

CREATE INDEX IF NOT EXISTS idx_stable_value_symbol ON stable_value_observations(symbol, obs_date);
-- Forward surge scanning (scripts/live-scan.mjs). User-requested
-- 2026-09-01: notify before the move, not after it.
--
-- The measurement behind these tables matters more than their shape, so
-- it is recorded here too. Over 176K hourly observations across 200
-- Binance-global symbols, mean forward 24h return falls MONOTONICALLY as
-- a volume spike grows: +0.28% at 2.5x, -0.17% at 5x, -1.69% at 12x,
-- -2.88% at 20x, against a +0.33% all-bar baseline. A volume spike into a
-- rising bar is an exhaustion marker, not an entry. Two cohorts looked
-- profitable pooled and both failed the chronological-half split that
-- research_registry (migration 0006) exists to enforce.
--
-- So surge_signal_log is not a list of trade ideas. It is the evidence
-- base that decides which configurations are ever ALLOWED to become trade
-- ideas: every configuration is cast and scored on live forward data,
-- proven or not, and an unproven one stays silent until its own record
-- clears a coin flip on a Wilson lower bound over at least 30 scored
-- casts. A candidate earns the right to interrupt; it is not granted it
-- because a backtest liked it.
--
-- Idempotent by construction: CREATE TABLE IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS surge_signal_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  -- What the configuration PREDICTED, which is not what the bar did:
  -- exhaustion fires on a rising bar and predicts weakness.
  dir INTEGER NOT NULL,
  -- The closed bar the cast was made on, never the forming one.
  cast_at TEXT NOT NULL,
  entry_price REAL NOT NULL,
  horizon_hours INTEGER NOT NULL,
  ratio REAL,
  trade_ratio REAL,
  bar_pct REAL,
  liquidity REAL,
  -- NULL until the horizon elapses. 'correct' | 'wrong' | 'flat', where
  -- flat means the market never moved past the deadband either way and
  -- so does not credit whichever side happened to be called.
  outcome TEXT,
  exit_price REAL,
  move_pct REAL,
  scored_at TEXT,
  notified INTEGER NOT NULL DEFAULT 0,
  UNIQUE (config_id, symbol, cast_at)
);

CREATE INDEX IF NOT EXISTS idx_surge_log_open ON surge_signal_log(outcome, cast_at);
CREATE INDEX IF NOT EXISTS idx_surge_log_config ON surge_signal_log(config_id, outcome);

-- One row per configuration: its live, forward-tested standing and
-- whether it is currently permitted to notify. Recomputed each run from
-- surge_signal_log, so it can never drift from the evidence.
CREATE TABLE IF NOT EXISTS surge_config_status (
  config_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  dir INTEGER NOT NULL,
  horizon_hours INTEGER NOT NULL,
  -- Cleared significance AND held its sign in both chronological halves
  -- at discovery. Only exhaustion20 did.
  proven_at_discovery INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  wrong INTEGER NOT NULL DEFAULT 0,
  flat INTEGER NOT NULL DEFAULT 0,
  -- correct + wrong: flat casts are excluded from accuracy rather than
  -- counted against it, since a market that did not move tested nothing.
  decided INTEGER NOT NULL DEFAULT 0,
  accuracy REAL,
  lower_bound REAL,
  avg_move_pct REAL,
  notifying INTEGER NOT NULL DEFAULT 0,
  status_note TEXT,
  updated_at TEXT NOT NULL
);

-- Spot accumulation bot state and fill ledger.
--
-- Separate from the futures bot's tables on purpose: different key, different
-- risk profile, and no shared state beyond the D1 database itself. Nothing
-- here is leveraged and nothing here is ever sold by the bot, so there are no
-- stops, targets or exposure caps to track — only what was bought, when, and
-- what the measured reason was.
CREATE TABLE IF NOT EXISTS spot_bot_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),   -- single row, upsert-only
  last_tranche_at TEXT,
  -- Quote currency banked because no asset triggered on a due cycle. Capped
  -- in code (maxCarryTranches) so deferral cannot grow into one oversized
  -- bet, which would defeat the point of averaging.
  dry_powder REAL NOT NULL DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS spot_bot_fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filled_at TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('dry', 'live')),
  symbol TEXT NOT NULL,
  signal_symbol TEXT NOT NULL,
  sleeve TEXT NOT NULL CHECK (sleeve IN ('core', 'satellite')),
  -- Which measured condition released the tranche, and the numbers behind it.
  -- Stored verbatim so a later review can group outcomes by trigger rather
  -- than re-deriving thresholds that have since moved.
  trigger TEXT NOT NULL CHECK (trigger IN ('significant-drop', 'weekly-low-reached')),
  trigger_reason TEXT,
  quote_spent REAL NOT NULL CHECK (quote_spent > 0),
  price REAL NOT NULL CHECK (price > 0),
  quantity REAL,
  order_id TEXT,
  -- The per-asset profile in force at the fill. A drop is only "significant"
  -- relative to a distribution, and that distribution moves as history
  -- accumulates, so judging this fill later requires what was known now.
  weekly_sigma REAL,
  typical_drawdown REAL,
  weeks_history INTEGER
);

CREATE INDEX IF NOT EXISTS idx_spot_bot_fills_symbol ON spot_bot_fills(symbol, filled_at DESC);
CREATE INDEX IF NOT EXISTS idx_spot_bot_fills_time ON spot_bot_fills(filled_at DESC);

-- Cycles where a tranche was due but nothing met its bar. Recorded because
-- conditional DCA's central risk is sitting out a rally: without this, the
-- skips are invisible and there is no way to tell later whether waiting paid.
CREATE TABLE IF NOT EXISTS spot_bot_skips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skipped_at TEXT NOT NULL,
  symbol TEXT NOT NULL,
  reason TEXT NOT NULL,
  price REAL,
  quote_deferred REAL
);

CREATE INDEX IF NOT EXISTS idx_spot_bot_skips_time ON spot_bot_skips(skipped_at DESC);

-- Long-horizon record of what the bots actually did and what it earned.
--
-- The shadow ledger (0015) captures DECISIONS and resolves them against later
-- prices. This captures OUTCOMES: the realized profit and loss Binance itself
-- reports once a position is closed, alongside the evidence that was in force
-- when it was opened. Without the second half, there is no way to ask whether
-- the model's edge estimate, horizon or measured excursion actually predicted
-- anything -- which is the point of keeping it.
CREATE TABLE IF NOT EXISTS trading_bot_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  -- 'bot' and 'manual' are NEVER pooled. A position the operator opened by
  -- hand is not evidence about the model's selection, and averaging the two
  -- would corrupt exactly the measurement this table exists to support.
  origin TEXT NOT NULL CHECK (origin IN ('bot', 'manual')),
  source TEXT,
  opened_at TEXT,
  closed_at TEXT NOT NULL,
  entry_price REAL,
  exit_price REAL,
  quantity REAL,
  leverage REAL,
  margin_used REAL,
  -- Authoritative figures from Binance's own income history, not inferred
  -- from price differences: fees and funding are real costs and an edge that
  -- only exists gross of them is not an edge.
  realized_pnl REAL,
  commission REAL,
  funding_fee REAL,
  net_pnl REAL,
  return_on_margin_pct REAL,
  holding_minutes REAL,
  exit_reason TEXT,
  -- What the model believed at entry. Judging an outcome against evidence
  -- gathered later would be hindsight, so this is frozen at open time.
  edge REAL,
  horizon_hours REAL,
  holding_mfe_pct REAL,
  holding_mae_pct REAL,
  holding_hours_to_peak REAL,
  extreme_boost INTEGER,
  equity_at_open REAL,
  equity_at_close REAL
);

CREATE INDEX IF NOT EXISTS idx_trading_bot_trades_closed ON trading_bot_trades(closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trading_bot_trades_symbol ON trading_bot_trades(origin, symbol, closed_at DESC);
-- One row per closed position per symbol, so a re-run cannot double-count a
-- trade into the record the model learns from.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_bot_trades_unique ON trading_bot_trades(symbol, closed_at, origin);

-- Equity through time: the denominator for return on assets, and the only way
-- to see drawdown between trades. Bucketed to 15 minutes so a 5-minute cadence
-- cannot grow this without bound (~35k rows/year) while keeping enough
-- resolution to measure a drawdown that matters.
CREATE TABLE IF NOT EXISTS trading_bot_equity_log (
  bucket TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL,
  equity REAL NOT NULL,
  open_positions INTEGER,
  unrealized_pnl REAL
);

-- Mark-to-market for spot. Fills alone give a cost basis; this gives the other
-- half of return on asset, and it costs nothing extra because the spot cycle
-- already fetches every one of these prices.
CREATE TABLE IF NOT EXISTS spot_bot_valuation (
  bucket TEXT NOT NULL,
  symbol TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  quantity REAL NOT NULL,
  price REAL NOT NULL,
  market_value REAL NOT NULL,
  cost_basis REAL,
  unrealized_pct REAL,
  PRIMARY KEY (bucket, symbol)
);

CREATE INDEX IF NOT EXISTS idx_spot_valuation_symbol ON spot_bot_valuation(symbol, observed_at DESC);

-- Positions the operator opened by hand. The bots do not manage these -- no
-- stop, no take-profit, no time exit -- but they are watched every cycle, and
-- a reading that suggests a large loss is imminent is recorded here and
-- alerted on. Kept so "we warned at this level, at this time" is auditable.
CREATE TABLE IF NOT EXISTS trading_bot_risk_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raised_at TEXT NOT NULL,
  symbol TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'extreme')),
  reason TEXT NOT NULL,
  mark_price REAL,
  liquidation_price REAL,
  distance_to_liquidation_pct REAL,
  unrealized_pnl REAL,
  unrealized_vs_equity_pct REAL,
  equity REAL,
  action_taken TEXT
);

CREATE INDEX IF NOT EXISTS idx_risk_alerts_time ON trading_bot_risk_alerts(raised_at DESC);

-- Robinhood leveraged-ETF reversal rule: evidence before execution.
--
-- The rule is promising, not proven. Measured over 5,020 daily bars across 10
-- leveraged ETFs (2024-09 to 2026-09), sigma-scaled thresholds gave 7 of 10
-- symbols positive compounded returns, median +25.4% -- but on 54 trades in
-- total, 2 to 9 per symbol. That cannot separate skill from luck, so it
-- accumulates a forward record here before it is allowed to place an order.
--
-- The same discipline as trading_bot_shadow_trades (0015): decisions recorded
-- with the numbers in force at the time, resolved against real subsequent
-- prices, provenance never pooled.
CREATE TABLE IF NOT EXISTS robinhood_shadow_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'live')),
  symbol TEXT NOT NULL,
  -- A bottom in a leveraged LONG is a bet the underlying recovers, amplified.
  -- A bottom in an INVERSE is a bet it falls, with daily-reset decay working
  -- against the position throughout. Different trades; never pooled.
  structure TEXT NOT NULL CHECK (structure IN ('long', 'inverse')),
  entry_price REAL NOT NULL CHECK (entry_price > 0),
  target_price REAL NOT NULL CHECK (target_price > 0),
  stop_price REAL NOT NULL CHECK (stop_price > 0),
  max_hold_days INTEGER NOT NULL,
  -- Everything the rule measured at the moment it fired. Frozen, because
  -- judging the outcome against a sigma recomputed later would be hindsight.
  sigma_pct REAL,
  low_price REAL,
  low_age_sessions INTEGER,
  off_low_pct REAL,
  needed_pct REAL,
  reason TEXT,
  resolved_at TEXT,
  exit_price REAL,
  exit_reason TEXT CHECK (exit_reason IS NULL OR exit_reason IN ('target', 'stop', 'time')),
  return_pct REAL
);

CREATE INDEX IF NOT EXISTS idx_rh_shadow_open ON robinhood_shadow_trades(resolved_at, opened_at) WHERE resolved_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rh_shadow_one_open ON robinhood_shadow_trades(symbol, mode) WHERE resolved_at IS NULL;

-- Where every candidate stood on every observation day, whether or not it
-- fired. Without this there is only a record of the days the rule acted, which
-- would make it impossible to ask later how close the near-misses came or
-- whether the thresholds are set anywhere near right.
CREATE TABLE IF NOT EXISTS robinhood_watchlist_state (
  observed_on TEXT NOT NULL,
  symbol TEXT NOT NULL,
  structure TEXT NOT NULL,
  close REAL NOT NULL,
  low_price REAL,
  low_age_sessions INTEGER,
  off_low_pct REAL,
  needed_pct REAL,
  sigma_pct REAL,
  closed_up INTEGER,
  qualifies INTEGER NOT NULL DEFAULT 0,
  verdict TEXT,
  PRIMARY KEY (observed_on, symbol)
);

CREATE INDEX IF NOT EXISTS idx_rh_watch_symbol ON robinhood_watchlist_state(symbol, observed_on DESC);
-- Continuous cross-venue / perp-vs-spot lead-lag measurement, at 1-second
-- resolution (user-requested 2026-09-05: "evaluate the various asset prices
-- across the various platforms as well as perpetual/futures vs spot prices
-- even on the same platform to see if one could be a leading and the other a
-- lagging indicator even if for a few seconds or minutes ... the evaluation
-- should be continuous so we can catch it if a pattern ever emerges").
--
-- WHAT IS STORED, AND WHAT IS NOT
--
-- Not raw ticks. A single run reads ~300 seconds x 3 series x 7 assets; kept
-- verbatim that is ~6,300 rows per run and tens of millions a month, to answer
-- a question that only ever needs the summary. Each run instead reduces its
-- window to one row per tested cell -- (symbol, family, leader, follower, lag)
-- -- and stores that. ~245 rows per run, and the pooled test across runs is
-- then a plain GROUP BY.
--
-- Each row is therefore ONE INDEPENDENT OBSERVATION of a hypothesis: this
-- window, this pair, this lag, this correlation. That is the unit the pooled
-- test counts, and it is why window_id exists and why overlapping windows are
-- rejected at write time (see microstructure.mjs' overlap guard). Counting two
-- overlapping windows as two observations is the exact defect QUANT_SIGNAL_
-- DIAGNOSIS.md records as the v6 model's headline failure -- overlapping
-- samples treated as independent trials, inflating every sample size and
-- confidence bound. It is not repeated here.
--
-- WHY THE FILTERING COLUMNS ARE NOT OPTIONAL
--
-- traded_frac_* and n record how much of the window actually carried trades on
-- BOTH sides. At 1-second granularity these venues are quiet: measured live on
-- 2026-09-05, Binance spot traded in 84.6% of seconds, OKX spot in 44.3%, OKX
-- perp in 63.0%. A second with no trade has no new price -- its "close" is the
-- previous close carried forward -- so correlating raw 1s closes manufactures
-- lead-lag out of nothing but one venue being thinner than the other. This is
-- the classic non-synchronous trading bias, and on the same live sample it was
-- worth the difference between 91 honest paired seconds and 299 contaminated
-- ones. Only seconds where both sides genuinely traded are counted.
--
-- peak_at_zero / lag0_corr are the clock-alignment check. Two venues stamping
-- the same trade a second apart would look exactly like a one-second lead, so
-- a constant clock offset is indistinguishable from the effect being hunted.
-- The defence is that genuinely synchronised venues correlate MOST strongly at
-- lag 0: measured 0.93 (OKX perp vs OKX spot) and 0.96 (Binance spot vs OKX
-- spot) on the live sample, both peaking exactly at zero. A window whose peak
-- sits off zero has its clocks in question, not its economics, and is recorded
-- with peak_at_zero = 0 so the pooled test can exclude it.
--
-- edge_bps is the economic half, kept beside the statistical half on purpose.
-- A correlation is not a trade: at 1-second horizons these assets move on the
-- order of a basis point or two, while a round trip costs far more (see
-- DEFAULT_ROUND_TRIP_COST_PCT in discovery.mjs). Leverage does not rescue that
-- -- it scales the edge and the cost together, leaving the ratio untouched --
-- so a finding that is statistically real and economically dead must be able
-- to say so. That is what microstructure_findings.trade_decision at the bottom
-- of this file is for, and edge_bps is what feeds it.
CREATE TABLE IF NOT EXISTS microstructure_observations (
  window_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  symbol TEXT NOT NULL,
  family TEXT NOT NULL,
  leader TEXT NOT NULL,
  follower TEXT NOT NULL,
  lag_seconds INTEGER NOT NULL,
  corr REAL,
  n INTEGER NOT NULL,
  edge_bps REAL,
  edge_n INTEGER,
  lag0_corr REAL,
  peak_at_zero INTEGER NOT NULL DEFAULT 0,
  traded_frac_leader REAL,
  traded_frac_follower REAL,
  clock_skew_ms REAL,
  method_version TEXT NOT NULL,
  PRIMARY KEY (window_id, symbol, family, leader, follower, lag_seconds)
);

-- The pooled test's own access pattern: every observation of one cell, in
-- chronological order (for the split-half and for the post-discovery
-- out-of-sample slice, which is simply "windows after discovered_at").
CREATE INDEX IF NOT EXISTS idx_microstructure_cell
  ON microstructure_observations(symbol, family, leader, follower, lag_seconds, observed_at);

-- Overlap rejection reads only the most recent window's end, per this table's
-- docs above.
CREATE INDEX IF NOT EXISTS idx_microstructure_recent
  ON microstructure_observations(window_end DESC);

-- One row per run, whether or not it produced usable observations. A run that
-- collected nothing (venue outage, a symbol delisted, every second filtered
-- out as untraded) is itself the answer to "is this still being evaluated",
-- and without it a silent collector is indistinguishable from a quiet market.
CREATE TABLE IF NOT EXISTS microstructure_runs (
  window_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  window_start TEXT,
  window_end TEXT,
  symbols_requested INTEGER NOT NULL DEFAULT 0,
  symbols_usable INTEGER NOT NULL DEFAULT 0,
  observations INTEGER NOT NULL DEFAULT 0,
  skipped_reason TEXT,
  venue_errors TEXT,
  method_version TEXT NOT NULL
);

-- The economic verdict per cell, kept out of research_strategy_metrics on
-- purpose. That table is shaped around trade-level returns — win rate, profit
-- factor, walk-forward folds, drawdown — none of which a per-window
-- correlation cell produces. Forcing these numbers into those columns would
-- make both tables lie about what they hold. research_registry still owns the
-- STATUS lifecycle (provisional -> confirmed -> decayed) exactly as it does for
-- every other research lane; only the cost arithmetic lives here.
--
-- trade_decision is deliberately independent of that status. A cell can be
-- statistically confirmed and still abstain forever because a two-basis-point
-- edge cannot pay a ten-basis-point round trip — which, at one-second
-- horizons, is the expected outcome rather than an edge case.
CREATE TABLE IF NOT EXISTS microstructure_findings (
  hypothesis TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  family TEXT NOT NULL,
  leader TEXT NOT NULL,
  follower TEXT NOT NULL,
  lag_seconds INTEGER NOT NULL,
  windows INTEGER NOT NULL DEFAULT 0,
  mean_corr REAL,
  pooled_z REAL,
  z_bar REAL,
  tests_in_family INTEGER NOT NULL DEFAULT 1,
  median_edge_bps REAL,
  assumed_round_trip_cost_pct REAL NOT NULL,
  trade_decision TEXT NOT NULL DEFAULT 'abstain'
    CHECK (trade_decision IN ('abstain', 'eligible')),
  decision_reason TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (hypothesis) REFERENCES research_registry(hypothesis) ON DELETE CASCADE
);

-- Read-only Binance account journal (migration 0021). Exchange fills are
-- stored independently of bot outcome tables, with conservative provenance:
-- an unmatched order is UNKNOWN, never presumed manual.
CREATE TABLE IF NOT EXISTS account_journal_orders (
  market TEXT NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol TEXT NOT NULL,
  order_id TEXT NOT NULL,
  client_order_id TEXT,
  side TEXT CHECK (side IS NULL OR side IN ('BUY', 'SELL')),
  order_type TEXT,
  status TEXT,
  order_time TEXT,
  updated_time TEXT,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (market, symbol, order_id)
);

CREATE INDEX IF NOT EXISTS idx_account_journal_orders_client
  ON account_journal_orders(market, client_order_id)
  WHERE client_order_id IS NOT NULL;

-- Parent conditional orders must be retained separately: Binance does not
-- promise that a parent outside a later rolling window will reappear when
-- actual_order_id is assigned after a stop or take-profit triggers (0027).
CREATE TABLE IF NOT EXISTS account_journal_futures_algos (
  symbol TEXT NOT NULL,
  algo_id TEXT NOT NULL,
  client_algo_id TEXT,
  actual_order_id TEXT,
  side TEXT CHECK (side IS NULL OR side IN ('BUY', 'SELL')),
  order_type TEXT,
  actual_type TEXT,
  algo_status TEXT,
  create_time_ms INTEGER,
  update_time_ms INTEGER,
  trigger_time_ms INTEGER,
  last_polled_at TEXT,
  polling_closed_at TEXT,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (symbol, algo_id)
);

CREATE INDEX IF NOT EXISTS idx_account_journal_algos_pending
  ON account_journal_futures_algos(last_polled_at, symbol)
  WHERE actual_order_id IS NULL AND polling_closed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_account_journal_algos_actual_order
  ON account_journal_futures_algos(symbol, actual_order_id)
  WHERE actual_order_id IS NOT NULL;

-- Latest and append-only historical snapshots of actually open USDⓈ-M
-- positions (migration 0031). Unmatched state is UNKNOWN, never presumed
-- manual, and these read-only rows cannot authorize an order.
CREATE TABLE IF NOT EXISTS account_journal_current_positions (
  symbol TEXT NOT NULL,
  position_side TEXT NOT NULL CHECK (position_side IN ('BOTH', 'LONG', 'SHORT')),
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  position_amt REAL NOT NULL CHECK (position_amt <> 0),
  quantity REAL NOT NULL CHECK (quantity > 0),
  entry_price REAL CHECK (entry_price IS NULL OR entry_price > 0),
  break_even_price REAL CHECK (break_even_price IS NULL OR break_even_price > 0),
  mark_price REAL CHECK (mark_price IS NULL OR mark_price > 0),
  unrealized_pnl REAL,
  liquidation_price REAL CHECK (liquidation_price IS NULL OR liquidation_price > 0),
  leverage REAL CHECK (leverage IS NULL OR leverage > 0),
  margin_type TEXT,
  isolated_margin REAL CHECK (isolated_margin IS NULL OR isolated_margin >= 0),
  notional REAL,
  origin TEXT NOT NULL CHECK (origin IN ('bot', 'manual', 'unknown')),
  classification_method TEXT NOT NULL,
  classification_evidence TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (symbol, position_side)
);

CREATE INDEX IF NOT EXISTS idx_account_journal_current_positions_origin
  ON account_journal_current_positions(origin, symbol);

CREATE TABLE IF NOT EXISTS account_journal_position_snapshots (
  observed_at TEXT NOT NULL,
  symbol TEXT NOT NULL,
  position_side TEXT NOT NULL CHECK (position_side IN ('BOTH', 'LONG', 'SHORT')),
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  position_amt REAL NOT NULL CHECK (position_amt <> 0),
  quantity REAL NOT NULL CHECK (quantity > 0),
  entry_price REAL CHECK (entry_price IS NULL OR entry_price > 0),
  break_even_price REAL CHECK (break_even_price IS NULL OR break_even_price > 0),
  mark_price REAL CHECK (mark_price IS NULL OR mark_price > 0),
  unrealized_pnl REAL,
  liquidation_price REAL CHECK (liquidation_price IS NULL OR liquidation_price > 0),
  leverage REAL CHECK (leverage IS NULL OR leverage > 0),
  margin_type TEXT,
  isolated_margin REAL CHECK (isolated_margin IS NULL OR isolated_margin >= 0),
  notional REAL,
  origin TEXT NOT NULL CHECK (origin IN ('bot', 'manual', 'unknown')),
  classification_method TEXT NOT NULL,
  classification_evidence TEXT,
  PRIMARY KEY (observed_at, symbol, position_side)
);

CREATE INDEX IF NOT EXISTS idx_account_journal_position_snapshots_symbol_time
  ON account_journal_position_snapshots(symbol, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_journal_position_snapshots_origin_time
  ON account_journal_position_snapshots(origin, observed_at DESC);

CREATE TABLE IF NOT EXISTS account_journal_fills (
  market TEXT NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol TEXT NOT NULL,
  trade_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  client_order_id TEXT,
  event_time TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  position_side TEXT CHECK (position_side IS NULL OR position_side IN ('BOTH', 'LONG', 'SHORT')),
  price REAL NOT NULL CHECK (price > 0),
  quantity REAL NOT NULL CHECK (quantity > 0),
  quote_quantity REAL CHECK (quote_quantity IS NULL OR quote_quantity >= 0),
  realized_pnl REAL,
  commission REAL CHECK (commission IS NULL OR commission >= 0),
  commission_asset TEXT,
  is_maker INTEGER CHECK (is_maker IS NULL OR is_maker IN (0, 1)),
  origin TEXT NOT NULL CHECK (origin IN ('bot', 'manual', 'unknown')),
  classification_method TEXT NOT NULL,
  classification_evidence TEXT,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (market, symbol, trade_id),
  FOREIGN KEY (market, symbol, order_id)
    REFERENCES account_journal_orders(market, symbol, order_id)
);

CREATE INDEX IF NOT EXISTS idx_account_journal_fills_time
  ON account_journal_fills(event_time DESC);
CREATE INDEX IF NOT EXISTS idx_account_journal_fills_origin
  ON account_journal_fills(origin, market, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_account_journal_fills_order
  ON account_journal_fills(market, symbol, order_id);
CREATE INDEX IF NOT EXISTS idx_account_journal_fills_symbol
  ON account_journal_fills(market, symbol, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_account_journal_fills_ingested
  ON account_journal_fills(origin, ingested_at);
CREATE INDEX IF NOT EXISTS idx_account_journal_fills_symbol_time
  ON account_journal_fills(symbol, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_account_journal_fills_reported_pnl
  ON account_journal_fills(realized_pnl, event_time DESC)
  WHERE market = 'futures' AND realized_pnl IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_journal_origin_overrides (
  market TEXT NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol TEXT NOT NULL,
  order_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('bot', 'manual')),
  note TEXT,
  set_at TEXT NOT NULL,
  PRIMARY KEY (market, symbol, order_id)
);

CREATE TABLE IF NOT EXISTS account_journal_checkpoints (
  market TEXT NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol TEXT NOT NULL,
  stream TEXT NOT NULL CHECK (stream IN ('trades', 'orders')),
  last_trade_id TEXT,
  cursor_time_ms INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (market, symbol, stream)
);

CREATE TABLE IF NOT EXISTS account_journal_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  markets_requested INTEGER NOT NULL DEFAULT 0,
  symbols_requested INTEGER NOT NULL DEFAULT 0,
  fills_seen INTEGER NOT NULL DEFAULT 0,
  pages_read INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_account_journal_runs_time
  ON account_journal_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS account_journal_daily_stats (
  day TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('spot', 'futures')),
  origin TEXT NOT NULL CHECK (origin IN ('bot', 'manual', 'unknown')),
  symbol TEXT NOT NULL,
  fill_count INTEGER NOT NULL,
  order_count INTEGER NOT NULL,
  buy_fill_count INTEGER NOT NULL,
  sell_fill_count INTEGER NOT NULL,
  buy_quantity REAL NOT NULL,
  sell_quantity REAL NOT NULL,
  buy_quote_quantity REAL NOT NULL,
  sell_quote_quantity REAL NOT NULL,
  realized_pnl REAL,
  first_fill_at TEXT NOT NULL,
  last_fill_at TEXT NOT NULL,
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (day, market, origin, symbol)
);

CREATE INDEX IF NOT EXISTS idx_account_journal_daily_origin
  ON account_journal_daily_stats(origin, day DESC, market);

CREATE TABLE IF NOT EXISTS account_journal_daily_fees (
  day TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('spot', 'futures')),
  origin TEXT NOT NULL CHECK (origin IN ('bot', 'manual', 'unknown')),
  symbol TEXT NOT NULL,
  commission_asset TEXT NOT NULL,
  commission_amount REAL NOT NULL,
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (day, market, origin, symbol, commission_asset)
);

CREATE VIEW IF NOT EXISTS account_journal_manual_fills AS
  SELECT * FROM account_journal_fills WHERE origin = 'manual';

CREATE VIEW IF NOT EXISTS account_journal_review_queue AS
  SELECT * FROM account_journal_fills WHERE origin = 'unknown';

CREATE VIEW IF NOT EXISTS account_journal_origin_summary AS
  SELECT
    market,
    origin,
    COUNT(*) AS fill_count,
    COUNT(DISTINCT symbol || ':' || order_id) AS order_count,
    COUNT(DISTINCT symbol) AS symbol_count,
    MIN(event_time) AS first_fill_at,
    MAX(event_time) AS last_fill_at,
    SUM(CASE WHEN side = 'BUY' THEN COALESCE(quote_quantity, 0) ELSE 0 END) AS buy_quote_quantity,
    SUM(CASE WHEN side = 'SELL' THEN COALESCE(quote_quantity, 0) ELSE 0 END) AS sell_quote_quantity,
    CASE WHEN market = 'futures' THEN SUM(realized_pnl) ELSE NULL END AS realized_pnl
  FROM account_journal_fills
  GROUP BY market, origin;

-- ===========================================================================
-- Research-only point-in-time crash-threshold cohort (migration 0029).
-- ===========================================================================
-- Research-only, point-in-time crash-threshold cohort.
--
-- Scope is intentionally narrow: this records first crossings below a
-- predeclared drawdown threshold and what happened afterwards. It does NOT
-- identify a bottom, predict a reversal, establish a cause, or represent the
-- full historical market. The source is the bounded, currently archived
-- asset_daily_bars universe, which can omit delisted assets and therefore has
-- survivorship/coverage censoring. Hindsight lows and return milestones are
-- outcome diagnostics only and are never model inputs.
--
-- Nothing in this schema is wired to research_registry, learned weights,
-- published signals, alerts, or orders. Every live_edge_eligible field is
-- hard-locked to zero.

CREATE TABLE IF NOT EXISTS crash_recovery_runs (
  run_id TEXT PRIMARY KEY,
  method_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'resource-capped', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  universe_scope TEXT NOT NULL DEFAULT 'bounded-current-archive-no-delisted-guarantee'
    CHECK (universe_scope = 'bounded-current-archive-no-delisted-guarantee'),
  symbols_considered INTEGER NOT NULL DEFAULT 0 CHECK (symbols_considered >= 0),
  symbols_processed INTEGER NOT NULL DEFAULT 0 CHECK (symbols_processed >= 0),
  symbols_deferred INTEGER NOT NULL DEFAULT 0 CHECK (symbols_deferred >= 0),
  bars_read INTEGER NOT NULL DEFAULT 0 CHECK (bars_read >= 0),
  episodes_seen INTEGER NOT NULL DEFAULT 0 CHECK (episodes_seen >= 0),
  outcomes_pending INTEGER NOT NULL DEFAULT 0 CHECK (outcomes_pending >= 0),
  outcomes_matured INTEGER NOT NULL DEFAULT 0 CHECK (outcomes_matured >= 0),
  error_summary TEXT,
  live_edge_eligible INTEGER NOT NULL DEFAULT 0 CHECK (live_edge_eligible = 0)
);

CREATE INDEX IF NOT EXISTS idx_crash_recovery_runs_started
  ON crash_recovery_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS crash_recovery_checkpoints (
  asset_class TEXT NOT NULL CHECK (asset_class IN ('crypto', 'stock')),
  symbol TEXT NOT NULL,
  method_version TEXT NOT NULL,
  -- Last bar fully examined for a threshold crossing. A resource-deferred
  -- publication lookup or truncated bar query must never advance this cursor
  -- through the deferred event/range.
  last_scanned_signal_date TEXT NOT NULL,
  -- Frozen on the first successfully processed slice. Rows dated on/before
  -- this boundary are bootstrap; only later rows are prospective.
  bootstrap_through_date TEXT NOT NULL,
  cohort_id TEXT NOT NULL,
  source_max_date TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (asset_class, symbol, method_version),
  CHECK (last_scanned_signal_date <= source_max_date),
  CHECK (bootstrap_through_date <= source_max_date)
);

CREATE INDEX IF NOT EXISTS idx_crash_recovery_checkpoints_rotation
  ON crash_recovery_checkpoints(method_version, updated_at, asset_class, symbol);

CREATE TABLE IF NOT EXISTS crash_recovery_episodes (
  asset_class TEXT NOT NULL CHECK (asset_class IN ('crypto', 'stock')),
  symbol TEXT NOT NULL,
  signal_date TEXT NOT NULL,
  method_version TEXT NOT NULL,
  -- The crossing is knowable only after signal_date's close. The later bar
  -- close is a reproducible research reference, not a claimed executable fill.
  eligible_at TEXT,
  feature_cutoff_date TEXT NOT NULL,
  signal_close REAL NOT NULL CHECK (signal_close > 0),
  reference_entry_close REAL CHECK (reference_entry_close IS NULL OR reference_entry_close > 0),
  signal_source TEXT,
  entry_source TEXT,
  threshold_pct REAL NOT NULL CHECK (threshold_pct < 0),
  peak_lookback_sessions INTEGER NOT NULL CHECK (peak_lookback_sessions > 0),
  trailing_peak_close REAL NOT NULL CHECK (trailing_peak_close > 0),
  drawdown_pct REAL NOT NULL CHECK (drawdown_pct <= threshold_pct),
  peak_age_sessions INTEGER NOT NULL CHECK (peak_age_sessions >= 1),
  trailing_return_20_pct REAL,
  realized_vol_20_pct REAL CHECK (realized_vol_20_pct IS NULL OR realized_vol_20_pct >= 0),
  volume_ratio_20 REAL CHECK (volume_ratio_20 IS NULL OR volume_ratio_20 >= 0),
  distance_sma_200_pct REAL,
  benchmark_symbol TEXT,
  benchmark_return_20_pct REAL,
  relative_strength_20_pct REAL,
  benchmark_regime TEXT CHECK (benchmark_regime IS NULL OR benchmark_regime IN ('up', 'down', 'flat')),
  depth_bucket TEXT NOT NULL CHECK (depth_bucket IN ('30-to-40', '40-to-55', '55-plus')),
  evidence_partition TEXT NOT NULL CHECK (evidence_partition IN ('bootstrap', 'prospective')),
  cohort_id TEXT NOT NULL,
  -- Exact post-sanitizer board snapshot strictly before the signal UTC day.
  publication_snapshot_at TEXT,
  publication_state TEXT NOT NULL CHECK (publication_state IN (
    'published', 'conflicted', 'withheld', 'not-surfaced', 'not-in-universe', 'unavailable'
  )),
  published_direction INTEGER CHECK (published_direction IN (-1, 1)),
  published_score REAL,
  publication_call_usable INTEGER CHECK (publication_call_usable IN (0, 1)),
  publication_alignment_reason TEXT NOT NULL,
  first_recorded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  scope_label TEXT NOT NULL DEFAULT 'crash-threshold-crossing-not-bottom-or-cause'
    CHECK (scope_label = 'crash-threshold-crossing-not-bottom-or-cause'),
  association_label TEXT NOT NULL DEFAULT 'association-not-causal'
    CHECK (association_label = 'association-not-causal'),
  live_edge_eligible INTEGER NOT NULL DEFAULT 0 CHECK (live_edge_eligible = 0),
  PRIMARY KEY (asset_class, symbol, signal_date, method_version),
  CHECK (feature_cutoff_date = signal_date),
  CHECK (eligible_at IS NULL OR eligible_at > signal_date),
  CHECK ((eligible_at IS NULL AND reference_entry_close IS NULL)
      OR (eligible_at IS NOT NULL AND reference_entry_close IS NOT NULL)),
  CHECK ((publication_state = 'published'
          AND published_direction IS NOT NULL AND publication_call_usable = 1)
      OR (publication_state <> 'published'
          AND published_direction IS NULL
          AND (publication_call_usable = 0 OR publication_call_usable IS NULL)))
);

CREATE INDEX IF NOT EXISTS idx_crash_recovery_episode_partition
  ON crash_recovery_episodes(method_version, asset_class, evidence_partition, signal_date);

-- Separate predeclared clocks avoid treating 252 US sessions as equivalent to
-- 252 continuously traded crypto days. Crypto uses 365/730 daily bars; stocks
-- use 252/504 observed sessions. Recent incomplete paths stay pending.
CREATE TABLE IF NOT EXISTS crash_recovery_outcomes (
  asset_class TEXT NOT NULL CHECK (asset_class IN ('crypto', 'stock')),
  symbol TEXT NOT NULL,
  signal_date TEXT NOT NULL,
  method_version TEXT NOT NULL,
  horizon_sessions INTEGER NOT NULL,
  outcome_status TEXT NOT NULL CHECK (outcome_status IN ('pending', 'matured')),
  observed_forward_sessions INTEGER NOT NULL DEFAULT 0 CHECK (observed_forward_sessions >= 0),
  outcome_label TEXT CHECK (outcome_label IN ('recovered-prior-peak', 'failed-recovery')),
  recovered_prior_peak INTEGER CHECK (recovered_prior_peak IN (0, 1)),
  sessions_to_recovery INTEGER CHECK (sessions_to_recovery IS NULL OR sessions_to_recovery >= 0),
  first_2x_sessions INTEGER CHECK (first_2x_sessions IS NULL OR first_2x_sessions >= 1),
  first_5x_sessions INTEGER CHECK (first_5x_sessions IS NULL OR first_5x_sessions >= 1),
  first_10x_sessions INTEGER CHECK (first_10x_sessions IS NULL OR first_10x_sessions >= 1),
  first_20x_sessions INTEGER CHECK (first_20x_sessions IS NULL OR first_20x_sessions >= 1),
  forward_terminal_return_pct REAL,
  forward_max_return_pct REAL,
  forward_max_adverse_pct REAL,
  -- Outcome-only hindsight diagnostic. It cannot be used as an entry feature.
  hindsight_low_close REAL CHECK (hindsight_low_close IS NULL OR hindsight_low_close > 0),
  hindsight_low_date TEXT,
  sessions_to_hindsight_low INTEGER CHECK (sessions_to_hindsight_low IS NULL OR sessions_to_hindsight_low >= 0),
  matured_at TEXT,
  first_recorded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  outcome_only_label TEXT NOT NULL DEFAULT 'future-path-label-not-model-input'
    CHECK (outcome_only_label = 'future-path-label-not-model-input'),
  live_edge_eligible INTEGER NOT NULL DEFAULT 0 CHECK (live_edge_eligible = 0),
  PRIMARY KEY (asset_class, symbol, signal_date, method_version, horizon_sessions),
  FOREIGN KEY (asset_class, symbol, signal_date, method_version)
    REFERENCES crash_recovery_episodes(asset_class, symbol, signal_date, method_version)
    ON DELETE CASCADE,
  CHECK ((asset_class = 'crypto' AND horizon_sessions IN (365, 730))
      OR (asset_class = 'stock' AND horizon_sessions IN (252, 504))),
  CHECK ((first_5x_sessions IS NULL OR first_2x_sessions IS NOT NULL)
      AND (first_10x_sessions IS NULL OR first_5x_sessions IS NOT NULL)
      AND (first_20x_sessions IS NULL OR first_10x_sessions IS NOT NULL)),
  CHECK (
    (outcome_status = 'pending'
      AND observed_forward_sessions < horizon_sessions
      AND outcome_label IS NULL AND recovered_prior_peak IS NULL
      AND sessions_to_recovery IS NULL
      AND first_2x_sessions IS NULL AND first_5x_sessions IS NULL
      AND first_10x_sessions IS NULL AND first_20x_sessions IS NULL
      AND forward_terminal_return_pct IS NULL AND forward_max_return_pct IS NULL
      AND forward_max_adverse_pct IS NULL AND hindsight_low_close IS NULL
      AND hindsight_low_date IS NULL AND sessions_to_hindsight_low IS NULL
      AND matured_at IS NULL)
    OR
    (outcome_status = 'matured'
      AND observed_forward_sessions = horizon_sessions
      AND outcome_label IS NOT NULL AND recovered_prior_peak IS NOT NULL
      AND forward_terminal_return_pct IS NOT NULL
      AND forward_max_return_pct IS NOT NULL
      AND forward_max_adverse_pct IS NOT NULL
      AND hindsight_low_close IS NOT NULL AND hindsight_low_date IS NOT NULL
      AND sessions_to_hindsight_low IS NOT NULL AND matured_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_crash_recovery_outcomes_pending
  ON crash_recovery_outcomes(method_version, asset_class, symbol, signal_date, horizon_sessions)
  WHERE outcome_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_crash_recovery_outcomes_matured
  ON crash_recovery_outcomes(method_version, asset_class, horizon_sessions, signal_date)
  WHERE outcome_status = 'matured';

-- Raw descriptive rates only. Events from one symbol and overlapping horizons
-- are dependent, so an iid binomial/Wilson confidence interval would overstate
-- certainty. Unique symbol/cohort counts expose the effective breadth instead.
CREATE TABLE IF NOT EXISTS crash_recovery_associations (
  method_version TEXT NOT NULL,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('crypto', 'stock')),
  horizon_sessions INTEGER NOT NULL,
  evidence_partition TEXT NOT NULL CHECK (evidence_partition IN ('all', 'bootstrap', 'prospective')),
  feature_name TEXT NOT NULL CHECK (feature_name IN (
    'all-events', 'drawdown-depth', 'momentum-20', 'realized-volatility-20',
    'volume-ratio-20', 'distance-sma-200', 'benchmark-return-20',
    'relative-strength-20', 'benchmark-regime', 'publication-call'
  )),
  feature_bucket TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n > 0),
  unique_symbols INTEGER NOT NULL CHECK (unique_symbols > 0 AND unique_symbols <= n),
  unique_cohorts INTEGER NOT NULL CHECK (unique_cohorts > 0 AND unique_cohorts <= n),
  recovered_n INTEGER NOT NULL CHECK (recovered_n >= 0 AND recovered_n <= n),
  failed_n INTEGER NOT NULL CHECK (failed_n >= 0 AND failed_n <= n),
  recovery_rate REAL NOT NULL CHECK (recovery_rate >= 0 AND recovery_rate <= 1),
  reached_2x_n INTEGER NOT NULL CHECK (reached_2x_n >= 0 AND reached_2x_n <= n),
  reached_5x_n INTEGER NOT NULL CHECK (reached_5x_n >= 0 AND reached_5x_n <= n),
  reached_10x_n INTEGER NOT NULL CHECK (reached_10x_n >= 0 AND reached_10x_n <= n),
  reached_20x_n INTEGER NOT NULL CHECK (reached_20x_n >= 0 AND reached_20x_n <= n),
  avg_terminal_return_pct REAL,
  avg_max_return_pct REAL,
  avg_max_adverse_pct REAL,
  updated_at TEXT NOT NULL,
  evidence_label TEXT NOT NULL DEFAULT 'raw-descriptive-association-not-causal'
    CHECK (evidence_label = 'raw-descriptive-association-not-causal'),
  live_edge_eligible INTEGER NOT NULL DEFAULT 0 CHECK (live_edge_eligible = 0),
  PRIMARY KEY (method_version, asset_class, horizon_sessions, evidence_partition, feature_name, feature_bucket),
  CHECK ((asset_class = 'crypto' AND horizon_sessions IN (365, 730))
      OR (asset_class = 'stock' AND horizon_sessions IN (252, 504))),
  CHECK (recovered_n + failed_n = n),
  CHECK (reached_20x_n <= reached_10x_n AND reached_10x_n <= reached_5x_n
      AND reached_5x_n <= reached_2x_n)
);

CREATE INDEX IF NOT EXISTS idx_crash_recovery_associations_lookup
  ON crash_recovery_associations(asset_class, horizon_sessions, evidence_partition, feature_name, n DESC);

-- Futures resting entry intent/outcome ledger (migration 0030).
CREATE TABLE IF NOT EXISTS trading_bot_entry_intents (
  client_order_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'dry', 'shadow')),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  filled_at TEXT,
  canceled_at TEXT,
  closed_at TEXT,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('crypto', 'stock')),
  symbol TEXT NOT NULL,
  signal_symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  source TEXT NOT NULL,
  signal_generated_at TEXT,
  signal_price_at TEXT NOT NULL,
  signal_price REAL NOT NULL CHECK (signal_price > 0),
  mark_price_at_order REAL CHECK (mark_price_at_order IS NULL OR mark_price_at_order > 0),
  limit_price REAL NOT NULL CHECK (limit_price > 0),
  offset_pct REAL NOT NULL CHECK (offset_pct > 0),
  offset_basis TEXT NOT NULL,
  median_daily_move_pct REAL,
  absolute_24h_move_pct REAL,
  adverse_excursion_pct REAL,
  adverse_basis TEXT,
  wrong_call_samples INTEGER,
  conservative_edge REAL,
  position_pct REAL,
  leverage INTEGER,
  requested_qty REAL,
  filled_qty REAL,
  avg_fill_price REAL,
  stop_price REAL,
  target_price REAL,
  time_exit_after_ms REAL,
  horizon_hours REAL,
  cancel_reason TEXT,
  final_net_pnl REAL,
  final_return_on_margin_pct REAL,
  exit_reason TEXT,
  first_touch_bar_at TEXT,
  observation_count INTEGER,
  observed_low REAL,
  observed_high REAL,
  closest_distance_pct REAL,
  research_resolved_at TEXT,
  resolution_basis TEXT,
  evidence_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_entry_intents_symbol_time
  ON trading_bot_entry_intents(symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entry_intents_status_expiry
  ON trading_bot_entry_intents(mode, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_entry_intents_research_pending
  ON trading_bot_entry_intents(asset_class, expires_at)
  WHERE mode IN ('dry', 'shadow') AND status IN ('proposed', 'awaiting-bars');

-- Research capsules and reports only. Never used as live authorization.
-- Source intents, original prices and account journals are never modified.
CREATE TABLE IF NOT EXISTS policy_history_events (
  event_id TEXT PRIMARY KEY,
  method_version TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  source TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
  horizon_hours INTEGER NOT NULL CHECK(horizon_hours IN (1,6,24)),
  reference_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready','unavailable')),
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  retry_after INTEGER,
  updated_at TEXT NOT NULL,
  event_gzip_base64 TEXT,
  archive_bytes INTEGER NOT NULL DEFAULT 0,
  live_eligible INTEGER NOT NULL DEFAULT 0 CHECK(live_eligible=0),
  UNIQUE(method_version, intent_id, horizon_hours)
);
CREATE INDEX IF NOT EXISTS idx_policy_history_ready
  ON policy_history_events(method_version,status,reference_at);

CREATE TABLE IF NOT EXISTS policy_history_reports (
  method_version TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  report_json TEXT NOT NULL,
  live_eligible INTEGER NOT NULL DEFAULT 0 CHECK(live_eligible=0)
);

CREATE TABLE IF NOT EXISTS policy_history_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  attempted INTEGER NOT NULL,
  archived INTEGER NOT NULL,
  unavailable INTEGER NOT NULL,
  api_requests INTEGER NOT NULL,
  archive_bytes INTEGER NOT NULL,
  details_json TEXT NOT NULL
);

-- Deep historical derivatives archive, backfilled from Binance's PUBLIC DATA
-- PORTAL (data.binance.vision), not its trading API.
--
-- Why a new table instead of backfilling funding_rate_daily: that table's OI
-- comes from CoinGecko /derivatives, which reports the single highest-OI
-- venue per asset across all exchanges. This table is Binance-USDT-perp only.
-- The two are NOT level-comparable (Binance is a subset of global OI, and
-- which venue CoinGecko picks can change day to day), so mixing them into one
-- column would silently create fake jumps at the join seam. Percent CHANGES
-- track each other closely, which is what the features actually consume.
--
-- Why this source at all: fapi.binance.com is HTTP 451 from this project's
-- infra (verified again 2026-09-11, same as archive.mjs's existing note), and
-- api.bybit.com is HTTP 403 CloudFront country-blocked. The public data
-- portal is a plain static bucket on the same host family as
-- data-api.binance.vision, which this codebase already depends on for crypto
-- daily bars, and it is NOT geo-blocked. Coverage confirmed live 2026-09-11:
-- 141 of the 168 symbols in funding_rate_daily, BTC back to 2020-09-01 and
-- most majors to 2022-01-01.
--
-- This replaces "wait for the daily logger to accumulate history." The live
-- funding_rate_daily logger keeps running unchanged; this is the deep past it
-- could never reach.
--
-- Beyond open interest, each file also carries positioning ratios Binance
-- publishes nowhere else in historical form: the long/short split of TOP
-- TRADERS by account and by position size, the all-account split, and taker
-- buy/sell volume. Those are stored here because they are the natural
-- controls for "is this OI build-up crowded retail or positioned size" — the
-- question raw OI alone cannot answer.
--
-- RESEARCH INPUT ONLY on arrival. Nothing here is wired to published signals,
-- learned weights, alerts, or orders. Features derived from it must clear the
-- cross-sectional lane's existing evidence gate (XS_FAMILY_ALPHA,
-- XS_MIN_SIGN_CONSISTENCY) exactly like every other candidate feature.

CREATE TABLE IF NOT EXISTS derivatives_daily (
  symbol TEXT NOT NULL,                 -- project symbol (ZEC), never the venue's
  date TEXT NOT NULL,                   -- UTC date of the 5m bars aggregated into this row
  venue_symbol TEXT NOT NULL,           -- BTCUSDT, 1000PEPEUSDT -- kept so the 1000x
                                        -- quantity convention stays auditable
  -- Open interest. *_usd is the trustworthy cross-symbol field:
  -- open_interest_qty is denominated in the venue's contract unit, which for
  -- a 1000-prefixed listing counts 1000 tokens per unit.
  oi_usd_close REAL,                    -- last 5m bar of the UTC day, aligned with a price close
  oi_usd_mean REAL,                     -- day mean, less sensitive to one noisy print
  oi_usd_high REAL,
  oi_usd_low REAL,
  oi_qty_close REAL,
  -- Positioning. Ratios are long/short; >1 means net long.
  toptrader_account_ls REAL,            -- count_toptrader_long_short_ratio
  toptrader_position_ls REAL,           -- sum_toptrader_long_short_ratio (size-weighted)
  all_account_ls REAL,                  -- count_long_short_ratio
  taker_buy_sell_ratio REAL,            -- sum_taker_long_short_vol_ratio (day mean)
  samples INTEGER NOT NULL,             -- 5m bars that fed this row; a full day is 288
  source TEXT NOT NULL,
  PRIMARY KEY (symbol, date)
);

CREATE INDEX IF NOT EXISTS idx_derivatives_daily_date ON derivatives_daily(date);

-- Resumable-backfill bookkeeping. The portal serves ONE FILE PER SYMBOL PER
-- DAY (there is no monthly metrics roll-up -- checked live), so a full-depth
-- pass is ~141k HTTP requests and cannot be assumed to finish inside a single
-- Actions job. Each run advances whatever it can and records where it got to;
-- re-running resumes rather than restarting. `unavailable` is a real terminal
-- state, not a failure: not every tracked asset has a Binance USDT perp.
CREATE TABLE IF NOT EXISTS derivatives_backfill_state (
  symbol TEXT PRIMARY KEY,
  venue_symbol TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'partial', 'complete', 'unavailable')),
  earliest_date TEXT,                   -- oldest date confirmed stored
  latest_date TEXT,                     -- newest date confirmed stored
  earliest_probed TEXT,                 -- oldest date actually requested, hit or 404
  days_stored INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  notes TEXT
);

-- Advisory quarantine for corrupt rows in asset_daily_bars.
--
-- Found by the derivatives cost model (docs/DERIVATIVES_EVIDENCE.md §4.5): a
-- portfolio held a broken name at full weight and booked -4103%/period. Every
-- REGRESSION in this engine had been silently absorbing the same rows, because
-- winsorise() clips each cross-section's tails before fitting — which makes
-- corruption invisible to a t-stat while remaining lethal to anything that
-- SELECTS assets: portfolios, backtests, the surge scanner, crash-recovery
-- episode detection, the trading bot.
--
-- ADVISORY, NOT DESTRUCTIVE. No row is deleted from asset_daily_bars. A false
-- positive is undone by deleting a row here, not by re-fetching lost history.
-- Same principle as migration 0012's cross-class ticker quarantine.
--
-- Three reasons, detected by scripts/bar-quarantine.mjs:
--
--   spike        One or two bars wildly off, series reverts. Threshold 4x,
--                CONFIRMED by the reversion itself. 16 in crypto.
--   level-shift  Price jumps and HOLDS: a supplier remapped the ticker to a
--                different asset, or the token was redenominated. Threshold
--                10x, stricter precisely because nothing confirms it. 25 in
--                crypto, 0 in equities.
--   stale        Identical close for 10+ consecutive bars — a dead feed.
--                4349 crypto / 2356 equity bars. Lower severity: these are
--                not WRONG, they are uninformative, and excluding them changes
--                the tradeable universe rather than correcting an error. Left
--                for consumers to weigh; the default helper does not drop them.
--
-- Threshold calibration rests on two real cases rather than on a gap in the
-- data (a sweep found 37/30/25/22/20 flags at 4x/8x/10x/15x/25x — no cliff):
--   * DOGE 2021-01-28 rose 4.43x in a day during the GameStop episode. REAL.
--     A 4x level-shift bar would have erased it.
--   * AAVE 2020-10-03 rose 90.6x on the LEND->AAVE 100:1 redenomination. Not
--     a return anyone earned.
--
-- KNOWN JUDGMENT CALL, recorded so it is not mistaken for a bug: LUNC
-- 2022-05-11..13 is flagged level-shift. That collapse was REAL market
-- history, not a data fault — but the archive also splices pre-collapse LUNA
-- prices onto post-rename LUNC, and a -99.9999% single-step observation is
-- unrepeatable enough to distort any cross-sectional fit that treats it as an
-- ordinary trial. Quarantining the SEAM does not delete the bars; a consumer
-- that genuinely wants the collapse (crash-recovery research is the obvious
-- one) can read asset_daily_bars directly and ignore this table.

CREATE TABLE IF NOT EXISTS asset_bar_quarantine (
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,              -- for level-shift, the FIRST bar of the new
                                   -- regime, so a window starting on it is clean
  reason TEXT NOT NULL CHECK (reason IN ('spike', 'level-shift', 'stale')),
  detail TEXT,                     -- human-readable evidence for the call
  detector_version TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  PRIMARY KEY (asset_class, symbol, date)
);

CREATE INDEX IF NOT EXISTS idx_asset_bar_quarantine_symbol
  ON asset_bar_quarantine(symbol, date);
CREATE INDEX IF NOT EXISTS idx_asset_bar_quarantine_reason
  ON asset_bar_quarantine(reason);

-- Token supply and dilution. The engine had NO supply data of any kind before
-- this: no circulating, total or max supply anywhere in worker.js or scripts/.
-- That is a real blind spot, because "how much more of this token is about to
-- exist" is a first-order driver of price and is invisible to every
-- price/volume/OI feature already modelled.
--
-- Requested directly: "can our model check for and incorporate supply and
-- demand (at a point in time, eg more supply will be released soon)".
--
-- WHY CIRCULATING SUPPLY IS DERIVED RATHER THAN FETCHED
--
-- DefiLlama publishes actual unlock SCHEDULES, which would be the ideal
-- source, but /emissions returns HTTP 402 on the free plan (checked
-- 2026-09-12). CoinGecko's free tier gives current supply but no supply
-- history.
--
-- However, /coins/{id}/market_chart returns `prices` AND `market_caps` over
-- full history in ONE call, and circulating supply is exactly market_cap /
-- price. So the realized supply curve is recoverable for the whole archive at
-- a cost of one request per symbol, without a paid plan and without waiting
-- for a logger to accumulate.
--
-- Arguably this is the better measurement anyway: a schedule says what was
-- SUPPOSED to unlock, while this says what actually entered circulation —
-- including unscheduled mints, burns and treasury movements a calendar misses.
--
-- Derived values carry derivation error: market_cap and price are each rounded
-- by the supplier, so the ratio is noisy at the margin. It is therefore stored
-- as a real number to be differenced over WEEKS, never treated as an exact
-- token count. `market_cap` and `price_used` are kept alongside so the
-- derivation stays auditable and can be re-done if CoinGecko changes units.
CREATE TABLE IF NOT EXISTS asset_supply_daily (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  circulating_supply REAL,        -- derived: market_cap / price_used
  market_cap REAL,
  price_used REAL,
  source TEXT NOT NULL,
  PRIMARY KEY (symbol, date)
);

CREATE INDEX IF NOT EXISTS idx_asset_supply_daily_date ON asset_supply_daily(date);

-- Total and max supply are POINT-IN-TIME ONLY — CoinGecko exposes no history
-- for them, so there is no honest way to build a daily series and this table
-- deliberately does not pretend otherwise. It holds one current row per symbol.
--
-- The overhang metric this enables, (total - circulating) / circulating, is the
-- direct form of "more supply will be released soon": APT measured 40.7% on
-- 2026-09-12 against ~0% for BTC and ZEC. Because it is a snapshot, it can be
-- used as a CROSS-SECTIONAL feature (compare assets today) but NOT as a
-- time-series one (compare an asset to its own past) — the realized dilution
-- rate from asset_supply_daily is what serves that purpose.
CREATE TABLE IF NOT EXISTS asset_supply_snapshot (
  symbol TEXT PRIMARY KEY,
  coingecko_id TEXT,
  circulating_supply REAL,
  total_supply REAL,
  max_supply REAL,
  as_of TEXT NOT NULL
);

-- Four data families the engine was blind to, added together because they are
-- consumed by one feature panel and gated by one correction.
--
-- Requested: "can our model check for and incorporate supply and demand ...
-- liquidity and production costs, on-chain activities, and any other relevant
-- metrics we may have missed".

-- 1. ORDER-BOOK LIQUIDITY -----------------------------------------------------
-- From Binance's public data portal bookDepth dataset: ~3,456 snapshots/day of
-- resting notional at each 1% step out to +/-5% from mid. Same host and same
-- access story as derivatives_daily (migration 0033) — no new supplier risk.
--
-- Why this matters beyond being "another feature": the cost model in
-- docs/DERIVATIVES_EVIDENCE.md charges a FLAT 6.5bp per side to BTC and to
-- microcaps alike, and flagged that as optimistic for illiquid names. Real
-- depth is what turns that single tunable number into a per-asset estimate.
--
-- book_imbalance is the genuinely new signal here, not depth itself: resting
-- bid notional versus ask notional is standing limit interest, which no
-- price/volume/OI series in this engine expresses.
CREATE TABLE IF NOT EXISTS asset_liquidity_daily (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  venue_symbol TEXT NOT NULL,
  bid_notional_1pct REAL,        -- mean resting USD within 1% below mid
  ask_notional_1pct REAL,
  bid_notional_5pct REAL,
  ask_notional_5pct REAL,
  -- (bid - ask) / (bid + ask) at +/-1%. Positive = more resting bids.
  book_imbalance_1pct REAL,
  book_imbalance_5pct REAL,
  -- Total two-sided depth at 1%, the scale term the cost model needs.
  depth_1pct_usd REAL,
  snapshots INTEGER NOT NULL,    -- how many book samples fed this row
  source TEXT NOT NULL,
  PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_asset_liquidity_daily_date ON asset_liquidity_daily(date);

-- 2. SUPPLY SNAPSHOTS, CAPTURED DAILY ----------------------------------------
-- asset_supply_daily (migration 0035) derives circulating supply from
-- market_cap/price via CoinGecko market_chart, one call per symbol. That gets
-- HISTORY but is unusable at scale: CoinGecko's free tier throttled a 23/min
-- local run into total failure and a 9s-paced Actions run into the same, and
-- every free alternative for historical supply is paywalled (CoinPaprika 402,
-- CoinCap withdrawn).
--
-- This table takes the opposite trade and wins on cost: getCryptoMarkets() is
-- ALREADY CALLED by every hourly build and already returns circulating, total
-- and max supply for all 250 coins in ONE request. Archiving it is therefore
-- ZERO additional API cost, perfectly reliable, and accumulates from today.
--
-- It captures what the dilution-only framing missed:
--   * burns   -> circulating_supply FALLS; supply_change_pct goes negative
--   * unlocks -> circulating rises toward total
--   * lockups -> circulating falls while total is unchanged (staking,
--                vesting re-locks, treasury withdrawals from float)
-- The sign and the total/circulating gap together distinguish them, which a
-- one-directional "dilution" metric cannot.
CREATE TABLE IF NOT EXISTS asset_supply_snapshot_daily (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  circulating_supply REAL,
  total_supply REAL,
  max_supply REAL,
  market_cap REAL,
  source TEXT NOT NULL,
  PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_asset_supply_snapshot_daily_date ON asset_supply_snapshot_daily(date);

-- 3. CHAIN ACTIVITY AND MACRO LIQUIDITY --------------------------------------
-- DefiLlama, free and historical. Two different things in one table, keyed by
-- `metric`, because both are chain-scoped daily series and splitting them into
-- separate tables would duplicate the same loader three times.
--
--   tvl              per-chain total value locked -- on-chain activity, and
--                    the closest free proxy for capital actually deployed
--   stablecoin_mcap  circulating stablecoin supply -- the standard macro
--                    liquidity proxy for crypto; dry powder entering or
--                    leaving the whole asset class
--
-- Chain-level, not asset-level. It joins to an asset through asset_sectors /
-- the chain a token settles on, and stands alone as market context otherwise.
CREATE TABLE IF NOT EXISTS chain_metrics_daily (
  chain TEXT NOT NULL,           -- 'Ethereum', 'Solana', or 'ALL' for aggregates
  date TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('tvl', 'stablecoin_mcap')),
  value REAL NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (chain, date, metric)
);
CREATE INDEX IF NOT EXISTS idx_chain_metrics_daily_date ON chain_metrics_daily(date, metric);

-- 4. PRODUCTION COST (PROOF OF WORK) -----------------------------------------
-- blockchain.info charts, free and historical. Bitcoin only by construction —
-- this is a PoW concept and most of the tracked universe is not PoW, so the
-- feature it feeds must abstain elsewhere rather than fabricate a number.
--
-- The economic claim being tested, not assumed: miner marginal cost acts as a
-- soft floor, because sustained price below it forces capitulation and
-- hashrate withdrawal. Difficulty and hashrate give the cost side; miners'
-- revenue gives the income side. Their ratio is a cost-basis proxy, NOT a
-- dollar cost per coin -- electricity price and hardware efficiency are not in
-- this data and are deliberately not guessed at.
CREATE TABLE IF NOT EXISTS network_cost_daily (
  network TEXT NOT NULL,         -- 'BTC'
  date TEXT NOT NULL,
  hashrate REAL,                 -- TH/s
  difficulty REAL,
  miners_revenue_usd REAL,
  transactions INTEGER,
  source TEXT NOT NULL,
  PRIMARY KEY (network, date)
);

-- High-frequency open-interest sampling, and the flush events derived from it.
--
-- WHY THIS EXISTS
--
-- docs/FLUSH_EVIDENCE.md established that the direction of open-interest change
-- DURING a violent move is what separates a dip that fully retraces from one
-- that does not: OI rising through the drop (new shorts pressing in) recovers
-- 106% median, OI falling (longs being liquidated out) recovers 50.3%.
-- Spearman +0.505, t = 7.99, n = 189.
--
-- That finding is useless to a live bot unless the OI reading is FAST. The
-- portal's metrics files are 5-minute buckets published after the day closes,
-- and the live 5m aggregate endpoints lag 6-16 minutes — far slower than the
-- sub-five-minute events they would have to classify.
--
-- Measured on the Oracle host 2026-09-12: /fapi/v1/openInterest returns a
-- reading stamped ~8 SECONDS old, in ~0.6s round trip. That is fast enough.
-- But it is a SNAPSHOT — it carries no delta — so computing "OI change across
-- the last five minutes" requires having sampled and stored the history
-- yourself. Hence this table.
--
-- Only the Oracle host can write it: fapi.binance.com is HTTP 451 from the
-- developer machine and from GitHub runners.
CREATE TABLE IF NOT EXISTS oi_tick (
  symbol TEXT NOT NULL,
  ts INTEGER NOT NULL,              -- exchange timestamp, ms epoch
  oi_contracts REAL,
  oi_usd REAL,
  mark_price REAL,
  PRIMARY KEY (symbol, ts)
);
CREATE INDEX IF NOT EXISTS idx_oi_tick_ts ON oi_tick(ts);

-- Detected in-flight events, written by the sampler the moment the geometry
-- qualifies. Deliberately separate from trading_bot_entry_intents: this is an
-- OBSERVATION ("a flush is happening on ZEC right now, OI is falling"), not a
-- decision to trade. Keeping them apart means the classifier can be evaluated
-- on its own record before anything is allowed to act on it.
--
-- classification uses the measured rule, not a guess:
--   'liquidation'  OI fell through the move  -> partial recovery expected (~50%)
--   'new-position' OI rose through the move  -> full retrace expected (~106%)
--   'ambiguous'    OI flat, or no OI history deep enough to judge
CREATE TABLE IF NOT EXISTS flush_event (
  id TEXT PRIMARY KEY,              -- symbol|first_ts
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('down', 'up')),
  detected_at TEXT NOT NULL,
  first_ts INTEGER NOT NULL,
  ref_price REAL NOT NULL,          -- pre-event extreme the move is measured from
  extreme_price REAL NOT NULL,      -- furthest price reached during the move
  move_pct REAL NOT NULL,
  oi_change_pct REAL,               -- across the move; the classifying variable
  classification TEXT NOT NULL CHECK (classification IN ('liquidation', 'new-position', 'ambiguous')),
  expected_recovery REAL,           -- from the measured medians, not a forecast
  -- Outcome, filled in later by whatever scores these. Left NULL on write so a
  -- detection can never be confused with a verified result.
  resolved_at TEXT,
  actual_recovery REAL,
  fwd_1h_pct REAL,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_flush_event_symbol ON flush_event(symbol, first_ts);
CREATE INDEX IF NOT EXISTS idx_flush_event_unresolved ON flush_event(resolved_at) WHERE resolved_at IS NULL;
