# Capital rotation: does money move through size tiers or categories in a way we can predict, and what would make the model better and faster?

2026-10-02. Asked: "look into how capital/volume/open interest/momentum rotates
and affects asset price movement per category. for instance, btc and large caps
pump, cools, very low caps then pump, the mid caps? or could the rotation be
based on the type of asset/utility/function. also check for lessons learned so
far if anything can be improved to predict better and timely without breaking
anything or shooting up cost"

The day before, [the category study](research-2026-10-01-categories/CATEGORIES.md)
tested this question on prices only. This study adds what that one did not use:
size tiers set by what each coin traded at the time, traded value
(capital), perpetual open interest, the size of moves rather than their
direction, and hourly timing.

## Short answer

- **There is no rotation you can schedule.** Money does not move BTC → large
  caps → micro caps → mid caps, or in any other fixed order, in a way that
  repeats. This held for price, for traded value and for open interest; at
  1, 7 and 28 days; and in both 2021-23 and 2024-26. The "BTC and large caps
  pump, cool, then the small ones run" story produced 5 and 6 clean episodes
  in the two periods. In both periods micro caps did a little better than
  usual afterwards, but neither period comes close to significance.
- **The type of coin does not set the order either.** The category study
  covered price. Here, traded value and open interest moving into a category
  did not come before that category doing better.
- **One weak pattern held its sign in both periods.** When large-cap alts take
  a growing share of all traded value over four weeks, alts tend to lag BTC
  over the next four weeks. That is crowding, not rotation, and it is too weak
  to act on (t about -1.7 to -2.4, below the bar).
- **What does spread through a category is the size of moves, and it spreads
  within hours.** When a coin's category peers move hard in an hour, the coin
  tends to move more over the next 1 to 24 hours than its own volatility says
  (t 8 to 12 in both halves of 2024-26). It also drifts the same way as its
  peers by 1 to 3 basis points an hour, which is real and far smaller than the
  ~20 bp cost of a round trip, even at the most extreme peer hours.
- **Adding category features to the big-move watch made it no better.** Walked
  forward over 1,733 days, its daily top 10 moved 12% or more within two days
  28.6% of the time, against 28.7% with the category features (t 0.70). The
  watch's own volatility and volume features already carry it.
- **The biggest gain was timing, not a new model.** The big-move watch's phone
  digest arrived 9 to 10 hours after the daily close it ranks, because GitHub
  starts the job it waits on about 6 hours late. By then 30% of the moves it
  flags have already happened. The same picks alerted one hour after the close
  still had a fresh 12% move ahead in 53% of cases, against 44% at 10 hours.
  **Changed today:** the watch now goes out at about 00:30 UTC (section 9), at
  no new cost.
- **A bug in the watch's live record was also fixed.** A flagged coin that
  dropped out of the archive's universe right after being flagged was never
  scored. That was 6 of the first ~75 matured picks, and 3 of those 6 were
  real 12% moves.

## 1. Data and method

- **Coins:** 505 Binance spot USDT coins from 2019-03 to 2026-10-01. This is
  the category study's panel with volume, highs and lows added. Coins delisted
  in 2024-26 come from the hourly archive, so **2024 onward is close to
  survivorship-free**. Before 2024 the panel holds only coins still listed
  today. Stablecoins, pegged and wrapped coins, and Binance's tokenized stocks
  are excluded.
- **Open interest:** production D1 `derivatives_daily`, read only. 195 of
  these coins have Binance USDT perpetuals, 2023-01 to 2026-10. "New money"
  is the change in contracts, not in dollars, because dollar open interest
  just tracks price (r = 0.998, [OI_MEASUREMENT_EVIDENCE](OI_MEASUREMENT_EVIDENCE.md)).
