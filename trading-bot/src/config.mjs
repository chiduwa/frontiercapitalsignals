// All tunable risk/behavior parameters in one place, env-overridable so
// the deployed bot can be retuned without a code change. Every numeric
// default here reflects an explicit user instruction (see README) except
// where noted.
const num = (v, d) => (v == null || v === '' ? d : Number(v));
const bool = (v, d) => (v == null || v === '' ? d : v === 'true' || v === '1');

const { BINANCE_API_KEY, BINANCE_API_SECRET, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID } = process.env;

// Same D1 database the rest of this repo's scripts already write to —
// state.mjs uses it since this bot runs as a one-shot GitHub Actions
// script with no local disk that survives between cycles (see
// .github/workflows/trading-bot-cycle.yml).
for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}

// DRY_RUN defaults true on purpose: this is an autonomous, leveraged,
// real-money system. It should never place a real order until someone
// deliberately sets DRY_RUN=false after reviewing what it WOULD have
// done (dry-run logs every decision exactly as if it were live).
const DRY_RUN = bool(process.env.DRY_RUN, true);

// Required even in dry-run: dry-run still reads REAL account balance/
// positions/prices so the simulation is realistic (it only skips the
// mutating calls — order placement, leverage changes). A key/secret pair
// only needs trade + read permission, never withdrawal — see README.
if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
  console.error('BINANCE_API_KEY/BINANCE_API_SECRET are not set. Required even for DRY_RUN=true (used for read-only account/position/price data). Generate a TRADE-ONLY key (withdrawal permission OFF) — see README.');
  process.exit(1);
}

export const config = {
  dryRun: DRY_RUN,
  binanceApiKey: BINANCE_API_KEY,
  binanceApiSecret: BINANCE_API_SECRET,
  binanceBase: process.env.BINANCE_FAPI_BASE || 'https://fapi.binance.com',

  cloudflareApiToken: CLOUDFLARE_API_TOKEN,
  cloudflareAccountId: CLOUDFLARE_ACCOUNT_ID,
  d1DatabaseId: FCS_D1_DATABASE_ID,

  signalsBase: process.env.SIGNALS_API_BASE || 'https://frontiercapitalsignals.com/signals',

  // Position sizing: margin committed per trade, as a fraction of account
  // balance. User: "trade a percentage of the portfolio (5 to 20%) per
  // trade... based on confidence and reliability levels."
  minPositionPct: num(process.env.MIN_POSITION_PCT, 0.05),
  maxPositionPct: num(process.env.MAX_POSITION_PCT, 0.20),
  // Hard ceiling on ALL open positions combined. User: "all open trades
  // not exceeding 50% of the balance/portfolio."
  maxTotalExposurePct: num(process.env.MAX_TOTAL_EXPOSURE_PCT, 0.50),

  // Leverage: "3x to 20x leverage based on confidence and reliability
  // levels."
  minLeverage: num(process.env.MIN_LEVERAGE, 3),
  maxLeverage: num(process.env.MAX_LEVERAGE, 20),

  // Confidence gating: conf.agree/conf.total (technique agreement) and
  // topIndicator.accuracy (that asset's single best-performing technique's
  // own live track record) both have to clear this before the bot
  // considers a candidate at all — this IS the "patience" instruction:
  // don't trade every signal, only ones with real conviction behind them.
  minConfidenceRatio: num(process.env.MIN_CONFIDENCE_RATIO, 0.55),
  minTopIndicatorAccuracy: num(process.env.MIN_TOP_INDICATOR_ACCURACY, 0.55),

  // Range-position entry gate. rangePos is already computed by the live
  // engine (0 = at the predicted range's low end, 1 = at the high end).
  // User: "buys when the asset is closer to the lower predicted range and
  // sells when its closer to the upper [range]."
  entryLowRangePos: num(process.env.ENTRY_LOW_RANGE_POS, 0.25),
  entryHighRangePos: num(process.env.ENTRY_HIGH_RANGE_POS, 0.75),

  // Fear & Greed extreme-reversal conditioning, exact thresholds from the
  // user's own spec: "goes harder, holds the buy a bit longer with a bit
  // of a higher leverage whenever fear and greed is around or below 15
  // and there seems to be a reversal... vice versa (sell when fear and
  // greed is above 85, peaked and its reversing)." "Reversal" is read as
  // the intraday signal's own bottomed/peaked flags (proximity to a real
  // 24h extreme), not its `dir` field — see signals.mjs for why dir is
  // deliberately NOT used as a trade trigger.
  fearGreedExtremeLow: num(process.env.FEAR_GREED_EXTREME_LOW, 15),
  fearGreedExtremeHigh: num(process.env.FEAR_GREED_EXTREME_HIGH, 85),
  extremeAggressionBoost: num(process.env.EXTREME_AGGRESSION_BOOST, 1.25), // multiplier on size/leverage when the extreme+reversal condition fires, still hard-capped at max/max
  extremeHoldMultiplier: num(process.env.EXTREME_HOLD_MULTIPLIER, 1.5), // "holds the buy a bit longer" — multiplies the normal target-hold/cooldown window

  // Risk management not explicitly specified by the user but necessary
  // for an unattended leveraged system — see README's "added on top of
  // your spec" section.
  stopLossMarginFraction: num(process.env.STOP_LOSS_MARGIN_FRACTION, 0.5), // stop when unrealized loss reaches this fraction of the margin committed to that trade
  cooldownMinutes: num(process.env.COOLDOWN_MINUTES, 60), // minimum gap after closing a symbol before re-entering it — avoids fee/slippage churn
  circuitBreakerDrawdownPct: num(process.env.CIRCUIT_BREAKER_DRAWDOWN_PCT, 0.15), // pause NEW entries (existing positions still managed) if equity drawdown from peak exceeds this
  dailyLossLimitPct: num(process.env.DAILY_LOSS_LIMIT_PCT, 0.10), // pause new entries for the rest of the day if realized+unrealized loss since day-start exceeds this
  maxFundingRateAbs: num(process.env.MAX_FUNDING_RATE_ABS, 0.001) // skip entry if funding is this unfavorable or worse against the intended direction (0.001 = 0.1% per 8h)
};
