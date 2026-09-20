# FCS tracked-asset prediction and data audit — 2026-09-19

> **Release update, 2026-09-20:** the broader worker, data-integrity fixes, research workflows and four research/explanation panels are deployed. Migrations 0043–0045 are applied; Oracle funding/OI writes are restored, all seven favorites are pinned in the OI sampler, and 14,630 canonical funding days were backfilled; settlement spot-checks passed for each asset. New model candidates remain research-only. See [release verification and remaining limits](RELEASE_VERIFICATION_2026_09_20.md).


The seven always-tracked assets are BTC, ETH, SOL, XLM, XRP, HYPE and HBAR.
The useful improvement is better input timing and provenance plus separate
per-asset direction and magnitude evaluation. **There is no established new
tradeable direction model.** No new predictor is promoted or permitted to trade.

Changes are implemented in the local working tree. Production deployment,
collector rollout and historical funding repair are **not completed** by this
audit. The live page was read and checked; it still serves the earlier models.
No orders, notifications, historical database rewrites or production configuration
changes were made.

The subsequent [calendar, eight-stablecoin and move-explanation extension](CALENDAR_STABLECOIN_INSIGHTS_2026_09_19.md) adds the requested weekday/extreme studies, tests all eight named stablecoins and documents the confirmed Oracle credential failure.

## Evidence and reproducibility

- [Complete measured report](research-2026-09-19/report.md), including the weekly results.
- [All model metrics, per-asset selections, feature coverage and corrected tests](research-2026-09-19/report.json).
- [Existing hierarchical/adaptive model comparison](research-2026-09-19/native-comparison.json).
- [Independent price checks](research-2026-09-19/price-crosscheck.json).
- [Live payload checks](research-2026-09-19/live-page-check.json).
- [Frozen input panel](research-2026-09-19/panel.json.gz). Source records are retained unchanged.
- [Continuation and rollout instructions](PREDICTION_ROADMAP.md).

The specialist run includes 27 direction candidates, 13 magnitude candidates,
and two specialist combinations, with a separate validation-based selector for
each objective. Candidates include scaled multiple ridge regressions, logistic
regressions, nearest-neighbor models, momentum/reversal, historical median,
EWMA, a multi-window volatility blend and a fitted HAR-like absolute-return
proxy. The latter is **not** HAR-RV estimated from intraday realized variance.

Every asset has its own fitted transforms, coefficients, validation losses and
model selections. A hierarchical comparison additionally measures partial pooling
across these seven assets; its results are not a remeasurement of the full
production-universe prior.

The evaluation window starts 2026-03-23, with 178 disjoint daily outcomes per
asset and 25 weekly outcomes for the six long-history assets. HYPE lacks enough
weekly history for the nested train/validation protocol and correctly returns
`insufficient-history`. Native estimators have slightly different terminal
maturity/weekly anchors; their JSON reports individual and common-date counts.

## Which model suits which asset?

These are **descriptive test-set winners**, not deployed choices. Selecting one
after seeing this table requires subsequent untouched forward validation. The
last column measures the selector that really chose using earlier validation.
MAE is error in absolute close-to-close percentage return, not high-low range.

| Asset | Lowest daily magnitude MAE candidate | MAE, percentage points | Historical-median MAE | Validation-selected improvement vs median |
|---|---|---:|---:|---:|
| BTC | Historical median absolute return | 0.986 | 0.986 | −1.7% |
| ETH | Calibrated EWMA | 1.287 | 1.357 | +2.4% |
| SOL | Calibrated EWMA | 1.411 | 1.586 | +4.3% |
| XLM | Calibrated daily/weekly/monthly blend | 1.760 | 1.954 | +6.1% |
| XRP | Nearest neighbors with price, OI, funding and depth candidates | 1.381 | 1.435 | −7.5% |
| HYPE | Calibrated daily/weekly/monthly blend | 2.021 | 2.203 | +3.2% |
| HBAR | Calibrated EWMA | 1.165 | 1.465 | +10.2% |

HBAR's nearest-neighbor magnitude candidate, rather than its lowest-MAE EWMA
candidate, is the only comparison passing the conservative family-wise test in
this run (Holm-adjusted p about 0.034 against the median baseline). This is a
research hypothesis, not proof of future performance. The bootstrap has finite
Monte Carlo resolution; report the uncertainty and replicate forward.

