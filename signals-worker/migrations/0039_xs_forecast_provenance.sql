-- Where a cross-sectional forecast came from, mirroring what migration 0038
-- did for forecast_outcomes.
--
-- 'live'   cast by a scheduled build from coefficients fitted on everything
--          available at that moment, then scored when the horizon elapsed.
-- 'replay' cast by scripts/replay-xs.mjs over archive sections, from
--          coefficients refit WALK-FORWARD on strictly prior sections only.
--
-- These pool, and the reason is the same one that let the direction lane pool
-- its two populations: the live lane is itself walk-forward (at time T its
-- coefficients were fitted on data up to T), so a replay that refits the same
-- way is producing observations of the same estimator, not a different one.
--
-- The replay previously wrote under its own method_version instead, which kept
-- the two apart in separate rows of xs_decile_evidence. That was over-cautious
-- rather than wrong, and it had a cost: the publication gate reads only the
-- live method version, so 101,563 matured walk-forward observations sat where
-- the gate could not see them while it judged the lane on five days of live
-- logging -- about 40 observations per decile against a 200-section bar.
--
-- A column, not a version, so the claim that they agree stays checkable: any
-- query can split them and compare, and a material divergence in decile means
-- between the two is the alarm that the replay has drifted from the live lane.
ALTER TABLE xs_forecast_log ADD COLUMN provenance TEXT NOT NULL DEFAULT 'live';

CREATE INDEX IF NOT EXISTS idx_xs_forecast_log_provenance
  ON xs_forecast_log(provenance, method_version, asset_class, horizon_days, decile);
