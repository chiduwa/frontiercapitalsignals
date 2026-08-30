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
