# Mean vs median vs simulation for the day zones, and precision/recall for the tournament

2026-10-06. Asked: "for fcs signals model, for the part that we use the median
to try estimating daily movements, try using the mean, flaw of averages,
simulation models, etc and see if that predicts better so we use that (or
maybe for specific assets). also, could the learning model be also checking
precision, recall/sensitivity, specificity, and negative predictive value, to
see if we can learn from those to improve the models per asset"

## Short answer

- **The mean predicts worse than the median: about 9-10% worse in both
  periods.** It sits above the median, so 65% of days stay inside a
  mean-based level instead of 50%. It answers a different question ("how big
  is the average day"), not the same one better.
- **Simulations predict worse too.** Monte Carlo days stitched from past hours
  were 1.5-5% worse. A formula for how far a random walk reaches in a day
  (from EWMA or GARCH volatility) was mixed: between 1.5% better and 0.2%
  worse depending on the volatility model and period.
- **What did predict better is a learned model, and it now runs live
  (day-zones-v3).**
  - It is a median regression: still the median, but adjusted for last
    week's moves, how far the 60-day **mean** sits above the median (the
    "flaw of averages" signal: a fat recent tail means bigger days ahead), the
    weekday, and the volatility, volume and move inputs the levels already
    used.
  - It is 1.7% more accurate in 2019-22 and 2.4% in 2023-26, better on every
    coin.
  - Fitted only on 2019-22 and frozen, it is still 2.4% better on 2023-26,
    HYPE included.
- **One model per coin did worse than one pooled model,** in both tests.
  "Maybe for specific assets" was tested and is no.
- **The alerts' odds barely move.** A better forecast of the day's range does
  not make the level a top: near the day's high 30% of the time vs 29% before,
  and the same continuation afterwards. The pushes now quote the new numbers
  and say how far each level sits from the plain median.
- **Precision, recall/sensitivity, specificity and NPV:** the tournament now
  checks them for every direction model on its forward forecasts, and the
  dashboard shows them. They cannot be used to pick better models:
  - **Sensitivity and specificity mostly measure how often a model says "up".**
    Stock models said up 75% of the time, so they score 0.75 and 0.25 in every
    period. Maximizing either picks a model that always, or never, says up.
  - **Precision and NPV move together by arithmetic.** Their gains over the
    base rate share one numerator, so a model can never be good at "up" calls
    and bad at "down" calls. That held on all 6,678 cells checked.
  - **Picking each asset's model by any of them** gave worse probability
    forecasts than the Brier score the tournament already uses, on every
    horizon. The best case (crypto, 1 day) earned +0.06-0.09% a call before
    costs and about nothing after.

## 1. The day-zone forecast: what was compared

Hourly Binance bars of the eight always-tracked coins, 2018-01 to 2026-10-05
(HYPE from its Binance perpetual, 2025-05 on). For each UTC day the target is
the same as the live zones: U = how far the day's high went above the 00:00
open, D = how far the low went below it (in logs). Every forecast uses only
days before the one it forecasts; models are refit every 91 days on everything
before. The Python baseline reproduces the live `day-zones.mjs` to 16 decimal
places on BTC, HBAR and HYPE.

Three scores, so each method gets a fair hearing:
- **MAE**, the error the median is built to minimize. It is the score the
  2026-10-02 study chose production by.
- **MSE**, the error the **mean** is built to minimize.
- **CRPS**, the whole forecast distribution scored at its 10th, 25th, 50th,
  75th and 90th percentiles. This is the "flaw of averages" test: is a full
  range of outcomes better than one number?

Results are ratios to production (below 1 is better), averaged over coins.
t is the paired difference, days pooled across coins, Newey-West
(`results/score_out.txt`):

