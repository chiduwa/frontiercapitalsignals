# Frontier Capital Signals — Cloudflare Worker

Hourly confluence screens across the top 100 cryptos (by market cap) and 60 US equities. Up to 32 candidate techniques per asset may emit a bullish, bearish, or neutral research vote, but those techniques are not assumed independent. Unknown, weak, and baseline-level candidates receive zero production weight while continuing to accumulate outcomes. A public direction, horizon, and interval appear only when the asset class and the exact asset/side/horizon/score/range cells have enough independent, calibrated evidence; otherwise the row explicitly says `WITHHELD`. Price and 24h change tick live between rebuilds, while analysis stays anchored to its timestamped reference price.

Lives at `frontiercapitalsignals.com/signals`, as a Worker bound only to that path — the rest of the domain (the Next.js app, deployed separately via `deploy.yml`) is untouched, and it's linked from the main site's nav, footer, and homepage.

## Architecture: the engine runs outside the Worker

The confluence engine (`buildPayload()` in `worker.js`) makes roughly 230 outbound fetches per build (60 stock quotes, 60 analyst-valuation lookups, ~100 per-coin crypto daily-history calls, a handful of index/global calls) and does real CPU work computing 16 indicators across ~160 assets, several of them now over years of daily history. That's too much for Cloudflare Workers' **Free plan** limits (50 subrequests, ~10ms CPU per invocation) — it would get hard-killed mid-build every time.

So the work is split:

- **`.github/workflows/signals-refresh.yml`** (repo root) runs `scripts/build-signals.mjs` via GitHub Actions — a plain Node process with no such limits — and writes the resulting JSON straight into the Worker's KV namespace over the Cloudflare API. It also drives the reliability-learning loop against D1 (see below).
- **`worker.js`** serves the static dashboard and reads that KV key at request time. Its lightweight five-minute Cloudflare cron makes no market-data calls or calculations; it only dispatches the existing GitHub workflow when the KV payload is stale, so GitHub's delayed native cron cannot leave the model stale for hours.

If a build fails (upstream outage, etc.), `build-signals.mjs` exits non-zero without touching KV, so the Worker just keeps serving the last good payload rather than an empty one.

## What's in this folder

```
signals-worker/
├── worker.js                    The Worker: dashboard + KV-read-only API, plus the engine itself
├── src/worker.js                 Same file, for the wrangler CLI path (keep byte-identical, no build step)
├── wrangler.toml                 KV binding + route template
├── scripts/build-signals.mjs     Runs the engine, pushes the result to KV (called by the GitHub Action)
├── scripts/reliability.mjs       D1-backed reliability learning loop (load weights, log votes, score outcomes)
├── migrations/                   Versioned additive D1 schema changes
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

Then run the schema in `scripts/schema.sql` against it (`npx wrangler d1 execute frontier-capital-signals-reliability --file=scripts/schema.sql --remote`). Future additive schema changes live in `migrations/`; both the Worker deploy and refresh workflows apply them before running code that depends on them. To apply one manually, run `npx wrangler d1 migrations apply frontier-capital-signals-reliability --remote`.

**3. GitHub repo secrets/variables** (repo → Settings → Secrets and variables → Actions), used by `signals-refresh.yml`:

| Name | Type | Value |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | secret | Needs Workers KV Storage:Edit **and** D1:Edit. The "Edit Cloudflare Workers" dashboard template does not include D1 — add the D1 permission group to the token (or issue a second scoped token) or the reliability loop will log a warning and skip itself every run. |
| `CLOUDFLARE_ACCOUNT_ID` | secret | Same as `deploy.yml`. |
| `FCS_KV_NAMESPACE_ID` | variable | The id returned by `wrangler kv namespace create` above. Not secret, just an identifier. |
| `FCS_D1_DATABASE_ID` | variable | The uuid returned by `wrangler d1 create` above. If unset, descriptive data may still build but trade-like fields fail closed. |
| `TREFIS_OVERRIDES` | variable, optional | e.g. `{"AAPL":275.0,"NFLX":88.0}` — your own model price targets, if any. |
| `GITHUB_ACTIONS_TOKEN` | secret, recommended | A fine-grained GitHub token restricted to this repo with **Actions: Read and write**. `signals-deploy.yml` securely copies it into the Worker as a secret so the five-minute stale-cache monitor can dispatch `Signals Refresh`; it is never sent to browsers, KV, or notifications. |

After adding `GITHUB_ACTIONS_TOKEN`, push/redeploy once so `signals-deploy.yml` copies it to the Worker and verifies the identical GitHub dispatch request used by the stale-cache monitor. That verification queues a guarded `force=false` refresh: it builds only if KV is stale, otherwise it exits without duplicate scoring or writes. Without the secret, the normal GitHub schedule remains fallback coverage but cannot self-recover from a multi-hour scheduling gap. Visit `https://frontiercapitalsignals.com/signals`.

