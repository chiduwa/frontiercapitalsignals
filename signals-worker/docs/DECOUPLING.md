# Coins pulling away from the market: HBAR on 2026-09-28, two years of the largest coins, and the watch that now runs hourly

Asked 2026-09-28: "now lets do a deep dive into the big crytos (top 20-30).
for instance, hbar just pumped when others are down. looking at this and
historically, were there any data/signs/ models/techniques that could have
predicted this but we missed? look at the other top assets too and when they
breakout or breakdown away from the entire market trend and lets find early
predictor per asset"

The short answer:

- **The size of a coming move away from the market is predictable; its
  direction is not.** Heavy volume, and a coin's own recent volatility, come
  before big moves in both directions: 3 to 4 times as often as usual, in
  both years of the study. Nothing tested reliably says which way.
- **HBAR showed the pattern before its run.** At the 08:00 UTC close its
  volume was 3.5x its norm and 2.2x the typical coin's surge, and it was 5.1%
  ahead of a falling market. HBAR was up 1.0% on the day then, and up 31.2%
  by 17:00.
- **We missed it because nothing watched for size, hourly, in the largest
  coins.** The scanner's two alerts that did fire on HBAR that morning call
  direction. They are silent until their live record earns it, and they
  haven't.
- **A watch for exactly this now runs every hour.** It is scored in public
  against every coin over the same hours and pushes only the side that held
  up in both study years.

All times are UTC. "Against the market" means net of the market: the coin's
return less beta times the equal-weight return of the other large coins.

## 1. HBAR on 2026-09-28

The news the press credited on the day was the listing of IDTrust, a
Hedera-based identity platform from The Hashgraph Group, in the IBM Cloud
Catalog. It was announced on 2026-09-23 and had been public for five days,
so it was not what moved HBAR that morning.

Each row is read at the close of an hour, as a live system would read it.
Volume and moves are Binance spot, computed by the production module. Open
interest is the perpetual's, in contracts, from our own 20-second sampler.
HBAR's day runs from 0.09586 at 00:00.

| Close | HBAR on the day | Volume, 8h vs its norm | HBAR vs market, 8h (in its sds) | Market, 8h | Open interest, 8h | What we had |
|---|---:|---:|---:|---:|---:|---|
| 01:00 | +0.5% | 1.3x | +2.8% (1.8) | +0.4% | +2.3% | |
| 02:00 | +0.6% | 1.5x | +3.2% (2.1) | -0.7% | +2.9% | |
| 03:00 | -1.0% | 1.7x | +1.7% (1.1) | -2.3% | +2.9% | |
| 04:00 | -0.7% | 1.9x | +2.5% (1.6) | -2.6% | +4.6% | scanner `accum_quiet`, logged, silent |
| 05:00 | +0.3% | 2.1x | +3.0% (2.0) | -1.7% | +5.1% | scanner `accum_quiet`, logged, silent |
| 06:00 | +1.5% | 2.5x | +5.1% (3.3) | -3.0% | +7.5% | |
| 07:00 | +1.8% | 2.9x | +5.8% (3.8) | -2.7% | +8.1% | scanner `moderate_liq`, logged, silent |
| **08:00** | **+1.0%** | **3.5x (2.2x the typical coin)** | **+5.1% (3.3)** | **-4.9%** | **+10.3%** | **the new rule's first hour** |
| 09:00 | +12.5% | 9.5x | +15.6% (9.6) | -3.9% | +24.0% | the hour just closed traded 51x its usual hourly volume |
| 17:00 | +31.2% | | | | | the other 37 large coins: -4.4% since 00:00 |

What was there, and why it didn't reach you:

1. **The live scanner fired three times and stayed quiet.** `accum_quiet` (at
   the 04:00 and 05:00 closes) and `moderate_liq` (07:00) call a coin *up*.
   Since 2026-09-24 such calls stay silent until their live record beats the
   same-window market in the direction they call (t of at least 2 over at
   least 30 casts and 10 days; see [MISSED_MOVES.md](MISSED_MOVES.md)), and
   neither has. That is the right gate for a direction claim. Section 3
   shows why: direction is where the evidence runs out.
2. **Nothing watched for size, hourly, in the largest coins.** The big-move
   watch ranks coins once a day, for 12%+ moves over two days. The scanner's
   volume patterns call direction. Neither is built to spot a large coin
   pulling away from the market within the hour.
3. **The study's combined model saw it building** (section 3; it is not in
   production). It ranked HBAR in the top 11% of all coin-hours at the 06:00
   close and the top 6% at 08:00.
