# Per-asset multiple regression: the model, and what it is allowed to claim

This describes `hierarchical-mlr-v1` — a per-asset multiple regression with
partial pooling, added alongside confluence, the cross-sectional lane and
`adaptive-ridge-v1`. It replaces nothing. It authorizes no orders, changes no
existing trade weight, and publishes no direction.

## The problem it was built for

Two established results in this project pull in opposite directions.

`adaptive-ridge-v1` fits each asset separately and shrinks it toward **zero**,
with a fixed ridge penalty of 20 over 8 price/volume columns. Shrinking toward
zero is a claim: it says the best prior for an asset with little history is
"this feature does nothing." That discards the pooled signal, which
`PREDICTION_WEIGHTS_EVIDENCE.md` measured and found real — a 60-minute
composite spreading 0.0873% at t=5.66 over 4,307 non-overlapping observations.

At the same time, that same document closed the door on per-asset weighting.
The correlation between a symbol's first-half information coefficient and its
second-half IC is **−0.036**. Both extreme quintiles revert to the universe
mean. Restricting the book to the best-scoring quintile returned the same
0.0867% spread as all 148 symbols. Between-asset dispersion is larger than
sampling noise (0.0284 vs 0.0062), so assets genuinely differ — but *which*
assets does not carry forward.

So: pooling throws away real per-asset differences, and per-asset fitting
reliably fits luck. Choosing one by hand is how the last several models here
were wrong.

## The estimator

Empirical Bayes resolves this by not choosing. For each feature *j*, the
between-asset variance τ² is estimated across the class by DerSimonian-Laird,
and each asset's coefficient is shrunk toward the class value by a weight
computed from its own precision:

```
lambda_ij = tau^2_j / (tau^2_j + se^2_ij)
beta_ij   = mu_j + lambda_ij * (beta_ij - mu_j)
```

The behaviour at the limits is the point:

- **τ² → 0** (spread is indistinguishable from sampling noise): λ → 0, and every
  asset receives the pooled class coefficient. The model learns per asset
  *nowhere*, automatically, without anyone deciding that.
- **τ² large, asset measured precisely**: λ → 1, and the asset keeps its own
  coefficient.
- **τ² large, asset measured noisily**: λ small, and it is pulled back to the
  class regardless of how extreme its own estimate looked.

λ is reported per asset per feature, and I² — the share of observed spread that
is real rather than noise — is reported per feature. **The question "does this
asset deserve its own model" now has a measurement attached instead of an
assumption.** A low λ is a finding, not a failure to fit.

## The regressors

One dependent variable per asset: its own forward return over the horizon,
normalized by the volatility known at the anchor. 29 candidate columns across
seven lanes, so a lane can be tested as a group rather than argued about:

| lane | columns |
|---|---|
| momentum | `return1` `return5` `return20` `return60` `trendGap` |
| volatility | `volRatio` `volOfVol` `downsideShare` |
| volume | `volumeRatio` `volumeTrend` |
| market | `market5` `market20` `relative5` `beta60` |
| range | `rangePosition` `drawdownFromHigh` `dwellShare` |
| derivatives | `oiChange1` `oiChange7` `oiPercentile` `oiPriceDivergence` `takerRatio` `accountLsChange` |
| supply | `supplyGrowth30` `supplyOverhang` |

Plus an intercept and one availability indicator per optional lane.

**A missing lane is never a silent zero.** Filling an absent measurement with
zero tells the regression it was measured and came out average. Each optional
lane carries a `<lane>Missing` indicator instead, which absorbs the level
difference so the lane's own coefficients are estimated only over the period
where the lane exists. These indicator coefficients are frequently significant
— derivatives coverage begins in 2023 — and they are **controls, not findings**.
They are excluded from the heterogeneity headline for that reason.

## What makes the inference survivable

Each of these exists because a specific measurement in this project was wrong
without it:

- **Non-overlapping observations only.** A 7-day forecast sampled daily shares
  six days of its target window with its neighbour. Counting those as separate
  trials is the `confluence-v6` defect.
- **Newey-West HAC standard errors** over the residual serial correlation that
  remains.
- **Clustering by decision date** in the panel summary. `PREDICTION_WEIGHTS_EVIDENCE.md`
  records pooled quintiles that looked significant at an inflated t until
  exactly this was applied.
- **Benjamini-Hochberg across the whole sweep.** One regression per asset over
  ~500 assets is thousands of coefficient tests; at the nominal rate, dozens
  look significant by construction.
- **Three blind column reductions, in order**: constants, then exact linear
  dependence by Gram-Schmidt, then variance inflation. The middle step is not
  optional — a perfectly dependent column makes *every* VIF auxiliary
  regression singular, so VIF returns null for everything, nothing is pruned,
  and the fit dies as `singular-design`. That is not hypothetical: BTC
  benchmarked against BTC makes `market5` identically `return5` and `relative5`
  identically zero, and it failed exactly this way before the pass was added.
- **Bar sanitation.** `asset_daily_bars` contains corrupt rows. One
  non-positive close makes a log return −Infinity, which reaches X'X and kills
  the asset's fit with an error that names no symbol.
- **Residual diagnostics reported, not just fit**: Durbin-Watson, Ljung-Box,
  Breusch-Pagan, Jarque-Bera, AIC/BIC, VIF, and out-of-sample R² against the
  zero-return forecast.
- **Nested Wald test per lane**, using the same HAC covariance as the
  coefficient table, so the two cannot disagree about the same numbers. Lane
  significance counts are always printed against the count expected under the
  null, because 5% of tests land under 0.05 by construction.

## Two passes, and only one of them is a forecast

`INFERENCE` fits the full sample. It describes what an asset's history
co-moved with. **It is not out-of-sample evidence and is labelled as such
everywhere it is written down.**

`PREDICTION` is walk-forward. At each date: mature outcomes train the
accumulators, then coefficients are re-solved on a cadence, then pooled, then
shrunk, and only then is a forecast produced. Nothing in scope had happened
later than the anchor. A regression test asserts this directly — appending 300
later bars must leave every earlier forecast bit-identical.

Two structural traps were hit while building the walk-forward loop, both
deadlocks, and both are now regression-tested:

1. Queuing training rows only when the model was ready to predict. No forecast
   meant no queued row, which meant no training, which meant no forecast.
2. Recording residuals only for scored forecasts, while scoring required an
   interval built *from* those residuals.

Both produced a silent zero-observation run rather than an error.

## Verification

`test-regression-diagnostics.mjs` (14 tests) checks every estimator against a
closed form it must satisfy exactly — the t, F and χ² tails against their
distributional identities rather than transcribed table values, HAC at zero
lags against White/HC1, clustered errors against a fixture of duplicated
observations, and Benjamini-Hochberg's false-discovery rate as an expectation
over 200 replications. **It found two real bugs in this file's own math**: a
garbled continued fraction in the incomplete beta, and a missing factor of two
in the χ² tail.

`test-hierarchical-model.mjs` (17 tests) covers the model. The one that matters
most is `the panel does not invent per-asset structure in a homogeneous
universe`: 24 assets generated from a single shared coefficient, where the
learner must report I² near zero and cluster every asset's coefficient
together. Its counterpart — 24 assets split into genuinely trending and
mean-reverting halves — requires the split to be found and to survive shrinkage.
A model that passes only one of those two is useless.

## First full run: 569 assets, 717,167 bars, from 2021-01-01

Deterministic — the same input hash reproduces the same run ID and the same
numbers, so a retry is idempotent rather than a second sample.

### Per-asset learning survives in exactly one place

