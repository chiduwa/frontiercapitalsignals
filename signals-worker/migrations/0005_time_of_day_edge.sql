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
-- Slots are DST-AWARE exchange-local labels (hour_utc_NN, hour_et_NN,
-- hour_ldn_NN, hour_tyo_NN, dow_utc_N) from slotsForTimestamp, not raw UTC
-- hours. The first version keyed on raw UTC and that was a real measurement
-- error, not a nicety: 16:00 ET is 20:00 UTC under EDT and 21:00 UTC under
-- EST, so an effect anchored to the US close was split across two buckets and
-- each half measured separately. The symptom was visible in the data — hours
-- 20 and 21 both came out positive across every asset, which looks like two
-- weak patterns and is actually one strong one cut in half by the clock change.
-- Exchange-local slots keep such an effect in a single bucket year-round, and
-- cover the boundaries that matter: 00:00 ET, 00:00 UTC, and the NYSE, LSE and
-- TSE opens and closes.
--
-- Measured live at creation on RAW UTC hours (pre-DST-fix), 20:00 UTC:
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
