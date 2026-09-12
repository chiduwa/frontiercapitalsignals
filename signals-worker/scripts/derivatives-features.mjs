// Feature construction over derivatives_daily (migration 0033). Pure
// functions, no I/O, so the research harness and any future live path compute
// the SAME numbers from the same code rather than two drifting copies.
//
// Three families, deliberately kept separate so the evidence gate can reject
// one without taking the others down with it:
//
//   flow        — how open interest is CHANGING. The existing engine only ever
//                 had an OI *level* percentile, which saturates at 1.00 on any
//                 asset whose OI is trending and then carries no information
//                 at all (ZEC sat at 1.00 for 14 straight days through its
//                 entire Aug-Sep 2026 run). Change is the thing that was
//                 actually being observed when someone says "OI kept rising".
//   positioning — WHO is on each side: Binance's top-trader long/short split,
//                 the all-account split, and the gap between them. Open
//                 interest alone is direction-blind by construction; $700M of
//                 OI built by crowded retail longs and $700M built against a
//                 short-heavy book are opposite setups with identical OI.
//   context     — market-wide state: how much of total tracked OI sits in BTC
//                 versus everything else, whether leverage is expanding across
//                 the board, and how broad that expansion is.
//
// Nothing here decides a direction. These are candidate features to be scored
// by the cross-sectional lane's existing evidence gate, which is the only
// thing in this project allowed to conclude that a number predicts a return.

// Trailing window for level percentiles. ROLLING, not expanding: an expanding
// window ranks today against all of history including a long-ago regime, and
// on a monotonically rising series it pins to 1.00 and stops discriminating.
// One year is long enough to span a full leverage cycle.
export const OI_PERCENTILE_WINDOW = 252;

// A percentile computed from a handful of points is noise wearing a decimal
// point. Same abstain-not-guess bar as loadFundingHistory's own minimum.
export const OI_MIN_HISTORY_DAYS = 60;

// Calendar-day tolerance when locating the bar N days back. Perps trade every
// day, so their bars should be exact; this absorbs a portal gap, not a real
// hole. Deliberately tighter than the equity-aware XS_DATE_TOLERANCE_DAYS.
export const DERIV_DATE_TOLERANCE_DAYS = 2;

const iso = (t) => new Date(t * 86400000).toISOString().slice(0, 10);
const dayNum = (d) => Date.parse(`${d}T00:00:00Z`) / 86400000;

// Value `days` back, or null. Returns the actual gap so a caller can reject a
// reading that is nominally 7 days old but really 9 — the same class of bug
// that produced a single +120,933% observation in cross-sectional validation
// when an index was stepped instead of a date.
export function lookback(series, date, days, tolerance = DERIV_DATE_TOLERANCE_DAYS) {
  const target = dayNum(date) - days;
  for (let k = 0; k <= tolerance; k++) {
    for (const sign of (k === 0 ? [0] : [-1, 1])) {
      const d = iso(target + sign * k);
      if (series.has(d)) return { date: d, value: series.get(d), gapDays: Math.abs(sign * k) };
    }
  }
  return null;
}

export function pctChange(series, date, days) {
  const now = series.get(date);
  const then = lookback(series, date, days);
  if (now == null || !then || !(then.value > 0) || !(now > 0)) return null;
  return ((now / then.value) - 1) * 100;
}

// Rank of `value` within `sorted` as 0..1. Ties take the midpoint so a flat
// series does not report 0 or 1 spuriously.
export function percentileOf(sorted, value) {
  if (!sorted.length || value == null) return null;
  let lo = 0, hi = 0;
  for (const v of sorted) { if (v < value) lo++; else if (v === value) hi++; }
  return (lo + hi / 2) / sorted.length;
}

export function rollingPercentile(values, index, window = OI_PERCENTILE_WINDOW, minDays = OI_MIN_HISTORY_DAYS) {
  const start = Math.max(0, index - window);
  const hist = values.slice(start, index).filter((v) => v != null && v > 0);
  if (hist.length < minDays) return null;
  return percentileOf(hist.slice().sort((a, b) => a - b), values[index]);
}

