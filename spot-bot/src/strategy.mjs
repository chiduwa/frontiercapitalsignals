// Pure decision layer for spot accumulation: which assets, whether this is a
// tranche cycle, whether an asset's own history says now is a buy, and how
// much. No I/O — index.mjs supplies the data and executes the result.
//
// The organising principle, and the reason this bot can run while the futures
// bot cannot: **none of this makes a directional forecast.** Selection uses
// only descriptive measures the engine publishes; the buy triggers are
// observations about what price has already done, measured against each
// asset's own distribution. Nothing here consumes a withheld directional call
// or invents one from a screen.
import { config } from './config.mjs';

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
};

const stdev = (xs) => {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
};

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

// Ranks the tradable universe into a core and a satellite sleeve.
//
// Permitted inputs, all descriptive and published even while the engine
// withholds direction: the cross-sectional `quality` percentile, market-cap
// rank, and membership of the `longTermPotential` board (the engine's "is this
// asset currently near a fresh multi-month/year low" measurement, which
// explicitly makes no claim about which candidates succeed).
//
// Explicitly NOT used: dir, score, confidence, or board membership in
// breakout/breakdown. Those are screen or forecast outputs; letting them pick
// accumulation targets would smuggle a withheld call in through the back door.
export function selectAssets(payload, spotTradable, opts = {}) {
  const coreCount = opts.coreCount ?? config.coreCount;
  const satelliteCount = opts.satelliteCount ?? config.satelliteCount;
  const quote = opts.quoteAsset ?? config.quoteAsset;

  const crypto = payload?.crypto || {};
  const boards = [...(crypto.breakout || []), ...(crypto.breakdown || []),
    ...(crypto.favorites || []), ...(crypto.longTermPotential || [])];

  const nearLow = new Set((crypto.longTermPotential || []).map((r) => r.symbol));
  const seen = new Map();
  for (const row of boards) {
    if (!row || !row.symbol || seen.has(row.symbol)) continue;
    const symbol = `${row.symbol}${quote}`;
    // Must actually be buyable here. A signals symbol with no Binance spot
    // pair is not a candidate, however promising it looks.
    if (!spotTradable[symbol]) continue;
    const quality = row.quality && Number.isFinite(row.quality.score) ? row.quality.score : null;
    if (quality == null) continue; // no published quality percentile, no ranking basis
    seen.set(row.symbol, {
      symbol, signalSymbol: row.symbol, name: row.name || row.symbol,
      quality, mcapRank: Number.isFinite(row.mcapRank) ? row.mcapRank : 9999,
      nearMultiMonthLow: nearLow.has(row.symbol), price: row.price ?? null
    });
  }

  const all = [...seen.values()];
  // Being near a genuine multi-month low is a measured fact about price, and
  // it is the one thing that most directly serves "buy at the lowest", so it
  // breaks ties ahead of raw quality.
  const rank = (a, b) => (Number(b.nearMultiMonthLow) - Number(a.nearMultiMonthLow))
    || (b.quality - a.quality) || (a.mcapRank - b.mcapRank);

  const corePool = all.filter((a) => a.mcapRank <= config.satelliteMinMcapRank).sort(rank);
  const satellitePool = all.filter((a) => a.mcapRank > config.satelliteMinMcapRank).sort(rank);

  const core = corePool.slice(0, coreCount).map((a) => ({ ...a, sleeve: 'core' }));
  const satellites = satellitePool.slice(0, satelliteCount).map((a) => ({ ...a, sleeve: 'satellite' }));

  // Weights are per sleeve and equal within it. If a sleeve came up short,
  // its weight is NOT redistributed to the other: padding an unvalidated
  // satellite sleeve because the core screen was thin would be the opposite
  // of what the screen is for. The unallocated share simply stays in powder.
  const coreW = core.length ? (config.coreWeight / core.length) : 0;
  const satW = satellites.length ? ((1 - config.coreWeight) / satellites.length) : 0;
  return [
    ...core.map((a) => ({ ...a, weight: coreW })),
    ...satellites.map((a) => ({ ...a, weight: satW }))
  ];
}

