// Spot accumulation bot — configuration.
//
// Deliberately a separate process and a separate Binance API key from the
// futures bot. Same host, but a bug or a leaked key in the leveraged path
// must not be able to touch spot holdings.
//
// The strategy is conditional DCA: a scheduled tranche that is only spent
// when the asset has actually fallen by its OWN measured standard, and is
// otherwise banked as dry powder for a later, larger buy. Every threshold
// below is either a portfolio-policy choice or is derived per-asset from
// measured history — none of them is a price forecast.
const num = (v, d) => (v == null || v === '' ? d : Number(v));
const bool = (v, d) => (v == null || v === '' ? d : v === 'true' || v === '1');

const { BINANCE_SPOT_API_KEY, BINANCE_SPOT_API_SECRET, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID } = process.env;

for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
if (!BINANCE_SPOT_API_KEY || !BINANCE_SPOT_API_SECRET) {
  console.error('BINANCE_SPOT_API_KEY/BINANCE_SPOT_API_SECRET are not set. Required even for DRY_RUN=true (balances and prices are read live). Generate a SPOT key with Spot Trading + Reading, withdrawals OFF, restricted to this host\'s IP.');
  process.exit(1);
}

export const config = {
  dryRun: bool(process.env.SPOT_DRY_RUN, true),
  apiKey: BINANCE_SPOT_API_KEY,
  apiSecret: BINANCE_SPOT_API_SECRET,
  base: process.env.BINANCE_SPOT_BASE || 'https://api.binance.com',

  cloudflareApiToken: CLOUDFLARE_API_TOKEN,
  cloudflareAccountId: CLOUDFLARE_ACCOUNT_ID,
  d1DatabaseId: FCS_D1_DATABASE_ID,
  signalsBase: process.env.SIGNALS_API_BASE || 'https://frontiercapitalsignals.com/signals',

  quoteAsset: process.env.SPOT_QUOTE_ASSET || 'USDT',

  // --- Schedule -----------------------------------------------------------
  // Days between tranches. 7 = weekly, 14 = bi-weekly. The timer fires daily;
  // this is what actually decides whether a cycle is a tranche cycle, so the
  // cadence survives a missed firing instead of silently skipping a period.
  tranchePeriodDays: num(process.env.SPOT_TRANCHE_PERIOD_DAYS, 7),

  // --- Size ---------------------------------------------------------------
  // Fraction of the free quote balance per tranche. A percentage rather than
  // a fixed sum so it scales with the account and can never over-commit.
  tranchePct: num(process.env.SPOT_TRANCHE_PCT, 0.05),
  // Unspent tranches pool as dry powder so a skipped week is deferred rather
  // than lost. Capped, because unbounded carry would concentrate an ever
  // larger share of the account into one fill — which is the opposite of what
  // averaging is for.
  maxCarryTranches: num(process.env.SPOT_MAX_CARRY_TRANCHES, 2),

  // Sleeve weights. The satellite sleeve is deliberately the smaller one: the
  // engine's long-term-bottom detector explicitly makes no claim about which
  // candidates succeed, so that exposure is unvalidated by construction.
  coreWeight: num(process.env.SPOT_CORE_WEIGHT, 0.75),
  coreCount: num(process.env.SPOT_CORE_COUNT, 7),
  satelliteCount: num(process.env.SPOT_SATELLITE_COUNT, 3),
  // An asset ranked beyond this by market cap counts as satellite.
  satelliteMinMcapRank: num(process.env.SPOT_SATELLITE_MIN_MCAP_RANK, 40),

  // --- Buy triggers (per-asset, measured) ---------------------------------
  // "A significant drop": how far below the last completed weekly close the
  // price must sit, expressed in standard deviations of THAT asset's own
  // weekly return distribution. A fixed percentage would mean something
  // completely different for BTC than for a low-cap.
  dropSigmas: num(process.env.SPOT_DROP_SIGMAS, 1.0),
  // "The projected weekly low has been reached": the median drawdown from
  // weekly open to weekly low, measured over the trailing window. Reaching it
  // is an observation about this week, not a forecast about next week.
  weeklyLowQuantile: num(process.env.SPOT_WEEKLY_LOW_QUANTILE, 0.5),
  // Weeks of history required before an asset may be traded at all. Below
  // this there is no distribution to measure a "significant" drop against.
  minWeeksHistory: num(process.env.SPOT_MIN_WEEKS_HISTORY, 12),
  klineWeeks: num(process.env.SPOT_KLINE_WEEKS, 52),

  // --- Guards -------------------------------------------------------------
  // Never spend below this many quote units in one order; Binance rejects
  // dust and fees would dominate anyway. Real per-symbol minimums come from
  // exchangeInfo and override this upward.
  minOrderQuote: num(process.env.SPOT_MIN_ORDER_QUOTE, 10),
  // Leave this much of the balance untouched as a floor.
  reserveQuote: num(process.env.SPOT_RESERVE_QUOTE, 0),
  // Accumulate only. There is no sell path in this bot: an exit needs a
  // directional or valuation call, and the engine withholds both. Wiring one
  // now would mean inventing thresholds, which is the practice the v7 audit
  // removed. Kept as an explicit flag so the absence is a decision on record.
  sellEnabled: false
};