- **Hourly:** Binance spot hours for 452 coins, 2024-01 to 2026-08.
- **Discipline, as in every FCS study:**
  - returns are measured against BTC or against the equal-weight market;
  - multi-day horizons use non-overlapping periods;
  - t statistics are Newey-West;
  - every result is judged in two periods, and anything chosen in the first
    period is checked in the second;
  - a Bonferroni bar is applied over each table;
  - 28-day results are re-run from four different block start dates.

## 2. Size tiers

At each close, alts are ranked by their 30-day median traded value on Binance,
using only data up to that day. The tiers are large (ranks 1-20), mid (21-60),
small (61-150) and micro (151 and up). BTC and ETH are their own legs.

| tier | coins (2026) | median market cap | smallest |
|---|---|---|---|
| large | 20 | $5.4B | $768M |
| mid | 40 | $614M | $10M |
| small | 87 | $72M | $6M |
| micro | 230 | $32M | $4M |

Traded-value rank and market-cap rank agree only moderately (Spearman 0.64
over 380 coins). Market caps before 2025 are not available point-in-time, so
traded value is the honest stand-in. "Micro" means the bottom of Binance;
coins that trade only on DEXes are not in the panel. The small and micro tiers
have enough members only from 2021 and 2022. The two periods are therefore
2021-23 (A) and 2024-26 (B).

In 2024-26, BTC returned +6.8 bp a day while every alt tier lost 16-29 bp a
day. Alts carried a beta to BTC of 1.1-1.3.

## 3. Price: does one tier lead another?

Leg i over the last k days predicts leg j over the next k days, with leg j's
own last k days held constant. There are 90 tests, absolute and relative to
BTC (`tiers_out.txt`).

- **Absolute:** nothing passes the bar (|t| ≥ 3.26). Nothing has the same sign
  at |t| ≥ 2 in both periods. "BTC today → alts tomorrow" was positive in A
  (t +1.2 to +1.3) and negative in B (t -2.5 to -3.0): it flips.
- **Relative to BTC:** two pairs pass the bar in A (mid → large, mid → micro at
  28 days), and both vanish in B (t -1.33, +0.08).
- **The order you asked about, relative to BTC (t in A / B):**

| lead → follow | next day | next week | next 4 weeks |
|---|---|---|---|
| large → micro | -0.62 / +1.53 | -0.45 / -1.96 | +3.11 / +1.72 |
| micro → mid | +1.23 / -0.08 | -1.03 / -0.38 | -2.26 / -0.03 |
| large → mid | +0.42 / +1.10 | -0.51 / -2.32 | -1.54 / +1.49 |
| small → micro | +2.15 / +1.71 | +1.63 / -0.50 | +1.68 / +1.07 |

"Large caps beat BTC for four weeks, then micro caps do" was the closest thing
to the story. It did not survive moving the block start date: in B it read
-0.94, -0.81, +0.35 and +1.33 across the four start dates, and +0.15 with
every day as an anchor (`tiers_robust_out.txt`).

## 4. The story itself: BTC and large caps pump, cool, then what?

A pump is a week in which BTC and the large caps rose more than one standard
deviation above their own trailing year. "Cooling" is the following week
being down. The outcome is each tier against BTC and the large caps over the
next four weeks.

| | events | micro | small | mid | ETH |
|---|---|---|---|---|---|
| A, pump then cool | 5 | +5.9% vs +1.8% usual (t +1.88) | +1.2 vs +1.8 | +0.6 vs -0.5 | -2.5 vs +3.0 |
| B, pump then cool | 6 | +0.5% vs -3.1% (t +0.86) | -7.8 vs -6.0 | -7.2 vs -6.5 | -2.2 vs +2.0 |

Micro caps did better than usual after the pattern in both periods. With 5
and 6 events, neither result comes close to significance. There is no mid-cap
leg after it. This is the one place where more history would decide it, and
it is logged here as unproven.

## 5. Capital: traded value moving between tiers

In 2024-26 the average share of all traded value was BTC 25.9%, ETH 16.3%,
large 33.0%, mid 11.6%, small 7.8% and micro 5.4%. A leg's share over the last
7 days, against its share over the prior 4 weeks, was tested against the next
7 days. Then a 4-week change was tested against the next 4 weeks.

