# Frontier Capital Signals — Cloudflare Worker

Hourly confluence screens across the top 100 cryptos (by market cap) and 60 US equities. Up to 14 independent techniques per asset vote bullish, bearish, or neutral; assets rank by weighted directional agreement, and every row shows the raw agreement count (for example 9/14). Each technique's weight for a given asset adapts over time based on how reliably it has actually called that asset's direction (see "Adaptive reliability weighting" below).

Lives at `frontiercapitalsignals.com/signals`, as a Worker bound only to that path — the rest of the domain (the Next.js app, deployed separately via `deploy.yml`) is untouched, and it's linked from the main site's nav, footer, and homepage.

## Architecture: the engine runs outside the Worker

The confluence engine (`buildPayload()` in `worker.js`) makes roughly 230 outbound fetches per build (60 stock quotes, 60 analyst-valuation lookups, ~100 per-coin crypto daily-history calls, a handful of index/global calls) and does real CPU work computing 14 indicators across ~160 assets. That's too much for Cloudflare Workers' **Free plan** limits (50 subrequests, ~10ms CPU per invocation) — it would get hard-killed mid-build every time.

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

## The 14 techniques

Multi-horizon momentum alignment; RSI(14) regime and direction; MACD(12/26/9) histogram; moving-average stack (SMA20/50/200, from real daily bars for both equities and crypto); Bollinger %B with squeeze detection; stochastic (14,3) crosses; Donchian 20-bar breakout/breakdown; volume vs baseline; OBV trend; swing structure of higher-highs/higher-lows; momentum divergence proxy; volatility regime (coiled vs climactic); reversal-pattern detection (below); and a valuation-or-positioning layer. Techniques without data abstain rather than guess, so the agreement denominator varies from about 11 to 14.

Crypto gets a real per-coin daily-history fetch (`getCryptoDailyHistory`, CoinGecko `/coins/{id}/market_chart`, ~210 daily bars) instead of relying only on the 7-day hourly sparkline. This matters beyond just "more data": RSI/MACD/etc. computed off 14 *hourly* points (the old approach) is a materially different, noisier number than the conventional daily-bar RSI(14) everyone means by that term. When a coin's history fetch fails for a given run, that coin falls back to the old sparkline-only behavior for that hour rather than dropping out of the universe.

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

- **Historical** (`basis: 'historical'`, shown in amber on the dashboard with a check mark): once an asset has at least `MIN_RELIABILITY_SAMPLES` matured outcomes at the 24h or 168h mark for the techniques currently voting on it, the estimate uses *that asset's own measured accuracy* at each horizon — the same D1 data the adaptive weighting above draws on, just answering a different question.
- **Methodology** (`basis: 'methodology'`, shown in gray): the fallback before there's enough of that asset's own history — a weight-averaged blend of the active techniques' typical horizons from `TECHNIQUE_META`. An informed estimate, not a measurement, and the dashboard says so via the chip's tooltip.

This reuses `reliability.mjs`'s existing D1 data rather than adding a new store: `loadReliability()` now returns `{ blended, byHorizon }` — `blended` (sums correct/total across horizons) is what `evaluateTechniques()` uses to weight votes; `byHorizon` (keeps 24h and 168h separate) is what `horizonEstimate()` uses to compare which horizon has actually been more accurate for a specific asset.

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
