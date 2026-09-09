-- Exact post-sanitizer signal state for causal retrospective grading.
--
-- technique_votes is intentionally a full-universe learning log. It cannot
-- tell us which side-specific top-10 row, pinned favorite, or confidence-gated
-- call was actually published. This append-only snapshot records the exact
-- object presented to users before a later outcome is known.

CREATE TABLE IF NOT EXISTS signal_publication_snapshots (
  run_at TEXT NOT NULL,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('crypto', 'stock')),
  universe_json TEXT NOT NULL CHECK (json_valid(universe_json)),
  boards_json TEXT NOT NULL CHECK (json_valid(boards_json)),
  universe_count INTEGER NOT NULL CHECK (universe_count >= 0),
  PRIMARY KEY (run_at, asset_class)
);

CREATE INDEX IF NOT EXISTS idx_signal_publication_snapshots_latest
  ON signal_publication_snapshots(asset_class, run_at DESC);

-- Legacy columns retain their originally observed endpoint values. These
-- additions identify the causal, pre-window facts used for all new grading.
ALTER TABLE retrospective_misses ADD COLUMN prewindow_in_universe INTEGER
  CHECK (prewindow_in_universe IN (0, 1));
ALTER TABLE retrospective_misses ADD COLUMN publication_snapshot_at TEXT;
ALTER TABLE retrospective_misses ADD COLUMN publication_state TEXT
  CHECK (publication_state IN ('published', 'conflicted', 'withheld', 'not-surfaced', 'not-in-universe'));
ALTER TABLE retrospective_misses ADD COLUMN state_basis TEXT;

-- Existing pattern rows were derived from reconstructed publication state and
-- are not comparable with the exact-snapshot method. They are disposable
-- aggregates; raw observations remain intact and the next retrospective run
-- rebuilds this table only from causally graded rows.
DELETE FROM retrospective_patterns;
