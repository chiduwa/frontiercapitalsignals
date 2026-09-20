-- Separate mean settlement rates from realized daily carry. The legacy table
-- also contains vendor snapshots, so summing those rows is not meaningful.
CREATE TABLE IF NOT EXISTS funding_settlement_daily (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  rate_sum REAL NOT NULL,
  rate_mean REAL NOT NULL,
  settlements INTEGER NOT NULL CHECK(settlements > 0),
  first_time INTEGER NOT NULL,
  last_time INTEGER NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY(symbol,date)
);
