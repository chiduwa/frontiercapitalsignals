# Classic forecasting models, per asset and market-wide

2026-09-28. The question: would Holt-Winters, naive Bayes, decision stumps
and their bagged and boosted ensembles, random forests, simple exponential
smoothing, Holt's trend-corrected smoothing, multiplicative (triple)
Holt-Winters, automated ETS, Monte Carlo prediction intervals, feature
engineering and data balancing, statistical validation for regression,
classification metrics and forecast-error diagnostics make this project's
forecasts more accurate, reliable, timely and precise, for single assets or
for the market as a whole?

Short version:

| technique | what it did here | outcome |
| --- | --- | --- |
| naive Bayes | worse than the base rate for every asset, and badly overconfident | not used |
| decision stumps; bagged; boosted (AdaBoost, gradient) | no asset beat its base rate after correction | not used |
| random forest, with or without class balancing | the same | not used |
| Holt and Holt-Winters on price | no direction edge; negative out-of-sample R² | not used |
| SES, Holt, Holt-Winters (additive, multiplicative, triple), automated ETS | none beat GARCH + weekday on move size | not used |
| one model for a whole class, and the market's own indexes | no direction edge anywhere; a pooled base rate helps slightly | not used |
| **Monte Carlo and empirical-quantile intervals** | the +-1 sd range contained 75% to 83% of moves while claiming 68% | **shipped: ranges sized to what really contains 68%** |
| **Monte Carlo for the buying time** | revealed the arcsine law, which beats every count-based timing model with no data | **shipped as tournament candidates**, with a caveat on what timing can save |
| feature engineering | compact engineered inputs cut naive Bayes's damage; no edge | not used |
| data balancing | nudged balanced accuracy; never helped Brier or log loss | not used |
| statistical validation for regression | the in-sample robust test passes 11% to 87% of fits that mostly lose out of sample | documented; decisions stay out-of-sample |
| classification metrics | AUC 0.46 to 0.52; calibration slopes near zero or negative | documented |
| forecast-error diagnostics | live ranges over-cover; tournament too young to judge | fixed through the ranges |

Across 4,175 tests corrected together, not one per-asset direction or size
comparison survived. The useful results came from the uncertainty side:
honest range widths, and a closed-form model of when a price's daily low
falls.

## How it was tested

Everything ran inside the harness the sequence-model study used
(`tracked-research.py` folds and bootstrap, `SEQUENCE_MODELS.md`), so every
number compares with that study:

- **Assets:** the model tournament's 81 (40 coins, 41 stocks), plus the market
  as a whole: an equal-weight index of the 40 coins, one of the 41 stocks
  (both built by the same row builder, so they carry the same features and a
  GARCH + weekday forecast), and SPY.
- **Test:** the last 720 days (2024-10-06 to 2026-09-25), untouched,
  walk-forward: refit every 28 days on at most 730 earlier labels, the last 60
  (20 at a week) held out for validation and purged. Horizons 1 and 7 days
  for coins, 1 and 5 sessions for stocks. Multi-day outcomes are
  non-overlapping.
