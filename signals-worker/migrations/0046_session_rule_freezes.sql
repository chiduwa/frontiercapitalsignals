-- Prospective freeze ledger for the session/calendar timing rules.
--
-- WHY: every timing number this project has is retrospective. The study splits
-- development (through 2025-12-31) from a 2026 holdout, which was honest the
-- first time and has been eroding ever since — the weekly rerun re-estimates on
-- a period it has already seen many times, so "holdout" now means "repeatedly
-- inspected". PREDICTION_ROADMAP.md is explicit that a rerun is monitoring, not
-- independent confirmation, and that the way out is to timestamp every rule
-- BEFORE its outcomes exist.
--
-- This table is that timestamp. A row says: these exact parameters were fixed
-- at this instant, and only data after evaluation_starts_at may ever be used to
-- score them. It is append-only and rows are never updated — the writer uses
-- ON CONFLICT DO NOTHING precisely so that a rerun which re-picks a different
-- hour CANNOT move an existing freeze. A re-pick is a different rule_id and
-- therefore a new row with its own later start date, which is what stops the
-- goalposts moving quietly.
--
-- claim_type is load-bearing, not documentation. 'activity' rules say only WHEN
-- larger moves happen; they carry no direction and must never reach a trade
-- decision. Conflating the two is the specific error the roadmap forbids
-- ("never infer direction from a magnitude forecast"), so the distinction is a
-- CHECK constraint rather than a convention.
CREATE TABLE IF NOT EXISTS session_rule_freezes (
  rule_id TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  claim_type TEXT NOT NULL CHECK(claim_type IN ('direction','activity')),
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  -- The exact frozen parameters, as JSON. Anything that could change the rule's
  -- meaning is also encoded in rule_id, so this is provenance, not the key.
  params_json TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  -- First date whose outcome is admissible. Strictly after everything the study
  -- could have seen, so a rule can never be scored on its own training data.
  evaluation_starts_at TEXT NOT NULL,
  study_version TEXT NOT NULL,
  study_as_of TEXT NOT NULL,
  input_hash TEXT,
  code_hash TEXT,
  -- What the study had already looked at when it proposed this rule. Kept so a
  -- later reader can tell retrospective evidence from prospective evidence
  -- without having to trust that the distinction was honoured.
  development_ends TEXT,
  holdout_starts TEXT,
  discovery_n INTEGER,
  discovery_stat REAL,
  discovery_adjusted_p REAL,
  tests_in_family INTEGER,
  -- Whether the STUDY called it supported. Recorded, never trusted: an
  -- unsupported rule is frozen too, because only freezing the winners is how a
  -- family-wise error rate gets quietly thrown away.
  study_supported INTEGER NOT NULL DEFAULT 0,
  first_seen_run TEXT
);

CREATE INDEX IF NOT EXISTS session_rule_freezes_symbol
  ON session_rule_freezes(symbol, family, frozen_at);
CREATE INDEX IF NOT EXISTS session_rule_freezes_eval_start
  ON session_rule_freezes(evaluation_starts_at);
