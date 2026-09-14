# FCS model improvements and measured limits

This change preserves the confluence engine, its indicators, previous research,
outcome ledger, publication thresholds and trading integrations. It fixes data
and evidence defects and adds a separate, reproducible adaptive model. No
historical observations or techniques are deleted, and the challenger does not
authorize orders or change existing trade weights.

## Findings verified against production

Read-only D1 queries on 2026-09-14 found 2,216,190 archived daily observations
across asset, market, sector and context series. The outcome ledger contained
1,147,978 rows: 80,320 live and 1,067,658 replay. These populations are not
interchangeable evidence of live execution performance.

The public API returned 225/242 crypto daily histories and 290/290 stock
histories at `2026-09-14T17:40:50.252Z`. The independent stale-cache monitor's
recorded dispatch at `2026-09-14T15:41:23.556Z` failed with GitHub HTTP 403.
Wrangler's existing OAuth session allowed database inspection; it does not
repair the separate GitHub token held by the Worker.

Both BTC and ETH had these missing archive dates, with **zero quarantined
rows**: August 1, 4, 7, 10, 13, 16, 19, 22, 25, 28; September 4 and 10.
The old refresh predicate skipped data while the newest date was less than
three days old, and writes excluded holes inside MIN/MAX. These dates match
the resulting failure pattern. Having a recent MAX(date) hid the missing data.

## Corrections to existing paths

- Daily Yahoo/CoinGecko archival now excludes the current UTC date. Since an
  existing close is immutable, accepting an unfinished session could previously
  freeze an intraday quote as its final daily close. Existing stored prices are
  retained; this change does not claim to have retrospectively corrected them.
- Daily ingestion requests yesterday's completed data instead of accepting a
  three-day delay. It checks actual stored dates to fill internal gaps. A
  Sunday refresh also audits older history. Current missing data is offered for
  every asset first (up to 32 rows each), then the remaining budget deepens
  history (up to 3,000 rows per asset). This prevents a few long series from
  consuming the budget before the rest get current observations.
- Yahoo daily dates are now filtered with their quotes. A missing close no
  longer shifts every later date by one position.
- Live and replay benchmark correlations match the start and end dates of
  returns. Seasonal analogs retain their relative-window comparison, since
  different historical years deliberately do not share calendar dates. This
  corrects date alignment; it does not establish that every provider's daily
  close has identical timestamp semantics.
- `loadReliability` now filters composite evidence to the active weighting
  model, as its existing contract requires. Previously both queries also
  admitted v7 composites through the compatibility list. Unchanged individual
  technique evidence from v7/v8 is retained, and old composite rows remain in
  the ledger for inspection.
- The archive request timeout now covers reading the response body as well as
  receiving headers.
- Replay documentation no longer claims that using fewer inputs must produce
  a lower bound on live skill. Adding inputs can improve or worsen an ensemble.
  No research results were erased on the basis of this documentation correction.

## The additive model

`adaptive-model.mjs` fits a joint ridge regression for each asset and horizon.
Inputs are volatility-normalized returns over 1/5/20 observations, trend,
relative volume, benchmark movement and relative movement. Market-input
availability is explicit. Fitting correlated inputs jointly with regularization
reduces the incentive to count similar indicators as independent confirmations.
The model learns signed coefficients, so reversal or continuation can emerge
from outcomes rather than being prescribed for every asset.

Fixed initial settings, chosen before the first archive run: ridge penalty 20,
180-calendar-day forgetting half-life, 80% nominal error bands, and a 20-basis-
point round-trip cost assumption. No parameter search or winning-symbol
selection was performed after seeing these results. Prior outcomes decay with
age; raw outcomes and reported losses are never clipped. Normalized training
targets are bounded for numerical robustness only.

The historical loop predicts first, waits for a non-overlapping target to
mature strictly before a later decision, scores it, then updates weights.
Features are computed only from past bars. Rebuilding from the fixed
2021-01-01 archive origin is deterministic, so a retry does not accidentally
train twice on the same sample. One/seven-calendar-day crypto horizons and
one/five-trading-session stock horizons are explicitly different labels.

Intervals use the last 180 matured, prequential residuals, scaled by volatility
known at prediction time, with a finite-sample quantile rank and minimum 30
residuals. Coverage and width are measured separately from direction and
profit. This is an empirical rolling residual interval, **not** an implementation
of adaptive conformal inference with a distribution-free guarantee.

Reports retain full-history and recent performance, early/late after-cost
returns, a zero-return forecast error baseline, a buy-and-hold return baseline,
band coverage/width, and a hypothetical full-exposure drawdown. Benchmarks get
their own models: SPY is a US large-cap proxy; BTC is Bitcoin; MCAP:BROAD is a
tracked-crypto proxy; MCAP:TOTAL is market capitalization. None is labelled a
forecast for the entire global financial market.

## First full archive run