**Direction:** the selected daily classifier's Brier loss is worse than the
asset's trailing base-rate forecast for all seven assets. Some hit rates exceed
50%, but that neither establishes calibrated probabilities nor profitable
execution. A 50% constant-probability forecast explicitly abstains on direction.
Accuracy in the report is conditional on an active sign; `active` is recorded.

**Multiple regression:** the existing hierarchical daily point forecasts have
out-of-sample R² below zero for BTC, ETH, SOL, XLM and HYPE over this window;
HBAR and XRP have small positive values (about 0.013 and 0.005). These isolated
point-estimate improvements are not a proven per-asset directional edge. The
larger model is generally weaker at magnitude than the volatility specialists.
Intervals remain a separate question: native daily 80% interval coverage ranges
roughly 79–86%; coverage alone does not establish sharpness or trading value.

**Combination:** `(2*p_up-1) × predicted_abs_move` mostly worsens signed return
error against zero. We also evaluate probability times separate positive and
negative conditional move sizes. Neither is promoted. A magnitude model must
never supply a direction vote by itself. HBAR's positive weekly combination R²
comes from only 25 outcomes and is insufficient for a trading claim.

**Leading assets:** all six other favorites are tested as predictors of each
asset, using strictly prior-day one- and three-day returns. The comparison is
incremental to an own-price/volume/OI logistic model on identical outcomes.
None survives correction across the research family. This does not rule out
intraday leadership or economic relationships; daily samples cannot settle
those questions.

## Data defects found and changes made

1. **Funding overwrite and false source labels.** The snapshot writer could
   replace a settled rate while retaining `source='binance-fapi-direct'`.
   BTC rows on September 12–14, for example, jump from decimal settlement
   magnitudes to snapshot-scale values while retaining the Binance label.
   The SQL now protects direct settlements and updates provenance when an
   eligible rate changes. A real SQLite integration test proves the priority
   rules. Existing suspect values are preserved for audit, not silently fixed.
2. **Incomplete funding days and truncated history.** The collector previously
   stored today's partial settlements and resumed on the next day, leaving
   incomplete observations permanent. It now admits only completed UTC days,
   rereads two watermark days, deduplicates timestamps, rejects conflicting
   duplicates and supports `COLLECT_FROM_DATE` to repair truncated backfills.
   It reuses scaled contract-symbol mappings, prioritizes favorites and sorts
   other assets by oldest watermark. A bounded fetch respects the run budget.
3. **Carry was mislabeled.** Mean settlement rate is not daily funding paid.
   Additive migration 0043 creates `funding_settlement_daily`, storing observed
   sum, mean, count and first/last settlement timestamps separately. It assumes
   no fixed three-settlement cadence. A complete-day boundary is not itself
   proof that the source returned every scheduled settlement; retain counts
   and confirm interval changes against venue metadata.
4. **HYPE/CoinGecko day alignment.** Market-chart daily samples at midnight
   were treated as same-date closing bars. Joining them to a same-date BTC
   close could expose future benchmark information. Research readers now
   align legacy CoinGecko samples to the preceding UTC close, preserve
   `sourceDate`, and avoid shifting twice. The fix applies to adaptive,
   hierarchical and specialist research. It does not rewrite stored dates.
5. **Current supply leaking backward.** The hierarchical loader attached the
   current maximum supply to historical circulating supply. It now uses
   dated matching supply snapshots and leaves earlier maximum supply missing.
6. **Stale and wrong-class optional inputs.** Exact-date OI/funding changes
   replace stale forward-filled changes. Equities cannot consume same-ticker
   crypto derivatives or supply. Invalid calendar dates are rejected.
7. **Historical cutoff.** Hierarchical research now passes the cutoff into
   sample construction so future target bars cannot enter an earlier run.
8. **Wrong reproducibility hash.** The previous hierarchical hash used only
   asset count, bar count and date. Different values with identical counts
   produced the same run ID and could be ignored on persistence. It now hashes
   the panel contents. Changed input values are covered by a regression test.
9. **Derivatives parser.** Duplicate timestamps no longer inflate sample
   counts, conflicting duplicates fail, wrong symbols are excluded, blank
   numbers remain missing, and quantity OI is attached to the same closing
   timestamp as USD OI.
10. **Visible coverage.** The hierarchical summary carries seven-asset data
    checks. Dashboard code displays freshness, short histories and mixed
    funding provenance separately from predictive confidence. A scheduled,
    read-only audit workflow preserves panel inputs and results as artifacts.

