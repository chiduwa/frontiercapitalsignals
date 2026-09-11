# FrontierCapitalSignals trading bot

Autonomous Binance USDS-M Futures bot, driven by the live signals at
[frontiercapitalsignals.com/signals](https://frontiercapitalsignals.com/signals).
Runs as a one-shot script fired every 5 minutes by a systemd timer on a
single Oracle Cloud instance — see [`deploy/`](deploy/) for the runbook. It
is not a persistent daemon: each firing runs one cycle and exits, with all
state in D1.

It ran on GitHub Actions until 2026-09-05. That moved for two reasons with
one cause: the `*/5` schedule **never fired once**, and GitHub-hosted runners
egress from ~7,251 rotating CIDR blocks, so the Binance API key could never
be IP-restricted — which the security section below had flagged as this
design's weakest point. One instance you own fixes both. This is a **separate
process, targeting the Lead Trader futures account**, and does not depend on
the existing personal-account "Ben 10" bot. If an operator also trades
manually in the same Futures account, those positions are classified
separately and are alert-only: this bot does not add a stop, target or time
exit to them. All state that needs to
survive between runs (equity curve, per-symbol cooldowns, this bot's own
record of open orders) lives in the same D1 database the rest of this
repo already writes to (`trading_bot_*` tables, `signals-worker/scripts/schema.sql`)
— see `src/state.mjs`. Actual balance/positions are always re-read fresh
from Binance every cycle, never trusted from D1.

**This connects to a real account with real leverage. Read this whole
file before setting `DRY_RUN=false`.**

## Bound to the engine's publication gate (confluence-v7)

This is the default, evidence-only mode. The optional active-limit mode below
adds an explicitly experimental rule; it does not change the engine's
publication or confidence requirements.

## Optional active-limit mode (2026-09-10)

`ACTIVE_LIMIT_MODE=true` permits the `active-limit-v1` rule alongside authorized
model calls. The rule needs model-ready price history, at least 30 daily-move
observations, at least three agreeing techniques, and at least 60% directional
screen agreement. A known `no-edge` row is excluded. Screen agreement is only
a rule input: correlated techniques are not independent trials and their
agreement is never labelled a win probability. Opposite qualifying setups for
the same instrument abstain; an authorized model call takes precedence over
an experimental setup.

Experimental setups use a 7.5% minimum entry offset, widening with observed
asset movement up to the existing 10% ceiling. Their calibrated confidence,
expected range and predicted horizon stay null. Validated model calls retain
their existing 5–10% offset rule and bounded high-confidence reduction. Wider
limits may improve the eventual entry price but also reduce fill frequency;
neither a fill nor subsequent profit is guaranteed.

The experimental defaults commit the existing 5% minimum margin per order at
5x leverage, subject to the 50% aggregate margin ceiling. This permits up to
ten minimum-size allocations on an otherwise empty account. Actual exchange
minimum sizes, available margin, existing personal orders, funding, freshness,
duplicate-symbol checks and cooldowns can reduce that number. Every pending
order reserves capacity, and exchange-reported position/order margin is
checked again immediately before submission.

The new baseline uses a 10–30% stop and staged 60%/120% profit targets measured
as gross return on ORIGINAL initial margin, with a maximum 24-hour hold.
At 10x, the profit targets represent 6%/12% favorable price movement.
These are **policy targets**,
not predicted extrema. Their parameters are frozen in the ownership record
so restart/reconciliation cannot replace them with a later setting. Order
expiry is anchored to the original reference timestamp and capped at 24
hours; refreshing the decision cycle does not extend a particular order.
Existing bot ownership checks still prevent stops or targets being placed on
personal or mixed positions.

`ROI_EXIT_POLICY=true` applies this baseline to newly opened authorized model
positions too. Existing positions retain their frozen policy. Both new-mode
flags default false; installing code does not activate live entry mode.

Leverage is 5–20x, capped independently by measured conservative edge and by
the larger of mean/median 30 CLOSED daily high-low ranges (plus a larger current
absolute daily move). Missing, malformed or stale range evidence means 5x.
The initial stability cap is `floor(40 / rangePct)`, bounded to 5–20: 2% or
less can permit 20x, 8% or more caps at 5x. Reliability must also qualify;
technique agreement does not justify higher leverage. Sentiment boosts cannot
override these caps. These anchors are operator baselines, not fitted optima.

Stop ROI is `clamp(rangePct * leverage * (0.25 + 0.25 * reliability), 10, 30)`;
missing range uses 10%. Reliability is the measured-edge progress from the
engine's actionable bar to its full-size bar, not a win probability. First
profit-taking closes 75% at unknown/floor reliability, scaling to 50% at full
reliability; the remainder targets 120%. Original quantity and initial margin
remain immutable for full-trade accounting. Exchange lot rounding applies;
a position too small to split closes at the first target.

The stop and final profit target rest on Binance. First-stage profit and time
exits run on the protection supervisor's nominal 15-second cadence, subject
to API/lease/runtime delays; they are not exchange-resident first-stage orders.
A fresh authorized opposite model signal requests an early close on the full
decision cycle (nominally five minutes). No immediate news-disruption detector
is claimed. Fees, funding, slippage and gaps can change realized ROI; the stop
is a trigger, not a guaranteed loss cap.

### Learning and scalp status

Every new intent retains the exit-policy version, leverage inputs, observed
range and evidence status. Existing seasonal/regime/lead-lag research remains
active and research-only. Automatic per-asset leverage/exit optimization is
NOT connected: it needs chronological after-cost comparisons, untouched
validation and prospective confirmation before changing the baseline.

The microstructure collector currently produces second-scale correlation
findings, not timestamped executable setups or calibrated per-asset pattern
lifetimes. A confirmed correlation alone cannot bypass entry offsets. A
separate live-trigger, duration and latency-aware after-cost scalp execution
path is still required; no microstructure orders are enabled by this patch.

### Offline per-asset policy comparison

`node trading-bot/policy-research.mjs /absolute/path/input.json` prints a JSON
research report. It does not read credentials, connect to Binance/D1, change
settings or place orders. Its input is `{ events, policies, comparison }`:

- Each event requires a unique `id`, exact futures `symbol`, `assetClass`,
  `venue: "binance-usdm"`, `priceType: "mark"`, and a nonempty `source`.
  `side` is BUY/SELL. `regime` is bull/bear/range/unknown and its numeric
  millisecond `contextAt` must be no later than `entryAt`. Month is UTC.
- Numeric `entryAt`, `endAt`, `entryPrice`, and `intervalMs` describe the
  reference trade window. `bars` are contiguous `{ at, open, high, low, close }`
  records beginning at entry and covering the entire window. Intervals may
  range from one second to five minutes. Do not include a candle whose range
  began before the entry; that would leak pre-entry extremes into outcomes.
- `costs` requires decimal `feeRate`, percentage `slippagePct`, a nonempty
  `source`, explicit `fundingComplete: true`, and `funding` records containing
  numeric `{ at, rate, markPrice }`. An empty funding array asserts there were
  no funding settlements in the window; missing funding is not zero funding.
- Each policy needs a unique `id`, leverage 5–20, stop ROI 10–30,
  `firstTargetRoiPct: 60`, `finalTargetRoiPct: 120`, and `firstFraction` 0.5–0.75.
  `comparison` supplies `cutoffAt`, `baselineId` and optional `asOf` in numeric
  milliseconds. The baseline must appear in the policy list.

Entry/exit slippage, two-sided fees and funding on residual quantity are
included. Stop gaps use the opening price, not the crossed stop. Intrabar
stop/target order and funding/exit ambiguities are refused, not guessed.
Every policy uses the same admissible events; exclusions are reported.
Duplicate IDs are errors; overlapping same-asset windows and windows crossing
the chronological split are excluded. Unmatured windows are excluded too.

Within each asset/side/month/regime cell, selection uses training median net
margin ROI only. At least 30 training windows are required to select a
candidate; 20 later windows are required for a descriptive validation report.
The report compares the selected candidate against the baseline on those
same later events. These sample floors do NOT establish significance or
independence. All reports retain `liveEligible: false`, even when profitable.

Budgets: 32 MiB input, 5,000 events, 250,000 total bars and 32 policies per
run. The tool does not silently truncate a requested history. Importantly,
mark-price candles are not executable quotes, do not prove limit fills, and
cannot validate second-scale scalp latency. Portfolio/liquidation effects,
survivorship and repeated-search overfitting require separate validation.
See [Bailey et al., The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)
for why the best historical candidate is not automatically a reliable edge.

Current status: the replay/comparison engine is implemented and tested on
synthetic fixtures. A production historical-path adapter, scheduled runs,
prospective confirmation and any live promotion remain unimplemented. No
real-market profitability result is claimed by these software tests.

In active mode, the loss gate reconstructs cumulative net P&L, its realized
peak, and UTC daily P&L from `origin='bot'` settled outcomes. It also includes
negative mark P&L on exactly owned open positions, without crediting open
gains against booked losses. The 15% drawdown and 10% daily thresholds compare
those attributed losses with currently available account equity plus those
losses. Personal trades and cash flows affect available capital but never
enter the bot-loss numerator; the old account high-water mark is preserved.
This is an entry-risk measure, not a cash-flow-adjusted fund NAV: fees and
funding on open trades are incorporated when their exact outcome settles.
Missing outcomes or mixed ownership prevent new entries until reconciled.
An additional account-wide gate blocks entries at maintenance margin of at
least half of equity.

With `ACTIVE_LIMIT_MODE=false`, qualified experimental setups are collected
as shadow observations, and the original account drawdown gate remains in
force. No old shadow result is promoted into a real fill or learned confidence.

### Operator activation

Review the settings in `.env.example`, then edit the existing server file:

```bash
sudoedit /etc/fcs-trading-bot.env
```

Set `ACTIVE_LIMIT_MODE=true` for the experimental policy. `DRY_RUN=true`
previews its orders; the operator's explicit `DRY_RUN=false` setting permits
live execution. The next scheduled five-minute cycle reads the settings;
no service restart or timer change is needed. Verify `bot_entry_risk`,
`decision_open`, and `resting_limit_placed` in the service log. A proposal or
resting order is not proof of a fill. This release does not change the server's
activation settings automatically.

## Evidence-only contract

This bot does not have its own opinion about direction. It reads the same
public JSON the dashboard renders from, and it may open a position only when
the engine has **published an authorized call**. Concretely, in `contract.mjs`:

- the asset class must have demonstrated skill over its **own** measured
  no-skill baseline (`classSkill[class].proven`);
- the row must carry a published `dir` of +1 or -1 — **which board a row was
  screened onto is not a trade call**, and is never read as one;
- `horizon` and `range` must both be `basis: 'historical'`, i.e. produced by a
  matching-horizon record rather than a methodology assumption;
- `confidence.calibration_source` must be the exact
  `asset-class-direction-horizon` cell (pooled calibration is diagnostic only
  and may never authorize a position), with the engine's independent-sample
  minimums met on the asset record, the calibration cell and the range;
- `confidence.conservative_edge` — a Wilson lower bound on accuracy minus the
  class baseline — must clear the engine's own 0.18 bar.

If any one of those is missing, there is no trade. The engine already nulls
`dir`/`horizon`/`range`/`confidence` together when it withholds, so this file
**verifies that invariant** rather than re-deriving statistics: no
reconstructing a direction from `score`, `rangePos`, or a driver list.

What changed, and why it mattered: before v7 this bot read board membership as
direction and `conf.agree / conf.total` as confidence. Technique agreement
across correlated techniques is precisely the "independent evidence" fallacy
the engine's own audit removed
(`signals-worker/QUANT_SIGNAL_DIAGNOSIS.md`) — and `topIndicator` is no longer
published for a withheld row, so the old confidence floor was silently
resolving to zero and skipping everything for the wrong reason. The Fear &
Greed reversal boost was also reading `bottomed`/`peaked` from `/api/intraday`,
a pipeline retired for showing no usable edge whose endpoint now returns a
deprecation stub with no watchlist — so that whole branch was unreachable. It
now uses `posInDayRange` from the measurement-only `/api/scalp` surface, which
is the same underlying idea (proximity to a real session extreme) and a number
the engine still stands behind.

### Second authorized source: confirmed research

A strategy from the engine's discovery lane retains a second authorization
path, but only in the `confirmed` lifecycle state — family-corrected discovery,
then purged walk-forward folds, then a **positive after-cost 95% lower bound
replicated on data that did not exist when the pattern was found**.
`provisional` may not trade. The current research payload does not publish an
immutable reference price, so the LIMIT-entry policy withholds those rows until
it does; it never invents one from the live mark. Once that field is supplied,
these positions take the floor size and floor leverage because the evidence is
an event study rather than per-asset calibration, and sit under their own much
lower exposure ceiling
(`MAX_RESEARCH_EXPOSURE_PCT`), and never outrank a calibrated directional call
for the same margin. Their stop is sized off the strategy's **own measured
worst trade** rather than a generic fraction — a stop tighter than the
drawdown the rule is known to produce would cut exactly the trades its
expectancy depends on — and is still bounded by the normal per-trade cap.

## Entry and exit, measured rather than assumed

The engine records, for every matured non-overlapping forecast, the best and
worst price reached inside the declared window and when each first occurred
(`payload.holdingEvidence`, 30 independent paths minimum). The bot uses all
three numbers, and falls back to the previous behaviour per asset until that
asset clears the floor:

- **Take-profit** targets a fraction of the measured mean favorable excursion
  rather than the far edge of the volatility band. The fraction
  (`TAKE_PROFIT_MFE_FRACTION`, 0.7) is there because excursion distributions
  are right-skewed: their mean sits above their median, so a target at the
  full mean would be reached less than half the time. Where both a band edge
  and a measured target exist, the **nearer** one wins — banking a measured,
  achievable move is what the engine's own "gave back" column exists to
  argue for.
- **Time exit.** Past the measured mean time-to-peak, the evidence says the
  favorable excursion for this asset/side/horizon is usually already behind us
  and the position is giving back. The bot closes at market. This is the one
  exit that cannot live on the exchange (Binance has no "close after N hours"
  order), so it is enforced in-process and is strictly additive: a missed
  cycle delays it, it never removes the stop or target underneath. It never
  extends past the declared horizon.
- **Resting LIMIT entry.** The immutable `analysis.reference_price`, not the
  later live dashboard price, anchors every entry. A long limit rests below
  that reference and a short limit above it. The offset begins at 5%, widens
  with adequately sampled exact-asset median daily movement, the current
  absolute 24-hour move, or measured adverse excursion (preferring the
  wrong-call subset), and is capped at 10%. The strongest calibrated edge may
  reduce it by at most one percentage point, never below 4%; the bot never
  deliberately submits at the signal price. A reference older than 30 minutes
  or more than 3% from the live Binance mark fails closed.
- **Bounded order life.** Entries use Binance `LIMIT` + `GTD`. Their expiry is
  the measured mean time-to-peak when available, otherwise the forecast
  horizon, clamped to 15 minutes through 24 hours. Resting exposure is reserved
  against the portfolio cap. A partial fill causes the exact remainder to be
  canceled before the filled quantity can be protected.
- **Exact lifecycle reconciliation.** A deterministic client order ID and the
  frozen symbol/side/quantity/price/expiry are checked on every retry. Expiry,
  ownership conflicts and cleanup cancel only that exact bot-tagged order;
  there is no account- or symbol-wide cancellation.

Migration `0030_futures_limit_entry_intents.sql` is the durable write-ahead
ledger for live, dry and shadow proposals. It retains the signal reference,
offset inputs, expiry, fills/cancellations and realized outcome so unfilled
orders remain evidence about whether an asset's margin of error was too near
or too far. Apply it before running this version of the bot.

## The shadow ledger, and why the bot may place nothing for weeks

Migration 0009 reset the engine's derived evidence on purpose, so as of
2026-09-04 **every** direction is withheld and `classSkill.crypto` is null.
A correctly-gated bot therefore opens nothing until that evidence rebuilds —
which is the right answer, not a bug, and the thresholds must not be lowered
to change it.

During that window, each already-withheld candidate that clears the bot's
per-candidate gates is
recorded as a shadow LIMIT proposal in `trading_bot_entry_intents`, including
its exact reference, offset and expiry. It is **not** recorded as a fill and
does not enter performance statistics merely because it was proposed. Any
later evaluation must first establish from subsequent market data that the
limit actually traded. Historical pre-0030 market-entry shadows remain in
`trading_bot_shadow_trades` and continue to resolve under their original
methodology.

Account drawdown and daily-loss gates still block **every live entry**, but
do not by themselves block these research-only proposals. Freshness, funding,
existing-position, cooldown and exposure checks still apply. An authorized
candidate remains `SKIP` while an account gate is active; the bot does not
turn a shadow proposal into an order. This preserves prospective learning
without resetting the account's risk baseline or treating a research record
as profit.

Three provenances are kept strictly separate and never pooled: `shadow`
(engine had not authorized), `dry` (authorized, `DRY_RUN` on), and `live`.
New crypto dry and shadow proposals are resolved only as LIMIT
**reachability research** from subsequent hourly OHLC bars. A low/high crossing
can establish that the price touched the limit, but it cannot establish queue
position, venue liquidity, slippage, or intrabar ordering, so it is never
counted as an execution or P&L. A non-touch is marked expired only when at
least 75% of the expected bars and both window boundaries are present;
otherwise it remains `awaiting-bars`. Stock proposals remain unresolved until
a point-in-time stock-bar source is available rather than borrowing crypto
evidence or current prices. For the
historical filled-form ledger rows, resolution judges against the extremes
seen since entry, not the latest mark,
because a stop breached and then recovered between two cycles is a closed
trade and scoring on the current price alone would silently drop exactly the
losers. When both levels have been seen it resolves as the **stop** — which
came first is unknowable from sampled extremes, so it takes the unflattering
reading.

**Stated limit:** those extremes are sampled at the cycle cadence (~5
minutes), so a spike through a level and back inside one gap is invisible.
A real position does not have that problem — its stop and target live on the
exchange and trigger on any tick. The ledger is therefore biased slightly
optimistic against a live position and must not be read as a like-for-like
backtest of one.

## Risk controls

- 5–20% of the portfolio per trade. Evidence-scaled leverage receives a modest
  1.15 multiplier after authorization and is still hard-capped at 20x; it does
  not loosen the per-position or total exposure ceilings. Confirmed-research
  trades retain their separate floor sizing.
- Max 20% per position, max 50% total exposure, enforced regardless of edge.
- Quantity-bounded, reduce-only exchange-side stop-loss AND take-profit on
  every verified bot-owned filled position, so protection survives a failed
  or skipped cycle. A protection-only service checks resting fills every 15
  seconds (subject to host, network, exchange and scheduler latency) and shares
  the decision cycle's execution lease, so it cannot race a five-minute run.
- Funding-rate check, per-symbol cooldown, 15% drawdown circuit breaker, 10%
  daily loss limit. A shadow entry consumes no exposure and can never crowd
  out a real one.
- Every decision is logged as structured JSON to the job log, including every
  skip and the engine's own reason for withholding.
- `node test.mjs` covers the contract binding, sizing, entry/exit geometry,
  order identity, ownership and ledger resolution with no network or Binance
  key. The engine's numeric
  bars are pinned there, so a drift that would leave the bot laxer than the
  system it follows fails the suite. `deploy/setup.sh` refuses to install a
  checkout that fails them, and the hourly update rolls back rather than arm
  an untested bot.

### Personal trades and account isolation

Manual/foreign positions are alert-only at every risk level. The bot records
their risk readings but has no setting that can turn those readings into a
stop, target or close. If a manual position appears while a bot entry rests,
the bot attempts to cancel only its own exact tagged entry; if ownership of a
net position cannot be proved from an exchange-confirmed fill and exact
quantity, automated management is quarantined. Legacy `fcsa-*` assisted stops
from older versions are retired by exact ID.

That software policy is not hard isolation. Binance one-way mode nets manual
and automated fills for the same symbol into one position, and a manual fill
can race between two API checks. New protection is exact-quantity and
`reduceOnly=true`, and ownership is rechecked before each protective POST and
again afterward; if ownership changes, the bot cancels only its own exact IDs.
That bounds and narrows the race, but software cannot eliminate it on a netted
position. If “the bot can never affect a personal trade” is a hard requirement,
use a dedicated Futures subaccount/account; a second API key on the same
one-way account is not sufficient isolation.

### Asset-class boundary

Stocks pass the same class-skill and exact calibration gates as crypto, then
must map to an active USDT-margined Binance `TRADIFI_PERPETUAL` whose exchange
metadata identifies it as equity/TradFi and which supports LIMIT/GTD,
have a fresh reference within 3% of that contract's mark, and expose live
funding. The bot never accepts or signs a Binance TradFi agreement; account
eligibility remains an operator/exchange decision. A ticker-name match alone
does not authorize a trade. Commodities are
not currently an execution class: the bot abstains until the signal engine has
a commodity board, class baseline/calibration, immutable references and an
explicit verified Binance-contract mapping. Exchange availability alone is
not evidence.

## Security — non-negotiable

Generate a **trade-only** API key on Binance: enable **Futures** +
**Reading**, leave **Withdrawals off**. This bot never needs withdrawal
permission for anything it does, and a compromised trade-only key can't
drain the account.

**Restrict the key to the instance's reserved public IP.** This is now
possible and you should do it: the bot runs from one address you control.
Reserve the IP first — an ephemeral Oracle public IP changes on stop/start
and would silently break the allowlist. `deploy/setup.sh` prints the egress
address it actually sees, so you allowlist the measured value rather than an
assumed one.

The secret lives only in `/etc/fcs-trading-bot.env` on that instance (mode
640, root:fcsbot), not in GitHub secrets and not in this repo. Keep the
trade-only / no-withdrawal scope as well: IP restriction and scope are
independent controls, and rotate the key if the instance or this repo is ever
suspected compromised.

Never put real keys in `.env.example`; `.env` is only for local dry-run
testing and is gitignored.

## Setup

```bash
npm test                 # runs the pure risk/strategy logic tests, no network needed
```

For **local** testing only (not how it runs in production):

```bash
cp .env.example .env    # fill in BINANCE_API_KEY / BINANCE_API_SECRET / Cloudflare D1 creds, leave DRY_RUN=true
node src/index.mjs       # runs ONE cycle and exits — no internal loop
```

With `DRY_RUN=true` (the default), it does REAL reads (account balance,
positions, live prices) so the proposal uses current inputs, but it sends no
orders or leverage changes and does not fabricate a fill. Watch several days
of logs before considering `DRY_RUN=false`.

## Running in production

Production runs from the Oracle host under systemd; see
[`deploy/README.md`](deploy/README.md). Before the host pulls this version,
apply D1 migrations (through 0031), push `main`, let the hourly updater run
its tests, and inspect the service log. The updater deliberately does not
restart or enable timers. Keep the trade-only credentials in
`/etc/fcs-trading-bot.env` and keep `DRY_RUN=true` until the proposals and
ownership classifications have been reviewed.

## What I verified vs. what still needs your own verification before going live

Verified directly against Binance's current API docs while building this
(not assumed from training data, which has a January 2026 cutoff):
Binance migrated conditional orders (STOP_MARKET/TAKE_PROFIT_MARKET) to a
separate Algo Order API on 2025-12-09 — the old order endpoint now
rejects them outright. This bot uses the correct current endpoints
(`POST /fapi/v1/algoOrder`, `GET /fapi/v1/openAlgoOrders`) — getting this
wrong would have meant stop-losses silently failing to place.

Fixed 2026-09-05, and worth calling out because it had never been reached:
the engine speaks in bare asset symbols (`UNI`) while this account trades
USDT pairs (`UNIUSDT`), and nothing mapped between them. Any candidate that
ever cleared the gates would have thrown `no exchange info for UNI` inside
order sizing. It was invisible only because no candidate has ever cleared
them. There is now a mapping plus a tradability check that drops any asset
with no Binance USDS-M futures market before it can reach execution.

**Not yet verified live** (couldn't be, without live credentials): the
exact field names in `getAccount()`'s response (`totalMarginBalance`,
`positions[].notional`, etc.) are Binance's long-stable standard field
names, but this should still be watched closely during your first dry-run
sessions — if a field is ever `undefined` where a number is expected, the
logs will show it plainly rather than silently computing garbage, but
this is exactly the kind of thing to check via the job logs before
flipping to live, not to assume works.

Also unverified live: the order-placement path itself has never executed,
in dry-run or otherwise, because no candidate has ever been authorized.
The first authorized call the engine publishes will be the first time
`executeOpen` runs end to end. Watch that cycle's job log specifically.

## Not financial advice

Same framing as the dashboard itself: this is an experimental,
autonomous system trading real leveraged money against research findings
that are still actively being validated (see
`correlation_research_findings` in the signals-worker D1 database). Start
in dry-run, size conservatively, and watch it before trusting it with
meaningful capital.