| Class / horizon | Mean shrinkage (final) | Features that earned their own coefficients |
|---|---:|---|
| crypto 1d | 0.0425 | `oiChange1` (I²=67%), `oiChange7` (I²=33%), `return1` (I²=28%) |
| crypto 7d | 0.0000 | **none** |
| stock 1d | 0.0000 | **none** |
| stock 5d | 0.0000 | **none** |

At three of the four class/horizon pairs, **no feature's between-asset spread
exceeds sampling noise**, so every asset is handed its class coefficient. This
reproduces `PREDICTION_WEIGHTS_EVIDENCE.md` by an entirely different route —
that study fitted per-symbol ICs on a 5-minute panel and found first/second-half
correlation of −0.036; this one estimates τ² directly on daily bars and gets
zero. Two methods, same conclusion.

The exception is worth noting. The only surviving heterogeneity is in the
open-interest columns at the daily horizon — and the cross-sectional lane's only
selected feature was also open-interest based (`oi_px_divergence`, t=3.79
Newey-West). Two independent methods point at the same lane.

### Prediction has no edge, and the in-sample structure does not convert

Walk-forward, clustered by decision date:

| Class / horizon | Scored | Direction | OOS R² | Net %/period | Dates | t |
|---|---:|---:|---:|---:|---:|---:|
| crypto 1d | 300,591 | 49.80% | −0.00008 | +0.0164 | 1,979 | 0.08 |
| crypto 7d | 33,807 | 50.45% | −0.74137 | −0.5332 | 1,538 | **−2.98** |
| stock 1d | 349,503 | 50.18% | −0.01101 | −0.0453 | 1,326 | **−2.59** |
| stock 5d | 60,567 | 50.94% | −0.00476 | +0.0045 | 1,029 | 0.63 |

Out-of-sample R² is at or below zero in all four. Two are significantly
negative.

Against that, the full-sample lane tests look busy: at crypto 1d the
derivatives lane is significant for 60 assets against 9.8 expected under the
null, and the market lane for 69 against 13.2. **That structure is real
in-sample and does not convert out of sample.** The gap between those two
tables is the finding. It is not a tuning target, and the I² numbers above are
not a skill claim.

### A power caveat that must not be read as a result

At 7 days the online learner reports zero heterogeneity while the full-sample
fit sees plenty (`market20` at I²=70%). That is **low power, not homogeneity**:
non-overlapping sampling leaves roughly one seventh of the rows, the 365-day
half-life decays them further, standard errors grow, Q falls below its degrees
of freedom, and τ² pins to zero. Absence of detected heterogeneity at 7d says
nothing about whether it exists.

## v2: the ridge penalty was measuring the wrong thing (2026-09-18)

v1 added a flat constant to every diagonal of `X'X`. The columns are not on one
scale, so an identical constant is a wildly different penalty per column.
Measured over the crypto majors, with the 365-day half-life's effective weight
of ~527:

| column | mean square | share of the coefficient the flat ridge removed |
| --- | --- | --- |
| `supplyGrowth30` | 0.00004 | 99.6% |
| `oiPriceDivergence` | 0.0033 | 74.2% |
| `oiChange1` | 0.0045 | 67.7% |
| `oiChange7` | 0.030 | 23.8% |
| `return1` … `return60` | ~1.0 | ~0.9% |
| `drawdownFromHigh` | 14.6 | 0.06% |

The penalty landed hardest on precisely the features this lane exists to
measure. `oiChange1` and `oiChange7` are the two features v1 itself reported as
the only ones carrying real per-asset heterogeneity.

**The bias is confirmed against an unpenalized reference.** The inference pass
runs at `ridge = 0`. It reports `oiChange1` I² = **0.954**. v1's online learner,
on the same data, reported **0.70**; v2 reports **0.94**. The estimator now
agrees with the unbiased fit it is supposed to approximate.