Version separation: adaptive `adaptive-ridge-v2`; hierarchical
`hierarchical-mlr-v4` / experimental `hierarchical-mlr-v4-exp`. The specialist
experiment is `tracked-specialists-v1`. Earlier versions' evidence is retained.

## What the archive actually supports

Most favorites have 2,086 price rows since January 2021, around 1,357 OI days
and a similarly deep order-book archive. HYPE has 393 price rows and 477 OI
rows. Daily price data for the long-history favorites ended September 17 at
the read; HYPE also ends September 17 after midnight alignment.

Funding has only 173 rows for most favorites, 90 for HYPE. Of those, 169/86
carry a Binance source label, with the last such row September 14. **These are
not verified settlement days** because the writer bug undermines provenance.
The latest four completed dates are CoinGecko snapshots. Older notes describing
77,000 funding rows across the universe did not mean several years of funding
history for each favorite. The funding feature ablation is diagnostic only
until a fresh event-level settlement backfill repairs and verifies these rows.

The new study uses source-isolated funding percentiles rather than mixing raw
rate units; that cannot repair a false source label. It adds OI **quantity**
changes alongside USD OI to separate contracts added from mechanical price
revaluation. Each model input gets its own training-only missingness indicator;
missing volume or partial optional coverage is not a measured zero.

18 independent Binance spot closes were checked across six assets and three
dates. 16 were within 1% of the archived aggregate close. XRP on September 8
was −2.19%, HBAR +1.75%; these remain review items, not automatic corruption
judgments. HYPE's requested Binance spot files returned 404, so that check is
unavailable rather than passed. Use an appropriate HYPE venue next.

## Validation rules and remaining limits

- Chronological inner training, purged validation and later outer evaluation.
  Model choice uses only matured validation targets; refits occur every 28 days.
- Daily labels are disjoint. Weekly labels are seven calendar days and disjoint
  within each asset. Missing sessions are rejected rather than index-skipped.
- Training-only imputation, scaling, availability selection and regularization.
  Appending/changing future outcomes cannot alter an earlier prediction.
- Direction: Brier/log loss, active and balanced accuracy, and an illustrative
  flat-cost signed-return score. Magnitude: MAE against a strong historical
  median baseline and Spearman ranking. Signed return: R² against zero.
- Paired circular block bootstrap (20,000 replicates; seven daily or two weekly
  observations per block); Holm correction across direction, magnitude, feature
  ablation and leader tests. Observational bootstrap inference remains approximate.
- Optional daily research features are delayed one day because the archive
  lacks original publication/first-seen timestamps. Native comparisons retain
  the existing historical close convention and are not executable backtests.
- Current favorites are a selected surviving universe. No claim of a
  survivorship-free security master is made, even for established assets.
- Costs use 20 bps round trip, excluding funding, borrow and market impact.
  None of these net-return numbers is a deployable trading simulation.
- The six-month period is a retrospective test, not a registered untouched
  forward holdout. Nightly reruns do not create new independent evidence.
- No finite model collection is exhaustive. Options, macro release vintages,
  token unlocks, venue basis, intraday liquidation/order flow and execution
  friction require further data work. See the roadmap for acceptance gates.

Verification completed: model/data-quality/storage suites, all 20 experimental
hierarchical checks, 39 derivatives checks, 76 rendered-dashboard checks,
worker integration, health checker and 11 Python research tests passed. The
normal model suite skips its separately executed experimental-only case.
No order-execution code changed. Local funding-vote changes are versioned as
v9 as described below. Existing unrelated edits under `trading-bot/README.md`
and `multi-market-bot/` were left alone.

## Primary research references

- [Binance market-data API](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data):
  settlement timestamps and rate pagination, OI quantity/value distinctions,
  and bounded lookback on rolling statistics. Archive short-retention feeds
  continuously; a later backfill cannot be assumed.
