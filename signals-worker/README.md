# Frontier Capital Signals — Cloudflare Worker

Hourly confluence screens across the top 200 cryptos and 60 US equities. Up to 13 independent techniques per asset vote bullish, bearish, or neutral; assets rank by weighted directional agreement, and every row shows the raw agreement count (for example 9/13).

Lives at `frontiercapitalsignals.com/signals`, as a Worker bound only to that path — the rest of the domain (the Next.js app, deployed separately via `deploy.yml`) is untouched.

## Architecture: the engine runs outside the Worker

The confluence engine (`buildPayload()` in `worker.js`) makes roughly 130 outbound fetches per build (60 stock quotes, 60 analyst-valuation lookups, a handful of crypto/index calls) and does real CPU work computing 13 indicators across ~260 assets. That's too much for Cloudflare Workers' **Free plan** limits (50 subrequests, ~10ms CPU per invocation) — it would get hard-killed mid-build every time.

So the work is split:

- **`.github/workflows/signals-refresh.yml`** (repo root) runs `scripts/build-signals.mjs` on an hourly cron via GitHub Actions — a plain Node process with no such limits — and writes the resulting JSON straight into the Worker's KV namespace over the Cloudflare API.
- **`worker.js`** does only two things at request time: serve the static dashboard, and read that one KV key. No outbound fetches, negligible CPU — comfortably inside Workers Free plan.

If a build fails (upstream outage, etc.), `build-signals.mjs` exits non-zero without touching KV, so the Worker just keeps serving the last good payload rather than an empty one.

## What's in this folder

```
signals-worker/
├── worker.js            The Worker: dashboard + KV-read-only API (paste-ready, self-contained)
├── src/worker.js         Same file, for the wrangler CLI path
├── wrangler.toml         KV binding + route template
├── scripts/build-signals.mjs   Runs the engine, pushes the result to KV (called by the GitHub Action)
├── test-worker.mjs       Integration harness: routing, KV serving, and the engine itself
└── README.md
```

The engine (indicator math, confluence scoring) is the same code verified by 52 offline math/scoring checks; `test-worker.mjs` adds routing, caching, and end-to-end engine checks on top. All green — run `node test-worker.mjs` (no network, everything stubbed) after any edit.

## One-time setup

**1. Cloudflare KV namespace + Worker:**

```
cd signals-worker
npx wrangler kv namespace create FCS_CACHE   # paste the returned id into wrangler.toml
npx wrangler deploy
```

Then in the Cloudflare dashboard: Worker → Settings → Domains & Routes → confirm the `frontiercapitalsignals.com/signals*` route is bound (also templated in `wrangler.toml`).

**2. GitHub repo secrets/variables** (repo → Settings → Secrets and variables → Actions), used by `signals-refresh.yml`:

| Name | Type | Value |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | secret | Same token used by `deploy.yml`, as long as it also has "Workers KV Storage: Edit" — otherwise re-issue it via the "Edit Cloudflare Workers" template. |
| `CLOUDFLARE_ACCOUNT_ID` | secret | Same as `deploy.yml`. |
| `FCS_KV_NAMESPACE_ID` | variable | The id returned by `wrangler kv namespace create` above. Not secret, just an identifier. |
| `TREFIS_OVERRIDES` | variable, optional | e.g. `{"AAPL":275.0,"NFLX":88.0}` — your own model price targets, if any. |

Then trigger the workflow once manually (Actions tab → Signals Refresh → Run workflow) to populate KV immediately instead of waiting for the next hour. Visit `https://frontiercapitalsignals.com/signals`.

## The 13 techniques

Multi-horizon momentum alignment; RSI(14) regime and direction; MACD(12/26/9) histogram; moving-average stack (SMA20/50/200 for equities, 7-day mean and slope for crypto); Bollinger %B with squeeze detection; stochastic (14,3) crosses; Donchian 20-bar breakout/breakdown; volume vs baseline; OBV trend (equities); swing structure of higher-highs/higher-lows; momentum divergence proxy; volatility regime (coiled vs climactic); and a valuation-or-positioning layer. Techniques without data abstain rather than guess, so the agreement denominator varies from about 11 to 13.

## Valuation layer and Trefis

Equities use Wall Street consensus mean price targets and recommendation ratings (Yahoo quoteSummary via a crumb handshake): trading well below a buy-rated target votes bullish, trading above it votes bearish. Trefis publishes no public API, so consensus stands in by default. Supply your own model targets via the `TREFIS_OVERRIDES` variable and those win, labeled `source: "override"` in the payload. Crypto uses Bybit perpetual funding rates and CoinGecko trending-list crowding as its positioning layer.

## Data sources

CoinGecko (markets, global, trending), alternative.me Fear & Greed, Bybit linear perp funding, Yahoo Finance daily OHLCV with Stooq fallback, Yahoo analyst estimates. All fetched concurrently in `build-signals.mjs`, all optional-degrade. The status bar shows live coverage (CG, EQ n/60, VAL n). Yahoo endpoints are unofficial; `getStock` and `getValuation` (inside `worker.js`) are the only functions to swap if you move to Finnhub or Polygon.

## Security

The dashboard sends `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy` headers. All data rendered into the page goes through the client-side `esc()` helper before hitting `innerHTML`, including fields (asset names, symbols) that ultimately originate from third-party feeds. The JSON API is public/read-only with no auth and `Access-Control-Allow-Origin: *` by design — it carries no secrets and no user-specific data, only market data that's already public.

## Editing later

Change the watchlist, universe size, and filters in the config constants near the top of `worker.js`; tune technique weights in `evaluateTechniques`; adjust the embedded dashboard in the `PAGE_HTML` template near the bottom. `worker.js` is the single source of truth — `build-signals.mjs` imports `buildPayload` from it directly, so there's no separate copy of the engine to keep in sync. After any edit, copy the file to `src/worker.js` too (`cp worker.js src/worker.js`) and run `node test-worker.mjs` before redeploying.

## Honest notes

A score of 70 with 10/13 agreement is a strong mechanical setup, not a probability. The model has no knowledge of token unlocks, earnings dates, lawsuits, or macro events; those remain the human layer. The footer marks the page as informational, not advice. If you ever charge for access, review investment adviser rules first.
