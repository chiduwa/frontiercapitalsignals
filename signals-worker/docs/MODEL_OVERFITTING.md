# Overfitting audit: every per-asset fit, measured out of sample

2026-09-27. The question: check the models for overfitting (in-sample R² and
similar), find the right correction per asset, and measure whether the
corrections make the forecasts better.

Short version:

- **The per-asset return regression is overfit about as far as its R² says.**
  Its median in-sample R² is barely above what pure noise produces with the
  same number of inputs, and its out-of-sample R² is negative in every lane. It
  is research-only (`actionable: false`) and stays that way. The best
  per-asset correction shrinks its forecasts almost to zero, which is the
  benchmark it already loses to.
- **Four per-asset choices on the production path were partly fitting
  noise.** Three got a measured correction, and the fourth is already guarded:

  | where | what was overfit | correction | measured effect |
  | --- | --- | --- | --- |
  | tournament size models | each asset's own calibration factor | factor pulled toward its class by empirical Bayes | better in 16 of 24 slot/source cells, never significantly worse; **shipped as new candidates** |
  | tournament size models | choosing each asset's best model from its own record | none needed: one fixed model beats per-asset picks in all 4 slots | the forward promotion rule already guards this |
  | the volatility band | each asset's lookback window, picked on its own history | one fixed 90-day window times one factor per class | calibration 1.36 to 1.01 (crypto), 1.17 to 1.04 (stocks); **shipped** |
  | engine technique weights | each asset's own hit rate, trusted after a few outcomes | prior strength 12 to 400 outcomes | +0.008 to +0.009 log-likelihood per outcome on live data; **shipped** |

- **One correction is measured but not shipped**, because it changes which
  calls get published: per-asset composite records overstate their winners
  (section 6).

## How overfitting was measured

An in-sample fit always looks better than the truth, so every number below
comes from forecasts that could not see their outcomes:

- **R² against what noise gives.** A regression with p inputs fitted to n
  points of pure noise has an expected R² of (p - 1) / (n - 1). An in-sample R²
  near that number means the fit found nothing. Out-of-sample R² is scored
  against the zero-return forecast, so a negative value means "worse than
  predicting nothing".
- **Walk-forward only.** Every factor, weight and choice is refitted using
  labels that had matured by the forecast date, then frozen and scored on what
  followed. Nothing is tuned on the period it is scored on.
- **Proper scores.** Size forecasts are scored by QLIKE (r²/σ² + log σ², lower
  is better), the loss that rewards an honest variance. Hit-rate forecasts are
  scored by binomial log-likelihood. Calibration is the mean squared
  standardized move: 1.00 means the band was exactly as wide as the moves that
  followed, above 1 means too narrow.
- **Honest t-statistics.** Differences are averaged per date first, because
  assets on one date move together, and multi-day outcomes are thinned to
  non-overlapping dates. The composite folds bootstrap over assets.

## 1. The per-asset return regression (hierarchical-mlr-v4)

Production's own code (`hierarchical-research.mjs`, `hierarchical-model.mjs`)
on the full panel as of 2026-09-26. In-sample is the full-sample per-asset fit;
out-of-sample is production's own walk-forward forecasts (refit every 21
days). Medians across assets:

| lane | assets | points (n) | inputs (p) | in-sample R² | what noise gives | adjusted R² | out-of-sample R² | assets beating zero |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| crypto 1d | 335 | 963 | 23 | 3.0% | 2.3% | 1.0% | -1.4% | 20% |
| crypto 7d | 201 | 290 | 24 | 12.0% | 8.7% | 3.0% | -3.3% | 9% |
| stock 1d | 291 | 1,378 | 17 | 1.2% | 1.2% | 0.1% | -1.6% | 5% |
| stock 5d | 291 | 275 | 17 | 6.0% | 5.8% | 0.2% | -1.2% | 30% |

