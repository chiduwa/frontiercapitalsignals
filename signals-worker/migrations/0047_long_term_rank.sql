-- Depth of the fall behind each "possible multi-month/year low", so the boards
-- can rank candidates and show at most 20 per asset class
-- (rankLongTermCandidates, worker.js). Additive; NULL until the next
-- daily-refresh writes the table, and the ranking falls back to base length.
ALTER TABLE long_term_bottom_status ADD COLUMN drawdown_pct REAL;
