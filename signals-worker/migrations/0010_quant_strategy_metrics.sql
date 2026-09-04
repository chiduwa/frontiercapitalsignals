-- A statistically interesting pattern is not automatically a tradeable one.
-- Keep the research lifecycle in research_registry, and store a separate,
-- queryable execution/risk assessment here. `trade_decision` is the hard gate
-- used by discovery.mjs: only `confirmed` rows may produce live setup alerts.
--
-- Returns are percent per non-overlapping setup event. The cost field is an
-- explicit assumption deducted once per round trip; funding, borrow, taxes,
-- and market impact remain outside the model and are named in alert copy.
CREATE TABLE IF NOT EXISTS research_strategy_metrics (
  hypothesis TEXT PRIMARY KEY,
  strategy_direction TEXT NOT NULL CHECK (strategy_direction IN ('long', 'short', 'abstain')),
  assumed_round_trip_cost_pct REAL NOT NULL CHECK (assumed_round_trip_cost_pct >= 0),

  discovery_trade_n INTEGER NOT NULL DEFAULT 0,
  discovery_gross_mean_pct REAL,
  discovery_net_mean_pct REAL,
  discovery_net_lower_95_pct REAL,
  discovery_win_rate_pct REAL,
  discovery_profit_factor REAL,
  discovery_compound_return_pct REAL,
  discovery_max_drawdown_pct REAL,
  discovery_worst_trade_pct REAL,

  walk_forward_verdict TEXT NOT NULL DEFAULT 'insufficient'
    CHECK (walk_forward_verdict IN ('passed', 'failed', 'insufficient')),
  walk_forward_folds INTEGER NOT NULL DEFAULT 0,
  walk_forward_positive_folds INTEGER NOT NULL DEFAULT 0,
  walk_forward_net_mean_pct REAL,
  walk_forward_net_lower_95_pct REAL,
  walk_forward_max_drawdown_pct REAL,

  oos_trade_n INTEGER NOT NULL DEFAULT 0,
  oos_gross_mean_pct REAL,
  oos_net_mean_pct REAL,
  oos_net_lower_95_pct REAL,
  oos_win_rate_pct REAL,
  oos_profit_factor REAL,
  oos_compound_return_pct REAL,
  oos_max_drawdown_pct REAL,
  oos_worst_trade_pct REAL,

  trade_decision TEXT NOT NULL DEFAULT 'abstain'
    CHECK (trade_decision IN ('abstain', 'provisional', 'confirmed')),
  decision_reason TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (hypothesis) REFERENCES research_registry(hypothesis) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_research_strategy_decision
  ON research_strategy_metrics(trade_decision, oos_net_lower_95_pct DESC);

-- Append-only decision history makes deterioration and re-calibration
-- auditable instead of overwriting yesterday's assessment with today's.
CREATE TABLE IF NOT EXISTS research_strategy_metric_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hypothesis TEXT NOT NULL,
  trade_decision TEXT NOT NULL,
  decision_reason TEXT NOT NULL,
  oos_trade_n INTEGER NOT NULL DEFAULT 0,
  oos_net_mean_pct REAL,
  oos_net_lower_95_pct REAL,
  oos_compound_return_pct REAL,
  oos_max_drawdown_pct REAL,
  computed_at TEXT NOT NULL,
  FOREIGN KEY (hypothesis) REFERENCES research_registry(hypothesis) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_research_strategy_history
  ON research_strategy_metric_history(hypothesis, computed_at DESC);
