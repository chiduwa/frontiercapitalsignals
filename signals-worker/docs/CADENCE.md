# Rhythm and cadence: is there a pattern in how each asset moves that a swing trader can use?

Asked 2026-09-28: "look for some sort of rhythm or cadance in the way each
assets moves, on regular days, during pumps, breakdown, etc. if any seem to
have a cadance, we can use that to swing trade"

The short answer:

- **No asset has a reliable rhythm in which way it moves.**
  - 13,068 tests on 38 coins (hourly) and 398 coins, stocks and SPY (daily).
  - 19 passed the false-discovery bar in the first period, and none of them
    repeated in the second: about what chance alone would give.
- **No class has one either, once you allow for assets moving together.**
  Crypto trends, stock short-term reversal and crypto dead-cat bounces all
  looked class-wide at first. Each turned out to be a few market-wide moves
  counted once per asset.
- **One real pattern: coins mean-revert against the rest of the market.**
  It holds over 2 days and over 40-60 days. On the coins you would actually
  trade (the 100 most traded on Binance), the 2-day rotation never paid
  after costs. The 40-day rotation made about +34% a year in 2021-23 and
  +32% in 2024-26 on replay, net of costs (section 7). That replay only sees
  coins still listed today, which flatters holding laggards, so the rotation
  is now logged live on paper to get a record without that bias.
- **The rhythm in move size is real and steady.** This is where the swings
  you see come from:
  - moves are a third bigger at 14:00-15:00 UTC than in a typical hour;
  - weekend moves are about a fifth smaller;
  - a swing's length is set by its size relative to volatility. A 1-sd
    swing lasts about 31 hours in the big coins and 4 days on daily bars,
    which is exactly what a random walk of that volatility produces.
- **No rhythm here is worth trading.** Section 9 covers what is usable
  (timing entries and stops by the size rhythm) and what isn't (swing age,
  pullback depth, Fibonacci levels, pump and breakdown timing). The 40-day
  rotation is the one candidate, under live observation.

## 1. How rhythm was tested

A random walk draws convincing swings, cycles and pump shapes: the eye finds
cadence in noise. So each asset was compared with **200 copies of itself**:

- the same returns, with their signs randomized;
- a copy keeps everything about the size of moves: fat tails, calm and wild
  spells, quiet weekends, the busy US open;
- it removes everything about direction.

A rhythm counts only where the real asset beats its own copies, measured as
a z-score against them.

**Data:**
- hourly Binance spot closes for the 38 largest coins, 2024-09 to 2026-09;
- daily closes for 286 US stocks and SPY (production's research panel,
  2021-01 to 2026-09);
- daily Binance spot candles for 124 coins (2021-01 or listing, to 2026-09);
  the archive's own daily crypto closes were not usable (section 8).

**Split:** every result is read in two separate periods.
- Hourly: 2024-09 to 2025-08, then 2025-09 to 2026-09.
- Daily: 2021-01 to 2023-12, then 2024-01 to 2026-09.

A pattern counts only if it holds in both, in the same direction.

**Tests, per asset:**
- **Serial:** does the last move predict the next one, over 1 hour to 7
  days (hourly) or 1 to 60 days (daily)? Measured as the gross profit of
  following it.
- **Cycles:** the strongest repeating period in the returns, and whether
  the same period is still there in the second period.
- **Swings:** a zigzag at three sizes (0.5, 1 and 2 sd of a day for hourly
  data; 1, 2 and 4 sd for daily), read in real time with no hindsight:
  - does a swing in progress keep going?
  - do old swings turn more than young ones? (a cadence)
  - does buying a deep pullback within a swing pay?
  - from completed swings: are their lengths regular, do long and short
    swings alternate, and do retracements cluster at 0.382, 0.5 and 0.618?
- **Calendar:** hour of day, day of week, the turn of the month and the
  monthly options-expiry week.
- **Pumps and breakdowns:** a move of 3 or more of the asset's own sds in a
  day (section 5).

**Checks:** `test_cadence.py` confirms the method:
- on random walks with fat tails and volatility bursts it finds no rhythm
  (|z| above 2 in 2.6% of tests);
- it finds each planted effect: a 1-hour reversal, a 4-day cycle, an
  hour-of-day drift, a turn-of-month drift and a post-pump drift;
- its swings read nothing from the future.

## 2. Per asset: nothing beyond chance

| | Tests | Pass the first period's false-discovery bar | Repeat in the second |
|---|---:|---:|---:|
| All assets, all tests | 13,068 | 19 | **0** (chance: about 1) |

