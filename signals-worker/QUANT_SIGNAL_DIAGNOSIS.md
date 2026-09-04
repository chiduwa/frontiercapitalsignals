# FCS signal timing and continuous-learning diagnosis

Audit date: 2026-09-04  
Scope: the `/signals` confluence model, FIL/PEPE timing examples, reversal alerts,
outcome scoring, automatic pattern discovery, and the supplied Bitcoin market-
cycle indicators.

## Outcome

The principal defect was not a lack of indicators. It was that correlated,
overlapping forecasts were treated as independent evidence and then reused to
publish timing and price bands that the exact current setup had not earned.
That made sample sizes, confidence bounds, horizon selection, and continuous
learning look more certain than they were.

The corrected design separates four things that must never be conflated:

1. a **candidate screen** that is allowed to be noisy and keeps learning;
2. an immutable **forecast and outcome ledger** containing independent trials;
3. a **research lane** that can discover hypotheses but cannot trade them;
4. a fail-closed **publication gate** that exposes a direction, horizon, or
   expected-move band only after the matching evidence clears its baseline.

This does not make exact tops and bottoms predictable. It makes uncertainty
visible and prevents the system from inventing a clock, target, or pattern when
the required evidence is absent.

## Five Whys

| Why | Finding | Consequence | Corrective control |
|---|---|---|---|
| 1. Why were some FIL/PEPE calls late or wrong? | The public model primarily judged 24-hour and 168-hour outcomes, while PEPE could peak and reverse within a few hours. A sudden-move alert also described a move already underway. | A valid daily screen could still be unusable as a scalp entry; a reactive observation could read like a forecast. | Remove unsupported timing, label sudden moves as post-move observations, and keep the fresh scalp surface measurement-only until a sub-hour model proves an edge. |
| 2. Why did the output sound more precise than the model was? | The former horizon path could fall back to static technique metadata, and volatility-derived ranges could appear beside a current call without matching setup calibration. | A methodology assumption looked like an empirical estimate of when and where price would turn. | Only historical, matching-horizon evidence may produce a timeframe or band. Otherwise direction, horizon, and range are withheld together. |
| 3. Why did the learning loop believe the evidence was strong? | An hourly 24-hour forecast could be counted about 24 times over substantially the same future path; a 168-hour call could be counted about 168 times. Multiple techniques and both horizons also described correlated outcomes. | `n`, Wilson bounds, calibration, technique weights, and alert confidence were overstated. | Admit at most one forecast per full horizon for each asset/technique series, keep horizons separate, use the deepest contributor rather than summing correlated `n`, and aggregate from an append-only ledger. |
| 4. Why did automatic learning not correct this by itself? | The learner trusted its derived counters. Retryable time-of-day backfills added the same history again; the old equity gate expected 12 intraday bars although a normal US session has roughly seven hourly bars. Some multi-step writes were not atomic. | Repeated jobs could increase apparent evidence without adding observations, especially for calendar/time patterns; a failed job could leave inconsistent state. | Replace bootstrapped time statistics atomically, use asset-class-aware session coverage, and fold each ledger outcome into counters with its `aggregated` flag in one D1 batch transaction. |
| 5. Why could these faults reach the page? | Candidate generation, research, confidence estimation, and publication were too tightly coupled. The archive also keyed daily bars by `(symbol,date)`, allowing a cross-class ticker collision such as Dash crypto versus DoorDash stock (`DASH`) to manufacture a spectacular false pattern. | A screen score could be mistaken for a trade probability, and contaminated data could win a mining contest. | Quarantine cross-class ticker collisions, require class-level and exact-setup evidence, keep research shadow-only, and treat abstention as a normal model outcome. |

## Evidence from FIL and PEPE

The deployed API snapshot inspected on 2026-09-03 was still labelled
`confluence-v6`. Its pooled class record did not demonstrate skill over its own
baseline: crypto was about 37.23% versus 41.15% over 10,016 raw scored rows, and
stocks about 39.01% versus 42.49% over 8,675. Those counts were precisely the
kind contaminated by overlapping windows, so they are diagnostic, not valid
independent sample sizes.

The asset drill-down also showed why a single headline was misleading:

- PEPE composite direction was approximately 50% at 24 hours but 15% at seven
  days; its reversal records were thin and materially different by horizon.
- FIL composite direction was approximately 33% at 24 hours and 12% at seven
  days; its reversal records were extremely thin.
- PEPE's reversal state switched between top and bottom within hours. That is a
  whipsaw at the model's present cadence, not evidence that both pivots were
  forecast successfully.
- FIL's sudden-move notification was evidence that a move had occurred, not
  validated evidence that a reversal would follow.

Therefore the defensible answer for those exact events is not a retrofitted
price target. PEPE required a separately validated 15-minute/one-hour setup to
support a scalp call; FIL required a pre-move trigger with independent forward
outcomes. Until those exist, FCS should show observations and watch conditions,
not an entry, top, bottom, or holding-period recommendation.

## Corrected continuous-learning architecture

```text
point-in-time data + provenance
            |
            v
quality checks / collision quarantine / stale-data abstention
            |
            v
versioned features and candidate forecasts  ---> all candidates keep learning
            |
            v
exact target-time outcome + non-overlapping admission
            |
            v
append-only outcome ledger --atomic--> derived reliability/calibration
            |
            +--> shadow research: purged walk-forward + costs + family correction
            |                              |
            |                              v
            |                    provisional -> confirmed -> decayed
            v
class skill gate -> exact setup gate -> direction / horizon / band or WITHHELD
```

### Implemented controls

- `forecast_outcomes` is the idempotency boundary. Repeated jobs cannot count
  the same accepted forecast twice, and overlapping forecasts are completed but
  deliberately excluded from statistical `n`. Each accepted row preserves its
  target/observation timestamps, entry/exit prices, path high/low and time to
  each extreme, plus the model and label versions that created it.
- Outcomes use the first observation at the forecast's exact maturity, within a
  bounded scheduler tolerance. A much later price no longer substitutes for a
  missed target.
- Directional accuracy, range containment, reversal behavior, and intraday
  results remain separate metrics. A wide range cannot inflate direction skill.
- Technique candidates with unknown, weak, or statistically inferior records
  receive zero production weight while their raw votes continue to be logged.
- A class must first demonstrate a conservative edge over its measured no-skill
  baseline. Then the exact current asset, side, score bucket, and horizon must
  have matching calibration plus the asset's independent composite record.
  Pooled calibration is informational only and cannot authorize a call.
- A public band additionally needs at least 30 independent, version-matched
  asset/horizon outcomes, a conservative containment floor, and coverage close
  to its declared 68% target. An almost-always-hit band is rejected as too broad.
- If either the empirical horizon or qualified empirical range is missing, the
  row loses all three actionable fields: direction, timeframe, and band.
- Reversal notifications require two consecutive builds on the same new side,
  matching non-overlapping evidence, significance over baseline, and a cooldown.
  They say “possible reversal watch” and give an evaluation checkpoint rather
  than claiming the pivot was found.
- The scalp API is fresh and descriptive: range used, position within the day,
  and independently validated time windows. It emits no direction, leverage,
  entry, target, top, or bottom.
- Retry-safe replacement fixes time-of-day and swing-time bootstrap inflation.
  Crypto and equity sessions have separate minimum-bars-per-day requirements.
- Cross-class ticker collisions are quarantined from the affected legacy tables
  until their primary keys can be widened safely.

### Migration behavior

Migration `0009` intentionally clears the derived reliability, calibration,
range, move, intraday, and time-effect aggregates that inherited invalid sample
counts. Raw forecasts and market history remain. The immediate post-release
state will therefore contain many `WITHHELD` rows while independent evidence
rebuilds. That cold start is the correct result; retaining invalid confidence to
avoid an empty page would preserve the original defect.

## What a quant-grade trade assessment should contain

The optimization target should be stated as:

> Estimate the highest-quality, executable opportunity to enter near a local
> low and exit near a local high within a declared horizon, after costs and
> under explicit risk constraints—not predict the unknowable exact extrema.

For each horizon—eventually 15 minutes, one hour, four hours, 24 hours, and seven
days—the model should learn separate labels and calibration. A public trade card
may expose a field only if its own validation gate passes.

