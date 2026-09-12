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
// `snapshotRows`    asset_supply_snapshot_daily — circulating, total and max as
//                   CoinGecko reports them. Captured by every hourly build at
//                   zero API cost, so it grows one date per day from 2026-09-12.
// `circulatingRows` asset_supply_daily — circulating derived as market_cap /
//                   price over a year of history, from the CoinGecko
//                   market_chart backfill.
//
// TWO SOURCES, DELIBERATELY NOT MERGED INTO ONE SERIES. Until 2026-09-12 this
// read snapshotRows alone, which on that date held 131 rows across ONE date —
// so supply_change_30d, supply_overhang, float_ratio, burn_rate_30d and
// lockup_rate_30d all fitted zero betas for their entire lifetime and dropped
// out as `untested`, while 45,532 rows of real supply history sat unread in the
// other table.
//
// The fix is to read both, not to concatenate them. The two circulating figures
// are computed differently — one reported, one derived from two rounded fields —
// so splicing them would put a step change at the join date and every 30-day
// difference spanning that seam would read it as an unlock. Differenced series
// therefore come from asset_supply_daily ONLY, and the snapshot is used only for
// the ratios that are never differenced.
//
// The consequence is honest and worth stating: supply_change_30d/90d have a
// year of depth available immediately, while burn_rate_30d and lockup_rate_30d
// difference total_supply, which exists only in the snapshot, and so stay
// untested until the snapshot has accumulated 30 days of its own.
export function buildSupplyLookup(snapshotRows, circulatingRows = []) {
  const out = new Map();
  const circBySymbol = groupBy(circulatingRows, 'symbol');
  const snapBySymbol = groupBy(snapshotRows, 'symbol');
  const symbols = new Set([...snapBySymbol.keys(), ...circBySymbol.keys()]);
  for (const symbol of symbols) {
    const snapshots = (snapBySymbol.get(symbol) || [])
      .slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const daily = (circBySymbol.get(symbol) || [])
      .slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    // The differenced float series: one source, never spliced.
    const circ = new Map(daily.map((r) => [r.date, r.circulating_supply]));
    // total_supply has no other source, so burn/lockup are snapshot-only and
    // will read null until it has depth.
    const total = new Map(snapshots.map((r) => [r.date, r.total_supply]));
    const snapshotByDate = new Map(snapshots.map((r) => [r.date, r]));
    // Every date either source knows about, so a symbol present in only one of
    // them still yields the features that source can support.
    const sorted = [...new Set([...circ.keys(), ...snapshotByDate.keys()])]
      .sort()
      .map((date) => ({ date, ...(snapshotByDate.get(date) || {}), circulating_daily: circ.get(date) }));
    const perDate = new Map();
    for (const r of sorted) {
      // Point-in-time ratios use the snapshot's own reported circulating figure
      // so numerator and denominator come from the same reading; the derived
      // one is only ever used for differences.
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

// The LATEST non-price feature row per symbol, for the live build.
//
// WHY THIS EXISTS. The cross-sectional fit runs on archiveMetrics, which reads
// the fundamentals panel and therefore sees open interest, supply and order-book
// depth. The live build runs on buildCryptoMetrics, which reads none of them.
// So the fit can SELECT a feature the live path cannot compute — and when it
// does, xsForecast finds no usable rank, returns null for every asset, and the
// lane goes quiet without an error.
//
// That is not hypothetical. When oi_px_divergence became the only selected
// feature on 2026-09-12T14:21, live forecasts stopped dead: 150 rows logged in
// the 08:00 build, 5 at 13:00, and zero after. Nothing failed, nothing warned,
// and the lane simply produced nothing while its coefficients looked healthy.
//
// Only the most recent row per symbol is needed — the live build is casting for
// today, not reconstructing history — so this is one indexed query per table
// rather than the full panel the archive fit loads.
export async function loadLatestFundamentals(d1Fn, env, { maxAgeDays = 3 } = {}) {
  const since = new Date(Date.now() - maxAgeDays * 86400000).toISOString().slice(0, 10);
  const out = new Map();
  const put = (symbol, fields) => {
    const cur = out.get(symbol) || {};
    out.set(symbol, { ...cur, ...fields });
  };
  try {
    // Derivatives features need a short history per symbol (oi_px_divergence
    // differences OI and price over 7 days), so the window is wider than one
    // day and assetDerivFeatures is reused rather than reimplemented — the
    // fitted coefficient belongs to ITS definition, not a second one that
    // happens to look similar.
    const derivSince = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const [deriv, bars] = await Promise.all([
      d1Fn(env, `SELECT symbol, date, oi_usd_close, oi_usd_mean, oi_usd_high, oi_usd_low,
                        toptrader_account_ls, toptrader_position_ls, all_account_ls, taker_buy_sell_ratio
                   FROM derivatives_daily WHERE date >= ?1 ORDER BY symbol, date`, [derivSince]),
      d1Fn(env, `SELECT symbol, date, close FROM asset_daily_bars
                  WHERE asset_class = 'crypto' AND date >= ?1 AND close > 0 ORDER BY symbol, date`, [derivSince])
    ]);
    const priceBySymbol = new Map();
    for (const r of bars) {
      if (!priceBySymbol.has(r.symbol)) priceBySymbol.set(r.symbol, new Map());
      priceBySymbol.get(r.symbol).set(r.date, r.close);
    }
    for (const [symbol, byDate] of buildDerivLookup(deriv, priceBySymbol)) {
      const dates = [...byDate.keys()].sort();
      const latest = dates[dates.length - 1];
      if (!latest || latest < since) continue;
      const f = byDate.get(latest);
      put(symbol, {
        oiPxDivergence: f.oi_px_divergence,
        oiChg1d: f.oi_chg_1d,
        oiChg3d: f.oi_chg_3d,
        oiLevelPctRoll: f.oi_level_pct,
        topTraderLs: f.toptrader_position_ls,
        allAccountLs: f.all_account_ls
      });
    }
  } catch (e) {
    console.log(`[xs] latest derivatives unavailable (${String(e && e.message).slice(0, 80)})`);
  }
  try {
    const liq = await d1Fn(env, `SELECT symbol, date, depth_1pct_usd, book_imbalance_1pct, book_imbalance_5pct
                                   FROM asset_liquidity_daily WHERE date >= ?1 ORDER BY symbol, date`, [since]);
    const derivForLiq = new Map();
    for (const [symbol, fields] of out) derivForLiq.set(symbol, new Map([['x', { oi_usd: null }]]));
    for (const [symbol, byDate] of buildLiquidityLookup(liq, derivForLiq)) {
      const dates = [...byDate.keys()].sort();
      const latest = dates[dates.length - 1];
      if (!latest) continue;
      const f = byDate.get(latest);
      put(symbol, {
        bookImbalance1pct: f.book_imbalance_1pct,
        logDepth1pct: f.log_depth_1pct,
        depthChange7d: f.depth_change_7d
      });
    }
  } catch (e) {
    console.log(`[xs] latest liquidity unavailable (${String(e && e.message).slice(0, 80)})`);
  }
  return out;
}