The crypto 7-day fit's 12% looks like a real model until it is set next to the
8.7% that noise gives with 24 inputs and 290 points. Out of sample, 91% of those
assets did worse than forecasting zero.

**The correction tested:** scale each forecast by a calibration slope learned
only from that asset's earlier, already-matured forecasts, partially pooled
toward the class slope and clipped to [0, 1]. A slope below 1 is the textbook
symptom of overfitting: forecasts too extreme for what follows them.

| lane | pooled out-of-sample R², raw | after the correction | median slope | assets improved |
| --- | ---: | ---: | ---: | ---: |
| crypto 1d | -0.08% | -0.002% | 0.08 | 274 of 335 |
| crypto 7d | -2.48% | -0.04% | 0.00 | 181 of 201 |
| stock 1d | -2.22% | -0.04% | 0.05 | 279 of 291 |
| stock 5d | -2.26% | -0.25% | 0.15 | 202 of 291 |

The correction helps 69% to 96% of assets, and it does so by learning to
multiply the forecasts by roughly zero. There is no hidden edge under the
overfitting. **No change:** the regression is already research-only.

## 2. Tournament size models: each asset's calibration factor

`calibrated` scale candidates multiply a base volatility by
c = sqrt(mean(log move² / σ²)) measured on the asset's own history. Tested with
the tournament's own `base_sigma`, `log_move`, `matured` and QLIKE on its own
input, refitted every 28 days, 2023-09 to 2026-09.

The empirical-Bayes weight an asset's own factor deserves,
w = τ² / (τ² + se²) with the between-asset spread τ² by DerSimonian-Laird and
se² from the asset's own ratios at an effective size of n / h:

- GARCH and GARCH + weekday: **0.27 to 0.44**. The assets really differ, but
  their own estimates deserve well under half the weight.
- seasonal HAR, HAR, EWMA and trailing: **0.00**. Every difference between
  assets' factors is noise.

QLIKE against the per-asset factor production uses (negative = better):

| slot | GARCH + weekday | GARCH | seasonal HAR | EWMA | HAR | trailing |
| --- | --- | --- | --- | --- | --- | --- |
| crypto 1d | -0.005 (t -1.0) | -0.009 (t -1.6) | +0.001 (t 0.1) | -0.005 (t -0.7) | +0.003 (t 0.2) | -0.008 (t -1.1) |
| crypto 7d | -0.032 (t -1.8) | -0.034 (t -1.9) | +0.016 (t 0.5) | -0.014 (t -0.7) | +0.029 (t 0.7) | -0.018 (t -1.0) |
| stock 1d | +0.000 (t 0.1) | +0.000 (t 0.1) | -0.008 (t -1.0) | **-0.008 (t -2.8)** | -0.007 (t -0.9) | **-0.010 (t -3.5)** |
| stock 5d | +0.007 (t 0.9) | +0.006 (t 0.8) | -0.005 (t -0.5) | -0.004 (t -0.6) | -0.003 (t -0.3) | -0.006 (t -1.0) |

Better in 16 of 24 cells, significantly in 2, never significantly worse (the
largest loss is t +0.9). Calibration itself matters: leaving HAR uncalibrated
costs +0.29 to +0.76 (t +2.4 to +5.4). It is the per-asset part that does not
earn its keep.

On the generator's own 360-day history screen (12 assets, 24 asset-slots), the
shrunk factor beat the per-asset one in 15 of 24 slots for GARCH + weekday
(mean QLIKE gain +0.012), 18 of 24 for trailing (+0.023) and 15 of 24 for
EWMA (+0.016).

**Shipped** (`scripts/model-tournament.py`): six new size candidates, one per
base source, "calibrated toward its class". The class pool is rebuilt at every
fit date from labels matured by that date, so it never sees the future. They
enter like every candidate: screened on history, **promoted only on forward
evidence** by the e-process. This commit replaces no incumbent.

## 3. Choosing each asset's model from its own record

