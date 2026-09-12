# Derivatives lane: open interest, positioning, and what they actually predict

Method version `fcs-derivatives-v1`. Created 2026-09-11 in response to:
*"does the model track perpetual futures open interest? ... see how it
correlates with other metrics and how, when and how long it drives asset
prices so we can use it to predict before it happens. for instance, zcash
seemed to have a lot of open interest recently and it kept rising."*

Everything below is **research**. Nothing here is wired to published signals,
learned weights, alerts, or orders.

---

## 1. What the engine had before this

Open interest was already fetched and archived, but only in its weakest form.

* `getFundingMap()` (worker.js) reads CoinGecko `/derivatives` for a **live
  snapshot** of funding, OI and perp-vs-spot basis, keeping the highest-OI
  venue per asset. Archived daily to `funding_rate_daily`.
* One technique, `openinterest` (worker.js), voted on the **level percentile**
  of OI against the asset's own expanding history, gated on `|chg7d| > 8%`.
* `XS_FEATURES` declared `oi_pct` — but the cross-sectional fit builds its
  metrics from `asset_daily_bars` alone, which carries no OI. The feature
  produced **zero weekly betas across its entire lifetime** and silently fell
  out of `tested`. Same for `funding_pct`, `vol_ratio`, `log_mcap`,
  `turnover`: five declared features, never once evaluated. `fitCoefficients`
  now reports these as `untested` on every refit so the gap cannot hide again.

Two defects in the level-percentile design:

1. **It saturates.** A percentile of a trending series pins at 1.00 and stops
   discriminating. ZEC sat at exactly 1.00 from 2026-08-27 to 2026-09-09 —
   fourteen consecutive days spanning its entire run — while OI went
   $227M → $691M. The feature was maximally uninformative precisely when the
   thing it measures was most extreme. The replacement
   (`derivatives-features.mjs`) uses a **rolling 252-day** window.
2. **It is direction-blind.** $700M of OI built by crowded longs and $700M
   built against a short-heavy book are opposite setups with identical OI.

Its live ledger agrees: `openinterest` at the 7-day horizon scored **51/173 =
29.5%**, from 150 bullish votes against 23 bearish, versus a 43.2% base rate
for "up" over the same window (`direction_baseline`, crypto, 168h).

---

## 2. The data constraint, and how it was removed

The original blocker was history: `funding_rate_daily` began 2026-08-02 and
had real gaps (Aug 22–26, 28–29, 31–Sep 1, 3–4 missing). For a 7-day horizon
that is **9–22 independent dates**. Nothing can clear a family-wise bar on
that, and CoinGecko's endpoint is snapshot-only with no backfill path.

Sources checked live on 2026-09-11:

| Source | Result |
| --- | --- |
| `fapi.binance.com` (Binance global trading API) | **HTTP 451**, geo-blocked — confirms the existing note in `archive.mjs` |
| `api.bybit.com` | **HTTP 403**, CloudFront country block |
| Coinalyze | HTTP 401, needs a key |
| OKX `/rubik/stat` | HTTP 200, but aggregate-only |
| **`data.binance.vision`** (Binance public data portal) | **HTTP 200** |

The public data portal is a static bucket on the same host family as
`data-api.binance.vision`, already a proven dependency here for crypto daily
bars. It is **not** geo-blocked, and it carries far more than OI:

```
create_time, symbol, sum_open_interest, sum_open_interest_value,
count_toptrader_long_short_ratio, sum_toptrader_long_short_ratio,
count_long_short_ratio, sum_taker_long_short_vol_ratio
```

288 five-minute bars per symbol per day, back to **2020-09-01** for BTC and
2022 for most majors. Coverage: **141 of the 168** tracked perp symbols (the
six `1000X`-scaled listings are mapped in `VENUE_SYMBOL_OVERRIDES`; the
remaining 27 are mostly exchange tokens with no Binance USDT perp and are
recorded `unavailable`).

This is stored in `derivatives_daily` (migration 0033), deliberately **not**
merged into `funding_rate_daily`: CoinGecko reports the highest-OI venue
across all exchanges while this is Binance-only, so the levels are not
comparable and merging would fabricate jumps at the join seam.

---

## 3. Method

