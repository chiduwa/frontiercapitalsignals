# Binance grid bots: which one, on what, with which settings

2026-09-29. Asked: "Based on these options and research from online and my FCS
signals, give me the best option for spot and futures binance grid bots, the
assets and the settings to use for maximum/most reliable profit." The options
were Binance's bot menus: Spot Grid, Rebalancing Bot, Spot DCA, Spot Algo
Orders; Futures Grid, Position Snowball, Futures DCA, Arbitrage Bot, Futures
TWAP, Futures VP.

Published for readers at
[frontiercapitalsignals.com/research/binance-grid-bots](https://frontiercapitalsignals.com/research/binance-grid-bots)
(`src/app/research/binance-grid-bots/page.tsx`). Every number there comes from
`research-2026-09-29-grid-bots/results/`.

## Short answer

- **No grid has an edge over holding.** A grid is short volatility: its Grid
  Profit is paid for by holding too much of a falling coin and too little of a
  rising one. Under a random walk the two cancel and the fees are left. On real
  prices, all 40 settings trailed holding the launch inventory after fees, in
  both halves of the sample.
- **The least-bad grid is a wide BTC spot grid:** geometric, ±3 sd of 90-day
  vol over 30 days, 1.5% apart. At BTC 83,926 (29 Sep): 58,000 to 121,000, 49
  grids. Median 30-day run +0.4%, worst 10% of runs -9.0% against -18.6% for
  holding BTC. A calmer half-position, not income.
- **The Arbitrage Bot is the one bot with a direction-free return.** Long spot
  BTC, short the perpetual: every 90-day hold started in 2021-2025 made money
  net of fees; 62% in 2026. At September's funding (6.7% to 7.8% a year gross)
  it nets about 4% a year on capital at 2x.
- **Futures grids are a liquidation bet.** Neutral BTC: median 30-day run
  +0.04%, worst -11% unlevered (-55% at 5x). The worst runs were rallies: SOL
  +331% in August 2021 (-54%), XRP +347% in November 2024 (-132%, past the
  whole margin).
- **Execution algos are not strategies.** Spot Algo Orders, Futures TWAP and
  Futures VP only split an order over time.

This agrees with the engine's own evidence: no direction call survives
(`CLASSIC_MODELS.md`, 4,175 tests), move size is predictable (so ranges can be
sized from volatility), and swings look like a random walk (`CADENCE.md`).

## Data

- Daily OHLC 2021-01-01 to 2026-09-22 for BTC ETH SOL XRP XLM HBAR, from the
  sequence study's panel (`research-2026-09-23-sequence/panel.json.gz`).
  Yahoo rows carry no open, so a day opens at the prior close.
- ARB: only the contiguous Binance block, 2023-03-23 to 2025-08-29. Its
  CoinGecko rows track a different price series (0.075 in August 2026 against
  Binance's 0.22 in September).
- HYPE: closes only, so it is left out of the grid tables.
- Binance USDⓈ-M funding for all eight, from `binance-fapi-direct`, as daily
  means of the 8-hour rates.
- BTC hourly, 2026-05-08 to 2026-09-11 (`multi-market-bot/research`), to
  check the daily replay.

## Method

`scripts/gridsim.py` replays Binance's grid: geometric levels, equal USDT per
grid, the grids above the price bought at launch, a buy filling when price
falls through its level and the sell above it filling when price comes back.
A day's path is open, low, high, close on an up day and open, high, low, close
on a down day.

Grids launch every 7 days after 90 days of history and run 30 or 90 days. The
range is ±k times the 90-day daily vol scaled to the horizon (k = 1, 1.5, 2,
3), with 0.6% to 3% between grids: 72,280 runs. Spot pays 0.1% a fill. A
neutral futures grid has the same fills from a flat start (its P&L is the spot
grid's less the launch inventory's), pays 0.02% maker and real funding on the
net position.

The benchmark is holding the launch inventory: the same coins and dollars the
grid started with, left alone. The excess over it is what the grid trading
added.

## Checking the replay (`results/bias.txt`)

Bars hide the swings inside them, and those are round trips a live grid would
take. On synthetic martingale prices, where the fee-free excess is zero:

| step | 15-minute path | daily bars |
|---|---:|---:|
| 0.6% | -0.83% | -1.55% |
| 1.5% | -0.36% | -0.73% |
| 3.0% | -0.14% | -0.20% |

So the replay reads low, most at fine spacing. On BTC's hourly bars against
its daily bars, the daily replay counts 1.05x (3% step) to 2.3x (0.4% step)
fewer round trips, but the excess moves only 0.1 to 0.4 points: what drives
the excess is the inventory, not the round trips.

## Spot grids against holding (`results/replay.txt`)

After fees, pooled over the seven coins. Two lines of the 40:

| setting | 2021-23 | 2024-26 |
|---|---:|---:|
| 30 days, ±3 sd, 1.5% | -1.61% (t -4.7) | -2.39% (t -2.4) |
| 90 days, ±3 sd, 1.5% | -2.84% (t -2.4) | -5.21% (t -2.0) |

Every setting is negative in both halves. Wider ranges lose less; finer
spacing loses more.

## Separating the market from the replay (`results/flipped.txt`)

Each coin gets 16 copies with every day mirrored at random: the same ranges
and volatility, no trend and no mean reversion. Real minus copies, fee-free,
removes the replay's bias:

| setting | 2021-23 | 2024-26 | all |
|---|---:|---:|---:|
| 30 days, ±2 sd, 1.5% | -0.21% | -1.44% | -0.83% (t -1.5) |
| 30 days, ±3 sd, 1.5% | -0.10% | -1.26% | -0.69% (t -1.4) |
| 90 days, ±3 sd, 1.5% | -0.20% | -3.23% | -1.68% (t -1.3) |

Negative in all 18 settings and both halves, not significant, and flat across
spacing: the cost is trend, not chop. No setting found prices bouncing back
more than a random walk, which is the only thing that would pay a grid.

## Outcomes per coin

30-day spot grids, ±3 sd, 1.5% apart, after fees:

| coin | median grid | grid, worst 10% | holding, worst 10% | runs up |
|---|---:|---:|---:|---:|
| BTC | +0.4% | -9.0% | -18.6% | 55% |
| ETH | +0.1% | -10.4% | -22.8% | 50% |
| SOL | +0.5% | -12.0% | -28.8% | 52% |
| XRP | -0.6% | -8.9% | -23.0% | 45% |
| XLM | -0.9% | -8.7% | -23.3% | 43% |
| HBAR | -1.6% | -10.5% | -27.0% | 42% |
| ARB | -0.5% | -12.8% | -29.0% | 49% |

Price stayed inside a ±3 sd range 98% to 100% of the time on every coin (BTC
99.7%). Pump-prone coins do worst: a grid sells out early in a pump and sits
in cash while the coin keeps going.

Neutral futures grids, 30 days, ±3 sd, 1% apart, unlevered:

| coin | median | mean | worst 5% | worst |
|---|---:|---:|---:|---:|
| BTC | +0.04% | -0.79% | -5.0% | -11.1% (Feb 2024, BTC +54%) |
| ETH | -0.14% | -1.18% | -6.8% | -12.9% |
| XRP | +0.08% | -2.32% | -7.5% | -131.6% (Nov 2024, XRP +347%) |
| SOL | -0.34% | -2.69% | -13.7% | -53.5% (Aug 2021, SOL +331%) |

## The bots that don't ride the price path (`results/funding-rebalance.txt`)

**Arbitrage Bot.** 90-day holds, two thirds of capital as notional (2x),
0.3% of notional per round trip:

| coin | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---:|---:|---:|---:|---:|---:|
| BTC | 16.4% | 3.1% | 3.3% | 7.4% | 3.4% | 0.9% |
| ETH | 20.3% | 0.7% | 3.4% | 8.1% | 3.4% | 0.3% |
| SOL | 21.2% | -4.7% | -7.7% | 8.9% | 0.4% | -2.0% |

BTC made money in every hold started in 2021-2025 and 62% of 2026's. To
2026-09-22 its funding ran 7.8% a year (7 days), 7.3% (30), 6.7% (90), with
one negative day in 90. SOL, XRP, XLM, HBAR and ARB had 20 to 32 negative days
in 90 (HYPE 11, ETH 7).

**Rebalancing Bot**, equal-weight BTC ETH SOL XRP:

| period | buy-and-hold | 5% band | 20% band | weekly |
|---|---:|---:|---:|---:|
| 2021-23 | +1456% | +741% | +801% | +714% |
| 2024 to Sep 2026 | +67% | +83% | +88% | +93% |
| last 12 months | -37% | -36% | -37% | -37% |

It sells whatever is leading. That halved 2021-23, when SOL ran away, and paid
in 2024-26, when leadership rotated. The 40-day rotation study
(`CADENCE.md`) is the same effect, still on paper.

**Spot DCA** (Binance's bot averages down and sells at a take-profit) has a
grid's weakness to trends. For accumulating, `spot-bot/` already runs the
tested rule: weekly, dips first, never a week without a buy.

## Settings (`results/settings.txt`)

90-day daily vol to 2026-09-22: BTC 2.24%, ETH 2.90%, SOL 3.12%, BNB 1.77%.
Range = price x exp(±k x vol x sqrt(days)); grids = ln(upper/lower) /
ln(1 + spacing).

| | BTC | ETH |
|---|---|---|
| Spot Grid, 30 days, ±3 sd | 58,000 to 121,000, 49 grids | 1,686 to 4,378, 64 grids |
| Tighter, ±2 sd | 65,670 to 107,300, 33 grids | 1,977 to 3,735, 43 grids |
| Neutral Futures Grid, 1% apart | 58,000 to 121,000, 74 grids, 2x at most | not recommended |

Arbitrage Bot: BTCUSDT, positive carry, 1-2x; enter at a 7-day average
funding of about 0.006% per 8 hours (6.5% a year), exit when it turns
negative. Compare with Simple Earn's USDT rate first.

## Honest limits

- Daily bars. The flipped copies correct the structure comparison; absolute
  grid returns still read a little low, most at fine spacing.
- No slippage model. Grid fills are limit orders, so it is small for BTC and
  ETH, larger on thin coins.
- Not tested: trailing up, arithmetic mode, Position Snowball (Binance's
  description was unreachable from this environment), BNB (no daily bars).
- The arbitrage figures assume the short leg is never liquidated. At 2x a
  rally of about 50% needs margin topped up from the spot leg.
- 2021 to 2026 is two or three regimes, not many.

## Reproduce

```bash
cd signals-worker/docs/research-2026-09-29-grid-bots
pip install numpy pandas
python3 scripts/bias_check.py        > results/bias.txt
python3 scripts/replay.py            > results/replay.txt
python3 scripts/flipped.py           > results/flipped.txt   # ~15 min on 4 cores
python3 scripts/funding_rebalance.py > results/funding-rebalance.txt
python3 scripts/settings.py          > results/settings.txt
```
