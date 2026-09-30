-- oi_tick: same columns, same primary key, same rows -- stored WITHOUT ROWID.
--
-- As a rowid table with a composite PRIMARY KEY, every tick lived in three
-- b-trees: the table, SQLite's hidden sqlite_autoindex on (symbol, ts), and
-- idx_oi_tick_ts. D1 bills a written row per b-tree, so each of the ~162k
-- ticks a day cost 3 writes. WITHOUT ROWID stores the table in its primary
-- key, so it is 2: measured on production D1 2026-09-30, 10 rows = 30 written
-- rows as a rowid table, 20 without. About 4.9M billed writes a month.
--
-- Nothing a reader sees changes. No code reads rowid, and every oi_tick query
-- either orders by (symbol, ts) / by ts within one symbol -- a unique key, so
-- its output is fully determined -- or aggregates with MAX; there are no views,
-- triggers or foreign keys on the table (checked in sqlite_master). The copy
-- is exact (count and per-column sums identical on a 200k-row rehearsal), and
-- idx_oi_tick_ts is recreated under the same name, which the OI sampler's
-- INDEXED BY hint requires.
--
-- Rehearsed on a scratch D1 database: 200k rows in 785 ms, so ~5 s for the
-- ~1.16M rows retained here, well inside the 30 s the Oracle clients wait. A
-- D1 migration is one transaction (a deliberately failing rehearsal rolled the
-- rename back), so a failure cannot leave the sampler without its table.
ALTER TABLE oi_tick RENAME TO oi_tick_rowid;

CREATE TABLE oi_tick (
  symbol TEXT NOT NULL,
  ts INTEGER NOT NULL,              -- exchange timestamp, ms epoch
  oi_contracts REAL,
  oi_usd REAL,
  mark_price REAL,
  PRIMARY KEY (symbol, ts)
) WITHOUT ROWID;

INSERT INTO oi_tick (symbol, ts, oi_contracts, oi_usd, mark_price)
  SELECT symbol, ts, oi_contracts, oi_usd, mark_price FROM oi_tick_rowid ORDER BY symbol, ts;

-- Drops the old idx_oi_tick_ts with it, freeing the name for the new table.
DROP TABLE oi_tick_rowid;

CREATE INDEX idx_oi_tick_ts ON oi_tick(ts);
