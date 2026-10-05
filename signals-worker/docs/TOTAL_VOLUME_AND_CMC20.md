# Low total volume, CMC20, and the Cloudflare bill

2026-10-04. Asked: "for the signals model on FCS, investigate how low total
volume (usually below 60 billion usd over 24 hours i think) affects the market.
the market seems to be quiet then swings one way suddenly. i think coin
marketcap more accurate info on the total volume (or whereever you get the most
accurate). the also have an index, CMC20, see if that can be used as a variable
to help in finding trends and predictions. also, try to find cost savings. you
can purge certain cryptos (ones that cannot be traded on binance global) if that
will lower our CF bill."

Scripts and every output: [`research-2026-10-04-volume-cmc20/`](research-2026-10-04-volume-cmc20/).

## Short answer

- **Low total volume is followed by a calmer market, not a sudden swing.**
  - **Daily:** when total volume is in its bottom fifth for the past month, the
    chance of a big next-day move (more than twice the usual size) roughly
    halves: 4.4% vs 8.2% for BTC, with the same picture for the whole market,
    ETH and SOL. This holds after allowing for how volatile the last week was
    and for the weekday, and in both 2022-23 and 2024-26.
  - **Quiet spells:** the longer they last, the rarer a big move gets. After
    3+ quiet days in a row the rate is 0-2.4%, against 8.5% on other days.
    Nothing builds up.
  - **Intraday:** after the quietest fifth of 4-hour stretches, a big move in
    the next 4 hours happens 7% of the time, against 17% otherwise (BTC; ETH
    7% vs 16%, SOL 7% vs 14%).
  - **Big moves come out of busy days.** 23% of big-move days followed a quiet
    day, while 35% of all days do.
- **Direction is a coin flip.** After a quiet day the next 3 days go with the
  prior week's trend 45-48% of the time, and the 26-27 big moves that did come
  straight out of a quiet day split about evenly up and down.
- **The $60B line is mostly a weekend line.** In 2026, 47 of the 58 readings
  below $60B came on a Saturday, Sunday or Monday morning, so they measured
  Friday, Saturday or Sunday trading. The pattern you
  have noticed is real, but it is a calendar effect: Monday is the most
  volatile day of the week (big moves 12% of Mondays, against 8-9% on other
  weekdays and 1% on Saturdays). Within Mondays, though, the quieter the
  weekend was, the calmer the Monday: 8% after the quieter half of Sundays,
  16% after the busier half.
- **The apparent "low volume, then the price rises" effect is 2023.** 82% of
  2023's days were below $60B, and 2023 was a recovery year. With each year's
  own drift taken out, the effect is not significant (t = 1.5).
- **Where the figure comes from matters less than you might think.** CMC's
  headline total ($41.5B today) and CoinGecko's ($46.0B) agree. CMC also
  publishes a "reported" total ($253B today) that counts the wash-traded venues
  it otherwise discounts. CMC's headline series changed method in the week of
  2022-01-09 (it was 89% of reported in 2019-20 and is ~18% now), so only
  2022-onward values compare with today's, and a fixed dollar line drifts as
  the market grows: 82% of 2023's days were below $60B, 4% of 2025's.
- **Total volume does not earn a place in the model.** It does sharpen BTC's
  next-day move-size forecast out of sample (3% better than GARCH+weekday,
  t = -2.6), but BTC's own volume does better (4.1%, t = -3.5) and total volume
  adds nothing on top of it. The day-zone band already widens on each coin's
  own volume (`DAY_ZONE_EVIDENCE`, `worker.js`).
- **CMC20 is BTC and ETH.** Its daily moves correlate 0.98 with BTC, and BTC
  and ETH together explain 98.9% of them. Its trend signals (7/30-day momentum,
  20/50-day averages, the non-BTC part, large-caps vs CMC100) predict nothing
  for the index or for nine tracked coins: 0 of 196 tests survive. The best
  single result is t = 1.93, and the BTC version of each signal does exactly
  as well. Not added.
- **Cost:** the overage is D1 row writes, about 75M in September against 50M
  included ($1 per million over). Three writers that rewrote rows nothing read
  are fixed, and 112 coins Binance does not list were dropped and their 457k
  history rows purged (backed up first). First full hour after the change:
  43k rows written, against 62-76k an hour before. With stock votes back during
  US market hours that projects to about 1.2-1.4M a day (~37-42M a month)
  against 1.9-2.1M before, under the allowance again. Section 4.

