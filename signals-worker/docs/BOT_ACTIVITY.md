# Can the bots trade more often? Testing the research as real trades

2026-09-29. Asked: "anything usable for my bots to trade on? i need them to be
more active / open more orders".

## Short answer

Not yet. Nothing in the research survives fees and funding on perpetuals at a
higher trade count. The two candidates that could keep the futures bot busy
were replayed as real trades on Binance perpetuals, with real funding and
delisted coins included:

| Candidate | How active | After costs | Holds in both halves? |
|---|---|---|---|
| Exhaustion shorts (the Sell pressure alert) | about 234 signals a month | -0.33% a trade (2024-02 to 2025-05), +0.23% (2025-06 to 2026-08) | No |
| 40-day coin rotation, every laggard against every leader | about 100 positions, rebalanced daily | +13% a year, t 1.0 | Too weak to tell |
| The same rotation, 10 against 10 (what a small account can hold) | 20 positions | -12% a year | No |

The futures bot has placed no live order because it only trades calls the
engine is allowed to publish. In its last shadow log (2026-09-07 to 09-09)
all 2,959 candidate calls were withheld: 2,549 because the research lifecycle
said "abstain" and 410 because the asset class had no measured skill yet. The
classic-models and overfitting studies found those calls don't beat the base
rate, so opening the gate would pay fees on coin flips.

## Data

Binance's public archive (`data.binance.vision`): monthly 1h candles for spot
and for USDS-M perpetuals, and the perpetuals' funding history, 2024-01 to
2026-08. Every coin with both a spot USDT pair and a USDT perpetual, delisted
ones included: 473 coins, 456 with data in the window. The archive keeps
delisted pairs, so unlike the earlier replays this one is not limited to
survivors.

Scripts in `research-2026-09-29-bot-activity/scripts/`: `list_universe.py`,
`fetch_archive.py`, `sim.py`, `report.py`, `reconcile.py`, `sleeve.py`,
`rotation_perp.py`. Outputs in `results/`.

## Exhaustion shorts as trades

**The signal is the live rule, computed the same way:** spot 1h bars, the
per-coin rule (volZ >= 3, barZ >= 3, run24Z >= 1.5, rising bar) or the 20x rule.
Majors (30-day median hourly quote volume of $400K or more) are left out, as
live. Thin means under $33K an hour.

**The trade is a short on the perpetual:**

- Entry at the next bar's open, or an hour later (the live scan and the bot
  act within minutes, so the truth is in between). Or a limit 3% or 5% above
  the print's close, resting 12 hours.
- Stop: none, 15% or 25%. Hold: 24h or 72h.
- Costs: 0.02% maker, 0.05% taker, slippage of 0.10% (thin) or 0.05% (mid) on
  each taker fill (stops pay double), and the real funding payments.
- One position per coin: the first print per coin per 24 hours.

**Results.** Picked on the first half among the hour-late entries: market
entry, 15% stop, 24h exit. The first half made -0.33% a trade (t -1.3), the
second +0.23% (t +1.2). All 36 variants lost money in the first half (the
best, t -0.3), and none reaches t 2 in the second (the best, t +1.7). Limit
entries above the print are the worst of all, because they fill mostly when
the pump keeps going.

**Where the study's edge goes** (`results/reconcile.txt`). The study's measure
still holds on these coins: from the print's spot close, the coin trails the
market by 2.22% over 24h (thin 3.42%, mid 1.36%). A trade keeps little of it:

| First print per coin, next open to 24h | |
|---|---|
| A short at the spot close would make | +1.79% |
| The perpetual actually moves | +1.03% |
| Fees and slippage | -0.24% |
| Funding | -0.52% |
| Net | +0.27% |

After a pump the perpetual already trades below spot and the shorts pay
funding: most of the drop is priced in before the bot can act. On follow-on
prints in the same pump, shorts pay 1.31% in funding and the net turns
negative (-0.31%).

**A book of them loses more than the average trade suggests.** Run as a
portfolio at 5% margin a trade, 2x, at most 10 open: -50% a year in the first
half, -4% in the second. Pumps come in waves, a capped book takes the first
shorts of a wave, and those get squeezed. In the second half, the trades it
took averaged +0.08% and the ones it had no room for +0.67%.

**One filter, chosen before looking:** skip prints where the last funding rate
was already negative (crowded shorts). It helps, since those prints lose
(-1.59% a trade in the first half). The rest, entered at the next open and
held 24 hours, make +0.10% a trade in the first half (t 0.3) and +0.78% in the
second (t 2.2). As a small book (15% stop, 2% margin a trade, 2x, at most 5
open), `results/sleeve.txt`:

| Entry | 2024-02 to 2025-05 | 2025-06 to 2026-08 | Trades a month |
|---|---|---|---|
| Next bar's open | +1% a year | +41% a year | 82 to 118 |
| An hour later | -8% a year | +3% a year | 80 to 113 |

It works in one half only, and only if entered within the hour. With about
9.4% spread in outcomes per trade and trades bunching by day, a live paper
record needs roughly 2,800 trades to show +0.5% a trade at t 2. That is well
over a year at this signal's rate.

## The rotation on perpetuals

Cohorts exactly as the live paper log forms them (`scripts/coin-rotation.mjs`):
spot daily closes at the 23:00 UTC bar, the 100 most-traded coins by 30-day
median quote volume, 40-day relative moves. The universe is limited to coins
with a perpetual on the formation day. Formed 2024-02-10 to 2026-07-22
(`results/rotation-perp.txt`).

| Every laggard against every leader | 2024 | 2025 | 2026 (to July) | All |
|---|---|---|---|---|
| Spot, the paper log's way | +10%/yr | +22%/yr | +28%/yr | +19%/yr, t 1.5 |
| Perpetual price | +9%/yr | +18%/yr | +28%/yr | +17%/yr, t 1.3 |
| Perpetual with funding | +9%/yr | +16%/yr | +14%/yr | +13%/yr, t 1.0 |

The concentrated version a small account can hold (the 10 biggest laggards
against the 10 biggest leaders) comes to -12% a year with funding (t -0.5),
-51% a year in 2024.

Two things changed from the 2021-26 replay (+32% a year for 2024-26, t 1.96):

- The universe is perpetual-listed coins, delisted ones included.
- Funding costs about 4% a year, almost all of it on the short side. Coins
  that led the market carry negative funding (the shorts are already
  crowded), so shorting them pays 0.47% a round. Laggards' funding nets to
  about zero (-0.01% a round).

Treating delisted coins at their last close instead of dropping them barely
matters (+18% against +19% a year), so survivorship was not the big flattering
effect here. The universe was.

## What would change the answer

- **Finer bars.** Measure the funding-filtered short at the bot's real delay
  (5 to 15 minutes) on 1m or 5m perpetual candles, where hourly bars can only
  bracket it.
- **The rotation's live paper log.** It pushes when a horizon clears t >= 2
  over nine 40-day periods.
- **A confirmed engine call.** Any call that passes the publication gate
  trades as before.

## Honest limits

- Hourly bars: within a bar, the order of fill, stop and target is unknown.
  Ambiguous bars count against the trade.
- Slippage is a flat assumption per tier, not measured order-book depth.
- 2.6 years, split by date into two halves: two regimes, not many.
