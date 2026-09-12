// Evidence harness for the derivatives features (migration 0033,
// derivatives-features.mjs). Answers one question and refuses to answer it
// loosely: does any open-interest / positioning feature carry information
// about FORWARD returns, over and above what price already says?
//
// Method is deliberately the one the cross-sectional lane already uses, not a
// new one invented for this feature set:
//
//  * Fama-MacBeth. For each non-overlapping period, cross-sectionally rank the
//    feature, regress that period's forward EXCESS return on the rank, keep
//    the slope. Then t-test the time series of slopes. This is the only
//    correct effective sample size here: 800 same-day observations across 60
//    assets are not 800 independent trials, they are ~1. Counting them as
//    independent is exactly the v6 defect that inflated every confidence bound
//    in this engine (see QUANT_SIGNAL_DIAGNOSIS.md).
//  * Excess return, never hit rate. Cross-sectional momentum quintiles in this
//    archive run ~46-47% accurate in EVERY quintile while the top quintile
//    still beats the universe — any gate keyed on direction accuracy is blind
//    by construction (docs/CROSS_SECTIONAL_EVIDENCE.md).
//  * Non-overlapping windows only.
//  * Bonferroni across the whole tested family, because this script tests many
//    features at several horizons and the best of 30 noise series always looks
//    significant at 0.05.
//
// Read-only. Writes nothing to the live model; prints a report.
import { d1 } from './d1-client.mjs';
import { loadBarQuarantine, cleanBars } from './bar-quarantine.mjs';
import { bonferroniZ, winsorise, ols, XS_FAMILY_ALPHA, XS_MIN_SIGN_CONSISTENCY, XS_PUBLICATION_MIN_T } from './cross-sectional.mjs';
import { crossSectionalRanks } from '../worker.js';
import {
  assetDerivFeatures, marketContextSeries, fixedMembershipOiChange,
  DERIV_FEATURE_FAMILIES, DERIV_FEATURE_IDS, lookback
} from './derivatives-features.mjs';
import {
  assetSupplyFeatures, SUPPLY_FEATURE_FAMILY, SUPPLY_SNAPSHOT_FEATURES
} from './supply-features.mjs';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID } = process.env;
for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID };

export const RESEARCH_HORIZONS = [1, 3, 7, 14];
// A cross-section thinner than this cannot support a rank regression.
export const MIN_CROSS_SECTION = 20;
// Fewer periods than this and the time-series t-stat is itself noise.
export const MIN_PERIODS = 20;

const iso = (t) => new Date(t * 86400000).toISOString().slice(0, 10);
const dayNum = (d) => Date.parse(`${d}T00:00:00Z`) / 86400000;

async function loadAll() {
  console.log('loading derivatives_daily...');
  const deriv = await d1(env, `SELECT symbol, date, oi_usd_close, oi_usd_mean, oi_usd_high, oi_usd_low,
    toptrader_account_ls, toptrader_position_ls, all_account_ls, taker_buy_sell_ratio
    FROM derivatives_daily ORDER BY symbol, date`);
  console.log('loading asset_daily_bars...');
  const bars = await d1(env, `SELECT symbol, date, close FROM asset_daily_bars
    WHERE asset_class = 'crypto' AND date >= '2022-12-01' ORDER BY symbol, date`);
  console.log('loading asset_supply_daily...');
  // Supply is optional: the lane must still run before migration 0035 has been
  // backfilled, reporting the supply family as unavailable rather than failing.
  let supply = [], supplySnapshot = [];
  try {
    supply = await d1(env, `SELECT symbol, date, circulating_supply FROM asset_supply_daily
      WHERE date >= '2022-12-01' ORDER BY symbol, date`);
    supplySnapshot = await d1(env, 'SELECT symbol, circulating_supply, total_supply, max_supply FROM asset_supply_snapshot');
  } catch (e) {
    console.log(`  supply tables unavailable (${String(e && e.message).slice(0, 60)}) — supply family will abstain`);
  }
  return { deriv, bars, supply, supplySnapshot };
}

