-- Advisory quarantine for corrupt rows in asset_daily_bars.
--
-- Found by the derivatives cost model (docs/DERIVATIVES_EVIDENCE.md §4.5): a
-- portfolio held a broken name at full weight and booked -4103%/period. Every
-- REGRESSION in this engine had been silently absorbing the same rows, because
-- winsorise() clips each cross-section's tails before fitting — which makes
-- corruption invisible to a t-stat while remaining lethal to anything that
-- SELECTS assets: portfolios, backtests, the surge scanner, crash-recovery
-- episode detection, the trading bot.
--
-- ADVISORY, NOT DESTRUCTIVE. No row is deleted from asset_daily_bars. A false
-- positive is undone by deleting a row here, not by re-fetching lost history.
-- Same principle as migration 0012's cross-class ticker quarantine.
--
-- Three reasons, detected by scripts/bar-quarantine.mjs:
--
--   spike        One or two bars wildly off, series reverts. Threshold 4x,
--                CONFIRMED by the reversion itself. 16 in crypto.
--   level-shift  Price jumps and HOLDS: a supplier remapped the ticker to a
--                different asset, or the token was redenominated. Threshold
--                10x, stricter precisely because nothing confirms it. 25 in
--                crypto, 0 in equities.
--   stale        Identical close for 10+ consecutive bars — a dead feed.
--                4349 crypto / 2356 equity bars. Lower severity: these are
--                not WRONG, they are uninformative, and excluding them changes
--                the tradeable universe rather than correcting an error. Left
--                for consumers to weigh; the default helper does not drop them.
--
-- Threshold calibration rests on two real cases rather than on a gap in the
-- data (a sweep found 37/30/25/22/20 flags at 4x/8x/10x/15x/25x — no cliff):
--   * DOGE 2021-01-28 rose 4.43x in a day during the GameStop episode. REAL.
--     A 4x level-shift bar would have erased it.
--   * AAVE 2020-10-03 rose 90.6x on the LEND->AAVE 100:1 redenomination. Not
--     a return anyone earned.
--
-- KNOWN JUDGMENT CALL, recorded so it is not mistaken for a bug: LUNC
-- 2022-05-11..13 is flagged level-shift. That collapse was REAL market
-- history, not a data fault — but the archive also splices pre-collapse LUNA
-- prices onto post-rename LUNC, and a -99.9999% single-step observation is
-- unrepeatable enough to distort any cross-sectional fit that treats it as an
-- ordinary trial. Quarantining the SEAM does not delete the bars; a consumer
-- that genuinely wants the collapse (crash-recovery research is the obvious
-- one) can read asset_daily_bars directly and ignore this table.

CREATE TABLE IF NOT EXISTS asset_bar_quarantine (
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,              -- for level-shift, the FIRST bar of the new
                                   -- regime, so a window starting on it is clean
  reason TEXT NOT NULL CHECK (reason IN ('spike', 'level-shift', 'stale')),
  detail TEXT,                     -- human-readable evidence for the call
  detector_version TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  PRIMARY KEY (asset_class, symbol, date)
);

CREATE INDEX IF NOT EXISTS idx_asset_bar_quarantine_symbol
  ON asset_bar_quarantine(symbol, date);
CREATE INDEX IF NOT EXISTS idx_asset_bar_quarantine_reason
  ON asset_bar_quarantine(reason);
