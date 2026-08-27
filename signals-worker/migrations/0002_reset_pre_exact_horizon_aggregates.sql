-- Before exact-target matching, maturity evaluation compared forecasts with an
-- arbitrary later "latest" price whenever the scheduler was delayed. Those
-- aggregate statistics are not valid 24h/168h evidence and must not influence
-- future weights or alert confidence. Raw price/vote/archive data is retained;
-- corrected aggregates begin accumulating only from exact-horizon outcomes.
DELETE FROM technique_reliability;
DELETE FROM technique_regime_reliability;
DELETE FROM technique_combo_reliability;
DELETE FROM range_reliability;
DELETE FROM asset_move_stats;
DELETE FROM score_calibration;
DELETE FROM score_calibration_detail;
DELETE FROM asset_score_snapshots;

-- Call-flip outcomes had the same timing defect. Keep their historical flip
-- events for the dashboard but exclude legacy labels from held/reverted stats.
UPDATE call_flip_log
SET outcome = 'legacy-unscored',
    outcome_checked_at = NULL
WHERE outcome IS NOT NULL;
