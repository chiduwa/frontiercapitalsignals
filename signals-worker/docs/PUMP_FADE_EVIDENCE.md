# "Now reversing" and the pump fade (2026-10-05)

The owner asked for the futures bot to trade the "now reversing" post-move
alert, which looked very accurate to them. This doc records the test of that
alert, what the test found instead, and what was deployed: a **shadow**
ledger for the pump fade. No orders are placed.

Scripts and raw output: `docs/research-2026-10-05-now-reversing/`.

## What the alert is

`checkAndNotifySuddenMoves` in `scripts/notify.mjs` fires when a crypto asset
moves 10% or more over about 6 hours (dedup: once per coin, direction and UTC
day). The title says "now reversing" when the 1h, 3h, 6h and 1d changes
disagree in sign (`summarise().agreement === 'mixed'`, `price-change.mjs`).

That label covers two different situations:

- **The last hour (or 3 hours) turned against the move.** Example: AI was
  +21% over 6h and −1.8% over the last hour.
- **Only the 1-day change disagrees.** Example: MUBARAK was −10.8% over 6h,
  down on every short horizon, and +3.9% on the day. The move is itself
  reversing an earlier pump.

Both describe something that has already happened inside the window. That is
why the alert reads as accurate. It says nothing about the next move.

## Test

**Live alerts.** There were 111 "now reversing" alerts from 2026-08-29 to
2026-10-05. Of those, 78 were crypto with Binance 5-minute bars. Fading the
6h move won 53–56% of the time. The mean was about zero once the three best
trades are removed. The worst outcomes were −26% at 12h and −84% at 24h.

**Replay.** The alert rule was run on hourly Binance spot bars for the 258
coins with a USD-M perpetual, from 2024-07-01 to 2026-10-05. That gave
10,827 alerts, of which 2,302 were "now reversing". Costs were 0.15% per
round trip. t-stats are clustered by signal day, because pumps arrive in
bursts.

| "now reversing", all cases | mean | win | t |
|---|---|---|---|
| fade, 24h hold | −0.53% | 46% | −1.44 |
| fade, entered 1h late | −0.90% | 44% | −2.21 |
| fade, stop 8% / target 4% / 12h | −0.04% | 61% | 1.56 |
| follow, 24h hold | +0.23% | 53% | 0.82 |

**Verdict: "now reversing" has no tradable edge in either direction. Do not
build a trader on it.** One sub-case looks better: a dump that is still up on
the day, bought with an 8% stop and a 4% target over 12h. It made +0.72%,
t 2.81. That came from a search of about 80 cells, and it holds only on coins
listed before July 2024 (t 3.35; new listings t 0.47). It is a candidate, not
a result.

## The pump fade

The same replay found something else. The ordinary pump alert falls back
afterwards. That alert is a coin up 10% or more over 6h with every horizon
agreeing, so not a "now reversing" one.

| short the aligned pump (n = 5,377, 775 days) | mean | win | t |
|---|---|---|---|
| 24h hold, no stop | +0.38% | 62% | 4.66 |
| 24h hold, 15% stop (20% of trades stopped) | +0.25% | — | 4.25 |
| entered 1h late, no stop | +0.22% | 60% | 3.71 |
| first half / second half (24h) | +0.13% / +0.62% | | |
| older coins / new listings | +0.29% / +0.59% | | 3.90 / 2.73 |

The size of the stop matters little for the mean: 10% +0.27%, 15% +0.25%,
20% +0.22%, 30% +0.32%. At 8x leverage, liquidation is about 12% adverse, so
a 15% stop needs 5x or lower.

What the replay does **not** include:

- **Funding.** Shorts on pumped coins often pay it.
- **Perp vs spot price differences.**
- **Market impact.**
- **Delisted coins.** The universe is today's perps. A pumped coin that later
  delisted would mostly have helped a short, so this cuts against the result,
  but it is still a bias.

The per-trade edge is small next to its spread. On $25 notional, +0.25% is
6 cents a trade.

## What is deployed

`trading-bot/src/pump-fade.mjs` runs hourly on the Oracle host
(`fcs-pump-fade.timer`, :01:30 UTC). It writes to D1 `pump_fade_shadow`
(migration 0061):

- **Detection.** Same rule as the alert, including its dedup: the day's first
  10% hour decides. A coin whose first qualifying hour was "now reversing" is
  skipped for the day. Entry is at the perp's mark price. A missed run
  records one bar late; anything later is skipped. Cross-checked against the
  Python replay on 43 coins: 1,139 identical signals, 0 extra, and 5 missed.
  All 5 were the day after a new listing, where an earlier hour lacked a full
  day of history.
- **Settlement.** After 24h it scores the trade on 5-minute perp bars. The
  15% stop fills at the bar's open when price gaps through it, and the entry
  bar counts in full. It adds the funding actually charged while the trade
  was open, and 0.15% costs.
- **No orders.** The file has no order code. `PUMP_FADE_MODE` accepts only
  `shadow` and `off`.

## Promotion

Live trading is a separate change, decided on the ledger's forward record.
The owner's plan is shadow first, then live at floor size after a few weeks.
At about 6.5 signals a day, a few weeks gives roughly 150 trades. That can
show whether funding erases the edge. It cannot prove an edge of +0.25% on
its own. At the replay's day-clustered spread (t 4.25 over 775 days), t 2
needs about 170 signal days, roughly six months, and three weeks would read
about t 0.7 even if the edge is real. Read it as "is the live record
consistent with the replay, after funding", not as a fresh proof.