| method | MAE 2019-22 | MAE 2023-26 | MSE 2019-22 / 2023-26 | CRPS 2019-22 / 2023-26 | days inside the top / bottom, 2023-26 |
|---|---|---|---|---|---|
| 60-day median (production v2) | 1.000 | 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 51% / 52% |
| 60-day mean | 1.098 (t +14.4) | 1.089 (t +15.3) | 0.971 / 0.973 | 1.129 / 1.131 | 65% / 65% |
| 10% trimmed mean | 1.017 (t +6.9) | 1.016 (t +6.2) | 0.961 / 0.958 | 1.033 / 1.035 | 57% / 58% |
| geometric mean | 1.001 | 1.000 | 1.065 / 1.050 | 1.010 / 1.009 | 44% / 45% |
| mean x walk-forward correction | 0.990 (t -4.4) | 0.992 (t -3.0) | 1.019 / 1.007 | 1.003 / 1.006 | 48% / 49% |
| recency-weighted median | 1.005 | 1.003 | 0.995 / 0.991 | 1.011 / 1.012 | 51% / 52% |
| Monte Carlo, hour by hour | 1.048 (t +9.3) | 1.032 (t +7.9) | 0.965 / 0.957 | 1.035 / 1.017 | 60% / 59% |
| Monte Carlo, 6-hour blocks | 1.015 (t +6.2) | 1.010 (t +4.2) | 0.967 / 0.961 | 1.015 / 1.004 | 56% / 56% |
| random-walk reach, EWMA 24h vol, corrected | 0.991 (t -2.2) | 0.994 (t -1.5) | 1.012 / 1.007 | 1.004 / 1.006 | 47% / 48% |
| random-walk reach, EWMA 7d vol, corrected | 0.995 (t -1.2) | 0.985 (t -4.3) | 1.044 / 1.008 | 1.005 / 0.994 | 48% / 50% |
| random-walk reach, GARCH vol, corrected | 0.989 (t -2.7) | 1.002 (t +0.5) | 1.012 / 1.016 | 1.004 / 1.007 | 49% / 50% |
| median regression, one per coin | 0.994 (t -1.0) | 0.987 (t -1.0) | 1.062 / 1.241 | 0.998 / 0.984 | 49% / 50% |
| **median regression, pooled** | **0.983 (t -3.7)** | **0.976 (t -5.2)** | 1.003 / 1.001 | **0.984 / 0.974** | 49% / 50% |

What the table says:

- **The mean.** It wins only on squared error, the score it is built for,
  and by 3%. On the level's job (half of days inside) and on the whole
  distribution it loses badly. The trimmed mean sits in between.
- **The simulations** draw each hour (or 6-hour block) from a different past
  day. That breaks up trend days, which is exactly the continuation the
  2026-10-02 study found, so their levels sit too far out (56-60% of days
  inside). The uncorrected random-walk formulas were too wide as well
  (57-63% inside); a walk-forward correction fixes the level but not the
  forecast.
- **The mean x correction** (the mean is a steadier estimate of the centre
  and the correction moves it to where the median would be) gains 1%. The
  regression below gains more, using the mean as one of its inputs.

**Which inputs carry the gain** (exact median regression, walk-forward,
`results/ablate_out.txt`):

| inputs | MAE 2019-22 | MAE 2023-26 |
|---|---|---|
| the median alone, recalibrated | 1.036 | 1.029 |
| production's inputs (last 24h volatility, 24h volume, yesterday's move), refitted | 0.999 | 1.000 |
| + the last 7 days' moves vs the median | 0.990 (t -3.3) | 0.990 (t -2.5) |
| + the 60-day mean vs the median | 0.986 (t -4.3) | 0.988 (t -2.5) |
| + the weekday (**shipped**) | 0.985 (t -3.5) | **0.975 (t -5.4)** |

Production's own inputs, refitted, change nothing, so the old levels were
already well tuned on what they used. The gain is new information:
- **Last week:** a busy week means a busier day.
- **The mean-median gap:** a fat recent tail means bigger days ahead.
- **The weekday:** Mondays run larger, and Saturday's downside smaller. This
  effect is stronger since 2023 than before.

**Frozen test.** Fitted once on 2019-22 and never refit, it scores 0.976 on
2023-26 (t -5.2):

