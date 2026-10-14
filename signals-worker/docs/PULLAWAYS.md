# Coins pulling away from the market: TRX on 2026-10-14, and how long pull-aways last in bull and bear markets

Asked 2026-10-14: "trx seems to be pulling away from the market today. figure out if there
were any signs we missed so we never miss it again for such assets. go back and look for
assets that pull away, the factors/variables that cause them and how long such pull aways
last depending on whether we are in a bear or bull markets."

This extends [DECOUPLING.md](DECOUPLING.md) (2026-09-28, after HBAR). That study covered what
comes *before* a large coin pulls away and the 24 hours after it. This one covers how long
pull-aways last, which kinds last, and whether the market regime changes that. **Research
only; nothing is deployed.** Scripts and outputs: `docs/research-2026-10-14-pullaways/`.
Data (gitignored): `reports/scenarios/2026-10-14-pullaways/`.

## Short answer

- **TRX today: nothing important was missed.** TRX rose 2.0% while the median large coin fell
  3.5%. That is mostly the market falling around a coin that barely moves with it (TRX's beta
  to the market is 0.07). The hourly decoupling watch nearly fired: TRX passed its relative-
  volume and move-size tests and missed only on its own volume (2.66-2.80x its norm against a
  3x bar). There was no TRX-specific catalyst.
- **Most pull-aways fade, and the fading kind is easy to recognise.** A small coin (under
  $5M a day) that jumps ahead on heavy volume with a big 3-day move is, 30 days later, 11-18%
  behind similar coins in three of the four half x regime cells (t -4.9 to -6.3). Its lead usually
  peaks within about two weeks, often on the day it is first seen.
- **The kind that lasts:** a large coin ($20M+ a day) pulling ahead steadily and moderately.
  In 2023-26 these kept beating other large coins for months, in bull markets (+25% at 90 days,
  t 8.1) and bear markets (+14%, t 3.0). In 2019-22 the sign was the same, but too weak to rely
  on. Read it as true of the current market, not as proven across cycles.
- **Regime matters less than the kind of coin.** Bear markets make the fading kind fade faster
  and further; the 2023-26 bear made the lasting kind last as well. The direction the market
  moved during the pull-away made no consistent difference.
- **Falling behind does not reliably continue.** Against random days in the same regime, coins
  that dropped sharply behind the market did no worse afterwards in 2023-26 (in 2019-22 bull
  markets they did, on 111 cases).

## 1. TRX on 2026-10-14

From the UTC day's open (0.327) to 18:00, TRX was +2.0% (0.334), while the median of the 40
large coins was -3.5%. TRX's hourly volume ran 2-6x its norm from 01:00. The production
decoupling rule, replayed on today's bars with its own code (`trx_replay.mjs`):

| Hour starting (UTC) | TRX volume, 8h vs its norm (needs 3x) | vs the median coin's surge (needs 2x) | TRX vs market, 8h, in its sds (needs 2) | Market, 8h |
|---|---:|---:|---:|---:|
| 05:00 | 1.90x | 4.6x | 2.0 | -0.8% |
| 07:00 | 2.32x | 5.6x | 3.0 | 0.0% |
| **08:00** | **2.66x** | **6.2x** | **3.9** | **-0.9%** |
| 10:00 | 2.80x | 6.0x | 1.9 | -1.3% |
| 13:00 | 2.65x | 3.4x | 2.2 | -2.6% |

- **The miss is the 3x bar.** TRX passed the other two tests and was a little short on that
  one. Lowering the bar is not justified by this one case: the watch is built and scored for
  moves of at least 5% away from the market, and TRX's beta-adjusted move today was about 2%.
- **On the daily definition below, TRX does not qualify either.** It is 10.3% ahead of the
  median large coin over 3 days, but that is only 2.0 of its usual 3-day relative moves (the bar
  is 2.5), because the market keeps swinging around it: -7.7% on 10-12, -3.5% today.