function buildPanel(deriv, bars, quarantine, supply = [], supplySnapshot = []) {
  // Corrupt bars are removed BEFORE any feature or return is computed, and a
  // remapped ticker keeps only its post-identity-change history (migration
  // 0034). The +/-1000% guard in forwardReturn stays as a backstop for anything
  // the detector missed, but this is the primary defence.
  const barsBySymbol = new Map();
  for (const b of bars) {
    const c = Number(b.close); if (!(c > 0)) continue;
    if (!barsBySymbol.has(b.symbol)) barsBySymbol.set(b.symbol, []);
    barsBySymbol.get(b.symbol).push({ date: b.date, close: c });
  }
  const priceBySymbol = new Map();
  let droppedBars = 0;
  for (const [symbol, rows] of barsBySymbol) {
    const clean = quarantine ? cleanBars(quarantine, symbol, rows) : rows;
    droppedBars += rows.length - clean.length;
    priceBySymbol.set(symbol, new Map(clean.map((b) => [b.date, b.close])));
  }
  if (droppedBars) console.log(`quarantine: dropped ${droppedBars} bars (corrupt or pre-identity-change)`);
  const derivBySymbol = new Map();
  for (const r of deriv) {
    if (!derivBySymbol.has(r.symbol)) derivBySymbol.set(r.symbol, []);
    derivBySymbol.get(r.symbol).push(r);
  }
  const byDate = new Map();
  let skipped = 0;
  for (const [symbol, rows] of derivBySymbol) {
    const prices = priceBySymbol.get(symbol);
    if (!prices || prices.size < 60) { skipped++; continue; }
    for (const f of assetDerivFeatures(rows, prices)) {
      if (!byDate.has(f.date)) byDate.set(f.date, []);
      byDate.get(f.date).push(f);
    }
  }
  // Merge supply features onto the same (symbol, date) cells. Left join: a
  // symbol with no supply history keeps its derivatives features and simply
  // has nulls for the supply ones, which the coverage filter then skips.
  const snapBySymbol = new Map(supplySnapshot.map((r) => [r.symbol, r]));
  const supplyBySymbol = new Map();
  for (const r of supply) {
    if (!supplyBySymbol.has(r.symbol)) supplyBySymbol.set(r.symbol, []);
    supplyBySymbol.get(r.symbol).push(r);
  }
  let supplyMerged = 0;
  for (const [symbol, rows] of supplyBySymbol) {
    const feats = new Map(assetSupplyFeatures(rows, snapBySymbol.get(symbol) || null).map((f) => [f.date, f]));
    for (const [date, cells] of byDate) {
      const cell = cells.find((c) => c.symbol === symbol);
      const f = feats.get(date);
      if (!cell || !f) continue;
      for (const id of SUPPLY_FEATURE_FAMILY) cell[id] = f[id];
      supplyMerged++;
    }
  }
  if (supplyMerged) console.log(`supply: merged ${supplyMerged} cells from ${supplyBySymbol.size} symbols`);
  return { byDate, priceBySymbol, symbols: derivBySymbol.size, skippedNoPrice: skipped, supplySymbols: supplyBySymbol.size };
}

// A return this large over a research horizon is a broken bar, not a trade.
// asset_daily_bars genuinely contains such rows: 37 single-step moves above
// 300% exist in the crypto archive, and the worst are unambiguous corruption —
// TIA printing 0.0105 -> 7149.42 in one day (+68,063,639%), NIGHT 0.000003 ->
// 0.0986, APE 0.000713 -> 2.064. These look like a ticker being remapped to a
// different asset, or a decimal/scaling fault, not a price.
//
// The regression path never noticed because winsorise() clips the tails of
// every cross-section before fitting. A PORTFOLIO does notice: it would hold
// the broken name at full weight and book the fake return. So the guard lives
// here, at the source, rather than being left to each consumer to remember.
// Rejected observations are counted and reported, never silently dropped.
export const MAX_PLAUSIBLE_PERIOD_RETURN_PCT = 1000;
export const returnGuardStats = { checked: 0, rejected: 0, worst: 0 };

// Forward return from `date` to `date + days`, using real dates. A price bar
// more than `tol` days off the target is treated as missing, not stretched —
// stepping N index positions and calling it N days is how a single
// +120,933% observation entered cross-sectional validation once already.
function forwardReturn(prices, date, days, tol = 2) {
  const p0 = prices.get(date);
  if (!(p0 > 0)) return null;
  const target = dayNum(date) + days;
  for (let k = 0; k <= tol; k++) {
    for (const sign of (k === 0 ? [0] : [1, -1])) {
      const p1 = prices.get(iso(target + sign * k));
      if (p1 > 0) {
        const r = ((p1 / p0) - 1) * 100;
        returnGuardStats.checked++;
        if (Math.abs(r) > MAX_PLAUSIBLE_PERIOD_RETURN_PCT) {
          returnGuardStats.rejected++;
          if (Math.abs(r) > Math.abs(returnGuardStats.worst)) returnGuardStats.worst = r;
          return null;
        }
        return r;
      }
    }
  }
  return null;
}

