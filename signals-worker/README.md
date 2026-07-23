# Frontier Capital Signals — Cloudflare Worker

Hourly confluence screens across the top 100 cryptos (by market cap) and 60 US equities. Up to 16 independent techniques per asset vote bullish, bearish, or neutral; assets rank by weighted directional agreement, and every row shows the raw agreement count (for example 9/16). Each technique's weight for a given asset adapts over time based on how reliably it has actually called that asset's direction (see "Adaptive reliability weighting" below).

Lives at `frontiercapitalsignals.com/signals`, as a Worker bound only to that path — the rest of the domain (the Next.js app, deployed separately via `deploy.yml`) is untouched, and it's linked from the main site's nav, footer, and homepage.

## Architecture: the engine runs outside the Worker

The confluence engine (`buildPayload()` in `worker.js`) makes roughly 230 outbound fetches per build (60 stock quotes, 60 analyst-valuation lookups, ~100 per-coin crypto daily-history calls, a handful of index/global calls) and does real CPU work computing 16 indicators across ~160 assets, several of them now over years of daily history. That's too much for Cloudflare Workers' **Free plan** limits (50 subrequests, ~10ms CPU per invocation) — it would get hard-killed mid-build every time.

So the work is split:

- **`.github/workflows/signals-refresh.yml`** (repo root) runs `scripts/build-signals.mjs` on an hourly cron via GitHub Actions — a plain Node process with no such limits — and writes the resulting JSON straight into the Worker's KV namespace over the Cloudflare API. It also drives the reliability-learning loop against D1 (see below).
- **`worker.js`** does only two things at request time: serve the static dashboard, and read that one KV key. No outbound fetches, negligible CPU — comfortably inside Workers Free plan.

If a build fails (upstream outage, etc.), `build-signals.mjs` exits non-zero without touching KV, so the Worker just keeps serving the last good payload rather than an empty one.

## What's in this folder

```
signals-worker/
├── worker.js                    The Worker: dashboard + KV-read-only API, plus the engine itself
├── src/worker.js                 Same file, for the wrangler CLI path (keep byte-identical, no build step)
├── wrangler.toml                 KV binding + route template
├── scripts/build-signals.mjs     Runs the engine, pushes the result to KV (called by the GitHub Action)
├── scripts/reliability.mjs       D1-backed reliability learning loop (load weights, log votes, score outcomes)
├── test-worker.mjs               Integration harness: routing, KV serving, engine, and reliability weighting
└── README.md
```

`worker.js` is the single source of truth for the engine — `build-signals.mjs` imports `buildPayload` from it directly, and `reliability.mjs` imports the weighting constants from it too, so there's no separate copy of the scoring logic to keep in sync. Run `node test-worker.mjs` (no network, everything stubbed) after any edit.

## One-time setup

**1. Cloudflare KV namespace + Worker:**

```
cd signals-worker
npx wrangler kv namespace create FCS_CACHE   # paste the returned id into wrangler.toml
npx wrangler deploy
```

Then in the Cloudflare dashboard: Worker → Settings → Domains & Routes → confirm the `frontiercapitalsignals.com/signals*` route is bound (also templated in `wrangler.toml`).

**2. Cloudflare D1 database** (for reliability weighting — optional, but the point of the whole learning loop):

```
npx wrangler d1 create frontier-capital-signals-reliability
```

Then run the schema in `scripts/schema.sql` against it (`npx wrangler d1 execute frontier-capital-signals-reliability --file=scripts/schema.sql --remote`).

**3. GitHub repo secrets/variables** (repo → Settings → Secrets and variables → Actions), used by `signals-refresh.yml`:

| Name | Type | Value |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | secret | Needs Workers KV Storage:Edit **and** D1:Edit. The "Edit Cloudflare Workers" dashboard template does not include D1 — add the D1 permission group to the token (or issue a second scoped token) or the reliability loop will log a warning and skip itself every run. |
| `CLOUDFLARE_ACCOUNT_ID` | secret | Same as `deploy.yml`. |
| `FCS_KV_NAMESPACE_ID` | variable | The id returned by `wrangler kv namespace create` above. Not secret, just an identifier. |
| `FCS_D1_DATABASE_ID` | variable | The uuid returned by `wrangler d1 create` above. Leave unset to run without reliability weighting (baseline weights only, no error). |
| `TREFIS_OVERRIDES` | variable, optional | e.g. `{"AAPL":275.0,"NFLX":88.0}` — your own model price targets, if any. |

