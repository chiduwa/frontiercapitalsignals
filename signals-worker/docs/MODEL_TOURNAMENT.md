# Per-asset model tournament (`model-tournament-v1`)

**2026-10-08 correction:** promotion now uses `bounded-loss-v2`. The prior
variance-scaled, symmetrically clipped difference does **not** preserve the
mean-loss null under skewed errors. A worse challenger crossed its threshold
in 175/200 controlled simulations. Direction now uses raw Brier differences
(bound 1); timing uses raw log-loss differences divided by `-log(1e-9)`,
the bound implied by the existing probability floor. Neither is clipped or
rescaled from past realized differences. QLIKE has no finite such bound:
magnitude forecasts, raw losses and screening continue, but automatic
promotion/retirement is withheld pending a valid test for that objective.
No live champions existed in the registry at this audit. Existing baselines,
forecasts, model IDs, alpha allocations and trading risk controls are retained.
See [the evidence and validation report](research-2026-10-08-learning-integrity/README.md).

Asked 2026-09-23: use the history and everything we log so the learning model
gets better at predicting and timing, "even if that means creating/generating
its own models per asset", and "learn how to weigh each data/information per
asset as some data may affect each asset differently".

This is the machinery for that. It does not assume any model works. It lets
models compete per asset and promotes one only when the future confirms it.

## What it does, daily

1. **Scores** every forecast whose outcome has arrived.
2. **Decides**, per asset and per question, whether a challenger has beaten the
   method in force on forecasts it logged *before* their outcomes existed, or
   whether a promoted model has since fallen behind.
3. **Issues** today's forecast from every model in play and writes it to
   `model_forecasts` once. It is never rewritten.
4. **Sundays** (or on demand): **proposes** new challengers per asset from a
   grid of model families and input groups, ranked on the last 360 days.

`.github/workflows/signals-model-tournament.yml` runs after Signals Daily, with
a 17:27 UTC fallback. It is about 70 s of compute, plus about 1 min when the
generator runs.

## Who is in it (widened 2026-09-24)

`scripts/tournament-universe.json` is a fixed, reviewed list: the
always-tracked 8, the 32 most liquid other coins (30-day median dollar
volume, at least 600 days of history, no pegs), the 40 most liquid stocks,
and LMT, which joined on 2026-09-24 for its screened candidate (below). It is fixed on purpose: a forward record only means something if the
asset stays in. Change it by commit. An asset that leaves keeps its ledger;
one that joins starts seeding on its first run.

- **Crypto** assets use the always-tracked 8 as their leader inputs, so the
  original 8 keep exactly the inputs they were first measured on. That was
  verified: all 17,460 of their overlapping rows are identical in the wide
  build.
- **Stocks** get their own slots: direction and move size at 1 and 5
  **trading sessions**, SPY as benchmark and leader, no crypto
  derivatives or liquidity inputs, and no timing slot (the spot bot buys
  crypto). They pool in their own slot, `*stock`, never with coins. A stock
  forecasts from its own last session, so a Friday close still forecasts on a
  Sunday run, and 5-session outcomes count once per five sessions.
- The first wide run, seeding 72 new assets at once, took about 20 minutes
  (1,329 challengers, 2,199 forecasts). Daily runs after that are much lighter.
  The input keeps only rows from the last 1,200 days, the most any fit or
  screen reads.
- Each run's per-asset slots and weights live in
  `model_tournament_run_assets` (migration 0051), one row per asset. The
  payload publishes the always-tracked 8, the pooled slots and **any asset
  whose model has been promoted**, and names those in the panel. The rest stay
  in D1.
- The futures bot trades only promoted 7-day crypto slots, so a promoted
  stock is published but never becomes a futures trade.

## Screened candidates (added 2026-09-24)

The weekly generator only proposes cheap families it can screen on every
asset in minutes. A slower model enters by a second door: the
**archive-wide sequence screen** ([SEQUENCE_MODELS](SEQUENCE_MODELS.md),
"The wide screen"). A candidate that clears that screen is written into
`scripts/tournament-universe.json` under `screened`, with its evidence. It
must have cleared all three of these:

1. Benjamini–Hochberg q < 0.05, corrected across every test in the screen.
2. The strong benchmark: beating GARCH + weekday on size, not just the median
   move.
3. Both halves of its test window.

Each run then:

