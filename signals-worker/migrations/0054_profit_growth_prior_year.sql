-- The prior-year figures behind each growth rate (2026-09-26). A growth rate
-- off a LOSS reads as thousands of percent (-$2M to +$50M is "+2600%"), which
-- says less than "turned positive". Storing the base lets the page say the
-- true thing. Applied once by wrangler's migration journal.
ALTER TABLE profit_growth_screen ADD COLUMN prev_ni REAL;
ALTER TABLE profit_growth_screen ADD COLUMN oi_ttm REAL;
ALTER TABLE profit_growth_screen ADD COLUMN oi_prev REAL;
ALTER TABLE company_profit_metrics ADD COLUMN prev_ni REAL;
ALTER TABLE company_profit_metrics ADD COLUMN oi_ttm REAL;
ALTER TABLE company_profit_metrics ADD COLUMN oi_prev REAL;
