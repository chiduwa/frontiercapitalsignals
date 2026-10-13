# Binance low caps, 2026-10-13: what came before the spikes, and today's ranking

Asked 2026-10-13: investigate the very low market-cap coins on Binance global
that can be bought; look for utility, team, social presence and sentiment, and
anything else that came before similar coins exploded; rank them by how likely
they are to spike over the next few months (possibly as part of the signals
page); and find a way to forecast the inflows that move them, testing which
variables per asset or per category work.

The short answer:

- **Low caps on Binance spike often, and give the spike back.** Since 2019
  there were 361 runs of 3x or more within 60 days from a bottom-40% market
  cap, across 218 coins (46 in 2026 so far). The median run was 4.4x in 50
  days. Ninety days after the peak the median coin was 57% below it, and only
  8% held their gains.
- **The pond itself loses money.** Buying every bottom-40% coin and holding
  90 days lost 6.8% per trade after costs from Nov 2021 to Jul 2026, and
  13.1% per trade since 2024. Binance delisted 40, 51 and 50 USDT pairs in
  2024, 2025 and 2026 so far; 4.5% of low caps were delisted within 90 days,
  and 7.5% of the bottom 20%.
- **Smaller is not better.** Inside the low-cap set, size does not change the
  odds that a coin's close doubles within 90 days (t = -1.2). The bottom 20%
  doubles as often as the bottom 40% (19.7% vs 19.1%), is delisted more, and
  the model cannot rank it at all.
- **Inflows can be forecast. Their direction mostly cannot.** Whether a coin's
  30-day volume triples is predictable out of sample (AUC 0.67, t = 15): a
  volume surge already under way, a thin book and high price impact per
  dollar all lead it. Whether the price follows is a much weaker relation.
- **Which coin doubles is only slightly predictable.** The best walk-forward
  model put 15.8% of its top 10 at a doubled close within 90 days against an
  11.0% base (t = 3.2), and beat the base in every year. With a take-profit at
  +100% its picks made +4.9% per trade net (t = 0.7), +7.0% more than the
  low-cap pond (t = 2.6), but only +0.6% since 2024.
- **The model's probability levels are wrong; only its order is useful.**
  Picks it rated 42% likely to double did so 11% of the time. The levels came
  from market-regime inputs that worked in 2020-21 and failed after. The
  rankings below are ranks, not probabilities.
- **Catalysts pay on the day and cost afterwards.** An Upbit KRW listing
  lifted low caps a median +52% on the day (market-adjusted) and they were
  -30% thirty days later. A Binance perpetual launch comes after a +23%
  run-up, not before it. A Binance monitoring tag was followed by -36% over 90
  days, the strongest warning in the data.
- **Team, development and social did not separate winners.** GitHub activity
  (Santiment, 2019-26) predicted nothing. Social volume (one year only) leaned
  the wrong way: the most-discussed coins doubled less often. Category
  mattered only for memes since mid-2025 (one year, one regime), fan tokens
  (worse) and coins already on Upbit KRW (fewer spikes, the catalyst is spent).
- **A small buy moves a low cap; it does not keep it moved.** Lifting the
  median low cap +20% takes $76k of market buying today (0.45% of its market
  cap), but the same coin trades about $766k a day on Binance, 11x that wall.
  That is why intraday 2x touches (27%) are far more common than 2x closes
  (19%).

Recommendation: treat the ranking as a watchlist with a mechanical exit, not a
forecast of who will moon. Size each position as a lottery ticket, sell into
strength (the +50% and +100% take-profits both beat holding), and avoid the
monitoring-tag, Upbit-warning and fan-token names entirely. On the signals
page only the validated parts are public: the inflow watch and the avoid
list; the spike ranking is logged privately until its live record earns a
place (section 10).

Scripts, inputs and every result:
[`research-2026-10-13-lowcap/`](research-2026-10-13-lowcap/README.md). Raw
data (prices, market caps, events, order books) is in the gitignored
`signals-worker/reports/lowcap/raw/`.

## 1. Data

All keyless except CoinGecko (Demo key, ~330 calls) and Santiment (free tier).

