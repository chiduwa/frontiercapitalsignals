# Calendar, stablecoin and move-explanation extension — 2026-09-19

> **Release update, 2026-09-20:** the broader worker, data-integrity fixes, research workflows and four research/explanation panels are deployed. Migrations 0043–0045 are applied; Oracle funding/OI writes are restored, all seven favorites are pinned in the OI sampler, and 14,630 canonical funding days were backfilled; settlement spot-checks passed for each asset. New model candidates remain research-only. See [release verification and remaining limits](RELEASE_VERIFICATION_2026_09_20.md).


Implemented, tested and released for BTC, ETH, SOL, XLM, XRP, HYPE and HBAR.
These additions are research and explanatory context, not new trading signals.
The numerical study below preserves the September 19 frozen experiment;
subsequent scheduled reports carry their own cutoff, versions and input hashes.

## What the timing evidence supports

The first session study found larger weekday moves around 09:00–12:00 Eastern
for the six spot assets; HYPE's selected hours were 09:00, 10:00 and 12:00.
This is an activity result, not a direction forecast. All timestamps use
`America/New_York`, including daylight-saving changes. The new study uses
complete local days, requiring 23/24/25 hourly candles as appropriate. Tied
extremes split their probability weight instead of double-counting a day.

The three-hour windows below were selected using development history through
2025, then counted in 260 completed 2026 holdout days. HYPE uses perpetual
prices, while the other assets use Binance spot. The hour contains the extreme;
we cannot infer the exact minute from hourly candles.

| Asset | Selected peak window ET | Holdout fraction | Selected bottom window ET | Holdout fraction |
|---|---|---:|---|---:|
| BTC | 09:00–12:00 | 16.3% | 00:00–03:00 | 21.2% |
| ETH | 00:00–03:00 | 19.2% | 00:00–03:00 | 21.5% |
| SOL | 00:00–03:00 | 19.6% | 00:00–03:00 | 20.0% |
| XLM | 00:00–03:00 | 21.6% | 00:00–03:00 | 20.4% |
| XRP | 00:00–03:00 | 16.7% | 00:00–03:00 | 22.5% |
| HYPE | 00:00–03:00 | 20.0% | 21:00–24:00 | 16.2% |
| HBAR | 00:00–03:00 | 21.0% | 00:00–03:00 | 18.3% |

**A 20% fraction is not “usually.”** Near-midnight concentrations can arise
from the arbitrary boundary of a daily window. Both the peak and bottom can
have the same most frequent window across different days. No live peak/bottom
is known until the day ends.

The page now has expandable Monday–Sunday rows for each asset, showing counts,
peak/bottom windows, and large-jump/dump frequencies. Thresholds are each
asset's development 95th percentile excursion from its NY opening price, with
a minimum 3%. For BTC these are +5.60% and −5.22%, respectively. The study
compares each weekday with the other six within complete calendar weeks.
**No weekday-specific peak, bottom, jump or dump effect survived the 210-test
Holm correction.** Weekday activity can still replicate without a weekday
extreme/event effect. HYPE has insufficient development observations for
separate weekday tests; this is displayed rather than filled with guesses.

See [all weekday tables](research-2026-09-19/calendar-report.md) and
[intervals and comparisons](research-2026-09-19/calendar-report.json).
The prior [morning/session study](research-2026-09-19/session-report.md)
separates an 08:00–10:00 move's association with the full-day close from returns
actually earned after 10:00. None of those rules earned promotion either.

## Exact eight-stablecoin theory

The dataset contains **364 complete daily midnight observations per coin**
from September 20, 2025 through September 18, 2026, for all eight requested
stablecoins plus eleven major cryptos. Exact provider IDs are frozen in the
input artifact: USDT/tether, USDC/usd-coin, USDe/ethena-usde, DAI/dai,
USD1/usd1-wlfi, USDG/global-dollar, PYUSD/paypal-usd and RLUSD/ripple-usd.

