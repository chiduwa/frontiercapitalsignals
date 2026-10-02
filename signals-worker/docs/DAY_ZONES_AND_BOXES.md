# Box theory, daily top/bottom alerts, and cheaper notifications

2026-10-02. Asked: "check if the box theory works on the major and always
tracked assets. also, for my always tracked assets, based on the historical
median and forecasted move for the day, can you send me notifications if a
forecasted top/near top or bottom/near bottom for the asset has been detected.
figure out the best time to use as a reference when the median movement gives
the best results from the past and for predictions. optimize notifications and
the system so they are cost efficient without degrading function,
effectiveness, or efficiency"

## Short answer

- **Box theory does not work on these assets as a timing rule.**
  - **Daily Darvas boxes:** they gained nothing reliable on the
    always-tracked coins, nine more major coins, or ten major US
    stocks/ETFs. Where they looked good in 2018-22 they lost in 2023-26.
  - **4-hour bars:** box breakouts beat random entries, but about as much as
    buying any new 20-bar high does.
  - **BTC, ETH and SOL:** nothing in 2023-26.
  - **What trading it is like:** about 42% of trades win, the median trade
    loses about 1.3%, and the best tenth of trades make more than all the
    profit. That is trend following with the box as decoration.
- **A level built from the median daily move is a good forecast of the day's
  range and a poor detector of its top or bottom.**
  - About half of days stay inside it, as a median should.
  - When price reaches it late in the UTC day, the day's high still ended
    clearly higher about 7 times in 10.
  - On average price kept rising into the close: more continuation than a
    random walk of the same size gives.
- **Notifications now go out from 18:00 UTC:** one push per coin per side
  per day, whenever one of the eight tracked coins is at or beyond today's
  forecast top or bottom. Each push quotes what followed in the past and says
  it is not a top or bottom signal. Coins reaching their levels together
  share one push.
- **The best reference time is midnight UTC, the one already in use.** No hour
  beat it significantly. 16:00-20:00 UTC were 1.5-3% better (not
  significant). 08:00 and 14:00 UTC were measurably worse.
- **Cheaper, at the same function:**
  - one D1 query was 53% of every row the database read: 722M rows a day for
    an overlap check that needs only recent rows. It now reads ~2% of that
    and makes exactly the same decisions. That should bring the monthly read
    bill back under the plan's allowance (about $17 a month of overage
    before);
  - the two noisiest alert streams now send one push per run instead of one
    per coin.

## 1. Box theory (Darvas)

**The rule, built causally bar by bar:**
- a new high (the highest of the last `lookback` bars: 52 weeks as Darvas
  used it, or 20 bars as a looser range rule) is a box top once 3 bars fail
  to exceed it;
- the lowest low after it is the box bottom once 3 bars fail to undercut it;
- a close above the top is a breakout (buy), a close below the bottom a
  breakdown (sell);
- traded as Darvas did: buy the breakout, stop at the box bottom, raise the
  stop to each new box's bottom.

**The test** compares those trades, net of costs (0.1% a side for coins,
0.05% for stocks), with the **same exits entered on random bars**. The
question is whether the entry adds anything, not whether trailing stops do.
Periods: coins 2018-22 / 2023-26, stocks 2000-12 / 2013-26
(`results/box_out.txt`).

| assets, bars, boxes | entry edge per trade vs random entries, earlier period | later period |
|---|---|---|
| 8 tracked coins, daily, 52-week | +10.9% (t 1.0, 20 trades) | **-10.0% (t -2.6, 16)** |
| 8 tracked coins, daily, 20-bar | +6.3% (t 1.2, 69) | -1.1% (t -0.4, 75) |
| 9 major coins, daily, 52-week | +31.9% (t 1.6, 26) | -8.8% (t -1.4, 16) |
| 9 major coins, daily, 20-bar | +11.9% (t 1.9, 110) | -2.6% (t -1.3, 111) |
| 10 stocks/ETFs, daily, 52-week | +0.4% (t 0.3, 108) | **-1.9% (t -2.6, 352)** |
| 10 stocks/ETFs, daily, 20-bar | -0.2% (t -0.3, 303) | -0.2% (t -0.4, 558) |
| 8 tracked coins, **4-hour**, 20-bar | +1.3% (t 2.0, 516) | **+2.4% (t 3.1, 596)** |
| 8 tracked coins, 4-hour, new 90-day highs | +3.2% (t 1.6, 86) | +5.3% (t 2.0, 103) |

Requiring breakout volume of 1.5x its average changed nothing systematic.