- **7 days:** zero results at |t| ≥ 2 in either period, out of 36 tests.
- **4 weeks:** one pattern kept its sign. A rising **large-cap** share came
  before large caps lagging BTC (t -2.42 in A, -2.22 in B), before small caps
  lagging BTC (-2.35, -2.50), and before alts as a whole lagging BTC. With
  every day as an anchor it was -2.40 in A and -1.65 in B. Leaving out the
  2022 crash it was -1.53. It never reached the bar (3.39).
- A rising share of traded value in micro or mid caps came before nothing.

Read it as crowding: when the money is all in the large alts, that is closer
to a top than a start. It is not strong enough to act on.

## 6. Open interest: new perpetual money moving between tiers and categories

Tested on 2023-01 to 2024-11 against 2024-11 to 2026-09 (`oi_out.txt`).

- **Tier OI flow against BTC's, then the tier against BTC:** every |t| < 1.5,
  at 1, 7 and 28 days.
- **All-alt OI flow against BTC's, then alts against BTC:** 1 day +0.94 /
  +0.16, 7 days -1.44 / +0.56, 28 days -0.82 / +1.19.
- **Category OI flow, then the category** (10 categories with enough perps,
  second period only): t +0.60, +1.49, +0.44.
- **A coin's category peers opening contracts today, then the coin tomorrow:**
  +27.5 bp (t 2.08) in the first period, +3.1 bp (t 0.41) in the second.

This extends the settled result that open interest does not lead price
([DERIVATIVES_EVIDENCE](DERIVATIVES_EVIDENCE.md)) from single coins to whole
tiers and categories.

## 7. Does a hot category make a coin's big move more likely?

This is the big-move watch's own question: a move of 12% or more, either way,
within two days. The watch's 22 features were computed by importing
production's `big-move-watch.py`, on 526,726 coin-days. The base rate is 9.7%.
Category and tier peers were leave-one-out.

- **Per-day regressions, with all of the watch's features as controls:**
  - peers' volume surge: +0.9 points from the bottom to the top of the day
    (t 2.2) in 2021-23, and +0.6 (t 2.8) in 2024-26;
  - peers' size of move: +0.7 (t 1.8) and +0.4 (t 2.1);
  - size-tier peers: nothing.
  - The effects are real and small.
- **The decisive test: the watch's own LightGBM, walked forward** with
  monthly refits, 2022-01 to 2026-09 (`contagion_wf_out.txt`):

| model | top 10 that moved ≥ 12% in 2 days | lift over the base |
|---|---|---|
| the watch (production) | 28.6% | 3.22x |
| + all category features | 28.7% | 3.23x |
| + category volume and move size | 28.7% | 3.23x |
| every coin, same days | 8.9% | |

  The difference is +0.11 points a day (t 0.70), better in 7 of 10
  half-years. The category features are not added.
- **Direction:** peers say nothing about which way. Peers' 5-day move gave
  t +1.6 and +0.1.

## 8. Hourly: how fast does a category's move spread?

Each hour, within the cross-section, controlling for the coin's own move,
24-hour volatility and volume surge (`hourly_out.txt`, `hourly_tail_out.txt`):

| peers' move this hour → the coin's | next hour | hours 2-4 | hours 5-24 |
|---|---|---|---|
| size of move (t, 2024-25 / 2025-26) | +10.6 / +12.4 | +10.9 / +11.2 | +8.4 / +9.4 |
| direction (bp per hour, bottom to top of peers) | +2.2 / +1.5 | +2.2 / +1.3 | +2.6 / +3.2 |

Peer size spills over within hours, consistently, but it is small next to the
coin's own volatility (a slope of about 0.015 against 0.30). The direction
drift is real and tiny. At the most extreme peer hours (the top or bottom 1%,
with the coin itself still quiet), the coin's next 24 hours were +12 bp and
+7 bp, below the ~20 bp round trip and not significant in the second half. At
the daily scale the drift is gone: the category's day gave t -0.71 and +0.12
for the next day. Any category "sympathy" plays out inside a day, and too
weakly to pay.