The earlier statement that only 18 complete global-volume days were available
referred to the project's D1 first-seen archive. The new 364-point series is
**retrospectively retrieved provider history**, which can contain revisions;
it is not a replacement for collecting first-seen vintages going forward.
CoinGecko documents its historical volumes as rolling 24-hour observations and
its long-history prices as midnight samples. The experiment delays entry by a
full day after the feature snapshot before measuring the following 24-hour
return, so the snapshot's publication delay cannot leak that target return.
[CoinGecko measurement and timing documentation](https://docs.coingecko.com/reference/coins-id-market-chart).

Tested per asset, CMC100 and the median return of the seven tracked assets:

- Each stablecoin separately, the full eight-coin basket and USDT/USDC/DAI core.
- Volume growth over 1, 3 and 7 days; additional delays of 0, 1, 3 and 7 days.
- Basket volume relative to eleven major cryptos and relative to basket market cap.
- Logistic direction, signed multiple ridge regression and absolute-move ridge
  regression, with separate selection on earlier validation data.
- Controls for own lagged returns, volatility, own/major-crypto volume changes
  and available Binance BTC/ETH/SOL aggressive selling imbalance. Training,
  validation and outer evaluation are ordered and purge unmatured outcomes.

There are 119 outer evaluation observations per target. No comparison survives
correction across **1,359 formal tests**, using paired seven-day block bootstrap
samples. Signed-return basket regressions worsen error against the corresponding
controlled regression for every tracked asset and CMC100. Direction improvements
are small, inconsistent and unconfirmed. Magnitude regressions fail to beat the
simple median reliably. No stablecoin feature is added to live votes.

For CMC100, the unconditional down frequency was **51.3%**. After full-basket
volume rose at least 10%, the later down frequency was **52.4% (42 cases)**.
After volume fell at least 10%, it was **51.4% (35 cases)**. The latter does not
support the proposed inverse relationship either. The full-basket correlation
with subsequent market return was approximately **−0.003**. Individual-coin
conditional percentages and correlations are in the report; none establishes
a reliable leading indicator after controls and correction.

Unsigned volume does not distinguish cashing out from buying crypto, arbitrage,
market making or transfers between stablecoins. The same trade can contribute
to the reported volume of both a crypto and its stablecoin quote. Thus a ratio
of aggregated asset volumes is an activity feature, not a net cash-flow measure.

See [readable results](research-2026-09-19/stable-basket-report.md),
[full regression metrics and explanatory coefficients](research-2026-09-19/stable-basket-report.json),
and the frozen inputs/predictions listed in
[the artifact manifest](research-2026-09-19/stable-basket-artifacts.json).

## Move explanations and CoinMarketCap

The new panel separates observed data, interpretation and conditions to watch.
It uses an aligned, continuous one-hour contract-quantity OI/mark-price window.
It refuses stale data, future observations, missing endpoints and interior
gaps. Dollar OI is not substituted for quantity: price changes mechanically
change dollar notional even without new contracts.

Examples of permitted statements:

- Price rises while contract OI falls: consistent with position closing,
  including possible short covering. This alone cannot identify forced
  liquidations or predict fading momentum.
- Verified short liquidations coincide with a rise: forced buying was present;
  it does not prove the sole cause or a subsequent reversal.
- Price closes beyond a completed 20-day range: monitor participation and a
  retest. These conditions carry no invented probability or trade recommendation.

Levels use actual OHLC highs/lows where available; closing samples are labeled
**closing highs/lows**. Stale or insufficient levels are withheld. The attached
screenshots' Fed/ETF/causal claims were not treated as verified evidence.
No legacy assumed “recovery percentage” is used.

CMC is **not necessary** for the timing or eight-stablecoin tests. Its public
CMC100 endpoint was successfully queried without an API key and supplies 366
benchmark observations in the frozen artifact. We implemented that integration.
[Official keyless API documentation](https://coinmarketcap.com/api/documentation/pro-api-reference/keyless-public-api.md).

An optional authenticated CMC liquidation collector/parser is also implemented.
It records rolling-hour long/short/total USD amounts with provider timestamps
and validates totals, IDs and freshness. An omitted coin is treated as unknown,
not zero: CMC can omit coins with no tracked derivatives or no reported
liquidations. That endpoint was **not live-tested with an authenticated key**;
no account or subscription was purchased. Actual entitlement must be tested
before promising coverage. Configure `CMC_API_KEY` as a GitHub Actions secret
only when an authorized account is available. Provider failure leaves the panel
explicitly unavailable without affecting trading votes.
[Official liquidation endpoint](https://pro.coinmarketcap.com/api/documentation/pro-api-reference/derivatives/latest-liquidations-by-cryptocurrency.md).

Hourly rolling liquidation snapshots are context, not an exhaustive event tape.
They cannot reconstruct liquidation levels or prove momentum persistence. A
later event study needs high-frequency forced-order data, exchange coverage,
aligned spot imbalance/depth, subsequent returns and prospective validation.

## September 19 incident history (resolved September 20)

The following incident description records the original audit. The current
collector and release status is in the linked release verification above.

Read-only SSH inspection succeeded on Oracle instance `fcs-trading-bot`.
`fcs-binance-collector.timer` and `fcs-oi-sampler.timer` are active, and Binance
is reachable. Both services fail when accessing D1. Cloudflare's token-verification
endpoint returns **HTTP 401, Invalid API Token** for the configured credential.
Earlier logs show authorization failures followed by authentication failures.
The latest OI data are September 14 (23:59 UTC for six assets, 23:44 for HBAR).
This is an authentication failure, not a missed systemd timer or a Binance block.

A valid scoped credential must be installed securely in the existing environment
file before a service restart can restore writes. Do not paste tokens into chat
or logs. No credential was changed, copied to another host, or printed. The
shared trading environment and all trading/order services remain unchanged.
A [real D1 read-only explanation check](research-2026-09-19/live-insights-check.json)
correctly withheld current positioning narratives for all seven assets.

The health checker now detects a missing/lagged OI collector separately from a
fresh model/price payload, and warns on research older than ten days. The funding
collector exits nonzero on partial source/write failures, so systemd cannot
report success for that failure case. Funding percentiles now require the same
venue **and contract**, with at least twenty completed observations; unknown
legacy instruments do not calibrate a new instrument.

Release instructions, remaining experiments and expansion to other assets are
in [PREDICTION_ROADMAP.md](PREDICTION_ROADMAP.md). No new model is promoted on
these retrospective results.


## Verification completed

- Real historical studies ran against the checked hourly panel and exact named
  stablecoin history. Frozen results report 210 calendar comparisons and 1,359
  stablecoin comparisons, with no qualifying new extrema/event or flow rule.
- 82 dashboard assertions pass, including rendering the actual seven-asset
  calendar report and nine-target stablecoin summary and withholding a narrative
  when live OI is missing.
- 19 Python tests pass across the original model, session and new calendar/basket
  studies. These check DST completeness, tied extrema, missing basket volumes,
  future-feature invariance, availability embargo, matured-label model selection,
  majority-return construction and reproducible corrected inference.
- New JavaScript data/context checks pass, including raw liquidation validation,
  absent-source handling, OI contract alignment/gaps, completed levels,
  idempotent SQLite storage and independently versioned summaries. Existing model,
  derivative, regression, worker and health checks pass; the default-disabled
  experimental feature case is intentionally skipped in the default model suite;
  a separate enabled-feature run passes all 20 hierarchical tests.
- Full schema plus migration replay passes in SQLite. Worker source mirrors match,
  syntax/diff checks pass, and compressed artifact and research-code hashes match.
- Production D1 was queried read-only to test explanation withholding. Oracle
  timers, service definitions, errors and token validity were inspected read-only.
  The subsequent release verified the repaired collector write path against
  production and Binance. Authenticated CMC liquidations remain unconfigured;
  local parser tests do not establish that live feed is operational.
