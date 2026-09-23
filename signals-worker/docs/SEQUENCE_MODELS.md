# Sequence, time and momentum models (`tracked-sequence-v1`)

Asked on 2026-09-23: make the learning models learn from sequences, time and
momentum, and find out whether an LSTM, ARIMA/SARIMAX, XGBoost/LightGBM,
support vector regression or logistic regression works for any individual
always-tracked asset. This page is the evidence and the handoff for carrying
the same test to the other tracked assets.

## The answer

**None of the five families adds anything for any of the 8 always-tracked
assets, at 1 day or 7 days, so none of them goes into production.** This
covers LSTM, SARIMA/SARIMAX, LightGBM/XGBoost, SVR and logistic regression.
Seven families were scored per asset on a 720-day untouched test (2024-10-03
to 2026-09-21: 719 one-day and 102 non-overlapping seven-day outcomes per
established asset). After correction across all 233 comparisons none of them
beats the asset's base rate on direction or GARCH + weekday on size. The
uncorrected numbers say the same: 218 tests of the new families produced
**one** p below 0.05 where chance alone produces about eleven.

The sequence and time structure that does hold out of sample is already in
production: volatility clustering and the weekday rhythm, both inside GARCH(1,1)
+ weekday (the time-series panel's band). It beat the median move on 7 of 8
assets at 1 day (uncorrected p 0.001–0.033, HYPE the exception), which is the
universe-wide result of [TIME_SERIES_EVIDENCE](TIME_SERIES_EVIDENCE.md)
reproduced per asset. Momentum (vol-normalized 1/5/20/60-day returns, trend
gap) was already an input to the per-asset model, and adding acceleration,
return lags, calendar and a 30-day sequence did not create direction skill in
any family.

Frozen run: `research-2026-09-23-sequence/` (`report.json`, `report.md`,
`panel.json.gz`). `inputHash` `45b7de9b4abf44d9…`, `codeHash`
`3aad25eea16ffe21…`, as of 2026-09-23. To reproduce it without credentials,
from `signals-worker`, in an environment built as in the handoff below (about
14 minutes on one core):

```sh
gzip -dc docs/research-2026-09-23-sequence/panel.json.gz > /tmp/seq-panel.json
node scripts/tracked-research-data.mjs /tmp/seq-panel.json /tmp/seq-rows.json --sequence
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 /tmp/fcs-seq-env/bin/python scripts/tracked-sequence-research.py \
  --input /tmp/seq-rows.json --output /tmp/seq-out --test-days 720
```

### Direction: does it call up/down better than the asset's own base rate?

| Family | Cells better than base rate (raw) | Lowest uncorrected p | Hit rate | Net per decision after 0.20% |
|---|---:|---:|---:|---:|
| Logistic regression | 0 / 15 | 0.683 | 50.1% | −0.29% |
| LightGBM | 3 / 15 | 0.061 (HYPE 1d) | 50.6% | −0.64% |
| XGBoost | 2 / 15 | 0.147 | 50.8% | −0.12% |
| SVR | 3 / 15 | 0.047 (XLM 7d) | 51.1% | −0.04% |
| SARIMA | 4 / 15 | 0.132 | 48.7% | −0.49% |
| SARIMAX (1d only) | 0 / 8 | 0.557 | 50.0% | −0.10% |
| LSTM | 2 / 15 | 0.287 | 50.4% | −0.21% |

A cell is one asset at one horizon; HYPE has no 7-day cell (below). Every
family loses money on average after costs. Logistic regression is the worst
family in 12 of the 15 cells: with this many correlated inputs and at most 730
training rows it fits noise even at C = 0.1. SARIMA's weekly seasonal terms and SARIMAX's OI
and volume inputs find nothing that a flat base rate does not.

### Size: does it forecast the next move's size better than GARCH + weekday?

| Family | Beats GARCH + weekday | Beats even the median move | Lowest uncorrected p vs GARCH |
|---|---:|---:|---:|
| LightGBM | 0 / 15 | 1 / 15 | 0.593 |
| XGBoost | 0 / 15 | 0 / 15 | 0.858 |
| SVR | 1 / 15 | 3 / 15 | 0.403 |
| LSTM | 1 / 15 | 4 / 15 | 0.324 |

Per-asset one-day GARCH + weekday, the benchmark (mean absolute error in %,
improvement over the median move, Spearman rank correlation with the realized
size):

| | BTC | ETH | SOL | XLM | XRP | HYPE | HBAR | ARB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| MAE % | 1.087 | 1.749 | 1.900 | 2.156 | 1.951 | 2.264 | 2.223 | 2.493 |
| vs median | +0.045 | +0.057 | +0.056 | +0.121 | +0.067 | −0.004 | +0.123 | +0.071 |
| Spearman | 0.28 | 0.17 | 0.23 | 0.23 | 0.24 | 0.07 | 0.31 | 0.19 |

The gradient-boosted and neural models do worse than GARCH on size for a
reason worth knowing: they fit |move| directly on a few hundred rows and
chase its heavy tail, while GARCH imposes the one structure that is real,
persistence of variance.

### Signed return

6 of 68 signed cells have positive out-of-sample R², the largest +0.011 (XRP
7d, LightGBM, 102 outcomes). Every family's median R² is negative: LightGBM
−0.012, SARIMA −0.016, SARIMAX −0.032, XGBoost −0.062, SVR −0.074.

### Two data limits found on the way

- **HYPE** has only CoinGecko history in the archive (from 2025-08-22, the
  demo tier's 365-day reach; Yahoo and Binance spot do not carry it). After the
  60-day warm-up that is 336 rows: 168 one-day test outcomes and no seven-day
  ones. It needs a longer-history source (Hyperliquid's own candles) before any
  HYPE-only result means much.
- **ARB** lost 17 test rows to a one-day hole where its archive switched from
  CoinGecko to Binance. The same hole hit 32 coins. It is fixed in
  `backfill-history.mjs` (see `coinGeckoReplacement` in `scripts/archive.mjs`),
  and the run above predates the fix.

## What the models see

Every family gets the same rows (`scripts/tracked-research-data.mjs`), built
at each daily close from data known at that close:

| Kind | Inputs |
|---|---|
| **Sequence** | a 30-day window of daily log return, its absolute value, and log volume against its 20-day mean (the LSTM's input, `--sequence`); ten daily return lags `returnLag0..9` (the tabular models' input) |
| **Time** | weekday as a one-hot, month on the unit circle (sin/cos); SARIMA carries a 7-day seasonal AR and MA term |
| **Momentum** | 1/5/20/60-day returns normalized by volatility, trend gap, `momentumAcceleration` (5-day z less 20-day z), drawdown from high, range position |
| **Derivatives and liquidity** | open-interest change and percentile, taker ratio, long/short change, funding rank, book imbalance, depth, the same lanes `tracked-research.py` uses |

A field measured fewer than 25 times in a fold's training rows is dropped for
that fold, and every kept field has its own missing indicator. That is why an
asset without Oracle OI or funding samples still runs; it just runs without
those lanes.

## The families, as configured

| Family | Direction P(up) | Magnitude \|move\| | Signed return |
|---|---|---|---|
| Logistic regression | L2, C = 0.1, on train + validation | — | — |
| LightGBM | 7 leaves, early-stopped on validation, refit on train + validation at that size | same | same |
| XGBoost | depth 3, same early-stop-then-refit | same | same |
| Support vector regression | sigmoid of the scaled signed forecast | RBF SVR on \|move\| | RBF SVR, C = 1, ε = 0.1 |
| SARIMA(1,0,1)(1,0,1,7) + drift | Φ(mean / sd) of the h-step forecast | — | h-step cumulative mean |
| SARIMAX | as SARIMA, plus OI change and volume ratio as exogenous inputs (1-day only) | — | same |
| LSTM | one layer, 16 units, two heads (BCE + ½·Huber), early-stopped on validation, ≤ 80 epochs | second head | — |

Benchmarks each model has to beat: the asset's own smoothed up-rate
(direction); the median |move| and **GARCH(1,1) with a weekday factor**
scaled on training rows only (magnitude), which is the model that already
beats production's volatility scale ([TIME_SERIES_EVIDENCE](TIME_SERIES_EVIDENCE.md));
and zero (signed).

## Protocol

The same folds, transforms and bootstrap as `tracked-research.py`, so numbers
compare with [the September 19 audit](TRACKED_ASSET_AUDIT_2026_09_19.md):

- Untouched test window (720 days here, 360 in the weekly job) at the end of
  history. 7-day outcomes are non-overlapping, one every 7 days.
- Refit every 28 days on at most 730 earlier labels. The last 60 labels (20 at
  7 days) are validation, and every training label whose outcome reaches into
  validation is purged.
- SARIMA's parameters are fitted through the end of each fold's history, then
  held fixed while the filter walks forward through the test rows.
- Direction is scored by Brier improvement over the base rate, plus hit rate
  and net return after a flat 0.20% round trip. Magnitude is scored by MAE
  against both benchmarks, signed by out-of-sample R².
- Intervals come from a paired circular block bootstrap (7-day blocks at 1
  day, 2 at 7 days). **Holm correction runs across every asset, horizon, model
  and question in the run.** A model "works" only if it clears the corrected
  5% bar with a positive mean.

### Why the protocol can be trusted

`test-tracked-sequence-research.py` checks that appending later rows never
changes an earlier prediction, first for the fast families and then for SARIMA,
SARIMAX and the LSTM. It also checks that pure noise clears nothing after
correction and that the calendar encoding is right. Each check was
mutation-tested. Three planted leaks were each caught by a failing test:
(1) the median benchmark computed with test labels, (2) SARIMA parameters
fitted on the whole series, and (3) the LSTM normalized with test windows.

## Where it runs

`.github/workflows/signals-sequence-research.yml` runs every Sunday at 10:43
UTC, and on demand with a chosen test window. It tests first, then reads the
bounded tracked panel, builds rows with `--sequence`, scores everything, and
keeps inputs and results as a 90-day artifact. It is research only: it writes
no D1 rows, publishes nothing and places no orders. Libraries are pinned in
`scripts/sequence-research-requirements.txt`; PyTorch comes from the CPU
index at 2.14.0.

## Handoff: carrying this to the other tracked assets

### Other crypto assets: ready to run

The row builder and the model script both take a symbol list. From
`signals-worker`, with the FCS D1 credentials in the environment:

```sh
python3 -m venv /tmp/fcs-seq-env
/tmp/fcs-seq-env/bin/pip install -r scripts/sequence-research-requirements.txt
/tmp/fcs-seq-env/bin/pip install torch==2.14.0 --index-url https://download.pytorch.org/whl/cpu

SYMS=LINK,AVAX,DOT,ADA,DOGE,SUI      # one batch; see the pitfalls below
node scripts/hierarchical-research.mjs --dry-run --symbols $SYMS --save-input /tmp/seq-panel.json --load-only
node scripts/tracked-research-data.mjs /tmp/seq-panel.json /tmp/seq-rows.json --sequence --symbols $SYMS
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 /tmp/fcs-seq-env/bin/python scripts/tracked-sequence-research.py \
  --input /tmp/seq-rows.json --output /tmp/seq-results --test-days 720
```

Runtime is about 100 seconds per asset for a 720-day test on one core (1-day
and 7-day together), about half that at 360 days. `--no-lstm` and
`--no-sarima` remove the two slowest families. The archive holds 321 crypto
assets, so the other 313 are roughly 9 core-hours at 720 days: run batches as
parallel processes, then correct them together (pitfall 1).

Pitfalls, in the order they will bite:

1. **Correct across the whole family, not one batch.** Holm runs over whatever
   is in one report. Six assets scored in isolation and then compared by eye
   is an uncorrected search. Either run every symbol in one invocation (rows
   from several panel loads with the **same `asOf`** can be concatenated,
   since the script only needs `asOf`, `symbols` and `rows`), or pool the
   per-batch `p` values from each `report.json` and correct them together
   before calling anything a result.
2. **Load in small symbol batches.** The panel loader already pages symbols,
   but a very long `--symbols` list still makes large D1 reads, and the D1
   7010 result-size limit has silently emptied research inputs before. Six to
   ten symbols per load is safe.
3. **Only the always-tracked 8 have OI, funding and liquidation samples.** For
   every other asset those lanes drop out, so a result there is a
   price/volume/calendar/momentum result. Say so when reporting it, and do not
   compare it one-for-one with a favorite's.
4. **Survivorship.** Any asset still being tracked today survived. Split every
   result by listing cohort, established versus recent, before believing it
   (the survivorship section of [MODEL_ZOO](MODEL_ZOO.md)).
5. **Short histories.** An asset needs about 150 daily rows before its first
   test fold (90 train + 60 validation). A recent listing produces few test
   outcomes and wide intervals. Report n next to every number.

### Stocks: needs code, not just a flag

`researchRows` keeps crypto assets only, and three things in it assume a
7-day week:

- The target check `end.date === offset(date, horizon)` counts calendar days,
  so every Friday 1-day row (Friday → Saturday) would be dropped. Stocks need
  the horizon counted in **sessions**.
- `timeSeriesPaths` is called with `assetClass: 'crypto'`. Stocks need
  `'stock'` so the weekday factor is estimated over the five sessions.
- SARIMA's seasonal period should be 5 on a session index, and the weekday
  one-hot will have two always-zero columns (harmless, but drop them).

The crypto derivatives and liquidity lanes must stay absent for stocks. Add
equity-specific inputs (earnings dates, adjusted prices, options) only with
their own publication timestamps, as
[PREDICTION_ROADMAP](PREDICTION_ROADMAP.md) §5 requires.

### What would count as "it works"

The same bar as every other lane: clear Holm across the full family in the
established cohort, hold in both halves of the test window, beat the *strong*
benchmark (GARCH + weekday for magnitude, not just the median), and then
survive a pre-declared forward window before anything touches the published
direction or a bot. The report does not split halves itself; for any
candidate, split `predictions.json` by date and score each half.

Related: [[TIME_SERIES_EVIDENCE]], [[TRACKED_ASSET_AUDIT_2026_09_19]],
[[PREDICTION_ROADMAP]], [[MODEL_ZOO]]