## 1. Data

| series | source | depth | note |
| --- | --- | --- | --- |
| Total crypto volume, 24h, daily | CMC `data-api/v3/global-metrics/quotes/historical` (keyless) | 2013-04-29 | value stamped D 00:00 covers day D-1: Sunday and Monday stamps are lowest |
| Same, hourly | same endpoint, `interval=1h` | 2019-01-01, 68,010 hours | rolling 24h at each hour |
| CMC20, CMC100 daily | CMC `public-api/v3/index/cmc20-historical` (keyless, 10 days per call) | 2024-01-01 (CMC20's first print) | value at D 00:00 = close of D-1 (corr 0.98 with BTC's D-1 move) |
| Prices | Binance `data-api.binance.vision` klines, daily and hourly | 2017-08 (BTC) | open 00:00 UTC |

Studied from 2022-01-10, after CMC's volume-method change. One glitch day
(adjusted volume more than 3x off its own fortnight) was blanked.

"Relative volume" is the day's total against its median over the previous 30
days. "Quiet" cut-offs (bottom fifth or third) are set on trailing data only.
Inference is Newey-West with lags of horizon + 5.

## 2. What follows low volume

Next-day effect of relative volume, after recent volatility, yesterday's move
and weekday (t; positive = more volume, bigger next move):

| | market | BTC | ETH | SOL |
| --- | --- | --- | --- | --- |
| big move tomorrow | +3.44 | +3.23 | +3.68 | +3.41 |
| size of tomorrow's move | +3.40 | +3.53 | +3.35 | +1.82 |
| largest swing within 3 days | +2.49 | +1.81 | +2.15 | +2.49 |
| tomorrow's direction | +1.44 | +1.11 | +0.50 | +1.03 |

Split in halves (2022-23 / 2024-26) the big-move t is +2.5/+2.5 for the
market and +2.5/+2.1 for BTC.

Quiet streaks (bottom third, consecutive days), market:

| quiet days in a row | days | big-move rate | swing over 7 days vs usual |
| --- | --- | --- | --- |
| 0 | 1,162 | 8.5% | 0.88 |
| 1 | 226 | 4.9% | 0.85 |
| 2 | 155 | 8.4% | 0.80 |
| 3-4 | 100 | 1.0% | 0.65 |
| 5+ | 84 | 2.4% | 0.71 |

Weekday (move of the day named; the volume read at its start covers the day
before), market: Monday 12.1% big moves, Tuesday-Friday 7.7-9.3%, Saturday
1.6%, Sunday 3.7%.

Intraday, non-overlapping 4-hour blocks: last-4h BTC volume against the same
clock hours over 30 days predicts the next 4 hours' size at t = +3.5 (BTC),
+3.3 (ETH), +1.4 (SOL), direction at most t = 2.0 (SOL, not significant across
the 12 tests). Total 24h volume adds little intraday (t up to +2.5).

## 3. CMC20

Each signal was tested in its CMC20 form and its plain-BTC form, on next-day
and next-7-day returns of CMC20, BTC, ETH, SOL, XRP, XLM, HBAR, ARB, DOGE and
ADA (HYPE has only 11 days of Binance spot). Holm across all tests, both halves
required to agree.

- 0 of 196 survive; mean |t| 0.53 for both the CMC20 and BTC forms.
- Breadth (CMC100's 7-day return minus CMC20's) predicts nothing either: 20
  tests, best |t| 1.51.
- The non-BTC part of yesterday's CMC20 move (the large-cap alts) does not lead
  any alt.
- This matches the earlier settled result that a BTC 10-week-average regime
  gate adds no return: an index that is two-thirds BTC behaves the same.

## 4. Cost

Cloudflare bills the Workers Paid plan $5 plus D1 usage beyond 25B rows read,
50M rows written and 5GB a month. Workers requests and KV were far inside their
allowances; the overage was D1 writes, and an index update counts as a written
row. Daily usage is in `results/d1_daily_usage_2026-09-06_to_10-04.json`.

| month | rows written | rows read | over allowance |
| --- | --- | --- | --- |
| September (09-06 to 09-30 measured, 09-01 to 09-05 estimated) | ~75M | ~18B | ~25M writes |
| October pace before the fix | ~60M | ~28B | ~10M writes, ~3B reads |

