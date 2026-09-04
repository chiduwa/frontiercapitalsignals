-- Exact audit trail for every scored forecast. This makes timing errors
-- diagnosable (declared target versus the actual observation used) and keeps
-- model/label changes visible instead of silently blending definitions.
ALTER TABLE forecast_outcomes ADD COLUMN target_at TEXT;
ALTER TABLE forecast_outcomes ADD COLUMN observed_at TEXT;
ALTER TABLE forecast_outcomes ADD COLUMN entry_price REAL CHECK (entry_price IS NULL OR entry_price > 0);
ALTER TABLE forecast_outcomes ADD COLUMN exit_price REAL CHECK (exit_price IS NULL OR exit_price > 0);
ALTER TABLE forecast_outcomes ADD COLUMN path_high_pct REAL;
ALTER TABLE forecast_outcomes ADD COLUMN path_low_pct REAL;
ALTER TABLE forecast_outcomes ADD COLUMN minutes_to_high REAL CHECK (minutes_to_high IS NULL OR minutes_to_high >= 0);
ALTER TABLE forecast_outcomes ADD COLUMN minutes_to_low REAL CHECK (minutes_to_low IS NULL OR minutes_to_low >= 0);
ALTER TABLE forecast_outcomes ADD COLUMN model_version TEXT NOT NULL DEFAULT 'confluence-v7';
ALTER TABLE forecast_outcomes ADD COLUMN label_version TEXT NOT NULL DEFAULT 'direction-deadband-0.5pct-v1';

CREATE INDEX IF NOT EXISTS idx_forecast_outcomes_model_slice
  ON forecast_outcomes(model_version, label_version, asset_class, symbol,
                       horizon_minutes, series_kind, series_key, run_at DESC);
