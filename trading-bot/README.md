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

## What it does, mapped to what was asked for

- **Fully autonomous.** Fired every 5 minutes by a GitHub Actions cron
  schedule, no manual intervention required. (GitHub's documented cron
  minimum is 5 minutes; actual firing can lag a few minutes under
  platform load — this cadence doesn't need to be exact to be safe,
  since protection lives on the exchange, not in this process — see
  below.)
- **5-20% of the portfolio per trade, 3-20x leverage, scaled to
  confidence.** Confidence = the *lower* of the live confluence engine's
  technique-agreement ratio and that asset's own best-performing
  technique's live accuracy (`combinedConfidence`, `src/risk.mjs`) — both
  have to be genuinely good, not just one.
- **Max 20% per position, max 50% total exposure.** Hard ceilings,
  enforced regardless of confidence (`src/risk.mjs`).
- **Buys near the low end of the predicted range, sells near the high
  end.** Uses `rangePos` exactly as the live dashboard computes it (0 =
  low end, 1 = high end) — no reimplementation, one source of truth
  (`src/signals.mjs`).
- **"Be patient... enter at the right time, not just executing trades."**
  A candidate has to clear a confidence floor AND actually be sitting in
  the low/high entry zone before the bot acts — most cycles, most
  candidates get skipped, logged with the specific reason. Run right now
  against live data (2026-08-17), **every current candidate is skipped
  for insufficient confidence** — that's the patience rule working, not a
  bug.
- **Fear & Greed extreme + reversal aggression.** F&G <=15 with a detected
  bottom (or >=85 with a detected top) *substitutes* for the normal range
  gate and boosts size/leverage by `EXTREME_AGGRESSION_BOOST` (still
  capped at the hard ceilings) — exact thresholds from your own spec.
  "Reversal" here means the intraday signal's `bottomed`/`peaked` flags
  (proximity to a real 24h extreme), not its `dir` field — see the note
  in `src/signals.mjs` on why.
- **"Include other instructions to make it more profitable."** Added on
  top of your spec, all in `src/risk.mjs` / `src/strategy.mjs`:
  - Real exchange-side stop-loss AND take-profit on every position
    (protection survives a run failing outright, or a cycle being
    skipped entirely — it isn't enforced by this process staying alive,
    which matters even more here than on a VM since this process never
    stays alive between cycles by design).
  - Take-profit target = the opposite end of the same predicted range the
    entry was gated on.
  - Stop-loss sized so max loss per trade is a consistent fraction of the
    margin committed, regardless of that trade's leverage.
  - Funding-rate check — skips entries where you'd be paying away edge
    every 8h before the trade has a chance to work.
  - Cooldown after closing a symbol, so it doesn't immediately re-enter
    and churn fees/slippage.
  - Circuit breaker: pauses *new* entries (existing positions stay
    protected) if equity drawdown from peak hits 15%.
  - Daily loss limit: pauses new entries for the rest of the day past
    10% loss since day-start.
  - Every decision is logged, including every skip and why — printed as
    structured JSON to stdout, which is that job run's log in the
    Actions tab. No local log file: there's no disk that survives
    between runs, so the job log IS the audit trail (same pattern as
    every other scheduled script in this repo).

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

**Not yet verified live** (couldn't be, without live credentials): the
exact field names in `getAccount()`'s response (`totalMarginBalance`,
`positions[].notional`, etc.) are Binance's long-stable standard field
names, but this should still be watched closely during your first dry-run
sessions — if a field is ever `undefined` where a number is expected, the
logs will show it plainly rather than silently computing garbage, but
this is exactly the kind of thing to check via the job logs before
flipping to live, not to assume works.

## Not financial advice

Same framing as the dashboard itself: this is an experimental,
autonomous system trading real leveraged money against research findings
that are still actively being validated (see
`correlation_research_findings` in the signals-worker D1 database). Start
in dry-run, size conservatively, and watch it before trusting it with
meaningful capital.