When diagnosing stale data, `https://frontiercapitalsignals.com/signals/api/refresh-status` exposes the most recent stale-cache dispatch result for up to 24 hours. It records only a timestamp and safe outcome (for example, `dispatched` or a GitHub HTTP error); it never includes the token. A request for an already-stale `/api/signals` response also queues the same guarded refresh in the background, so visitor traffic remains a fallback if the Cloudflare cron service is delayed.

## Candidate techniques (see `TECHNIQUE_META` for the authoritative list)

Multi-horizon momentum alignment; RSI(14); MACD; SMA stack; Bollinger state; stochastic; Donchian proximity; volume and OBV; swing structure; divergence; volatility regime; reversal and dwell research; seasonal analogs; positioning/valuation; sentiment; time/calendar behavior; events; cross-asset/sector lead-lag; support/resistance; accumulation; relative outliers; and macro candidates. These are correlated features, not independent voters. Missing inputs abstain, and an available input still receives zero live weight until its own record earns one.

Crypto gets a real per-coin daily-history fetch (`getCryptoDailyHistory`, CoinGecko `/coins/{id}/market_chart`, up to 365 daily bars). RSI/MACD computed from 14 hourly sparkline points is not the conventional daily-bar RSI/MACD and cannot share its labels. If a trustworthy daily series is unavailable, the asset remains visible to descriptive/live-price paths but is excluded from the daily directional model for that build.

**365 days is CoinGecko's actual free-tier ceiling, not a design choice** — confirmed live in production after briefly trying 2000 days (error code 10012, "Public API users are limited to querying historical data within the past 365 days," caused every single one of ~76 coins to fail that run instead of the usual ~36-37). Practical effect: `seasonalAnalog` can never find a candidate year for crypto on this plan (it needs more than 365 days of history to compare even one year back), so it's effectively **equities-only** — for crypto it correctly returns `null` every time via the same length check that already handles "too young to have history," just universally true here rather than only for the newest coins. Stocks don't have this ceiling: `getStock` fetches 10 years from Yahoo (was 1), and the Stooq fallback keeps ~2600 trading days (was 300) to match, so `seasonalAnalog` has real multi-year data to work with there.

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

Every build logs directional candidate votes and the timestamped reference price. At 24 hours or seven days, scoring uses the first observation at or after the exact target, within 90 minutes of scheduler tolerance; a pre-target or materially late price cannot shorten or relabel the horizon. At most one forecast per full horizon enters each asset/technique series, so 24 hourly versions of a 24-hour call are one independent trial, not 24. The append-only `forecast_outcomes` ledger stores target time, observed time, entry/exit price, model version, and label version. Its claim, derived-counter updates, and commit execute in one D1 batch transaction, making retries idempotent and recoverable.

Before the next build, reliability and calibration are reconstructed from the ledger for the active model/label version. A technique earns positive live weight only after its conservative asset-specific record beats the relevant no-skill baseline; unknown, thin, coin-flip, and negatively skilled candidates have zero production weight while still being logged. Publication is stricter: the asset class must have demonstrated skill, then the exact current asset, direction, horizon, score bucket, and range-coverage cell must qualify. Pooled statistics are diagnostic only.

D1 evidence is load-bearing for trade-like output. If it is missing or fails, the builder may still refresh prices and descriptive observations, but direction, timeframe, and interval fail closed rather than falling back to heuristic weights. Migration `0009` resets invalid overlapping aggregates and replays the retained independent ledger; migration `0013` adds outcome provenance/version fields; migration `0014` persists the fixed out-of-sample review checkpoint separately from the number of simulated trades. A post-migration cold start with many withheld rows is expected and must not be bypassed by lowering thresholds.

## Leading vs. lagging, and the expected timeframe

`TECHNIQUE_META` still labels a candidate as leading or lagging for explanation, but those labels never manufacture a clock. `horizonEstimate()` compares the active side's exact asset/technique records at 24 hours and seven days. It publishes one only when that horizon has enough independent, positive evidence; when both work but cannot be distinguished, it reports an ambiguous 1–7 day research window and the publication gate withholds the trade call. With no empirical winner, the horizon is `null`.

## Expected price range

`predictedRange()` creates a research band from the asset's version-matched realized move distribution. Volatility-only bands may be logged so their coverage can be learned, but they are never public trade metrics. A public interval requires the exact asset and horizon to have at least 30 independent range outcomes, a conservative containment floor, and empirical coverage reasonably close to its declared 68% target. A near-100% hit rate is rejected as likely too broad rather than marketed as “high accuracy.” The band is anchored to the analysis reference price and is not an exact top, bottom, target, or stop; no such field is emitted until a path-dependent extreme model earns its own validation.

## Which indicator an asset leans on

`topIndicator()` scans a specific asset's entry in the reliability map and surfaces whichever technique has, on its own, the best individually-proven accuracy for that asset — shown under the asset's name once one exists ("Leans on divergence (71%)"). Some assets really are better predicted by one kind of signal than another; this is the direct answer to that, reusing the exact same per-(asset, technique) data the adaptive weighting draws on, gated by the same `MIN_RELIABILITY_SAMPLES` bar so a technique with a lucky handful of calls can't claim it.