- **Admits it once,** before the generator, as a challenger whose reason is
  the evidence. In a fresh slot it spends the slot's first and largest alpha
  (promotion at e ≥ 33). In a slot that already holds challengers it takes
  the next index; the error guarantee is never re-cut to make room. It does
  not count as seeding, so a fresh slot still gets its full first draw from
  the generator.
- **Feeds it only what it reads.** The LSTM reads a 30-day window
  (return, |return|, volume against its 20-day mean). Only its own slot's
  rows carry that window, and every other row of the input is byte-identical
  to a build without it. Open rows carry the window too, because they are
  what a live forecast is issued from.
- **Runs the study's own network,** `fit_lstm` from
  `tracked-sequence-research.py`, not a lookalike. It trains on the matured
  rows before the last 60 and is early-stopped on those 60. Its |move|
  forecast becomes a volatility by the constant that minimizes QLIKE over
  the training window, the same calibration the `scale` family uses. The
  network is deterministic on CPU. PyTorch 2.14.0 is installed from the CPU
  index in the workflow.
- **Never logs a stand-in.** A row without its window gets no LSTM forecast
  at all, rather than some other model's forecast under the LSTM's name.
  More generally, a size forecast of nothing is no longer logged, since it
  could never be scored.

In the tournament from 2026-09-24, both at 1 trading session:

| Asset | Screen evidence (LSTM vs GARCH + weekday, MAE of the move) | Slot | Promotion at |
|---|---|---|---|
| LMT | +0.076 pp, BH q = 0.006; halves t = 3.59 / 3.93 | fresh (LMT joined the universe for it) | e ≥ 33, index 1 |
| CAT | +0.050 pp, BH q = 0.048; halves t = 2.94 / 2.00 | already held 3 challengers | e ≥ 526, index 4 |

Both still face the forward bar: at least 60 paired forward sessions against
the slot's incumbent, on QLIKE. The screen scored the size of the move by
MAE, while the tournament scores the variance forecast by QLIKE, so passing
one is no promise of passing the other. A stock size model feeds no bot.

## Slots

Each always-tracked asset (BTC ETH SOL XLM XRP HYPE HBAR ARB) has five slots,
and a pooled slot `*` applies each spec to all of them at once:

| Slot | Question | Loss | Method in force until beaten |
|---|---|---|---|
| `direction:1`, `direction:7` | P(up) over the next 1 / 7 days | Brier | base rate (no skill), since production publishes no direction |
| `magnitude:1`, `magnitude:7` | size of the move (σ of the log return) | QLIKE, proper for a variance forecast | trailing 60-day volatility, the scale production runs on |
| `timing:2` | which of the spot bot's six 4-hour firings is cheapest on the day after next | log loss | uniform: no firing preferred |

Timing targets the day *after* the latest close's day because the job runs at
about 15:30 UTC. By then most of the next day has already passed, so the day
after is the first one a buyer can still act on. It uses Binance 4-hour opens
(the price at each firing). HYPE has no Binance spot pair, so it has no timing
slot.

An asset forecasts from its own newest close. A CoinGecko-only asset (HYPE)
is a midnight sample, one day behind by construction. Anything older than one
day is stale and never forecast from.

## How it learns per asset

Every model is fitted to one asset's own history, so its weights are that
asset's. The generator's grid is where "what matters for this asset" is
searched:

- **Direction:** logistic regression (strong / light shrinkage) on nine input
  sets (momentum; momentum + calendar; momentum + volume + volatility;
  derivatives + funding; derivatives + funding + momentum; the other tracked
  coins as leaders; return lags + calendar; market + momentum; everything),
  plus boosted trees on two sets.
- **Size:** GARCH + weekday, GARCH, seasonal HAR, EWMA, HAR and trailing
  volatility, each raw, calibrated per asset (the QLIKE-optimal scale on
  that asset's own history), or calibrated toward its class (that scale pulled
  toward the class's by empirical Bayes, in proportion to how much the
  asset's own estimate can be trusted; see `MODEL_OVERFITTING.md`); and a HAR
  regression per asset with extra inputs (volume, volatility, derivatives +
  funding, market, calendar).
- **Timing:** cheapest-firing frequency over 30 / 90 / 365 days, with and
  without the weekday; and the arcsine law, the exact probability that a
  random walk's lowest open falls in each slot (24.6% for the first and last,
  11.7% for the middle two), alone or updated by the coin's own record. On
  13,357 coin-days it beat every window count without using any history
  (`CLASSIC_MODELS.md`).

