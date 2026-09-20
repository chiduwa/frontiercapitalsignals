# Signals release verification — September 20, 2026

The broader release is live at [Signals → Timing](https://frontiercapitalsignals.com/signals/#timing). Release commits: `dbe95449cf08b1e6029e6a8b1a9999ba17afbf02` and `835c4864c118a4956ec1666987f9612252b7b834`. This update supersedes the earlier audit's undeployed/authentication-blocked status. It does not promote an unproven forecasting candidate.

## Released and checked

- Worker deployment [35510938477](https://github.com/chiduwa/frontiercapitalsignals/actions/runs/35510938477) succeeded. The public payload reports `confluence-v9`; the corrected `adaptive-ridge-v2` and `hierarchical-mlr-v4` jobs produce shadow research. Source-isolated funding, independent forecast version stamps and calibrated abstention are active.
- Migrations 0043, 0044 and 0045 were applied successfully. Live D1 writes were verified for funding snapshots, flow observations, forecast versions and independently versioned research summaries.
- The Oracle collectors authenticate and write successfully. A follow-up at 12:47 UTC found all seven OI samples 8–17 seconds old and zero invalid recent rows ([collector evidence](release-2026-09-20/collectors.json)). BTC, ETH, SOL, XLM, XRP, HYPE and HBAR are pinned in the default open-interest watchlist. Normal cadence remains every five minutes for the OI service and four daily funding collections. The trading/order services were not changed.
- A controlled funding repair wrote **14,630 completed daily observations** through September 19. A direct Binance reread for September 18 matched all seven assets' settlement sums, means, counts and first/last timestamps. HYPE had six settlements that day; the others had three. No fixed three-settlement multiplier is used. See [coverage](release-2026-09-20/funding-coverage.json) and [source comparison](release-2026-09-20/funding-source-check.json).
- The [weekly research run 35510956428](https://github.com/chiduwa/frontiercapitalsignals/actions/runs/35510956428) completed successfully, including all eight named stablecoins, CMC100, per-asset regressions and D1 publication. The earlier attempt hit a CoinGecko 429 on USDG and correctly refused an incomplete basket. Bounded retries and slower requests fixed that run; session/calendar publication is now independent of volume-feed success.
- The public payload generated at **12:49:18 UTC** contains September 20 session, calendar and stablecoin summaries. A live render check at **12:51:05 UTC** verifies all four panels without script errors ([render evidence](release-2026-09-20/live-render.json)): sessions, weekday peaks/bottoms and jumps/dumps, stablecoin research, and move explanations. The page health check passed 18 checks with no warnings/failures. This uses JSDOM against fetched production content; an interactive browser was unavailable.
- Regression suites passed: 82 dashboard assertions; 19 Python study tests; worker, health, derivatives, model and storage checks. The default-disabled experimental case is intentionally skipped in the default suite and tested separately with the feature enabled. The two worker source files match.

## What remains research-only

No stablecoin flow rule qualified in the September 20 rerun's 1,359-comparison family. The holdout CMC100 down frequency was 50.4%; after basket volume increased more than 10%, it was 52.4% across 42 observations, versus 50.0% across 36 observations after a decrease greater than 10%. The basket's future-return correlation was −0.007. These small descriptive differences are insufficient evidence of a leading signal. Unsigned turnover does not identify net selling into stablecoins.

The corrected per-asset models, morning/session rules, lead/lag candidates and calendar effects remain research-only. Magnitude and direction are evaluated separately; a magnitude estimate never supplies a direction vote. Retrospective winners require frozen prospective validation before promotion. The September 19 frozen reports retain their original cutoff and numbers; new runs have their own manifests and hashes.

Move explanations distinguish observations from interpretations. Price/OI changes can be consistent with a squeeze but cannot prove forced liquidation or predict persistence. The optional authenticated CoinMarketCap liquidation feed is **not configured**. CMC's public market index is available and used in research; an authenticated subscription is not required for the deployed core features. No liquidation amount, causal narrative or liquidation level is invented when that source is absent.

## Remaining quality and operational work

1. Observe two normal daily and two weekly collection cycles. A repaired manual run establishes current functionality, not lasting provider availability. Health checks retain visible stale/unavailable states; incomplete baskets cannot replace complete evidence.
2. Reconcile seven flagged legacy Yahoo OHLC rows (XLM 4, HBAR 2, XRP 1), preserving raw provenance. The [D1 proof](release-2026-09-20/d1-proof.json) lists their dates and values. Do not silently alter closes to fit highs/lows. Close-based research does not automatically quarantine every OHLC inconsistency; inspect feature-specific exposure before promotion. HYPE also has shorter, less current aligned price history and insufficient weekday development samples.
3. Collect prospective first-seen stablecoin volumes and longer clean derivative histories. Retrospectively retrieved provider histories can be revised; an availability embargo does not remove revision risk.
4. Configure a licensed liquidation source only if event-level coverage is needed, then validate units, timestamps, exchange coverage and subsequent persistence before making stronger squeeze claims.
5. Expand one asset at a time using [PREDICTION_ROADMAP.md](PREDICTION_ROADMAP.md), retaining chronological splits, costs, multiple-testing controls, source compatibility and explicit missing-data states. No finite model catalog is exhaustive.

Raw workflow evidence and manifests are retained for 90 days in [the successful run artifact](https://github.com/chiduwa/frontiercapitalsignals/actions/runs/35510956428/artifacts/10605262319). Export longer-lived inputs before that retention expires if the next study needs the exact revised-history vintage.

The September 20 published reports are also frozen here: [sessions](release-2026-09-20/session-report.md), [calendar and weekdays](release-2026-09-20/calendar-report.md), and [stablecoin regressions](release-2026-09-20/stable-basket-report.md), with adjacent machine-readable JSON.

The release was committed from an isolated worktree to preserve unrelated local trading changes. The original workspace retains its existing branch/index and working changes; fetch and reconcile against `origin/main` before creating a follow-up release. Do not blindly reset that workspace.
