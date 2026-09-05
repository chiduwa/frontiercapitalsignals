# FrontierCapitalSignals trading bot

Autonomous Binance USDS-M Futures bot, driven by the live signals at
[frontiercapitalsignals.com/signals](https://frontiercapitalsignals.com/signals).
Runs as a one-shot script fired every 5 minutes by GitHub Actions
(`.github/workflows/trading-bot-cycle.yml`), not a persistent daemon —
there's no VM. This is a **separate process, targeting the Lead Trader
futures account**, and does not touch or depend on the existing
personal-account "Ben 10" bot in any way. All state that needs to
survive between runs (equity curve, per-symbol cooldowns, this bot's own
record of open orders) lives in the same D1 database the rest of this
repo already writes to (`trading_bot_*` tables, `signals-worker/scripts/schema.sql`)
— see `src/state.mjs`. Actual balance/positions are always re-read fresh
from Binance every cycle, never trusted from D1.

**This connects to a real account with real leverage. Read this whole
file before setting `DRY_RUN=false`.**

## Bound to the engine's publication gate (confluence-v7)

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

A strategy from the engine's discovery lane may also open a position, but only
in the `confirmed` lifecycle state — family-corrected discovery, then purged
walk-forward folds, then a **positive after-cost 95% lower bound replicated on
data that did not exist when the pattern was found**. `provisional` may not
trade. Because that evidence is an event study rather than per-asset
calibration, these positions always take the floor size and floor leverage,
sit under their own much lower exposure ceiling
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
- **Entry patience.** `adverseFirstLower` is the lower bound on how often the
  window's worst price arrived *before* its best. When that clears 50%, the
  evidence says this setup goes against you first, so filling at the signal
  price is measurably the wrong fill — the bot waits for price to reach the
  session's low band (or high, for a short) instead. It runs again in five
  minutes; a resting limit order would need an order lifecycle a one-shot
  process cannot supervise.

## The shadow ledger, and why the bot may place nothing for weeks

Migration 0009 reset the engine's derived evidence on purpose, so as of
2026-09-04 **every** direction is withheld and `classSkill.crypto` is null.
A correctly-gated bot therefore opens nothing until that evidence rebuilds —
which is the right answer, not a bug, and the thresholds must not be lowered
to change it.

Rather than idle through that window, every candidate that clears each gate
the bot itself owns and fails **only** on the engine's authorization is
recorded in `trading_bot_shadow_trades` with the exact entry, stop, target and
clock it would have used. Later cycles resolve those against real subsequent
prices. So when the engine does open up, the bot arrives with a record of its
own selection quality instead of a blank one.

Three provenances are kept strictly separate and never pooled: `shadow`
(engine had not authorized), `dry` (authorized, `DRY_RUN` on), and `live`.
Resolution judges against the extremes seen since entry, not the latest mark,
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

## Risk controls (unchanged in intent)

- 5–20% of the portfolio per trade, 3–20x leverage, now scaled on the
  conservative edge over baseline rather than a raw win rate — a flat win-rate
  threshold demands wildly different edges in different classes, purely as an
  artifact of where each baseline sits.
- Max 20% per position, max 50% total exposure, enforced regardless of edge.
- Real exchange-side stop-loss AND take-profit on every position, so
  protection survives a failed or skipped cycle.
- Funding-rate check, per-symbol cooldown, 15% drawdown circuit breaker, 10%
  daily loss limit. A shadow entry consumes no exposure and can never crowd
  out a real one.
- Every decision is logged as structured JSON to the job log, including every
  skip and the engine's own reason for withholding.
- `node test.mjs` covers the contract binding, sizing, exit geometry, patience
  and ledger resolution with no network or Binance key. The engine's numeric
  bars are pinned there, so a drift that would leave the bot laxer than the
  system it follows fails the suite. The cycle workflow runs it before every
  live cycle.

## Security — non-negotiable

Generate a **trade-only** API key on Binance: enable **Futures** +
**Reading**, leave **Withdrawals off**. This bot never needs withdrawal
permission for anything it does, and a compromised trade-only key can't
drain the account.

**No IP restriction is possible.** GitHub-hosted runners use a large,
changing pool of IPs (GitHub publishes ranges, but they rotate and
aren't practical to allowlist on Binance's side) — unlike the original
VM design, this key cannot be locked to a fixed IP. The trade-only /
no-withdrawal scope is doing the real security work here; treat the key
as the sole thing standing between a leaked secret and unauthorized
trades, and rotate it if this repo (or its GitHub secrets) is ever
suspected compromised.

Store the real key as GitHub repo secrets (`BINANCE_API_KEY`,
`BINANCE_API_SECRET`) — Settings → Secrets and variables → Actions.
Never put real keys in `.env.example`, `.env` is only for local dry-run
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
positions, live prices) so the simulation is realistic, but every order
placement is logged as `dry_run_would_*` instead of actually sent. Watch
several days of job logs (Actions tab → Trading Bot Cycle) before
considering `DRY_RUN=false`.

## Running in production

There's nothing to deploy — the code runs directly from this repo via
`.github/workflows/trading-bot-cycle.yml`, same as the rest of this
repo's scheduled scripts. To go live:

1. Add repo secrets `BINANCE_API_KEY` / `BINANCE_API_SECRET` (trade-only,
   see above). `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` and the
   `FCS_D1_DATABASE_ID` variable are already set for this repo and are
   reused as-is — nothing to add there.
2. Push to `main` (or use "Run workflow" in the Actions tab to fire one
   cycle on demand without waiting for the cron).
3. Leave the `TRADING_BOT_DRY_RUN` repo variable unset (defaults to
   `true`) until satisfied with several days of dry-run job logs. Set it
   to `false` (Settings → Secrets and variables → Actions → Variables)
   only when ready to place real orders.

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
