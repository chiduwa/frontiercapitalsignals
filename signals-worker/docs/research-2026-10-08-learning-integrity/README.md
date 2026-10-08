# Prediction and learning audit — October 8, 2026

The implementation retains the current prediction baselines. New direction
ensembles did not earn a replacement; reliability defects did earn fixes.
Changes are local source changes, with regression checks; this audit did not
deploy code, place orders, send notifications or change account risk settings.

## Evidence before changes

1. **The promotion test could reward a worse model.** Under a fixed asymmetric
   distribution with mean loss advantage **−0.0004**, the original test crossed
   its threshold in **175/200** simulations (540 outcomes each, minimum 60).
   The threshold implied a 3.04% bound for the first challenger. Symmetric
   clipping changed the mean being tested; predictable scaling did not fix it.
   The corrected direction test crossed in **0/200** with the same draws.
   See `promotion-audit.json` and `test-learning-integrity.py`.
2. **Accuracy could contradict its immutable score.** With a recorded positive
   outcome and a subsequently revised negative archive return, the readout
   reported 0% precision instead of the recorded 100%. It also counted
   unscored rows and dropped evidence if archive rows disappeared. Regression
   cases failed before the fix and now pass.
3. **Repeat runs fitted forecasts they would discard.** A second issue pass
   fitted all four already-saved baseline forecasts in the controlled case.
   It now makes zero such fits and preserves every saved forecast. The same
   check precedes expensive LSTM and timing fits.
4. **Network deadlines ended at response headers.** Stalled D1 query/batch
   bodies and Binance response bodies escaped their deadlines. Bot signal
   fetches had no deadline. Fault-injection tests reproduced each defect.
5. **Reversal alerts accepted obsolete evidence.** A strong record from an old
   model or old label authorized a current alert. SQLite-backed regression
   cases reproduced both. Valid current-version evidence still authorizes it.

## Resulting behavior

- `bounded-loss-v2` tests raw Brier differences with fixed bound 1, and timing
  log-loss differences with fixed bound `-log(1e-9)`. It does not clip or
  estimate a scaling factor from the outcomes. The e-process bound is **per
  slot**, under its conditional-mean null, not a guarantee across the whole
  investment universe. Invalid bounds invalidate the whole comparison.
- **QLIKE is unbounded.** Magnitude challengers keep forecasting and learning
  raw losses, but automatic promotion/retirement is withheld until a valid
  test for that objective is supplied. Replacing it with a capped objective
  would change what “better volatility forecast” means, so no such substitute
  was silently introduced. The read-only live registry audit found **zero
  champions**, 647 direction, 867 magnitude and 217 timing challengers. No
  working champion is displaced. Historical forecasts and alpha allocations
  are retained; no schema reset or outcome rewrite is needed.
- Precision/NPV/recall read the frozen `outcome_json` associated with the
  stored loss, including newly scored rows in the same run. Missing or invalid
  frozen outcomes abstain instead of being reconstructed from mutable data.
- D1 retains its 30-second deadline through body consumption; Binance retains
  its 20-second deadline through parsing; signal/scalp fetches have a
  10-second total deadline. An accepted order whose reply stalls is still
  reconciled by its existing client ID. The new integration test observes
  **one POST, two reconciliation reads, one confirmed fill**—no duplicate order.
- Reversal votes and evidence must match the active model/label versions.
  Their baseline is the same immutable, version-matched market baseline used
  by the engine. The build shares its existing post-evaluation baseline read
  among reversal alerts, confident alerts and the score snapshot. Price reads
  are confined to the recent signal window rather than all retained history.

## Cheap model combinations tested

Reused **1,576,533** saved walk-forward forecasts, **80 assets**, 20 nonbaseline
direction models. Compared their equal-weight mean, 25/50/75% weights on that
mean with the remaining weight on the training-only base rate, and per-asset
blend weights chosen before April 1, 2025 and frozen thereafter. All methods
are compared on common rows. Later results end October 4, 2026.

