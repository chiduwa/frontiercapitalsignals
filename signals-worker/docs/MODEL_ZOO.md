# The candidate field: what each model is actually good at

`scripts/model-zoo.mjs`, `model-zoo-v1`. Additive, `actionable: false`, promotes
nothing. Runs inside the daily hierarchical research job and is reported per
lane under `prediction["<class>|<horizon>"].zoo`.

## Why it exists

On 2026-09-18 a combination rule — the two return models agreeing on sign AND
both forecasting a move over 0.5% — produced this on 34,592 crypto forecasts:

- 53.66% directional accuracy, t = **6.20**, clustered by decision date
- monotone in conviction: 50.6% → 53.7% → 56.4% → 61.0% as the threshold rose
- present in **both** halves of history (t = 3.13 early, 6.15 late)

It passed every persistence test this project had. It was still false.

| cohort | net after costs | t | 2026 hit rate | t |
| --- | --- | --- | --- | --- |
| all assets | +0.947 | 3.08 | 0.6258 | 13.60 |
| **established** (listed before the window) | +0.518 | 1.52 | **0.5099** | **0.58** |
| liquid ≥ $10M/day | **−0.015** | **−0.12** | 0.6646 | 11.37 |
| deep ≥ $100M/day | +0.017 | 0.11 | 0.7181 | 10.37 |

An asset is in the panel because it survived to today. That conditions its
history on success, and the distortion is worst for the recently listed — the
crypto panel grew from 249 to 295 assets across 2026 alone. Restricted to assets
that already existed when the window opened, the entire 2026 effect disappears.
On assets anyone could actually trade, the money is exactly zero.

Two rules follow, and this module enforces both.

## Rule 1: direction and magnitude are different skills

Measured on the same 311,088 crypto 1-day forecasts, established cohort:

| model | claims | direction hit | net t | magnitude ρ | MAE on \|move\| |
| --- | --- | --- | --- | --- | --- |
| zero | magnitude | — | — | — | 3.8003 |
| trailingVol | magnitude | — | — | 0.2952 | 3.7362 |
| ewmaVol | magnitude | — | — | 0.3359 | 3.6118 |
| **harVol** | magnitude | — | — | **0.3464** | **3.1791** |
| momentum | direction | 0.4823 | −2.86 | — | — |
| reversal | direction | 0.5165 | −0.66 | — | — |
| hierarchical | both | 0.5000 | −2.47 | 0.1997 | 3.3605 |
| adaptive | both | 0.4953 | −0.99 | 0.1900 | 3.3823 |

- **A plain volatility model beats the 29-feature regression at magnitude**, and
  HAR beats everything: ρ 0.346 against 0.200, and a 16% lower absolute error
  than forecasting no move at all. This is the only place in the project where
  something beats its null.
- **Nothing has tradeable direction.** Every net-of-cost t is negative.
  `reversal` is the honest curiosity: 51.65% is genuinely above chance
  (t = 3.14 on the hit rate) but its net t is −0.66. The effect is real and
  smaller than the spread.
- **Combining them makes magnitude worse.** Out of sample, regressing \|move\|
  on volatility alone gives ρ 0.332; adding the regressions' \|prediction\|
  drops it to 0.265 with negative R². Specialists beat blends here.

So a model declares its `skills` and is scored only on what it claims. A
magnitude-only model is never silently treated as a directional bet.

## Rule 2: no headline that is not cohort-split

`scoreByCohort` is the only reporting entry point. There is deliberately no
pooled number to quote, because the pooled number is what was wrong.
`established` means the asset's first bar predates the evaluation window, so its
presence cannot be owed to surviving that window. **A result that lives only in
the `recent` cohort is survivorship until shown otherwise.**

## Per-asset selection: reported, never applied

"Which model suits this asset" is a claim that has to survive its own history.
Split each asset chronologically, measure the edge in each half, correlate
across assets — by **rank**, because Pearson here is driven by a few extreme
assets and disagreed with Spearman 0.186 to 0.0001 on the direction question.

| pairing | Spearman | selectable |
| --- | --- | --- |
| hierarchical vs adaptive, direction | 0.0003 | no |
| hierarchical vs adaptive, magnitude | 0.0610 | no |
| harVol vs ewmaVol, magnitude | 0.4259 | **yes** |
| ewmaVol vs trailingVol, magnitude | 0.0880 | no |

Per-asset *return* model selection has now failed by three independent methods
(`PREDICTION_WEIGHTS_EVIDENCE` IC correlation −0.036, the empirical-Bayes
shrinkage weights, and this). Per-asset *volatility* model selection does
persist. That asymmetry is the finding: the size of an asset's next move has
stable, asset-specific structure; the sign does not.

`selectionPersistence` returns `selectable: false` unless the rank correlation
clears its threshold, and flags when Pearson and Spearman diverge.

## What was NOT adopted, and why

HAR wins magnitude ranking and point error, so the obvious move is to build the
prediction interval on it. Measured, established cohort, conformal radius per
asset exactly as production builds it:

| interval scale | coverage | mean width |
| --- | --- | --- |
| trailingVol (current) | 0.8002 | 12.063% |
| ewmaVol | 0.8007 | 11.926% (−1.1%) |
| harVol | 0.8012 | 12.970% (**+7.5%**) |

HAR makes the interval **worse**. Its 22-day averaging is what makes it a good
ranker and what makes it too slow for an interval, which needs to track
conditional dispersion day to day. EWMA is the interval winner by 1.1% — too
small a gain to justify changing the production scale on one measurement.

The lesson is the module's premise restated: the best model depends on the
question. Ranking which asset moves most, estimating how far it moves, and
sizing an interval around it are three objectives with three different winners.

## HAR wins on crypto and LOSES on stocks

The four-lane run contradicts any claim that HAR is simply the better magnitude
model. Spearman on \|move\|, established cohort:

| lane | trailingVol | harVol | winner |
| --- | --- | --- | --- |
| crypto 1d | 0.2953 | **0.3463** | HAR, clearly |
| crypto 7d | 0.2397 | **0.2599** | HAR, narrowly |
| stock 1d | **0.3678** | 0.3429 | trailing |
| stock 5d | **0.3750** | 0.3388 | trailing |

Equity volatility is better described by the plain trailing window; crypto
volatility is better described by HAR's multi-horizon blend. So the
per-asset-class question has a different answer per asset class, and
`harVsTrailingMagnitude` is correspondingly `selectable: true` on crypto 1d
(rho 0.323) and `false` on stock 1d (rho 0.036).

This is why the module reports the field per lane instead of naming a global
winner, and why HAR was added as a candidate rather than as a replacement.

## Limits

- The headline table is crypto 1-day, established cohort. The other three lanes
  are scored by the same code and reported alongside it; see the section above
  for where they disagree.
- `hierarchicalVsAdaptiveDirection` is `not-computed` in the wired daily run:
  the adaptive model is fitted per asset by a separate script and its forecasts
  are not currently threaded in. The standalone study measured it at Spearman
  0.0003. The field reports `status: 'not-computed'` rather than a null
  correlation, so it cannot be misread as a tested negative.
- Costs are a flat 20bps round trip. Funding, borrow, impact and spread are not
  modelled, and for the microcap tier that assumption is fiction.
- Nothing here promotes anything. A candidate that looks good becomes a
  registered hypothesis for the existing evidence gate to judge on unseen
  forward outcomes.

Related: [[PER_ASSET_REGRESSION]], [[PREDICTION_WEIGHTS_EVIDENCE]],
[[CROSS_SECTIONAL_EVIDENCE]]
