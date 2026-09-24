# Sequence, time and momentum models (`tracked-sequence-v1`)

Asked on 2026-09-23: make the learning models learn from sequences, time and
momentum, and find out whether an LSTM, ARIMA/SARIMAX, XGBoost/LightGBM,
support vector regression or logistic regression works for any individual
always-tracked asset. On 2026-09-24 the same test was carried to every other
asset in the archive ([the wide screen](#the-wide-screen-every-other-asset-2026-09-24)).
This page is the evidence for both runs and the recipe for running it again.

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

**Across the other 471 assets, the answer is the same for direction and
nearly the same for size.** Pooled with the favorites, the wide screen ran
14,834 tests on 479 assets. Of the 6,221 direction tests, none survives
correction. On size, two assets do beat GARCH + weekday, and both are stocks
at one session with the LSTM: LMT and CAT. Each holds in both halves of its
window, and both are now challengers in the
[model tournament](MODEL_TOURNAMENT.md), which decides forward.

Frozen run: `research-2026-09-23-sequence/` (`report.json`, `report.md`,
`panel.json.gz`). `inputHash` `45b7de9b4abf44d9…`, `codeHash`
`3aad25eea16ffe21…`, as of 2026-09-23. The script has since learned stocks,
so that hash is the version at commit `3c9b45b`
(`git show 3c9b45b:signals-worker/scripts/tracked-sequence-research.py`).
To reproduce the run without credentials, from `signals-worker`, in an
environment built as in [Running it again](#running-it-again) (about 14
minutes on one core):

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

## The wide screen: every other asset (2026-09-24)

The handoff this page used to end with was carried out. The row builder
learned stocks: horizons counted in trading sessions, SPY as benchmark and
leader, the weekday factor over five sessions, and SARIMA's season set to 5.
Every asset in the archive with enough usable history was then scored by the
same seven families, and everything was corrected as one family.

### What was run

- **Panel:** the whole archive as of 2026-09-24 (652 assets), loaded once.
- **Assets:** every crypto asset or stock with at least 600 usable daily
  bars, minus pegs and series stored at too few decimals to have a real
  return. That left 182 other coins and 289 stocks. The 8 favorites came from
  the weekly lane's own 360-day report, for **479 assets** in all (190 crypto,
  289 stocks).
- **Inputs:** crypto assets use the favorites as leaders and stocks use SPY,
  so no asset's rows depend on its batch. Only the favorites have open
  interest, funding and liquidation lanes, so every other result is a
  price, volume, calendar and momentum result.
- **Test:** the last 360 days per asset (245 sessions for a stock), walk-forward
  as in [Protocol](#protocol). Horizons were 1 and 7 days for crypto, and 1
  and 5 sessions for stocks.
- **Correction:** 63 reports, pooled by `scripts/tracked-sequence-combine.py`
  into one family of **14,834 tests**: 6,221 on direction against the base
  rate, 4,785 on size against the median move and 3,828 on size against
  GARCH + weekday. Both Holm (no false positive anywhere, at 5%) and
  Benjamini–Hochberg (at most 5% of passes false) were applied. The p-values
  come from each test's bootstrap interval. The bootstrap's own p bottoms out
  at 1/20,001, which sits above Holm's first bar at this width, so it would
  have made passing impossible however real the effect.
- **Cost:** about 7 hours on 5 cores, in 62 batches of 8.

Frozen in `research-2026-09-24-sequence-wide/`:

- `combined.json`: the summary and every Holm and BH pass.
- `all-tests.json.gz`: all 14,834 tests, with p, Holm p and BH q.
- `batches.json`: the batches exactly as run.

The `codeHash` is `f501eedd9500880a…` (commit `1a5b820`). The 245 MB panel is
not frozen, so re-running on today's archive is a new screen, not a
reproduction.

### What it found

| Question | Tests | BH passes | Holm passes |
|---|---:|---:|---:|
| Direction vs base rate | 6,221 | **0** | 0 |
| Size vs median move | 4,785 | 78 | 21 |
| Size vs GARCH + weekday | 3,828 | **2** | 0 |

**Direction: nothing, anywhere.** Chance alone would put about 311 direction
tests below p = 0.05 in the models' favour. There were 91, so the models lose
to the plain base rate more often than luck would have them.

**Size vs the median move** is mostly production's own method. GARCH +
weekday has 46 passes (31 coins, 15 stocks), 42 of them at one day or
session. The learned models have 32 passes, 30 of them on stocks. The LSTM
has 21: ANET, ASML, BSX, CIEN (both horizons), CSCO, GLW, HPE, HUBS, IBM,
INTU, LMT, LRCX, MU, NEM, OKLO (both horizons), ORCL and WDC, plus two coins,
MX and PAXG. SVR has 6, LightGBM 3 and XGBoost 2.

**Size vs GARCH + weekday**, the bar that matters, has two passes. Both are
the LSTM at one session:

| Asset | MAE gain vs GARCH + weekday | 95% interval | BH q | First half | Second half |
|---|---:|---|---:|---:|---:|
| LMT | +0.0755 pp | +0.041 to +0.111 | 0.006 | +0.074, t 3.59 | +0.078, t 3.93 |
| CAT | +0.0501 pp | +0.022 to +0.079 | 0.048 | +0.054, t 2.94 | +0.046, t 2.00 |

Each window runs from 2025-09-29 to 2026-09-18, split at its midpoint.
Neither clears Holm (LMT's Holm p is 0.18), so both are candidates, not
conclusions.

The class-level pattern explains why they are exceptions. This is the share
of assets where each model beat GARCH + weekday on size:

| Model | Stocks, 1 session | Stocks, 5 sessions | Crypto, 1 day | Crypto, 7 days |
|---|---:|---:|---:|---:|
| LSTM | 60% | 39% | 5% | 24% |
| LightGBM | 32% | 34% | 1% | 14% |
| SVR | 19% | 31% | 1% | 20% |
| XGBoost | 23% | 23% | 1% | 9% |

On stocks at one session, the LSTM is roughly level with GARCH + weekday on
average (+0.003 pp). It wins on 60% of stocks, but narrowly; LMT and CAT are
the tail where it wins clearly. On crypto, every learned model loses to
GARCH + weekday almost everywhere.

### What happened with the results

- **LMT and CAT are challengers in the model tournament** (1 session, move
  size). This is recorded in `scripts/tournament-universe.json` under
  `screened`, and LMT joined the stock universe for it. The tournament runs
  this study's own `fit_lstm`, turned into a calibrated volatility and scored
  forward on QLIKE against the slot's incumbent. Promotion needs e ≥ 33 for
  LMT (a fresh slot, first alpha) and e ≥ 526 for CAT (fourth in a slot that
  already had three challengers), plus at least 60 forward sessions.
  Details: [MODEL_TOURNAMENT](MODEL_TOURNAMENT.md), "Screened candidates".
- **Nothing else from the screen is actionable.** GARCH + weekday is
  production already, and a size-vs-median pass by a learned model is
  already beaten by it.
- **Data defects the screen exposed:**
  - Tiny-price coins stored at six decimals. Nightly repaired SHIB, BONK,
    LUNC, FLOKI and XEC from Binance. BABYDOGE, BTT, HTX, SKY, TAG and XCN
    have no clean source and are skipped.
  - USX, a loosely pegged USD stablecoin (median daily move 0.07%, above the
    0.03% peg bar), is now on the stable list.
  - On 2026-09-22 Yahoo returned no close for 211 stocks. That date is a
    hole the nightly keeps re-offering, so a one-session label across it
    spans two sessions for those stocks.

### Running it again

No schedule runs it; it is too heavy for that. Re-run it after a large
archive repair, or when the tournament's universe is due for review. From
`signals-worker`:

```sh
python3 -m venv /tmp/fcs-seq-env
/tmp/fcs-seq-env/bin/pip install -r scripts/sequence-research-requirements.txt
/tmp/fcs-seq-env/bin/pip install torch==2.14.0 --index-url https://download.pytorch.org/whl/cpu

# 1. One whole-archive panel (wrangler logged in; unset a stale CLOUDFLARE_API_TOKEN first).
node scripts/hierarchical-research.mjs --dry-run --wrangler --load-only --save-input /tmp/wide/panel.json
# 2. Split into batches: usable history, pegs and quantized series decided here.
node scripts/sequence-wide-batches.mjs /tmp/wide/panel.json /tmp/wide
# 3. Score every batch, one core each; resumable.
/tmp/fcs-seq-env/bin/python scripts/sequence-wide-run.py /tmp/wide --workers 5 --test-days 360
# 4. The favorites, from the same panel.
node scripts/tracked-research-data.mjs /tmp/wide/panel.json /tmp/wide/fav-rows.json --sequence
OPENBLAS_NUM_THREADS=1 /tmp/fcs-seq-env/bin/python scripts/tracked-sequence-research.py \
  --input /tmp/wide/fav-rows.json --output /tmp/wide/out/favorites --test-days 360
# 5. Correct everything as ONE family.
python3 scripts/tracked-sequence-combine.py /tmp/wide/out/*/report.json --output /tmp/wide/final
```

On the 2026-09-24 panel, step 2 reproduces the screen's exact asset set
without any hand exclusions: 471 batched assets plus the 8 favorites.

Pitfalls, in the order they will bite:

1. **Correct across the whole family, never one batch.** A batch corrected
   on its own is an uncorrected search. Step 5 is the only place a result is
   read.
2. **Judge quantization on the stored bars.** Sanitizing drops repeated
   closes, which is exactly what hides the defect. Count *usable* bars, too:
   BABYDOGE stores 1,929 bars, of which 11 are usable.
3. **Survivorship.** Every coin and stock still in the archive survived. The
   stock universe is today's large caps. Split a result by listing cohort
   before believing it (the survivorship section of
   [MODEL_ZOO](MODEL_ZOO.md)).
4. **A screen's pass is a candidate.** Before a pass goes into `screened`, it
   needs BH across the whole family, the strong benchmark (GARCH + weekday,
   not the median move) and both halves. After that, only the tournament's
   forward record can promote it.

### What would count as "it works"

The same bar as every other lane, now enforced by the tournament:

1. Clear the corrected screen.
2. Beat the strong benchmark in both halves.
3. Win forward on forecasts logged before their outcomes existed, through an
   e-process that stays valid however often it is checked.

Only a model that has done all three may touch the published direction or a
bot. The screen's report does not split halves itself. For any candidate,
split its batch's `predictions.json` by date and score each half.

Related: [[TIME_SERIES_EVIDENCE]], [[TRACKED_ASSET_AUDIT_2026_09_19]],
[[PREDICTION_ROADMAP]], [[MODEL_ZOO]]
