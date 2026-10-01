-- The market cap each surge cast was judged with (2026-10-01,
-- docs/research-2026-10-01/EXHAUSTION_SQUEEZES.md), so the live record can be
-- sliced by coin size and the $500M ceiling on the per-coin exhaustion rule
-- re-checked on forward data. NULL means the coin was outside CoinGecko's top
-- 250 or no lookup succeeded that run. ADD COLUMN only edits the schema: no
-- table rewrite, and no extra billed write per inserted row.
ALTER TABLE surge_signal_log ADD COLUMN market_cap REAL;