// ---------------------------------------------------------------------------
// Buy triggers — measured per asset, never forecast
// ---------------------------------------------------------------------------

// Summarises an asset's own weekly behaviour from completed candles.
// `weeklySigma` is the dispersion a "significant" drop is judged against;
// `typicalDrawdown` is how far this asset usually falls from its weekly open
// to its weekly low, which is what "the projected weekly low" means here —
// a level this asset routinely reaches, not a prediction that it will.
export function weeklyProfile(klines, opts = {}) {
  const minWeeks = opts.minWeeksHistory ?? config.minWeeksHistory;
  if (!Array.isArray(klines) || klines.length < minWeeks + 1) {
    return { ok: false, reason: `only ${Array.isArray(klines) ? klines.length : 0} weekly candles, needs ${minWeeks + 1}` };
  }
  // The final candle is the in-progress week; it must shape no statistic.
  const completed = klines.slice(0, -1);
  const current = klines[klines.length - 1];

  const returns = [];
  for (let i = 1; i < completed.length; i++) {
    const prev = completed[i - 1].close, close = completed[i].close;
    if (prev > 0 && close > 0) returns.push(close / prev - 1);
  }
  const drawdowns = completed
    .filter((k) => k.open > 0 && k.low > 0)
    .map((k) => k.low / k.open - 1);

  const sigma = stdev(returns);
  const typicalDrawdown = quantile(drawdowns, opts.weeklyLowQuantile ?? config.weeklyLowQuantile);
  if (!(sigma > 0) || typicalDrawdown == null) {
    return { ok: false, reason: 'weekly history is degenerate (no dispersion to measure against)' };
  }
  return {
    ok: true,
    weeklySigma: sigma,
    medianWeeklyReturn: median(returns),
    typicalDrawdown,
    lastCompletedClose: completed[completed.length - 1].close,
    currentWeekOpen: current.open,
    weeks: completed.length
  };
}

