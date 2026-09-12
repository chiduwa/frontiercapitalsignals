-- Token supply and dilution. The engine had NO supply data of any kind before
-- this: no circulating, total or max supply anywhere in worker.js or scripts/.
-- That is a real blind spot, because "how much more of this token is about to
-- exist" is a first-order driver of price and is invisible to every
-- price/volume/OI feature already modelled.
--
-- Requested directly: "can our model check for and incorporate supply and
-- demand (at a point in time, eg more supply will be released soon)".
--
-- WHY CIRCULATING SUPPLY IS DERIVED RATHER THAN FETCHED
--
-- DefiLlama publishes actual unlock SCHEDULES, which would be the ideal
-- source, but /emissions returns HTTP 402 on the free plan (checked
-- 2026-09-12). CoinGecko's free tier gives current supply but no supply
-- history.
--
-- However, /coins/{id}/market_chart returns `prices` AND `market_caps` over
-- full history in ONE call, and circulating supply is exactly market_cap /
-- price. So the realized supply curve is recoverable for the whole archive at
-- a cost of one request per symbol, without a paid plan and without waiting
-- for a logger to accumulate.
--
-- Arguably this is the better measurement anyway: a schedule says what was
-- SUPPOSED to unlock, while this says what actually entered circulation —
-- including unscheduled mints, burns and treasury movements a calendar misses.
--
-- Derived values carry derivation error: market_cap and price are each rounded
-- by the supplier, so the ratio is noisy at the margin. It is therefore stored
-- as a real number to be differenced over WEEKS, never treated as an exact
-- token count. `market_cap` and `price_used` are kept alongside so the
-- derivation stays auditable and can be re-done if CoinGecko changes units.
CREATE TABLE IF NOT EXISTS asset_supply_daily (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  circulating_supply REAL,        -- derived: market_cap / price_used
  market_cap REAL,
  price_used REAL,
  source TEXT NOT NULL,
  PRIMARY KEY (symbol, date)
);

CREATE INDEX IF NOT EXISTS idx_asset_supply_daily_date ON asset_supply_daily(date);

-- Total and max supply are POINT-IN-TIME ONLY — CoinGecko exposes no history
-- for them, so there is no honest way to build a daily series and this table
-- deliberately does not pretend otherwise. It holds one current row per symbol.
--
-- The overhang metric this enables, (total - circulating) / circulating, is the
-- direct form of "more supply will be released soon": APT measured 40.7% on
-- 2026-09-12 against ~0% for BTC and ZEC. Because it is a snapshot, it can be
-- used as a CROSS-SECTIONAL feature (compare assets today) but NOT as a
-- time-series one (compare an asset to its own past) — the realized dilution
-- rate from asset_supply_daily is what serves that purpose.
CREATE TABLE IF NOT EXISTS asset_supply_snapshot (
  symbol TEXT PRIMARY KEY,
  coingecko_id TEXT,
  circulating_supply REAL,
  total_supply REAL,
  max_supply REAL,
  as_of TEXT NOT NULL
);