| Field | Quant interpretation | Withhold when |
|---|---|---|
| As-of and reference price | Immutable decision timestamp and price used by the model | Timestamp, source, or price is stale/missing |
| Side | Calibrated probability of up/down/flat versus a class and regime baseline | Conservative edge is not positive after correction |
| Entry zone | Empirical price quantile or validated structural zone, never one magic number | No point-in-time entry model or spread/liquidity is inadequate |
| Resolution horizon | Distribution or coarse window in which the label historically resolved | Adjacent horizons cannot be distinguished statistically |
| Expected-move band | Conditional return quantiles anchored to the reference price | Matching asset/horizon sample is thin or miscalibrated |
| Top/bottom estimate | Prefer probability of a local extreme and a broad quantile interval | A true-extreme label has not been validated; never infer it from RSI alone |
| Path risk | Maximum adverse excursion, maximum favorable excursion, worst trade, and drawdown | Only close-to-close data exists for the proposed strategy |
| Invalidation | Observed support/resistance, barrier, or condition that falsifies the setup | It would be a guessed stop rather than a tested condition |
| Execution | Spread, turnover, volume, slippage/impact assumption, borrow/funding, and market hours | Costs cannot be estimated or instrument cannot be executed reliably |
| Catalyst risk | Earnings, unlocks, macro releases, security events, and source freshness | Event coverage is incomplete; flag the gap rather than treating it as no event |
| Suitability | `scalp`, `swing`, `position`, or `measurement only`, tied to validated horizons | The required cadence and outcomes have not accumulated |

The decision rule should compare **expected net return and its lower confidence
bound**, not raw classification accuracy. Ranking should also penalize drawdown,
turnover, tail loss, liquidity, and correlated exposure. Position sizing belongs
to a separate portfolio/risk layer; confidence must not map directly to leverage.

Useful path-dependent labels for the next model version are:

- probability that an upper barrier is reached before a lower barrier;
- time-to-barrier and time-to-local-extreme distributions;
- conditional return quantiles rather than a symmetric volatility band;
- maximum favorable and adverse excursion during the proposed holding period;
- net expectancy after fee, spread, slippage, funding/borrow, and latency;
- calibration/Brier score, precision among the top-ranked opportunities, and
  abstention coverage by asset class and market regime.

These targets answer the PEPE question directly: a setup can be classified as a
short-lived scalp if most favorable excursion occurs within one hour and then
reverses, even if its seven-day directional accuracy is poor.

## Automated pattern and strategy discovery

The new research lane evaluates declared families such as close-to-open versus
intraday behavior, weekday effects, turn-of-month windows, and reversal after a
directional run. It records after-cost expectancy, win rate, profit factor,
compounded event return, worst trade, and maximum drawdown.

A proposed rule such as “buy after a 10% decline and exit after a 5% rebound” is
a **hypothesis generator**, not a rule to publish. Candidate thresholds and
horizons must be counted in the multiple-testing family; entry and exit events
must not overlap; the threshold must be selected on training folds and evaluated
unchanged on later folds; and fills must include instrument-specific costs.

The lifecycle is deliberately asymmetric:

- `abstain`: thin, unstable, contradicted, or unprofitable after costs;
- `provisional`: survived corrected discovery and disjoint walk-forward folds;
- `confirmed`: also replicated on data that did not exist at discovery, with a
  positive conservative after-cost expectancy;
- `decayed`: later evidence contradicted it or removed its tradeability.

A decayed pattern cannot automatically resurrect from one favorable check. It
must enter a new versioned discovery lifecycle. This makes “continuous
learning” controlled champion/challenger research, not uncontrolled daily
self-modification.

Serially related event returns use a conservative heteroskedasticity/autocorrelation-
aware standard error. Promotion decisions occur only at predeclared doubling
checkpoints (for example 25, 50, 100 independent events), so checking every new
winner cannot silently become another source of multiple-testing bias.

Before portfolio use, this lane still needs a point-in-time universe (including
delisted assets), instrument-specific costs and market impact, simultaneous
position accounting, exposure/correlation constraints, and a paper-trading
shadow period. The current leaderboard is research triage, not proof that the
highest backtest return was historically investable.