**The 4-hour result, stress-tested** (`results/box_4h_robust_out.txt`):

- **The momentum control kills most of it.** Against random entries drawn
  only from bars that closed at a new 20-bar high, with the same stops, the
  20-bar box's edge falls to +0.9% (t 1.5) and +1.2% (t 1.5). The box adds
  little to buying strength.
- **It is not every coin.** In 2023-26 the per-coin edge was BTC +0.2%, ETH
  +0.1%, SOL -0.2%, XRP +2.2%, against XLM +6.9% and HBAR +9.3%, the two
  coins with big 2024-25 trends.
- **What trading it is like:**
  - 13 trades a month across the eight coins;
  - 42% win, and the median trade loses 1.3%;
  - the best tenth of trades made 127% of the total.

**Verdict:** no box alert was built. If you trade boxes, use them on 4-hour
bars as a trend-following frame, size for long losing streaks, and expect
nothing on BTC, ETH or SOL.

## 2. Today's forecast top and bottom: what works and what does not

Hourly bars of the eight tracked coins, 2018-2026: Binance spot, and Binance's
perpetual for HYPE (spot listed only 2026-09-24). The day is the 24 hours from
a reference hour. Everything is judged in two periods, 2018-22 and 2023-26.

**The forecast** (`results/daytop_out.txt`, the error of the median against
the day's actual move up and down):

| forecast of the day's move | error vs a plain 60-day median, 2018-22 | 2023-26 |
|---|---|---|
| median of the last 30 / 60 / 90 days | 1.002 / 1.000 / 1.001 | 0.998 / 1.000 / 0.995 |
| 60-day median x (last 24h volatility / usual) ^ 0.5 | **0.968** | **0.972** |
| the same ^ 1 (full adjustment) | 1.000 | 1.003 |
| + a weekday factor | 0.966 | 0.964 |

"Historical median" plus a "forecast for the day" (scaled by how volatile the
last 24 hours were) is about 3% more accurate than the median alone. The live
version leaves out the weekday factor, which needs a year of hourly bars and
added under 1%. The forecast is well calibrated: on 49-51% of days the move
stayed inside each side at every reference hour.

**The reference hour** (`results/daytop_final_out.txt`). Paired against
midnight UTC, coin by coin and day by day:

| reference | difference in error vs 00:00 UTC, 2018-22 | 2023-26 |
|---|---|---|
| 16:00 UTC | -0.016 (t -0.4) | -0.020 (t -0.5) |
| 17:00 UTC | -0.023 (t -0.5) | -0.030 (t -0.7) |
| 19:00 UTC | -0.029 (t -0.6) | -0.002 (t -0.1) |
| 08:00 UTC | **+0.104 (t +3.1)** | +0.038 (t +1.4) |
| 14:00 UTC | **+0.086 (t +2.0)** | +0.031 (t +0.9) |

Midnight UTC is tied for best, and it matches the daily candle everyone
trades on and the day-range read the site already keeps. A day starting at
the London or US open is worse.

**Does reaching the level mark the top?** No, at every reference hour and at
every zone width tested (0.75x, 1x and 1.25x the forecast;
`results/daytop_report_out.txt`). "Near" means the day's extreme ended within
a quarter of a typical move of the alert price.

- **Any time of day:** 20-23% of alerts were near the extreme. Price usually
  went another 0.7-0.8 of a typical move.
- **By hours left in the UTC day** (`results/daytop_timeleft_out.txt`): near
  the extreme 38-44% with under 4 hours left, 12-14% with 16 or more. That is
  geometry (less time left, less room), and it is why pushes start at 18:00.
- **Against a random walk of the same size** (the same hourly moves with
  random signs), the rule as it runs live (`results/daytop_rule_out.txt`):

| at/beyond the level with 6h or less left | near the extreme | further move, median | closed back inside | close vs alert price |
|---|---|---|---|---|
| top, real coins, 2023-26 | 29% | 0.50 typical moves | 22% | **kept rising +25 bp (t 3.9)** |
| top, random walk | 47% | 0.30 | 23% | +0 bp |
| bottom, real coins, 2023-26 | 32% | 0.46 | 25% | +3 bp (t 0.4) |
| bottom, random walk | 47% | 0.30 | 23% | +1 bp |

2018-22 gave the same picture (top: 31% near, +19 bp, t 2.6). A coin at its
forecast top late in the day is on a trend day, and trend days carry on. One
pattern was suggestive: a coin hitting its bottom ALONE bounced in every cell
tested (+20 to +70 bp). It is too thin to rely on (t 0.9-2.6, 80-400 cases a
cell), so it is noted, not used.

## 3. What now notifies you

`scripts/day-zones.mjs` (hourly build) puts each tracked coin's forecast top
and bottom for the UTC day in the payload as `dayZones`. That costs two
public, keyless Binance requests per coin; HYPE uses Hyperliquid's public
candles until Binance spot has 60 days of it. The Worker's 5-minute tick
(`worker.js` `dueDayZoneAlerts`) compares the live price with them.

- From 18:00 UTC, a coin at or beyond its top or bottom is due once per side
  per UTC day.
- Coins due on the same tick go out as one push.
- Each push gives the price, the level, the move from the open, how far past
  cases went further (median and 1 in 4, in that coin's own percent), and the
  odds above, ending "Not a top signal" or "Not a bottom signal".

An example:

```
Forecast top: BTC, ETH · forecast bottom: XLM
BTC $85,805 at or above today's forecast top $85,634 (+1.09% from the 00:00 UTC open). Past cases went a median +0.44% further, 1 in 4 beyond +0.91%.
...
Not a top signal. Reaching the forecast top this late in the UTC day (8 coins, 2023-26), the day's high still ended clearly higher 71% of the time, the coin closed the day back below the level only 22% of the time, and on average it kept rising into the close.
```

Expect about 2 pushes a day. On 2023-26 the rule fired 4.5 alerts a day
across the eight coins, which share pushes: median 2 pushes a day, 3 on one
day in ten, none on 5% of days. That is counted by the hour; the live check
runs every 5 minutes, so coins arriving minutes apart can make it slightly
more. The JavaScript
forecast reproduces the study's Python to 12 decimal places on real BTC and
HBAR bars (`test-day-zones.mjs`).

**Cost:**
- no D1 at all;
- on a tick, no I/O unless a coin is past a level after 18:00, and then one
  KV read;
- on a new alert, one KV write and one push.

## 4. Fewer pushes, same information

Counted on the phone topic, 03:06-14:37 UTC on 2026-10-02: 46 pushes.

| stream | pushes | sender |
|---|---|---|
| "post-move spike/drop detected" | 20 | `scripts/notify.mjs`, hourly build |
| "volume exhaustion" | 20 | `scripts/live-scan.mjs`, hourly |
| everything else | 6 | |

The first two send one push per coin, in bursts: five gaming coins at 08:07,
five movers at 08:15.

**Changed** (`scripts/push-batch.mjs`): a run with several alerts sends one
push.
- One line per coin with its numbers, at the highest priority among them, the
  shared caveat once, and under ntfy's 4,096-byte limit.
- A run with one alert sends exactly what it always did.
- Every coin keeps its own dedup state, its own `notification_log` row with
  its full message, and its own `surge_signal_log.notified` flag.

In the 11.5 hours counted, those two streams sent 40 pushes from 18 runs.
Batched, they would have been 18. The gating of what is worth sending is
untouched. `test-push-batch.mjs` runs the real
notifier against SQLite built from the schema.

## 5. The database bill

`wrangler d1 insights`, 2026-10-02, one day:

- reads were **1.41 billion rows a day** (about 42 billion a month against 25
  billion included, so roughly $17 a month of overage); writes 1.67M a day
  (50M a month, right at the allowance);
- 89% of reads were the `forecast_outcomes` ledger, and one query was 53% on
  its own: `MAX(run_at) ... GROUP BY series` over the whole 2.8M-row table,
  4.48M rows per call, 161 calls a day.

It feeds the one-forecast-per-horizon rule (`selectNonOverlappingForecasts`),
which can only be changed by a forecast later than (the oldest candidate - one
horizon). An earlier one is treated exactly like no prior forecast at all. The
query now stops there, through the index whose leading column is `run_at`:

- 52k rows at 24h and 224k at 168h instead of 2.8M;
- the same 11,555 / 18,921 series on production;
- the same accept/skip decisions on 80 randomized ledgers
  (`test-query-plans.mjs`);
- the test fails if the bound is mutated.

Expected reads: about 0.7 billion a day, under the allowance.

**Left as they are, deliberately:**
- the remaining `forecast_outcomes` aggregates (~0.5B rows a day) recompute
  class statistics over every matured outcome each build. Making them
  incremental would change the reliability core, and after this fix they fit
  inside the allowance;
- `oi_tick` (0.5M writes a day) feeds the live flush executor, which trades
  real money, so it was not touched.

## Reproduce

Scripts, outputs and data fetchers: [research-2026-10-02-day-zones-boxes/](research-2026-10-02-day-zones-boxes/README.md).