Identical to the cross-sectional lane's, not a new one invented for this:

* **Fama-MacBeth.** Per non-overlapping period, cross-sectionally rank the
  feature, regress that period's forward **excess** return on the rank, keep
  the slope; then t-test the time series of slopes. This is the only honest
  effective sample size — 800 same-day observations across 100 assets are not
  800 independent trials. Counting them as independent is the v6 defect that
  inflated every confidence bound in this engine.
* **Excess return, never hit rate.** Momentum quintiles here run ~46–47%
  accurate in *every* quintile while the top quintile still beats the
  universe; any gate keyed on direction accuracy is blind by construction.
* **Bonferroni across the whole family** (13 features × 4 horizons = 52 tests,
  `|t| ≥ 3.302`), plus sign consistency ≥ 0.55.
* Real dates throughout, never index stepping (`lookback`, `forwardReturn`).

---

## 4. Results

### 4.1 The headline: open interest is coincident, not leading

Cross-sectional beta of `oi_chg_1d` on excess return, by offset, over ~1,348
daily cross-sections spanning 2023-01-01 to 2026-09-10, 140 symbols:

| offset | meaning | beta | t |
| --- | --- | --- | --- |
| −3 | price 3d **before** | −0.358 | −6.84 |
| −2 | price 2d before | −0.469 | −8.63 |
| −1 | price 1d before | −0.637 | −10.90 |
| **0** | **same day** | **4.883** | **55.11** |
| +1 | price 1d **after** | 0.435 | 7.35 |
| +2 | price 2d after | 0.050 | 1.00 |
| +3 | price 3d after | 0.027 | 0.56 |
| +5 | price 5d after | −0.016 | −0.33 |

The contemporaneous effect is **~11× larger** than the forward one and dies
completely after a single day. So, to the question as asked — *how, when and
how long does OI drive prices*:

* **When:** overwhelmingly the same day. OI rises *with* price.
* **How long:** the predictive residue lasts exactly **one day**.
* **Before the move:** nothing. The negative betas at negative lags say OI
  tends to build *after* a down day, not ahead of an up one.

The engine's existing `openinterest: { leading: false }` classification was
right. "Predict before it happens" from open interest alone is not supported.

### 4.2 What does survive

Three features clear the family-wise bar, and they survive a short-term
price-reversal control in the same regression (partial slopes):

| feature | h | periods | partial beta | t | sign% | control t | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `oi_px_divergence` | 1 | 1343 | 0.497 | **9.39** | 59% | −3.12 | survives |
| `oi_px_divergence` | 3 | 448 | 0.712 | **4.47** | 59% | −0.11 | survives |
| `oi_px_divergence` | 7 | 192 | 0.877 | 2.25 | 57% | −0.18 | absorbed |
| `oi_chg_1d` | 1 | 1347 | 0.475 | **8.02** | 59% | −3.87 | survives |
| `oi_chg_1d` | 3 | 449 | 0.626 | **4.17** | 58% | −0.29 | survives |
| `oi_chg_1d` | 7 | 192 | −0.165 | −0.36 | 53% | 0.16 | absorbed |
| `oi_chg_3d` | 1 | 1347 | 0.443 | **7.90** | 58% | −4.60 | survives |
| `oi_chg_3d` | 3 | 449 | 0.533 | 3.36 | 54% | −0.70 | fails sign consistency |
| `oi_range_pct` | 1 / 3 / 7 | — | — | 3.88 / 2.71 / 2.64 | 53% | −3.84 / −0.38 / −0.51 | absorbed |

`oi_px_divergence` = `oi_chg_7d − px_chg_7d`: **leverage building faster than
price has moved.** That is the closest formal statement of the ZEC
observation, and it is the strongest feature in the set. Crucially its t-stat
*rises* under the reversal control (9.12 → 9.39), so it is not reversal
re-labelled — the two effects partly offset. At h=3 the control contributes
essentially nothing (t = −0.11), meaning that horizon is close to pure open-
interest information.

`oi_range_pct` looked significant univariately at h=3 and is **fully absorbed
by price** — a reminder of why the control column exists.

Everything dies at h=7. **The usable window is 1–3 days.**

### 4.3 Positioning: coherent but short of the bar