// Non-overlapping period starts: every `days`-th date, so no forward window is
// counted twice.
function periodStarts(dates, days) {
  const sorted = [...dates].sort();
  const out = [];
  let last = null;
  for (const d of sorted) {
    if (last === null || dayNum(d) - dayNum(last) >= days) { out.push(d); last = d; }
  }
  return out;
}

// One Fama-MacBeth pass for one feature at one horizon.
function famaMacBeth(byDate, priceBySymbol, featureId, days, { filter = null } = {}) {
  const betas = [], periods = [];
  for (const date of periodStarts(byDate.keys(), days)) {
    let rows = byDate.get(date) || [];
    if (filter) rows = rows.filter((r) => filter(r, date));
    const usable = rows.filter((r) => Number.isFinite(r[featureId]));
    if (usable.length < MIN_CROSS_SECTION) continue;

    const fwd = usable.map((r) => forwardReturn(priceBySymbol.get(r.symbol), date, days));
    const keep = usable.map((_, i) => fwd[i] != null).map((ok, i) => (ok ? i : -1)).filter((i) => i >= 0);
    if (keep.length < MIN_CROSS_SECTION) continue;

    const rets = keep.map((i) => fwd[i]);
    // EXCESS return: subtract this period's equal-weighted universe mean, so a
    // feature cannot score just by being long a rising market.
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const excess = winsorise(rets.map((r) => r - mean));
    const ranks = crossSectionalRanks(keep.map((i) => usable[i][featureId]));
    const pairs = ranks.map((rk, i) => [rk, excess[i]]).filter(([rk, e]) => rk != null && Number.isFinite(e));
    if (pairs.length < MIN_CROSS_SECTION) continue;

    const fit = ols(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
    if (!fit || !Number.isFinite(fit.beta)) continue;
    betas.push(fit.beta);
    periods.push(date);
  }
  if (betas.length < MIN_PERIODS) return { featureId, days, periods: betas.length, insufficient: true };
  const n = betas.length;
  const mean = betas.reduce((a, b) => a + b, 0) / n;
  const variance = betas.reduce((s, b) => s + (b - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  const t = se > 0 ? mean / se : 0;
  const agree = betas.filter((b) => (b > 0) === (mean > 0)).length / n;
  return { featureId, days, periods: n, beta: mean, tStat: t, signConsistency: agree,
    firstPeriod: periods[0], lastPeriod: periods[periods.length - 1] };
}

// Daily cross-correlation of a feature against price change at various lags.
// Answers "does this lead, lag, or merely move with price" — the question that
// decides whether anything here can predict rather than describe.
function leadLag(byDate, priceBySymbol, featureId, maxLag = 5) {
  const dates = [...byDate.keys()].sort();
  const out = [];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const betas = [];
    for (const date of dates) {
      const rows = (byDate.get(date) || []).filter((r) => Number.isFinite(r[featureId]));
      if (rows.length < MIN_CROSS_SECTION) continue;
      const rets = rows.map((r) => {
        const prices = priceBySymbol.get(r.symbol);
        if (!prices) return null;
        const from = iso(dayNum(date) + lag - 1), to = iso(dayNum(date) + lag);
        const a = prices.get(from), b = prices.get(to);
        return (a > 0 && b > 0) ? ((b / a) - 1) * 100 : null;
      });
      const idx = rets.map((v, i) => (v != null ? i : -1)).filter((i) => i >= 0);
      if (idx.length < MIN_CROSS_SECTION) continue;
      const vals = idx.map((i) => rets[i]);
      const mu = vals.reduce((a, b) => a + b, 0) / vals.length;
      const excess = winsorise(vals.map((v) => v - mu));
      const ranks = crossSectionalRanks(idx.map((i) => rows[i][featureId]));
      const pairs = ranks.map((rk, i) => [rk, excess[i]]).filter(([rk, e]) => rk != null && Number.isFinite(e));
      if (pairs.length < MIN_CROSS_SECTION) continue;
      const fit = ols(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
      if (fit && Number.isFinite(fit.beta)) betas.push(fit.beta);
    }
    if (betas.length < MIN_PERIODS) { out.push({ lag, insufficient: true, periods: betas.length }); continue; }
    const n = betas.length, mean = betas.reduce((a, b) => a + b, 0) / n;
    const se = Math.sqrt(betas.reduce((s, b) => s + (b - mean) ** 2, 0) / (n - 1) / n);
    out.push({ lag, beta: mean, tStat: se > 0 ? mean / se : 0, periods: n });
  }
  return out;
}

// Bivariate Fama-MacBeth: the feature's slope AFTER a control is in the same
// regression. This is not optional decoration. oi_px_divergence is defined as
// oi_chg_7d MINUS px_chg_7d, so it mechanically contains a short-term price
// reversal term, and short-term reversal is a long-documented crypto effect on
// its own. A univariate win for that feature is therefore ambiguous by
// construction: it could be open-interest information, or it could be reversal
// re-labelled. Only the partial slope separates them.
function famaMacBethControlled(byDate, priceBySymbol, featureId, controlId, days) {
  const betas = [], controlBetas = [];
  for (const date of periodStarts(byDate.keys(), days)) {
    const rows = (byDate.get(date) || []).filter(
      (r) => Number.isFinite(r[featureId]) && Number.isFinite(r[controlId]));
    if (rows.length < MIN_CROSS_SECTION) continue;
    const fwd = rows.map((r) => forwardReturn(priceBySymbol.get(r.symbol), date, days));
    const keep = fwd.map((v, i) => (v != null ? i : -1)).filter((i) => i >= 0);
    if (keep.length < MIN_CROSS_SECTION) continue;

    const rets = keep.map((i) => fwd[i]);
    const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
    const y = winsorise(rets.map((r) => r - mu));
    const x1 = crossSectionalRanks(keep.map((i) => rows[i][featureId]));
    const x2 = crossSectionalRanks(keep.map((i) => rows[i][controlId]));
    const idx = y.map((v, i) => (Number.isFinite(v) && x1[i] != null && x2[i] != null ? i : -1)).filter((i) => i >= 0);
    if (idx.length < MIN_CROSS_SECTION) continue;

    // Two-regressor OLS solved directly: with both regressors mean-centred
    // ranks, the normal equations are a 2x2 system.
    const a = idx.map((i) => x1[i]), b = idx.map((i) => x2[i]), yy = idx.map((i) => y[i]);
    const n = idx.length;
    const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n, my = yy.reduce((s, v) => s + v, 0) / n;
    let saa = 0, sbb = 0, sab = 0, say = 0, sby = 0;
    for (let i = 0; i < n; i++) {
      const da = a[i] - ma, db = b[i] - mb, dy = yy[i] - my;
      saa += da * da; sbb += db * db; sab += da * db; say += da * dy; sby += db * dy;
    }
    const det = saa * sbb - sab * sab;
    if (!(Math.abs(det) > 1e-12)) continue;
    betas.push((say * sbb - sby * sab) / det);
    controlBetas.push((sby * saa - say * sab) / det);
  }
  if (betas.length < MIN_PERIODS) return { featureId, controlId, days, periods: betas.length, insufficient: true };
  const stat = (arr) => {
    const n = arr.length, m = arr.reduce((x, y2) => x + y2, 0) / n;
    const se = Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1) / n);
    return { mean: m, t: se > 0 ? m / se : 0, signConsistency: arr.filter((v) => (v > 0) === (m > 0)).length / n };
  };
  const f = stat(betas), c = stat(controlBetas);
  return { featureId, controlId, days, periods: betas.length,
    beta: f.mean, tStat: f.t, signConsistency: f.signConsistency,
    controlBeta: c.mean, controlT: c.t };
}

// ---------------------------------------------------------------------------
// Cost model
// ---------------------------------------------------------------------------
// A t-stat says a feature carries information. It says nothing about whether
// that information survives paying to act on it, and the two can point in
// OPPOSITE directions: the strongest result in this study sits at the 1-day
// horizon, which is also the configuration that trades most. Ranking findings
// by t-stat alone would therefore recommend the most expensive one.
//
// This does NOT improve any forecast. It converts a slope into the thing a
// decision actually needs: net return per period, and the cost level at which
// the edge disappears.
//
// Round-trip cost per side, in basis points. Binance USDT-perp taker fee is
// 4.5bp at VIP0; the rest is slippage and spread on a liquid perp. Deliberately
// a single tunable number rather than a per-symbol depth model — the universe
// here spans BTC to microcaps and a fake-precise per-asset estimate would imply
// confidence this archive cannot support. The breakeven figure below is the
// honest output: it lets a reader substitute their own cost.
export const COST_BPS_PER_SIDE = Number(process.env.DERIV_COST_BPS || 6.5);

// Long the top `fraction` of the cross-section, short the bottom, equal
// weight, gross exposure 1.0 per side. Quintiles rather than deciles: a decile
// of a 100-name universe is 10 names, thin enough that one outlier drives the
// period.
export const PORTFOLIO_FRACTION = 0.2;

function targetWeights(rows, featureId, fraction = PORTFOLIO_FRACTION) {
  const usable = rows.filter((r) => Number.isFinite(r[featureId]));
  if (usable.length < MIN_CROSS_SECTION) return null;
  const sorted = usable.slice().sort((a, b) => a[featureId] - b[featureId]);
  const k = Math.max(1, Math.floor(sorted.length * fraction));
  const w = new Map();
  for (let i = 0; i < k; i++) w.set(sorted[i].symbol, -1 / k);                       // bottom: short
  for (let i = sorted.length - k; i < sorted.length; i++) w.set(sorted[i].symbol, 1 / k); // top: long
  return w;
}

// Turnover between two weight books, as a fraction of gross exposure. Entering
// a fresh book from flat is turnover 1.0; holding it unchanged is 0.
function turnoverBetween(prev, next) {
  const symbols = new Set([...(prev ? prev.keys() : []), ...next.keys()]);
  let sum = 0;
  for (const s of symbols) sum += Math.abs((next.get(s) || 0) - ((prev && prev.get(s)) || 0));
  return sum / 2;
}

// Walks the non-overlapping period grid holding a long-short book, charging
// turnover at each rebalance. Returns gross and net per-period statistics plus
// the breakeven cost.
function backtestCosted(byDate, priceBySymbol, featureId, days, { costBps = COST_BPS_PER_SIDE } = {}) {
  const grossRets = [], turnovers = [];
  let prev = null;
  for (const date of periodStarts(byDate.keys(), days)) {
    const rows = byDate.get(date) || [];
    const w = targetWeights(rows, featureId);
    if (!w) continue;

    // Returns are demeaned and winsorised exactly as the regression does, so
    // the backtest measures the same quantity the t-stats were computed on.
    // Without this the two disagree: the fit sees a clipped cross-section while
    // the portfolio sees the raw one, and a single surviving outlier swamps the
    // period. (It did — this printed -4103% per period before the fix.)
    const universe = rows
      .map((r) => ({ symbol: r.symbol, ret: forwardReturn(priceBySymbol.get(r.symbol), date, days) }))
      .filter((x) => x.ret != null);
    if (universe.length < MIN_CROSS_SECTION) continue;
    const mu = universe.reduce((s, x) => s + x.ret, 0) / universe.length;
    const clipped = winsorise(universe.map((x) => x.ret - mu));
    const excessBySymbol = new Map(universe.map((x, i) => [x.symbol, clipped[i]]));

    const held = new Map();
    let gross = 0;
    for (const [symbol, weight] of w) {
      const r = excessBySymbol.get(symbol);
      if (r == null) continue;
      held.set(symbol, weight);
      gross += weight * r;
    }
    if (held.size < MIN_CROSS_SECTION) continue;
    grossRets.push(gross);
    turnovers.push(turnoverBetween(prev, held));
    prev = held;
  }
  if (grossRets.length < MIN_PERIODS) return { featureId, days, periods: grossRets.length, insufficient: true };

  // Both legs trade, so one unit of turnover costs 2 x per-side bps.
  const costPct = turnovers.map((t) => (t * 2 * costBps) / 100);
  const netRets = grossRets.map((g, i) => g - costPct[i]);
  const stat = (a) => {
    const n = a.length, m = a.reduce((x, y) => x + y, 0) / n;
    const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1));
    return { mean: m, t: sd > 0 ? m / (sd / Math.sqrt(n)) : 0, sd };
  };
  const g = stat(grossRets), nt = stat(netRets);
  const meanTurnover = turnovers.reduce((a, b) => a + b, 0) / turnovers.length;
  // Cost per side at which mean net return hits zero.
  const breakevenBps = meanTurnover > 0 ? (g.mean * 100) / (meanTurnover * 2) : null;
  // Periods per year, for an annualised view that compares horizons fairly.
  const perYear = 365 / days;
  return {
    featureId, days, periods: grossRets.length,
    grossPerPeriod: g.mean, netPerPeriod: nt.mean, netT: nt.t,
    meanTurnover, breakevenBps,
    grossAnnual: g.mean * perYear, netAnnual: nt.mean * perYear,
    netSharpe: nt.sd > 0 ? (nt.mean / nt.sd) * Math.sqrt(perYear) : 0
  };
}

