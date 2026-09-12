// Assembles every non-price data source into per-symbol, per-date feature
// lookups that the cross-sectional fit can read alongside asset_daily_bars.
//
// This is the piece that makes the new data ACTUALLY LEARNED FROM rather than
// merely archived. The XS lane already is the learning module — Fama-MacBeth
// fit, Bonferroni gate, sign consistency, forecast logging, maturity scoring,
// decile evidence, publication gate — but archiveMetrics() could only see
// asset_daily_bars, so open interest, supply and liquidity had no way in. They
// do now, and they are judged by exactly the same evidence bar as every price
// feature: nothing here is trusted because it sounds economically sensible.
//
// A NOTE ON WHAT CANNOT BE AN XS FEATURE
//
// Chain TVL, stablecoin supply and Bitcoin network cost are GLOBAL series: on
// any given date every asset shares the same value, so their cross-sectional
// rank is undefined and a rank regression cannot use them. They are regime
// CONDITIONERS (does the OI signal behave differently when stablecoin supply
// is expanding?), which is a different mechanism, and they are exposed here as
// a date-keyed context series rather than smuggled into the per-asset panel
// where they would contribute nothing but a wider multiple-testing correction.
import { assetDerivFeatures } from './derivatives-features.mjs';

// Backward-looking percent change over `days`, located by DATE with a small
// tolerance. Never index-stepped.
const iso = (t) => new Date(t * 86400000).toISOString().slice(0, 10);
const dayNum = (d) => Date.parse(`${d}T00:00:00Z`) / 86400000;

export function changeOver(series, date, days, tolerance = 3) {
  const now = series.get(date);
  if (!(now > 0)) return null;
  const target = dayNum(date) - days;
  for (let k = 0; k <= tolerance; k++) {
    for (const sign of (k === 0 ? [0] : [-1, 1])) {
      const then = series.get(iso(target + sign * k));
      if (then > 0) return ((now / then) - 1) * 100;
    }
  }
  return null;
}

function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r[key])) out.set(r[key], []);
    out.get(r[key]).push(r);
  }
  return out;
}

// Per-symbol Map<date, features> for derivatives.
export function buildDerivLookup(derivRows, priceBySymbol) {
  const out = new Map();
  for (const [symbol, rows] of groupBy(derivRows, 'symbol')) {
    const prices = priceBySymbol.get(symbol) || new Map();
    out.set(symbol, new Map(assetDerivFeatures(rows, prices).map((f) => [f.date, f])));
  }
  return out;
}

// Per-symbol Map<date, features> for supply.
//
// Captures burns as well as dilution, which a one-directional "dilution"
// metric could not: supply_change_30d is NEGATIVE when tokens are burned or
// re-locked, and float_ratio (circulating / total) separates the two cases —
// a burn shrinks circulating AND total, a lockup shrinks only circulating.
export function buildSupplyLookup(supplyRows) {
  const out = new Map();
  for (const [symbol, rows] of groupBy(supplyRows, 'symbol')) {
    const sorted = rows.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const circ = new Map(sorted.map((r) => [r.date, r.circulating_supply]));
    const total = new Map(sorted.map((r) => [r.date, r.total_supply]));
    const perDate = new Map();
    for (const r of sorted) {
      const c = r.circulating_supply, t = r.total_supply, m = r.max_supply;
      const chg30 = changeOver(circ, r.date, 30);
      const chg90 = changeOver(circ, r.date, 90);
      const totalChg30 = changeOver(total, r.date, 30);
      perDate.set(r.date, {
        // Realized float change. Positive = unlocks/emission, negative = burn
        // or lockup.
        supply_change_30d: chg30,
        supply_change_90d: chg90,
        // Total supply shrinking is an actual BURN (tokens destroyed), as
        // opposed to float merely being withdrawn from circulation.
        burn_rate_30d: totalChg30 != null ? -totalChg30 : null,
        // Circulating falling while total holds means supply was LOCKED, not
        // destroyed — staking, vesting re-locks, treasury withdrawal.
        lockup_rate_30d: (chg30 != null && totalChg30 != null) ? (totalChg30 - chg30) : null,
        // How much of the eventual supply is already liquid. Low float with a
        // large overhang is the classic unlock-pressure setup.
        float_ratio: (c > 0 && t > 0) ? c / t : null,
        supply_overhang: (c > 0 && t > 0) ? ((t - c) / c) * 100 : null,
        supply_pct_of_max: (c > 0 && m > 0) ? (c / m) * 100 : null
      });
    }
    out.set(symbol, perDate);
  }
  return out;
}

