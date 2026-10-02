# Box theory and day zones, 2026-10-02: scripts and results

Findings: [`../DAY_ZONES_AND_BOXES.md`](../DAY_ZONES_AND_BOXES.md). Inputs are
public Binance, Binance-portal and Yahoo data. Run from this `scripts/`
folder with numpy, pandas and scipy installed. `DZ_DATA` is where the
fetchers write (default `signals-worker/reports/day-zones`, gitignored).
`CAT_DAILY` is the 2026-10-01 category study's Binance daily klines, for the
major coins in `box.py`.

```sh
python fetch.py               # hourly Binance spot for the 8 tracked coins; Yahoo daily for 10 stocks/ETFs
python fetch_hype_perp.py     # HYPE hourly from the Binance USD-M perpetual (spot listed 2026-09-24)
```

| script | DAY_ZONES_AND_BOXES.md section | output (`results/`) |
| --- | --- | --- |
| `box.py` | 1: Darvas boxes, daily and 4-hour, vs random entries with the same exits | `box_out.txt` |
| `box_4h_robust.py` | 1: the 4-hour result per coin, leave-one-out, momentum-matched control | `box_4h_robust_out.txt` |
| `daytop.py` | 2: which forecast of the day's move (median length, volatility scaling, weekday) | `daytop_out.txt` |
| `daytop_alerts.py` + `daytop_report.py` | 2: every reference hour x zone width, real vs random-sign copies | `daytop_report_out.txt` |
| `daytop_split.py` | 2: per alert, date-clustered; solo vs with the market; accuracy by hour | `daytop_split_out.txt` |
| `daytop_final.py` | 2: reference hours paired against midnight UTC | `daytop_final_out.txt` |
| `daytop_timeleft.py` | 2: odds by hours left in the UTC day | `daytop_timeleft_out.txt` |
| `daytop_rule.py` | 2-3: the alert rule as it runs live, vs random-sign copies | `daytop_rule_out.txt` |
| (`wrangler d1 insights`) | 5: the heaviest D1 queries on 2026-10-02 | `d1_insights_2026-10-02.json` |

`scripts/day-zones.mjs` is the live forecast. `test-day-zones.mjs` checks it
against `daytop.py`'s numbers on real BTC and HBAR bars
(`test-fixtures/day-zones-2026-09-30.json`).

One look-ahead was found and fixed during the study. The volatility scale had
included the window's first hour. Every output here is from after the fix,
which moved the forecast gain from 3.4% to 3.2% and the alert odds by a point
at most.