| Source | What | Coverage |
|---|---|---|
| Binance `data-api.binance.vision` + `data.binance.vision` archive | daily OHLCV, quote volume, taker-buy volume, trade count | 584 USDT pairs: 392 live, **192 delisted**, 2017-07 to 2026-10-13 |
| CMC data-api `cryptocurrency/historical` | daily market cap, circulating supply | 558 coins from 2018-06; live pairs mapped by CMC's own Binance pair table; 166 of 180 delisted pairs mapped by price match |
| Binance CMS announcements | listings, delistings, monitoring tags, perp launches, Earn/Margin/Convert adds | 10,355 posts, 2017-2026 |
| Upbit notices + market list | KRW listings (134 since 2022-03), caution/warning flags | |
| `data.binance.vision` futures archive | first day of each USD-M perpetual | 473 pairs |
| Santiment free API | dev activity (full history), social volume (2025-10-14 to 2026-09-12 only) | 482 projects |
| Binance product feed, CMC detail, CoinGecko | today's tags, watchers, holders, top-10 wallet share, CertiK score, total supply, VC/market-maker portfolio tags | live coins only |
| Spot order book (5,000 levels) | dollars needed to lift the price +10/20/50% | 399 of 401 live pairs, 2026-10-13 |

Binance's own circulating-supply field is stale for about a third of coins
(older pairs too low, many new listings near total supply), so all market caps
are CMC's. The 1000x pairs (1000SATS, 1000CAT, 1000CHEEMS, 1MBABYDOGE) are
scaled before the price match.

Tags are today's labels, so narratives coined later ("ai-agents") are a mild
look-ahead in the category tests; nothing positive came out of them anyway.

## 2. Method

- **Anchors:** every 14 days, 2019-01-01 to the last date with a complete
  90-day window. A coin enters if it traded that day, is at least 120 days
  old, has a CMC market cap and fewer than 10 dead days in the last 30.
- **Low cap** = bottom 40% of that day's Binance market caps (median $15-88M
  depending on the year; $15M in 2026). The bottom 20% was rerun as a check.
  18,542 coin-dates, 376 coins, 152 of them later delisted.
- **No survivorship:** delisted pairs stay in, and a coin delisted inside the
  window exits at its last Binance close. A series is split at reused tickers
  and redenominations (30-day gaps or 10x one-day jumps).
- **Outcomes:** `y2c` the daily close reaches 2x within 90 days (sellable);
  `y2h` the intraday high does (includes wicks); `y50` the close reaches +50%
  within 30 days; `ret90`; `tp2` sell at the first close at 2x, else hold 90
  days; `inflow3x` the next 30 days' average volume is 3x the trailing 90.
- **Tests:** per anchor, top-minus-bottom quintile of each feature (ranked
  within that day's low caps); mean over anchors with Newey-West t (lag 7,
  because 90-day windows overlap about 6.4 anchors); both halves; Holm across
  every feature x outcome cell. Yes/no flags: flag minus non-flag per anchor.
- **Models:** walk-forward from Nov 2021 (the first anchor with 2,000 closed
  training rows) to Jul 2026, 123 test anchors; each fitted only on anchors
  whose window had closed 91 days earlier. Rank-percentile features, L2
  logistic and a shallow gradient-boosted classifier.
- **Costs:** 0.6% round trip per trade in the basket tests.

## 3. Base rates

| Year | Share of low caps whose close doubled within 90d | Median 90d return |
|---|---|---|
| 2019 | 16.8% | -14% |
| 2020 | 46.3% | +49% |
| 2021 | 33.6% | -15% |
| 2022 | 9.6% | -15% |
| 2023 | 13.3% | +2% |
| 2024 | 16.1% | -11% |
| 2025 | 5.6% | -32% |
| 2026 | 9.0% | -19% |

Average over all anchors: 19.1% doubled on the close, 27.2% touched 2x
intraday, 4.5% were delisted within 90 days. The top 40% by market cap
doubled 16.5% of the time, so low caps spike only a little more often than
larger coins, and lose more doing it. In Jan-Feb 2021 93-100% of low caps
doubled within 90 days: in a mania everything pumps, which says nothing about
selection.

## 4. Which variables worked (bottom 40%)

Full tables: `results/univariate_lowcap40.txt`, `results/flags_lowcap40.txt`.

