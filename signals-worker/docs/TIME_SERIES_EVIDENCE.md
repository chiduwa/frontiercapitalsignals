# Time-series models: the size of the next move forecasts, its direction does not

`scripts/time-series.mjs` (`time-series-v1`), scored by the candidate field
(`model-zoo-v2`) and summarized for the dashboard by
`scripts/time-series-research.mjs`. Measured 2026-09-23 on the archive as it
stood that day: 614 series, 782,385 daily bars from 2021-01-01, the same
walk-forward outcomes the daily hierarchical job scores. Everything is
`actionable: false`.

## The answer

| question | answer |
| --- | --- |
| Does a time-series model forecast how LARGE the next move will be? | **Yes.** GARCH(1,1) with a weekday factor beats the production volatility scale on the variance loss at one day, for crypto (QLIKE t = −5.34) and equities (t = −7.64), in both halves of history, on assets listed before the test window. |
| Does it make the expected-move band better? | **Yes, at one day.** Same coverage, slightly narrower, and the weekday-to-weekday coverage gap is cut from 10.4 to 5.7 points (crypto) and 3.2 to 1.4 (equities). At multi-day horizons it is mixed (crypto 7d under-covers) or flat (equities 5d). |
| Does a time-series model forecast which WAY the market moves? | **No.** ARIMA and the structural model have no direction skill after costs in any lane. In the recently-listed cohort both score below chance. |
| Is there seasonality? | **In the size of moves, yes; in their direction, no.** Crypto weekends are quiet — BTC's Saturday move is half its average day's (corrected p < 0.001), confirmed on Binance's independent bars and in all three eras since 2021. No weekday direction effect survives correction for any series. |
| Are there cycles? | **None that survive correction**, for any displayed series. Multi-day swings are statistically indistinguishable from a random walk. |

So the dashboard publishes one forecast from this module — an 80% band on the
size of the next session's move — and describes everything else.

## What was tested