4. **An open-interest version would have flagged it three hours earlier**,
   at the 05:00 close: volume at least 2x, open interest up at least 5% in
   contracts, at least 1.5 sds ahead. It needs open-interest history for
   every coin, and production keeps it only for the coins the host's sampler
   watches (13 of these 40 are outside it) and for 7 days. So the watch
   below uses no open interest, and quotes it as context when it has it.

## 2. The question, made testable

For the 40 largest coins with Binance perpetuals, hourly, from 2024-09-01 to
2026-09-27:

- **A breakout (or breakdown)** is when the next 24 hours' move against the
  market is at least 2.5 of the coin's own 24-hour standard deviations, and at
  least 5%, up (or down). It follows 2.4% of coin-hours.
- **The early signs** tested, all known at the close of the hour before:
  - the coin's move against the market over 1 to 72 hours, raw and in its
    own sds, and the market's own move;
  - volume against the coin's 30-day norm, raw and less the median coin's;
  - open interest in contracts, raw and less the median coin's;
  - taker buying, and the long/short ratios of top traders and all accounts;
  - the coin's own volatility over the last day against its last 30 days;
  - the drop or rise in its correlation with the market;
  - its distance from its 30-day high;
  - its three closest peers' moves.
- **The split:** everything was chosen on the first year (2024-09 to
  2025-08) and read once on the second (2025-09 to 2026-09). Inference is
  clustered by day, with a Benjamini-Hochberg correction across all 1,303
  per-coin tests.

The same study was rerun on Binance spot bars (the live scanner's own
source, 38 coins) for every rule that needs no open interest.

## 3. What comes before a big move away from the market

Across all coins, the top tenth of each sign against the usual rate of big
moves, up and down, in each year. "Next day" is the t-statistic of the mean
next-24-hour move against the market after that top tenth. Near zero, or
flipping sign between years, means no direction.

| Sign (top tenth) | Big up moves, 1st / 2nd year | Big down moves, 1st / 2nd year | Next day, t, 1st / 2nd year |
|---|---:|---:|---:|
| Its own volatility, last 24h | 3.0x / 3.6x | 4.1x / 3.6x | -0.8 / +1.5 |
| Volume, last 8h | 2.9x / 3.3x | 3.5x / 3.7x | -0.2 / +0.4 |
| Volume vs the median coin, last 8h | 2.6x / 3.2x | 3.0x / 3.1x | +0.1 / +1.0 |
| Move vs market, last 72h (in sds) | 2.7x / 3.6x | 3.5x / 3.2x | -2.0 / +2.1 |
| Move vs market, last 24h (in sds) | 2.6x / 3.4x | 3.6x / 2.9x | -2.5 / +2.1 |
| Open interest, last 8h | 1.9x / 2.0x | 2.6x / 2.5x | +1.4 / +0.9 |
| Near its 30-day high | 1.6x / 2.3x | 2.2x / 2.3x | -3.1 / +1.9 |
| Market move, last 8h | 1.8x / 1.4x | 1.6x / 1.2x | +1.4 / -0.3 |
| Peers' move, last 8h | 2.0x / 1.5x | 1.7x / 1.4x | +1.5 / 0.0 |
| Taker buying, last 8h | 0.9x / 0.9x | 0.9x / 0.8x | -0.8 / +0.4 |
| Top traders' long/short positions | 1.8x / 0.9x | 1.8x / 0.8x | +0.6 / -2.1 |

A gradient-boosted tree model on every sign at once (depth 3, fit on the
first year, scored on the second) separates the coin-hours that come before
a big move from the rest with an AUC of 0.73:

- **Top 1% of coin-hours:** 19.6% had a big move, 8.0x the 2.5% base, and
  caught 8% of all big moves.
- **Top 5%:** 12.6%, 5.1x, 26% of all big moves.
- **Top 10%:** 9.5%, 3.8x, 38% of all big moves.

Its most important inputs were the coin's own recent volatility, then 8-hour
volume. A second model, asked which way the big moves went, scored an AUC of
0.54. Seven in ten big moves were up, and the model barely beat always
guessing up.

Taker flow and long/short ratios, the usual "smart money" reads, carried
nothing that held up in both years.

## 4. Per coin

The signs that held in **both** years for each coin, after the multiple-test
correction, with how much more often a big move followed in the second year
than that coin's usual rate. "How predictable" is the combined model's AUC
on that coin in the second year (0.5 is a coin flip). Perpetual data, largest
coins first.

