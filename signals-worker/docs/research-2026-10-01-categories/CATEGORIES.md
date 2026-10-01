# What assets are used for, and whether categories lead or rotate

2026-10-01. Asked: "find and tag assets/coins on fcs signals page with their utility (what they are used for. could be multiple). also see if similar categories have similar trends and if some are leading indicators within the category and if a category itself might be a leading indicator (maybe interest/capital might be rotating predictably from one category to the next during certain periods like a bull season, etc)".

## Short answer

* **Tags shipped.** Every coin and stock on the signals page now shows what it is used for (up to 3 uses), and the search box matches uses ("lending", "ai", "fees"). There is no runtime cost: the tags are a static file (`utility-tags.js`) built by `scripts/gen_utility_tags.py`.
* **Categories do move together, some strongly.** Memes (0.30 correlation with their own category vs -0.04 with others), payments coins (0.27-0.37) and gaming (0.20-0.28) are real clusters. Oracle and social tokens are not.
* **No category leads another, and no category leader leads its category,** in a way that held up out of sample. This covers 342 category pairs at daily, weekly and 4-weekly steps, BTC and ETH as leaders, data-chosen and size-chosen category leaders, category momentum, and the BTC -> ETH -> large caps -> small caps -> memes "alt season" sequence. The number of nominal hits was what chance alone produces.
* **No category reliably does better in bull or bear phases** (BTC above or below its 200-day average). Every apparent phase effect flipped sign between the two halves of the history.
* **One real but small pattern: a coin that lagged its own category tends to catch up.** Over 28 days the slope is -0.085 (t -4.2) in 2023-26 and the same sign in 2019-22 (t -1.1). In a head-to-head test, the category beats the whole market as the thing coins revert to. That suggests the coin-rotation pattern already logged on paper is really reversion toward a coin's own category. As a long-laggards / short-leaders trade it is not significant after costs (+1.7% per 28 days, t 1.3; the first half had the wrong sign). **Meme laggards keep lagging** (-15.7% per 28 days): they die rather than catch up.

## Tags

* Crypto (2,123 coins tagged): CoinGecko category membership, 141 categories, mapped to 25 plain uses in `scripts/taxonomy.py`. Membership is keyed by CoinGecko id, because unrelated coins share tickers. Ecosystem and investor categories are excluded: they say where a token lives or who bought it, not what it does. The ~110 largest coins have hand-checked tags (`scripts/curated.py`). Two tidy rules apply: a stablecoin is never also "meme", and a DEX or perps token is not an "exchange token" (that tag means CEX fee tokens like BNB).
* Stocks (all 290 on the watchlist): hand-checked business lines, 66 labels. Nasdaq's industry codes were rejected: they call MicroStrategy software, GE Vernova consumer electronics and IonQ "EDP services".
* MOVR and GLMR are tagged **"Legacy: chain shut down"**: their chains were wound down in July 2026 and the tokens now have no built-in use.
* Refresh: re-run `fetch_members.py` then `gen_utility_tags.py <out.js> <markets.json>`. Keyless CoinGecko takes about 90 minutes at a safe pace.

## Data and method

575 Binance USDT spot coins, daily closes 2019-03 to 2026-10. The listed ones come from `data-api.binance.vision`; coins delisted in 2024-26 come from the 2026-09-29 hourly archive. Returns are measured in excess of the equal-weight market of every coin trading that day. A coin's first 60 days are dropped, and so are redenomination jumps. Each coin's category is its most specific use. Halves: A 2019-07..2022-12, B 2023-01..2026-10. Anything chosen (a leader, a pair) is chosen on A and judged on B. Time-series t statistics are Newey-West; cross-sections are Fama-MacBeth over non-overlapping periods. With 342 pairs, the bar for a half-A pick was Bonferroni |t| >= 3.8.

**Excluded: Binance "bStocks".** These are 61 tokenized US stocks and ETFs (TSLAB, NVDAB, SPYB, SOXLB...), listed as ordinary USDT pairs since June 2026. They are not crypto. The same finding changed `live-scan.mjs`, which had cast 65 silent candidate signals on 13 of them since 2026-09-27; none were exhaustion warnings and nothing was pushed.

## Results (`research-output.txt`)

| Question | Result |
|---|---|
| Members move with their own category | Yes, for meme, payments, gaming, liquid staking, privacy, platforms; no for oracle, social |
| Category leader -> its category, next day / week | No leader held in both halves (largest-coin leaders: AI/TAO and scaling/ARB only have half-B data) |
| BTC or ETH today -> a category tomorrow | No consistent effect |
| Category A -> category B next day / week / 4 weeks | 0 / 2 / 2 pairs past the half-A bar; none held in half B |
| Category momentum (top third vs bottom third) | Not significant in either half |
| BTC -> ETH -> large -> small -> memes sequence | No lag (1-4 weeks or 4-week steps) held |
| Category by bull/bear phase | Every apparent effect flipped between halves |
| Coin vs its own category, 28 days | Reverts: t -4.2 (B), -1.1 (A); tradable spread not significant; memes the opposite |

## Honest limits

* Before 2024 the panel holds only coins still listed today. Laggards that died and were delisted are missing, which flatters catch-up, so half B is the one to weigh.
* Categories are today's. A coin tagged "AI" now may not have been an AI coin in 2021.
* Half A has few coins in the newer categories (AI, RWA, scaling), so several cells are half-B only.
* Nothing here changed a score or an alert. The catch-up pattern is a candidate for the paper log, not a signal.
