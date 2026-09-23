# Per-asset model tournament (`model-tournament-v1`)

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
  volatility, each raw or calibrated per asset (the QLIKE-optimal scale on
  that asset's own history); and a HAR regression per asset with extra inputs
  (volume, volatility, derivatives + funding, market, calendar).
- **Timing:** cheapest-firing frequency over 30 / 90 / 365 days, with and
  without the weekday.

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
- Scale each difference by the spread of the *previous* differences, and clip
  to ±1. The first 10 only set the scale.
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
  logged 540 forward outcomes (80 at 7 days) without a verdict.

A per-asset champion beats a pooled one; a pooled champion applies to every
asset without its own.

### How long promotion takes

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
- **The spot bot's buy timing.** A promoted timing champion is published. The
  natural next step is for the spot bot to delay a week's tranche to the
  champion's likeliest cheapest firing, with the week-end guarantee still in
  force. It should be an opt-in flag.
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
- **More assets:** the row builder takes `--symbols`; add them to the
  workflow's `--symbols`. Assets without Oracle OI/funding simply drop those
  inputs. Stocks need session-aware horizons first (see
  [SEQUENCE_MODELS](SEQUENCE_MODELS.md)).
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
