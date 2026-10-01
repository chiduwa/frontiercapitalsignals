# Exhaustion warnings through a squeeze: MOVR, QNT, and what changed

2026-10-01. Asked: "movr kept giving alert of volume exhaustion but the coin kept going up. investigate what happened and why our signal was reversed ... if the findings from its history, similar coins, etc can be applied." Then: "go ahead ... choosing the best options for accurate, precise, reliable, and timely forecasts ... dont overpay for cloudflare and other usage subscriptions."

## Short answer

* **MOVR was an outlier squeeze, not a reversed signal.** A scheduled catalyst (Moonriver's token migration, claim deadline 2026-09-30) put a ~$20M coin through about 6x its market cap in a day. Its first two prints (+54% and +63% against the market over 24h) are in the top 1.3-1.7% of 14,871 historical prints. Before this week the rule had fired on MOVR 50 times, mostly correctly; all 6 prints in its April 2026 blow-off were right (-16% to -42%).
* **Small market cap and high turnover do not flip the signal. They widen both tails.** As turnover rises, the median fade deepens (-2.9% to -11.6%) and the share that rips 20%+ past the market rises (3.9% to 17.8%). Rips are only weakly predictable (validation AUC 0.62), and the riskiest decile also has the deepest median fade (-12%).
* **The genuine weak spot is a large coin that trades thin on Binance.** The rule judged size by Binance volume only. QNT (~$1B, ~$26K/h on Binance) took 14 live casts at +39%. Above $500M the warning had no consistent edge in both halves.
* **Repeat prints in a run are MORE accurate, not less.** Pushing every print beat every cooldown and one-per-episode policy in both halves. Later prints carry more rip risk, and the alert now says so instead of going quiet.
* **The live judge was one squeeze away from demoting a rule that never once trailed the market over a 10-day window in 2.7 years.** It now counts each cast at most +/-20%.

## Data and method

456 coins with a Binance USDT perpetual, delisted ones included: 1h spot, perp and funding from the 2026-09-29 archive (Jan 2024 - Aug 2026), plus September spot from `data-api.binance.vision`. Features are recomputed as live does (`calibratedSurge`). They match production to 6 decimals on all 10 MOVR prints of 09-29..10-01. Outcomes are 24h excess over the equal-weight market, t statistics are clustered by day, and the date split is 2025-05-29 (A = discovery, B = validation). Thresholds are chosen on A and quoted on B.

Market cap: CoinGecko current circulating supply x Binance price. Checked against CoinGecko's real daily caps (keyless history is limited to 365 days), the median ratio is 1.23. Tokens Binance lists per 1000/1M are rescaled. `features-output.txt` predates that rescale (124 prints); the fixed tables below are the ones to quote, and the conclusions did not change.

## Findings

Feature buckets (`features-output.txt`, all prints, 24h excess):

| Turnover (24h Binance vol / mcap) | n | mean | median | ripped >20% |
|---|---|---|---|---|
| < 0.05 | 4,754 | -1.85% | -2.86% | 3.9% |
| 0.05-0.15 | 3,712 | -3.05% | -5.52% | 6.3% |
| 0.15-0.5 | 2,700 | -3.71% | -7.78% | 9.6% |
| 0.5-1.5 | 912 | -5.94% | -10.68% | 12.3% |
| > 1.5 | 197 | -6.48% | -11.61% | 17.8% (halves disagree) |

Push policies (`backtest-output.txt`, prints live-scan can push):

| Policy | pushes/day | B mean | B t | B median | B rip |
|---|---|---|---|---|---|
| every print, no ceiling | 9.8 | -3.39% | -6.80 | -6.38% | 7.1% |
| every print, mcap ceiling $500M (chosen: best A t) | 9.1 | -3.52% | -6.99 | -6.62% | 7.0% |
| cooldown 24h | 5.9 | -2.59% | -6.08 | -5.40% | 5.7% |
| re-push only at +20% above last push | 6.3 | -2.75% | -5.27 | -5.68% | 6.6% |
| first print of episode only | 4.8 | -2.60% | -6.14 | -5.22% | 5.3% |
| (excluded by the ceiling: > $500M) | 0.7 | -1.81% | -1.45 | -2.51% | 8.9% |

Run position (prints by the coin in the prior 72h; pushable, under $500M), stable in both halves:

| Position | n | median 24h excess | ripped >20% |
|---|---|---|---|
| first | 4,326 | -5.0% | 4.9% |
| 2nd-4th | 3,513 | -7.5% | 7.7% |
| 5th+ | 983 | -11.4% | 12.2% |

The live judge replayed over history (`judge-output.txt`): neither exhaustion rule was ever demoted in any 10/20/30-day window, raw or capped. The capped judge confirms a working rule far sooner. For the per-coin rule over 10/20/30 days: raw 46/54/60%, capped at +/-20% 73/91/96%. Only 0.4% of historical 5-day windows reached t <= -2. Replaying the live days 09-26..09-29 with the $500M ceiling turns the panel's record from -2.59% to +1.86% in the signal's favour.

Things that did not hold: a coin's own past record (no persistence), funding, perp/spot volume, taker share and drawdown from the high (no split held in both halves). The Polkadot family (MOVR, GLMR, ASTR, KSM, DOT, PHA) was if anything better than average (-4.2%, t -4.8).

## What changed

* `exhaustion_calibrated.maxMarketCap = 500_000_000` (`surgeConfigMatches`; an unknown cap passes).
* `tierOf(liquidity30d, marketCap)`: $500M+ is major. A 20x print there is pushed at default priority as a caution, with the large-coin evidence quoted.
* `surgeExcessRecord`: each cast counts at most +/-`SURGE_EXCESS_CAP_PCT` (20) in the gate statistic; `rawMeanExcessPct` keeps the uncapped figure.
* Alerts state the print's position in the run and what that position has meant (`runPosition`), read from bars already fetched.
* `live-scan.mjs loadMarketCaps`: CoinGecko top 250 keyless, then the Demo key only if throttled, then the D1 `asset_supply_daily` snapshot rescaled to today's price. Every match is price-checked against Binance.
* Migration 0060: `surge_signal_log.market_cap`, so the ceiling can be re-checked on live data.

Cost: no new D1 writes (the new column rides on the existing insert). The only new read is the D1 fallback (~131 indexed rows) when CoinGecko fails. One free CoinGecko call per hourly scan; the Demo key is spent only on failure (at most ~720 calls/month).

## Honest limits

* The $500M ceiling's excluded set is small (719 pushable prints). Watch it on the live record via `market_cap`.
* Market caps before Oct 2025 are a proxy (current supply), within ~23% where checked.
* MOVR's 8 later casts were unscored when this was written; a fast unwind like April's would turn several of them right.
* Scripts read the cached panel from session scratch paths; re-fetch with `fetch_sep.py` / the 2026-09-29 `fetch_archive.py` to reproduce.