// Per-symbol Map<date, features> for order-book liquidity.
export function buildLiquidityLookup(liqRows, derivLookup) {
  const out = new Map();
  for (const [symbol, rows] of groupBy(liqRows, 'symbol')) {
    const sorted = rows.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const depth = new Map(sorted.map((r) => [r.date, r.depth_1pct_usd]));
    const perDate = new Map();
    for (const r of sorted) {
      const d = derivLookup.get(symbol)?.get(r.date);
      perDate.set(r.date, {
        book_imbalance_1pct: r.book_imbalance_1pct,
        book_imbalance_5pct: r.book_imbalance_5pct,
        log_depth_1pct: r.depth_1pct_usd > 0 ? Math.log(r.depth_1pct_usd) : null,
        depth_change_7d: changeOver(depth, r.date, 7),
        // Depth relative to leverage outstanding: how thin the book is against
        // the positions that might have to exit through it. A crowded,
        // thinly-backed book is the liquidation-cascade setup.
        depth_to_oi: (r.depth_1pct_usd > 0 && d && d.oi_usd > 0) ? r.depth_1pct_usd / d.oi_usd : null
      });
    }
    out.set(symbol, perDate);
  }
  return out;
}

// Date-keyed GLOBAL context. Not per-asset, so not an XS feature — see the
// header. Exposed for regime conditioning and for market-wide reporting.
export function buildContextSeries(chainRows, networkRows) {
  const byDate = new Map();
  const stable = new Map(), tvl = new Map();
  for (const r of chainRows) {
    if (r.metric === 'stablecoin_mcap' && r.chain === 'ALL') stable.set(r.date, r.value);
    else if (r.metric === 'tvl') tvl.set(r.date, (tvl.get(r.date) || 0) + r.value);
  }
  const dates = new Set([...stable.keys(), ...tvl.keys(), ...networkRows.map((r) => r.date)]);
  const net = new Map(networkRows.map((r) => [r.date, r]));
  for (const date of [...dates].sort()) {
    const n = net.get(date);
    byDate.set(date, {
      date,
      stablecoin_mcap: stable.get(date) ?? null,
      stablecoin_chg_30d: changeOver(stable, date, 30),
      total_tvl: tvl.get(date) ?? null,
      tvl_chg_30d: changeOver(tvl, date, 30),
      btc_hashrate: n?.hashrate ?? null,
      btc_difficulty: n?.difficulty ?? null,
      // Income per unit of work. A cost-basis PROXY, not a dollar cost per
      // coin: electricity price and rig efficiency are not in this data and
      // are deliberately not guessed at. Falling revenue-per-hash is miner
      // margin compression, which historically precedes capitulation selling.
      btc_revenue_per_hash: (n?.miners_revenue_usd > 0 && n?.hashrate > 0)
        ? n.miners_revenue_usd / n.hashrate : null,
      btc_transactions: n?.transactions ?? null
    });
  }
  return byDate;
}

// Feature ids contributed to XS_FEATURES by each family, so the correction
// counts exactly what was searched.
export const FUNDAMENTAL_FEATURE_IDS = [
  // derivatives
  'oi_chg_1d', 'oi_chg_3d', 'oi_px_divergence', 'oi_level_pct_roll', 'toptrader_ls', 'all_account_ls',
  // supply
  'supply_change_30d', 'burn_rate_30d', 'lockup_rate_30d', 'float_ratio', 'supply_overhang',
  // liquidity
  'book_imbalance_1pct', 'log_depth_1pct', 'depth_change_7d', 'depth_to_oi'
];