v2 scales each column's penalty by its own decayed mean square, so the shrink is
`ridge/(weight + ridge)` for every column regardless of units — the usual
"standardize, then penalize" ridge, expressed on the sufficient statistics so no
second pass over the rows is needed and coefficients stay in natural units.
`test-hierarchical-model.mjs` pins the identity: rescaling a column by `c` must
scale its coefficient by exactly `1/c` and move nothing else. Under a flat ridge
a column whose true coefficient is 60 comes back below 5.

### What changed, and what did not

At crypto 1d the detected heterogeneity changes substantively:

| | v1 (flat) | v2 (scale-invariant) |
| --- | --- | --- |
| `oiChange1` | I²=0.70 | I²=0.94 |
| `return1` | I²=0.30 | I²=0.38 |
| `oiPriceDivergence` | not detected | I²=0.23 |
| `oiChange7` | I²=0.35 | dropped |
| mean shrinkage | 0.0444 | 0.0507 |

`oiPriceDivergence` was the second-most-penalized column and was invisible in
v1. It is also the only feature the cross-sectional lane selected independently
(t=3.79). Two unrelated methods were agreeing on open-interest/price divergence;
the flat penalty was suppressing the agreement on this side.

**Prediction is unchanged: there is still no edge.** Walk-forward, clustered by
decision date, over four lanes and two estimators, plus a penalty-strength sweep
at 5/25/100/400:

| lane | v1 t | v2 t | v1 OOS R² | v2 OOS R² |
| --- | --- | --- | --- | --- |
| crypto 1d | +0.17 | −1.32 | +0.0001 | −0.0003 |
| crypto 7d | −2.98 | −4.14 | −0.590 | −0.052 |
| stock 1d | −2.42 | −3.42 | −0.011 | −0.022 |
| stock 5d | +0.13 | −1.41 | −0.005 | −0.023 |

Three facts hold across every arm tested:

- **The point forecast never beats forecasting zero.** MAE exceeds the
  zero-return baseline in every lane, every estimator, every penalty strength.
- **Interval coverage stays in 0.7994–0.8116** against its 0.80 target while
  R², t and MAE swing around. The calibrated interval is the one output robust
  to the estimator, and the only part of this model worth consuming.
- **Per-asset learning still survives only at crypto 1d.** Shrinkage is exactly
  0 in the other three lanes under both estimators, so that result was never an
  artifact of the penalty.

### The penalty strength is deliberately not tuned

Raising the scale-invariant penalty monotonically improves the stock lanes'
headline metrics — stock 1d OOS R² goes −0.022 → −0.008 → −0.003 → −0.0008 at
ridge 5 → 25 → 100 → 400, and t rises −3.42 → −0.55. This is not a discovery.
As the penalty grows the predictions shrink toward zero, so every metric
converges to the null *by construction*; directional accuracy falls the whole
way, 0.4984 → 0.4958. On the stock lanes the model scores best exactly when it
predicts least, which is a statement about absence of signal.

Selecting a penalty on that sweep would be fitting the walk-forward the sweep
was measured on. The default stays at a single principled value — strength 5,
which leaves the well-scaled columns at the ~0.9% shrink they already had under
v1 — and the class sensitivity is recorded here rather than acted on.

## What it is not allowed to claim

- Walk-forward research over archived daily closes. Daily closes are not
  executable issue-time quotes. **This is not a live track record.**
- Costs are a flat round-trip assumption. Funding, borrow, market impact and
  venue spread are not modelled.
- The archive is not a survivorship-free point-in-time security master.
- `actionable: false`. The payload carries aggregate diagnostics only;
  per-asset forecasts stay in the snapshot tables. Publication still requires
  clearing the same evidence gate as every other call, on unseen forward
  outcomes.

Related: [[PREDICTION_WEIGHTS_EVIDENCE]], [[MODEL_IMPROVEMENT_2026_09_14]],
[[CROSS_SECTIONAL_EVIDENCE]], [[DERIVATIVES_EVIDENCE]]
