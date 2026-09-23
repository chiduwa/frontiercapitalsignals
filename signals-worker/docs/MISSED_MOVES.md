# Missed moves: what was missed, what comes before a move, and what now notifies you

Asked 2026-09-24: "how is the learning model handling what the model missed,
especially the ones that were scored and surfaced but still missed? Ensure
that they are studied and the signals are known so I can be notified / reach
the board on time going forward."

## 1. What is being missed

`scripts/retrospective.mjs` logs every coin in the top 300 that moved 12% or
more in 48 hours. For each one it records what the engine said beforehand and
whether volume showed an early tell. From 2026-09-01 to 09-23 it logged 364
such moves across 150 coins:

| Cause | Moves | Early tell present | Mean lead | Mean gain after the tell |
|---|---:|---:|---:|---:|
| Outside the engine's top-100 universe | 178 | 25 | 27 h | 75% |
| In the universe, never ranked onto a board | 124 | 67 | 22 h | 20% |
| **On a board, direction withheld** | 40 | 24 | 18 h | 16% |
| **On a board, wrong side** | 7 | 2 | 50 h | 32% |
| **On a board, late** | 4 | 4 | 50 h | 31% |
| Caught | 6 | 2 | 16 h | 28% |
| Filtered out (floors) | 5 | — | — | — |

"Scored and surfaced but still missed" is the three bold rows: 51 moves. For
most of them the engine withheld direction. It had not proven it could call
direction for that coin, and the study in §3 says it can't.

**The retrospective's learning step never concluded anything.** It tests each
technique's vote against misses in 1,427 cells (technique × coin × regime ×
time of day), and every cell has at most 2 independent dates against a bar
of 20. At that granularity it cannot converge. The study below replaces it
for the question "what comes before a move".

## 2. The alerts you were getting

`scripts/live-scan.mjs` scans about 250 Binance coins hourly and alerts on
three volume patterns. Two of them graduated to notifying because their hit
rate beat 50%. In the September rally, though, **72% of all scanned coins
rose more than 1% over the same windows**, so any "strength ahead" call beat
a coin flip.

Every scored alert (913, 09-01..23) was measured against what all 137 alerted
coins did over its exact hours (Binance hourly closes), with days clustered:

| Alert | Notified | Hit rate | Same-window base rate | Move vs market, called direction | Verdict |
|---|---:|---:|---:|---:|---|
| Quiet accumulation (up, 48 h) | 376 | 74.7% | 72.5% | −1.06% (t = −2.0) | market drift, now **silent** |
| Moderate surge (up, 48 h) | 55 | 61.9% | 71.2% | −0.64% (t = −0.2) | market drift, now **silent** |
| Volume exhaustion (down, 24 h) | 107 | 63.6% | 30.9% | **+4.56% (t = 2.1)** | real, keeps notifying |

Each scored alert now records the same-window market move and base rate
(`marketWindow`, migration 0049). An unproven alert notifies only if it
beats the market in its called direction (day-clustered t ≥ 2, ≥ 30 alerts,
≥ 10 days). A proven one keeps notifying until its live record trails the
market at t ≤ −2 (`surgeNotifyGate`). History was backfilled from Binance
hourly closes over the identical windows.

## 3. What actually comes before a big move

The retrospective only looks at coins that moved, so it can say "a tell
existed" but never "when the tell fires, a move follows". This study uses
**every coin-day**, movers and non-movers, from the daily archive:
330,100 coin-days, 286 coins, 2021-03 to 2026-09. Pegs are dropped;
CoinGecko rows are aligned to their true close; windows with gaps are
skipped.

Event: the close two days later is at least 12% above or below today's close.
Base rate 10.3% of coin-days (up 5.7%, down 4.6%), ranging from 6.6% in 2023
to 19.6% in 2021.

**Precursors.** For each measure, the day's top and bottom 10% of coins are
compared with that day's base rate, for 2021–23 and 2024–26 separately:

| Measure at the close | Top decile | Bottom decile |
|---|---|---|
| 20-day volatility | 2.1× / 2.6× | 0.36× / 0.17× |
| 5-day volatility | 2.1× / 2.6× | 0.52× / 0.28× |
| 10-day high-low range | 2.1× / 2.5× | 0.38× / 0.24× |
| Size of the last day's move | 2.0× / 2.4× | 0.79× / 0.67× |
| 20-day return (either extreme) | 1.9× / 2.2× | 1.3× / 1.4× |
| Volume vs its 20-day median | 1.8× / 1.8× | 1.0× / 1.0× |
| Volume trend (5 vs 20 days) | 1.7× / 1.7× | 1.0× / 1.1× |
| Coin age (youngest decile) | — | 1.4× / 1.9× |
| Dollar volume (top = most liquid) | 0.70× / 0.72× | 1.4× / 1.2× |

Every one holds in both halves. Put plainly: **a coin that is already moving
a lot, on rising volume, is the one about to move a lot again**, and more so
if it is young and thinly traded.

**Combined and walked forward** over nine half-years (LightGBM on those
inputs plus BTC's trend and volatility, market breadth and turbulence;
trained only on outcomes known before each half):

| | Daily top 10 that moved 12%+ in 2 days | Ranking accuracy (AUC) |
|---|---:|---:|
| A typical coin (base rate) | 8.6% | — |
| Highest recent volatility | 26.9% | 0.70 |
| Logistic model | 29.2% | 0.70 |
| **Boosted model (the watch)** | **29.9%** | **0.71** |

The worst half-year was 19.7% against a 7.1% base. In 2026 it is 45–47%.
Replaying the production code over 26 dates in 2026, each trained only on
what was known then, gave 47.0% against 8.2%; it beat the base rate on 25 of
26 dates.

**Direction is not forecastable.** Among flagged coins that did move, 52%
rose. A model for up versus down, among big moves only, scored AUC
0.41–0.68 across half-years (0.5 is chance) and fell below chance in three
of ten. The one direction-bearing signal with evidence is the volume
exhaustion warning (§2), which fires after a coin has already run and
predicts it will lag the market.

## 4. What now notifies you, and where it shows

- **Big-move watch** (`scripts/big-move-watch.py`, daily after the archive
  job, `signals-big-move-watch.yml`). It ranks every archived coin,
  including the 49% of missed movers outside the top 100, and logs the top
  10 in `big_move_watch` before its two days happen. It **pushes one digest
  a day** ("most likely to move 12%+ either way over the next 2 days,
  direction unknown") and heads the Watchlists view as an open panel. Each
  day is later scored against the share of all coins that moved 12%+ on the
  same days. It also reports recall: the share of all 12%+ movers that were
  on the watch the day before. It was proven at discovery (every
  walk-forward half beat the base rate), so it notifies from day one, and is
  demoted if its live record trails the same-day base rate at t ≤ −2 over
  ≥ 30 days.
- **Volume exhaustion warning**, hourly, unchanged: "weakness ahead" on a
  coin that just ran on a volume spike.
- **Quiet accumulation and moderate surge** stay logged and scored, silent
  until they beat the same-window market.

On the first run (as of the 2026-09-21 close), the watch held AIOZ,
MUBARAK, ALCH, AKE, ZETA, NOCK, SN53, STRK, PIEVERSE and SN3. Most had just
moved 20–56% on several times their usual volume. Only STRK was on any of
the engine's boards at the time.

## 5. Limits, stated plainly

- The watch tells you **where the action is likely to be, not which way**.
  Treat it as a list of coins to look at, not a buy or sell signal; pair it
  with the exhaustion warning or the engine's own calls.
- Two days is the horizon studied. Moves slower than that are not what it
  ranks.
- The archive holds coins that exist today (survivors). Relative rankings
  within a day are robust to that; absolute rates are not a promise.
- CoinGecko-only coins lag a day by construction, and a coin that is not in
  the daily archive at all cannot be watched.

Related: [MODEL_TOURNAMENT](MODEL_TOURNAMENT.md) (per-asset models,
forward-promoted), [SEQUENCE_MODELS](SEQUENCE_MODELS.md) (why direction
models fail), `scripts/retrospective.mjs`, `scripts/live-scan.mjs`.