- [CoinGecko market-chart documentation](https://docs.coingecko.com/reference/coins-id-market-chart)
  and [daily timestamp changelog](https://docs.coingecko.com/changelog/10122018):
  daily midnight sampling and delayed availability justify explicit time alignment.
- [scikit-learn TimeSeriesSplit](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html):
  chronological evaluation and exclusion gaps; this study implements its own
  stricter target-maturity checks and non-overlapping calendar-horizon labels.
- [Corsi, 2009, HAR-RV](https://doi.org/10.1093/jjfinec/nbp001):
  different volatility horizons motivate the magnitude candidates. The simple
  close-return blend is clearly distinguished from the fitted realized-volatility model.
- [Cloudflare D1 CLI](https://developers.cloudflare.com/d1/wrangler-commands/):
  read-only remote audit queries and the separate migration rollout procedure.

## Extension: trading times, conditional rules and stablecoin turnover

See the [full timing report](research-2026-09-19/session-report.md),
[all timing/flow statistics](research-2026-09-19/session-report.json),
[checked archive manifest](research-2026-09-19/session-manifest.json) and
[stablecoin context](research-2026-09-19/stable-context.json).

The extension collected 582 checksum-verified public hourly archives; 66
requested instrument/period combinations were unavailable, and no fetch failed.
Each of the six spot assets has 32,566 hourly bars from 2023. HYPE has 11,438
**perpetual**, not spot, bars starting May 2025. Missing hours and incomplete
local days are excluded, never filled with flat returns or zero volume. DAI's
requested pair was unavailable. USDC/USDT begins in March 2023, consistent with
its venue listing; missing pre-listing data is not zero turnover.

Development ends December 31, 2025. The later holdout contains approximately
260 complete daily observations per asset. Local times use IANA time zones,
including 23/25-hour New York daylight-saving days. These are clock windows:
weekday analysis includes exchange holidays. Hourly bars cannot isolate the
09:30 NYSE open, so no claim is made about its exact first half-hour.

### When do the largest moves occur?

The following hours were selected using **development data**, then tested on
later data. Each hour's absolute open-to-close move is normalized by its day's
average absolute hourly move, reducing volatility-regime confounding. These
are activity patterns, not buy/sell instructions.

| Asset | Weekday busiest hours, Eastern | Holdout uplift vs typical hour | Weekend result |
|---|---|---:|---|
| BTC | 09–10, 10–11, 11–12 | +66.7% | 18–19, 20–21, 21–22 replicated |
| ETH | 09–10, 10–11, 11–12 | +59.7% | 18–19, 20–21, 21–22 replicated |
| SOL | 09–10, 10–11, 11–12 | +49.8% | Selected evening hours unconfirmed |
| XLM | 09–10, 10–11, 11–12 | +43.5% | Unconfirmed |
| XRP | 09–10, 10–11, 11–12 | +52.1% | Selected evening hours unconfirmed |
| HYPE perpetual | 09–10, 10–11, 12–13 | +26.2% | Insufficient development weekends |
| HBAR | 09–10, 10–11, 11–12 | +46.8% | Selected evening hours unconfirmed |

All listed weekday activity effects survive the combined Holm correction.
No individual hour establishes a direction after the correction and 20 bp
cost threshold. The report also contains hourly high-low ranges and separate
all-day/weekday/weekend profiles. HBAR's all-days selection includes 20–21 ET;
that is different from its weekday-only selection.

### Evidence-backed “if” statements

**Descriptive statement:** if BTC rose from 08:00 to 10:00 ET, the next New York
midnight close exceeded the previous midnight close in **70.9% of 117** holdout
cases. If it fell, the daily close was lower in **67.8% of 143** cases.
However, the return **after 10:00** continued the morning direction in only
**57.3%** of up cases and **48.3%** of down cases. This does not establish a
profitable continuation rule.

For each asset, the study tests both signs across New York midnight, morning,
afternoon and evening, London morning and Tokyo morning windows. Every window
has a subsequent, nonoverlapping four-hour target. The requested NY morning
rule also has three explicitly different closing definitions: NY midnight,
16:00 ET, and UTC midnight. Daily-close classifiers control for distance from
the prior close, trailing return and trailing volatility before testing the
morning move's incremental value. No tested rule clears both the corrected
incremental prediction test and the cost-adjusted subsequent-return test.
The full JSON preserves every result, including failures; there is no selected
“winning rule” hidden among many failed hypotheses.

### Is stablecoin activity useful?

The historical test uses **USDC/USDT quote turnover divided by BTC/ETH/SOL USDT
quote turnover on the same exchange**. The numerator and denominator contain
disjoint pairs. It is a venue-specific stable-to-stable turnover proxy, not
all stablecoin volume, stablecoin issuance, net inflow, or the entire market.
BTC/ETH/SOL's daily rebalanced equal-weight index is the broad-direction proxy;
it excludes the rest of crypto. Provider-wide stablecoin asset volumes can
count opposite sides of the same trades and must not be called independent
capital flows.

Features are delayed a full day beyond the measured UTC day. Supply growth
uses an additional two-day publication lag because historical first-seen
vintages are unavailable. Supply is all pegs valued in USD, not only USD pegs.
Separate tests add the ratio, add stable volume after controlling for major
crypto volume, and add 1/7/30-day supply growth. Weekly tests with fewer than
40 holdout observations abstain.

The ratio's descriptive holdout Spearman correlation with subsequent signed
returns is weak: approximately **0.04–0.11** across the seven assets and **0.067**
for the three-asset market proxy. Correlation with subsequent absolute return
is approximately **−0.06 to −0.17**. These are descriptive associations, not
independently confirmed statistical discoveries.

No tested stablecoin direction model survives correction. Ratio-based
magnitude regression improves over a fitted price/volatility regression for
SOL, XRP, HBAR and the market proxy, but **none reliably beats the simpler
historical-median magnitude baseline**. The volume-controlled sensitivity also
fails to establish superiority over that median. No stablecoin feature is
promoted. The small negative magnitude correlation is a hypothesis worth
recording forward, not evidence of a dependable directional forecast.

Only **18 completed days** of existing global stablecoin snapshots are
available. Their rolling 24-hour windows and changing constituents cannot be
spliced into the longer calendar-day exchange series. The new immutable
`market_flow_observations` table logs explicitly identified USD stablecoins
and named crypto assets from the same provider snapshot, with observation time,
provider time, rolling USD volume, market cap, price and quality flag. This is
implemented for future builds; the table has not yet been deployed or populated.

### Implemented continuation and version safety

- Weekly **Signals Session and Stablecoin Research** collects checksum-verified
  hourly archives, checks data contracts, reruns the fixed study, preserves
  full artifacts and stores a non-actionable summary. The next normal signals
  build attaches it to the dashboard. Stale summaries are labeled after ten
  days. It does not send alerts or promote a model.
- The timing dashboard shows per-asset weekday/weekend hours, missingness,
  conditional close versus subsequent-return percentages, and stablecoin
  evidence status. The prior hardcoded claim equating 20:00 UTC with 16:00 ET
  year-round was removed.
- Live funding percentiles now compare only provider- and venue-matched snapshots.
  `funding_snapshot_daily` independently preserves those observations, including
  venue, contract ID, raw unit label and observation time; protecting canonical
  settlements no longer prevents comparable snapshot history from growing. A
  provider-native rate cannot fall back to fractional settlement thresholds.
  This changes a live vote, so the corrected model is **confluence-v9** and
  starts a separate evidence cohort. `forecast_run_versions` records the
  version when a forecast is logged; pending legacy votes cannot mature as v9.
  Existing history remains stored, but no longer establishes the corrected
  model's live track record. Expect abstention while new evidence accumulates.
- Migration `0044_session_flow_research.sql` adds the observations, summaries
  and forecast-version table. Apply it together with the code release. This
  audit did not change the live deployment or its historical records.

The complete timing/flow family has **887** tests with fixed-seed, paired
moving-block bootstrap intervals and Holm correction. Retrospective holdout
and repeated weekly inspection remain limitations; fresh prospective evidence
is required before claiming production accuracy. The bootstrap tail has finite
Monte Carlo resolution (20,000 draws); borderline corrected p-values are not
proof of a stable trading effect.

Primary sources for this extension:

- [Binance public archive format and checksum policy](https://github.com/binance/binance-public-data/blob/master/README.md):
  source column definitions and spot microsecond timestamps beginning in 2025.
- [Binance stablecoin pair listing and fee promotion](https://www.binance.com/en/support/announcement/detail/dd331bed50bb44f485e47aed132bfc02):
  March 2023 USDC/USDT and TUSD/USDT listings; venue changes and fee incentives
  can alter turnover independently of a market forecast.
- [NYSE trading hours](https://www.nyse.com/trade/hours-calendars) and
  [Japan Exchange Group trading hours](https://www.jpx.co.jp/english/equities/trading/domestic/01.html):
  distinguish exchange sessions from 24/7 crypto clock windows.
- [BIS: measuring stablecoin, crypto and DeFi ecosystems](https://www.bis.org/publications/working-paper-1377-hidden-complexity-measuring-stablecoin-crypto-and-decentralised-finance-ecosystems):
  measurement and use-case differences motivate separating trading turnover,
  on-chain activity and circulating supply; they do not validate our forecasts.

The final collector check additionally covers interrupted pagination: a page or
time limit withholds the final historical day rather than publishing partial
settlement carry. Resume watermarks come from `funding_settlement_daily`, so a
crash after legacy-row writes cannot skip missing canonical history.