## 9. Lateness: what the watch's delay cost, and the fix

**The delay.** The watch ranks at the 00:00 UTC close. It waited for Signals
Daily, and its digest went out between 08:45 and 09:42 UTC (2026-09-25 to
10-01). The schedules had been called reliable because every daily cron fires
once a day. Nobody had measured *when* they start:

| workflow | cron (UTC) | median start delay | last 7 runs |
|---|---|---|---|
| Signals Daily | 02:37 | +5.3 h | +6.3 h |
| signals-replay | 04:11 | +5.6 h | +6.3 h |
| signals-adaptive | 06:23 | +5.5 h | +6.4 h |
| signals-hierarchical | 06:47 | +5.4 h | +6.2 h |
| signals-tracked-research | 09:21 | +5.3 h | +6.6 h |
| daily-intelligence (site posts) | 07:00 | +5.2 h | +6.1 h |
| signals-retrospective | 04:20 | +5.0 h | +6.2 h |
| signals-discovery | 05:40 | +4.6 h | +5.7 h |
| the watch's evening run | 17:47 | +3.4 h | +3.8 h |
| signals-profit-growth | 22:40 | +2.9 h | +2.9 h |

Every daily job starts hours late, the morning ones most, and the delay has
grown over the last week (`schedule_delays_out.txt`, up to 30 runs each).

**What it cost** (`latency_out.txt`). The watch's own daily top 10, walked
forward with monthly refits over 2024-01 to 2026-08, gave 9,443 picks with a
full hourly path:

| hours after the close | picks already ±12% from the close | of the eventual ±12% touches, already done | a fresh ±12% from that hour's price still to come |
|---|---|---|---|
| +1 h | 1.1% | 2.1% | 53.3% |
| +4 h | 6.1% | 11.1% | 50.5% |
| +10 h (the old digest) | 16.4% | 29.9% | 43.7% |
| +24 h | 33.7% | 61.4% | 27.5% |

**Why not simply run Signals Daily earlier.** Binance's data portal publishes
the previous day's derivatives files at 06:50-07:50 UTC, and order-book depth
at 07:18-09:19. Signals Daily's late start happens to land just after them.
Moving it earlier would make the open-interest features a day staler. So only
the watch moves.

**The change** (`big-move-watch-io.mjs` `EARLY`, `worker.js`
`CADENCE_DISPATCHES`):

1. The Worker's cron fires on time, so it now dispatches the watch once a day
   at 00:20 UTC. It is the only daily job given a Worker lane.
2. The early pass reads the archive as before. It then adds the just-closed day
   **in memory only**, from the supplier the archive already uses for that coin
   (Binance or Yahoo; both are true UTC closes, final at 00:00). The fetched bar
   for the archive's newest day must match the stored close. CoinGecko coins
   (none of the first 101 picks) wait for the archive. Nothing is written to
   `asset_daily_bars`.
3. It ranks, records and pushes. **It scores nothing**: earlier picks are still
   judged on the archive alone, so the live record's method is unchanged.
4. If it reaches fewer than 80% of the coins it should, it refuses, and the run
   after Signals Daily issues the watch as before.
5. The first ranking of a close is its record. A rerun once left 11 rows under
   2026-09-23. Later runs now score and refresh, add no coins, and show the
   recorded list.

**The dry run on production data** (read only). The archive was cut back to
2026-09-30 and the clock set to 10-02 00:21:

- the 10-01 close was added for 263 of 263 eligible coins in 8 seconds;
- 249 match exactly what Signals Daily archived nine hours later;
- the other 14 were never archived for 10-01, because they left the archive's
  universe that morning;
- the early ranking named 9 of the 10 coins the 09:36 digest named (PHA in
  place of MEGA, which were near-tied for 10th).

