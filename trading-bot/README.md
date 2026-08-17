# FrontierCapitalSignals trading bot

Autonomous Binance USDS-M Futures bot, driven by the live signals at
[frontiercapitalsignals.com/signals](https://frontiercapitalsignals.com/signals).
Built to run unattended on the Oracle Cloud VM ("Ben 10" region,
af-casablanca-1) alongside the existing personal-account bot — this is a
**separate process, targeting the Lead Trader futures account**, and does
not touch or depend on the existing bot in any way.

**This connects to a real account with real leverage. Read this whole
file before setting `DRY_RUN=false`.**

## What it does, mapped to what was asked for

- **Fully autonomous.** Runs in a loop (default every 5 minutes), no
  manual intervention required.
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
    (protection survives a bot crash or VM reboot — it isn't enforced by
    this process staying alive).
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
  - Every decision is logged, including every skip and why
    (`state/decisions.jsonl`) — full audit trail for an unattended system
    moving real money.

## Security — non-negotiable

Generate a **trade-only** API key on Binance: enable **Futures** +
**Reading**, leave **Withdrawals off**. Restrict it to the VM's public IP
in Binance's API management page. This bot never needs withdrawal
permission for anything it does, and a compromised trade-only key can't
drain the account.

`.env` (real keys) is gitignored and must never be committed. On the VM,
create it by hand from `.env.example` — don't sync it from a laptop.

## Setup

```bash
cp .env.example .env    # fill in BINANCE_API_KEY / BINANCE_API_SECRET, leave DRY_RUN=true
npm test                 # runs the pure risk/strategy logic tests, no network needed
node src/index.mjs       # starts the loop
```

With `DRY_RUN=true` (the default), it does REAL reads (account balance,
positions, live prices) so the simulation is realistic, but every order
placement is logged as `dry_run_would_*` instead of actually sent. Watch
`state/decisions.jsonl` for at least a few days before considering
`DRY_RUN=false`.

## Deploy to the Oracle VM

```bash
./deploy/deploy.sh ubuntu@<vm-ip>
```

Copies the code (never `.env`) and installs it as a systemd service
(`deploy/trading-bot.service`) so it survives reboots and restarts on
crash. First time on the VM: `ssh` in once and create `.env` by hand.

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
this is exactly the kind of thing to check via `decisions.jsonl` before
flipping to live, not to assume works.

## Not financial advice

Same framing as the dashboard itself: this is an experimental,
autonomous system trading real leveraged money against research findings
that are still actively being validated (see
`correlation_research_findings` in the signals-worker D1 database). Start
in dry-run, size conservatively, and watch it before trusting it with
meaningful capital.