**Forecasting inflows (next 30 days' volume tripling), base 11%.** Every one
of these survives Holm and is positive in both halves:

| Feature | Top quintile | Bottom quintile | t |
|---|---|---|---|
| 7-day volume vs 90-day (surge under way) | 16.0% | 5.8% | 7.3 |
| Illiquidity (Amihud) | 17.9% | 5.0% | 6.8 |
| Trade-count surge | 15.0% | 5.3% | 6.8 |
| 30-day dollar volume (low = more) | 6.2% | 17.3% | -5.5 |
| Biggest daily gain in 90 days (low = more) | 7.2% | 14.7% | -5.2 |
| Price impact per $1M net buying (Kyle's lambda) | 15.0% | 9.9% | 4.2 |
| 7-day momentum | 13.9% | 8.9% | 4.0 |

**Forecasting the direction of the flow.** Net taker buying is persistent:
coins in the top fifth for 30-day net buying had a 37% chance of net buying
the next month against 11% for the bottom fifth (t = 15). It turned into price
only weakly (90-day return t = 1.5, take-profit return t = 2.4, both carried by
2023-26).

**Forecasting a doubled close within 90 days.** Nothing survives Holm.
Closest, all positive in both halves: volatility relative to its own past
(t = 3.6), 30-day volatility (3.3), 30-day range (3.2). Size within the
low-cap set: t = -1.2. Momentum at 7/30/90 days: nothing.

**Forecasting the take-profit return.** Two survive: low dollar volume
(bottom-volume quintile 11.0% vs top 2.6%, t = -4.7) and illiquidity (t = 3.7).
The illiquid names are also the most expensive to trade, which the 0.6% cost
in section 6 only partly covers.

**Flags and categories (doubled close; flag minus rest per anchor):**

| Flag | With | Without | t | Note |
|---|---|---|---|---|
| Meme category | 18.8% | 7.6% | 5.6 | only since 2025-06, 26 anchors, one regime |
| Binance monitoring tag | 12.9% | 6.9% | 3.7 | squeezes; but 90d return -11 pts, take-profit -9 pts |
| Has a Binance perp | 18.3% | 13.9% | 3.4 | take-profit +4.9 pts (t 2.9) |
| DWF Labs portfolio | 21.6% | 17.3% | 2.9 | not Holm |
| Already on Upbit KRW | 6.8% | 11.0% | -2.5 | catalyst spent |
| "Made in America" tag | 19.9% | 13.4% | 2.4 | second half only |
| Fan token | 7.0% | 12.9% | -2.2 | |
| Top-tier VC portfolio | 19.6% | 16.6% | 2.0 | |
| AI / DeFi / L1-L2 / gaming / NFT | | | |t| < 1.9 | no effect |

**Team and social (Santiment):** 90-day dev activity and its growth: |t| <= 1.4
on every outcome, 2019-26. Social volume exists free only for 2025-10 to
2026-09 (17 anchors, about three independent 90-day windows): the most
discussed fifth doubled 7.0% of the time vs 13.7% for the least discussed, and
rising chatter came before worse take-profit returns (t = -4.0). Suggestive,
not established.

**Market regime.** In-sample, when most Binance alts were up over 30 days the
low-cap doubling rate was 27% vs 13.5% (t = 2.0). Out of sample (Nov 2021 to
Jul 2026) it was 12.9% vs 9.9% (t = 0.8). The 2020 alt season carried it.
Timing claims are dropped.

## 5. The combined model, walk-forward

`results/walkforward_lowcap40.txt`. Top 10 per anchor, Nov 2021 to Jul 2026.

| Model | AUC (doubled close) | Top-10 doubled | Base | Inflow AUC | Take-profit excess vs pond |
|---|---|---|---|---|---|
| Gradient-boosted, all features | 0.545 (t 2.4) | 15.8% | 11.0% | 0.524 | +4.5% (t 2.2) |
| Logistic, all features | 0.530 (t 1.5) | 14.0% | 11.0% | | +3.4% (t 1.4) |
| Logistic, inflow target | | | | **0.674 (t 15.1)** | +3.8% (t 1.7) |
| Volatility only | 0.538 | 14.6% | 15.2% | | **-5.9% (t -3.4)** |
| Illiquidity only | 0.506 | | | 0.639 | +3.7% (t 1.9) |
| Smallest market cap only | 0.511 | | | | -0.6% |

By year, gradient-boosted top 10 vs base: 2022 10.8% vs 9.6%, 2023 22.3% vs
13.3%, 2024 24.6% vs 16.1%, 2025 6.9% vs 5.6%, 2026 15.0% vs 10.9%. AUC above
0.5 in five of six years (2025: 0.46).

Calibration failed: by predicted decile, realised doubling was flat at 9-12%
from the lowest (predicted 7%) to the highest (predicted 42%). Averaged per
anchor, predicted level and realised rate were negatively related (t = -1.8).
Only the within-day order is used.

Bottom 20% only: base 19.7%, AUC 0.50 (no skill), inflow AUC still 0.67.

## 6. Exits matter more than entries

`results/strategy_lowcap40.txt`. Per-trade mean, net of 0.6%, Nov 2021 to Jul 2026.

| Basket | Exit | Mean | t | 2021-23 | 2024-26 | Median trade | Excess vs pond |
|---|---|---|---|---|---|---|---|
| All low caps | hold 90d | -6.8% | -1.0 | +0.4% | -13.1% | -21% | |
| All low caps | +100% or 90d | -2.1% | -0.3 | +2.7% | -6.3% | -21% | |
| Model top 10 | +50% or 90d | +4.0% | 0.7 | +7.6% | +0.8% | -14% | +4.2% (t 2.0) |
| Model top 10 | +100% or 90d | +4.9% | 0.7 | +9.8% | +0.6% | -21% | +7.0% (t 2.6) |
| Model top 10 | +200% or 90d | +4.5% | 0.5 | +8.8% | +0.8% | -21% | +8.4% (t 2.4) |
| Model top 10 | hold 90d | -1.5% | -0.2 | +6.8% | -8.7% | -21% | +5.3% (t 1.6) |
| Model top 10, monitoring/fan excluded | +100% or 90d | +4.1% | 0.6 | +10.3% | -1.3% | -17% | +6.2% (t 2.5) |
| Illiquidity top 10 | +100% or 90d | +2.9% | 0.4 | +10.7% | -3.8% | -16% | +5.0% (t 1.6) |

Win rate 35-52% depending on exit. Buying only when at least half of alts are
up (fixed threshold) gave +11.5% on 38 anchors vs +1.9% otherwise, t = 0.95:
not significant, consistent with section 4.

## 7. Catalysts

`results/event_study.txt`. Median Binance return minus the median Binance alt
over the same window.

| Event (low caps) | n | 30d before | Day | Best close in 7d | Next 30d | Next 90d |
|---|---|---|---|---|---|---|
| Upbit KRW listing | 12 | +4% | **+52%** | +52% | **-30%** | -22% |
| Upbit KRW listing, all caps | 74 | +5% | +16% | +21% | -10% | -16% |
| Binance perp launch | 57 | **+23%** | +13% | +20% | -19% | -20% |
| Binance monitoring tag | 73 | -2% | -12% | -10% | -13% | **-36%** |
| Binance delisting notice | 191 | -4% | -13% | -4% | -17% | -13% |
| Binance Earn/Margin/Convert add | 465 | +6% | +1% | +8% | -4% | -8% |
| Upbit caution flag | 8 | -11% | -9% | | -21% | -50% |

Upbit KRW day-one moves by year (all caps): 2024 +17%, 2025 +22%, 2026 +14%,
in line with 4pillars' finding that the Upbit pump fell from a 42% median
first day to 10% after mid-June 2026
([4pillars, Aug 2026](https://research.4pillars.io/en/data/content/the-dying-upbit-listing-pump)).
Delisting notices since 2024 cost -14% to -33% on the day and -31% to -51%
over 30 days. A handful of delisting notices on coins with perps produced short
squeezes instead (ALPACA 19x in Apr 2025, HIFI 9x, BAKE, SLF, NFP, HFT), and
so did monitoring-tag coins (LSK 11x Aug-Sep 2026): violent, untradeable from
spot, and gone within days.

The usable form of the Upbit catalyst is holding a coin that Upbit already
trades in BTC or USDT but not KRW (Upbit usually upgrades those; 4pillars puts
the median at +19%) and selling into the listing day.

## 8. What the explosions looked like

`results/episodes.csv`. 361 episodes: a close at least 3x the lowest close of
the prior 60 days, from a bottom-40% market cap.

- By year: 2019 5, 2020 30, 2021 123, 2022 34, 2023 40, 2024 53, 2025 30, 2026 46.
- Median 4.4x over 50 days. Ninety days after the peak: median -57%, 8% at or
  above the peak.
- 67% had no Binance or Upbit event between two weeks before the low and the
  peak. Present in the rest: Binance Earn/Margin/Convert adds 20%, perp
  launch 13%, delisting notice 3.6%, Upbit KRW 1.4%.
- Categories appear roughly in proportion to their share of low-cap days (AI
  15% of episodes vs 12% of days, privacy 9% vs 7%, meme 3% vs 2%, fan tokens
  5% vs 8%).
- Recent large ones: TUT 21x and SYN 20x (Jun-Aug 2026), LSK 11x, MUBARAK
  7.7x, ONE 6.7x, PROM 6.3x (Upbit KRW), SAGA 6.1x, and earlier OM 13x
  (Dec 2023 to Feb 2024).

## 9. Today's ranking (as of 2026-10-12)

`results/ranking_2026-10-12.csv` has every column; the lists come from
`scripts/final_lists.py`. "Rank" is the model's order among all 154 low caps.
"$ to lift +20%" is ask-side depth on Binance spot today. "Inflow rank" is the
validated volume-surge forecast (1 = most likely), which says nothing about
direction.

### A. Spike watch - eligible, not already running (model order)

| Rank | Coin | Category | Mcap | 30d | From ATH | $ to lift +20% | Binance $/day | Inflow rank | Korea | Backers | Flags |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 4 | AUDIO (Audius) | infra | $23.0M | +22% | -100% | $287k | $1806k | 33 | Upbit BTC only - KRW candidate | top VC |  |
| 5 | SKL (SKALE) | gaming | $33.6M | +47% | -100% | $137k | $2083k | 41 | Bithumb only | top VC |  |
| 6 | CELR (Celer Network) | privacy | $23.7M | +40% | -98% | $58k | $1975k | 88 | Bithumb only | top VC |  |
| 7 | LUMIA (Lumia) | privacy | $19.1M | +39% | -97% | $76k | $2551k | 24 | not in Korea | DWF | top-10 wallets 97% |
| 9 | EDEN (OpenEden) | rwa | $26.6M | +24% | -96% | $120k | $881k | 150 | Upbit BTC/USDT only - KRW candidate |  | top-10 wallets 91% |
| 10 | NEIRO (Neiro) | meme | $33.9M | -8% | -97% | $252k | $1877k | 116 | not in Korea | DWF |  |
| 12 | DOGS (DOGS) | meme | $21.4M | -22% | -98% | $61k | $614k | 64 | not in Korea |  |  |
| 14 | DOLO (Dolomite) | defi | $11.5M | +5% | -93% | $42k | $301k | 59 | not in Korea | top VC | top-10 wallets 81% |
| 15 | BROCCOLI714 (CZ's Dog) | meme | $21.8M | +26% | -86% | $101k | $2728k | 133 | not in Korea |  |  |
| 16 | FOGO (Fogo) | l1_l2 | $23.7M | -30% | -95% | $28k | $627k | 19 | not in Korea |  | supply +36% in 90d |
| 18 | SPELL (Spell Token) | defi | $17.6M | +8% | -100% | $133k | $633k | 20 | not in Korea | DWF | top-10 wallets 84% |
| 19 | TST (Test) | meme | $15.2M | +1% | -97% | $122k | $1748k | 143 | not in Korea |  |  |
| 20 | ROBO (Fabric Protocol) | ai | $17.3M | -16% | -85% | $75k | $1262k | 128 | Bithumb only |  | FDV 4.5x mcap |
| 21 | LUNA (Terra) | other | $31.7M | -5% | -100% | $72k | $1214k | 125 | not in Korea |  |  |
| 22 | HAEDAL (Haedal Protocol) | defi | $9.7M | -8% | -94% | $45k | $448k | 54 | Upbit BTC/USDT only - KRW candidate |  | supply +19% in 90d |
| 23 | WOO (WOO) | defi | $23.6M | +10% | -99% | $19k | $228k | 15 | Bithumb only |  |  |
| 24 | AIXBT (aixbt) | meme | $20.0M | -2% | -98% | $57k | $584k | 36 | not in Korea |  | top-10 wallets 86% |
| 26 | SLP (Smooth Love Potion) | gaming | $22.1M | -3% | -100% | $40k | $330k | 75 | not in Korea |  |  |
| 27 | FRAX (Frax (prev. FXS)) | defi | $31.3M | +21% | -79% | $30k | $376k | 10 | Bithumb only |  | top-10 wallets 82% |
| 28 | MAV (Maverick Protocol) | privacy | $12.6M | +2% | -99% | $50k | $453k | 3 | Bithumb only | top VC | top-10 wallets 89% |

### B. Already running - high spike rank but late (30d >= +50% or 90d >= +100%)

| Rank | Coin | Category | Mcap | 30d | From ATH | $ to lift +20% | Binance $/day | Inflow rank | Korea | Backers | Flags |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | ONE (Harmony) | l1_l2 | $27.8M | +173% | -100% | $123k | $14319k | 126 | not in Korea |  |  |
| 2 | OGN (Origin Protocol) | defi | $26.6M | +95% | -99% | $152k | $4813k | 45 | Upbit BTC only - KRW candidate | top VC |  |
| 3 | ACE (Fusionist) | gaming | $20.3M | +14% | -99% | $226k | $6926k | 151 | Bithumb only |  |  |
| 31 | INIT (Initia) | l1_l2 | $25.4M | +73% | -92% | $57k | $1036k | 26 | Upbit BTC/USDT only - KRW candidate |  | FDV 4.8x mcap |

### C. Inflow watch - most likely 30d volume to triple (direction NOT forecast)

| Rank | Coin | Category | Mcap | 30d | From ATH | $ to lift +20% | Binance $/day | Inflow rank | Korea | Backers | Flags |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 28 | MAV (Maverick Protocol) | privacy | $12.6M | +2% | -99% | $50k | $453k | 3 | Bithumb only | top VC | top-10 wallets 89% |
| 43 | TKO (Toko Token) | other | $9.6M | +4% | -99% | $18k | $268k | 5 | not in Korea |  |  |
| 104 | MBL (MovieBloc) | other | $15.6M | +14% | -98% | $60k | $692k | 6 | Upbit KRW already | DWF |  |
| 86 | CTK (Shentu) | defi | $20.9M | +8% | -97% | $70k | $1363k | 8 | Bithumb only |  |  |
| 27 | FRAX (Frax (prev. FXS)) | defi | $31.3M | +21% | -79% | $30k | $376k | 10 | Bithumb only |  | top-10 wallets 82% |
| 97 | MANTA (Manta Network) | privacy | $33.0M | +11% | -98% | $93k | $990k | 11 | Bithumb only | top VC |  |
| 74 | ARPA (ARPA) | privacy | $17.2M | +17% | -96% | $90k | $1076k | 13 | Upbit BTC/USDT only - KRW candidate | DWF |  |
| 29 | RVN (Ravencoin) | rwa | $26.2M | -28% | -99% | $140k | $1523k | 14 | not in Korea |  |  |
| 23 | WOO (WOO) | defi | $23.6M | +10% | -99% | $19k | $228k | 15 | Bithumb only |  |  |
| 45 | SHELL (MyShell) | ai | $9.7M | +4% | -97% | $49k | $496k | 16 | Upbit BTC/USDT only - KRW candidate | top VC | top-10 wallets 93% |
| 78 | SXT (Space and Time) | ai | $12.7M | +7% | -95% | $69k | $752k | 17 | Bithumb only |  | FDV 3.6x mcap |
| 112 | IQ (IQ) | ai | $23.0M | -3% | -97% | $31k | $226k | 18 | Upbit KRW already |  | top-10 wallets 92% |

### D. Upbit KRW candidates - already on Upbit BTC/USDT markets, no KRW pair yet

| Rank | Coin | Category | Mcap | 30d | From ATH | $ to lift +20% | Binance $/day | Inflow rank | Korea | Backers | Flags |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2 | OGN (Origin Protocol) | defi | $26.6M | +95% | -99% | $152k | $4813k | 45 | Upbit BTC only - KRW candidate | top VC |  |
| 4 | AUDIO (Audius) | infra | $23.0M | +22% | -100% | $287k | $1806k | 33 | Upbit BTC only - KRW candidate | top VC |  |
| 9 | EDEN (OpenEden) | rwa | $26.6M | +24% | -96% | $120k | $881k | 150 | Upbit BTC/USDT only - KRW candidate |  | top-10 wallets 91% |
| 22 | HAEDAL (Haedal Protocol) | defi | $9.7M | -8% | -94% | $45k | $448k | 54 | Upbit BTC/USDT only - KRW candidate |  | supply +19% in 90d |
| 31 | INIT (Initia) | l1_l2 | $25.4M | +73% | -92% | $57k | $1036k | 26 | Upbit BTC/USDT only - KRW candidate |  | FDV 4.8x mcap |
| 45 | SHELL (MyShell) | ai | $9.7M | +4% | -97% | $49k | $496k | 16 | Upbit BTC/USDT only - KRW candidate | top VC | top-10 wallets 93% |
| 55 | CTSI (Cartesi) | l1_l2 | $31.5M | +33% | -98% | $159k | $1686k | 56 | Upbit BTC only - KRW candidate |  |  |
| 74 | ARPA (ARPA) | privacy | $17.2M | +17% | -96% | $90k | $1076k | 13 | Upbit BTC/USDT only - KRW candidate | DWF |  |
| 79 | CHR (Chromia) | ai | $20.9M | +33% | -99% | $76k | $948k | 65 | Upbit BTC only - KRW candidate |  |  |
| 131 | BNT (Bancor) | defi | $32.0M | +1% | -97% | $21k | $169k | 48 | Upbit BTC/USDT only - KRW candidate |  |  |
| 142 | BMT (Bubblemaps) | ai | $14.1M | +4% | -94% | $99k | $774k | 144 | Upbit BTC/USDT only - KRW candidate |  |  |

### E. Avoid - Binance monitoring tag, Upbit warning/caution, fan tokens

QI (Binance monitoring tag), ACT (Binance monitoring tag), REZ (Upbit caution), EPIC (Binance monitoring tag), HEI (Binance monitoring tag), COOKIE (Binance monitoring tag), QUICK (Binance monitoring tag), RARE (Binance monitoring tag), TOWNS (Binance monitoring tag), BICO (Binance monitoring tag), GNS (Binance monitoring tag), SOPH (Binance monitoring tag), MOVR (Binance monitoring tag), SCR (Binance monitoring tag), GLMR (Binance monitoring tag), YB (Upbit caution), PORTAL (Binance monitoring tag), AVA (Binance monitoring tag), OPG (Upbit caution), NOM (Binance monitoring tag), RESOLV (Binance monitoring tag), TLM (Binance monitoring tag), BREV (Upbit caution), GTC (Binance monitoring tag), ERA (Upbit caution), BIGTIME (Upbit caution), ARKM (Upbit caution), TREE (Upbit caution), MANTRA (Upbit warning), RAD (Upbit caution), MIRA (Upbit caution), ZKC (Upbit caution), CYBER (Upbit caution), ANIME (Upbit caution), QKC (Binance monitoring tag), WCT (Upbit caution), API3 (Upbit caution), CVC (Binance monitoring tag), GMT (Upbit caution), ZBT (Upbit caution), DODO (Binance monitoring tag), AI (Upbit caution), SANTOS (fan token), HYPER (Upbit caution), EUL (Upbit caution), ALPINE (fan token), LAZIO (fan token), ACM (Upbit caution), ASR (fan token), OG (fan token), JUV (fan token), BAR (fan token), CITY (fan token), PORTO (fan token), ATM (fan token), PSG (fan token)

### Notes from the review of the top names

Most of section A are old projects 96-100% below their all-time highs with
little current coverage; that is typical of what Binance's bottom 40% now is.

- **ONE (Harmony)**: all-time low $0.00023 on 2026-08-12, now about 7x off it,
  daily volume 86% of market cap. No news found explaining it. Late.
- **OGN (Origin Protocol)**: 2.5x off its 2026-07-01 low; volume about 377% of
  market cap. Protocol revenue funds OGN buybacks since mid-2025. On Upbit BTC
  only, so it is also a KRW candidate. Late but with a catalyst left.
- **ACE (Fusionist)**: July-August 2026 squeeze on an $11M float; game chain
  (Endurance) testing ACE as gas. Late.
- **AUDIO (Audius)**: music streaming, top-VC backed, on Upbit BTC only. No
  2026 news found.
- **SKL (SKALE)**: v5 deployed; FAIR (MEV-resistant L1) announced in 2025. No
  October news.
- **CELR (Celer)**: launched Celer Intent (cross-chain RFQ) in March 2026.
- **LUMIA**: RWA chain, DWF Labs partner; top-10 wallets hold 97% of tracked supply.
- **EDEN (OpenEden)**: real business (USDO stablecoin, TBILL fund with a
  Moody's "A"); on Upbit BTC/USDT only (KRW candidate); scheduled emissions
  from the ecosystem allocation; top-10 wallets 91%.
- **DOLO (Dolomite)**: WLFI lending runs on Dolomite (52% day in Jan 2026);
  protocol revenue fell from $4.1M in Q2 to about $0.65M in Q3 2026; new
  all-time low in June 2026.
- **INIT (Initia)**: thin float, repeated 50-70% days on volume 5-11x market
  cap; FDV 4.8x market cap; on Upbit BTC/USDT only.
- **FOGO**: unlock cliff of roughly 164-171M tokens on 2026-09-26 and monthly
  unlocks after; supply +36% in 90 days.
- **ROBO (Fabric/OpenMind)**: robotics narrative, Binance HODLer airdrop, 22%
  of supply circulating at launch (FDV 4.5x).

Sources: CoinMarketCap coin pages (ONE, OGN, 2026-10-13);
[Phemex on ACE](https://phemex.com/blogs/what-is-fusionist-ace-and-why-aaa-gaming-token-rallied);
[OneKey on OGN](https://onekey.so/blog/ecosystem/ogn-deep-dive-token-fundamentals-recent-developments-and-future-outlook);
[OneKey on SKL](https://onekey.so/blog/ecosystem/skl-deep-research-report-token-future-development-and-price-outlook);
[MEXC on Celer Intent](https://www.mexc.com/news/869389);
[OpenEden](https://openeden.com/news/openeden-eden-token-tokenized-rwa-ecosystem/);
[DWF Labs and Lumia](https://dwf-labs.com/news/525-revolutionising-real-world-assets-dwf-labs-and-lumia);
[DefiLlama DOLO](https://defillama.com/token/DOLO);
[MEXC on INIT](https://www.mexc.com/news/728024);
[Bitrue on the FOGO unlock](https://www.bitrue.com/blog/fogo-token-unlock);
[Binance Research on Fabric](https://www.binance.com/research/projects/fabric-protocol).

## 10. How to use it, and what would go on the signals page

How to use the lists:

1. Spread small stakes across section A or D rather than concentrating; the
   model's edge is only visible across ten names.
2. Set the exit when you buy: sell at +50% or +100% on a daily close, or at 90
   days. Holding through the peak returned the typical run to -57%.
3. Do not buy section E. Treat a new monitoring tag or Upbit caution on
   anything you hold as a sell.
4. For section D, the catalyst is an Upbit KRW listing; sell into the
   listing day, because the next 30 days averaged -30% for low caps.
5. Section C says volume is coming, not which way. Combine it with A, or use
   it to size, not to pick.

### The signals-page lane (built 2026-10-13, `lowcap-watch-v1`)

Approved by the owner the same day. Panel `panel-lowcapWatch` in the
Watchlists zone; daily job `.github/workflows/signals-lowcap-watch.yml`
(01:23 UTC, GitHub starts it late; the summary counts as live for 36 hours).

| Piece | What it does |
|---|---|
| `scripts/lowcap-watch.py` | fetches Binance spot klines, Binance tags and delisting notices, CMC market caps, Upbit markets, the perp archive and order books; computes the study's features on each pair's newest bar; fits both models on the frozen panel; ranks today's low caps; scores rows whose 30/90 days have passed |
| `scripts/lowcap-training-v1.csv.gz` | the study panel (18,542 coin-dates, 2019 to 2026-09), production features and both labels |
| `scripts/lowcap-evidence-v1.json` | every rate the panel quotes |
| `scripts/lowcap-watch-io.mjs` | D1 ledger (insert-only cohorts, outcomes filled once), payload loader |
| `migrations/0062_lowcap_watch.sql` | `lowcap_watch` (every low cap, every day, both ranks, both outcomes), `lowcap_watch_runs` |

What is published and what is not:

- **Inflow watch (public):** the 10 eligible low caps most likely to see
  30-day volume triple. Production configuration, walked forward with the
  CI-pinned libraries (`results/prod_validation.json`): top 10 17.3% vs 8.2%
  base, AUC 0.67, AUC above 0.64 every year, but no top-10 edge so far in
  2026 (7.2% vs 7.1%, 14 dates). Pulled from the page if its live record
  trails the same days' low caps with t <= -2 over 60 or more days.
- **Avoid list (public):** every live Binance pair under the monitoring tag,
  Upbit's formal warning (유의종목; the lighter same-day "caution" alerts are
  not used, they were never tested) or an announced Binance spot delisting.
  Fan tokens are excluded from the watch but not listed.
- **Spike ranking (private):** logged every day, never in the payload, until
  its own live record beats the low-cap average after costs: top 10 with a
  +100% take-profit vs the same day's whole low-cap set, t >= 2 over at least
  180 daily cohorts. The first 90-day outcomes arrive in January 2027, so the
  earliest it can appear is mid-2027. The Worker refuses it again unless the
  gate is live and the list arrived; the loader strips it otherwise.

Every low cap of every day is stored (about 155 rows a day), so both records
compare the picks with the same day's whole set, not with a backtest.

Checks: production features reproduce the study's exactly (40 random
coin-dates, 29 features); `test-lowcap-watch.py` (24), `test-lowcap-watch-io.mjs`
(5), 17 rendered-dashboard checks including the spike gate in three
directions, health checks `lowcap-watch-fresh` and `lowcap-avoid-sources`
(warns if Binance's www API or Upbit were unreachable from the runner). Each
gate and scoring rule was mutation-tested: 14 deliberate breaks, 14 caught.

## 11. Caveats

- The walk-forward covers Nov 2021 to Jul 2026 only (123 anchors), mostly a
  falling market for alts; the 2021 mania is excluded from testing.
- Binance volume and taker flow are one venue. Korean and DEX flows are not
  seen, and 67% of explosions had no catalyst we could see.
- Market-cap mapping for 14 delisted pairs failed; they are missing from the
  low-cap panel.
- Social data covers one year. X follower counts and LunarCrush-type
  sentiment are not available free and were not tested.
- Tags (categories, VC portfolios, DWF) are today's labels.
- The order-book snapshot is one moment on 2026-10-13.