| Later-period Brier skill vs base rate; higher is better | Crypto 1d | Crypto 7d | Stocks 1 session | Stocks 5 sessions |
|---|---:|---:|---:|---:|
| Equal model mean | −0.00911 | −0.02292 | −0.00680 | −0.02396 |
| 25% model mean / 75% base rate | −0.00038 | −0.00045 | −0.00019 | −0.00230 |
| Per-asset blend picked on earlier data | −0.00118 | −0.00348 | −0.00017 | 0.00000 |

No asset-class/horizon group improves. The last zero means the per-asset
selector chose the baseline, not that it discovered predictive skill. These
are historical rejection tests on previously explored data, not fresh
forward proof. The existing neural/day-zone research also does not justify
replacing the simpler working day-zone model. Full results, input SHA-256,
limits and reproducible code are in `ensemble-results.json` / `ensemble_audit.py`.

## Conditional scenarios and journal

[Scenario study](../research-2026-10-08-scenarios/README.md): 16 Binance Global
futures contracts, 1,503,414 candles, 3,744 asset/rule/side/horizon cells, plus
27,666 recent candles for 18 US stocks/ETFs relevant to Robinhood. It tests
volume fade, quiet drift, session moves, failed breakouts, OI, funding, taker
flow and a fixed market basket, with cost/delay stress and frozen holding
selection. **Zero rules cleared the full gate.** No new trading or holding
rule is activated.

The private journal review covers 23 identifiable BTC/ETH/SOL/HBAR short-closing
orders since September 24. It records subsequent 1h/4h/24h/72h/7d paths and
adverse movement; the HBAR snapshot also documents the contemporaneous
liquidation level. Account fills and private findings remain in ignored
`reports/scenarios/`, outside the public research artifact. Later profitability
does not prove that a losing position could safely have survived the intervening path.

## Validation and operational cost

The [longer-history cycle extension](../research-2026-10-08-cycles/README.md)
adds BTC prices from 2010, a separate Bitstamp series from 2011 through
October 2026, older altcoin histories, Binance Global futures from their
available listings, and stock/ETF histories from 2000 where available.
Across 43 source/asset series, **1,168** seasonality/cycle/interaction
comparisons for direction and volatility produced **zero** candidates under
the joint evidence and era-stability screen. The intraday study now also has
a separately preserved **3,221,925-candle** long-history run, with **zero**
qualifying rules among 3,744 cells. None of these research models changes
the live prediction or holding policy. There are only three completed
inter-halving intervals; a four-year price law is not assumed.

- Full tournament suite: 30 tests passed, including no look-ahead, lifecycle,
  independent horizons and per-asset calibration.
- Learning-integrity regressions: 8 passed, including asymmetric errors,
  unbounded-loss abstention, immutable readouts, malformed evidence, pooled
  corruption rejection and skipped repeat fits.
- D1, notifications, tournament I/O and push batching: 21 tests passed.
- Bot network boundaries/order reconciliation: 6 tests passed.
- Scenario causality, funding sign/parity, gaps, non-overlap, reporting lag and
  holiday/DST tests: 7 passed.
- Long-history/cycle regressions: 9 passed, including future-date invariance,
  matured-label purging, reference-market lag, volatility targets, missing
  paths, old headerless Binance archives and corrupt-download rejection.
- Full Worker-side Node run: 236 passed, zero failed, one intentional skip
  for experimental funding/sentiment feature blocks disabled by default.
- Existing Worker integration, trading-bot suite and workflow guardrails passed.
- New regression checks are wired into the existing deployment/tournament/bot
  workflows. Offline scenario tests use a separate research requirements file.

No new recurring Cloudflare workload, schema, storage writes, paid data plan,
neural inference service or cloud model job was added. Research ran locally
against cached public archives and narrow read-only journal/registry queries.
Repeated active-model fits are skipped, baseline scans are shared, and the
notification price-history query is bounded. Forecast quality gains are not
claimed where the data failed to establish them.

The bounded-test reasoning follows
[Waudby-Smith and Ramdas, *Estimating means of bounded random variables by betting*](https://academic.oup.com/jrsssb/article/86/1/1/7043257).
The Cloudflare cost review follows the service's
[row-based D1 billing model](https://developers.cloudflare.com/d1/platform/pricing/).