**The scoring bug found on the way.** The archive writes only the coins in
that day's universe (313 on 10-02, down from 354 on 09-24). A pick whose coin
dropped out stayed unscored for good: 6 of the first ~75 matured picks. Those
picks are now scored from the coin's own supplier, matched on the flagged
day's close. The day's base rate still comes from the archive. The dry run
recovered all 6, and 3 were real 12% moves (NIL -14.9% twice, RHEA -47.6%), so
the record had been losing hits.

**Cost:**

- one more Actions run a day (public repo, free);
- about 263 free requests to Binance and Yahoo;
- one KV read per 5-minute Worker tick;
- no CoinGecko calls, no new D1 writes, and the same one push per close.

## 10. Lessons so far, and what would improve prediction and timing

**What three weeks of studies agree on:**

1. **Direction does not forecast**, at any level tested: single coins (every
   model family tried; 14,834 tests in the wide screen alone), categories, size tiers, traded value and
   open interest. Rotation stories are easy to see after the fact and do not
   repeat on a schedule.
2. **Size does forecast, and that is where the value is.** The big-move watch
   has a 3.2x lift walked forward and 36% vs 9.5% live (8 days, t 3.45);
   GARCH + weekday sizes the ranges; the hourly decoupling watch covers the
   largest coins.
3. **Speed beat sophistication.** The same model, nine hours sooner, keeps
   about a fifth more of its flagged moves actionable. More features (category,
   tier, flows) added nothing measurable.
4. **The costliest failures were plumbing, and each one was silent:**
   - D1's size ceiling killed Discovery for five days;
   - one CoinGecko seam voided 60 days of rows;
   - `secrets.` vs `vars.`;
   - jsdom hijacked `fetch`;
   - the keyless CoinGecko block;
   - and now: crons that fire every day, six hours late, and picks that fall
     out of the universe unscored.

   Each was found by checking *when* or *whether* something happened, not by
   a test that passed.
5. **Measurement traps keep recurring:**
   - pooled per-cast t statistics;
   - baselines taken from the wrong population;
   - survivorship;
   - and, new here, 28-day results that depend on which day the blocks start.

   Check start offsets before believing any monthly result.
6. **The cross-sectional lane now selects nothing.** The 10-02 nightly log
   reads `[xs] crypto 1d: ok=false selected=[]`. `oi_px_divergence`, selected
   on 09-12, has fallen back under the bar. The gate is doing its job; nothing
   is published from that lane until something clears it again.

**Recommended next, not done (each cheap and research-first):**

- **Widen the hourly size watch beyond the largest ~40 coins.** Section 8
  shows a coin's own volume surge and its peers' moves forecast next-hour size
  across all 452 coins, and half the missed moves were outside the top 100. The
  hourly bars are free from Binance; the cost to measure first is the extra
  hourly D1 writes.
- **Paper-log category catch-up next to coin rotation.** The 28-day catch-up
  toward a coin's own category (category study, t -4.2 in 2023-26) costs
  nothing to log, and the live log has no survivorship.
- **Re-test the pump-then-cool micro-cap effect** once 2026-27 adds episodes.
  It is the only rotation pattern that pointed the same way twice.
- **Watch the live record after the scoring fix.** Six recovered picks join
  the record at the next full run.

## Honest limits

- Before 2024 the panel holds only coins still listed today. That flatters
  micro caps in period A; period B is the one to weigh.
- Tiers are by Binance traded value, not market cap, and "micro" stops at what
  Binance lists.
- The pump-then-cool test has 5 and 6 events, so it cannot rule an effect in or
  out.
- Category tags are today's; a coin tagged "AI" now may not have been one in
  2021.
- The early pass ranks yesterday's universe without CoinGecko coins, so its
  list can differ from the archive-backed run at the edge (9 of 10 the same in
  the dry run).

## Reproduce

Scripts, outputs and the dry-run code are in
[research-2026-10-02-rotation/](research-2026-10-02-rotation/README.md).