export function zScore(values, index, window = OI_PERCENTILE_WINDOW, minDays = OI_MIN_HISTORY_DAYS) {
  const start = Math.max(0, index - window);
  const hist = values.slice(start, index).filter((v) => v != null && Number.isFinite(v));
  if (hist.length < minDays) return null;
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
  const sd = Math.sqrt(hist.reduce((s, v) => s + (v - mean) ** 2, 0) / (hist.length - 1));
  if (!(sd > 0)) return null;
  return (values[index] - mean) / sd;
}

// ---------------------------------------------------------------------------
// Per-asset features
// ---------------------------------------------------------------------------
// `rows` is one symbol's derivatives_daily rows, date-ascending.
// `prices` is a Map date -> close for the same symbol.
export function assetDerivFeatures(rows, prices) {
  const oiSeries = new Map(rows.map((r) => [r.date, r.oi_usd_close ?? r.oi_usd_mean]));
  const oiValues = rows.map((r) => r.oi_usd_close ?? r.oi_usd_mean);
  const chg7Series = [];
  const out = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const date = r.date;
    const oiChg1 = pctChange(oiSeries, date, 1);
    const oiChg3 = pctChange(oiSeries, date, 3);
    const oiChg7 = pctChange(oiSeries, date, 7);
    const oiChg14 = pctChange(oiSeries, date, 14);
    chg7Series.push(oiChg7);

    const pxNow = prices.get(date);
    const pxThen = lookback(prices, date, 7);
    const pxChg7 = (pxNow > 0 && pxThen && pxThen.value > 0) ? ((pxNow / pxThen.value) - 1) * 100 : null;

    // The case that motivated all of this: leverage piling in while price has
    // NOT yet moved. Raw OI change cannot express it and a level percentile
    // cannot either — it needs both series in the same number.
    const oiPxDivergence = (oiChg7 != null && pxChg7 != null) ? oiChg7 - pxChg7 : null;

    // Top traders vs everyone else. >1 means the size-weighted book is longer
    // than the account-count book, i.e. the bigger accounts lean long while
    // the crowd does not (or the reverse below 1).
    const smartRetailGap = (r.toptrader_position_ls > 0 && r.all_account_ls > 0)
      ? r.toptrader_position_ls / r.all_account_ls : null;

    out.push({
      symbol: r.symbol, date,
      // flow
      oi_chg_1d: oiChg1,
      oi_chg_3d: oiChg3,
      oi_chg_7d: oiChg7,
      oi_chg_14d: oiChg14,
      oi_chg_7d_z: zScore(chg7Series, i),
      oi_level_pct: rollingPercentile(oiValues, i),
      oi_px_divergence: oiPxDivergence,
      oi_range_pct: (r.oi_usd_high > 0 && r.oi_usd_low > 0 && r.oi_usd_mean > 0)
        ? ((r.oi_usd_high - r.oi_usd_low) / r.oi_usd_mean) * 100 : null,
      // positioning
      toptrader_position_ls: r.toptrader_position_ls ?? null,
      toptrader_account_ls: r.toptrader_account_ls ?? null,
      all_account_ls: r.all_account_ls ?? null,
      smart_retail_gap: smartRetailGap,
      taker_buy_sell: r.taker_buy_sell_ratio ?? null,
      // raw carry-through for joins/diagnostics
      oi_usd: oiValues[i], px: pxNow ?? null, px_chg_7d: pxChg7
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Market context
// ---------------------------------------------------------------------------
// "Is altcoin open interest larger than BTC's, and is that itself predictive?"
//
// The trap this has to avoid: the tracked universe GREW (36 -> 156 crypto on
// 2026-09-06, and the backfill adds symbols unevenly by listing date). Naively
// summing OI per date would then show alt OI "rising" purely because more alts
// are being counted, manufacturing a signal out of a schema change. So every
// cross-date comparison is computed on a FIXED membership: only symbols
// present on every date in the window contribute.
export const CONTEXT_MIN_SYMBOLS = 20;

export function marketContextSeries(byDate, { minSymbols = CONTEXT_MIN_SYMBOLS } = {}) {
  const dates = [...byDate.keys()].sort();
  const out = [];
  for (const date of dates) {
    const rows = byDate.get(date) || [];
    const withOi = rows.filter((r) => r.oi_usd > 0);
    if (withOi.length < minSymbols) { out.push({ date, insufficient: true }); continue; }
    const btc = withOi.find((r) => r.symbol === 'BTC');
    const eth = withOi.find((r) => r.symbol === 'ETH');
    const total = withOi.reduce((s, r) => s + r.oi_usd, 0);
    const btcOi = btc ? btc.oi_usd : null;
    const ethOi = eth ? eth.oi_usd : null;
    const altOi = btcOi != null ? total - btcOi - (ethOi || 0) : null;

    const rising = withOi.filter((r) => r.oi_chg_7d != null);
    const breadth = rising.length >= minSymbols
      ? rising.filter((r) => r.oi_chg_7d > 0).length / rising.length : null;

    const ls = withOi.map((r) => r.toptrader_position_ls).filter((v) => v > 0);
    const med = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y);
      const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

    out.push({
      date,
      symbols: withOi.length,
      total_oi: total,
      btc_oi_share: btcOi != null ? btcOi / total : null,
      // The user's formulation, stated as a ratio so ">1" literally means
      // "altcoin OI now exceeds BTC's".
      alt_btc_oi_ratio: (altOi != null && btcOi > 0) ? altOi / btcOi : null,
      oi_breadth_7d: breadth,
      market_toptrader_ls: med(ls),
      median_oi_chg_7d: med(withOi.map((r) => r.oi_chg_7d).filter((v) => v != null))
    });
  }
  return out;
}

// Fixed-membership aggregate change: recomputes totals over only the symbols
// present on BOTH ends of the window, so universe growth cannot masquerade as
// leverage expansion.
export function fixedMembershipOiChange(byDate, date, days, minSymbols = CONTEXT_MIN_SYMBOLS) {
  const dates = new Map([...byDate.keys()].map((d) => [d, true]));
  let thenDate = null;
  const target = dayNum(date) - days;
  for (let k = 0; k <= DERIV_DATE_TOLERANCE_DAYS && !thenDate; k++) {
    for (const sign of (k === 0 ? [0] : [-1, 1])) {
      const d = iso(target + sign * k);
      if (dates.has(d)) { thenDate = d; break; }
    }
  }
  if (!thenDate) return null;
  const nowRows = (byDate.get(date) || []).filter((r) => r.oi_usd > 0);
  const thenMap = new Map((byDate.get(thenDate) || []).filter((r) => r.oi_usd > 0).map((r) => [r.symbol, r.oi_usd]));
  const shared = nowRows.filter((r) => thenMap.has(r.symbol));
  if (shared.length < minSymbols) return null;
  const nowTotal = shared.reduce((s, r) => s + r.oi_usd, 0);
  const thenTotal = shared.reduce((s, r) => s + thenMap.get(r.symbol), 0);
  if (!(thenTotal > 0)) return null;
  return { pct: ((nowTotal / thenTotal) - 1) * 100, symbols: shared.length, from: thenDate };
}

// Candidate features exposed to the evidence gate, grouped by family so a
// whole family can be rejected together. Ids match the column names above.
export const DERIV_FEATURE_FAMILIES = {
  flow: ['oi_chg_1d', 'oi_chg_3d', 'oi_chg_7d', 'oi_chg_14d', 'oi_chg_7d_z', 'oi_level_pct', 'oi_px_divergence', 'oi_range_pct'],
  positioning: ['toptrader_position_ls', 'toptrader_account_ls', 'all_account_ls', 'smart_retail_gap', 'taker_buy_sell']
};
export const DERIV_FEATURE_IDS = Object.values(DERIV_FEATURE_FAMILIES).flat();