- **Scores:** direction by Brier against the asset's own base rate, plus log
  loss, AUC, balanced accuracy, MCC and the calibration slope; size by mean
  absolute error against GARCH(1,1) + weekday (the size champion) and by
  QLIKE (the tournament's score); ranges by coverage and the interval score.
- **Inference:** paired circular block bootstrap (7-day blocks at a day, 2 at
  a week). Holm (no false positive anywhere at 5%) and Benjamini-Hochberg (at
  most 5% of passes false) across 4,175 tests in one family.
- **No look-ahead, tested:** `test-classic-models-research.py` checks that
  removing later rows never changes an earlier forecast, per asset and for the
  class-wide models. It caught one real leak on the way (the smoothing's
  variance floor had been taken from the whole series), and every size result
  below comes from the corrected rerun. The smoothing filter reproduces
  statsmodels' own fitted values and forecasts to 1e-8 for all six ETS forms.

The families, as configured:

| family | configuration |
| --- | --- |
| naive Bayes | Gaussian, on every input (the tabular set plus calendar), and on a compact engineered set (momentum and volatility, 14 inputs) |
| decision stump | one split, at least 5% of rows per leaf |
| bagged stumps | 200 stumps on 80% bootstrap samples |
| boosted stumps | AdaBoost (SAMME) and gradient boosting, depth-1 trees, stage count chosen on the purged validation block, refit on train + validation |
| random forest | 300 trees, at least 25 rows per leaf, sqrt features; and the same with balanced class weights |
| data balancing | the random forest and the logistic regression with balanced class weights |
| Holt / Holt-Winters on price | damped trend, and damped trend + weekday season, on log price; P(up) from the forecast change over its residual sd |
| exponential smoothing on size | on the daily squared return: simple (SES, which is EWMA with its weight fitted), Holt's damped trend, additive Holt-Winters (weekday season), multiplicative Holt-Winters, triple (damped trend x multiplicative season) |
| automated ETS | the five above, chosen per asset and refit by AICc |
| combination | geometric mean of GARCH + weekday and the automated ETS pick |
| class-wide models | logistic, naive Bayes, random forest, AdaBoost and gradient-boosted stumps fitted on every asset of the class at once, scored per asset |

## 1. Direction: naive Bayes, stumps, bagging, boosting, random forests

Brier improvement over each asset's own base rate, 720 untouched days. A cell
is one asset at one horizon. "Better" counts cells with a positive mean before
any correction; no cell of any family survived Holm or Benjamini-Hochberg.

| family | crypto 1d | crypto 7d | stocks 1d | stocks 5d |
| --- | ---: | ---: | ---: | ---: |
| logistic (reference) | 0 / 40 | 2 / 39 | 0 / 41 | 0 / 41 |
| naive Bayes | 0 / 40 | 0 / 39 | 0 / 41 | 0 / 41 |
| naive Bayes, compact inputs | 0 / 40 | 0 / 39 | 0 / 41 | 0 / 41 |
| decision stump | 0 / 40 | 1 / 39 | 1 / 41 | 2 / 41 |
| bagged stumps | 7 / 40 | 10 / 39 | 10 / 41 | 8 / 41 |
| AdaBoost stumps | 0 / 40 | 4 / 39 | 0 / 41 | 0 / 41 |
| gradient-boosted stumps | 2 / 40 | 7 / 39 | 1 / 41 | 0 / 41 |
| random forest | 5 / 40 | 16 / 39 | 9 / 41 | 11 / 41 |
| random forest, balanced | 8 / 40 | 15 / 39 | 9 / 41 | 15 / 41 |
| logistic, balanced | 0 / 40 | 0 / 39 | 0 / 41 | 1 / 41 |
| Holt on price | 9 / 40 | 13 / 39 | 15 / 41 | 17 / 41 |
| Holt-Winters on price | 2 / 40 | 12 / 39 | 1 / 41 | 16 / 41 |
| **passes after correction** | **0** | **0** | **0** | **0** |

The median cell is worse than the base rate for every family in every slot.
The ones that come closest (bagged stumps, random forests, Holt on price) do
so by staying near the base rate, not by finding anything. Every family's
median AUC sits between 0.46 and 0.52, where 0.50 is a coin, and their
calibration slopes are near zero or negative, where 1 is a well-scaled
forecast.

What the classification metrics add:

- **Naive Bayes is the worst probability model tested.** Its independence
  assumption counts the same information once per correlated input, so its
  probabilities are extreme: log loss was 0.42 to 1.48 nats per call worse
  than the base rate (0.69 is a coin). Hit-rate metrics hide this; log loss
  and Brier do not. Engineering the inputs down to 14 momentum and volatility
  measures cut the damage by a half to three quarters and still lost
  everywhere.
- **Balancing the classes does what it is built to do and no more.** Balanced
  class weights nudged balanced accuracy and MCC up slightly (crypto 1d
  logistic: balanced accuracy 0.504 -> 0.509, MCC +0.009 -> +0.018) and never
  improved Brier or log loss. The up/down split is mostly mild (a median of
  50% up, 36% to 68% at the extremes), and a proper score is exactly what
  reweighting distorts.
- **Holt and Holt-Winters on price** extrapolate trend and weekday seasonality
  of the price itself. Their signed forecasts had negative out-of-sample R² in
  most cells (median -0.2% to -2.9%), the same answer the sequence study got
  from SARIMA.

## 2. Size: exponential smoothing up to automated ETS

Each form smooths the daily squared return, a variance proxy, and forecasts
the variance of the next h days; the forecast is then scaled on training rows
exactly as the GARCH + weekday benchmark is. Cells (asset x horizon) where the
model beat GARCH + weekday before correction, by MAE and by QLIKE, and the
median QLIKE difference (negative = worse than GARCH):

| model | crypto 1d (of 40) | crypto 7d (of 39) | stocks 1d (of 41) | stocks 5d (of 41) |
| --- | --- | --- | --- | --- |
| simple (SES) | 11 / 4, -0.079 | 11 / 7, -0.105 | 10 / 10, -0.033 | 16 / 16, -0.019 |
| Holt, damped trend | 8 / 6, -0.065 | 13 / 10, -0.126 | 8 / 12, -0.032 | 13 / 18, -0.008 |
| Holt-Winters, additive | 8 / 2, -0.276 | 13 / 5, -0.158 | 8 / 6, -0.106 | 16 / 16, -0.008 |
| Holt-Winters, multiplicative | 5 / 3, -0.139 | 6 / 2, -0.246 | 4 / 3, -0.150 | 9 / 11, -0.035 |
| triple (damped trend x multiplicative season) | 2 / 0, -0.639 | 3 / 5, -0.690 | 0 / 0, -0.552 | 1 / 3, -0.406 |
| automated ETS (AICc) | 5 / 3, -0.086 | 13 / 7, -0.143 | 4 / 4, -0.086 | 14 / 16, -0.025 |
| GARCH + weekday x automated ETS (geometric mean) | 14 / 14, -0.010 | 19 / 11, -0.030 | 15 / 13, -0.015 | 26 / 21, +0.002 |
| **passes after correction** | **0** | **0** | **0** | **0** |

GARCH + weekday stays the size model to beat. The richer the smoothing, the
worse it did: the triple form was the worst in every slot, and the weekday
season cost more than it gave in three of the four (additive Holt-Winters beat
SES only for stocks at a week). GARCH + weekday already carries the weekday,
and it models volatility clustering, which smoothing only approximates.

**Automated ETS chose by AICc, and chose wrong.** Across 3,887 refits it
picked multiplicative Holt-Winters 1,862 times, SES 1,033, the triple form
410, Holt 400 and additive Holt-Winters 182. The in-sample favourite, the
seasonal multiplicative form, did worse out of sample than plain SES in all
four slots (median QLIKE against GARCH). That is the same lesson as
`MODEL_OVERFITTING.md`: a choice made on in-sample fit, per asset, loses to a
fixed simple one.

The blend of GARCH + weekday with the automated pick came closest, and for
stocks at a week it edged ahead on the median (26 of 41 cells by MAE), too
little to survive correction.

The market series tell the same story: the best was the blend on the crypto
index at a day (+0.052 QLIKE, p 0.033 before correction, 1.0 after).

## 3. The market as a whole

**One model for every asset of a class** (the global, cross-learning approach
that won the M4 and M5 forecasting competitions), fitted every 28 days on all
40 coins or all 41 stocks at once and scored on each asset. Brier improvement,
averaged per date first:

| model | crypto 1d | crypto 7d | stocks 1d | stocks 5d |
| --- | --- | --- | --- | --- |
| class base rate, vs each asset's own | -0.09e-3 (p 0.70) | +4.91e-3 (p 0.18) | +0.30e-3 (p 0.06) | +1.19e-3 (p 0.10) |
| random forest, vs own base rate | -0.52e-3 (p 0.78) | +2.38e-3 (p 0.32) | -0.63e-3 (p 0.94) | -0.97e-3 (p 0.72) |
| gradient-boosted stumps | -0.51e-3 (p 0.77) | +2.69e-3 (p 0.30) | +0.00e-3 (p 0.51) | -0.24e-3 (p 0.58) |
| logistic | -3.37e-3 | -11.61e-3 | -2.29e-3 | -6.87e-3 |
| AdaBoost stumps | -10.61e-3 | -15.34e-3 | -41.62e-3 | -28.51e-3 |
| naive Bayes | -37.85e-3 | -140.33e-3 | -17.45e-3 | -28.05e-3 |

Against the class's own base rate every model is worse. What pooling does buy
is a better base rate: the class's up-rate beat each stock's own at one
session (p 0.06) and at five (p 0.10), the same lesson as
`MODEL_OVERFITTING.md` in its plainest form.

**The market's own series.** An equal-weight index of the 40 coins, one of
the 41 stocks, and SPY, each run through every family as if it were an asset:

| series | best direction family vs base rate | p |
| --- | --- | ---: |
| crypto index, 1 day | Holt on price, -0.13e-3 | 0.54 |
| crypto index, 7 days | balanced random forest, -1.07e-3 | 0.59 |
| stock index, 1 session | bagged stumps, +0.18e-3 | 0.45 |
| stock index, 5 sessions | logistic, +3.38e-3 | 0.37 |
| SPY, 1 session | balanced random forest, -0.64e-3 | 0.60 |
| SPY, 5 sessions | Holt-Winters on price, -2.35e-3 | 0.60 |

No series, no horizon, no family: the market's direction is no more
forecastable from these inputs than a single asset's.

## 4. Prediction intervals: Monte Carlo and empirical quantiles

The band a reader sees (`predictedRange`, 'historical' basis) is plus or minus
one standard deviation of the asset's own past moves, declared a 68% interval
(`RANGE_NOMINAL_COVERAGE`). A plus-or-minus-one-sd interval contains 68% only
for normal moves. These are fat-tailed.

**Rebuilt on the engine's own calls.** Every composite call confluence-v9 has
made, replayed and live, with its score, direction and realized move (457,943
calls, 2021 to 2026). Each asset's width was learned only from outcomes that
had matured before the call. Scored by coverage and the interval score, which
a forecaster minimizes only by quoting the true quantiles (Gneiting & Raftery
2007):

| class, horizon | +-1 sd: coverage | its width | 68% quantile width: coverage | its width | interval score |
| --- | ---: | ---: | ---: | ---: | --- |
| crypto 1 day | 83.2% | 25.5% | 68.4% | 8.7% | 32.27 -> 18.88 |
| crypto 7 days | 81.5% | 36.2% | 68.7% | 22.3% | 49.78 -> 42.94 |
| stocks 1 day | 76.3% | 5.4% | 67.3% | 4.3% | 7.98 -> 7.77 |
| stocks 7 days | 75.1% | 11.7% | 69.6% | 10.3% | 17.32 -> 17.07 |

(The quantile band here has the shipped form, the asset's mean absolute move
times one class multiplier, the 68th percentile of |move| / mean |move|, with
the multiplier learned walk-forward from calls that had matured.)

On the 97% to 98% of assets whose history holds no glitch, the plus-or-minus-
one-sd band still covered 83%, 81%, 76% and 75%, so this is fat tails, not bad
data. The mean width of the crypto band is inflated by a few glitch-ridden
histories. On clean assets the quantile band is 37% narrower at one day for
crypto (12.8% -> 8.1%) and 19% narrower for stocks (5.0% -> 4.0%).

Variants tested on the same calls, all walk-forward:

- the asset's own 68th percentile of past |moves| (historical simulation):
  as good as the shipped design, but SQL cannot compute it cheaply;
- asymmetric percentiles (16th and 84th): no better than symmetric;
- a robust scale (median absolute deviation) times a class multiplier:
  slightly better for crypto, slightly worse for stocks;
- a more timely typical move (the last 60 daily or 12 weekly outcomes): worse
  for crypto (interval score 19.99 against 18.95 at a day), and blended with
  the long-run one about 1% better for stocks. With tails this fat, a short
  window is too noisy to track.

**The band's tilt toward the call does nothing.** Production shifts the band's
centre toward the called direction by up to half a width as the score rises.
Against a centred band, the interval score changed by -0.0002 (crypto, a day),
+0.0011 (crypto, a week), -0.0008 (stocks, a day) and -0.0055 (stocks, a week,
the only one whose interval excludes zero). It was left in place: it costs
almost nothing, and removing it changes what readers see for no measurable gain.

**Across the 81 assets, three volatility sources.** The same question on the
research panel (720 untouched days, 68% ranges). "Worker band" is the band as
it stood after 2026-09-27: 90-day volatility times the class's variance
factor. Quantile bands take the class's pooled 68th percentile of |move /
volatility|, refitted every 28 days on matured moves. Monte Carlo sums
bootstrapped one-day standardized moves over the horizon. Coverage, interval
score, and the improvement over the worker band (p from the paired bootstrap):

| | worker band | 90-day, quantile | EWMA, quantile | GARCH + weekday, quantile | GARCH + weekday, Monte Carlo |
| --- | --- | --- | --- | --- | --- |
| crypto 1 day | 78.6%, 14.72 | 68.8%, 14.26 (+0.47, p < 0.001) | 68.3%, 14.12 (+0.61, p < 0.001) | 68.5%, 14.00 (+0.67, p < 0.001) | (same as quantile at one day) |
| crypto 7 days | 79.5%, 43.19 | 67.0%, 41.53 (+1.47, p 0.009) | 66.2%, 41.50 (+1.50, p 0.027) | 66.9%, 40.80 (+1.89, p 0.002) | 72.5%, 41.19 (+1.57, p 0.002) |
| stocks 1 day | 77.2%, 8.89 | 67.6%, 8.66 (+0.23, p < 0.001) | 67.5%, 8.58 (+0.31, p < 0.001) | 65.7%, 8.57 (+0.31, p < 0.001) | (same as quantile) |
| stocks 5 days | 74.5%, 20.57 | 67.5%, 20.19 (+0.38, p 0.035) | 67.5%, 20.03 (+0.53, p 0.012) | 65.5%, 19.99 (+0.54, p 0.023) | 67.1%, 19.98 (+0.56, p 0.015) |

Every variance-matched band over-covered, and every quantile band hit its 68%
and scored better. Monte Carlo got there too, but no better than the direct
quantile, because summing fat-tailed days just recovers the h-day quantiles
the data already hold. At 95% the variance-matched bands were already right
(94.6% to 95.1%): fat tails widen the far tails as much as they pinch the
middle, so only the 68% band was mis-sized.

GARCH + weekday (the size champion) made the sharpest bands, EWMA next, the
90-day window last, but only by 1% to 2% of the score. The warm-up band keeps
the 90-day window for now: it is a fallback that is never shown, and that gain
is not worth a second change to it in two days.

**Shipped** (`worker.js`, `scripts/reliability.mjs`):

- The historical band is the asset's mean absolute move (a new
  `meanAbsPct` in `loadMoveStats`) times its class's multiplier for that
  horizon, where the multiplier is the 68th percentile of |move| / mean |move|
  over the class's last two years of closes, recomputed every build
  (`applyBandCalibration`). On the archive's clean assets that is x1.08 (1 day)
  and x1.11 (7 days) for crypto, x1.13 and x1.19 for stocks. On the engine's
  calls those multipliers give 72.1%, 72.4%, 67.5% and 70.3% coverage (72.5%,
  74.9%, 64.1% and 66.5% over the last year), against 83%, 82%, 76% and 75%
  before. The first live build (2026-09-28 09:19 UTC) set x1.08 and x1.16 for
  crypto (its coins have about a year of daily closes, not two) and x1.13 and
  x1.18 for stocks, which on the same calls give 72.1%, 74.3%, 67.5% and
  70.3%. A multiplier computed from the logged outcomes themselves would sit
  closer to 68%; that is a heavier query and was left for later.
