-- Read-only snapshots of currently open USDⓈ-M positions. These are separate
-- from fills and from the bot's ownership ledger. `bot` requires an exact
-- durable side/quantity match; unmatched positions remain `unknown`, never
-- presumed manual. The latest table is replaced only after a successful read;
-- the snapshot table has no automatic retention deletion.

CREATE TABLE IF NOT EXISTS account_journal_current_positions (
  symbol TEXT NOT NULL,
  position_side TEXT NOT NULL CHECK (position_side IN ('BOTH', 'LONG', 'SHORT')),
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  position_amt REAL NOT NULL CHECK (position_amt <> 0),
  quantity REAL NOT NULL CHECK (quantity > 0),
  entry_price REAL CHECK (entry_price IS NULL OR entry_price > 0),
  break_even_price REAL CHECK (break_even_price IS NULL OR break_even_price > 0),
  mark_price REAL CHECK (mark_price IS NULL OR mark_price > 0),
  unrealized_pnl REAL,
  liquidation_price REAL CHECK (liquidation_price IS NULL OR liquidation_price > 0),
  leverage REAL CHECK (leverage IS NULL OR leverage > 0),
  margin_type TEXT,
  isolated_margin REAL CHECK (isolated_margin IS NULL OR isolated_margin >= 0),
  notional REAL,
  origin TEXT NOT NULL CHECK (origin IN ('bot', 'manual', 'unknown')),
  classification_method TEXT NOT NULL,
  classification_evidence TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (symbol, position_side)
);

CREATE INDEX IF NOT EXISTS idx_account_journal_current_positions_origin
  ON account_journal_current_positions(origin, symbol);

CREATE TABLE IF NOT EXISTS account_journal_position_snapshots (
  observed_at TEXT NOT NULL,
  symbol TEXT NOT NULL,
  position_side TEXT NOT NULL CHECK (position_side IN ('BOTH', 'LONG', 'SHORT')),
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  position_amt REAL NOT NULL CHECK (position_amt <> 0),
  quantity REAL NOT NULL CHECK (quantity > 0),
  entry_price REAL CHECK (entry_price IS NULL OR entry_price > 0),
  break_even_price REAL CHECK (break_even_price IS NULL OR break_even_price > 0),
  mark_price REAL CHECK (mark_price IS NULL OR mark_price > 0),
  unrealized_pnl REAL,
  liquidation_price REAL CHECK (liquidation_price IS NULL OR liquidation_price > 0),
  leverage REAL CHECK (leverage IS NULL OR leverage > 0),
  margin_type TEXT,
  isolated_margin REAL CHECK (isolated_margin IS NULL OR isolated_margin >= 0),
  notional REAL,
  origin TEXT NOT NULL CHECK (origin IN ('bot', 'manual', 'unknown')),
  classification_method TEXT NOT NULL,
  classification_evidence TEXT,
  PRIMARY KEY (observed_at, symbol, position_side)
);

CREATE INDEX IF NOT EXISTS idx_account_journal_position_snapshots_symbol_time
  ON account_journal_position_snapshots(symbol, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_journal_position_snapshots_origin_time
  ON account_journal_position_snapshots(origin, observed_at DESC);