## Live prices

Price and 24h change tick independently of the hourly rebuild, via a dedicated `/api/prices` route the client polls roughly every 20 seconds (`updateLivePrices()` in `PAGE_HTML`, patching only the price/chg cells already in the DOM — never a re-render, so it can't disturb a mid-sort or mid-scroll). This is the one deliberate exception to "the Worker only ever reads KV at request time": `/api/prices` reads the cached payload to learn which symbols are currently displayed (never from the request itself, so a caller can't make it fan out arbitrarily), then makes one batched CoinGecko `simple/price` call for the displayed crypto and up to ~20 parallel lightweight Yahoo chart calls (`yahooQuote()`, `range=1d`, just enough for `meta.regularMarketPrice`/`previousClose`) for the displayed equities — at most ~22 subrequests, comfortably inside the Free plan's 50-subrequest cap, and cheap on CPU since there's no indicator math, just passthrough JSON.

**CoinGecko rate-limits this from Cloudflare's shared egress IPs** — confirmed live: a single `simple/price` call for the displayed ids got a straight HTTP 429 with no unusual traffic at all, the same shared-IP rate-limiting GitHub Actions runners hit earlier on the per-coin history endpoint (see "The techniques" above), just from Workers' IP range instead of Actions'. Mitigations, all in the route handler:

- **A second, independent crypto price source** (added 2026-08-20): `binanceUsTradablePairs()` runs once per hourly build and rides in the KV payload as `binanceUsSymbols` — whichever displayed crypto symbols have a confirmed-tradable Binance.US USDT pair get their live tick from `binanceUsTicker24hr()` instead of CoinGecko; only the (mostly longer-tail) remainder still goes to CoinGecko, a smaller batch than before. This splits the rate-limit exposure across two providers rather than removing the need for the cache below — Binance.US, not Binance.com, which is geo-blocked (HTTP 451) from this project's infra (see `scripts/archive.mjs`'s Binance.US backfill integration).
- **A short KV-cached window** (`LIVE_PRICE_CACHE_KEY`, `expirationTtl: 60`, KV's own *minimum* — not a tunable floor, Workers KV rejects a shorter TTL outright) caps upstream calls to at most once per 60 seconds *regardless of visitor count*, for either provider — the actual fix for concurrent-visitor load, since the problem is request volume against a shared rate limit, not a transient blip a retry would smooth over. `X-FCS-Live-Cache: hit`/`miss` on the response shows which path served it. The provider split above doesn't lower this 60s floor (that's a platform minimum), it reduces each provider's own share of the traffic and adds headroom as the tracked universe grows.
- **Fallback to the hourly build's own price/chg24h** for any symbol both live fetches miss (still rate-limited even at reduced frequency, a thin/renamed/delisted symbol, a Yahoo hiccup) — real data, just not freshly ticked, rather than a gap the dashboard has to guess how to render.

Everything else — score, confluence agreement, range, horizon, every technique call — only changes on the hourly rebuild. Live prices are a between-build nicety, not a claim that the analysis itself is real-time.

## Day-trading and intraday research

The former public intraday direction model did not demonstrate a usable edge and its scheduled GitHub cadence was too sparse for a scalping claim. Its schedule is disabled and `/api/intraday` now always returns a deprecated, directionless response—even if an old directional KV payload exists.

`/api/scalp` is the replacement public surface. It reports fresh price, session range consumed, position within that range, non-directional confirmations, and only independently measured time windows. It contains no side, entry, target, top/bottom, leverage, liquidation, or position-size field. The old intraday and paper-trade code remains a manual shadow-research harness: target scoring is one-sided at or after the exact 15/30/60-minute maturity, overlapping windows do not increase sample size, and results cannot reach publication without a new versioned validation path.

## Prediction track record

The track-record panel is historical context, not a current trade card. Its headline is the composite direction record alone, tested against the asset class's measured no-skill baseline with a conservative lower bound; reversal inputs and range containment are shown separately so correlated outcomes or a very wide band cannot inflate “directional accuracy.” The panel deliberately contains no current side, horizon, entry, or interval. Today's setup must independently pass the stricter publication gate.

## Valuation layer and Trefis

Equities use Wall Street consensus mean price targets and recommendation ratings (Yahoo quoteSummary via a crumb handshake). Trefis publishes no public API, so consensus stands in by default; server-side `TREFIS_OVERRIDES` are labelled as overrides. Crypto positioning uses CoinGecko's derivatives-market observations and trending-list crowding. These remain candidate features and cannot bypass learned weighting/publication gates.

## Data sources

CoinGecko (top 100, daily history, global, trending, and derivatives positioning), alternative.me Fear & Greed, Binance.US/CoinGecko live crypto prices, Yahoo Finance daily OHLCV with Stooq fallback, Yahoo analyst estimates, CoinMetrics community MVRV, CMC Altcoin Season breadth when configured, CoinGecko BTC dominance, security-event feeds, and the locally derived Mayer control. Every optional input carries freshness/availability handling; missing data abstains. Market-cycle values are immutable, provider/version keyed, causal-percentile research rows and do not cast a production vote.

## Security

The dashboard sends `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy` headers. All data rendered into the page goes through the client-side `esc()` helper before hitting `innerHTML`, including fields (asset names, symbols) that ultimately originate from third-party feeds. The JSON API is public/read-only with no auth and `Access-Control-Allow-Origin: *` by design — it carries no secrets and no user-specific data, only market data that's already public. The reliability D1 database holds only prices and directional vote history, no PII, and is never exposed to the Worker or the public API.

## Support/resistance breaks and accumulation/distribution (added 2026-08-20)

Added after a post-mortem on the 2026-08-19 crypto pump: BTC's composite score sat at 10-19/100 through the move because its bullish candidates had poor BTC-specific records and no usable trending-regime fallback. Two new candidate techniques were added to the research lane. Like every new technique, each starts with zero production authority and must earn its own record:

- **`srbreak`** — a level only reaches `asset_sr_levels` once price has reversed off it more than once (a real, tested support/resistance level, not the existing `range` technique's plain 20-bar Donchian channel, which is unrelated and unchanged). Computed daily (`computeSrLevelsAndBreaks`, `scripts/archive.mjs`) via walk-forward swing-pivot detection over `asset_daily_bars`, using real high/low where the archive has them. Every historical break of a since-key level gets its realized 24h/168h move folded into `sr_break_stats` — per-symbol once a symbol has enough of its own break history, else pooled by `asset_class|level_type` (the same historical-if-enough-samples-else-pooled-fallback discipline `bestVolLookback`/`horizonEstimate` use) — so the live technique can note e.g. "broke support $64,200 — historically -3.1% over 24h (18 prior breaks)," not just the bare direction.
- **`accum`** — fires *while* price is still coiled (tightening Bollinger bands or realized vol well under baseline, with price itself still flat), reading OBV's slope with no price-confirmation requirement at all — deliberately the leading counterpart to the existing `obv` technique (T9), which only votes once `chg7d` has already confirmed a move. Answers "is this quietly building pressure" rather than "did volume confirm a move that already happened."

Also found in the same post-mortem, unrelated to either technique: `.github/workflows/signals-daily.yml` had been silently `cancelled` by its own `timeout-minutes` on every run from 08-17 through 08-20 (confirmed via the GitHub API) — the "Refresh per-asset sentiment" step (`daily-refresh.mjs`, which also does lead/lag, sector composites, and swing-time/score-snapshot work) had organically grown to 1508s, leaving under 2 minutes of the 1800s budget even on the last full success. Raised to 55 minutes; every individual outbound call already has its own bound via `fetchWithTimeout`, so this ceiling is about total aggregate time, not an unbounded-hang risk.

## Market-wide tracking, quality scores, and outperformer rotation (added 2026-08-21)

- **Favorites**: `FAVORITE_SYMBOLS` (currently BTC, ETH, SOL, XLM, XRP, HYPE, HBAR) always evaluate and always show, bypassing the normal `CRYPTO_MIN_MCAP`/`CRYPTO_MIN_VOLUME` floor, in their own pinned dashboard section shown ahead of the ranked boards.
- **`MCAP:BROAD`/`MCAP:TOTAL`**: a broad-market composite (equal-weighted return index across every tracked crypto asset, reusing the sector-composite machinery — CoinGecko's real historical total-market-cap endpoint is Pro-tier only) plus the real dollar total archived daily from today forward. Both are just more symbols in `asset_daily_bars`, so support/resistance detection (`srbreak`) and lead/lag apply to the whole market automatically. The `mktoutlier` technique flags an asset moving well beyond, or opposite to, what the broad market itself is doing.
- **`yieldcurve`**: the one hypothesis, out of 19 tested against the full historical record of every ≥20%-in-≤7-days crypto move, that held up independently in both halves of history — the 2s10s Treasury spread narrowing over the preceding 5 days precedes a crypto breakdown. Bearish-only; the mirror case for breakouts did not validate.
- **Quality score**: a cross-sectional percentile (GitHub commits/contributors, Telegram/Reddit reach, CoinGecko watchlist users) vs. every other tracked coin with data that day — never an absolute number, since raw counts are wildly different scales per project and coverage is genuinely uneven (many coins have no linked GitHub repo at all). Purely informational, shown as a `Quality N/100` badge; never a directional vote.
- **Outperformer rotation**: `detectOutperformanceRotation` (worker.js) flags a sustained multi-month outperformance streak vs `MCAP:BROAD` — validated live against Solana's own real archive before shipping (correctly found all 4 of its independently-documented breakout phases, 2020-21 through the 2023-24 post-FTX recovery, with no hand-tuning). Shown as a `⬆️ Rotating in` badge, also informational only.
- **Consolidating badge**: surfaces the `accum` technique's own vote as a dedicated always-visible badge, independent of whether it happens to make the top-3 "why" driver notes.
- **Stablecoin correlation research**: `correlation-research.mjs` excludes stablecoins from directional market tests and separately tests pooled stablecoin de-peg stress against next-day non-stable crypto returns. Findings are written only after pooled significance and same-signed chronological-half confirmation; the result remains research-only and does not alter live scores.
- **Tiered reliability weighting**: live technique weights now prefer, in order, the asset's own regime-specific record, then its broader per-asset record, with both shrunk toward the technique's asset-class baseline before affecting a vote. Technique pairs that repeatedly agree and are right for that same asset get only a small extra boost from `technique_combo_reliability`; nothing with thin or insignificant history changes a live weight.
- **Confident-move alerts**: the ntfy/RSS path requires score calibration matched to asset class, direction, score bucket, and horizon, plus the exact asset/side/horizon composite record and calibrated range coverage. Pooled calibration cannot authorize an alert. It uses conservative bounds, strong current agreement, anchored timestamps, and cooldown/re-arm state; any missing component withholds direction, timeframe, and interval together.
- **Perp-vs-spot basis**: archived daily going forward (`funding_rate_daily.basis_pct`) from the same CoinGecko derivatives snapshot that already feeds funding/OI — no historical basis exists anywhere to backfill, so this starts real accumulation now rather than fabricating a finding; no live technique reads it yet.

## Exhaustion reversals, leader/lagger research, and call-flip tracking (added 2026-08-22)

- **Exhaustion reversals**: `detectExhaustionReversals` (worker.js) filters a symbol's own `detectMoveEpisodes` output down to episodes preceded by an extended run in the OPPOSITE direction — "dipped suddenly after days of continuous rising" (user-requested, grounded in a real live event that day: BTC/ETH/SOL/XRP/XLM/HBAR all hit fresh highs then pulled back 3-11% intraday after the 08-20/21 rally). Across full history: bull-exhaustion dips are a genuine pivot (not a bounce-back blip) 72% of the time (n=208); the symmetric capitulation-bounce case holds 64% of the time (n=332). Neither volume-at-the-reversal nor whether the whole market was also extended predicts which outcome you get — both tested, both clean nulls. Research-only for now (`correlation-research.mjs`), not yet wired into a live technique.
- **Leader/lagger research**: does a specific asset's own exhaustion reversal happen before others', making it an early warning? Scoped to BTC and the market composite (pre-specified, not a mined scan across every symbol — see the file's own multiple-testing guard) plus, for the descriptive pass only, the top general leaders already validated by the independent `lead_lag_signals` table. Finding: BTC does NOT reliably lead this specific event type (led first in only 19% of paired cases, n=59 — these tend to be simultaneous market-wide moves). ONDO showed a 90% lead rate but only n=10 — worth watching, not yet a confirmed pattern.
- **Call-flip tracking**: user-requested, the WLFI case — called a bottom, switched to breakdown risk a few hours later. The composite call (`dir`/`score`) was already being logged every run in `technique_votes` (`technique_id='composite'`, for the calibration curve) — no new log needed. `detectCallFlips` (worker.js) reads that existing history and finds every point a symbol's own call reversed; `detectAndLogCallFlips`/`evaluateCallFlips` (reliability.mjs) append each new flip to the small, permanent `call_flip_log` table and judge ~24h later whether the new direction held, reverted (whipsaw noise), or was too small to call. Surfaces as a `⚠️ Flipped ▲→▼ Nh ago` caution badge on the affected row, plus a held/reverted rate once a symbol has enough evaluated flips (same `MIN_RELIABILITY_SAMPLES` gate used everywhere else) — informational only, same discipline as quality/rotation, never fed back into score/dir. This is the tracking infrastructure the self-learning loop needs; it started accumulating real outcome data today, so a calibrated behavioral change (e.g. requiring a stronger score to flip an asset with a history of reverting) is a follow-up once real held/reverted rates exist, not a guess made now.

## Stablecoin exclusion and the automatic retrospective (added 2026-08-31)

Two fixes from one report: USDG was sitting at #3 on the breakdown board wearing a **⏳ Consolidating ↓** badge, and ARB had run +34% without the engine calling it.

### Why a peg was being shown as consolidating

The T27 `accum` technique fires when a range is coiled — squeezed Bollinger bands or realized vol well under baseline, with `|chg7d| < 5%` — and then reads OBV to pick a direction. A $1 stablecoin satisfies the coiled test *permanently and unconditionally*, so the only thing choosing a direction was OBV, which on a peg is mint/redeem flow rather than accumulation. A peg has nothing to consolidate toward.

`isStableValueAsset` existed and was meant to prevent exactly this, but it is a ticker list plus a name regex, and nothing about the strings "USDG" or "Global Dollar" says "peg". Sweeping the live top 100 the same way found four more already inside the fetched universe, two of them also on live boards: **FIGR_HELOC** (a $21.9B tokenized HELOC, on both the breakdown *and* long-term-potential boards), **U** (United Stables), **USDGO** (which this repo's own day-trade notes had identified as a stablecoin back on 2026-08-25 without anyone adding it to the list), plus **AUSD** and **USDF**.

The real fix is behavioural, not another round of ticker whack-a-mole. `pegBehaviour()` measures the **median absolute bar-over-bar return** of the 7-day hourly sparkline every crypto row already carries. Median, not range: FIGR_HELOC's high/low band is 5.43% — wider than gold's — purely from stale prints in a thin book, so a range test clears it while the median test puts it at 0.0101%.

Calibrated against the live top 100 (2026-08-31), the two populations do not overlap:

| | median hourly move |
|---|---|
| all 24 pegs / T-bill funds / flat RWAs | ≤ 0.0101% |
| *— 7x gap —* | |
| LEO / BDX / HTX / XAUT / **PAXG** | 0.0750% – 0.0929% |

`PEG_MEDIAN_BAR_RETURN_PCT = 0.03` sits in the middle of that gap. PAX Gold is the near-miss worth protecting — genuinely low-volatility *and* genuinely directional — and it clears the threshold by 3.1x.

The threshold also catches an entire class the ticker list never would: tokenized money-market and T-bill funds (BUIDL, JTRSY, USYC, USTB, JAAA, BCAP), which are not stablecoins and are not $1-anchored (USTB trades ~$11.19, BCAP ~$106.25) but are equally non-directional.

One guard worth knowing about: a name heuristic alone is *not* trusted. The token literally named "Stable" (`stable-2`) is an ordinary directional asset — +7.2% in 24h, -14.9% over 30 days — and a plain `/\bstable\b/` ban would have silently deleted it from the boards. Soft name matches must be confirmed by the price series, and **the series always wins**. See `looksLikePegByName` / `isNonDirectionalAsset`.

### Excluded is not ignored

Pegs are split out of the directional boards, not discarded. A stablecoin's supply and turnover going quiet or surging is plausibly information about where the money *not* sitting in it is about to go — so every excluded asset is logged to `stable_value_observations` (price, market cap as a net mint/redeem proxy, volume, peg tightness, distance from its own anchor, and whether it was excluded by name or by behaviour, so a wrong exclusion stays auditable).

Keyed by **date**, not by run timestamp: it bounds the table without a pruning job (~9.5K rows/year rather than 228K), it matches the grain of the question (net mint/redeem is a daily-scale flow; hourly wobble in a peg's market cap is noise on the anchor), and it makes the rows directly joinable with the stablecoin depeg series `correlation-research.mjs` already keys by calendar date. The hourly build upserts into the day's row; `peak_deviation_pct` is the one column accumulated with `MAX` rather than overwritten, because a depeg is an intraday spike that last-write-wins would erase.

Anchor distance is measured against the asset's **own 7-day median**, not an assumed $1 — the excluded set includes tokenized T-bill funds trading near $11 (USTB) and $106 (BCAP), which a hardcoded dollar would score as permanently and enormously depegged. Observation only: nothing reads it into a live signal until `correlation-research.mjs` shows the relationship survives out-of-sample via `research_registry`.

### Binance global, after all

`api.binance.com` is geo-blocked from this project's infrastructure (HTTP 451 on every host, re-confirmed 2026-08-31). What had been missed is that Binance publishes the identical read-only `/api/v3` market-data surface on **`data-api.binance.vision`**, which is not geo-blocked and answers 200. Same klines/exchangeInfo/ticker endpoints, global order book, no key.

The difference is not marginal. On ARB during the move that prompted this work:

| | 17:00 bar |
|---|---|
| Binance.US | 5,504 units — and 14 of the preceding 24 hourly bars had **zero** volume |
| Binance global | 24,649,023 units / $2.25M / 11,955 trades |

The intraday leg had been reading a venue where the move did not happen. Global also lists 485 TRADING USDT pairs against Binance.US's much thinner set. Binance.US remains the fallback for live price ticks so one venue's outage is not the dashboard's.

### `scripts/retrospective.mjs` — what moved, and why we missed it

Runs daily (`signals-retrospective.yml`, 04:20 UTC). Three questions in order:

1. **What actually moved?** From a scan of the top **300**, deliberately wider than the engine's own `CRYPTO_UNIVERSE = 100`. That widening is the whole point — on 2026-08-31 six of the eight biggest movers were below rank 100 and were never fetched at all, so a retrospective built on the engine's own universe would have reported a clean sheet.
2. **Was it detectable in advance?** From Binance global hourly bars. `findMoveEpisode` locates the actual trough-to-peak run first, *then* `earliestDetectableSurge` looks for the tell within a bounded window before it — quote volume **and** trade count both clear of their 48-hour trailing medians, into a rising bar. Anchoring matters: an unanchored search fires on BTC and ETH as readily as on ARB, and put ARB's entry five days and a -10.5% drawdown before the real move.
3. **What did the engine say at the time?** From the composite votes the hourly build had already written — not a reconstruction after the fact.

Output is structured rows, not commentary, because the aggregate is the product. `MISS_CAUSES` is a closed vocabulary (`out-of-universe`, `filtered-out`, `unranked`, `wrong-side`, `late`, `caught`) specifically so causes can be **counted**: one missed move is an anecdote, "80% of misses were out-of-universe" is an instruction about what to fix. `retrospective_patterns` also tracks average % still available between the first tell and the peak — the number that decides whether a miss actually cost anything, since a move only detectable at its own top cost nothing.

Downside episodes are explicitly **not** analysed rather than analysed wrongly. Caught during a dry run: PROM had fallen 16%, and the upside-only search dutifully found the bull trap that preceded the drop (19.3x volume into a rising bar, then -22.1%) and reported it as a detectable long. Distribution is not the mirror image of accumulation, so downside moves return `detected: false` with a stated reason and are counted separately. An acknowledged gap in the ledger beats a confident wrong entry in it.

Three traps worth knowing about, all found in review rather than in production:

- **CoinGecko pagination offset is `per_page * (page - 1)`.** Shrinking `per_page` on the last page to fit a budget re-reads earlier ranks instead of continuing past them — `per_page=250` then `per_page=50&page=2` returns ranks 1-250 followed by ranks **50-99**, never reaching 251-300. The scan would have been blind to exactly the band it exists to cover while double-counting the band it already had. `PAGE_SIZE` is fixed and results are deduped by id.
- **A `composite` vote is written for every scored asset, not only for the ten per side that reach a board.** Treating "has a composite vote" as "was on a board" would classify almost every in-universe mover as `caught` and make `unranked` unreachable — the engine grading itself as having called moves it never showed anyone. `loadEngineStateBefore` reconstructs board membership by ranking each run's composite votes the way `sortSide` does.
- **`Math.abs(m.chg7d ?? 0) < 5`** in the `accum` technique inverted the safe default. Everywhere else in `evaluateTechniques` the `?? 0` idiom makes a missing value fail the test and the technique abstain; here it made a missing value assert *perfect flatness*, the strongest possible evidence of coiling. Latent (every live top-100 asset currently reports a 7d change) but the same shape as the USDG bug, and a newly listed coin is both the likeliest source of a missing `chg7d` and the worst place to invent a consolidation. Now requires `Number.isFinite`.

Results render in a **Retrospective** section placed *above* the boards, not below them — burying the engine's record of what it got wrong under the calls it is currently making would invert the honesty the section exists to provide.

## Forward surge scanning, and why it warns instead of entering (added 2026-09-01)

The retrospective explains moves after the fact. The obvious next question is whether the same volume tell can fire *before* one, as an entry trigger. It was measured before it was built, and the measurement said no.

### The selection bias in the retrospective's own numbers

Every figure the retrospective reports is **conditioned on the outcome**: it takes assets that already moved and looks back for a surge. That answers "did a tell exist?" It does not answer "when a tell fires, does a move follow?" Those diverge completely if most surges lead nowhere — and most do.

Measured over **176K hourly observations across 200 Binance-global symbols** (~42 days), the naive reading is not merely weaker than it looked. It is inverted:

| trigger | mean forward 24h |
|---|---|
| ratio ≥ 2.5, rising bar | +0.28% |
| ratio ≥ 5 | −0.17% |
| ratio ≥ 12 | −1.69% |
| ratio ≥ 20 | −2.88% |
| ratio ≥ 12 with a +3% bar | −4.71% |

*(all-bar baseline: +0.33%)*

Monotonic. **The bigger the volume spike into a rising bar, the worse the next day.** By the time 20x prints, the crowd is buying and the move is ending. An alerter built on "big volume means get in" would have lost money.

### Two cohorts looked profitable and both failed the split

Quiet accumulation (2–3x, flat bar, liquid book) and moderate surges (5–10x, liquid) beat baseline at every horizon and cleared significance pooled — z of 4.83 and 3.44 at 48h. Both **failed the chronological-half test** that `research_registry` exists to enforce:

| cohort | first half | second half |
|---|---|---|
| quiet accumulation, 24h | −0.33% | +2.41% |
| moderate surge, 72h | −2.13% | +5.75% |

Opposite signs. The apparent edge is a bull-regime artifact of the back half of the sample, nothing more. This is precisely the trap the pooled-then-split methodology was built to catch, and it caught it.

### What survived

Only the exhaustion finding, and it survived convincingly — z = −8.84 at 24h with both halves negative (−3.45 / −2.11), **78% of individual symbols** and **69% of individual events** negative, median −2.78%. Broad, not a handful of outliers.

Tightening it to require the spike hour to have **already run ≥5%** cut alert volume from 20.6/day to **4.4/day** across 200 symbols while more than doubling the effect to **−8.02%** (z = −8.3, halves −8.1 / −7.3). Better signal and a readable alert budget, which is not a trade-off that usually comes for free.

One counter-intuitive detail worth preserving: exhaustion carries **no liquidity floor**, unlike the accumulation candidates where liquidity was the single most discriminating filter. Adding one collapses the sample to 96 events and significance disappears — exhaustion is a thin-and-mid-book pump-and-fade pattern, so screening for deep books screens out the phenomenon itself.

### `scripts/live-scan.mjs` — earning the right to interrupt you

Runs hourly over 250 Binance-global symbols (deliberately wider than `CRYPTO_UNIVERSE`, since the retrospective's standing finding is that ~80% of missed moves were never fetched at all).

**Every** configuration is cast, logged and scored on live forward data — proven or not. That is the learning loop: an unproven candidate can only earn its way in by accumulating a real forward record, and it cannot accumulate one if it is never cast. The notification gate, in order:

- **proven at discovery** → notifies (only `exhaustion20`)
- **≥30 scored casts and a Wilson lower bound above a coin flip** → notifies, graduated on its own live evidence
- otherwise → logged, silent

`surge_config_status` carries each configuration's standing and the reason it is or is not currently allowed to speak, recomputed from `surge_signal_log` every run so it can never drift from the evidence. Scoring is directional against a 1% deadband, so a market that never moved credits neither side rather than flattering whichever was called.

The alert says what the evidence says: **a warning not to chase, not an entry.**

## Continuous quant strategy research

`scripts/discovery.mjs` scans the archived daily bars for pre-declared pattern families (overnight versus intraday, weekday, turn-of-month, and class-level run reversal). A pattern clearing a family-size-corrected significance bar is only a research finding. It is not allowed to become a live setup from that result.

The tradeability layer added in migration `0010_quant_strategy_metrics.sql` keeps that distinction explicit:

- **abstain** — the effect is missing, too thin, unstable in walk-forward folds, or not profitable after the declared execution-cost assumption;
- **provisional** — discovery history is statistically consistent and has conservative after-cost expectancy, but no post-discovery sample has confirmed it yet;
- **confirmed** — the same direction replicated on data dated after discovery, and the setup's own after-cost return (not just its difference from baseline) has a positive 95% lower confidence bound. Only this state can emit a live setup alert.

The discovery-time stress test is anchored walk-forward: each expanding training prefix chooses long or short, then scores only the next disjoint date block. The genuine confirmation set remains stricter in one important sense: it contains only bars that did not exist at discovery. The lower confidence bound uses the more conservative of an IID standard error and a short Newey-West estimate so clustered daily returns cannot masquerade as independent precision. `research_strategy_metrics` stores trade count, gross/net expectancy, win rate, profit factor, compounded return, worst trade, and maximum drawdown; compounded return/drawdown are the sequential full-notional event curve, not a sizing recommendation. `research_strategy_metric_history` preserves each daily decision so degradation is auditable rather than overwritten.

The default round-trip deductions are explicit assumptions—0.30% for crypto and 0.15% for equities—and can be overridden with `FCS_CRYPTO_ROUND_TRIP_COST_PCT` and `FCS_STOCK_ROUND_TRIP_COST_PCT`. They cover a conservative fee/spread allowance, not market impact, borrow, perpetual funding, taxes, or guaranteed fills. Those omissions are repeated in alerts; no exact entry, exit, top, or bottom is inferred from this daily-bar research lane.

This is not yet a portfolio backtester: the archive is built from the currently observed universe and is therefore not guaranteed survivorship-bias-free, while simultaneous signals, capacity, and cross-position correlation are not netted into a portfolio equity curve. Maximum drawdown is measured on the event-close curve, not intratrade adverse excursion. Per-pattern rankings are useful research triage, not a claim that the top row was historically investable at arbitrary size.

## Editing later

Change the watchlist, universe size, and filters in the config constants near the top of `worker.js`; tune technique weights in `evaluateTechniques`; adjust the embedded dashboard in the `PAGE_HTML` template near the bottom. After any edit, copy the file to `src/worker.js` too (`cp worker.js src/worker.js`) and run `node test-worker.mjs` before redeploying.

## Honest notes

A score of 70 is a candidate ranking, not a 70% probability. Only the separately labelled conservative estimate is calibrated, and it is still uncertain. Event, earnings, security, positioning, sentiment, and macro coverage is partial; missing coverage is not evidence that no catalyst exists. Markets change regimes, so confirmed research can decay and must fail closed. See `QUANT_SIGNAL_DIAGNOSIS.md` for the FIL/PEPE Five-Whys, quant publication contract, cycle-indicator choices, and rollout requirements. The footer marks the page as informational, not advice. If access is commercialized, obtain appropriate legal/compliance review.