Then trigger the workflow once manually (Actions tab → Signals Refresh → Run workflow) to populate KV immediately instead of waiting for the next hour. Visit `https://frontiercapitalsignals.com/signals`.

## The 16 techniques

Multi-horizon momentum alignment; RSI(14) regime and direction; MACD(12/26/9) histogram; moving-average stack (SMA20/50/200, from real daily bars for both equities and crypto); Bollinger %B with squeeze detection; stochastic (14,3) crosses; Donchian 20-bar breakout/breakdown; volume vs baseline; OBV trend; swing structure of higher-highs/higher-lows; momentum divergence proxy; volatility regime (coiled vs climactic); reversal-pattern detection; dwell time at a long-run high/low plus market-correlation decoupling; a seasonal-analog read against the asset's own multi-year history (both below); and a valuation-or-positioning layer. Techniques without data abstain rather than guess, so the agreement denominator varies from about 11 to 16.

Crypto gets a real per-coin daily-history fetch (`getCryptoDailyHistory`, CoinGecko `/coins/{id}/market_chart`, up to ~2000 daily bars — bumped from an original 210 specifically so `dwellAtExtreme`/`seasonalAnalog` have real multi-year history to work with where a coin is old enough to have it) instead of relying only on the 7-day hourly sparkline. This matters beyond just "more data": RSI/MACD/etc. computed off 14 *hourly* points (the old approach) is a materially different, noisier number than the conventional daily-bar RSI(14) everyone means by that term. When a coin's history fetch fails for a given run, that coin falls back to the old sparkline-only behavior for that hour rather than dropping out of the universe. Stocks get the same treatment: `getStock` now fetches 10 years from Yahoo (was 1), and the Stooq fallback keeps ~2600 trading days (was 300) to match.

## Dwell time, market correlation, and seasonal analogs

Added after a real miss: HBAR pivoted from a downtrend to a swift uptrend and the engine didn't catch it early, even though the `divergence` technique actually flagged a bullish signal right at the bottom — lagging techniques (`structure`, `ma`) were still confirming the old downtrend and diluted the score. Investigated live via D1 (`technique_votes` for the affected window), not just in theory.

- **`dwellAtExtreme(closes, lookback, bandPct)`**: not just "is this asset at an extreme" but how many consecutive bars it's been within `bandPct`% of its `lookback`-bar (252 for equities' trading days, 365 for crypto's calendar days) high or low. A fresh one-day touch and a multi-week base at the same level are different setups.
- **`correlationWithBenchmark(closes, benchCloses, lookback)`**: Pearson correlation of daily returns against BTC (crypto) or SPY (equities) over the trailing 30 days — is this asset moving with the market right now, or on its own? BTC's own daily closes and SPY's closes (now fetched over 6 months, not 1, specifically to give this a real window) are threaded into every other asset's metrics as `benchCloses`.
- **The `dwell` technique**: fires only once dwell reaches `MIN_DWELL_DAYS` (5). Long dwell at a low votes bullish (reversal), the mirror at a high votes bearish, and decoupling from the benchmark (`|corr| < 0.3`) raises the weight — a real move on its own reads differently than one just riding the market. This is a prior, not a rule: like every technique here, its weight per asset adapts from real outcomes via the same reliability loop, so if dwell-at-lows actually predicts *further* downside for a specific asset rather than a bounce, that gets corrected automatically.
- **`seasonalAnalog(closes, cycleLength, windowDays, forwardDays, maxCycles)`**: compares the last `windowDays` (90) against the same-length window roughly `cycleLength` bars ago, for up to `maxCycles` (6) prior cycles, using the same correlation math as the benchmark check but against the asset's own past. Requires `|corr| >= 0.5` before it counts at all — with only a handful of candidate years, a looser bar would just fit noise. Most assets are too young to have any candidate years (returns `null`, the common case, not an error); this mainly applies to assets with several years of real history, like BTC, ETH, or long-listed equities.

## Reversal detection (overbought/oversold turning points)

