# Capital rotation and the watch's timing, 2026-10-02: scripts and results

Findings: [`../ROTATION.md`](../ROTATION.md). Every input is public Binance and
Yahoo data, or production's own D1, read only. Run the Python from
`signals-worker/` with numpy, pandas, scipy and lightgbm installed (the pins in
`scripts/sequence-research-requirements.txt` work). Intermediate files go to
`signals-worker/reports/rotation/` (gitignored), or to `ROT_WORK` if set.

## Data

The daily panel reuses the 2026-10-01 category study's inputs and its
`panel.py` (`../research-2026-10-01-categories/scripts`). The Binance daily
klines come from its `fetch_daily.py`, the category membership from its
`fetch_members.py` and `cg/markets.json`. Delisted coins and every hourly test
read the 2026-09-29 hourly archive, through `ARCH` in that `panel.py`. Point
`HERE`/`ARCH` there at wherever those were fetched.

```sh
R=docs/research-2026-10-02-rotation/scripts
python $R/rot_panel.py          # the panel: 505 coins, size tiers, primary use
python $R/fetch_oi.py           # production D1 derivatives_daily (read only, via wrangler login)
```

## Scripts and outputs

| script | ROTATION.md section | output (`results/`) |
| --- | --- | --- |
| `tiers.py` | 2-5: tiers, price lead-lag, pump-then-cool, traded-value share | `tiers_out.txt` |
| `tiers_robust.py` | 3, 5: the 28-day results from four block start dates | `tiers_robust_out.txt` |
| `oi.py` | 6: open-interest flows by tier, alts vs BTC, category, coin | `oi_out.txt` |
| `contagion.py` | 7: category and tier peers in the watch's regression | `contagion_out.txt` |
| `contagion_wf.py` | 7: the watch's LightGBM walked forward, with and without them | `contagion_wf_out.txt` |
| `hourly.py` | 8: peers' hour -> the coin's next 1 / 2-4 / 5-24 hours | `hourly_out.txt` |
| `hourly_tail.py` | 8: the most extreme peer hours, against costs | `hourly_tail_out.txt` |
| `latency.py` | 9: what had already happened by each hour after the close | `latency_out.txt` |
| `delays.py` | 9: how late GitHub starts each daily workflow (`gh api`) | `schedule_delays_out.txt` |
| `early_dryrun.mjs` | 9: the early pass on production data, archive cut back to 09-30 | `early_dryrun_out.txt` |
| (then `scripts/big-move-watch.py` on its two series) | 9: early ranking vs the recorded 10-01 watch | `early_ranking_out.txt` |
| `recover_dryrun.mjs` | 9: scoring picks whose coin left the archive | `recover_dryrun_out.txt` |

`contagion.py` imports production's `scripts/big-move-watch.py`, so the
baseline is the watch exactly as it runs; `contagion_wf.py` takes about 25
minutes on 8 cores. The two `.mjs` dry runs read D1 with any read credential:
`CLOUDFLARE_API_TOKEN`, or wrangler's OAuth token as `CF_OAUTH`, plus
`CLOUDFLARE_ACCOUNT_ID` and `FCS_D1_DATABASE_ID`. They write nothing to D1.

```sh
cd $R
node early_dryrun.mjs $W/early_series.json $W/early_meta.json $W/full_series.json
cd ../../..
python scripts/big-move-watch.py --series $W/early_series.json --series-meta $W/early_meta.json --state <empty state> --output $W/early_results.json
python scripts/big-move-watch.py --series $W/full_series.json --state <empty state> --output $W/full_results.json
```

The early dry run's answer depends on what the archive held on the day it ran.
Re-running it later on the same cut gives the same top-ups, until those coins
leave the universe.