- **News.** Tron Inc. bought 150,002 TRX (about $50k) for its treasury, which is too small to move
  the coin. The other coverage that day was mostly sponsored content.
- **TRX's history is the same pattern.** In 2023-26, 92% of TRX's pull-aways came with the
  market down 5% or more over the same 3 days. Its beta fell from 0.90 (2019-22) to 0.21. TRX
  after its pull-aways (30 days: median +11.1%, 13 cases) did no better than on its ordinary
  days (+11.4%): TRX simply outran a bleeding alt market almost all the time.

## 2. Method

- **Universe.** 685 Binance USDT spot pairs from 2017 (199 since delisted, held at their last
  close), daily. Tokenized stocks, stables and wrapped tokens are dropped. A coin counts on a
  day when its 30-day median volume is at least $1M. Events start in 2019, once 30 such coins
  exist.
- **Market.** The median log return of those coins over *exactly* the window being measured.
  Summing daily medians was tried first and dropped: daily returns are right-skewed, so that
  index drifts down over weeks and makes every coin look like it pulled away.
- **Pull-away (onset).** A coin's 3-day return minus the market's reaches 2.5 of its own usual
  3-day relative moves and at least 5%, ahead or behind. At most one per coin and side in 30
  days. 6,406 events on 548 coins: 4,879 ahead, 1,527 behind.
- **Regime.** BTC above or below its 200-day average at the onset (the CoinMarketCap alt cap
  against its own 200-day average gives the same split).
- **Judged against random days.** Every result is compared with random liquid coin-days in the
  same half, regime and size band. Random days do not average zero relative return, because
  the market is a median and large coins outran it in 2023-26.
- **Split.** 2019-22 and 2023-26 each contain bull and bear stretches; a finding needs both.

## 3. Results

**All pull-aheads, 30 days later** (median relative move in the same direction; share that
kept going; random days in brackets):

| | bull | bear |
|---|---|---|
| 2019-22 | -2.8% (+0.5%), 45% (51%) | -5.7% (0.0%), 39% (50%) |
| 2023-26 | -2.1% (-1.2%), 45% (46%) | -4.2% (-2.1%), 39% (44%) |

When the lead peaks, measured from the start of the move:

| | day 0 | days 1-3 | days 4-14 | days 15-90 |
|---|---:|---:|---:|---:|
| share of all pull-aheads | 15% | 10% | 15% | 59% |

The days 15-90 group includes a minority that keep running hard, plus the ordinary drift of
volatile coins.

**By kind, against random days of coins the same size** (`analysis3.py`):

| kind | half | regime | 30 days | 90 days | kept going at 90d | mean difference, 90d (t) |
|---|---|---|---|---|---|---|
| small (< $5M/day), heavy volume, big move | 2019-22 | bull | -4.3% vs +3.4% | -4.7% vs +1.3% | 45% vs 52% | -2.4% (-0.4) |
| | 2019-22 | bear | -13.0% vs +0.5% | -13.9% vs +1.5% | 33% vs 53% | -11.2% (-3.6) |
| | 2023-26 | bull | -10.2% vs -0.3% | -12.7% vs -1.1% | 33% vs 48% | -11.3% (-4.0) |
| | 2023-26 | bear | -17.3% vs -1.8% | -22.5% vs -5.8% | 27% vs 41% | -20.0% (-4.3) |
| large (≥ $20M/day), steady and moderate | 2019-22 | bull | -0.2% vs -3.3% | +4.2% vs -1.4% | 52% vs 48% | +2.9% (+0.4) |
| | 2019-22 | bear | +3.6% vs -1.6% | +5.4% vs -3.2% | 57% vs 46% | +8.9% (+2.3) |
| | 2023-26 | bull | +6.6% vs -3.7% | +12.3% vs -7.1% | 73% vs 41% | +25.3% (+8.1) |
| | 2023-26 | bear | +5.8% vs -0.1% | +9.2% vs 0.0% | 75% vs 50% | +14.4% (+3.0) |