Same walk-forward, every source with the shrunk factor. At each refit, each
asset takes the source with the lowest QLIKE over its trailing 360 days of
already-scored forecasts. That is "use this asset's best model", done
honestly. It is compared with one fixed model for everyone (GARCH + weekday).
QLIKE difference, positive = worse than the fixed model:

| slot | per-asset pick | per-asset only on clear evidence (t <= -2) | the class's best | average of all six |
| --- | --- | --- | --- | --- |
| crypto 1d | +0.034 (t 2.2) | +0.002 (t 1.4) | +0.001 (t 1.2) | -0.003 (t -0.2) |
| crypto 7d | +0.090 (t 2.6) | +0.032 (t 2.5) | +0.030 (t 2.4) | +0.099 (t 1.9) |
| stock 1d | +0.023 (t 2.2) | +0.010 (t 2.9) | +0.009 (t 2.9) | -0.012 (t -0.8) |
| stock 5d | +0.021 (t 1.8) | +0.006 (t 1.1) | +0.005 (t 0.8) | -0.008 (t -0.5) |

Picking per asset is worse in all four slots. Even re-picking the class's best
model on a trailing window is worse. Last year's winner is partly last year's
luck. **No change:** the tournament already refuses to promote on history, and
this is why that rule matters. Expect per-asset challengers to rarely beat a
pooled incumbent.

## 4. The volatility band

`predictedRange` sizes a band from volatility until the asset has 20 matured
moves of its own at that horizon. That band is never shown to a reader (only
'historical' ranges are published), but every one is logged and scored, and
those scores become the asset's range record that the publication gate reads.

Its volatility came from `bestVolLookback`, which picks each asset's window
(10 to 90 days) by how well that window fitted the asset's whole history.
Replicated exactly and run walk-forward: 7-day moves, one forecast per asset
per week, 2023 to 2026 (32,124 crypto and 37,871 stock forecasts). QLIKE against
the per-asset choice (negative = better), and calibration:

| band volatility | crypto QLIKE | crypto calibration | stock QLIKE | stock calibration |
| --- | --- | ---: | --- | ---: |
| per-asset window (before) | (reference) | 1.357 | (reference) | 1.171 |
| fixed 10 days | +0.309 (t 0.7) | 2.14 | +0.347 (t 5.7) | 1.92 |
| fixed 20 days | -0.175 (t -0.5) | 1.68 | +0.101 (t 4.1) | 1.48 |
| fixed 30 days | -0.236 (t -0.9) | 1.54 | +0.051 (t 2.5) | 1.35 |
| fixed 60 days | -0.055 (t -1.0) | 1.38 | +0.003 (t 0.2) | 1.18 |
| fixed 90 days | **-0.074 (t -3.0)** | 1.28 | -0.032 (t -1.6) | 1.13 |
| **fixed 90 days x class factor (shipped)** | -0.320 (t -1.8) | **1.01** | -0.034 (t -1.5) | **1.04** |

The per-asset choice already picked 90 days for 70% (crypto) and 75% (stocks)
of forecasts, and the other 25% to 30% of picks cost accuracy. Every window
ran too narrow. With the per-asset choice, realized 7-day moves were about 17%
(crypto) and 8% (stocks) wider than the band implied.

**Shipped** (`worker.js`): the band uses a fixed 90-day window scaled by one
factor per asset class. The factor is the mean squared standardized 7-day move
over the class's last two years, one move a week per asset, each judged
against the 90-day volatility known when it began (capped at 50, so a data
glitch cannot set the class factor). Under 500 pooled moves it stays 1. On the
archive, the shipped code gives crypto 1.206 from 21,049 moves (band 9.8% wider
than the plain 90-day band) and stocks 1.132 from 29,748 moves (6.4% wider).
The payload reports it as `bandCalibration`. `volPct` itself, and every
technique and feature that reads it, is unchanged.

