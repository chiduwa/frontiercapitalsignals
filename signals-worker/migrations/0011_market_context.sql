-- Daily, point-in-time market context for cycle/rotation research.
--
-- These rows are deliberately NOT techniques and do not vote on a live
-- asset. They first enter the research registry, then need a purged
-- walk-forward result and genuinely post-discovery observations before they
-- can ever become actionable. This prevents a visually convincing Bitcoin
-- cycle chart, fitted on three or four cycles, from being promoted as a
-- forecast.
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
