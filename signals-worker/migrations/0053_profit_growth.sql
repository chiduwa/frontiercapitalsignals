-- Profit growers (2026-09-26, scripts/profit-growth.mjs,
-- docs/research-2026-09-26/PROFIT_GROWTH.md). Small and mid-sized US companies
-- whose profits are growing, from SEC filings. Idempotent by construction.

-- Each day's two lists, as published. Never rewritten after the day, so a
-- later cohort score always judges what was actually shown.
CREATE TABLE IF NOT EXISTS profit_growth_screen (
  as_of TEXT NOT NULL,
  list TEXT NOT NULL,              -- 'small' | 'mid'
  rank INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT,
  sector TEXT,
  industry TEXT,
  price REAL,
  mcap REAL,
  ttm_ni REAL,                     -- net profit, last four quarters, USD
  ni_growth REAL,                  -- vs the four quarters before, as a fraction
  rev_growth REAL,
  oi_growth REAL,
  yoy_up INTEGER,                  -- of the last 4 quarters, how many beat the same quarter a year earlier
  profitable_quarters INTEGER,
  net_margin REAL,
  pe REAL,
  latest_quarter_end TEXT,
  liquidity REAL,                  -- median weekly dollar volume, last 13 weeks
  why TEXT,
  PRIMARY KEY (as_of, list, symbol)
);

-- The comparison group, once a week: every small and mid-cap listing and its
-- price, so a week's lists are judged against their own size bucket.
CREATE TABLE IF NOT EXISTS profit_growth_benchmark (
  as_of TEXT NOT NULL,
  bucket TEXT NOT NULL,
  symbol TEXT NOT NULL,
  price REAL NOT NULL,
  PRIMARY KEY (as_of, bucket, symbol)
);

-- Scored cohorts: a week's list against its bucket over 28, 91 and 182 days.
CREATE TABLE IF NOT EXISTS profit_growth_outcomes (
  cohort TEXT NOT NULL,
  list TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  n INTEGER NOT NULL,
  bucket_n INTEGER NOT NULL,
  list_pct REAL,
  bucket_pct REAL,
  excess_pct REAL,
  scored_on TEXT NOT NULL,
  PRIMARY KEY (cohort, list, horizon_days)
);

-- Latest profit facts for every listed company, so the existing stock screens
-- can show profitability next to their own rows.
CREATE TABLE IF NOT EXISTS company_profit_metrics (
  symbol TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  bucket TEXT,
  mcap REAL,
  ttm_ni REAL,
  ni_growth REAL,
  rev_growth REAL,
  oi_growth REAL,
  yoy_up INTEGER,
  profitable_quarters INTEGER,
  net_margin REAL,
  latest_quarter_end TEXT,
  qualifies INTEGER NOT NULL DEFAULT 0
);