| feature | h=1 | h=3 | h=7 | h=14 |
| --- | --- | --- | --- | --- |
| `toptrader_position_ls` t | −1.97 | −2.42 | −2.29 | −2.33 |
| sign consistency | 50% | 56% | 57% | **65%** |
| `toptrader_account_ls` t | −3.16 | −2.92 | −1.94 | −0.97 |
| `all_account_ls` t | −2.57 | −2.55 | −1.52 | −0.68 |

`smart_retail_gap` and `taker_buy_sell` are flat everywhere (|t| < 1.4 and
< 1.2 respectively) — no evidence either way.

Consistently negative at every horizon with rising sign consistency: when
Binance's size-weighted top-trader book leans long, forward excess returns are
lower. That is a crowding/contrarian reading and it is coherent — but **no
cell clears `|t| ≥ 3.302`**, so the family abstains. Recorded here so it is
not rediscovered as if new; not promoted.

Worth noting what this layer shows on the motivating case: on 2026-09-09, with
ZEC OI at $697M and price ripping to $1,244, `toptrader_account_ls` was
**0.40** — more than twice as many accounts short as long. Raw open interest
cannot express that, which is the core argument for carrying this family.

### 4.4 Market context: alt-vs-BTC leverage

`alt_btc_oi_ratio` = (total tracked OI − BTC − ETH) / BTC, on **fixed
membership** — only symbols present on both ends of a comparison contribute,
so the 36 → 156 universe widening cannot masquerade as leverage expansion.
Over 1,349 dates: min 0.49, median 0.74, max **1.39**. It *did* exceed 1.0 —
alt OI was larger than BTC's on **155 of 1,349 dates**, clustered exactly
where intuition says it should be: Jan 2023 (11 days), Mar–Apr 2024 (42),
Nov 2024–Jan 2025 (38), Aug–Oct 2025 (42). As of 2026-09-10 it sits at 0.69
with BTC holding 42.1% of tracked OI.

Splitting the flow family at the median is the clearest conditional result:

| regime | `oi_px_divergence` h=3 | verdict |
| --- | --- | --- |
| alt leverage **below** median (0.74) | beta 1.051, t = **5.00**, sign **63%**, n=219 | clears the widened bar (3.434) |
| alt leverage **above** median | beta 0.508, t = 2.00, sign 53%, n=229 | rejected |

The whole flow family tilts the same way: every feature scores higher in the
low-alt-leverage half. This is the single strongest cell in the entire study.

The OI signal works when the market is *not* already saturated with alt
leverage, and degrades when it is. Interpretable, and it clears a correction
widened for the extra conditional tests — but finding significance in one of
two regimes is exactly what happens by chance, so this needs out-of-sample
confirmation before it is treated as structure.

---

## 4.5 Net of costs

A t-stat says a feature carries information. It says nothing about whether the
information survives paying to act on it. Long-short top/bottom quintile,
equal weight, turnover charged at each rebalance, 6.5bp per side (Binance
USDT-perp taker 4.5bp plus spread/slippage), returns demeaned and winsorised
exactly as the regression does:

| feature | h | turnover | gross/pd | net/pd | net t | net ann% | net Sharpe | breakeven |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `oi_px_divergence` | 1 | 0.70 | 0.469 | 0.378 | **7.33** | 138.0 | **3.84** | **33.5bp** |
| `oi_px_divergence` | 3 | 1.15 | 0.735 | 0.586 | 3.77 | 71.3 | 1.98 | 32.1bp |
| `oi_px_divergence` | 7 | 1.68 | 0.957 | 0.738 | 1.76 | 38.5 | 0.92 | 28.4bp |
| `oi_chg_3d` | 1 | 0.86 | 0.346 | 0.234 | 4.82 | 85.6 | 2.61 | 20.2bp |
| `oi_chg_1d` | 1 | 1.41 | 0.403 | 0.220 | 4.26 | 80.3 | 2.29 | 14.3bp |
| `oi_chg_7d` | 1 | 0.60 | 0.270 | 0.193 | 4.04 | 70.4 | 2.19 | 22.7bp |
| `oi_chg_1d` | 7 | 1.42 | −0.136 | −0.321 | −0.84 | −16.7 | −0.46 | **−4.8bp** |
| `oi_level_pct` | 7 | 0.67 | 0.070 | −0.017 | −0.05 | −0.9 | −0.03 | 5.3bp |