The **weights report** (`summary.weights`, shown in the dashboard panel) refits
a full-information model per asset 13 times, 28 days apart. It reports how the
asset's model divides its weight across input groups, and whether each top
weight kept its sign across refits. A weight that flips is noise; one that
holds is stable structure in the fit. **Neither is evidence of forecasting
value.** Only the forward record is.

The first run (2026-09-23) already shows the assets differ. BTC's and XLM's
size models lean on OI change; ETH's and SOL's on momentum and trend. For
direction, SOL's and HYPE's lean on the other tracked coins.

## The promotion rule

The generator ranks candidates on history, and **history never promotes
anything**. A model chosen by searching the data will always look good on
that data. Promotion needs forecasts logged *before* their outcomes existed.

For each challenger against the method in force, from its epoch start:

- Pair the two models' losses on each date both were scored. At 7 days, use
  one date per week so no two outcomes overlap.
- For direction, use the raw Brier loss difference in [-1, 1]. For timing,
  divide the raw log-loss difference by its fixed `-log(1e-9)` bound. No
  clipping, learned scale or burn-in enters promotion. Invalid bounds abstain
  for the entire comparison. Magnitude's unbounded QLIKE remains untested by
  this e-process; its raw outcomes continue accumulating.
- Track a mixture betting e-process: E = mean over λ ∈ {0.05, 0.1, 0.2, 0.35,
  0.5} of ∏(1 + λx). While the challenger is no better, E is a nonnegative
  supermartingale, so the chance it *ever* reaches 1/α is at most α (Ville's
  inequality). It can therefore be checked every day without inflating false
  promotions.
- **Alpha is spent across a slot's challengers in admission order**: the j-th
  challenger gets α·6/(π²j²), α = 0.05 per slot, summing to at most α
  however many the generator ever admits. Search width costs time, never false
  promotions. The first challenger needs E ≥ 33; the sixth needs E ≥ 1,184.
- **Promote** when E crosses its bar with at least 60 forward outcomes (20 at
  7 days). The best qualifying challenger wins; the old champion retires;
  every other challenger restarts against the new incumbent with a fresh alpha
  share.
- **Demote** a champion when the reverse e-process against its fallback (the
  pooled champion, or else the benchmark) reaches 20.
- **Retire** a challenger when it is clearly worse (reverse E ≥ 20) or has
  logged 540 forward outcomes (80 at 7 days) without a verdict. This timeout
  is suspended for magnitude while its promotion test is unavailable.

A per-asset champion beats a pooled one; a pooled champion applies to every
asset without its own.

### How long promotion takes

**The simulation table below describes the retired clipped test, not the
current bounded test. Do not use it to estimate current promotion time.**
The corrected test will generally require more evidence, especially for
small probability improvements. The old apparent speed was partly the bug.

Honestly, months for most real effects. Simulated for the first challenger
of a slot (bar E ≥ 33; 200 runs each), where d is the true advantage in
standard deviations per outcome:

| true advantage d | median outcomes to promotion | 80th percentile | at 1 day, median |
|---:|---:|---:|---|
| 0.4 | 95 | 119 | about 3 months |
| 0.2 | 217 | 321 | about 7 months |
| 0.1 | 655 | 1,277 | about 1.8 years |

The pooled slot averages eight assets per day, so a shared effect gets there
several times sooner. The 2026-09-23 sequence study suggests direction
advantages are near zero (no family beat the base rate). Expect size and
timing promotions long before any direction one, and possibly none for
direction.

## Forward-call readout: precision, NPV, sensitivity, specificity (2026-10-06)

Asked whether the tournament could also check precision, recall/sensitivity,
specificity and negative predictive value "to see if we can learn from those
to improve the models per asset". It now checks them; it does not learn from
them, on evidence ([DAY_ZONE_METHODS_AND_CONFUSION](DAY_ZONE_METHODS_AND_CONFUSION.md), section 3).

- Every direction challenger in the run summary carries `calls`, computed from
  its forward forecasts since its epoch ("up" when P(up) > 0.5): n, the
  up-rate, how often it said up, precision, NPV, sensitivity, specificity and
  informedness. The method in force gets the same over the leading
  challenger's window (`incumbentCalls`). Multi-day horizons count one outcome
  per horizon, exactly as the promotion test does (`Ledger.forward_dates`).