// Decides whether to spend this asset's share now. Returns
// { buy: true, reason } or { buy: false, reason } — the reason is logged
// either way, so a skipped week is auditable rather than silent.
export function evaluateTrigger(price, profile, opts = {}) {
  if (!profile?.ok) return { buy: false, reason: profile?.reason || 'no weekly profile' };
  if (!(price > 0)) return { buy: false, reason: 'no price' };

  const dropSigmas = opts.dropSigmas ?? config.dropSigmas;
  const dropFromClose = price / profile.lastCompletedClose - 1;
  const threshold = -dropSigmas * profile.weeklySigma;
  if (dropFromClose <= threshold) {
    return {
      buy: true,
      trigger: 'significant-drop',
      reason: `down ${(dropFromClose * 100).toFixed(1)}% from last weekly close, past this asset's own ${dropSigmas}σ bar of ${(threshold * 100).toFixed(1)}%`
    };
  }

  const projectedLow = profile.currentWeekOpen * (1 + profile.typicalDrawdown);
  if (price <= projectedLow) {
    return {
      buy: true,
      trigger: 'weekly-low-reached',
      reason: `at ${price.toFixed(6)}, at or below this week's typical low of ${projectedLow.toFixed(6)} (median weekly drawdown ${(profile.typicalDrawdown * 100).toFixed(1)}% over ${profile.weeks}w)`
    };
  }

  return {
    buy: false,
    reason: `no trigger: ${(dropFromClose * 100).toFixed(1)}% from last close (needs ${(threshold * 100).toFixed(1)}%), price ${price.toFixed(6)} above typical weekly low ${projectedLow.toFixed(6)}`
  };
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

// The pool available this cycle: the scheduled tranche, plus one extra
// tranche for each whole period that elapsed without a buy.
//
// Derived from elapsed time rather than an accumulating stored balance. That
// is deliberate: this bot is fired several times a day so it can catch an
// intra-week dip, and an accumulator would grow on every *firing* while a
// tranche sat due rather than once per *period*. Computing it from the clock
// makes over-accumulation structurally impossible instead of merely unlikely.
//
// Capped, because unbounded deferral would concentrate an ever larger share
// of the account into a single fill — the opposite of what averaging is for.
export function tranchePool(quoteBalance, periodsElapsed, opts = {}) {
  const pct = opts.tranchePct ?? config.tranchePct;
  const reserve = opts.reserveQuote ?? config.reserveQuote;
  const maxCarry = opts.maxCarryTranches ?? config.maxCarryTranches;
  const spendable = Math.max(0, quoteBalance - reserve);
  const base = spendable * pct;
  // periodsElapsed of 1 means "due now, nothing missed"; 3 means two periods
  // went by with no trigger, so this cycle may spend three tranches' worth.
  const carryTranches = Math.min(Math.max(0, Math.floor(periodsElapsed) - 1), maxCarry);
  // Never commit more than is actually free, whatever the clock says.
  return { base, carryTranches, pool: Math.min(base * (1 + carryTranches), spendable) };
}

// Splits the pool across the assets that actually triggered.
//
// The naive split — pool x weight for every selected asset — is unusable at a
// small balance, and that is not a corner case: at $263 free, a 5% tranche is
// $13.17, which across 9 assets is $1.46 each against a Binance spot
// MIN_NOTIONAL of about $5. Every order would be rejected as dust, so the bot
// could never buy anything at all. Even at the 3x carry cap it is $4.39 each,
// still under the floor.
//
// So: fund as many of the triggered assets as the pool can actually cover at
// or above their own minimums, in rank order (core sleeve first), splitting
// the pool evenly among those funded. A small pool concentrates into one or
// two real buys instead of nine rejected ones; as the balance grows, k rises
// on its own and the allocation spreads back out across the full set. The
// sleeve intent survives because ranking decides who gets funded first.
//
// `minNotionalFor(symbol)` supplies each pair's own floor.
export function allocate(triggered, pool, minNotionalFor) {
  if (!Array.isArray(triggered) || !triggered.length || !(pool > 0)) return [];
  // Rank order: core before satellite, and within a sleeve the order selection
  // already produced (near-a-low, then quality, then market cap).
  const ordered = [...triggered].sort((a, b) =>
    (a.sleeve === b.sleeve ? 0 : a.sleeve === 'core' ? -1 : 1));

  for (let k = ordered.length; k >= 1; k--) {
    const share = pool / k;
    // Take the k highest-ranked assets that can each clear their OWN minimum
    // at this share -- skipping any whose floor is simply too high. Taking a
    // strict top-k instead would let one expensive-minimum pair at the top of
    // the ranking starve every affordable asset below it, funding nothing.
    const affordable = ordered.filter((a) => share >= minNotionalFor(a.symbol));
    if (affordable.length >= k) {
      return affordable.slice(0, k).map((a) => ({ ...a, quote: share }));
    }
  }
  return []; // the pool cannot fund even the single cheapest minimum
}

// Whole tranche periods elapsed since the last actual buy. 0 means not yet
// due; 1 means due; >1 means periods were skipped for want of a trigger.
export function periodsElapsed(lastTrancheAt, nowMs, opts = {}) {
  const period = (opts.tranchePeriodDays ?? config.tranchePeriodDays) * 86400000;
  if (!lastTrancheAt) return 1;
  const last = Date.parse(lastTrancheAt);
  if (!Number.isFinite(last)) return 1;
  return Math.floor((nowMs - last) / period);
}

// Is this cycle a tranche cycle? Driven by elapsed days rather than a cron
// expression so a missed firing delays the tranche instead of skipping it.
export function trancheDue(lastTrancheAt, nowMs, opts = {}) {
  return periodsElapsed(lastTrancheAt, nowMs, opts) >= 1;
}