- The volatility band (the warm-up fallback) keeps the 90-day window but its
  class factor is now the 68th percentile of |7-day move / (90-day volatility x
  sqrt 7)| instead of the root mean square: x0.82 for crypto and x0.92 for
  stocks on the archive, where the variance version gave x1.10 and x1.06.
- A class with fewer than 500 pooled moves keeps the old widths.

The published copy already calls the band "an empirical move interval", which
it now is. No range is published at the moment (every row is withheld by the
gates); the change shows first in the range record that the gate reads.

**Live check of the same thing.** `range_reliability`, every logged band
scored so far: crypto 74.1% (1 day) and 71.1% (7 days), stocks 72.2% and
76.8%, all above 68%. That record mixes the historical band with the
volatility band, which ran too narrow until 2026-09-27, so it sits below the
reconstruction of the historical band alone.

## 5. The buying time: Monte Carlo found a closed form

The tournament's `timing:2` slot forecasts which of six 4-hour opens (00, 04,
..., 20 UTC) will be the day's cheapest, scored by log loss. Its candidates
count how often each slot was cheapest over 30, 90 or 365 days. Tested with
the tournament's own walk-forward on its own 4-hour data (13,357 scored
coin-days over the last 360 days), log loss (lower is better; uniform is
1.7918):