| Coin | How predictable its big moves are (AUC) | Before its breakouts | Before its breakdowns |
|---|---:|---|---|
| BTC | 0.89 | none held | none held |
| ETH | 0.74 | none held | heavy volume (24h) 2.8x |
| XRP | 0.63 | none held | none held |
| BNB | 0.81 | heavy volume (8h) 3.5x | near its 30-day high 5.0x, high volatility of its own (24h) 4.4x |
| SOL | 0.66 | none held | heavy volume (24h) 3.6x |
| TRX | 0.54 | none held | none held |
| DOGE | 0.82 | heavy volume vs other coins (24h) 2.7x | high volatility of its own (24h) 4.0x, strong gain vs market (72h) 3.5x |
| ADA | 0.81 | none held | high volatility of its own (24h) 4.4x, heavy volume (24h) 4.0x |
| HYPE | 0.71 | none held | none held |
| LINK | 0.69 | none held | none held |
| XLM | 0.71 | strong gain vs market (72h) 2.5x, open interest rising vs other coins (72h) 2.4x | strong gain vs market (72h) 4.8x, heavy volume (24h) 4.3x |
| HBAR | 0.64 | heavy volume vs other coins (24h) 3.3x, high volatility of its own (24h) 2.6x | near its 30-day high 5.3x |
| BCH | 0.58 | none held | none held |
| SUI | 0.78 | none held | none held |
| AVAX | 0.70 | none held | high volatility of its own (24h) 3.9x, open interest rising vs other coins (72h) 3.4x |
| LTC | 0.81 | none held | open interest rising vs other coins (72h) 4.9x, heavy volume (24h) 4.4x |
| TON | 0.68 | high volatility of its own (24h) 3.3x | none held |
| SHIB | 0.74 | none held | strong gain vs market (72h) 3.9x, high volatility of its own (24h) 3.6x |
| DOT | 0.75 | strong gain vs market (72h) 2.4x | none held |
| UNI | 0.74 | none held | none held |
| AAVE | 0.69 | strong gain vs market (72h) 2.5x, high volatility of its own (24h) 2.5x | none held |
| NEAR | 0.80 | heavy volume (24h) 2.4x | heavy volume (24h) 4.7x, heavy volume vs other coins (24h) 4.2x |
| ENA | 0.67 | heavy volume (24h) 2.0x | strong gain vs market (72h) 2.6x |
| ONDO | 0.79 | none held | heavy volume (24h) 5.5x, high volatility of its own (24h) 4.5x |
| APT | 0.69 | high volatility of its own (24h) 2.5x | near its 30-day high 3.5x, high volatility of its own (24h) 2.9x |
| ICP | 0.81 | none held | strong gain vs market (72h) 3.0x |
| ETC | 0.79 | none held | high volatility of its own (24h) 5.1x, heavy volume (24h) 4.8x |
| ARB | 0.75 | none held | none held |
| OP | 0.68 | none held | high volatility of its own (24h) 2.7x, heavy volume (24h) 2.6x |
| FIL | 0.71 | none held | heavy volume (24h) 4.2x, high volatility of its own (24h) 3.6x |
| ALGO | 0.73 | strong gain vs market (72h) 2.2x | strong gain vs market (72h) 3.7x, strong gain vs market (24h) 3.1x |
| TAO | 0.73 | high volatility of its own (24h) 2.5x, near its 30-day high 2.7x | heavy volume (24h) 4.0x, near its 30-day high 4.1x |
| WLD | 0.85 | high volatility of its own (24h) 3.8x, heavy volume vs other coins (24h) 3.9x | heavy volume (24h) 3.3x, heavy volume vs other coins (24h) 3.3x |
| PEPE | 0.62 | none held | none held |
| ATOM | 0.70 | high volatility of its own (24h) 2.3x | none held |
| FET | 0.78 | strong gain vs market (72h) 2.3x, high volatility of its own (24h) 2.5x | none held |
| INJ | 0.67 | none held | none held |
| SEI | 0.70 | near its 30-day high 2.8x | heavy volume vs other coins (24h) 3.6x, strong gain vs market (72h) 2.8x |
| VET | 0.68 | heavy volume (24h) 2.5x | high volatility of its own (24h) 3.3x |
| XMR | 0.81 | none held | heavy volume (24h) 3.9x, heavy volume (8h) 3.2x |

How to read it:

- **The per-coin signs are the pooled ones again.** Heavy volume and the
  coin's own volatility show up for coin after coin. Nothing
  coin-specific beat them, so the watch below uses one rule for all coins
  rather than 40 fitted ones (per-asset fitting mostly fits noise here:
  [MODEL_OVERFITTING.md](MODEL_OVERFITTING.md)).