| BTC | ETH | SOL | XLM | XRP | HBAR | ARB | HYPE |
|---|---|---|---|---|---|---|---|
| 0.959 | 0.967 | 0.976 | 0.992 | 0.976 | 0.987 | 0.976 | 0.984 |

Every coin is better, including HYPE, which no fit had seen.

**Per coin.** Pick each coin's best method on one period and score it on the
next:
- 2019-22 picks, scored on 2025-26: 0.971, against 0.965 for the pooled model
  everywhere.
- 2023-24 picks, scored on 2025-26: 0.974 against 0.966.

Per-coin choices chase noise; one model for all eight is better.

**The guard.**
- **The problem:** on the most extreme 1% of days the uncapped model
  overshot. Those levels came out 3.6x the median, 55% of days stayed inside
  instead of 50%, and the error ran 14% above v2's.
- **The fix:** levels are capped at 4x the 60-day median move, which touches
  0.6% of coin-days.
- **The evidence, stated plainly:** on 2019-22 alone the cap is a tie
  (0.9782 vs 0.9779 uncapped), with a steadier gain (t -8.4 vs -7.5). On
  2023-26 it helps (0.973 vs 0.977). It is kept as an extrapolation guard,
  not as a fitted improvement.

## 2. What changed live

- **`scripts/day-zones.mjs`** (`day-zones-v3`): the levels come from the
  shipped regression. Its coefficients come from the exact solution on
  18,496 coin-days and sit in `DAY_ZONE.model`.
  - Each zone also carries `vsMedian`: the level against the plain 60-day
    median move.
  - It also carries the regression's `inputs`.
  - `test-day-zones.mjs` checks it against the study's Python to 1e-12 on
    real BTC and HBAR bars, including HBAR on 2026-09-30, where the downside
    hit the 4x guard.
- **`worker.js`:**
  - **The odds:** `DAY_ZONE_EVIDENCE` quotes the v3 odds. The same replay
    reproduces the v2 odds within a point (`results/evidence_out.txt`).
  - **The push wording:** a push now says "level 12% wider (or narrower)
    than its 60-day median move" when the adjustment is 5% or more. Before,
    it said "band widened".
  - **The footer** says what the level is built from.
  - **Older payloads:** a v2 payload still alerts, and says nothing about an
    adjustment.

The alerts against the old and new levels, 2023-26, as the rule runs live
(after 18:00 UTC, hourly closes):

| | v2 | v3 |
|---|---|---|
| alerts per day with any alert | 4.41 | 4.42 |
| top: near the day's high (light / normal / heavy volume) | 34% / 28% / 21% | 35% / 29% / 23% |
| top: closed back below | 22% | 23% |
| top: alert price to close | +24 bp (t 3.7) | +23 bp (t 3.7) |
| bottom: near the day's low (light / normal / heavy) | 36% / 30% / 28% | 34% / 30% / 28% |

The pushes still say "Not a top signal", and should.

## 3. Precision, recall/sensitivity, specificity and NPV for the tournament

**How it was tested.**
- **The forecasts:** every direction family the tournament's generator can
  propose (21 models), fitted per asset with the tournament's own code and
  refit schedule.
- **The coverage:** 80 assets (39 coins, 41 stocks), 1.58 million
  walk-forward forecasts, 2023-12 to 2026-10.
- **The split:** each result is split at 2025-04-01 into an earlier and a
  later half (`results/confusion_out.txt`).
- **The threshold:** a forecast becomes a call at P(up) > 0.5, and again at
  P(up) > the asset's own training up-rate, which strips out "it always says
  up because the asset usually rose".

**Is there skill to learn from?** No:
- Averaged over models, precision beat the up-rate by -0.009 to +0.009, in
  every slot and both halves.
- Informedness (sensitivity + specificity - 1, which is 0 for any model
  without skill) ran -0.021 to +0.017.
- Every model's Brier score was worse than the base rate's.

**Do the metrics persist per asset and model, from the earlier half to the
later?** (rank correlation; 0 = no persistence)