The read-only run used 468 assets and 936 asset/horizon combinations, as of
2026-09-14. Of these, 610 had usable recent features; 326 had stale/insufficient
inputs. A fresh feature window is not a validated trade. Recent holes prevented
BTC and ETH from producing a current forecast even though their latest raw bar
was September 13; their earlier walk-forward results remain available.

| Target | Horizon | Scored predictions | Direction accuracy | Mean absolute error | Zero-return error | 80% band coverage | Mean net return per evaluated period |
|---|---|---:|---:|---:|---:|---:|---:|
| BTC | 1 day | 1,946 | 48.92% | 2.017% | 1.987% | 80.31% | -0.1630% |
| ETH | 1 day | 1,946 | 49.54% | 2.734% | 2.699% | 80.73% | -0.2455% |
| SPY | 1 session | 1,336 | 51.35% | 0.755% | 0.751% | 79.23% | -0.0115% |
| MCAP:BROAD | 1 day | 1,989 | 51.84% | 2.390% | 2.382% | 80.90% | -0.0278% |

Among individual assets with at least 100 daily outcomes, 30/244 crypto and
0/204 stocks had lower absolute error than the zero-return forecast. Positive
net returns in both chronological halves occurred for 43 crypto assets and two
stocks; these are descriptive counts across many trials, **not selected trading
opportunities**. Across-date group summaries are not treated as independent
portfolio evidence when different assets' multi-day windows overlap.

The first run does **not** justify live promotion. Approximately correct
marginal interval coverage can coexist with no directional or economic edge.
The report is useful precisely because those claims are measured separately.

## Automation and reproducibility

`signals-adaptive.yml` runs after Signals Daily and on a daily fallback schedule.
It tests the learner, applies the additive migration, reads the archive, stores
immutable snapshots and uploads Markdown/JSON reports. A run becomes visible
only after all snapshots are stored. Identical inputs/configuration produce
the same run ID, making retries idempotent. The hourly payload exposes only
research health and aggregate diagnostics, with `actionable: false`; individual
research forecasts stay in the report/snapshot tables.

```bash
cd signals-worker
node --test test-adaptive-model.mjs
node scripts/adaptive-research.mjs --wrangler --dry-run \
  --save-input /tmp/fcs-adaptive-panel.json --output reports/adaptive
node scripts/adaptive-research.mjs --input /tmp/fcs-adaptive-panel.json \
  --as-of 2026-09-14 --dry-run --output reports/adaptive
```

The local Wrangler adapter runs SELECTs only and uses the existing OAuth
session without reading or copying its credential. Actions use the existing
D1 environment variables. The output records an input hash, model version,
configuration, data quality, weights, forecasts and metrics.

Validation: 14 new causal/data/SQL integration tests, the 974-check Worker
harness, 26 replay assertions, 37 cross-sectional assertions, 19 quarantine
assertions, and a successful Wrangler deployment dry run. The two Worker
source copies are byte-identical. This work has not submitted orders or
rewritten existing production history.

## Research basis and remaining evidence

- [scikit-learn's time-series split documentation](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html)
  describes chronological validation and a train/test gap. The implemented
  learner goes further at each decision by enforcing label maturity and
  non-overlapping training examples.
- [Ridge regression documentation](https://scikit-learn.org/stable/modules/linear_model.html#ridge-regression-and-classification)
  motivates a regularized joint fit for correlated inputs. This is a transparent
  first challenger; greater model complexity would need incremental validation.
- [Gibbs and Candès, Conformal Inference for Online Prediction with Arbitrary Distribution Shifts](https://jmlr.org/papers/v25/22-1218.html)
  motivates checking uncertainty over time under changing distributions. Its
  guarantees are not claimed for this simpler residual estimator.
- [Bailey et al., The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)
  explains why searching many variations can manufacture an apparent winner.
  That motivates frozen initial settings, complete reporting, and no promotion
  from a favorable in-sample cell.
- [CoinGecko's historical-chart documentation](https://docs.coingecko.com/reference/coins-id-market-chart)
  documents midnight daily observations. Provider timestamp conventions,
  previously frozen partial bars, adjusted prices/corporate actions, and
  source changes still require a versioned reconciliation audit before making
  strong live-performance claims from the existing archive.

The archive contains current/tracked membership and retrospectively identified
quarantines; it is not a survivorship-free point-in-time security master.
The new learner's input set is currently price/volume/benchmark data; existing
fundamental, derivative, event and sentiment lanes remain in confluence and
cross-sectional research. Incorporating them into this challenger requires
availability timestamps and incremental, held-out feature tests.

Before using the new forecasts for trading: demonstrate a stable advantage on
previously unseen forward observations measured from actual issue-time quotes,
correct multiple comparisons across any selected asset/strategy family, model
venue-specific spread/fees/slippage/funding/borrow, and verify interval coverage
in recent regimes. Repair the GitHub stale-refresh dispatch credential before
depending on that monitor. These requirements follow from the observed negative
results and the live 403, not from a claim that predicting exact tops and bottoms
is achievable with enough indicators.
