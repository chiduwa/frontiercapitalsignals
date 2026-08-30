-- Continuous, self-validating research (user-requested 2026-08-30: "look for
-- useful correlations/observations, notify me, and learn from it so the
-- predictions keep getting better").
--
-- correlation_research_findings stays exactly as it is: an append-only audit
-- log of what every run measured. This registry is the different thing that
-- was missing — one row per hypothesis carrying its LIFECYCLE, so a pattern
-- can be tracked over time instead of re-discovered from scratch each run.
--
-- The lifecycle is the whole point, and it exists because of a specific
-- failure mode. A scan over many hypotheses will always turn up some that look
-- significant in the data used to find them; that is what searching does. The
-- only real defence is to re-test a finding on data that did not exist when it
-- was discovered:
--
--   provisional  cleared the family-corrected pooled bar AND held its sign
--                independently in both chronological halves at discovery time.
--                NOT notified: at this stage it is still in-sample.
--   confirmed    has since held up on bars recorded AFTER discovered_at, which
--                is genuine out-of-sample evidence. Notified.
--   decayed      stopped holding. Also notified — a pattern that quietly stops
--                working is more dangerous than one that was never found, and
--                the engine has to be told to stop trusting it.
--
-- tests_in_family records how many hypotheses were tested to surface this one,
-- so the correction applied is auditable after the fact rather than implicit.
CREATE TABLE IF NOT EXISTS research_registry (
  hypothesis TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  asset_class TEXT,
  symbol TEXT,
  horizon_days INTEGER,
  status TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  discovery_n INTEGER NOT NULL,
  discovery_effect REAL NOT NULL,
  discovery_z REAL NOT NULL,
  tests_in_family INTEGER NOT NULL DEFAULT 1,
  oos_n INTEGER NOT NULL DEFAULT 0,
  oos_effect REAL,
  oos_z REAL,
  oos_checks INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  status_changed_at TEXT,
  notified_at TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_research_registry_status ON research_registry(status, family);

-- asset_daily_bars.open
--
-- Added 2026-08-30 so the close-to-open ("overnight") effect is testable at
-- all; the archive previously stored only close/high/low and could see
-- close-to-close alone. Applied directly to the live database, so the ALTER is
-- recorded here as a comment rather than a statement — SQLite has no
-- ADD COLUMN IF NOT EXISTS, and signals-refresh.yml runs `d1 migrations apply`
-- as its FIRST step, so a migration that cannot be re-run takes down the
-- hourly build (learned the hard way in 0003). The column definition lives in
-- scripts/schema.sql for fresh databases. To restore an older database:
--   ALTER TABLE asset_daily_bars ADD COLUMN open REAL;
