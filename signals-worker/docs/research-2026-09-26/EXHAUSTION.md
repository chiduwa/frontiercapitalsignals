# Volume exhaustion: per coin, per size, and across the market

2026-09-26. Asked: "volume exhaustion seems to be a good metric to let me know when to sell. lets try tracking that more accurately for all the assets and market in general if possible."

## Short answer

| Where | What a volume climax has been followed by | Used for |
|---|---|---|
| Smaller coins, hourly | **-2.8% (mid-size) to -5.3% (thin)** against the market over 24h, both halves of the history | Sell warnings (`exhaustion_calibrated`) |
| Large coins (BTC, ETH, SOL, XRP, HBAR, ARB, ~40 more), hourly and daily | Nothing reliable; if anything continuation | No warnings, and the page says why |
| The market as a whole | **More upside**: +2.7% over 3 days, +4.8% over a week after a market-wide volume surge in a rally | Context panel only, never an alert |
| US stocks, daily, 10 years | Nothing that held in both halves (best about -0.8% over 10 days) | No stock warnings |

Volume surges mean different things in thin and deep books. In a thin book a surge is usually a pump that fades. In a deep book it is usually real flow, and real flow tends to continue.

## Data

* Binance global spot, every TRADING USDT pair (478 after excluding stablecoins, wrapped assets, leveraged tokens and non-ASCII tickers), 1-hour klines from 2024-01-01 and daily klines from 2019-01-01, from `data-api.binance.vision` (the public mirror; `api.binance.com` is HTTP 451 from this Mac and the runners). Quote volume, trade count and taker-buy volume per bar.
* 4,578 US stocks, 10 years of daily bars from Nasdaq's public quote API (Yahoo rate-limited the download machine partway through).
* Scripts: `scripts/fetch_klines.py`, `build_events.py`, `analyze.py`, `market_analysis.py`, `daily_analysis.py`. Outputs: `exhaustion-*-output.txt`.

## Method

The project's standard, nothing new:

* Every feature is computed from bars at or before the bar being judged; outcomes are measured from that bar's close.
* The outcome is the coin's return **minus the equal-weight market over the same hours**. A falling market makes every down-call look good; this removes that.
* Day-clustered: prints on one day share one market move, so t-statistics are over days, never over prints.
* **Discovery / validation split by date** (split 2025-05-29). Variants are ranked on the first half only; the second half, which played no part in the choice, is what is quoted.

## The per-coin rule (hourly)

The live rule before this work, `exhaustion20`, needs 20x the 48h median hourly quote volume on an hour that ran 5%+. That can only happen in thin books: it fired on 65 coins in its first 22 days live, almost none of which anyone holds.

The new features measure the bar against **the coin's own last 30 days** (720 hours, windows ending at the previous bar, half a window required):

* `volZ`: log quote volume, z-scored against its own 30-day distribution
* `barZ`: log(close/open) in units of its own hourly volatility
* `run24Z`: the 24h log return to this close, same units (includes the bar itself)

125 variants were tested (volume z 2.5-5, bar z 1.5-4, run z none/1.5/3, with and without a new 7-day high, plus 5 "fading volume at a high" variants). Best by discovery-half t, which also holds in validation:

**volZ >= 3, barZ >= 3, run24Z >= 1.5, rising bar**

| Horizon | Excess vs market | t (day-clustered) | Halves | Coin fell |
|---|---|---|---|---|
| 4h | -1.76% | -15.6 | -1.54 / -1.96 | 66% |
| 24h | -3.21% | -12.3 | -3.10 / -3.32 | 71% |
| 72h | -3.67% | -10.3 | -3.23 / -4.08 | 72% |
| 168h | -4.22% | -8.8 | -3.11 / -5.28 | 72% |

