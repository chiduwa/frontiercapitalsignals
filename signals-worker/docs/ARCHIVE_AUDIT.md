# The crypto archive identity audit

2026-09-28. The cadence study (CADENCE.md, section 8) found production's daily
crypto archive (`asset_daily_bars`) carrying prices that were not the coin the
engine means. Asked to clean it up, the answer is
`scripts/crypto-archive-audit.mjs`: an audit that runs weekly, fixes what is
clearly wrong, and backs up every row it changes.

## What was wrong

The archive held 374 coins in 511,691 daily rows, 87% of them from Yahoo. A
ticker is not a token, and three kinds of wrong price had built up:

- **Another token under the ticker.**
  - SKY: Yahoo's SKY-USD is Skycoin, so SKY (Sky, ex-Maker) held Skycoin's
    prices from 2017 until Binance took over on 2026-09-23.
  - STRK held Strike (about $13) for years, not Starknet (about $2).
  - HOT, ID, APE, TIA and OP carried other tokens for long stretches.
  - JUP before 2024-01-31 is Jupiter Project, not Jupiter.
  - WLD before 2023-07-24 sat at $0.008, some other token, and W before its
    listing likewise.
  - BEAM, DBR and EDGE, which Binance does not list, are other tokens
    outright: Yahoo's BEAM-USD is the old privacy coin, not Merit Circle's
    Beam.
- **Prices rounded to too few decimals.** Yahoo kept SHIB, BONK, FLOKI, PEPE
  and NIGHT at about six decimals before Binance listed them. 1e-6 to 2e-6 is
  a +69% "day" that never happened.
- **Prices rounded to zero.** 2,847 rows had a close of 0: BABYDOGE (1,918),
  BTT (489), SHIB (258), BONK (175), FLOKI (5) and CATI (2).

**Why the existing guards missed them:**

- `bar-quarantine.mjs` looks for 4x spikes that revert and 10x level shifts.
  These prices sit well inside those bars: Skycoin was 4x off Sky, Strike
  6.6x off Starknet.
- The rounding check judged only a series' last 60 closes, and SHIB's rounding
  was in 2020-21.
- Yahoo's identity check accepted any latest close within 10x of the coin's
  current price.
- The rounded stretches that were caught went in as "stale", which consumers
  skip by default.

## What the audit does

**The reference** is the coin's own Binance daily candle: one token per pair,
full precision, a true UTC close.

- Binance counts as the reference only when its latest close is within 1.5x
  of CoinGecko's current price for the universe's coin, the one the engine
  means.
- A ticker on Binance is not proof either: Binance's ONE is Harmony, the
  engine's ONE is Cross. At 2x or more off, Binance is another token and the
  coin is left alone.

**For a coin where Binance is the reference:**

- **Wrong rows are replaced.** Every archived close more than 10% off
  Binance's close for the same day is replaced by Binance's bar (CoinGecko
  rows are compared a day earlier, their convention).
- **Early history is kept only if it was the same token and not rounded.**
  History before Binance's coverage is marked unusable (a level-shift marker
  at the listing, so `cleanBars` starts there) when any of these holds:
  - more than half of the archive's own rows in Binance's first month
    disagree with Binance (it was still carrying another token);
  - the series jumps 3x or more at the listing (the supplier re-pointed the
    ticker then). Listing days really do move 1.5-2x (YFI, ENS, CRV), so
    smaller jumps don't count;
  - the early history is rounded.
- **A redenomination on Binance's side** (SUN swapped 1,000 to 1 in 2021) is
  handled by comparing only after it.

**For a coin not on Binance** whose latest archived close is 2x or more off
the universe's price, CoinGecko's last year for the universe's id is the
reference. If the archive disagrees there too, that year is replaced by
CoinGecko's closes and the older history is marked unusable.

**Every close of zero** is quarantined as a spike.

**Every replaced row is copied first** to `asset_daily_bars_backup` (migration
0056), keyed by the run. The audit's markers carry their own version
(`identity-audit-v1`), so the older detector's runs and this one's cannot
erase each other.

## What it found (first run, 2026-09-28)

| | Coins | Rows |
|---|---:|---:|
| Checked against Binance | 202 | |
| rows off Binance by more than 10%, replaced | 52 | 5,559 |
| early history marked unusable | 16 | |
| Binance lists another token (AI, ONE): left alone | 2 | |
| Not on Binance | 143 | |
| another token outright (BEAM, DBR, EDGE): last year replaced from CoinGecko, older history unusable | 3 | 907 |
| Stablecoins, skipped | 27 | |
| Zero closes quarantined | 6 | 2,847 |

The biggest replacements:

| Coin | Rows replaced |
|---|---:|
| HOT | 1,866 |
| ID | 1,286 |
| STRK | 722 |
| APE | 568 |
| TIA | 496 |
| SKY | 371 |
| OP | 127 |

Most other coins had one to four days where a Yahoo close sat more than 10%
off Binance's: a glitch, or a gap between venues during a crash. BTC on
2017-12-23 is one. Aligning those to Binance, the venue the bots trade on, is
the point.

## So it does not come back

- **Binance first.** The daily backfill (`backfill-history.mjs`) now takes a
  coin's Binance candles first when Binance's latest close is within 1.5x of
  the coin's current price. It fetches only the last 60 days once the coin is
  archived. Yahoo and CoinGecko are the fallbacks.
- **A tighter identity check.** Yahoo's check tightened from 10x to 3x
  (`IDENTITY_MAX_RATIO` in `archive.mjs`). That rejects Skycoin, Strike and
  the old Beam.
- **A weekly audit.** `signals-archive-audit.yml` runs every Sunday at 06:23
  UTC. It tests first, applies, and keeps its report as an artifact for 90
  days.

## What is left

- **Readers that ignore the quarantine** still see the marked early history:
  `archive.mjs`'s daily computations (including the broad market index
  MCAP:BROAD), `market-context`, `market-explanations` and `retrospective`.
  They do get every replaced row. MCAP:BROAD is an equal-weighted average of
  about 370 coins, so one mislabeled coin moves it by about 1/370 of that
  coin's error. Making it quarantine-aware would rewrite its whole history, so
  it was left as it is.
- **AI and ONE** keep their archive as it is: Binance lists other tokens under
  those tickers, and there is no second reference for them.
- **Coins not on Binance** are checked only when their latest price is far off
  the universe's. A wrong token trading near the right one's price would still
  pass.

## Undoing a replacement

```sql
INSERT INTO asset_daily_bars (symbol, asset_class, date, open, close, high, low, volume, source)
SELECT symbol, 'crypto', date, open, close, high, low, volume, source
FROM asset_daily_bars_backup WHERE audit_run = '<run>' AND symbol = '<coin>'
ON CONFLICT (symbol, date) DO UPDATE SET open = excluded.open, close = excluded.close, high = excluded.high,
  low = excluded.low, volume = excluded.volume, source = excluded.source;
DELETE FROM asset_bar_quarantine WHERE detector_version = 'identity-audit-v1' AND symbol = '<coin>';
```

Tests: `test-crypto-archive-audit.mjs` covers each failure mode on synthetic
series shaped like the real ones: SKY, WLD, a real listing-day jump, SHIB,
ONE, SUN, BEAM. `test-archive-sources.mjs` pins the new identity bands.