For reference, the idea behind the 'historical' band that published rows use
(the asset's own past 7-day moves) scored 0.81 for crypto (too wide) and 0.99
for stocks on this test. That band was not changed. The range gate already
scores it against its own record.

## 5. Engine technique weights (`RELIABILITY_PRIOR_SAMPLES`)

Each technique's weight on an asset blends the asset's own record with the
technique's class-wide record: (correct + classRate x N0) / (n + N0). N0 was
12, so a 50-outcome asset record carried 81% of the weight.

**The test on live outcomes:** 119,447 live technique outcomes in 29,875
(asset, technique, horizon) cells, split at 2026-09-16. Each cell's first-half
record predicts its second-half hit rate. The class rate leaves the cell out.
Mean log-likelihood per outcome (higher is better):

| N0 | 0 | 3 | 6 | **12 (before)** | 25 | 50 | 100 | 200 | **400 (now)** | 1000 | class only |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| first half -> second | -1.7582 | -0.7206 | -0.6991 | -0.6876 | -0.6823 | -0.6805 | -0.6800 | -0.6798 | -0.6798 | -0.6798 | -0.6798 |
| second half -> first | -1.3646 | -0.6902 | -0.6728 | -0.6620 | -0.6563 | -0.6541 | -0.6534 | -0.6532 | -0.6532 | -0.6532 | -0.6532 |

Flat from 200 onward in both directions. The old setting lost 0.0078 and
0.0088 per outcome. The records this setting governs are thin: in the engine's
own table (confluence-v9) a technique cell holds a median of 5 outcomes at 24h
(never more than 7) and 1 at 168h. No live cell had 15 outcomes in both halves.

**The check on large records.** Technique records are too thin to say what a
large record deserves, so the same test ran on the composite call, which has
five years of replayed history per asset. This setting does not govern the
composite; it is a check on how much weight a big record earns. Year folds,
prior toward the class's training-period rate:

| fold | cells | test outcomes | median record | best N0 | 400 vs 12, per outcome | 95% range (by asset) | class only vs 400 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 2021-23 -> 2024 | 884 | 80,016 | 115 | 400 | +0.0034 | +0.0009 to +0.0082 | -0.0014 |
| 2021-24 -> 2025-26 | 1,232 | 246,288 | 166 | 200 | +0.0020 | +0.0010 to +0.0029 | -0.0008 |
| 2025-26 -> 2021-24 | 893 | 238,860 | 91 | 400 | +0.0041 | +0.0009 to +0.0102 | -0.0012 |

With records of 100 or more, the best prior is still 200 to 400 in every fold.
Ignoring the asset entirely (class only) is slightly worse than 400, so a large
record does carry a little real information. It just deserves a small share
of the weight: n / (n + 400).

**Shipped** (`worker.js`): `RELIABILITY_PRIOR_SAMPLES` = 400, and it is now
exported and pinned by a test. A 150-outcome asset record still gets 27% of
the say. The same answer the four earlier per-asset weight tests gave
(`PREDICTION_WEIGHTS_EVIDENCE.md`): assets differ, but not in ways that
persist at these sample sizes.

## 6. Not shipped yet: per-asset composite records in publication

Each asset's own composite record feeds two things: its "proven" track record
(`assetPredictionScore`, raw hit rate with a Wilson bound) and the asset part
of `currentSignalConfidence`. Using the same five-year replay: assets whose
2021-24 record clearly beat their class (one-sided Wilson bound above the
class rate), and the mirror group, against what they did in 2025-26:

| group | assets | median record | class 2021-24 | own record 2021-24 | shrunk forecast (N0 300) | what happened 2025-26 | class 2025-26 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| crypto 24h, beat class | 15 | 1,267 | 42.5% | 46.6% | 45.4% | **42.8%** | 41.9% |
| crypto 24h, trailed class | 16 | 558 | 42.5% | 35.0% | 38.3% | **35.9%** | 41.9% |
| stock 24h, beat class | 43 | 804 | 37.7% | 44.8% | 41.5% | **41.7%** | 37.9% |
| stock 24h, trailed class | 46 | 806 | 37.7% | 29.0% | 34.3% | **34.3%** | 37.9% |
| crypto 168h, beat class | 7 | 180 | 47.2% | 55.1% | 50.1% | **45.0%** | 44.2% |
| crypto 168h, trailed class | 9 | 140 | 47.2% | 31.4% | 43.7% | **31.0%** | 44.2% |
| stock 168h, beat class | 14 | 166 | 44.4% | 52.6% | 47.3% | **42.2%** | 44.3% |
| stock 168h, trailed class | 17 | 167 | 44.4% | 36.9% | 41.8% | **45.1%** | 44.3% |

Every "beat class" group did worse than its own record, by 3.1 to 10.4 points,
and the shrunk forecast was closer in all four. Measured against its class in
2025-26, the stock 24h winners kept about half their lead (+3.8 of +7.1
points); the other winners kept almost none (+0.9, +0.8 and -2.1 points).
The laggards split by class: crypto laggards kept most of their gap (-6.0 of
-7.5 and -13.2 of -15.8 points), stock laggards kept less than half (-3.6 of
-8.7) or none (+0.8 of -7.5).

What this means for the code as it stands:

- **Published confidence is already safe from it.** `currentSignalConfidence`
  takes the lower of the class-level bound and the asset's bound, so a lucky
  asset record cannot raise a published number.
- **Which assets pass, and the "proven" badge, are exposed to it.** Both read
  the raw record. An asset that looks proven on its own history keeps, on this
  evidence, between none and half of its lead over its class.

The recommended change is to shrink the asset's composite record toward its
class (prior about 300 outcomes) before it can promote an asset: the badge,
and the asset side of the gate. Raw records would still be allowed to demote,
which the crypto laggards support. It was not shipped here because it changes
which calls get published, and it should first be run walk-forward on the hit
rate of the calls it would publish.

**Decision, 2026-09-28: not shipped.** The rule from here on: an asset's own
estimate is pulled toward its class only where the class shows a clear,
consistent pattern *and* a walk-forward test shows the pooled version is better
for the model. The three pooled corrections above each passed that test before
they shipped:

- the class-calibrated size candidates reach production only by beating the
  incumbent on forward evidence;
- the class factor on the volatility band fixed its calibration (1.36 to 1.01
  for crypto, 1.17 to 1.04 for stocks);
- the 400-outcome prior on technique weights beat both extremes on live
  outcomes, in both directions of the split.

This one did not pass. The class pattern was mixed: stock winners kept about
half their lead, while crypto laggards kept most of their gap. And its effect
on the calls it would publish was never measured. Raw per-asset composite
records stay as they are unless that walk-forward test shows the shrunk version
publishes better calls.

## What changed in code

- `scripts/model-tournament.py`: `calibrated='shrunk'` scale candidates for all
  six base sources; `log_scale_estimate`, `pool_scales` (DerSimonian-Laird),
  `shrunk_scale`; `Tournament.calibration_pool` and `pool_for`, built per fit
  date from matured labels. Four new tests in `test-model-tournament.py`.
- `worker.js` (and `src/worker.js`): `bandCalibrationSample`,
  `applyBandCalibration`, `bandVolPct` feeding every `predictedRange` call,
  `bandCalibration` in the payload; `RELIABILITY_PRIOR_SAMPLES` 12 to 400.
  Band and prior tests in `test-worker.mjs`.
- Not changed: the hierarchical regression (research-only), per-asset model
  selection (the forward promotion rule already guards it), and per-asset
  composite records (section 6, waiting on a decision).

## Reproducing

Scripts and their outputs are in `docs/research-2026-09-27-overfitting/`. The
large inputs (the 250 MB research panel, the 310 MB tournament input, and the
walk-forward forecasts) are rebuilt from production's own tools, as described
in that folder's README.