| model | log loss | vs uniform |
| --- | ---: | ---: |
| uniform (in force) | 1.7918 | |
| window count, 30 / 90 / 365 days | 1.7935 / 1.7515 / 1.7379 | -0.002 / +0.040 / +0.054 |
| window count by weekday, 30 / 90 / 365 days | 1.8286 / 1.8036 / 1.7637 | -0.037 / -0.012 / +0.028 |
| exponential smoothing of the counts, half-life 14 / 45 / 120 days | 1.7690 / 1.7451 / 1.7372 | +0.023 / +0.047 / +0.055 |
| Holt-Winters on 4-hour prices + Monte Carlo | 1.7773 | +0.015 |
| Monte Carlo random walk (no drift, no history) | 1.7377 | +0.054 |
| **arcsine law** (exact, no data at all) | **1.7335** | **+0.058** |
| arcsine law updated by the coin's record (Dirichlet, 100 days, half-life 120) | 1.7333 | +0.059 |

The Monte Carlo walk did as well as the best window count while learning
nothing, which pointed at the reason. For a driftless walk with symmetric
steps, where the lowest of n equally spaced points falls is distribution-free
(Sparre Andersen's theorem): the discrete arcsine law, C(2k,k) C(2(n-1-k),
n-1-k) / 4^(n-1). For six opens: 24.6%, 13.7%, 11.7%, 11.7%, 13.7%, 24.6%. The
observed shares were 23.8%, 12.1%, 10.7%, 11.9%, 15.9% and 25.7%. The
exact law beats every model that counts, and a coin's own history adds
0.0002.