Some groups of tests do show more z-scores beyond 2 than chance in one
period. The hourly swing tests are the clearest: in the first period, 19% of
the swing-momentum tests (coins times swing sizes) passed z 2, against the
4.6% chance gives, mostly swings continuing. None of it repeats. Of the dominant cycles:
- 5 of the 38 coins kept the first period's cycle into the second (about 1
  expected by chance);
- four of them are 3-4 hour oscillations (ARB, SEI, SHIB, DOGE) and one runs
  15-16 hours (XLM), and none is strong enough to stand out in either period.

## 3. Class-wide: the trap, and the answer

Coins rise and fall together, and so, less tightly, do stocks. Adding up
per-asset z-scores as if assets were independent turns one market-wide swing
into a hundred "effects".

The valid test gives every asset in a class the same sign flip at the same
moment. That keeps their co-movement in the copies while still removing
direction. The check confirms it: with no rhythm the class z behaves like
noise, and it still finds a small planted class-wide reversal (z -3.2 to
-4.1).

| Pattern | Naive pooling, z (1st / 2nd) | Proper class test, z (1st / 2nd) |
|---|---:|---:|
| stocks: 3-day reversal | -7.2 / -5.3 | -1.2 / -1.1 |
| stocks: 20-day reversal | -9.3 / -3.3 | -1.4 / -0.2 |
| coins: 20-day momentum | +8.7 / +4.2 | +1.7 / +0.7 |
| coins, hourly: buying deep pullbacks in 2-sd swings | +3.8 / +3.7 | +1.2 / +1.1 |
| coins: selling the first bounce after a breakdown (5 days) | -6.2 / -5.7 | -1.4 / -1.9 |

With co-movement accounted for, nothing about direction holds in both
periods, for any class. The same goes for each class's equal-weight index
(the market's own rhythm), and for the calendar:

- **Turn of the month, crypto index:** +0.74% extra per turn-of-month day in
  2021-23 (z +2.3), then -0.36% in 2024-26 (z -1.0).
- **Options-expiry week, SPY:** -0.23% per day in 2021-23 (z -2.1), then
  nothing (z -0.4).
- **Hour of day and weekday:** no direction effect on any index.

Some rhythms did hold for a year or three and then stopped:
- **Hourly crypto, 2024-25:** short swings continued (z +2.6), and
  breakdowns bounced: +5.9% in the next 24 hours, against +0.2% by chance
  (z +3.2). The week's low came within 4 hours of the signal 42% of the
  time, against 12%. In 2025-26 neither held (the bounce was +0.1%).
- **Daily coins, 2021-23:** the largest (4-sd) swings kept going (z +2.1),
  and a pump's own day was the top of the next 20 days more often than
  chance (28% against 17%, z +2.3). Neither held in 2024-26.
- **Coins, 10-20 day trends:** they never cleared the bar (z +1.7 in
  2021-23, +0.6 to +0.7 since), and the backtest in section 7 finds no
  edge in either period.

A rhythm that belongs to one stretch of market history is not one you can
trade in the next.

## 4. Relative to the market: coins mean-revert

Subtracting the rest of the class from each asset (its move against the
market) removes the biggest thing assets share. It is the question for a
swing trader choosing *which* coin to hold. Same shared-sign test:

| Coins, against the rest of the market: gross profit of fading the move | 2021-23 | 2024-26 |
|---|---:|---:|
| the last 2 days, per 2-day trade | +13.4 bps (z -4.5) | +4.8 bps (z -2.0) |
| the last 40 days, per 40-day trade | +1.22% (z -3.5) | +0.38% (z -2.0) |
| the last 60 days, per 60-day trade | +1.06% (z -2.5) | +0.64% (z -2.3) |

(The z-scores compare with chance, which at long horizons is not zero: some
coins drift against the market for months, and that drift works against
fading. So the edge over chance is larger than the profit shown.)

A coin that ran ahead of the market tends to give some of it back, over days
and over two months. The hourly version is the same but tiny: under 1 bp an
hour. Stocks show nothing against their market (no z beyond 2).

It is weaker in the recent period. Section 7 shows it does not clear costs at
the short horizon, and does at 40 days.

## 5. Pumps and breakdowns

An episode starts when an asset moves 3 or more of its own daily sds (over
24 hours for hourly data, in one session for daily), at most one per asset
per 72 hours or 10 sessions. The same rule runs on the real data and on the
copies. From the close that shows the episode, the earliest a trader could
act:

- **What happens next** (4 hours to 7 days hourly, 1 to 20 days daily):
  nothing holds in both periods, for any class.
- **When the pump's high (or breakdown's low) comes:** for coins, nothing
  holds. For stocks, after a 3-sd down day the lowest close of the next 20
  sessions comes 3-4 sessions later more often than chance (11.2% and 13.5%
  of breakdowns, against 8.4% and 8.6%). The returns after do not differ
  from chance, so it cannot be traded on its own.
