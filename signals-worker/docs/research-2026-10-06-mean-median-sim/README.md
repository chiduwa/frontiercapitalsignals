# Mean vs median vs simulation, and precision/recall, 2026-10-06: scripts and results

Findings: [`../DAY_ZONE_METHODS_AND_CONFUSION.md`](../DAY_ZONE_METHODS_AND_CONFUSION.md).
Run from this `scripts/` folder. Day-zone scripts need numpy, pandas, scipy,
statsmodels, scikit-learn and arch; they read the hourly bars the 2026-10-02
study's fetchers write (`../research-2026-10-02-day-zones-boxes/scripts/fetch.py`
then `fetch_hype_perp.py`, into `DZ_DATA`, default
`signals-worker/reports/day-zones`) and write to `MM_OUT` (default
`signals-worker/reports/mean-median`, gitignored).

| script | doc section | output (`results/`) |
| --- | --- | --- |
| `zone_methods.py` | 1: every method's 10/25/50/75/90th percentile forecast of the day's up and down move (median, mean, trimmed, geometric, recency-weighted, corrected mean, random-walk reach from EWMA/GARCH vol, Monte Carlo by hour and by 6-hour block), walk-forward | `zone_methods_log.txt` |
| `score.py` | 1: adds the median regressions (pooled, per coin); MAE / MSE / CRPS / calibration vs production, per coin, per-coin choice | `score_out.txt` |
| `ablate.py` | 1-2: which inputs carry the gain (exact median regression), the frozen 2019-22 test, the shipped coefficients (`qr_final.json`) | `ablate_out.txt` |
| `evidence.py` | 2: the alert as it runs live with the v2 and v3 bands; the v3 odds in `worker.js` `DAY_ZONE_EVIDENCE` | `evidence_out.txt` |
| `direction_walkforward.py` | 3: walk-forward direction forecasts for all 80 tournament assets x 21 families, with the tournament's own code | `direction_walkforward_log.txt` |
| `confusion.py` | 3: precision / NPV / sensitivity / specificity / informedness: skill, persistence, selection, money, one-sided skill | `confusion_out.txt` |

`direction_walkforward.py` needs the tournament's pinned libraries
(`scripts/sequence-research-requirements.txt`) and its input split per asset:
download a Signals Model Tournament run's artifact (`gh run download <id>`),
build `input.json` with `node scripts/model-tournament-io.mjs data panel.json
input.json`, and write one pickle of rows per symbol plus `_meta.pkl` into
`TOUR_SYM` (as done on 2026-10-06 from run 37446752634). It writes
`TOUR_OUT/direction_wf.pkl` (default `signals-worker/reports/confusion`).

Checks made along the way:
- the Python production column reproduces `day-zones.mjs` (v2) to 1e-16 on BTC,
  HBAR and HYPE, and the v3 JavaScript reproduces `evidence.py`'s band to 1e-16
  on six dates each (both weekdays and weekends);
- `ablate.py`'s fast solver (statsmodels, tolerance 1e-8) matched the exact
  linear program (HiGHS) to 1e-4 in every coefficient; the shipped
  coefficients are the exact solution;
- `evidence.py` with the v2 band reproduces the 2026-10-02 odds within a point.

One slip found and fixed during the study: `score.py` logs the 90th-percentile
coefficients in `qr_coefficients.csv` (the last fit of its loop), not the
median's. The shipped median coefficients come from `ablate.py`.