The heaviest writers over the 24 hours before the fix
(`results/d1_insights_writes_24h_2026-10-04.json`), and what changed:

| writer | billed writes/day | change |
| --- | --- | --- |
| `technique_votes` insert, evaluated flags, retention delete | ~713k | stock rows only while a US quote can move (below) |
| `oi_tick` insert + retention delete (Oracle OI sampler) | ~488k | one tick per symbol per minute, every tick around a move |
| `technique_reliability` nightly rollup (`replay-history.mjs`) | ~296k | UPSERT that writes only a changed row |
| `time_of_day_stats` live upsert | ~116k | stock zero-moves while the market is shut skipped |

- **OI sampler.** Detection runs on the in-memory 20-second history; D1 needs
  the next firing's seed, the 30-minute scoring of an event, the
  market-explanation panel and the audits. A symbol that moves half the
  trigger (2%) is stored at full resolution for the next 35 minutes, so a real
  flush keeps its path. `test-flush.mjs` simulates an hour: a third of the
  ticks stored, every tick of the flushing symbol from the excursion on. Live on the Oracle host from the 22:37 UTC auto-update:
  `done: 585 samples (163 stored)` on the first quiet firing.
- **Stock session.** Stocks were ~61% of each build's vote rows, and 72% of
  stock vote rows were cast outside weekdays
  13:00-21:59 UTC (which covers the 13:30-20:00 summer and 14:30-21:00 winter
  sessions and the first build after the close). There the quote is the last
  close, so each hourly row repeated the one before, and a weekend cast was
  scored on a window with no move. Votes and ranges for stocks are now written
  inside that window only; stock prices are still logged every hour, so a
  Friday cast matures on Saturday's (closing) price. Live: the Sunday 22:35 UTC
  build wrote 1,595 crypto votes, 0 stock votes and all 290 stock prices.
- **Rollups.** A REPLACE is a delete plus an insert plus the index, for every
  one of ~21k rows, every night. The UPSERT gives identical figures and an
  unchanged re-run writes nothing (`test-query-plans.mjs`).
- **Coins Binance does not list.** 115 symbols in the archive had no Binance
  spot USDT pair and no USD-M perpetual. Matching them to Binance by CoinGecko
  coin id found three that do trade under another ticker (BEAM as BEAMX, RON as
  RONIN, BTT as BTTC); they stay. The other 112 (exchange tokens such as OKB,
  CRO, KCS, HTX, GT, BGB, MX and WBT, tokenized stocks, Bittensor subnets,
  pegged coins) are no longer admitted by the hourly build or archived by the
  nightly backfill. Perp-only coins (XMR, KAS, FARTCOIN...) and favorites stay.
  The perp listing is read from `www.binance.com/fapi/v1/exchangeInfo`
  (`fapi.binance.com` is HTTP 451 from US addresses), confirmed reachable from
  the GitHub runners: the first build after the change reported
  `binance_perps: true` and no purged coin in the payload. If either listing
  fails, nothing is dropped that run.
- **Purge.** 456,927 rows across 20 per-coin tables, led by `forecast_outcomes`
  (214,963), `asset_daily_bars` (102,243) and `technique_votes` (80,098), each
  batch written to a local backup before it was deleted:
  `~/Documents/ship/fcs-purge-backup-2026-10-04T22-47-06-206Z.ndjson.gz`. Not
  touched: the stable-value lane, tournament ledgers, retrospective and
  crash-recovery studies, cross-sectional casts, research snapshots and
  `asset_daily_bars_backup`.
- **BABYDOGE and MOG** trade as `1MBABYDOGEUSDT` and `1000000MOGUSDT`; the
  derivatives archive had recorded them `unavailable` under their bare
  tickers. Mapped, and their backfill state reset to `pending`.

Not changed, and why: the crypto technique votes stay hourly, because the
reversal alerts, call flips and the retrospective's lead-lag inputs read them
by the hour.

## 5. Not built

No total-volume or CMC20 feature was added to any model, alert or bot: neither
beat what is already there. A volume context line on the page ("total volume is
X% below its month; next-day big-move odds have historically been about half")
would be accurate but is descriptive, so it was left for the owner to ask for.