- **Second legs, and buying the first pullback or selling the first bounce:**
  nothing holds with co-movement accounted for.

## 6. The rhythm that is real: size

The sign-randomized copies keep this part exactly, because it is real and
steady.

**Size of moves by hour of day, 38 largest coins (1.00 = a typical hour, UTC):**

| 00 | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 | 09 | 10 | 11 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1.05 | 1.08 | 0.98 | 0.91 | 0.88 | 0.91 | 0.91 | 0.88 | 0.96 | 0.89 | **0.83** | 0.86 |

| 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.98 | 1.19 | **1.34** | **1.33** | 1.17 | 1.12 | 0.99 | 0.98 | 0.97 | 0.96 | 0.99 | **0.84** |

- **The busiest hour** is 14:00 or 15:00 UTC (the US open) for 36 of the 38
  coins. For each coin it is about 1.65 times the quietest hour.
- **The profile is steady:** it matches between the two periods (median
  correlation 0.81, lowest 0.64).
- **Weekend moves are smaller:** median 0.81 of a weekday's, 0.59 to 0.85
  across coins.

**How long swings last** (median, both periods):

| Swing size | Largest coins, hourly | Coins, daily | Stocks, daily |
|---|---:|---:|---:|
| 0.5 sd of a day | 11 hours | | |
| 1 sd | 31 hours | 4 days | 4 days |
| 2 sd | 95 hours | 8 days | 8 days |
| 4 sd | | 22 days | 20 days |

These are near-identical across assets because they follow volatility. A
random walk of the same volatility draws swings of the same lengths:
- the real swings are a little more regular than the copies (for 1-sd swings
  in the big coins, the spread of lengths is 0.87 and 0.92 of the copies');
- but neither a swing's age nor its pullback depth predicts the next move.

Knowing a swing "usually lasts about 31 hours" does not tell you this one is
about to turn.

## 7. What the tempting rules would have made

Net of costs, against buy-and-hold and against the same rule on the
shared-sign copies. Costs are round trip: 5 bps for stocks, 20 bps for crypto
spot, 10 bps for perps.

| Rule | 2021-23 | 2024-26 | Timing edge vs chance, 2024-26 |
|---|---|---|---|
| Stocks: hold those down over 3 days, 3 days | +13.4%/yr (buy-and-hold +11.2%) | +20.9%/yr (buy-and-hold +23.8%) | none (z +0.2) |
| Coins: hold those up over 20 days, 20 days | +48.4%/yr (buy-and-hold +53.9%) | -26.6%/yr (buy-and-hold -20.3%) | worse (z -1.1) |
| Coins, hourly: buy deep pullbacks in rising 2-sd swings, 72 h | -0.74% per trade (random entry -0.13%) | -0.45% (random entry -0.69%) | none (z +0.8) |
| Coins: rotation, 2 days, long laggards / short leaders (perps) | **+34.7%/yr** (z +4.2) | -9.1%/yr | gone (z +0.4) |
| Coins: rotation, 40 days (perps) | +15.2%/yr (z +3.3) | +1.6%/yr | not significant (z +1.5) |
| Coins: hold the 40-day laggards, spot | 7 pts a year behind buy-and-hold | 2 pts a year ahead | z +0.2, then +2.1 |
| Coins: short the first bounce after a breakdown, 5 days (perps) | +3.8% per short | +3.1% per short | z +1.6, then +2.1 |

**The rotation** (section 4) on the study's coins (the research panel's 124)
was a real edge in 2021-23 that shrank. On the coins the engine would trade,
the 100 most traded on Binance each day, it looks different. A fresh round
forms each day, and each is scored net of 0.2% (10 bps round trip on each
leg):

| The 100 most-traded Binance coins | 2021-23 | 2024-26 |
|---|---|---|
| 2-day: long laggards, short leaders | -0.08% a round, -14% a year (t -1.0) | -0.16% a round, -30% a year (t -2.5) |
| 40-day: long laggards, short leaders | **+3.7% a round, +34% a year (t 2.9)** | **+3.5% a round, +32% a year (t 2.0)** |
| 40-day: laggards only, against the market (spot) | +1.4% a round, +13% a year (t 2.7) | +1.3% a round, +12% a year (t 1.7) |

