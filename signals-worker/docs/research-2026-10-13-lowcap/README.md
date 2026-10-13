# Low-cap spike study, 2026-10-13

Write-up: [`../LOWCAP_SPIKES.md`](../LOWCAP_SPIKES.md). Raw data lands in
`signals-worker/reports/lowcap/raw/` (gitignored). Run from `scripts/`, in order:

| Step | Script | Output (raw/ unless noted) |
|---|---|---|
| 1 | `fetch_universe.py` | `universe.json`, `bapi_products.json`, `cmc_binance_pairs.json`, `cmc_map.json` |
| 2 | `fetch_klines.py` | `klines.parquet` (live + delisted daily OHLCV, taker-buy volume) |
| 3 | `fetch_cmc_history.py` | `cmc_hist.parquet`, `cmc_choice.json` (delisted pairs matched by price) |
| 4 | `fetch_events.py`, then `events.py` | Binance/Upbit announcements, perp launch dates, `events.parquet` |
| 5 | `categories.py` | `cmc_tags.json`, `cmc_flags.json` |
| 6 | `fetch_santiment.py` | `santiment.parquet` (uses ~1,000 aliased calls: the whole free monthly quota) |
| 7 | `snapshot.py [depth|cmc|cg]` | today's order books, CMC detail, CoinGecko (needs `COINGECKO_API_KEY`) |
| 8 | `panel.py` | `daily_features.parquet` |
| 9 | `analyze.py` (`LOWCAP_PCT=0.4` default) | `results/univariate_lowcap40.*`, `lowcap_panel40.parquet` |
| 10 | `analyze_flags.py`, `model.py`, `strategy.py` | flags, walk-forward, exit-rule results |
| 11 | `event_study.py`, `episodes.py`, `inflow_mechanism.py` | catalyst, episode and mechanism results |
| 12 | `rank_now.py`, `final_lists.py` | `results/ranking_<date>.csv`, `results/lists_<date>.md` |
| 13 | `prod_validate.py` (run with the CI-pinned libraries) | `results/prod_validation.json`, the configuration that ships |

Upbit's KRW market list (`upbit_markets.json`) and Bithumb's (`bithumb_krw.json`)
were saved by one-off calls documented in the write-up.

Traps met on the way:
- Binance's product-feed circulating supply is stale for about a third of
  coins; use CMC market caps.
- CMC's keyless historical endpoint returns daily points only for windows up
  to about a year; longer windows come back sparse. Fetch in 360-day chunks.
- Santiment counts every alias in a batched query against the free quota, and
  limits 500 per hour.
- The model's per-model walk-forward files were once overwritten by the
  bottom-20% run; they are now suffixed by universe.
- The gradient-boosted probabilities are miscalibrated; use ranks.
