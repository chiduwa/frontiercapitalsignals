# Cross-sectional lane: what was measured, and what it does and does not support

Date: 2026-09-06
Scope: why two production scoring rules were deleted, and what evidence the new
cross-sectional lane rests on.

Every query below ran against this project's own D1 (`asset_daily_bars`,
`forecast_outcomes`), not against a paper's dataset. Numbers are reproducible
by re-running them.

---

## 1. The production model's live record

`forecast_outcomes`, all independent (`aggregated = 1`) rows as of 2026-09-05.
9,524 outcomes, first run 2026-08-28.

| class | kind | horizon | n | accuracy |
|---|---|---|---|---|
| crypto | combo | 24h | 1,822 | 48.5% |
| crypto | technique | 24h | 1,473 | 43.7% |
| stock | combo | 24h | 1,288 | 27.6% |
| stock | technique | 24h | 1,173 | 30.1% |
| crypto | combo | 7d | 1,118 | 36.1% |
| stock | combo | 7d | 615 | 44.4% |

Accuracy alone understates the problem, because the label is three-way
(up/flat/down under a 0.5% deadband) while the model only ever emits ±1. The
diagnostic result is the mean forward return conditioned on the call:

| class | horizon | call | n | mean forward return |
|---|---|---|---|---|
| crypto | 7d | **down** | 678 | **+4.68%** |
| crypto | 7d | up | 440 | +4.47% |
| crypto | 24h | **down** | 262 | **+4.50%** |
| crypto | 24h | up | 1,560 | +2.03% |
| stock | 24h | **down** | 544 | **+0.64%** |
| stock | 24h | up | 744 | −0.38% |

**The bearish calls outperformed the bullish calls in both asset classes at
both horizons.** The model was not merely unskilled; its directional sign was
anti-correlated with forward returns.

---

## 2. The two deleted rules

`confluence()` carried two hard-coded "setup extremity" adjustments. Neither
was ever derived from evidence. Both were tested against the archive
(2018-01-01 onward, crypto with volume > $1M; stocks from 2010).

Crypto, n = 216,693 observations, base rate **+1.205%** mean forward 7-day return:

| condition | production effect | n | mean fwd 7d | up-rate |
|---|---|---|---|---|
| `chg7d >= 45%` | `short += 10` | 4,572 | **+9.97%** | 47.9% |
| `chg30d < −15 && chg7d > 0 && rsi < 55` | `long += 8` | 16,189 | **−1.08%** | 40.2% |
| `chg7d >= 20%` (comparison) | — | 18,066 | +5.69% | 47.4% |
| `chg7d <= −20%` (comparison) | — | 11,166 | +3.77% | 55.4% |

Stocks, n = 236,738, base rate **+0.635%**:

| condition | n | mean fwd 7d | up-rate |
|---|---|---|---|
| `chg7d >= 22%` (the stock form of the short kicker) | 1,825 | **+2.32%** | 54.8% |
| long-kicker condition | 3,687 | +0.84% | 53.0% |
| `chg7d <= −15%` | 3,281 | +1.82% | 56.5% |

### Survivorship control

`asset_daily_bars` holds only coins in today's universe, so a coin that pumped
and died is absent. The test was repeated on 20 majors that existed in 2018 and
still exist, where no selection is possible (BTC, ETH, XRP, LTC, BCH, ADA, XLM,
LINK, BNB, DOGE, TRX, ETC, XMR, ZEC, DASH, NEO, QTUM, WAVES, BAT, ZRX):

| condition | n | mean fwd 7d | base rate |
|---|---|---|---|
| `chg7d >= 45%` | 635 | **+5.87%** | +0.98% |
| long-kicker condition | 3,343 | **−0.95%** | +0.98% |
| `chg7d <= −20%` | 1,961 | +2.88% (58.3% up) | +0.98% |

Survivorship inflates the full-panel figure by roughly 40% (+9.97% → +5.87%),
but the sign and the significance survive completely. Both rules were inverted.

They were **deleted, not sign-flipped.** A magnitude effect does not belong in
a direction vote: note that `chg7d >= 45%` resolves up only 47.9% of the time
against a 46.6% base rate. Its +9.97% comes entirely from the size of the
winners. Flipping the rule would have been the same category error pointed the
other way.

---

## 3. What replaced them, and the evidence for it

### Cross-sectional quintiles, crypto, weekly, 2018-2026 (~30,200 weekly observations)

Top-quintile mean forward weekly return by signal:

| signal | Q1 (worst) | Q3 | Q5 (best) | Q5 − universe |
|---|---|---|---|---|
| 4-week momentum | 1.14% | 1.00% | 2.09% | +0.83% |
| 1-week momentum | 1.21% | 0.70% | 2.26% | +1.00% |
| 12-week momentum | 1.64% | 0.70% | 1.78% | +0.52% |

**Hit rate was 46-47% in every quintile.** The spread is entirely in magnitude.
This is the single most important measurement here: a direction-accuracy
scoreboard — the one the production model optimises and gates on — cannot see
this edge at all.

### Year-by-year stability (top quintile vs equal-weighted universe)

| year | universe | top quintile | edge |
|---|---|---|---|
| 2018 | −1.50% | −1.42% | **−1.40%** |
| 2019 | +0.81% | +2.22% | +1.24% |
| 2020 | +3.21% | +4.97% | +1.99% |
| 2021 | +5.97% | +6.72% | +0.96% |
| 2022 | −1.97% | −1.82% | +0.08% |
| 2023 | +2.01% | +3.80% | +1.74% |
| 2024 | +2.10% | +2.06% | +0.11% |
| 2025 | −0.60% | +0.58% | +1.16% |
| 2026 | +0.65% | +1.39% | +1.81% |