By calendar year the 40-day rotation made money in 5 of 6: 2021 +81%, 2022
+35%, 2023 -8%, 2024 +47%, 2025 +23%, 2026 so far +20%. (A one-day move
beyond 100x is a ticker event, not a return, and drops the coin from that
round. LUNA's relaunch as a new token printed +177,000%; SUN and QUICK were
redenominated 1,000 to 1. The rule also drops LUNA's real 2022 collapse from
the few rounds that held it: the conservative side.)

The big caveat is **survivorship**. The replay can only see coins listed on
Binance today. Coins that died and were delisted were often long-running
laggards, exactly what this rule buys. So the replay flatters the rotation by
an unknown amount. That is why it is now logged live, where no such bias
exists (section 9).

**The dead-cat short** looks consistent, but it is a bet on crash cascades:

| | 2021-23 | 2024-26 |
|---|---|---|
| shorts, in distinct weeks | 938, in 74 weeks | 834, in 84 weeks |
| share of profit from the 5 best weeks | 90% | 92% |
| per short, without those 5 weeks | +0.55% | +0.37% |
| t-statistic, counting by week | 0.7 | 1.3 |

The five best weeks include the FTX collapse (2022-11), the May 2021 crash
and the October 10, 2025 crash. The trade pays when a crash's first bounce
fails and the market falls again. That happened a few times; it is not a
cadence.

## 8. Found and fixed along the way

- **The archive's daily crypto closes were unreliable for this** (now
  audited and fixed: [ARCHIVE_AUDIT.md](ARCHIVE_AUDIT.md)).
  - Tickers were used by different tokens in different years: JUP and SKY
    in 2021 were other coins.
  - One ticker carries two tokens: FLUID alternates between about 0.75 and
    1.43.
  - Micro-priced coins are rounded to 6 decimals: SHIB steps from 1e-6 to
    2e-6, a +69% "day".
  - Each prints a spike that reverts the next day, which looks exactly like
    a reversal and made equal-weight crypto buy-and-hold show +719% a year.
  - The study switched to Binance candles (one token per pair, full
    precision). SUN is left out: its pair jumped about 840x in a day when
    the token was swapped 1,000 to 1.
  - Production's archive has since been cleaned: see ARCHIVE_AUDIT.md.
- **A flaw in the first class-wide test.** It flipped each asset's move
  size rather than its signed move, which made every copied asset move the
  same way at the same time. The chance baseline came out too wide, so the
  test was too cautious. It was fixed, pinned by a test, and everything in
  sections 3-5 comes from the fixed version. (The per-asset results were
  unaffected: with independent flips the two forms are the same.)
- **JPYC**, a yen-pegged coin, slipped past the pegged filter and produced
  the only per-asset "repeat" on the first pass. It is excluded.

## 9. What this means for swing trading

- **Don't time entries or exits by a swing's age, its pullback depth,
  Fibonacci levels, or where a pump or breakdown "usually" turns.** None of
  it beats a random walk of the same volatility.
- **Do use the size rhythm, which is real and steady:**
  - expect the biggest moves at 14:00-16:00 UTC and the quietest around
    10:00 and 23:00 UTC;
  - expect weekend moves about a fifth smaller;
  - size positions and set stops by volatility: a 1-sd swing takes about
    a day and a half in the big coins, a 2-sd swing about four days.
- **Coin rotation, on paper.** Since 2026-09-29 the hourly live scan logs a
  2-day and a 40-day round each UTC day over the 100 most-traded Binance
  coins, and scores each when its days are up (`scripts/coin-rotation.mjs`,
  panel in the Research view). A phone alert goes out only if a horizon clears
  its costs on its live record: t of 2 or more over 4 months of 2-day rounds,
  or a year of 40-day ones. Nothing is traded.
- **For "something is about to move",** the size signals already built do
  better than any cadence found here: the big-move watch
  ([MISSED_MOVES.md](MISSED_MOVES.md)) and the pulling-away-from-the-market
  watch ([DECOUPLING.md](DECOUPLING.md)).

The study itself changed no production code. The paper rotation (above) and
the archive audit (ARCHIVE_AUDIT.md) followed from it. Scripts, inputs and
outputs: [research-2026-09-28-cadence/](research-2026-09-28-cadence/README.md).

## Also decided on 2026-09-28: class averages

An asset's own estimate is pulled toward its class average only where the
class shows a clear pattern *and* a walk-forward test shows the pooled
version is better for the model. The pending composite-record shrink did not
meet that bar and stays off. Details:
[MODEL_OVERFITTING.md](MODEL_OVERFITTING.md), section 6.
