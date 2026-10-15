# Moving averages for Bitcoin and the total crypto market cap

Asked 2026-10-14: "can you calculate (on going) and display the moving average (and where
its heading to) as well as other relevant predictive metrics for btc and the entire crypto
marketcap on the page".

**On the page:** Overview → "Moving averages · Bitcoin and the total crypto market",
rebuilt every hour. Code: `scripts/market-trend.mjs` (built into the payload by
`build-signals.mjs`), the card in `worker.js` (`renderMarketTrend`). Tests:
`test-market-trend.mjs`, plus rendered checks in `test-dashboard.mjs`. Research:
`docs/research-2026-10-14-moving-averages/`.

## What the card shows, per series

- **The averages.** The 20-, 50-, 100- and 200-day averages and the 200-week (1,400-day)
  average, on daily closes. Today's live value counts as today's close, the way charting
  sites draw them. Each row shows where price sits against the average and how much the
  average moved over the last 20 days.
- **Where each average is heading.** The closes about to leave each average are already
  known, so its path is exact if price holds:
  - its level 30 days from now if price stays where it is;
  - a likely band for that level if price moves within its usual 30-day range;
  - the price that makes it rise tomorrow (the close leaving its window);
  - how many of the next 30 days it rises if price holds.
- **The 50/200 cross.** Which side the 50-day is on, since when, how far apart the two are,
  and the day they would meet if price holds (or that they don't within 120 days).
- **Likely range, 7 and 30 days.** From recent volatility (EWMA, λ 0.94), widened so the
  bands held about 68% and 95% of 2019-26 moves. This is a size forecast, not a direction.
  The page also shows 30-day volatility and its rank within the last year.
- **Against the 200-day average** (the Mayer multiple), with what followed days in the same
  band in each period.
- **Total market only:** BTC dominance and its 30-day change, and total 24h volume
  against its 30-day median. The quiet read comes from
  [TOTAL_VOLUME_AND_CMC20.md](TOTAL_VOLUME_AND_CMC20.md): in the bottom fifth of the month,
  a big next-day BTC move came about half as often (4.4% vs 8.2%), direction a coin flip.
- **Do these trend signals predict?** Each signal's current state, with the median 90-day
  change that followed it in each period.

## What the trend signals have predicted

BTC daily from 2011 and total market cap from 2013. Median change over the next 90 days
for days in each state; the t-statistic is overlap-aware (Newey-West).

| Signal | BTC 2011-18 (state vs other) | BTC 2019-26 | Total 2013-18 | Total 2019-26 |
|---|---|---|---|---|
| Price above the 200-day | +35% vs -11% (t 3.8) | +7% vs +10% (t 0.2) | +29% vs -14% (t 2.8) | +4% vs +9% (t 0.2) |
| 50-day above 200-day | +35% vs -10% (t 3.9) | +6% vs +14% (t -0.1) | +30% vs -16% (t 3.2) | +1% vs +14% (t -0.1) |
| 200-day rising | +32% vs -9% (t 3.6) | +9% vs 0% (t 0.4) | +29% vs -15% (t 3.0) | +4% vs +8% (t 0.1) |
| Full bullish stack | +57% vs +1% (t 3.5) | +9% vs +7% (t 0.6) | +42% vs -5% (t 3.0) | +3% vs +6% (t 0.6) |

**Until 2018 every trend signal separated the next three months strongly; since 2019 none
has.** The card shows them as a description of the trend, with both periods beside each.

How far price sits above the 200-day average points different ways in the two periods.
At 1.5-2.0x, BTC's next 180 days had a median of +191% (93% up) in 2011-18, but -6% (40%
up) in 2019-26. It is shown as context only.

The 7-day volatility band held 72% of 2019-26 moves inside ±1 sd (68% expected); the
30-day band held 64%. The card's bands use the multipliers that make them hold 68% and
95%: BTC 0.90 / 2.54 (7 days) and 1.10 / 2.84 (30 days), total market cap 0.93 / 2.39
and 1.12 / 2.78.

## Sources and failure handling

- **BTC:** Binance BTCUSDT daily klines, about 2,000 days in two requests. The last bar is
  today's, so its close is the live price.
- **Total market cap, dominance and volume:** CoinMarketCap's keyless `data-api` global
  metrics, 1,500 days in one request, plus `latest` for today. CMC stamps each daily value
  at about 02:30 UTC the next day, so it is filed under the day it covers. Only CMC volume
  from 2022-01-10 on is used: CMC changed its method that week.
- **If a source fails,** that series keeps the previous hour's block and the card marks it
  "LAST HOUR · SOURCE DOWN". With no previous block it shows "Unavailable this hour" and
  no number.
- **"High"** is the highest value in the history fetched: about 5.5 years for BTC and 4 years
  for the total. Both all-time highs (6 Oct 2025) fall inside those windows.