`evaluateTechniques`' "reversal" technique specifically targets *found-the-bottom* and *found-the-top* patterns, not a static "RSI < 30" level: it uses `rsiRecentRange()` (built on the new `rsiSeries()`, which exposes RSI's full history instead of just the latest value) to check whether RSI actually troughed below ~32 or peaked above ~68 in the last ~10 bars *and* has since turned back. That alone never fires a vote — it also requires at least one independent confirming signal (a stochastic cross, a Bollinger band extreme, swing structure, on-balance volume, or the divergence proxy), so this never trades on RSI in isolation.

On top of that, market-wide sentiment — the Fear & Greed index for crypto, and where VIX sits in its own recent 1-month range for equities (both already fetched for the overview tiles, previously unused in any per-asset scoring) — adds extra weight when it agrees: an oversold bottom during broad market-wide extreme fear, or an overbought top during broad extreme greed, is a more reliable read than the same per-asset pattern in isolation. Sentiment data missing or not aligned just means the technique scores at its base weight, not a penalty.

## Adaptive reliability weighting

Every build logs each technique's directional call (bullish/bearish, not neutral/abstain) per asset, plus that asset's price, into D1 (`scripts/reliability.mjs`). Once a call is 24 hours or 7 days old, it gets checked against what the price actually did (a move smaller than 0.5% counts as flat, not a win for either side) and folded into a running accuracy count per `(asset, technique, horizon)`.

Before scoring the next hour, `build-signals.mjs` loads each technique's blended accuracy for each specific asset and feeds it into `evaluateTechniques()` as a weight multiplier: `clamp(0.5 + accuracy, 0.5, 1.5)`. A technique that's been right 80% of the time on a given asset gets 1.3x its normal weight *for that asset specifically*; one that's been wrong 80% of the time gets 0.5x. A technique needs at least `MIN_RELIABILITY_SAMPLES` (20, in `worker.js`) matured outcomes for a given asset before its weight moves off the 1x baseline, so a handful of early results can't overfit the score.

This is additive, not load-bearing: if D1 isn't configured (`FCS_D1_DATABASE_ID` unset) or a D1 call fails, `build-signals.mjs` logs a warning and falls back to baseline (unweighted) scoring — the KV write and dashboard are never blocked on it. Tables are pruned automatically (evaluated rows past ~200 hours old, everything past 30 days regardless of evaluated status, so an asset that drops out of the universe can't leave orphaned rows growing forever).

## Leading vs. lagging, and the expected timeframe

