-- Outcomes are three-way (up / flat / down, OUTCOME_DEADBAND_PCT = 0.5%), but a
-- technique only ever votes +1 or -1. That makes 50% the WRONG no-skill line:
-- a flat outcome marks both an up-call and a down-call wrong, so every
-- technique's measured accuracy is structurally dragged under 0.5 even when it
-- carries real information. isReliabilitySignificant/reliabilityWeight tested
-- against a hardcoded p0 = 0.5, so the learning loop read almost the whole
-- technique library as "below average" and shrank nearly everything toward a
-- neutral weight.
--
-- Measured live from this database's own bars (2026-06-01 onward, same 0.5%
-- deadband) at the time this migration was written:
--
--   crypto  24h   up 34.4%  flat 27.2%  down 38.4%   -> best constant call 38.4%
--   crypto 168h   up 40.5%  flat 16.9%  down 42.5%   -> best constant call 42.5%
--   stock   24h   up 42.4%  flat 16.2%  down 41.4%   -> best constant call 42.4%
--   stock  168h   up 52.1%  flat  5.2%  down 42.7%   -> best constant call 52.1%
--
-- Against those baselines the composite's real skill is the opposite of what
-- the pooled 49.8% headline suggested: crypto is strongly positive
-- (+22.6pts at 24h, +15.0pts at 168h) and stocks are significantly negative
-- (-10.2pts at both). Pooling the two hid both results.
--
-- This table accumulates that outcome distribution forward from live matured
-- predictions rather than pinning the numbers above, so the baseline tracks
-- regime changes on its own. Counts are deduped per (symbol, run_at) exactly
-- the way asset_move_stats already is -- several techniques voting on one
-- asset in one hour all describe the SAME underlying price move, so counting
-- them separately would inflate the baseline's own sample count.
CREATE TABLE IF NOT EXISTS direction_baseline (
  asset_class TEXT NOT NULL,
  horizon_hours INTEGER NOT NULL,
  n_up INTEGER NOT NULL DEFAULT 0,
  n_flat INTEGER NOT NULL DEFAULT 0,
  n_down INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (asset_class, horizon_hours)
);

-- A technique's own null accuracy depends on the mix of directions IT chose,
-- not just on the market's outcome distribution: a technique that only ever
-- votes "up" has null accuracy P(up), one that splits evenly has the average.
-- Tracking the mix lets noSkillBaseline() compute a per-record null instead of
-- applying one class-wide number to every technique.
ALTER TABLE technique_reliability ADD COLUMN votes_up INTEGER NOT NULL DEFAULT 0;
ALTER TABLE technique_reliability ADD COLUMN votes_down INTEGER NOT NULL DEFAULT 0;

-- Seed, so the correction takes effect on the next build instead of waiting
-- weeks for live outcomes to clear BASELINE_MIN_SAMPLES (until then
-- noSkillBaseline falls back to 0.5 and nothing changes). Proportions are the
-- measured ones above; counts are deliberately scaled down to ~600 per cell
-- rather than the full 3-6k measured, so a few hundred live outcomes can move
-- the baseline meaningfully instead of being swamped by the seed forever.
-- ON CONFLICT DO NOTHING: never overwrite live-accumulated evidence with it.
INSERT INTO direction_baseline (asset_class, horizon_hours, n_up, n_flat, n_down, updated_at) VALUES
  ('crypto',  24, 206, 163, 230, '2026-08-29T02:00:00Z'),
  ('crypto', 168, 243, 101, 255, '2026-08-29T02:00:00Z'),
  ('stock',   24, 254,  97, 248, '2026-08-29T02:00:00Z'),
  ('stock',  168, 313,  31, 256, '2026-08-29T02:00:00Z')
ON CONFLICT (asset_class, horizon_hours) DO NOTHING;
