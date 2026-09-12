-- Four data families the engine was blind to, added together because they are
-- consumed by one feature panel and gated by one correction.
--
-- Requested: "can our model check for and incorporate supply and demand ...
-- liquidity and production costs, on-chain activities, and any other relevant
-- metrics we may have missed".

-- 1. ORDER-BOOK LIQUIDITY -----------------------------------------------------
-- From Binance's public data portal bookDepth dataset: ~3,456 snapshots/day of
-- resting notional at each 1% step out to +/-5% from mid. Same host and same
-- access story as derivatives_daily (migration 0033) — no new supplier risk.
--
-- Why this matters beyond being "another feature": the cost model in
-- docs/DERIVATIVES_EVIDENCE.md charges a FLAT 6.5bp per side to BTC and to
-- microcaps alike, and flagged that as optimistic for illiquid names. Real
-- depth is what turns that single tunable number into a per-asset estimate.
--
-- book_imbalance is the genuinely new signal here, not depth itself: resting
-- bid notional versus ask notional is standing limit interest, which no
-- price/volume/OI series in this engine expresses.
CREATE TABLE IF NOT EXISTS asset_liquidity_daily (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  venue_symbol TEXT NOT NULL,
  bid_notional_1pct REAL,        -- mean resting USD within 1% below mid
  ask_notional_1pct REAL,
  bid_notional_5pct REAL,
  ask_notional_5pct REAL,
  -- (bid - ask) / (bid + ask) at +/-1%. Positive = more resting bids.
  book_imbalance_1pct REAL,
  book_imbalance_5pct REAL,
  -- Total two-sided depth at 1%, the scale term the cost model needs.
  depth_1pct_usd REAL,
  snapshots INTEGER NOT NULL,    -- how many book samples fed this row
  source TEXT NOT NULL,
  PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_asset_liquidity_daily_date ON asset_liquidity_daily(date);

-- 2. SUPPLY SNAPSHOTS, CAPTURED DAILY ----------------------------------------
-- asset_supply_daily (migration 0035) derives circulating supply from
-- market_cap/price via CoinGecko market_chart, one call per symbol. That gets
-- HISTORY but is unusable at scale: CoinGecko's free tier throttled a 23/min
-- local run into total failure and a 9s-paced Actions run into the same, and
-- every free alternative for historical supply is paywalled (CoinPaprika 402,
-- CoinCap withdrawn).
--
-- This table takes the opposite trade and wins on cost: getCryptoMarkets() is
-- ALREADY CALLED by every hourly build and already returns circulating, total
-- and max supply for all 250 coins in ONE request. Archiving it is therefore
-- ZERO additional API cost, perfectly reliable, and accumulates from today.
--
-- It captures what the dilution-only framing missed:
--   * burns   -> circulating_supply FALLS; supply_change_pct goes negative
--   * unlocks -> circulating rises toward total
--   * lockups -> circulating falls while total is unchanged (staking,
--                vesting re-locks, treasury withdrawals from float)
-- The sign and the total/circulating gap together distinguish them, which a
-- one-directional "dilution" metric cannot.
CREATE TABLE IF NOT EXISTS asset_supply_snapshot_daily (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  circulating_supply REAL,
  total_supply REAL,
  max_supply REAL,
  market_cap REAL,
  source TEXT NOT NULL,
  PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_asset_supply_snapshot_daily_date ON asset_supply_snapshot_daily(date);

-- 3. CHAIN ACTIVITY AND MACRO LIQUIDITY --------------------------------------
-- DefiLlama, free and historical. Two different things in one table, keyed by
-- `metric`, because both are chain-scoped daily series and splitting them into
-- separate tables would duplicate the same loader three times.
--
--   tvl              per-chain total value locked -- on-chain activity, and
--                    the closest free proxy for capital actually deployed
--   stablecoin_mcap  circulating stablecoin supply -- the standard macro
--                    liquidity proxy for crypto; dry powder entering or
--                    leaving the whole asset class
--
-- Chain-level, not asset-level. It joins to an asset through asset_sectors /
-- the chain a token settles on, and stands alone as market context otherwise.
CREATE TABLE IF NOT EXISTS chain_metrics_daily (
  chain TEXT NOT NULL,           -- 'Ethereum', 'Solana', or 'ALL' for aggregates
  date TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('tvl', 'stablecoin_mcap')),
  value REAL NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (chain, date, metric)
);
CREATE INDEX IF NOT EXISTS idx_chain_metrics_daily_date ON chain_metrics_daily(date, metric);

-- 4. PRODUCTION COST (PROOF OF WORK) -----------------------------------------
-- blockchain.info charts, free and historical. Bitcoin only by construction —
-- this is a PoW concept and most of the tracked universe is not PoW, so the
-- feature it feeds must abstain elsewhere rather than fabricate a number.
--
-- The economic claim being tested, not assumed: miner marginal cost acts as a
-- soft floor, because sustained price below it forces capitulation and
-- hashrate withdrawal. Difficulty and hashrate give the cost side; miners'
-- revenue gives the income side. Their ratio is a cost-basis proxy, NOT a
-- dollar cost per coin -- electricity price and hardware efficiency are not in
-- this data and are deliberately not guessed at.
CREATE TABLE IF NOT EXISTS network_cost_daily (
  network TEXT NOT NULL,         -- 'BTC'
  date TEXT NOT NULL,
  hashrate REAL,                 -- TH/s
  difficulty REAL,
  miners_revenue_usd REAL,
  transactions INTEGER,
  source TEXT NOT NULL,
  PRIMARY KEY (network, date)
);