Positive in 8 of 9 calendar years; the exception is 2018, the classic momentum
crash. Overall ~+0.85%/week before costs.

### Variants tested — and found not to matter

Raw 4-week momentum, vol-scaled momentum, and a blend of 1/4/12-week rank were
compared. Overall means: 2.11%, 2.01%, 2.19% against a 1.26% universe. The
ordering is not stable across years (raw wins 2023/25/26, blended wins
2020/21/24, vol-scaled wins the two bear years). **The edge is in the
cross-sectional ranking itself, not in which flavour of momentum is ranked.**
This argues for combining many features and against tuning any one of them.

### A negative result: the BTC-trend regime gate does not work

Gating exposure on BTC > its 10-week MA was tested as a crash filter:

| | always invested | gated |
|---|---|---|
| all years | +2.30% | +2.07% |
| 2018 | −3.87% | −3.56% |
| 2022 | −1.87% | −0.61% |
| 2020 | +5.32% | +4.64% |
| 2023 | +3.75% | +3.17% |

It helps only in 2022, costs return in every good year, and barely improves
2018 — the year it was meant to save. It reduces drawdown by reducing exposure,
which is a risk preference, not alpha. **Not implemented.** (The open-source
`crypto-breadth` project reports a breadth gate adding 0.25 Sharpe; that did not
reproduce here as a return enhancer.)

---

## 4. External work this draws on

| source | what was taken | what was not |
|---|---|---|
| Fieberg, Liedtke, Poddig, Walker & Zaremba, *A Trend Factor for the Cross-Section of Cryptocurrency Returns*, JFQA 2025 | The architecture: rank predictors cross-sectionally into [−0.5, 0.5], estimate univariate Fama-MacBeth coefficients on a rolling window, select, then equally weight the survivors. Their long leg alone earns 3.98%/wk gross and 3.36% net at 50/60bp, and holds up in the largest 100 coins. | Their magnitudes. Sample is 2015-2022 with micro-caps and a short leg; our own archive shows the short leg losing in 2018, 2022 and 2024. |
| Liu, Tsyvinski & Wu, *Common Risk Factors in Cryptocurrency*, JF 2022 | That crypto is a **momentum** market at 1-4 week horizons — the opposite of the contrarian reading the deleted rules encoded. | Nothing implemented directly. |
| Rapach-Strauss-Zhou; Diebold-Shin | Equal-weighting selected univariate forecasts beats magnitude-weighting them out of sample. | — |
| Bailey & López de Prado, *Deflated Sharpe Ratio* | The principle that a winner chosen from many trials is inflated. Implemented here as a Bonferroni threshold over the number of features actually tested. | The full DSR statistic. |
| Barroso & Santa-Clara, *Momentum Has Its Moments*, JFE 2015; and the crypto replication (Sharpe 1.12 → 1.42) | Momentum crashes are predictable from the strategy's own realised vol. Motivated including `rvol` and `mom_7d_rvol` as features. | Not implemented as an exposure overlay — see the negative result above. |
| Moreira & Muir, *Volatility Managed Portfolios*, JF 2017 | — | **Deliberately not used.** Cederburg et al. (2020) show the gains are unavailable out of sample; Barroso & Detzel (2021) show costs erode them. |
| Crypto factor-zoo literature (2026) | Liquidity proxies dominate whatever else is in the model. Motivated including `log_mcap` and `turnover`. | — |

---

## 5. Current status, stated plainly

The lane is **built, tested, and abstaining.**

A 60-symbol / 2.2-year validation slice was fitted end to end. No feature
cleared the family-wise threshold at either horizon, so nothing was selected
and nothing would be published. Two things explain this and neither is a
defect:

1. The slice covers 2024-06 to 2026-09 — which the table in §3 shows are two of
   the three weakest years in the whole sample (+0.11% and +1.16% edge).
2. 60 symbols and 52 weeks is underpowered against a Bonferroni bar. A window
   sweep (26/39/52/65/80 weeks) confirmed this directly: no feature's |t| grew
   with T the way a real effect's must, and `rvol` hit t = −3.04 at exactly one
   window length while sitting between −1.0 and −1.7 at every other. That is a
   false positive the fixed window happened to avoid, and it is the reason the
   threshold was left strict rather than lowered.

The production fit runs on ~157 crypto symbols with 156 weekly cross-sections
back to 2014. Whether the edge measured in §3 is large enough to clear an
honest multiple-testing bar is now an empirical question the daily job will
answer on its own.

**Abstention is the designed outcome, not a failure.** The lane logs forecasts
regardless, so evidence accumulates whether or not anything is ever published;
and a published surface requires 200 matured observations per decile with
t ≥ 2.0 on mean excess return over the equal-weighted class.

### Two things worth watching

- Every symbol in the archive has date gaps — BTC has 11 missing days in an
  827-day window. Bar-index arithmetic across those gaps produced a single
  +120,933% observation during validation, which alone moved every fitted beta
  by two orders of magnitude. Both the fitter and its tests now guard this;
  anything else reading `asset_daily_bars` by index may not.
- `asset_daily_bars` holds 66 stock symbols against a 290-name
  `STOCK_WATCHLIST`. The equity side of this lane will be thin until the
  backfill catches up.