- The panel prints the leader's line, with precision next to the share of up
  days, because a 55% precision on a coin that rose 55% of days is no skill.
- **Promotion is unchanged: Brier, through the e-process.** On 1.58M
  walk-forward forecasts (80 assets, 21 families) sensitivity and specificity
  mostly measured how often a model says "up"; precision and NPV gains over
  the base rate always share a sign (one numerator), so no model is "good at
  down calls only"; and picking each asset's model by any of them gave worse
  probabilities than picking by Brier on every horizon, with no money after
  costs. Informedness (0 for any model without skill) is the honest single
  number in the readout.

## What reads it

`build-signals.mjs` publishes the latest run as `payload.modelTournament` via
`loadTournamentHealth`. Each slot is marked `actionable` only when its
incumbent was promoted and the run is under 36 hours old. The dashboard panel
*Models that have to earn their place, asset by asset* (timing zone) shows,
per asset:
- the method in force and its latest forecast;
- how far the leading challenger is toward promotion (log-scale share of its
  bar);
- the weights report.

**Not wired yet, deliberately:**
- **The trading bot.** A promoted direction champion is published but
  authorizes no trade. Live trading is real money; enabling that is the
  user's call, per asset, with its forward record in hand.
- **The spot bot's buy timing.** A promoted timing champion is published, but
  measured on 2026-09-28 it should not steer the bot as the target stands. The
  slots most often cheapest (the first and last of the day) are just as often
  the dearest, as the arcsine law says they must be. Averaged over 13,323
  coin-days, no slot's open differed from the day's average open by more than
  noise (-5.5 to +7.5 basis points, every interval spanning zero). Buying at
  the likeliest cheapest firing would not lower the average price paid.
  Wiring timing is only worth it if a slot is ever shown to cost less on
  average, which is a different target (the price paid against the day's
  average) from the one this slot scores (`CLASSIC_MODELS.md`).
- **The main confluence engine's sizing.** A promoted size champion could
  replace trailing volatility for that asset's band.

## Tables

- `model_forecasts`: the forward ledger. Primary key (model, symbol, horizon,
  as_of), INSERT OR IGNORE, so the first forecast stands. `loss` is filled
  once. **Never backfill it.**
- `model_registry`: one row per model per slot: status, alpha index, epoch,
  e-values, forward n, the history ranking it was admitted on.
- `model_registry_history`: every admission, promotion, demotion and
  retirement, unique per transition.
- `model_tournament_runs`: the run summary the payload reads.

Reruns are safe. A second run the same day issues nothing and decides nothing
(verified on the real first run).

## Extending it

- **More families or inputs:** add entries to `candidate_grid()`. A new entry
  is simply untried in every slot, so the next generator run screens it.
  Entries already tried are never re-admitted to the same slot.
- **More assets:** add them to `scripts/tournament-universe.json`. Assets
  without Oracle OI/funding simply drop those inputs; stocks run on sessions
  (above). **Scaling limit to fix before about 200 assets:** each run
  re-reads every active model's forward ledger since its epoch from D1 to
  recompute the e-values. That is fine at 81 assets. Beyond that, store each
  challenger's e-process state and update it incrementally, keeping the full
  recompute as a periodic audit.
- **Changing the rule** (α, bars, minimum samples) resets nothing already
  logged. It changes future decisions, so record why in this file.

Tests: `test-model-tournament.py` covers:
- the false-promotion rate under checks after every outcome;
- power on a planted effect;
- alpha spending and a predictable scale;
- no look-ahead for every family and for timing;
- the promote → reset → demote lifecycle;
- the minimum sample and the 7-day non-overlap;
- that an issued forecast is never re-issued;
- the generator admitting a planted edge;
- the weights report.

Four planted bugs are each caught. `test-model-tournament-io.mjs` checks the
ledger rules in real SQLite, and `test-dashboard.mjs` renders the panel from a
real run.

Related: [SEQUENCE_MODELS](SEQUENCE_MODELS.md),
[TIME_SERIES_EVIDENCE](TIME_SERIES_EVIDENCE.md), [MODEL_ZOO](MODEL_ZOO.md),
[PREDICTION_ROADMAP](PREDICTION_ROADMAP.md)