Holt-Winters' intraday seasonal drift made the simulation worse, and every
weekday variant did worse than its plain count: both fit noise.

**What the law also says.** The first and last opens are more often the
dearest too (26.1% and 22.8%). Measured directly over 13,323 coin-days, every
slot's open sat within noise of the day's average open (-5.5 to +7.5 basis
points, each interval spanning zero). So this slot predicts which open will
be lowest, but buying there would not lower the average price paid.

**Shipped** (`scripts/model-tournament.py`): two timing candidates, the
arcsine law and the arcsine law updated by the coin's record. They are
screened and promoted like any candidate, only on forward evidence.
`MODEL_TOURNAMENT.md` now says the spot bot should not be steered by this
target. If timing is ever wired, it should score the price paid against the
day's average.

## 6. Statistical validation for regression

The per-asset regression (hierarchical-mlr-v4, research-only) reports a joint
Wald test with HAC (Newey-West) standard errors on non-overlapping rows, which
is the textbook robust choice. Against its own out-of-sample record
(2026-09-27 audit):

| lane | fits | "significant" at 5% | with the small-sample F version | out-of-sample R², significant / not | beats zero, significant / not |
| --- | ---: | ---: | ---: | --- | --- |
| crypto 1 day | 335 | 39.7% | 38.8% | -0.82% / -1.67% | 34% / 10% |
| crypto 7 days | 201 | 86.6% | 86.6% | -3.31% / -3.51% | 11% / 0% |
| stocks 1 day | 291 | 10.7% | 10.0% | -0.89% / -1.69% | 13% / 4% |
| stocks 5 days | 291 | 36.4% | 34.0% | -0.33% / -1.52% | 45% / 21% |

