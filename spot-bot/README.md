# FrontierCapitalSignals spot bot

Conditional dollar-cost accumulation on Binance **spot**. Separate process and
**separate API key** from the futures bot in [`../trading-bot/`](../trading-bot/),
sharing the same host and the same D1 database. Fired every four hours by
`fcs-spot-bot.timer`; provisioned by
[`../trading-bot/deploy/setup.sh`](../trading-bot/deploy/setup.sh).

**Accumulate only. This bot never sells.**

## Why this one can run while the futures bot cannot

The futures bot is gated on the engine publishing an authorized directional
call, and under `confluence-v7` every call is withheld until independent
evidence rebuilds — so it places nothing for days or weeks, correctly.

This bot makes **no directional forecast at all**. Its premise is that
spreading purchases across time converts price variance into a lower average
cost basis, which does not depend on predicting anything. Every input it uses
is either a descriptive measure the engine publishes regardless of the gate, or
an observation about what price has *already* done. That is why it is useful
now rather than eventually.

## Selection: descriptive measures only

Two sleeves, from the universe that is actually spot-tradable here:

- **Core** (75% weight, up to 7): market-cap rank inside the top 40.
- **Satellite** (25%, up to 3): ranked beyond that — the smaller, higher-risk
  sleeve.

Ranked by: whether the asset sits on the engine's `longTermPotential` board
(its measurement of "currently near a fresh multi-month/year low" — which most
directly serves buying low), then published `quality` percentile, then
market-cap rank.

**Not used for selection:** `dir`, `score`, `confidence`, or membership of the
breakout/breakdown boards. Those are screen and forecast outputs; letting them
pick accumulation targets would smuggle a withheld directional call in through
the back door. A regression test asserts that a payload with every row marked
`abstained` selects *identically* to an authorized one.

Two honest limits:

- An asset with no published `quality` percentile is not ranked, and one with
  no Binance spot pair is dropped however good it looks (`KCS` is on the board
  but is KuCoin's own token).
- If the core screen comes up short, its weight is **not** redistributed to the
  satellite sleeve. Padding an unvalidated sleeve because the validated screen
  was thin is the opposite of what the screen is for.
- The satellite sleeve carries real survivorship risk. The engine's own
  long-term-bottom detector "deliberately makes no claim about which candidates
  will actually succeed," and DCA's premise is that the asset survives long
  enough for averaging to pay. That premise weakens down the market-cap curve.

## The buy triggers, measured per asset

A tranche is 5% of the free quote balance, due weekly. It is only spent when
one of two conditions holds — otherwise the week is skipped:

**1. A significant drop.** Price is at least 1σ below the last completed weekly
close, where σ is the standard deviation of *that asset's own* weekly return
distribution. A fixed percentage would mean completely different things for
BTC and for a low-cap; a test pins that a 3% drop clears a calm asset's bar and
does not clear a volatile one's.

**2. The projected weekly low has been reached.** Price is at or below this
week's open times the asset's *median* drawdown from weekly open to weekly low,
measured over the trailing year. That is a level this asset routinely trades
down to — an observation about the current week, not a prediction about the
next.

Both come from Binance weekly candles, and **the in-progress week shapes no
statistic** — otherwise a partial candle biases the very bar it is judged
against. An asset with fewer than 12 completed weeks, or with no dispersion to
measure against, is abstained on rather than guessed at.

## Deferral, and the trap it avoids

Skipping is the whole point of "buy at the lowest", but a skipped tranche is
not lost: for each whole period that elapses without a buy, the pool grows by
one tranche, capped at two carried (so 15% maximum in one cycle). A real
drawdown therefore gets bought harder.

The pool is derived from **elapsed time**, never from a stored accumulator.
That is deliberate: the timer fires six times a day so it can catch an
intra-week dip, and an accumulator would grow on every *firing* while a tranche
sat due rather than once per *period*. Computing it from the clock makes
over-accumulation structurally impossible rather than merely unlikely.

The tranche clock only restarts when something was actually bought. If a whole
cycle is declined, the tranche stays due and the next firing re-checks hours
later, not a week later.

## Worth being clear about

**Conditional DCA is market timing.** Plain DCA buys unconditionally and is
immune to being wrong about the entry; adding conditions means the bot can sit
out a rally entirely and accumulate nothing. That is a deliberate choice here,
not an oversight — but it is a real tradeoff, and it is why every skip is
written to `spot_bot_skips` with its reason and price. Without that record
there would be no way to judge later whether the waiting actually paid.

## The weekly guarantee (2026-09-23)

The conditional rule above did exactly what that paragraph warned: between
2026-09-10 and 2026-09-23 it bought once while its coins rallied, and the
deferred pool sat unspent. Backtested on 4-hour Binance prices for eight core
coins (BTC ETH SOL XRP HBAR XLM ADA DOGE), September 2024 to September 2026:

| rule | buys in 104 weeks | average cost vs plain weekly DCA | end value of $1,000 |
| --- | ---: | ---: | ---: |
| dips only (the rule above) | 39 | 9.7% worse | $741 |
| plain weekly DCA | 77 | — | $816 |
| **dips first, but never a week without a buy** | 83 | 0.7% better | **$818** |
| dips first, forced after 14 days without one | 60 | 1.2% worse | $800 |

Dips-only waits out every rally and then buys at higher prices (XLM +53%
cost, XRP +15%); it only wins in steady declines (SOL, ADA -6%). So a tranche
is now due whenever the current calendar week (Monday 00:00 UTC, the weekly
candle boundary) has no buy. A dip inside the week is still bought first; if
none comes, the final firing before the week closes buys the tranche anyway,
logged as `week-end-guarantee`. `SPOT_WEEKLY_GUARANTEE=false` restores
dips-only.

## Risk-weighted core sleeve (optional, off by default, 2026-10-03)

`SPOT_RISK_MODE` = `off` (default) | `shadow` | `on`. Code: `src/risk-weights.mjs`.

Instead of splitting each tranche evenly, `on` buys the triggered coins that sit
furthest below a **minimum-variance target**: long-only, at most 20% per coin
(`SPOT_RISK_CAP`), covariance from 180 daily returns (sample volatility times a
Ledoit-Wolf shrunk correlation). Only the core sleeve is weighted; the 75/25
sleeve split stays, and satellites stay equal (three coins cannot bind a 20% cap).
No expected return is used, so no withheld directional call can leak in.

**Evidence** (`optimization-portfolio/crypto-risk-portfolio`, rule fixed before the
run): six yearly windows 2020-2026, the 10 most-traded established coins at each
start, weekly buys at this bot's real size ($13, $5 minimum order). Against today's
even split, steering to these targets had lower volatility in 5 of 6 windows and a
smaller worst drawdown in 5 of 6 (e.g. -40% vs -51%, -52% vs -65%). Sharpe was
higher in 4 of 6; the pooled gain of +0.15 has a 90% interval of -0.03 to +0.34.
**Lower risk is shown; a higher return is not.** Steering to *equal* targets
changed nothing (+0.00), so the gain comes from the targets themselves.

**Caveat the numbers cannot show:** minimum variance leans on the calmest coins,
which in every window included BNB and TRX, single-company tokens. FTT showed that
an exchange token can go to zero in days, and price history does not price that.

**How it is solved:** an exact active-set method in plain JavaScript. Every
solution must pass the optimality (KKT) conditions or the cycle falls back to the
even split. It matches Gurobi to 1e-9 on 61 cases. HiGHS is deliberately not used:
its QP solver returned a non-optimal corner, labelled optimal, in 2 of 1,248
research solves (`test-fixtures/risk-weights.json` keeps one).

**Suggested rollout:** `shadow` for a few weeks. Each tranche cycle logs
`risk_shadow` with the targets, current holdings, the orders risk mode would
place, and the even-split orders actually placed. Then `on`.

## Sell side

There isn't one, and `sellEnabled` is a hard `false`. An exit needs either a
directional call or a valuation model, and the engine currently withholds both,
so any threshold written today would be invented rather than measured — exactly
the practice the v7 audit removed. `spot_bot_fills` records average cost basis
per asset so the position is visible; the sell path gets built when the engine
authorizes one.

## Operating it

```bash
sudo nano /etc/fcs-spot-bot.env          # the SPOT key (separate from futures)
sudo systemctl start fcs-spot-bot        # one cycle, by hand
journalctl -u fcs-spot-bot -n 80 --no-pager
sudo systemctl enable --now fcs-spot-bot.timer
node test.mjs                            # 50 assertions, no network or key
```

Keep `SPOT_DRY_RUN=true` until several cycles look right. Dry run still reads
real balances, prices and candles, and records its would-be fills with
`mode='dry'` so they are never pooled with live ones.

Every tunable is env-overridable — see [`src/config.mjs`](src/config.mjs).