- **A sign in the breakdown column is still a size sign.** After XLM's
  strongest 3-day runs ahead of the market, big down moves were 4.8x as
  common, but big up moves were 2.5x as common too.
- **"None held" is not "unpredictable".** BTC's big moves against the market
  are rare (0.14% of its hours in the second year), too few for any single
  sign to pass the correction, although the combined model ranks them well.
- **Direction results:** 172 per-coin results passed the screen as direction
  calls, across 29 coins. Nearly all describe the same thing: after a coin
  runs ahead of the market over 1 to 8 hours, its next day is a little
  weaker. That is the small give-back in section 5, not a call on the big
  moves.

## 5. After a coin pulls away

The top 5% of 8-hour moves against the market, then the next 24 hours, again
against the market:

| | Median | Mean | Share that kept going |
|---|---:|---:|---:|
| Breakouts, 1st / 2nd year | -0.57% / -0.37% | -0.08% / +0.10% | 40% / 42% |
| on volume at least 2x its norm | -0.95% / -0.68% | -0.12% / +0.19% | 39% / 40% |
| against a falling market (like HBAR) | -0.72% / -0.36% | -0.49% / +0.01% | 38% / 41% |
| Breakdowns, 1st / 2nd year | -0.11% / -0.05% | +0.08% / -0.03% | 48% / 49% (rebounded) |

The typical breakout gives a little back the next day while a minority keep
running hard, so the median is negative and the mean about zero. Breakdowns
are a coin flip. Neither is a trade after costs, and HBAR's day was one of
the minority.

## 6. The watch that now runs hourly

`scripts/decoupling-watch.mjs`, run by the hourly live scan
(`scripts/live-scan.mjs` via `scripts/decoupling-watch-io.mjs`), covers the
40 largest coins, less TON and XMR, which do not trade on Binance spot. At
the close of each hour a coin is a setup when, over the last 8 hours:

- its volume was at least **3x its own norm** (the 30 days ending a day
  earlier);
- that surge was at least **2x the median coin's** over the same 8 hours, so
  it is the coin's own and not a market-wide rush;
- it moved at least **2 of its own 8-hour sds** away from the market, up
  (pulling ahead) or down (falling behind).

The first hour a coin meets the rule is taken, then nothing for that coin for
24 hours, as the study took it. Each setup is logged before its outcome
exists (`decoupling_watch`, migration 0055) and scored 24 hours later against
the share of **all** the coins that moved that far over the same 24 hours.

Measured on spot, first year then second:

| | Setups per coin per month | Moved 5%+ further within a day | All coins, same hours | Times as likely | t (by day) |
|---|---:|---:|---:|---:|---:|
| Pulling ahead | 0.84 / 0.95 | 17.6% / 19.9% | 5.5% / 4.4% | 3.2x / 4.5x | 5.6 / 7.8 |
| Falling behind | 0.27 / 0.55 | 7.9% / 10.2% | 4.1% / 3.3% | 1.9x / 3.1x | 1.6 / 3.6 |

About two in three of those big moves were up on either side, the same as big
moves in general. After a coin pulls ahead, the typical next day is still
-1.2% / -0.7% against the market (median), with a mean of +0.5% / +0.6%. It
is a heads-up to watch a coin, not a trade.

Why it is built this way:

- **The same-hours comparison.** Scored against the flat 2.4%, the
  first version of the rule looked like 5 to 7 times the usual rate. But
  setups bunch into busy hours, when every coin is likelier to move.
  Against the same hours it was 2.1x / 2.7x.
- **The market-wide filter.** Among the rule's setups, those in hours when
  most coins were surging together did no better than every other coin in
  those hours: 8.6% / 10.2% against 6.4% / 8.2%, t 1.0 / 1.7. The filter
  drops them.
- **2x the median coin, not 2.5x.** The first year slightly favored 2.5x
  (t 5.6 against 5.4), and the second year could not tell them apart (4.5x
  and 4.3x, both t 8.0). 2x keeps more real setups, and HBAR's at 08:00 was
  one: 2.2x the typical coin. Every filter tried is in
  `research-2026-09-28-decoupling/results/setup_filters.out`.
- **Only coins pulling ahead reach your phone.** The falling-behind side
  failed the first year on its own (t 1.6), so it is logged, scored and shown
  on the dashboard, and never pushed.
- **No late announcements.** Each run replays the rule over the last 48
  hours with the 24-hour cooldown, seeded with what is already logged. A coin
  already mid-move when the watch starts, or after an outage, has its first
  hour inside that window, so it is not announced late. A setup from a
  skipped run (GitHub drops some) is caught up for two hours.
