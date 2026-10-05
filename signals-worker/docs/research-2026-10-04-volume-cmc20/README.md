# Low total volume and CMC20, 2026-10-04: scripts and results

Findings: [`../TOTAL_VOLUME_AND_CMC20.md`](../TOTAL_VOLUME_AND_CMC20.md). Inputs
are keyless public data: CoinMarketCap's website data API (total volume) and
public API (CMC20/CMC100), and Binance's public data mirror. Run every script
from one scratch folder with numpy, pandas, statsmodels and arch installed; the
fetchers write their JSON there and the studies read it from there.

```sh
python scripts/fetch_cmc.py daily     # CMC total volume, daily since 2013
python scripts/fetch_cmc.py hourly    # same, hourly since 2019 (~2 min)
python scripts/fetch_cmc.py binance   # BTC ETH SOL XRP BNB daily + hourly klines
python scripts/fetch_idx.py cmc20     # 10 days per call, paced for the keyless limit (~10 min)
python scripts/fetch_idx.py cmc100
```

`study_cmc20.py` also reads daily klines for XLM, HBAR, ARB, DOGE and ADA
(`fetch_cmc.binance(...)`, from 2023-06-01).

| script | doc section | output (`results/`) |
| --- | --- | --- |
| `study_volume.py` | 2: next-day size, big moves, 3/7-day swings and direction vs relative volume and the $60B line | `study_volume_out.txt`, `volume_regressions.csv`, `volume_raw.csv` |
| `study_streaks.py` | 2: halves, the $60B line by year, quiet streaks | `study_streaks_out.txt` |
| `study_preceded.py` | 2: what came before big moves; break direction after a quiet day | `study_preceded_out.txt` |
| `study_weekday.py` | 2: big moves by weekday; Mondays after quiet vs busy Sundays | `weekday_out.txt` |
| `study_hourly.py` | 2: 4-hour blocks, quiet stretch vs the next 4/12 hours | `study_hourly_out.txt`, `hourly_regressions.csv` |
| `study_oos.py` | short answer: GARCH+weekday with and without total / own volume, QLIKE out of sample | `study_oos_out.txt`, `oos_size.csv` |
| `study_cmc20.py` | 3: CMC20 vs BTC trend signals, alt lead, breadth vs CMC100 | `study_cmc20_out.txt`, `cmc20_tests.csv` |
| (`wrangler d1 insights`, GraphQL) | 4: D1 writers and daily usage | `d1_insights_writes_24h_2026-10-04.json`, `d1_insights_writes_7d_2026-10-04.json`, `d1_daily_usage_2026-09-06_to_10-04.json` |