Four families, pre-declared before scoring, each the textbook answer to one
question. Each declares the skills it claims and is scored only on those
(the zoo's rule 1). Parameters are re-estimated on a fixed cadence and held in
between; nothing reads a bar after the date its forecast is keyed on (tested
by cutting the series at and just before every refit boundary).

| model | skill | specification |
| --- | --- | --- |
| `garchVol` | magnitude | GARCH(1,1), Gaussian quasi-MLE with variance targeting, zero mean. Refit every 21 bars on at most the last 1,000 returns; first fit after 250. h-step variance summed from the mean-reverting path. |
| `garchWeekdayVol` | magnitude | The same GARCH fitted to weekday-deseasonalized returns, reseasonalized for the target sessions. Weekday factors come from GARCH-standardized squared returns, winsorized at \|z\| = 5, and shrunk toward "no effect" by DerSimonian-Laird. |
| `harWeekdayVol` | magnitude | The zoo's HAR blend on deseasonalized returns, reseasonalized. Asks whether seasonality adds to the incumbent. |
| `arima` | direction | ARIMA(p,1,0) with drift: AR(p) on daily log returns, p ≤ 5 chosen by BIC on a common sample, training returns clipped at 8 robust SDs, refit every 21 bars. |
| `structural` | direction | log price = local linear trend + trigonometric weekly seasonal + damped stochastic cycle (period 10–365 sessions) + irregular. Kalman filter on a session index (calendar days for crypto, business days for equities; a missing bar is a missing observation). Concentrated MLE by Nelder-Mead, refit every 126 sessions on at most 730. |

Every candidate reads the same cleaned, date-aligned bars (`sanitizeBars`) the
production features read.

## How it was scored

The zoo's two standing rules — direction and magnitude scored separately, and
every result split into `established` (listed before the test window) and
`recent` cohorts — plus three additions made for this study:

1. **Common rows.** A candidate and the model it would replace are compared
   only on rows where both have a forecast (`magnitudeHeadToHead`). The GARCH
   family skips a 250-return warm-up, and the field table's per-model numbers
   are on different row sets; on its own rows `harWeekdayVol` looked 0.18
   points better on MAE than `harVol`, and on common rows the difference is
   nothing (t = 0.46).
2. **QLIKE, not raw MAE.** Every candidate forecasts a standard deviation, but
   the MAE-optimal forecast of |move| is its median — about 0.5σ for these
   returns. Raw MAE therefore rewards whichever model happens to sit lowest.
   QLIKE (Patton, 2011) is the loss that ranks variance forecasts correctly
   when the squared return is a noisy stand-in for the true variance. The
   paired difference is clustered by date and reported for each half.
3. **The band test** (`intervalComparison`). An 80% interval built exactly as
   production builds one — per asset, radius = the 80th percentile of that
   asset's last 180 matured |standardized errors| — with each candidate as the
   scale. Reported: coverage, mean width, and the spread of coverage across
   target weekdays.

## Results

### Direction: nothing clears costs

Hit rate against 50%, net return after a 20 bp round trip, both clustered by
decision date. Established cohort.

| lane | model | forecasts | hit | net %/period | net t |
| --- | --- | ---: | ---: | ---: | ---: |
| crypto 1d | arima | 207,614 | 0.5022 | −0.183 | −1.75 |
| crypto 1d | structural | 207,386 | 0.5056 | −0.077 | −0.73 |
| crypto 7d | arima | 31,404 | 0.5163 | −0.615 | −1.97 |
| crypto 7d | structural | 31,390 | 0.5107 | +0.149 | 0.49 |
| stock 1d | arima | 329,791 | 0.5058 | −0.201 | −14.49 |
| stock 1d | structural | 329,233 | 0.4988 | −0.207 | −17.55 |
| stock 5d | arima | 65,751 | 0.4873 | −0.644 | −2.35 |
| stock 5d | structural | 65,751 | 0.4777 | −0.582 | −2.17 |

On each series' last 1,000 returns BIC selects order 0 — a random walk with
drift — for 98.3% of equities (286 of 291) and 74.3% of crypto series (208 of
280; the rest mostly order 1–2). So ARIMA's direction is mostly the sign of the
trailing drift, and its 50.6% on equities is the equity drift itself ("always
long"), not a skill. In the `recent` cohort both models run below chance
(crypto 1d: arima hit t = −4.32, structural t = −5.13). This is the same answer
every direction model in this project has given.

### Magnitude: GARCH forecasts variance; the weekday factor fixes calibration

Candidate minus incumbent on common rows, established cohort. Negative QLIKE
favours the candidate; halves are chronological.

| lane | comparison | ρ cand. | ρ inc. | QLIKE t | 1st half | 2nd half |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| crypto 1d | garchVol vs trailingVol | 0.302 | 0.278 | −5.35 | −4.90 | −3.09 |
| crypto 1d | garchVol vs ewmaVol | 0.302 | 0.322 | −3.07 | −2.35 | −2.07 |
| crypto 1d | garchVol vs harVol | 0.304 | 0.330 | −7.66 | −6.64 | −4.97 |
| crypto 1d | garchWeekdayVol vs garchVol | 0.314 | 0.302 | −0.82 | −1.83 | 0.31 |
| crypto 1d | **garchWeekdayVol vs trailingVol** | 0.314 | 0.278 | **−5.34** | −5.15 | −2.93 |
| crypto 1d | harWeekdayVol vs harVol | 0.337 | 0.327 | 0.92 | 0.53 | 0.75 |
| crypto 7d | garchWeekdayVol vs trailingVol | 0.230 | 0.241 | −2.81 | −2.63 | −1.79 |
| stock 1d | garchVol vs trailingVol | 0.367 | 0.366 | −7.14 | −2.67 | −7.01 |
| stock 1d | garchWeekdayVol vs garchVol | 0.368 | 0.367 | −3.55 | −3.34 | −2.28 |
| stock 1d | **garchWeekdayVol vs trailingVol** | 0.368 | 0.366 | **−7.64** | −3.22 | −7.18 |
| stock 1d | harWeekdayVol vs harVol | 0.340 | 0.340 | −4.24 | −2.76 | −3.33 |
| stock 5d | garchWeekdayVol vs trailingVol | 0.378 | 0.375 | 1.01 | 1.01 | 1.29 |

Read it as three separate facts:

- **GARCH is the better variance forecaster** — it beats the production scale,
  EWMA and HAR on QLIKE at one day in both classes, in both halves. The
  likely mechanism, not separately measured: its mean reversion stops the
  forecast collapsing after a calm spell, and QLIKE punishes an under-forecast
  far more than an over-forecast.
- **GARCH is not the better ranker on crypto.** EWMA and HAR order the
  cross-section of next-day moves better (ρ 0.322 / 0.330 vs 0.302). Ranking
  which asset moves most and sizing how far are still different skills with
  different winners, as MODEL_ZOO.md found for HAR.
- **The weekday factor's gain is in calibration, not in the average loss** on
  crypto (QLIKE t = −0.82 against plain GARCH, MAE t = −7.44), while on
  equities it improves QLIKE too (t = −3.55). Its per-asset benefit on crypto
  persists across halves (`harWeekdayVsHarMagnitude` Spearman 0.237,
  selectable); on equities it does not (−0.08) — there the effect is common to
  the class rather than asset-specific.

With one scale per model fitted on the first half of dates and scored on the
second (crypto 1d, established), the level-bias-free MAE is EWMA 2.281, HAR
2.311, trailing 2.315, GARCH-weekday 2.319, GARCH 2.331 — within 2% of each
other, against 3.359 for forecasting no move. HAR's raw-MAE lead over EWMA
(2.748 vs 3.054 on the same rows) is its lower level, not skill.

### The band

Conformal 80% band, production recipe, each candidate as the scale.

| lane | cohort | trailingVol | garchVol | garchWeekdayVol |
| --- | --- | --- | --- | --- |
| crypto 1d | established | 79.1% · 11.00% · gap 10.4 | 79.4% · 10.54% · gap 11.5 | **79.5% · 10.59% · gap 5.7** |
| crypto 1d | recent | 78.9% · 11.51% · gap 9.2 | 79.9% · 11.35% · gap 9.6 | 80.0% · 11.41% · gap 6.1 |
| crypto 7d | established | 79.0% · 31.90% | 77.2% · 28.21% | 77.3% · 28.27% |
| stock 1d | established | 79.9% · 5.66% · gap 3.2 | 80.0% · 5.59% · gap 3.0 | **80.0% · 5.61% · gap 1.4** |
| stock 1d | recent | 79.2% · 10.88% · gap 4.7 | 78.8% · 10.59% · gap 3.6 | 78.9% · 10.62% · gap 3.8 |
| stock 5d | established | 80.0% · 13.05% | 81.2% · 13.20% | 81.2% · 13.19% |

(coverage · mean width · max−min coverage across target weekdays, points)

A weekday-blind band is too wide on quiet days and too narrow on busy ones.
Crypto 1d, established, coverage by the weekday being forecast:

| scale | Sun | Mon | Tue | Wed | Thu | Fri | Sat |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| trailingVol | 83.2% | 75.5% | 79.1% | 76.1% | 77.9% | 76.4% | 85.9% |
| garchVol | 84.2% | 75.1% | 79.3% | 76.3% | 78.0% | 76.3% | 86.6% |
| garchWeekdayVol | 80.8% | 78.0% | 80.0% | 78.7% | 77.7% | 77.6% | 83.4% |

The average width barely moves, and should not: for a scale mixture the
calibrated band and the blind band have nearly the same mean width. What the
factor buys is a band that means 80% on a Monday as well as on a Saturday.

At 7 days crypto's GARCH band is narrower but under-covers (77.3%); at 5 days
the equity bands are equivalent. The one-day lane is where this model earns
its place.

### Per tracked asset, crypto 1d

Time-series ranking within each asset (Spearman of forecast vs |move| over its
own history) and the paired QLIKE t. HYPE (124 rows) and ARB (100) are too
short to read.

| asset | trailing ρ | GARCH ρ | GARCH+weekday ρ | QLIKE t, weekday vs GARCH | QLIKE t, GARCH vs trailing |
| --- | ---: | ---: | ---: | ---: | ---: |
| BTC | 0.156 | 0.171 | **0.320** | −4.74 | −2.57 |
| ETH | 0.150 | 0.192 | **0.277** | −3.06 | −1.10 |
| SOL | 0.174 | 0.214 | 0.248 | −1.66 | −1.83 |
| XLM | 0.202 | 0.269 | 0.283 | 0.22 | −3.18 |
| XRP | 0.103 | 0.185 | 0.230 | 0.33 | −1.98 |
| HBAR | 0.204 | 0.266 | 0.293 | −1.75 | −3.51 |
| Crypto market (MCAP:BROAD) | 0.178 | 0.206 | 0.246 | −2.38 | −2.61 |

For BTC the weekday factor nearly doubles how well the model orders its own
quiet and busy days. For XLM and XRP it adds nothing — which is why the factor
is shrunk per asset instead of imposed.

## What the dashboard now shows

The timing zone gains **Trend, seasonality, cycles, volatility and irregular
moves** for the crypto market (MCAP:BROAD), the US stock market (SPY) and every
always-tracked asset. Built by the daily hierarchical job from the panel it
already loads; the verdict line under the table is recomputed from that run's
own zoo, so a reversal of the evidence is reported as a reversal.

| reading | what it is | test | forecast? |
| --- | --- | --- | --- |
| Trend | close-to-close change over 30 days, 90 days and 1 year | Newey-West t on the mean daily return, Holm-corrected per window across the series shown | no — trend-following direction models showed no skill |
| Seasonality | relative move size by weekday; separately, mean return by weekday | Cochran's Q on the shrunk variance factors; HAC Wald on the weekday means; both Holm-corrected | the size profile feeds the band; the direction profile is descriptive |
| Cycles | strongest periodicity in GARCH-standardized returns (10–365 days; 10–260 sessions for equities), and the 20-session variance ratio | Fisher's g (exact under white noise); Lo-MacKinlay robust z; Holm-corrected | no |
| Variations | **80% band for the next session**; volatility regime (percentile of the past year, deseasonalized); half-life of shocks | the band test and head-to-head above | **yes — size only** |
| Irregular | moves beyond 3σ in the last 90 sessions, the largest one, excess kurtosis, Ljung-Box on standardized residuals and their squares | — | no |

Why the structural model is tested but not drawn: fitted to real prices, its
"cycle" runs to the 365-day bound with damping near 1 — it absorbs the random
walk's low-frequency wandering, not an oscillation. That is Slutsky-Yule: a
smoothed random walk shows cycles that are not there. The panel therefore
claims a cycle only if a periodicity in returns survives correction, and on
2026-09-23 none did, for any series (smallest corrected p = 0.33).

A series whose archive is more than three days behind keeps its descriptive
readings and loses its band: a k-step forecast that has decayed to the
long-run level, dated to a session that may already have closed, is not a
current forecast.

As of 2026-09-23 (archive through 2026-09-21):

| series | 90d | band, next session | regime | weekday move size (corr. p) |
| --- | ---: | --- | --- | --- |
| Crypto market | +35.0% | −2.72% to +2.80% | elevated (85th pct) | no confirmed effect (0.21) |
| US stock market | +5.4% | −1.09% to +1.10% | normal (66th) | not confirmed (0.056; Mon 0.89×, Thu 1.07×) |
| BTC | +38.2% | −3.50% to +3.63% | elevated (91st) | **Sat 0.49×, Mon 1.19× (<0.001)** |
| ETH | +66.7% | −3.41% to +3.53% | normal (74th) | **Sat 0.62×, Mon 1.14× (<0.001)** |
| SOL | +70.5% | −4.19% to +4.38% | elevated (84th) | **Sat 0.82×, Mon 1.08× (0.043)** |
| XRP | +38.2% | −4.63% to +4.86% | elevated (92nd) | **Sat 0.76×, Fri 1.08× (0.016)** |
| XLM, HYPE, HBAR | | | | no confirmed effect |
| ARB | | withheld — archive stale until the Binance tier runs | | |

No 90-day drift is distinguishable from noise after correction (ETH's t = 2.01
is one of thirty trend tests). No cycle or variance-ratio result survives.

## Found along the way

- **ARB's archive had stopped on 2026-09-06**, and it was not alone: 55
  CoinGecko-sourced coins were 3+ days stale. Yahoo's `ARB-USD` is a different
  token; the CoinGecko fallback ran without the `COINGECKO_API_KEY` secret,
  which existed but was never passed to the archive step. `backfill-history`
  now tries Binance's public klines first (ARB: 1,280 bars from its
  2023-03-23 listing) and receives the key.
- **Liquidity tiers were cut on a unit error.** Crypto volume is stored in USD;
  `medianDollarVolume` multiplied it by price again. MODEL_ZOO.md's `liquid`
  and `deep` survivorship rows rest on that tier.
- **The zoo's incumbent scales read CoinGecko assets a day stale**, because
  they keyed on raw dates while outcomes use aligned ones. Fixed; the
  incumbents' crypto numbers rose slightly (trailing ρ 0.294 → 0.299).
- **A research run with new code on an unchanged panel would have been
  dropped**: the run id hashed the regression version and the inputs, not the
  zoo or time-series version, and persistence is `INSERT OR IGNORE`. Both
  versions are now in the id.

## Limits

- Walk-forward research over archived daily closes. Not a live track record;
  the band has not yet been scored on sessions that did not exist when it was
  designed. That starts with the first daily run.
- The crypto market line is an equal-weighted composite of coins that survived
  to today (MCAP:BROAD). Its drift reads high for that reason; the real total
  market cap (MCAP:TOTAL) has only 26 days of history.
- Costs are a flat 20 bp round trip; funding, borrow and impact are not
  modelled. The survivorship caveat of MODEL_ZOO.md applies: `established` is
  a better cohort, not a survivorship-free universe.
- Binance volume is one venue and CoinGecko's is aggregated, so volume-based
  features see a level shift at a supplier seam. The time-series models use
  closes only.
- The production interval scale (`trailingVol` in the hierarchical lane) is
  unchanged. This evidence makes GARCH with a weekday factor the candidate to
  replace it at one day; that replacement should follow forward evidence, not
  this retrospective alone.

## Reproduce

```bash
# read-only panel via the local wrangler session
node scripts/hierarchical-research.mjs --dry-run --wrangler --save-input /tmp/panel.json --load-only
# the full daily report, including the zoo and the time-series section
node scripts/hierarchical-research.mjs --dry-run --input /tmp/panel.json --output /tmp/hier
node --test test-time-series.mjs test-model-zoo.mjs
```

Related: [[MODEL_ZOO]], [[PER_ASSET_REGRESSION]], [[TRACKED_ASSET_AUDIT_2026_09_19]]
