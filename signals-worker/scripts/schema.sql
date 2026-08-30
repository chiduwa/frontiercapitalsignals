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
-- KNOWN DEFECT, not yet repaired (found 2026-08-30): this PRIMARY KEY does not
-- include asset_class, but a ticker is NOT unique across asset classes. DASH is
-- both Dash the cryptocurrency (~$41) and DoorDash the equity (~$237), and the
-- two overwrite each other day by day, leaving one interleaved series that
-- alternates between the two price scales. Confirmed by scanning all 694k rows:
-- DASH is currently the ONLY affected symbol, so the blast radius is one asset
-- -- but any future overlap (crypto tickers reuse equity tickers freely) would
-- silently corrupt the same way.
--
-- Everything derived from these bars inherits the corruption for that symbol:
-- computeDailyRangeStats, computeLeadLag, computeSrLevelsAndBreaks and the
-- sector composites all read this table. dailyRangeStatsFromRows now DROPS any
-- symbol appearing under more than one asset_class rather than measuring the
-- mixture; the other consumers do not yet have that guard.
--
-- The real fix is widening this key to (symbol, asset_class, date) and
-- backfilling, which means re-keying every dependent table and recomputing the
-- derived ones -- deliberately not done as a side effect of a day-trading
-- feature. Until then, treat DASH's archived history as unreliable.
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
  opened_at TEXT NOT NULL
);

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
