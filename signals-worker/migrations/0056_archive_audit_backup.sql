-- The crypto archive identity audit (scripts/crypto-archive-audit.mjs) replaces
-- archived daily closes that disagree with the coin's own reference (Binance's
-- candle, or CoinGecko's for a coin Binance does not list). Every row it
-- replaces is copied here first, keyed by the run, so any replacement can be
-- undone with one INSERT ... SELECT. Found 2026-09-28: another token under the
-- ticker (Yahoo's SKY-USD is Skycoin, STRK was Strike), prices rounded to six
-- decimals or to zero. docs/ARCHIVE_AUDIT.md has the details.
CREATE TABLE IF NOT EXISTS asset_daily_bars_backup (
  audit_run TEXT NOT NULL,            -- '<audit version>|<run timestamp>'
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL,
  close REAL,
  high REAL,
  low REAL,
  volume REAL,
  source TEXT,
  PRIMARY KEY (audit_run, symbol, date)
);