## Market-cycle indicators from the supplied screenshots

Adding every indicator would make the model worse by counting the same BTC
price cycle many times. The implemented market-context archive is deliberately
small and does not cast a production vote.

| Treatment | Indicators | Reason |
|---|---|---|
| Controlled research | MVRV ratio | Distinct on-chain valuation concept; stored with causal prior-only percentiles and real `known_at` timestamps |
| Control model | Mayer Multiple | Transparent price/200-day-average benchmark that an elaborate cycle feature must beat |
| Prospective rotation context | CMC Altcoin Season breadth and BTC dominance | Potential BTC-versus-alt routing context, not directional votes; insufficient immutable history means wait and archive |
| Later, with licensed point-in-time data | Three-month futures basis combined with funding/open interest | Distinct leverage/carry information; should be one positioning family, not an extra correlated vote |
| Excluded as redundant | NUPL, MVRV Z-score, Pi Cycle, 2-year/4-year/Golden Ratio/Terminal Price variants, RSI-22 | Algebraic or moving-average overlap, very few cycle events, or duplication of existing features |
| Excluded as unauditable/refit | AHR999/AHR999x, Rainbow Chart, Bubble Index, BMO, CBBI, screenshot “Bitcoin Trend Indicator,” dated forecasts | Opaque/version-unstable formula, ex-post refitting, composite double counting, or no repeatable point-in-time hypothesis |
| Excluded as structurally weak | ETF streak/ETF-to-BTC, exchange flexible-savings yield, Strategy average BTC cost | Short history, publication lag, venue/promotion/company specificity, or nonstationary trend |

Every stored context row includes source time, first-known time, ingestion time,
provider, method version, raw hash, and a percentile computed only from earlier
values. Historical provider data first fetched today is marked known today. It
may create a provisional hypothesis, but only later prospectively archived rows
can confirm it. Provider and method versions cannot be pooled silently; future-
known observations, null percentiles, incomplete UTC candles, and exits beyond
the research cutoff are rejected.

## News, sentiment, events, and industry rotation

FCS already has partial inputs: crypto news/community sentiment, broad sentiment,
earnings awareness, security incidents, sector composites, cross-asset/sector
lead-lag, and a daily retrospective. These are incomplete observations, not a
complete news intelligence system.

The logical next module for a GPU-to-memory-style diffusion thesis is a
point-in-time **theme graph**:

1. normalize entities, products, industries, suppliers, customers, and events;
2. timestamp the first publication and market availability of each source;
3. score source reliability, novelty, sentiment, and surprise separately;
4. validate economic exposure using segment revenue/capex/order data rather than
   assigning a company to a theme because it appeared in an article;
5. learn lead/lag from catalyst to upstream and downstream beneficiaries using
   purged event studies and an unaffected sector/market control;
6. simulate entries after the information became tradable, including gaps,
   spread, liquidity, and earnings risk;
7. publish only a `theme monitor` until the relationship replicates out of
   sample, then name the evidence, horizon, leaders, laggards, and invalidation.

Without that point-in-time entity/exposure data, the model should say what it is
watching and what would confirm it. It should not advise that an industry is
“next” merely because current chatter resembles a successful historical story.

## Rollout and monitoring

1. Apply migrations `0009` through `0014` before running the new builders.
2. Deploy the Worker and builder together so the API and dashboard share the
   `confluence-v7` contract.
3. Expect a cold-start abstention period while corrected 24-hour and seven-day
   outcomes mature. Do not lower thresholds to make the boards look populated.
4. Keep market-cycle and new strategy families in shadow for at least 90–180
   days of genuinely post-discovery data, with a longer requirement for weekly
   labels and regime coverage.
5. Monitor calibration error, edge over baseline, abstention rate, outcome lag,
   provider freshness, data-collision rejects, drift by regime, net expectancy,
   drawdown, turnover, and alert precision. Compare every challenger with the
   current champion and a simple baseline.
6. Roll back automatically when data quality fails; decay a model when its newer
   evidence contradicts it; preserve every model/feature version and decision in
   the audit trail.

No production deployment is performed by this audit. The migrations reset
invalid derived evidence, so rollout order and the expected abstention window
should be reviewed before release.