**This reordered the findings, and it contradicted the prediction that
motivated building it.** The expectation was that the 1-day horizon — the
statistically strongest — would be the economically worst, because it trades
most. It is not. `oi_px_divergence` at 1d has turnover **0.70**, half that of
`oi_chg_1d` at the same horizon (1.41), because it is built from 7-day changes
and so its rank ordering is persistent even when rebalanced daily. Turnover
tracks the **signal's** speed, not the rebalance frequency. The best feature is
both the strongest and the cheapest.

The genuinely fragile configurations are the ones the gross numbers already
doubted: `oi_chg_1d` at 7d has a **negative** breakeven, meaning it loses money
before any cost is charged, and `oi_level_pct` at 7d breaks even at 5.3bp —
inside realistic cost.

**Read the breakeven column, not the Sharpe.** A net Sharpe of 3.84 is not
credible as a live expectation and should be treated as an upper bound built
from in-sample, full-period, frictionless-fill assumptions. Breakeven is the
robust statement: *the edge survives a cost of up to ~33bp per side.* On
BTC/ETH perps that is comfortable headroom. On an illiquid microcap perp in
this universe, 33bp round-trip is optimistic, and equal-weighting the whole
quintile assumes fills that a real book would not get.

### Data-quality finding

The cost model surfaced corruption in `asset_daily_bars` that the regression
path had been silently absorbing. **37 single-step moves above 300% exist in
the crypto archive**, and the worst are unambiguous breakage rather than price:

| symbol | step | move |
| --- | --- | --- |
| TIA | 0.0105 → 7149.42 in 1 day | +68,063,639% |
| NIGHT | 0.000003 → 0.0986 in 1 day | +3,288,000% |
| ANTFUN | 0.000003 → 0.0220 in 1 day | +732,867% |
| APE | 0.000713 → 2.064 in 1 day | +289,397% |

These look like a ticker remapped to a different asset, or a decimal/scaling
fault. `winsorise()` clips them out of every cross-section before fitting, so
the t-stats above were never affected — but a **portfolio** holds the broken
name at full weight and books the fake return. Before the guard, this backtest
printed −4,103% per period.

`forwardReturn` now rejects any period return beyond ±1000% as a data error and
counts what it drops: **494 of 3,754,616 (0.013%), worst +74,949,216%.** That
protects this lane. It does **not** fix the underlying rows, which remain in
`asset_daily_bars` for every other consumer — worth a separate quarantine pass
in the spirit of migration 0012.

## 5. Honest limits

* **Venue.** Binance USDT perps only. Cross-venue OI can move differently.
* **Costs.** Section 4.5 applies a turnover-aware cost model. The headline
  number to carry forward is the **breakeven (~33bp per side)**, not the net
  Sharpe. Short-leg perp funding is NOT modelled and can be materially negative
  to hold; neither is market impact.
* **Survivorship.** The universe is today's tracked list; delisted perps are
  absent.
* **In-sample.** These are full-sample fits. Promotion into `XS_FEATURES`
  requires the cross-sectional lane's own fixed out-of-sample checkpoint.
* **Not a direction model.** These rank assets against each other. A high rank
  means *expected to outperform the universe*, which in a falling market still
  means losing money.

## 6. Negative results — do not re-litigate

* Open interest does **not** lead price. Measured at 1,347 daily cross-sections
  across 3.7 years; the same-day effect is 11× the one-day-forward effect and
  the two-day-forward effect is indistinguishable from zero.
* OI **level** percentile carries nothing at any horizon (best |t| = 2.01,
  and it saturates on exactly the assets it is supposed to flag).
* `oi_range_pct` is absorbed by price at every horizon.
* `smart_retail_gap` (top-trader vs all-account positioning) and
  `taker_buy_sell` carry nothing at any horizon tested.
* The alt-vs-BTC OI crossing itself (ratio > 1) is not rare — 155 of 1,349
  dates — so it is a regime label, not an event signal. Its value here is as
  a *conditioner* on the flow family, not as a trigger.