| at P(up) > 0.5 | crypto 1d | crypto 7d | stock 1d | stock 5d |
|---|---|---|---|---|
| how often it says "up" | +0.49 | +0.43 | +0.69 | +0.68 |
| sensitivity | +0.51 | +0.41 | +0.67 | +0.62 |
| specificity | +0.45 | +0.38 | +0.70 | +0.66 |
| precision over the up-rate | +0.11 | -0.03 | -0.06 | +0.06 |
| NPV over the down-rate | +0.13 | -0.06 | -0.03 | +0.07 |
| informedness | +0.14 | -0.04 | -0.06 | +0.05 |
| Brier skill (what the tournament uses) | +0.43 | +0.29 | +0.59 | +0.45 |

- **Sensitivity and specificity persist only as far as "how often it says
  up" does.** Cut at each asset's own up-rate, their persistence falls to
  -0.02 to +0.25.
- **The parts that measure skill barely persist.** Precision gain, NPV gain
  and informedness are borderline at best: crypto 1 day, within each asset,
  informedness +0.11 (t 2.2). Elsewhere they are zero or negative.

**Choosing each asset's model by a metric on the earlier half, scored on
the later half** (Brier skill vs the base rate, higher is better):

| chosen by | crypto 1d | crypto 7d | stock 1d | stock 5d |
|---|---|---|---|---|
| Brier skill (current rule) | **-0.010** | **-0.044** | **-0.004** | **-0.019** |
| precision over the up-rate | -0.025 | -0.121 | -0.029 | -0.091 |
| NPV over the down-rate | -0.036 | -0.111 | -0.025 | -0.092 |
| informedness | -0.025 | -0.107 | -0.028 | -0.092 |
| MCC | -0.024 | -0.106 | -0.028 | -0.092 |

**And in money.** Crypto 1 day, calls on the same day pooled because coins
move together, 0.1% a side charged when a call flips:
- **Gross:** picks by informedness, markedness, MCC or NPV made +0.06 to
  +0.09% a call (t 1.0-1.5).
- **Net:** +0.00 to +0.03% (t 0.0-0.5).
- **Crypto 7 days:** the same picks lost 1.5% a call (t -2.0).
- **Stocks at P(up) > 0.5:** these looked profitable, but only because the
  models said "up" 75% of the time in a rising market. Cut at the up-rate:
  +0.05% (t 1.6) at 1 day and -0.12% (t -0.7) at 5 days.

**No one-sided skill.**
- **By arithmetic:**
  - precision - up-rate = (TP·TN - FP·FN) / (n·(TP+FP));
  - NPV - down-rate = (TP·TN - FP·FN) / (n·(TN+FN)).

  One numerator, so the two always share a sign (checked on all 6,678 cells).
  "Trust its down calls only" cannot come from these metrics.
- **In money:** whether the long side or the short side of a model's calls
  earned more did not persist either (rank correlation -0.03 to +0.09).

**What runs now** (`scripts/model-tournament.py` `call_metrics`): every run
attaches, to each direction challenger, `calls` over its forward forecasts
since its epoch:
- n, the up-rate, how often it says up;
- precision, NPV, sensitivity, specificity, informedness.

The method in force gets the same over the leader's window
(`incumbentCalls`). 7-day and 5-session forecasts are counted once per
horizon, as the promotion test counts them. The dashboard panel prints the
leader's line, with precision next to the share of up days. **Promotion
still uses only the Brier e-process**, and the code says why. Tests:
`test-model-tournament.py` `CallMetrics` (a hand-counted example, the
always-up model reads as no skill, the shared-sign identity, the summary
wiring and weekly counting) and `test-dashboard.mjs`.

## Reproduce

[research-2026-10-06-mean-median-sim/](research-2026-10-06-mean-median-sim/README.md).

Related: [DAY_ZONES_AND_BOXES](DAY_ZONES_AND_BOXES.md),
[MODEL_TOURNAMENT](MODEL_TOURNAMENT.md).
