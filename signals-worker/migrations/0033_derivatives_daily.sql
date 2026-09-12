-- Deep historical derivatives archive, backfilled from Binance's PUBLIC DATA
-- PORTAL (data.binance.vision), not its trading API.
--
-- Why a new table instead of backfilling funding_rate_daily: that table's OI
-- comes from CoinGecko /derivatives, which reports the single highest-OI
-- venue per asset across all exchanges. This table is Binance-USDT-perp only.
-- The two are NOT level-comparable (Binance is a subset of global OI, and
-- which venue CoinGecko picks can change day to day), so mixing them into one
-- column would silently create fake jumps at the join seam. Percent CHANGES
-- track each other closely, which is what the features actually consume.
--
-- Why this source at all: fapi.binance.com is HTTP 451 from this project's
-- infra (verified again 2026-09-11, same as archive.mjs's existing note), and
-- api.bybit.com is HTTP 403 CloudFront country-blocked. The public data
-- portal is a plain static bucket on the same host family as
-- data-api.binance.vision, which this codebase already depends on for crypto
-- daily bars, and it is NOT geo-blocked. Coverage confirmed live 2026-09-11:
-- 141 of the 168 symbols in funding_rate_daily, BTC back to 2020-09-01 and
-- most majors to 2022-01-01.
--
-- This replaces "wait for the daily logger to accumulate history." The live
-- funding_rate_daily logger keeps running unchanged; this is the deep past it
-- could never reach.
--
-- Beyond open interest, each file also carries positioning ratios Binance
-- publishes nowhere else in historical form: the long/short split of TOP
-- TRADERS by account and by position size, the all-account split, and taker
-- buy/sell volume. Those are stored here because they are the natural
-- controls for "is this OI build-up crowded retail or positioned size" — the
-- question raw OI alone cannot answer.
--
-- RESEARCH INPUT ONLY on arrival. Nothing here is wired to published signals,
-- learned weights, alerts, or orders. Features derived from it must clear the
-- cross-sectional lane's existing evidence gate (XS_FAMILY_ALPHA,
-- XS_MIN_SIGN_CONSISTENCY) exactly like every other candidate feature.

CREATE TABLE IF NOT EXISTS derivatives_daily (
  symbol TEXT NOT NULL,                 -- project symbol (ZEC), never the venue's
  date TEXT NOT NULL,                   -- UTC date of the 5m bars aggregated into this row
  venue_symbol TEXT NOT NULL,           -- BTCUSDT, 1000PEPEUSDT -- kept so the 1000x
                                        -- quantity convention stays auditable
  -- Open interest. *_usd is the trustworthy cross-symbol field:
  -- open_interest_qty is denominated in the venue's contract unit, which for
  -- a 1000-prefixed listing counts 1000 tokens per unit.
  oi_usd_close REAL,                    -- last 5m bar of the UTC day, aligned with a price close
  oi_usd_mean REAL,                     -- day mean, less sensitive to one noisy print
  oi_usd_high REAL,
  oi_usd_low REAL,
  oi_qty_close REAL,
  -- Positioning. Ratios are long/short; >1 means net long.
  toptrader_account_ls REAL,            -- count_toptrader_long_short_ratio
  toptrader_position_ls REAL,           -- sum_toptrader_long_short_ratio (size-weighted)
  all_account_ls REAL,                  -- count_long_short_ratio
  taker_buy_sell_ratio REAL,            -- sum_taker_long_short_vol_ratio (day mean)
  samples INTEGER NOT NULL,             -- 5m bars that fed this row; a full day is 288
  source TEXT NOT NULL,
  PRIMARY KEY (symbol, date)
);

CREATE INDEX IF NOT EXISTS idx_derivatives_daily_date ON derivatives_daily(date);

-- Resumable-backfill bookkeeping. The portal serves ONE FILE PER SYMBOL PER
-- DAY (there is no monthly metrics roll-up -- checked live), so a full-depth
-- pass is ~141k HTTP requests and cannot be assumed to finish inside a single
-- Actions job. Each run advances whatever it can and records where it got to;
-- re-running resumes rather than restarting. `unavailable` is a real terminal
-- state, not a failure: not every tracked asset has a Binance USDT perp.
CREATE TABLE IF NOT EXISTS derivatives_backfill_state (
  symbol TEXT PRIMARY KEY,
  venue_symbol TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'partial', 'complete', 'unavailable')),
  earliest_date TEXT,                   -- oldest date confirmed stored
  latest_date TEXT,                     -- newest date confirmed stored
  earliest_probed TEXT,                 -- oldest date actually requested, hit or 404
  days_stored INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  notes TEXT
);