Every technique in `worker.js` is classified in `TECHNIQUE_META` as **leading** (tries to anticipate a move before it's confirmed — RSI, Bollinger squeeze, stochastic, OBV, divergence, volatility regime, reversal detection, valuation/positioning) or **lagging/confirming** (describes a move already underway — momentum alignment, MACD, the moving-average stack, Donchian proximity, volume confirmation, swing structure), each with a typical resolution horizon in days.

`confluence()`'s `horizonEstimate()` uses this to show a timeframe next to every score (`built.crypto.breakout[0].horizon`, e.g. `{ label: '1-3 days', basis: 'methodology' }`), answering "how soon should this resolve," not just "how strong is it":

- **Historical** (`basis: 'historical'`, shown in amber on the dashboard with a check mark): once at least one of the techniques currently voting on this asset has, *on its own*, reached `MIN_RELIABILITY_SAMPLES` matured outcomes at the 24h or 168h mark for this specific asset, the estimate uses that asset's own measured accuracy at each horizon — the same D1 data the adaptive weighting above draws on, just answering a different question. This gate is deliberately per-technique, not summed across the active set: several techniques voting on the same asset in the same hour are correlated (right or wrong together, off the same underlying price move), so adding their individually-thin counts together would let that correlation pass as independent confidence it isn't — a real bug caught live in production before this was tightened.
- **Methodology** (`basis: 'methodology'`, shown in gray): the fallback before there's enough of that asset's own history — a weight-averaged blend of the active techniques' typical horizons from `TECHNIQUE_META`. An informed estimate, not a measurement, and the dashboard says so via the chip's tooltip.

This reuses `reliability.mjs`'s existing D1 data rather than adding a new store: `loadReliability()` now returns `{ blended, byHorizon }` — `blended` (sums correct/total across horizons) is what `evaluateTechniques()` uses to weight votes; `byHorizon` (keeps 24h and 168h separate) is what `horizonEstimate()` uses to compare which horizon has actually been more accurate for a specific asset.

## Expected price range

Every row shows a Range column — a band around the current price for the same timeframe as the horizon chip, never a single figure. `predictedRange()` in `worker.js` builds it from real volatility, in the same historical-vs-methodology pattern as the horizon estimate:

- **Historical**: once `evaluateMatured()` has scored at least `MIN_RELIABILITY_SAMPLES` realized moves for this asset at this horizon (`asset_move_stats`, a new D1 table — `symbol, horizon_hours, n, sum_pct, sum_pct_sq`, a running mean/stdev accumulator), the band width comes from that asset's own historical move size at this horizon. This is computed **once per (symbol, run_at) pair, not once per technique-vote** — the exact same correlation trap as the horizon confidence gate: several techniques voting on one asset in one hour all describe the same underlying price move, so counting it once per technique would inflate the sample size without adding real information. `evaluateMatured()` dedupes with a `seenMoves` set before folding a realized move into `asset_move_stats`.
- **Methodology**: the fallback before that — `realizedVolPct()` computes this asset's own recent daily volatility directly from its real price history (already being fetched for the indicators, no new data source), scaled by the square root of the horizon in days (the standard random-walk approximation for expected range over N days).

The band's center shifts toward the called direction only once the score shows real conviction (`score <= 50` gives a symmetric band with no directional assumption at all; the shift is capped at half the band width even at `score = 100`), so it never collapses into a false point prediction regardless of how strong the call is.

## Which indicator an asset leans on

`topIndicator()` scans a specific asset's entry in the reliability map and surfaces whichever technique has, on its own, the best individually-proven accuracy for that asset — shown under the asset's name once one exists ("Leans on divergence (71%)"). Some assets really are better predicted by one kind of signal than another; this is the direct answer to that, reusing the exact same per-(asset, technique) data the adaptive weighting draws on, gated by the same `MIN_RELIABILITY_SAMPLES` bar so a technique with a lucky handful of calls can't claim it.

## Valuation layer and Trefis

Equities use Wall Street consensus mean price targets and recommendation ratings (Yahoo quoteSummary via a crumb handshake): trading well below a buy-rated target votes bullish, trading above it votes bearish. Trefis publishes no public API, so consensus stands in by default. Supply your own model targets via the `TREFIS_OVERRIDES` variable and those win, labeled `source: "override"` in the payload. Crypto uses Bybit perpetual funding rates and CoinGecko trending-list crowding as its positioning layer.

## Data sources

CoinGecko (top 100 by market cap, plus per-coin daily history, global stats, trending), alternative.me Fear & Greed, Bybit linear perp funding, Yahoo Finance daily OHLCV with Stooq fallback, Yahoo analyst estimates. All fetched concurrently in `build-signals.mjs` (crypto history calls are paced, not fully concurrent, to stay well under CoinGecko's free-tier rate limits), all optional-degrade. The status bar shows live coverage (CG, EQ n/60, VAL n). Yahoo endpoints are unofficial; `getStock` and `getValuation` (inside `worker.js`) are the only functions to swap if you move to Finnhub or Polygon.

## Security

The dashboard sends `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy` headers. All data rendered into the page goes through the client-side `esc()` helper before hitting `innerHTML`, including fields (asset names, symbols) that ultimately originate from third-party feeds. The JSON API is public/read-only with no auth and `Access-Control-Allow-Origin: *` by design — it carries no secrets and no user-specific data, only market data that's already public. The reliability D1 database holds only prices and directional vote history, no PII, and is never exposed to the Worker or the public API.

## Editing later

Change the watchlist, universe size, and filters in the config constants near the top of `worker.js`; tune technique weights in `evaluateTechniques`; adjust the embedded dashboard in the `PAGE_HTML` template near the bottom. After any edit, copy the file to `src/worker.js` too (`cp worker.js src/worker.js`) and run `node test-worker.mjs` before redeploying.

## Honest notes

A score of 70 with 10/13 agreement is a strong mechanical setup, not a probability. The model has no knowledge of token unlocks, earnings dates, lawsuits, or macro events; those remain the human layer. Reliability weighting reflects each technique's own recent track record per asset, not a guarantee it'll keep working — markets change regimes. The footer marks the page as informational, not advice. If you ever charge for access, review investment adviser rules first.
