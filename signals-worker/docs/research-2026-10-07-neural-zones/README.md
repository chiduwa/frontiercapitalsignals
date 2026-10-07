# Neural networks for the day zones, 2026-10-07: scripts and results

Findings: [`../DAY_ZONE_METHODS_AND_CONFUSION.md`](../DAY_ZONE_METHODS_AND_CONFUSION.md), section 4.

Needs the 2026-10-06 study's `zone_scored.pkl` (run `zone_methods.py` then
`score.py` in `../research-2026-10-06-mean-median-sim/scripts/`) and the hourly
bars it reads, plus PyTorch, LightGBM and statsmodels (the tournament's pins:
`scripts/sequence-research-requirements.txt` and torch 2.14.0 CPU). Writes to
`NN_OUT` (default `signals-worker/reports/neural-zones`, gitignored).

| script | what | output (`results/`) |
| --- | --- | --- |
| `nn_zones.py` | builds the inputs (incl. 14 days of 4-hour bars ending at each open), then walk-forward fits: the linear median regression (v3's model), LightGBM quantile, an MLP and an LSTM (3 seeds each), refit every 91 days on 7 processes (~9 minutes) | `nn_zones_log.txt` |
| `score_nn.py` | MAE / CRPS / calibration against the linear model, 50/50 blends, per coin, and the up/down tilt test | `score_nn_out.txt` |
