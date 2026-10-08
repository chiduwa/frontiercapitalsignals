# Conditional market and asset scenarios — October 8, 2026

The [longer-history extension](../research-2026-10-08-cycles/README.md) preserves this first run and adds earlier Binance history, cycle/season/regime breakdowns, and separate daily direction/volatility models using BTC history from 2010.

**Decision: keep every new scenario research-only. No new alert, entry, or holding rule is authorized by these results.**

Tested 3,744 asset/rule/side/horizon cells on 1,503,414 15-minute Binance Global USDⓈ-M futures candles across 16 contracts, 2024-01-01–2026-10-07. 0 cells passed the full research gate. Also inspected 27,666 recent regular-session candles across 18 US stocks/ETFs relevant to Robinhood. That 60-day equity sample cannot validate persistent per-asset rules.

## Fixed scenarios

- A ≥0.75% 15-minute move with ≥3× prior-day median volume; two more closes in the same direction while volume falls below 70% of the spike.
- Two hours of 0.4–1.5% directional drift, ≥80% path efficiency, volume below 70% of the earlier-day median; continuation and subsequent ≥2× volume expansion.
- A close beyond the previous 24-hour high/low followed by a close back inside: failed upside breakout short / failed downside breakout long. The rejection must already be observed.
- A ≥1% prior-hour move at the actual New York/London open or close; both continuation and reversal, with holidays, half-days and DST.
- A ≥1% prior-hour move with rising/falling open-interest quantity, crowded/opposing funding, or confirming taker flow.
- A fixed seven-coin reference basket creeping on quiet volume, accelerating in volume, or moving broadly by ≥1%. This is a basket proxy, not all of crypto.

## Method and limits

Conditions use completed bars only. Enter at the next bar open, then repeat with 15 minutes of delay. Test 15m, 1h, 4h, 24h, 72h and 7d. Outcomes cannot overlap within an asset/rule/horizon. Subtract 20 bp round-trip fees/slippage, stress at 40 bp, and apply actual funding settlements (15-minute trade price approximates settlement mark). Missing bars and missing funding coverage abstain.

Choose each asset/rule/side holding horizon using outcomes ending before June 1, 2025. Evaluate June 1, 2025–September 30, 2026, also split at February 1, 2026. Compare with the same asset/side/hour/weekday without the scenario filter; this matched control measures association, not causation. Use 14-day blocks for uncertainty and BH correction across all tested cells. Require positive performance in both halves, ≥60 test events, ≥20 events per half, delay resilience and the higher cost stress. The gate is an offline screen; even a pass would still need new forward outcomes.

Current asset selection has survivorship bias. Recent OI covers only June–October 2026 for BTC/ETH/SOL/HBAR, so OI scenarios have no pre-June-2025 training sample and cannot earn a frozen holding choice. Funding sign uses the last observed settlement, not an unknowable future fee. Equities lack historical short-borrow/execution costs; their rows confer no permission to short on Robinhood. Stops, liquidation and portfolio interactions are not simulated in these strategy returns. A later profitable exit does not establish that the path was survivable.

## One-hour volume-fade continuation, per core asset

Net returns below are unlevered percentages after modeled costs. These are descriptive test-period results, not recommendations.

| Asset | Side | Events | Mean net | Mean above matched control | 90th-percentile adverse move |
|---|---|---:|---:|---:|---:|
| BTCUSDT | short | 18 | -0.506% | -0.300% | 1.752% |
| BTCUSDT | long | 24 | +0.116% | +0.307% | 0.923% |
| ETHUSDT | short | 42 | -0.479% | -0.303% | 2.041% |
| ETHUSDT | long | 51 | -0.264% | -0.082% | 1.727% |
| HBARUSDT | short | 52 | -0.194% | -0.009% | 1.742% |
| HBARUSDT | long | 46 | -0.122% | +0.055% | 1.876% |
| SOLUSDT | short | 38 | -0.503% | -0.303% | 2.394% |
| SOLUSDT | long | 43 | -0.158% | +0.015% | 1.773% |

## Holding duration and traps

The tested failed-breakout, funding, OI and volume conditions do not justify a blanket “hold shorts longer” rule. The report retains 15m–7d forward returns, funding, maximum favorable excursion and maximum adverse excursion for every event. Historical failed breakouts can fail again: a re-entry short can still suffer a larger squeeze. Use the private journal report to distinguish each entry basis, partial exit and observed liquidation level; it is intentionally excluded from this public research artifact.

## Reproduce and cost

Install `scripts/scenario-requirements.txt` in a research environment. From `signals-worker`:

```bash
python scripts/scenario-data.py
python test-scenario-research.py
python scripts/scenario-research.py
python scripts/scenario-equities.py
python scripts/scenario-report.py
```

Downloads are cached locally, with a 2,500-request ceiling and six download threads. No new Cloudflare storage, cron, paid API, or production inference has been added. The first run used 1,684 archive requests (1,652 available). Raw bars, full outcomes and account data remain in ignored `reports/scenarios/`; only the compact research report is versioned.

## Sources

- [Binance public archive, formats and venues](https://github.com/binance/binance-public-data). These futures candles are Binance Global, not Binance.US.
- [Binance futures market data, OI and funding](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data). OI quantity avoids confusing a price rise with new contracts.
- [Robinhood crypto availability](https://robinhood.com/us/en/support/articles/coin-availability/). Availability depends on account/jurisdiction; no account access was inferred.
- [NYSE hours and calendar](https://www.nyse.com/markets/hours-calendars) and [exchange_calendars](https://github.com/gerrymanoim/exchange_calendars).
- [CoinMarketCap OHLCV documentation](https://coinmarketcap.com/api/documentation/pro-api-reference/cryptocurrency). CMC is useful for aggregate context; exchange-specific execution/volume and funding come from Binance. No paid CMC history was purchased.