"Steady" means no single day made more than 70% of the 3-day move. "Moderate" means a 3-day
lead under 19%; both cut-offs are the 2019-22 medians. All large-coin pull-aheads together:
+2.7% and +1.6% at 90 days in 2019-22 (t 0.5, not significant); +16.2% (t 7.1) and +8.9%
(t 2.5) in 2023-26.

**How long the lead lasts.** Share of pull-aheads that have given back half (then all) of the
onset lead by day 3 / 7 / 14 / 30 / 60 / 90:

| kind | regime | half given back | all given back | median day the lead peaked |
|---|---|---|---|---|
| all | bull | 26 / 43 / 54 / 64 / 72 / 75% | 2 / 7 / 17 / 29 / 43 / 50% | 25 |
| all | bear | 27 / 45 / 57 / 68 / 75 / 80% | 2 / 7 / 17 / 31 / 44 / 53% | 26 |
| large, steady, moderate | bull | 18 / 32 / 41 / 48 / 54 / 56% | 1 / 6 / 15 / 24 / 33 / 39% | 51 |
| large, steady, moderate | bear | 15 / 30 / 43 / 51 / 55 / 62% | 1 / 4 / 14 / 23 / 34 / 43% | 48 |
| under $20M/day, heavy volume, big move | bull | 26 / 43 / 54 / 64 / 71 / 74% | 1 / 5 / 11 / 20 / 33 / 41% | 16 |
| under $20M/day, heavy volume, big move | bear | 30 / 51 / 61 / 71 / 79 / 84% | 2 / 7 / 12 / 26 / 40 / 50% | 11 |

**What at the onset predicts lasting** (pull-aheads, top fifth minus bottom fifth; only
results that held in both halves):

- **Bigger 3-day move:** fades more. 30 days: -9% / -19% (t -2.7 / -6.1). In its own sds:
  -11% / -5%.
- **Heavier volume, own and vs the market:** fades more. 7 days: about -5% to -6% in both
  halves (t -3.3 to -4.9). 30 days: -8% / -13% vs the market's surge.
- **Bigger coin:** lasts better. 7 days: +5.9% / +3.3% (t 4.0 / 3.4).
- **No difference:** whether the market rose or fell during the pull-away, the coin's prior
  30- and 90-day trend, distance from its 1-year high, age, how many coins pulled away
  together, BTC's 90-day trend, BTC dominance, and beta.

**Falling behind.** Against random days in the same half and regime, continuation was 51-56%
vs 52-58% in 2023-26 (no edge). In 2019-22 it was stronger in bull markets only (30 days
+5.6% vs -0.5%, 111 cases). Heavier volume on the way down made a continued slide likelier in
both halves; a high-beta coin, or many coins falling behind together, made it less likely.

## 4. What this means

- **For TRX-type coins, the sign is the market, not the coin.** A coin with near-zero beta pulls
  away whenever the market drops. That is mechanical, and it ends when the market stops falling.
- **A pull-away you can see is usually already old.** One in four peaks by day 3. For small
  coins on heavy volume, the typical one has given back half within a week in a bear market.
  This matches the exhaustion results: volume-driven pumps fade.
- **The ones worth watching are large coins grinding ahead without a volume spike.** In 2023-26
  they kept going for weeks to months (the lead typically peaked around day 50), in both bull
  and bear markets. That has not been shown in 2019-22, so it should be logged and scored live
  before anything quotes it as a rule.
- **Not built.** A daily board that labels each current pull-away "the kind that has faded" or
  "the kind that has lasted" would follow directly from section 3. It should run in shadow
  (logged, scored, silent) until its live record agrees, like every other lane here.

## Reproduce

`events.py` (events and controls) → `analysis.py` (durations, factors) → `analysis2.py`
(vs random days, profiles, TRX) → `analysis3.py` (size-matched controls). `trx_replay.mjs`
replays today's hours through the production rule; it needs network access to Binance.