By liquidity tier (symbol's median hourly quote volume; major = top 10%, above ~$408K/h; thin = bottom 40%, under ~$33K/h):

| Tier | 24h excess | t | 72h excess |
|---|---|---|---|
| thin (185 coins) | -5.32% | -16.7 | -6.54% |
| mid (231) | -2.82% | -8.4 | -3.02% |
| major (47) | -0.27% | -0.5 | +0.59% |

A separate majors-only sweep found **no** variant passing both halves. So the live rule excludes coins whose 30-day median hourly quote volume is $400K or more (`maxLiquidity30d`).

**Volume is what carries it.** Big green hours on quiet volume (volZ < 1): -0.18% at 24h, not significant. The same size of hour on loud volume (volZ >= 3): -2.4%.

**Fading volume at a high does not work** (price at a 7-day high after a run, last 24h volume at 50-90% of the 30-day average): -0.3% to -0.4%, not significant, halves disagree.

### How it overlaps the 20x rule (per day, non-major coins)

| | Per day | 24h excess | Coin fell (24h) |
|---|---|---|---|
| Both rules fire | 5.3 | **-4.62%** | 76% |
| Per-coin rule only | 6.7 | -2.60% (t -9.3, halves -2.60/-2.60) | 68% |
| 20x rule only | 2.4 | -2.56% | 70% |

When both fire, the coin itself fell over the next day 76% of the time (median -7.35%), but **66% of the time it first went higher** (median +7.9% above the print's close). There is usually time to sell into strength rather than at the print.

Each alert quotes exactly its own case (`EXHAUSTION_EVIDENCE.byCase`); every cell held in both halves:

| Case | Size | n | 24h vs market | t | Coin fell | First went higher (median) |
|---|---|---|---|---|---|---|
| both rules | thin | 2,288 | -6.65% | -15.0 | 80% | 63% (+7.6%) |
| both rules | mid | 2,857 | -3.91% | -8.2 | 73% | 67% (+8.3%) |
| per-coin only | thin | 2,052 | -3.50% | -7.8 | 75% | 72% (+5.8%) |
| per-coin only | mid | 4,415 | -1.95% | -5.6 | 65% | 80% (+6.8%) |
| 20x only | thin | 938 | -2.86% | -5.1 | 74% | 63% (+5.4%) |
| 20x only | mid | 1,208 | -2.71% | -6.1 | 70% | 70% (+6.3%) |

A 20x print on one of the most liquid coins (rare, about one every five days) is sent as a caution, with the text saying the evidence for large coins is not there.

### Favorites and holdings under the rule (hourly, full history)

BTC -1.07% (n 22), ETH -0.19% (24), SOL +0.91% (26), XRP +1.36% (49), HBAR -2.10% (36), ARB -0.52% (35), XLM +0.74% (57), WLFI -5.60% (8). All but XLM and WLFI were in the major tier over the sample. Individually noisy; the tier result is the reliable one.

## Daily bars

Crypto (`volZ` against 90 days, daily move and 5-day run in daily-volatility units): the best variant (volZ >= 4, barZ >= 1.5, run5Z >= 2.5) is **-11.5% over 10 days on thin coins** (t -10.6, halves -13.6/-10.7), mixed on mid-size, and **+8% on majors** (halves disagree). US stocks: 0 of the variants passed both halves; the best was about -0.8% against the market over 10 days and faded in the recent half.

## The market as a whole

From the hourly panel, once per day (00:00 UTC): breadth (share of coins with a print in the trailing 24h), aggregate quote volume z-scored against its own 30 days, and the equal-weight market's 72h run in its own hourly volatility.

* Breadth: median 3.1% of coins, p90 8.9%, p97 15.7%. High breadth did **not** precede market declines (72h: +1.1%, halves +2.4/-0.0; not reliable either way).
* Aggregate volume z >= 1.5 while the market's 72h run z >= 1.5 (30 days in 2.7 years): market **+2.74% over 72h** (t 2.3, halves +4.3/+0.7), **+4.83% over a week**; BTC +2.45% / +5.08%. Continuation, not a top.

So the market panel says what is happening and what has historically followed, and never calls a top.

## What was built

* `worker.js`: `calibratedSurge` / `surgeFeatures` (verified to 6 decimals against the Python), new `SURGE_CONFIGS` entry `exhaustion_calibrated` (proven at discovery), live-scan dispatch aligned to the clock (first 5-minute tick after the hour).
* `scripts/exhaustion-gauge.mjs`: recent prints, per-coin readings, the market gauge (verified against the Python), plain-language state, the alert body (anchored per the percentage-reporting rule).
* `scripts/live-scan.mjs`: all ~480 pairs, 1,000 bars each, logs calibrated features with every cast, writes `market_exhaustion_log`, alerts: 20x rule unchanged; per-coin rule for favorites/holdings (spot-bot fills) and for volZ >= 4 prints the 20x rule did not already cover (about 1.6 a day); one push per coin per hour.
* `scripts/exhaustion-io.mjs` and the dashboard's **Sell pressure** view.

## Honest limits

* 2.7 years of hourly data covers one bull, one drawdown and one recovery; the split is by date, so each half is a different regime, which is the point, but it is still only two.
* Tier boundaries were set from the sample's liquidity distribution; production uses the coin's current 30-day liquidity, so a coin can change tier.
* The live record (`surge_config_status`) is the judge from here: the per-coin rule is demoted automatically if its forward record trails the market (day-clustered t <= -2).
