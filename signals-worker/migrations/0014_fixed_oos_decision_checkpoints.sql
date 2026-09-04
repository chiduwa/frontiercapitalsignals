-- Sequential OOS reviews use the smaller side of a two-sample comparison as
-- their information count. `oos_trade_n` is only the number of simulated setup
-- trades and can be much larger, so it cannot safely remember which fixed
-- 25/50/100/... checkpoint was last evaluated.
ALTER TABLE research_strategy_metrics
  ADD COLUMN oos_checkpoint_n INTEGER NOT NULL DEFAULT 0;

ALTER TABLE research_strategy_metric_history
  ADD COLUMN oos_checkpoint_n INTEGER NOT NULL DEFAULT 0;