- **The push gate.** At most 4 pushes an hour. It notifies from the start,
  because the rule held in both years, and goes silent if the pushed side's
  live record trails the same-hours rate (t of -2 or worse by day, over at
  least 30 scored setups and 10 days).

Each push names the coin, its move against the market in the 8 hours to the
close, its volume against its own norm and the typical coin's, the market's
move, open interest where the host samples the coin, and the measured rates
above.

The dashboard's Watchlists view shows the last 72 hours of setups, after the
big-move watch. Each row shows what has happened since, alongside each
side's live record. The health check warns if the watch goes more than 3
hours without a run.

### What it would have said lately

Replayed with the production code on the live scanner's bars (`replay_live.mjs`):

- **2026-09-21 to 09-27:** 21 setups, of which 2 moved 5%+ further within a
  day (9.5%), against 4.0% of all coins over the same hours. The two were
  BCH (+15.4% against the market from the 13:00 close on 09-22) and ONDO
  (+10.8% from 13:00 on 09-24).
- **That is a weak week, and weeks vary a lot.** Over two years, in weeks
  with 5 or more setups, the median week reached 16% and 24% of weeks came in
  at 5% or less.
  Judge it over months, which is what the live record on the dashboard does.
- **Today's setups so far, against the market, to the 17:00 close:**
  - HBAR (seen 08:00): +29.6%.
  - ALGO (seen 09:00): +8.2%.
  - ONDO (seen 05:00): -12.2%. It pulled ahead, then fell away: a big move
    so far, the wrong way for anyone who read the setup as a buy.
  - SEI (seen 01:00): -2.8%.
  - LINK and XLM (both seen 13:00): +4.7% and +0.9%.

### Checks

- **Parity:** `parity.py` has the production module and the study compute
  the rule's inputs at 250 sampled coin-hours. They agree to 3.6e-12, and on
  every fire or no-fire.
- **Tests:** `test-decoupling-watch.mjs` covers:
  - UTC hour buckets on the 2026 daylight-saving dates;
  - no look-ahead;
  - the market-wide filter;
  - the cooldown chain: first hour only, never late, a streak taken again
    after 24 hours, a skipped run caught up;
  - scoring against the same hours;
  - the push gate, and the falling side never pushed;
  - the alert text;
  - the whole I/O loop without a network.
- **Dashboard and health:** `test-dashboard.mjs` renders the panel with and
  without data, and `test-health-check.mjs` covers its staleness warning.

## 7. Daylight saving

Asked mid-study: did the hourly open-interest bug have anything to do with
daylight saving?

- **It did not.** My research script gave each hourly bar the *next* hour's
  closing open interest, an off-by-one in how it bucketed the sampler's
  ticks. Every timestamp involved is UTC epoch milliseconds, which daylight
  saving never touches. It was fixed before any number here was computed.
  The raw ticks confirm the table in section 1: +10.3% in contracts from
  23:59:25 to 07:59:53.
- **The audit found one real exposure: the host's systemd timers.** Their
  `OnCalendar` schedules carried no timezone, so they followed the host's
  local clock. On a host set to a zone with daylight saving, every schedule
  would move an hour twice a year, and one inside the skipped or repeated
  hour would be skipped or run twice. One of those timers is the trading
  bot's.
  - Every schedule now ends in `UTC`.
  - `trading-bot/test.mjs` fails on any timer without it.
  - `trading-bot/deploy/update.sh` checks each staged schedule with
    `systemd-analyze calendar` before installing any unit.
- **The watch itself** buckets hours by integer division of UTC epoch
  milliseconds, and its tests pin that across the 2026 US and EU clock
  changes.

## 8. Limits

- **Direction is not predicted.** The watch says a big move is likelier than
  usual, not which way. Not financial advice.
- **Hit rates swing from week to week** (section 6). A quiet or poor week is
  normal. The gate acts on the record over at least 10 days and 30 setups,
  not on one bad day.
- **The universe is today's 40 largest coins**, picked with hindsight. The
  rates compare coins with each other over the same hours, which limits the
  damage, but a coin that shrank out of the top 40 is not in the study.
- **Open interest is context only**, and only for coins the host samples.
- **HYPE has less history:** its perpetual started on 2025-05-30, so its
  first year is about two months long and its numbers lean on the second.

Scripts, inputs and outputs:
[research-2026-09-28-decoupling/](research-2026-09-28-decoupling/README.md).
