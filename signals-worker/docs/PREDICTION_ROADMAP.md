# Prediction research handoff and rollout

> **Release update, 2026-09-20:** the broader worker, data-integrity fixes, research workflows and four research/explanation panels are deployed. Migrations 0043–0045 are applied; Oracle funding/OI writes are restored, all seven favorites are pinned in the OI sampler, and 14,630 canonical funding days were backfilled; settlement spot-checks passed for each asset. New model candidates remain research-only. See [release verification and remaining limits](RELEASE_VERIFICATION_2026_09_20.md).


Start with [the September 19 audit](TRACKED_ASSET_AUDIT_2026_09_19.md).
This is a continuation plan with explicit unresolved work, not a claim that
coverage or forecasting skill is complete. Work on the seven favorites before
expanding. Preserve existing publication gates and never infer direction from a
magnitude forecast.

## Reproduce the completed study without credentials

From the repository root, using Node 24 and Python 3.12+:

```sh
python3 -m venv /tmp/fcs-research-env
/tmp/fcs-research-env/bin/pip install -r signals-worker/scripts/tracked-research-requirements.txt
gzip -dc signals-worker/docs/research-2026-09-19/panel.json.gz > /tmp/fcs-audit-panel.json
node signals-worker/scripts/tracked-research-data.mjs /tmp/fcs-audit-panel.json /tmp/fcs-audit-rows.json
OPENBLAS_NUM_THREADS=1 /tmp/fcs-research-env/bin/python signals-worker/scripts/tracked-research.py --input /tmp/fcs-audit-rows.json --output /tmp/fcs-audit-results
node signals-worker/scripts/tracked-native-comparison.mjs /tmp/fcs-audit-panel.json /tmp/fcs-audit-results/native-comparison.json
```

Compare `inputHash`, `codeHash`, versions and metrics with the frozen report.
The generated rows are large and intentionally excluded from git. The raw
panel is frozen and compressed in the evidence directory. No account secrets
are in it. Remote input collection is read-only:

```sh
node signals-worker/scripts/hierarchical-research.mjs --wrangler --dry-run --symbols BTC,ETH,SOL,XLM,XRP,HYPE,HBAR --as-of 2026-09-19 --save-input /tmp/fcs-fresh-panel.json --load-only
```

Replace `--as-of` with the desired cutoff; never compare changed histories as
though they were the same experiment. Credentials are handled by Wrangler's
existing login or the standard D1 environment variables; do not print them.

## 0. Scheduled-job reliability, September 20

Three scheduled jobs were failing when this section was written. They are not
one story, and only the first is fully explained.

**Signals Replay — fixed.** It read the D1 database id from
`secrets.FCS_D1_DATABASE_ID`; the other nineteen workflows read
`vars.FCS_D1_DATABASE_ID`. GitHub substitutes an empty string for an undefined
context entry without warning, so the job ran, checked out, and applied
migrations successfully — Wrangler resolves the database by NAME and never
needs the id — then failed one second into `replay-history.mjs` on its own
argument check. It had never succeeded: runs #1 (09-13) and #2 (09-20) failed
identically. `test-workflows.mjs` now fails on any name read from two contexts,
on a D1 script whose workflow omits a credential, and on a scheduled job with
no `timeout-minutes`; `signals-deploy.yml` runs it before the Worker tests.
**The replay has therefore still never produced a walk-forward ledger.** Its
first green run is new evidence, not a regression check — read the edge report
against the baseline before treating any of it as confirmation of skill.

**Signals Retrospective — cause NOT established.** Run #20 (09-20 09:19Z)
failed after 19 consecutive successes, 11 seconds into `retrospective.mjs`,
with migrations already applied. The code was unchanged, and migrations
0043–0045 only create new tables, none of which it reads. The step log needs
admin auth, so the actual error was never seen; do not record this as diagnosed.
Two things were hardened on the evidence available, neither confirmed as the
cause:

- The retry predicate retried **only 429**, so a 502/503 from CoinGecko's edge
  or a dropped connection aborted the run with no retry at all — and this job
  makes its wide market scan first, before anything else can start. 11s fits
  that shape; an exhausted 429 backoff would have taken 21s or more. Now shared
  as `isRetryableFetchError` (429, any 5xx, transport failures; 4xx still fails
  fast) between `worker.js` and the script's own loop.
- `refreshFeatureCorrelations` read `retrospective_feature_snapshots` with one
  unbounded SELECT. That table is appended to every daily run and is never
  pruned, which is the same slow-motion D1 7010 that killed Signals Discovery
  for five days once `asset_daily_bars` outgrew a single response. It reads
  through `readAllRows` now. This is a latent fault fixed on its own merits;
  it runs late in `main()`, so it is unlikely to explain an 11s failure.

If the retrospective fails again, get the step log before changing anything
else. Re-verify by watching runs, not by reasoning about the diff.

**Signals Health** failed twice (#223, #224) and recovered on its own at 08:06Z
with no change. Left alone deliberately.

## 1. Completed release and follow-up monitoring

The release and one-off funding repair below were executed September 20;
see the release verification for evidence. Preserve these instructions for
reproduction. Two normal daily and weekly cycles still need observation;
one successful manual run does not establish long-term feed reliability.

1. Run the verification commands below and release the corresponding worker,
   scripts, tests and workflows together through the repository's normal path.
   Preserve unrelated working-tree edits. Keep worker.js and src/worker.js equal.
2. Apply migrations `0043_funding_settlement_daily.sql` and
   `0044_session_flow_research.sql` before the new collector
   runs. Existing deployment workflow applies migrations before worker deploy;
   `schema.sql` and the fresh-database migration baseline are also updated.
3. Oracle received the narrowly scoped funding collector and OI-watchlist
   changes with backups. Both services and Binance/D1 reachability were
   revalidated. Future deployments must preserve the trading service and
   existing runtime lock; do not replace the whole checkout indiscriminately.
4. Verify `fcs-binance-collector.timer` and its service are active, inspect recent
   success/failure logs, then run the controlled backfill below under the existing
   runtime lock. Do not change orders or stop the trading service for research.
5. Run the hierarchical job once. Confirm the public payload reports
   `hierarchical-mlr-v4`, includes `dataQuality`, and shows all seven symbols.
   The adaptive job should report `adaptive-ridge-v2` after its refresh.
6. Enable/verify **Signals Tracked Asset Audit**. It follows Signals Daily with
   a daily fallback schedule and writes artifacts only. It cannot promote a
   model or send a trade/notification. Inspect artifacts even on a failed job.

Acceptance: the pipeline has two consecutive completed daily archives with
fresh prices/derivatives, canonical funding counts, coherent source units and
visible per-asset warnings for any remaining gaps. An HTTP success or green
workflow alone is not acceptance.

## 2. Canonical funding repaired; retain source-isolation rules

The seven-asset canonical history was repaired September 20. Legacy history
remains unsuitable for pooling indiscriminately across measurement types. `funding_rate_daily` contains snapshots and settlement means, and some
Binance-labeled values were overwritten by snapshots. Never multiply the old
mean by three and call it daily carry; cadence can change.

On the configured collector host, with the existing service environment and
lock, run the collector with:

```text
COLLECT_SYMBOLS=BTC,ETH,SOL,XLM,XRP,HYPE,HBAR
COLLECT_FROM_DATE=2019-09-01
COLLECT_TIME_BUDGET_MIN=20
node scripts/binance-direct-collect.mjs
```

This is a one-off historical repair; remove `COLLECT_FROM_DATE` for incremental
runs. Check the logged stop reason; a time/page limit is not complete coverage.
For a long hourly-settlement listing, resume from the newest completed repaired
date if a forced-from-origin run reaches its page cap. The collector rereads
watermark days from the canonical table and uses settlement timestamps. A
truncated page stream drops its final day. A crash after legacy writes cannot
advance the canonical watermark past data that was not written. Repeats are safe.

Verify per asset:

- First settlement date is consistent with contract listing and the provider's
  available history; favorite histories should not all begin on the same recent
  date unless there is a documented provider limit.
- Last completed date, settlement counts, first/last timestamps, interval
  changes, duplicates and gaps. Cross-check at least ten dates including
  September 12–14 against venue responses.
- `rate_sum` equals the sum of observed settlement fractions, `rate_mean`
  equals sum/count; separate units, venue and instrument identifier.
- The snapshot writer cannot replace canonical rates. The source of the
  legacy `open_interest` and `basis_pct` columns remains distinct from funding;
  the row-level source does not certify those separate columns.

Then change the specialist funding loader to use `funding_settlement_daily`
canonical values rather than legacy source-isolated ranks. Add funding sum,
mean, percentile, change, funding × quantity-OI, funding × basis and regime
interactions in a **new** experiment version. Select per asset inside past
validation, retaining a no-funding control and a same-date complete-case
comparison. Preserve the diagnostic legacy run as evidence of the defect.

## 3. Build point-in-time data contracts for the seven assets

Each observation needs `asset_id`, venue, instrument, quote/base units,
`event_time`, period start/end, source publication time (where available),
`received_at`, revision/version and quality flags. Date-only joins cannot prove
information was available when a prediction was made. Funding, OI, supply and
macro data should not share a universal forward-fill policy.

| Lane | Implemented / available | Next required work | Admission rule |
|---|---|---|---|
| Spot OHLCV | Daily prices, range candidate, volume ratios | Resolve XRP/HBAR September 8 differences; acquire appropriate HYPE venue OHLCV; confirm aggregate vs venue and base vs quote volume | Positive coherent OHLC, exact period, completed bar; source transitions reviewed |
| Price timestamps | Research alignment for CoinGecko midnight samples | Preserve raw timestamps at collection; audit other readers (XS, retrospective, lead-lag, live array builders) before treating their date joins as clean | Never join start-of-day samples to future same-date closes |
| Funding | Collector and new sum/mean/count table | Historical repair and canonical loader, venue cadence metadata | Event timestamps; no partial day silently marked complete; never mix percentage and fraction |
| Open interest | USD and quantity histories | Match contract multiplier, quote asset and venue; establish sample completeness/late revisions | Quantity growth separated from price revaluation; enough valid within-day coverage |
| Volume/order flow | Volume ratios, taker buy/sell ratio | Perpetual quote volume, actual taker quantities and signed imbalance | Do not call a mean of ratios an aggregate buy/sell ratio |
| Basis | Snapshot basis exists elsewhere | Archive timestamped mark/index/spot basis and term structure; point-in-time loader | Same venue/time/units; no spread from asynchronous prices |
| Book liquidity | Daily depth and imbalance | Intraday spread, impact curves, withdrawal/replenishment and executable size | Record sample coverage, no extrapolation through outages |
| Liquidations | Not included in this daily study | Reliable timestamped stream, missed-message monitoring and venue aggregation | Forward-only until history verified; missing stream is not zero liquidation |
| Supply/unlocks | Dated supply ratios; current-snapshot leakage removed | Canonical token ID, announced vs revised unlock schedule, circulating/locked/burned supply | Announcement-time vintages; no current max supply projected backward |
| Options | Not included in this study | BTC/ETH DVOL, term structure, skew, put/call and expiry effects where available | Timestamped, liquid venue measurements; no synthetic coverage for unsupported assets |
| Macro/market | BTC benchmark and six lagged favorites | SPY/QQQ, USD, rates, gold, liquidity/stablecoin changes; event calendar | Correct session/holiday joins and economic release vintages |
| Chain/token fundamentals | Supply is partial; chain series exist elsewhere | Per-asset fees, activity, TVL, flows, staking/unlocks, revenue/buybacks for HYPE | Correct chain/token mapping and publication delays; do not copy one chain metric to every token |
| Identity/history | Current favorite symbols | Venue instrument master, listing/delisting and redenomination intervals | Survivorship-free membership and split/contract scaling checks |

For HYPE, prioritize venue-native funding/OI, fee/revenue/buyback and unlock
history, but do not assume these predict direction. For XRP/XLM/HBAR, treat
network activity, supply and event/regulatory context as timestamped candidate
data, not hand-assigned directional weights. For BTC/ETH/SOL, test funding,
quantity OI, liquidity and broader risk-market inputs before adding complexity.

## 4. Forward experiment and better model comparisons

Freeze the feature/time contracts, horizons, transformations, regularization
choices, costs, decision rules and test families **before** collecting the next
forward period. Store issued predictions with input hash, as-of time and model
version. Never reconstruct a supposedly live forecast from a later revision.

- Direction: logistic baseline, simple regularized returns, calibrated boosted
  trees as a bounded nonlinear challenger; probability calibration measured on
  earlier validation only. Brier/log loss, balance, abstention and coverage.
- Magnitude: historical median, calibrated EWMA, a genuinely fitted HAR-RV once
  intraday realized variance exists, asymmetric quantiles and a bounded
  tree/neighbor challenger. Score MAE, pinball loss and interval width/coverage.
- Combined outputs: keep `p_up`, positive conditional size, negative conditional
  size and interval separate. Evaluate expected return against zero and returns
  after realistic carry/spread/slippage. Never multiply specialists and assume
  independence or profitable execution.
- Selection: compare per-asset winners, conservative equal-weight combinations
  and partial pooling with training-only choices. A broader hyperparameter
  sweep requires nested selection and inclusion in the testing family.
- Lead–lag: synchronized 5/15/60-minute returns, funding/OI changes and order
  flow. Purge overlapping target windows, shift leader data strictly backward,
  include own lags and shared market factors, and test reversal/placebo lags.
  Correct across assets × leaders × lags × horizons. A correlated market shock
  is not proof that one asset leads another.
- Regimes: document bull/bear, volatility and liquidity splits using only past
  information. Report stability and degraded coverage, not only aggregate wins.
- Promotion: new forward evidence, performance versus strong baselines,
  probability calibration, stable magnitude error and intervals, adequate
  independent observations, after-cost economics and no unresolved material
  data-provenance defect. Passing retrospective significance alone is insufficient.

Do not promise power from 25 weekly outcomes. Calculate detectable effect size
and required sample before choosing the forward window. Repeatedly checking a
fixed p-value threshold needs a sequential-testing policy or predeclared dates.

## 5. Extend beyond favorites without repeating the whole investigation

1. Add a configurable symbol universe to `tracked-research-data.mjs` and its
   caller, keeping identity and asset-class scope explicit. The current script
   intentionally exports only the seven favorites.
2. Audit coverage first and group by usable lane/horizon, never impute an absent
   asset's funding/OI from another asset. Preserve per-asset missingness.
3. Load by small symbol batches; D1 result-size limits have caused past silent
   research failures. Do not turn the bounded liquidity read into one global
   SELECT. Save immutable input manifests and resumable per-asset outputs.
4. Predeclare time windows and selection policy. Fit expanding/rolling models
   independently, using partial pooling only where prior evidence supports it.
5. Correct across the **entire** expanded research family, not one favorable
   symbol batch at a time. Cluster cross-asset uncertainty by decision date.
6. Add equities only with equity-specific data: corporate actions, adjusted
   prices, earnings/report publication dates, session calendars, options and
   borrow. The current crypto liquidity/funding features must stay absent.
7. Add delisted/failed assets and point-in-time membership before publishing a
   universe performance headline. An established-assets subset is not a complete
   survivorship correction.

## Verification commands

From `signals-worker`:

```sh
node --test test-regression-diagnostics.mjs test-hierarchical-model.mjs test-model-zoo.mjs test-adaptive-model.mjs test-data-quality.mjs test-session-data.mjs
FCS_EXPERIMENTAL_BLOCKS=1 node --test test-hierarchical-model.mjs
node test-worker.mjs
node test-derivatives.mjs
node test-dashboard.mjs
node test-health-check.mjs
python3 test-tracked-research.py
python3 test-session-research.py
```

Tests cover future-data invariance, strict chronological purging, missing
indicators, source-priority SQL in real SQLite, calendar dates, funding sums and
partial days, duplicates, historical supply joins, content hashes and dashboard
rendering. The 2026-09-19 frozen outputs do not replace these checks after edits.

## 7. Continue session/conditional-rule and stablecoin research

Implemented entry points:

- `scripts/session-data.mjs`: public hourly OHLCV archives with SHA-256 checks,
  exact timestamps, ms/microsecond support, duplicate/conflict and OHLC checks.
- `scripts/session-research.py`: per-asset DST-aware activity, fixed conditional
  rules, future-return tests, stablecoin ratio/component/supply ablations.
- `scripts/session-context.mjs`: bounded-source stablecoin context collection
  and optional non-actionable summary persistence.
- `scripts/session-health.mjs`: compact dashboard summaries with a ten-day
  freshness label; the full report remains in artifacts.
- `.github/workflows/signals-session-research.yml`: weekly Monday 10:41 UTC
  refresh and artifact retention. The main signals build reads the summary;
  existing normal builds collect matched provider snapshots.

### Reproduce the timing study

From `signals-worker`, with the NumPy dependency installed:

```sh
node scripts/session-data.mjs 2026-09-19 reports/sessions
python3 scripts/session-research.py --input reports/sessions/panel.json --context docs/research-2026-09-19/stable-context.json --output reports/sessions/replay
node --test test-session-data.mjs
python3 test-session-research.py
```

The 47 MB hourly panel is local at `reports/sessions/panel.json`, excluded from
Git; CI preserves complete inputs for 90 days. The repository retains every
source URL/checksum in `docs/research-2026-09-19/session-manifest.json`, the
stablecoin context, full result JSON and code/input hashes. Re-download the
public archives and compare manifest hashes before claiming an exact replay.
If the supplier revises a source, preserve both versions and label a new run;
do not silently replace the September 19 benchmark. Existing local cache files
are checksum-verified at first download, not automatically revalidated every
week. Add a monthly cache-checksum revision audit before relying on long-term
historical stability.

### Release and observe the new collection

1. Apply **0043, 0044 and 0045** before deploying the changed build/collector.
   0044 adds `market_flow_observations`, `session_flow_research`,
   `forecast_run_versions` and `funding_snapshot_daily`. New snapshots and
   canonical settlements must both keep accumulating without overwriting each
   other. Source/venue/contract/unit metadata belongs in snapshots.
2. Release worker, build scripts, archive writer and both research workflows
   together. The corrected live vote model is `confluence-v9`. Its evidence
   starts fresh; old pending forecasts are excluded using issue-time version
   stamps. Do not relabel historical v8 outcomes as v9 to regain coverage.
3. Run the weekly workflow once, then a normal signals refresh. Confirm
   `sessionResearch.status`, seven per-asset profiles, completed-day counts,
   research labels and missing weekend data. A stale/unavailable summary must
   remain visible as such. No research field may populate a live board vote.
4. Verify `market_flow_observations` has both stablecoin IDs and the named
   crypto IDs at matching observation times. Inspect provider timestamps,
   stale/missing-volume flags and duplicate retries. Its volumes are rolling
   24-hour USD asset volumes, not disjoint pairs or net capital inflow.
5. Verify `funding_snapshot_daily` continues receiving CoinGecko observations
   even on dates already holding direct funding settlements. Live percentiles
   require at least 20 completed observations from the current venue and contract. Legacy
   unknown-venue history cannot supply a vendor-native live percentile.
   Funding cadence normalization is still required for comparisons across
   contracts or cadence changes; storing a provider rate does not solve that.
6. Inspect two completed weekly artifacts and two normal daily collections
   before declaring sustained collection reliability. The release steps were
   executed September 20; the two-cycle observation period remains open.

### Next experiments, in priority order

- **Prospective confirmation:** freeze the 2026-09-19 hypotheses and record
  forecasts before outcomes occur. Analyze the new period separately from the
  growing, repeatedly inspected 2026 holdout. Do not choose a new hour/window
  from the old holdout and still call that same period out-of-sample.
- **Timing:** retain activity and direction separately. Add 30-minute bars for
  the exact NYSE opening interval, genuine exchange holiday/early-close
  calendars, US/UK DST-mismatch weeks, funding-settlement clocks, and scheduled
  macro-release windows. Test enough weekdays/weekends per asset; HYPE needs
  more development weekends. Move beyond all-weekday clock windows only when
  calendar membership is historically correct.
- **Conditional rules:** freeze a small family of thresholds (e.g. morning
  move divided by trailing volatility) and continuation/reversal targets.
  Include distance to previous close and trailing movement controls. Report
  later return, costs, sample count, calibrated probability and coverage. Test
  each side separately; a high full-day hit rate is not a post-window edge.
- **Stablecoin turnover:** accumulate at least 180 complete daily snapshots,
  preferably a year covering distinct regimes. Construct same-clock ratios
  from explicit fixed constituents and preserve missingness. Compare ratio,
  numerator and denominator separately; test both direction and absolute move
  against base-rate, median and EWMA controls. Global asset-volume ratios have
  overlapping trade attribution and need that label. The current venue proxy
  must not be renamed global stablecoin volume.
- **Stablecoin sensitivity:** add fixed USDC/TUSD/FDUSD basket tests only on
  common overlapping history. Keep active-pair counts; never replace an
  unlisted or missing pair with zero. Record venue fee promotions, depegs and
  reserve/redemption events. Contrast all-stable USD-valued supply with an
  explicitly USD-pegged supply series; use historical first-seen vintages where
  possible. Test stablecoin dominance/supply growth as separate measurements.
- **Per-asset size models:** the stable-volume regressions do not yet beat a
  simple median reliably. Test the extra feature against the better per-asset
  EWMA/HAR-style candidates from the first audit, with nested chronological
  selection and fresh forward data. Do not promote a feature simply because
  it improves a weak regression control.
- **Remaining assets:** first build a versioned venue/instrument identity map.
  Require liquid quote-consistent OHLCV and sufficient development/holdout
  history. Add assets in bounded batches using the same frozen rule family;
  expand the multiplicity family across assets, sessions, horizons and model
  candidates. For equities, use adjusted prices and actual exchange calendars,
  exclude overnight gaps from intraday volume, and never attach crypto funding
  or stablecoin pair data as an asset-native observation. Include historical
  listing/delisting membership to avoid a survivor-only universe.

Acceptance for any directional rule: incremental calibrated holdout skill,
positive after-cost forward-return lower bound, enough independent observations,
corrected family-wise significance, stability across separate time periods,
clean point-in-time inputs and subsequent prospective replication. Passing an
activity-pattern test establishes only the time of larger movement.


## Calendar / eight-stablecoin / explanatory layer handoff

Read `CALENDAR_STABLECOIN_INSIGHTS_2026_09_19.md` before interpreting results.
The global basket now has 364 retrospective points; the earlier 18-day limit
applied only to original D1 first-seen observations. Keep those data contracts
separate. No new weekday extrema/event effect or stablecoin predictor passed.

1. **Restore the existing collectors:** securely replace the invalid Cloudflare
   token in `/etc/fcs-trading-bot.env` on the Oracle host supplied by the owner.
   Confirm D1 `SELECT 1` succeeds under the service environment without printing
   secrets. Inspect only `fcs-binance-collector` and `fcs-oi-sampler`; do not
   restart trading services, reset the checkout or replace the shared env file.
2. **Release safely:** migrate 0043–0045; 0045 adds immutable
   `liquidation_observations`. Install the corrected funding collector and
   `funding-quality.mjs` together, retaining backups. Existing OI sampler code
   need not change. Restart/check only the two data services. Verify new OI
   timestamps across seven assets, contract quantity and mark price. Verify
   funding settlement sums/counts against direct source records. A time-budget
   pause is resumable; a failed write is not successful collection.
3. **Repair funding history:** use the existing runtime lock with
   `COLLECT_SYMBOLS=BTC,ETH,SOL,XLM,XRP,HYPE,HBAR` and an explicit
   `COLLECT_FROM_DATE=2019-09-01` in bounded collector runs. Resume from the
   canonical settlement watermark. Never assume three settlements a day.
   Live OI snapshots missing during the outage cannot be recreated from today's
   value; recover available aggregate history separately and label its cadence.
4. **Publish research:** release build scripts and worker together, then execute
   `signals-session-research.yml` once. It computes and stores three versioned
   summaries before a normal signals refresh exposes them. Verify all seven
   asset panels, weekday insufficiency, and the exact stablecoin basket. The
   new health checker monitors OI relative to the build clock, avoiding false
   alarms caused by an hourly public payload. Weekly summaries expire after
   ten days. A valid current model clock must not mask a stale collector.
5. **Optional CMC:** keyless CMC100 is already implemented and was exercised.
   `CMC_API_KEY` is optional for authenticated liquidations. Test entitlement,
   requested IDs, timestamps and coverage before enabling it. Missing coins
   are unknown, not zero. Rolling windows overlap; do not sum hourly snapshots
   into daily liquidations without a non-overlapping measurement contract.
6. **Forward evidence:** keep the September 19 studies frozen. Weekly reruns
   are monitoring/re-estimation, not new independent confirmation of a repeatedly
   inspected 2026 period. Establish a new prospective evaluation interval and
   timestamp every model/rule before outcomes. Add EWMA/HAR magnitude and
   trailing base-rate comparisons before promoting a stablecoin candidate.
7. **More exhaustive research:** test 30-minute exchange opens, actual holiday
   calendars, macro announcements and funding clocks. For squeeze persistence,
   collect high-frequency forced-order observations and spot aggressor flow,
   separate liquidation events from voluntary OI reductions, measure returns
   only after the detection time, purge overlapping events and include fees.
   No recovery constants or screenshot narratives may serve as labels.
8. **Other assets:** follow the identity/coverage/multiplicity gates above.
   Short histories should return insufficient evidence, not use another asset's
   coefficients or preferred hour. Retain delisted assets where possible.

Reproduce from `signals-worker/` (NumPy requirements are already pinned):

```sh
python3 scripts/calendar-research.py --input reports/sessions/panel.json --output reports/sessions/results
node scripts/stable-basket-data.mjs 2026-09-19 reports/stable-basket/2026-09-19
node scripts/cmc-research.mjs 2026-09-19 reports/stable-basket/2026-09-19
OPENBLAS_NUM_THREADS=1 python3 scripts/stable-basket-research.py --input reports/stable-basket/2026-09-19/panel.json --cmc reports/stable-basket/2026-09-19/cmc100-series.json --hourly reports/sessions/panel.json --output reports/stable-basket/2026-09-19/results
node --test test-market-insights.mjs test-session-data.mjs
python3 test-calendar-stable-research.py
node test-dashboard.mjs
node test-health-check.mjs
```

For an **exact** replay, decompress the frozen `stable-basket-panel.json.gz`
and `cmc100-series.json.gz` into those input paths first, instead of querying
current rolling history with an old as-of date. Preserve bytes and verify the
artifact manifest hashes. Reconstruct/check the hourly source manifest as
explained above. `stable-basket-predictions.json.gz` contains the individual
outer predictions; full JSON reports retain selections, corrected tests,
intervals and explanatory coefficients. Reports include combined input and
code hashes. Authenticated liquidation data remain a separate untested source.

Existing UTC-hour summaries use a different internal archive and historical split test from the new ET studies. Do not treat their agreement across two halves as fresh prospective validation or combine their sample counts. Existing notification/trading modules were not changed by this audit. Reassess any reliance on those summaries separately before promoting a timing strategy.
