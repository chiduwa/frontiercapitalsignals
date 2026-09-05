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
