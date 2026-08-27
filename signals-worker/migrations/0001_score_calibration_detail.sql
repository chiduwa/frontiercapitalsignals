-- Keep alert calibration specific to the asset class, direction, and
-- evaluated horizon. The existing score_calibration table remains intact as a
-- pooled fallback while these more granular cells accumulate enough evidence.
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