function report(title, results, zThreshold) {
  console.log(`\n${title}`);
  console.log('  feature                 h   periods     beta    t-stat   sign%   verdict');
  console.log('  ' + '-'.repeat(76));
  for (const r of results) {
    if (r.insufficient) {
      console.log(`  ${r.featureId.padEnd(22)} ${String(r.days).padStart(2)}   ${String(r.periods).padStart(5)}       --        --      --   insufficient`);
      continue;
    }
    const selected = Math.abs(r.tStat) >= zThreshold && r.signConsistency >= XS_MIN_SIGN_CONSISTENCY;
    console.log(`  ${r.featureId.padEnd(22)} ${String(r.days).padStart(2)}   ${String(r.periods).padStart(5)} `
      + `${r.beta.toFixed(4).padStart(8)}  ${r.tStat.toFixed(2).padStart(7)}   ${(r.signConsistency * 100).toFixed(0).padStart(4)}%   `
      + (selected ? 'SELECTED' : 'rejected'));
  }
}

async function main() {
  const { deriv, bars, supply, supplySnapshot } = await loadAll();
  console.log(`derivatives rows ${deriv.length}, price bars ${bars.length}, supply rows ${supply.length}`);
  const quarantine = await loadBarQuarantine(d1, env, { assetClass: 'crypto' });
  const { byDate, priceBySymbol, symbols, skippedNoPrice, supplySymbols } =
    buildPanel(deriv, bars, quarantine, supply, supplySnapshot);
  const dates = [...byDate.keys()].sort();
  console.log(`panel: ${symbols} symbols (${skippedNoPrice} skipped, no price history), `
    + `${dates.length} dates ${dates[0]}..${dates[dates.length - 1]}`);
  const wide = dates.filter((d) => (byDate.get(d) || []).length >= MIN_CROSS_SECTION);
  console.log(`dates with a usable cross-section (>=${MIN_CROSS_SECTION} symbols): ${wide.length}`);
  if (wide.length < MIN_PERIODS * 2) {
    console.log('\nNot enough backfilled breadth yet to run the gate. Re-run after the backfill widens.');
    return;
  }

  // The whole family is every feature at every horizon: that is the real size
  // of the search, and the correction has to reflect it.
  // The supply family joins the SAME correction. Testing it under its own
  // separate alpha would be the multiple-comparison error this harness exists
  // to avoid: it is one search over one panel, however many sources feed it.
  const allIds = supplySymbols ? DERIV_FEATURE_IDS.concat(SUPPLY_FEATURE_FAMILY) : DERIV_FEATURE_IDS;
  const tests = allIds.length * RESEARCH_HORIZONS.length;
  const zThreshold = bonferroniZ(tests, XS_FAMILY_ALPHA);
  console.log(`\nfamily: ${allIds.length} features x ${RESEARCH_HORIZONS.length} horizons = ${tests} tests`);
  console.log(`Bonferroni |t| threshold = ${zThreshold.toFixed(3)} (family alpha ${XS_FAMILY_ALPHA}), `
    + `sign consistency >= ${XS_MIN_SIGN_CONSISTENCY}`);

  const families = { ...DERIV_FEATURE_FAMILIES };
  if (supplySymbols) families.supply = SUPPLY_FEATURE_FAMILY;
  for (const [family, ids] of Object.entries(families)) {
    const results = [];
    for (const id of ids) for (const h of RESEARCH_HORIZONS) results.push(famaMacBeth(byDate, priceBySymbol, id, h));
    report(`=== family: ${family} — forward EXCESS return ===`, results, zThreshold);
    if (family === 'supply') {
      console.log(`  note: ${[...SUPPLY_SNAPSHOT_FEATURES].join(', ')} are point-in-time snapshots, not series.`);
      console.log('        They are valid CROSS-SECTIONALLY (rank assets against each other today)');
      console.log('        but carry no within-asset time variation, so their periods are not independent');
      console.log('        draws of a changing quantity and their t-stats overstate confidence.');
    }
  }

  // ---- controls ----
  // Whatever survived above has to survive price too. If an open-interest
  // feature's edge vanishes once short-term price reversal is in the same
  // regression, then it was never open-interest information.
  console.log('\n=== CONTROLS: does the OI feature survive alongside plain price reversal? ===');
  console.log('  feature                 ctrl          h  periods   partial beta   t-stat  sign%   ctrl t   verdict');
  console.log('  ' + '-'.repeat(96));
  const controlPairs = [];
  for (const id of ['oi_px_divergence', 'oi_chg_1d', 'oi_chg_3d', 'oi_range_pct']) {
    for (const h of [1, 3, 7]) controlPairs.push([id, 'px_chg_7d', h]);
  }
  for (const [id, ctrl, h] of controlPairs) {
    const r = famaMacBethControlled(byDate, priceBySymbol, id, ctrl, h);
    if (r.insufficient) {
      console.log(`  ${id.padEnd(22)} ${ctrl.padEnd(12)} ${String(h).padStart(2)}  ${String(r.periods).padStart(6)}   insufficient`);
      continue;
    }
    const survives = Math.abs(r.tStat) >= zThreshold && r.signConsistency >= XS_MIN_SIGN_CONSISTENCY;
    console.log(`  ${id.padEnd(22)} ${ctrl.padEnd(12)} ${String(h).padStart(2)}  ${String(r.periods).padStart(6)}   `
      + `${r.beta.toFixed(4).padStart(11)}  ${r.tStat.toFixed(2).padStart(7)}   ${(r.signConsistency * 100).toFixed(0).padStart(3)}%  `
      + `${r.controlT.toFixed(2).padStart(7)}   ${survives ? 'SURVIVES' : 'absorbed by price'}`);
  }

  // ---- net of costs ----
  // The ranking above is by statistical strength. This is the ranking by money,
  // and they are not the same ordering.
  console.log(`\n=== NET OF COSTS: long-short top/bottom ${(PORTFOLIO_FRACTION * 100).toFixed(0)}%, `
    + `${COST_BPS_PER_SIDE}bp per side ===`);
  console.log('  feature                 h  periods  turnover  gross/pd   net/pd   net t   net ann%  netSharpe  breakeven');
  console.log('  ' + '-'.repeat(104));
  const costed = [];
  for (const id of ['oi_px_divergence', 'oi_chg_1d', 'oi_chg_3d', 'oi_chg_7d', 'oi_level_pct', 'toptrader_position_ls']) {
    for (const h of [1, 3, 7]) {
      const r = backtestCosted(byDate, priceBySymbol, id, h);
      if (r.insufficient) continue;
      costed.push(r);
      console.log(`  ${id.padEnd(22)} ${String(h).padStart(2)}  ${String(r.periods).padStart(6)}  `
        + `${r.meanTurnover.toFixed(2).padStart(8)}  ${r.grossPerPeriod.toFixed(3).padStart(8)}  `
        + `${r.netPerPeriod.toFixed(3).padStart(7)}  ${r.netT.toFixed(2).padStart(6)}  `
        + `${r.netAnnual.toFixed(1).padStart(8)}  ${r.netSharpe.toFixed(2).padStart(9)}  `
        + `${r.breakevenBps != null ? r.breakevenBps.toFixed(1).padStart(6) + 'bp' : '     n/a'}`);
    }
  }
  const viable = costed.filter((r) => r.netPerPeriod > 0 && r.netT >= XS_PUBLICATION_MIN_T);
  console.log(`\n  breakeven = cost per side at which the edge is exactly zero; below it the strategy pays.`);
  console.log(`  data guard: ${returnGuardStats.rejected} of ${returnGuardStats.checked} forward returns rejected as `
    + `implausible (>|${MAX_PLAUSIBLE_PERIOD_RETURN_PCT}|%)`
    + (returnGuardStats.worst ? `, worst ${returnGuardStats.worst.toFixed(0)}%` : ''));
  if (viable.length) {
    const best = viable.slice().sort((a, b) => b.netSharpe - a.netSharpe)[0];
    console.log(`  best net-of-cost configuration: ${best.featureId} at ${best.days}d — `
      + `net ${best.netAnnual.toFixed(1)}%/yr, Sharpe ${best.netSharpe.toFixed(2)}, breakeven ${best.breakevenBps.toFixed(1)}bp`);
    const byT = costed.slice().sort((a, b) => b.netT - a.netT);
    if (byT[0] && best && (byT[0].featureId !== best.featureId || byT[0].days !== best.days)) {
      console.log(`  note: the highest net-t configuration (${byT[0].featureId} ${byT[0].days}d) is NOT the best risk-adjusted one.`);
    }
  } else {
    console.log('  NO configuration clears a positive net return at this cost level.');
  }

  console.log('\n=== LEAD-LAG: is open-interest change leading, coincident, or lagging? ===');
  console.log('  (cross-sectional beta of oi_chg_1d on that day\'s excess return, by offset)');
  console.log('  lag   meaning                    beta     t-stat  periods');
  for (const r of leadLag(byDate, priceBySymbol, 'oi_chg_1d')) {
    const meaning = r.lag < 0 ? `price ${-r.lag}d BEFORE` : r.lag === 0 ? 'same day' : `price ${r.lag}d AFTER`;
    if (r.insufficient) { console.log(`  ${String(r.lag).padStart(3)}   ${meaning.padEnd(22)}  insufficient (${r.periods})`); continue; }
    console.log(`  ${String(r.lag).padStart(3)}   ${meaning.padEnd(22)} ${r.beta.toFixed(4).padStart(8)}  ${r.tStat.toFixed(2).padStart(7)}  ${String(r.periods).padStart(6)}`);
  }

  // ---- market context ----
  console.log('\n=== MARKET CONTEXT ===');
  const ctx = marketContextSeries(byDate).filter((c) => !c.insufficient);
  if (ctx.length < MIN_PERIODS) { console.log('  insufficient breadth for a market-context series yet'); }
  else {
    const last = ctx[ctx.length - 1];
    console.log(`  latest ${last.date}: ${last.symbols} symbols, BTC OI share ${(last.btc_oi_share * 100).toFixed(1)}%, `
      + `alt/BTC OI ratio ${last.alt_btc_oi_ratio.toFixed(2)}, breadth ${last.oi_breadth_7d != null ? (last.oi_breadth_7d * 100).toFixed(0) + '%' : 'n/a'}`);
    const ratios = ctx.map((c) => c.alt_btc_oi_ratio).filter((v) => v != null).sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    console.log(`  alt/BTC OI ratio: min ${ratios[0].toFixed(2)}, median ${median.toFixed(2)}, max ${ratios[ratios.length - 1].toFixed(2)} over ${ctx.length} dates`);

    // Regime split: does the flow family behave differently when alt leverage
    // dominates? Tested as a CONDITIONAL fit, not as a separate free feature,
    // so the correction still covers it.
    const byDateCtx = new Map(ctx.map((c) => [c.date, c]));
    const hot = (r, date) => (byDateCtx.get(date)?.alt_btc_oi_ratio ?? 0) > median;
    const cold = (r, date) => (byDateCtx.get(date)?.alt_btc_oi_ratio ?? Infinity) <= median;
    const regimeTests = tests + DERIV_FEATURE_FAMILIES.flow.length * 2 * 2;
    const zRegime = bonferroniZ(regimeTests, XS_FAMILY_ALPHA);
    console.log(`\n  regime split on alt/BTC OI ratio vs its median (${median.toFixed(2)})`);
    console.log(`  threshold widened to |t| >= ${zRegime.toFixed(3)} for the extra ${regimeTests - tests} conditional tests`);
    for (const label of ['alt-leverage HIGH', 'alt-leverage LOW']) {
      const filter = label.includes('HIGH') ? hot : cold;
      const results = [];
      for (const id of DERIV_FEATURE_FAMILIES.flow) for (const h of [3, 7]) {
        results.push(famaMacBeth(byDate, priceBySymbol, id, h, { filter }));
      }
      report(`  --- ${label} ---`, results, zRegime);
    }
  }

  console.log('\nNote: every "SELECTED" above is a research finding, not a live signal. Promotion still '
    + 'requires the cross-sectional lane\'s own out-of-sample checkpoint.');
}

main().catch((e) => { console.error(e); process.exit(1); });