With nothing to find, about 5% of fits should pass. The test passes 11% to
87%, while 55% to 89% of the passing fits still lose to forecasting zero. The
F correction barely moves it, so the problem is not the reference
distribution. It is many regressors on a few hundred points, and relationships
that do not survive the regime they were fitted in, which no standard error
can repair. In-sample significance carries a little information (passing fits
do somewhat better out of sample), but here it is not evidence that a model
works. The project already decides on out-of-sample evidence only (the
tournament's e-process, walk-forward screens), and this is why that rule
matters. No code changed; the p-value is not shown on the dashboard.

## 7. Classification metrics and forecast-error diagnostics

**Which metric decides.** A probability forecast should be judged by a proper
score, Brier or log loss, which only the honest probability minimizes. The
tournament already promotes on Brier (direction), QLIKE (size) and log loss
(timing). The other metrics earn their place as diagnostics, and here each one
told the same story from a different side:

- AUC 0.46 to 0.52 (per-family medians): no family ranks up days above down
  days better than a coin.
- Balanced accuracy and MCC: within about 0.02 and 0.06 of a coin for every
  family (medians 0.48 to 0.52, and -0.06 to +0.04).
- Calibration slope (a logistic fit of the outcome on the forecast's log
  odds; 1 is well scaled): near zero or negative for every family, so what
  little they say is too extreme. That is the classic signature of fitting
  noise.
- Log loss, not hit rate, is what exposed naive Bayes (section 1).

**Diagnostics on what production logs.**

- *Ranges:* the live range record contains the price 71% to 77% of the time
  against a declared 68% (section 4). Fixed.
- *Tournament forecasts:* 5 days of scored forward forecasts so far (976
  direction, 2,371 size and 752 timing outcomes at the shortest horizons), too
  few to diagnose. The e-process only needs its own record, and no model has
  been promoted.
- *The regression's significance tests:* over-reject badly (section 6).

## What changed in code

- `scripts/model-tournament.py`: a timing family, `arcsine`: the exact law
  (`arcsine_law()`) and the law updated by the coin's own record. Three tests
  in `test-model-tournament.py`, and the existing no-look-ahead test covers it.
- `worker.js` (and `src/worker.js`): band widths by coverage.
  `bandCalibrationSample` also returns each asset's standardized moves and its
  typical-move ratios; `applyBandCalibration` pools them per class into the
  68th-percentile volatility factor (`bandVolPct`) and the historical
  multipliers (`bandHistK`); `predictedRange` uses mean |move| x multiplier
  whenever both exist. The payload's `bandCalibration` now reports the factor,
  its old variance counterpart, and each class's historical multipliers with
  their sample counts. Tests in `test-worker.mjs`.
- `scripts/reliability.mjs`: `loadMoveStats` returns `meanAbsPct`.
- `scripts/classic-models-research.py` (research only, `actionable: false`)
  with `test-classic-models-research.py`, run daily in
  `signals-model-tournament.yml`.
- Docs: this page, `MODEL_TOURNAMENT.md` (the timing candidates, and why the
  spot bot should not be steered by that target), `README.md`.

Not changed, on this evidence: every direction model, every size model, the
class-wide models and the band's tilt.

## Reproducing

Scripts, inputs and each script's output: `docs/research-2026-09-28-classic-models/`.
