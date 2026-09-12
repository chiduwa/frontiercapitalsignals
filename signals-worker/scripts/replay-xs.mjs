// Walk-forward replay of the CROSS-SECTIONAL lane, to give its publication gate
// the matured evidence it has been starved of.
//
// WHY
//
// The XS lane holds the only feature in this project that has ever cleared a
// real bar: oi_px_divergence, t=3.79 Newey-West over 1,091 sections, SELECTED
// out of a 35-feature panel. None of that reaches a reader, because publication
// is gated on xs_decile_evidence, which needs XS_PUBLICATION_MIN_SAMPLES (200)
// matured observations per decile — and that table is folded from
// xs_forecast_log, the LIVE shadow log, which on 2026-09-12 held five days:
// 396 matured observations at 1d spread across ten deciles (~40 each), and
// ZERO at 7d.
//
// So the lane is starved in exactly the way the direction model was, for
// exactly the same reason: its evidence only accrues from live casts, one
// cast per asset per day. The medicine is the same — walk it over the archive.
//
// THE THING THAT MAKES THIS HARD, AND THE RULE THAT HANDLES IT
//
// A direction replay only has to avoid look-ahead in its FEATURES. This one
// also has to avoid it in its COEFFICIENTS. Scoring 2022 with betas fitted on
// 2021-2026 is not a backtest, it is a description of the answer — and it would
// look excellent, which is the dangerous part.
//
// So coefficients are refit walk-forward: at section i the fit may only see
// sections strictly before i. Refitting on every section would be exact and
// pointlessly slow (the fit is O(sections x features)), so it refits every
// XS_REPLAY_REFIT_EVERY sections and carries the last fit forward. Carrying a
// STALE fit forward is conservative — it uses less information than a live
// refit would have had — so it can only understate the lane, never flatter it.
//
// Sections before the first successful fit are skipped entirely rather than
// scored with no coefficients.
//
// Usage:
//   node scripts/replay-xs.mjs --asset-class crypto --horizons 1,7
//   node scripts/replay-xs.mjs --dry-run

import { buildXsPanel, xsForecast, xsPercentiles } from '../worker.js';
import { d1, d1Batch, chunk } from './d1-client.mjs';
import {
  loadArchiveBars, loadFundamentalsPanel, buildWeeklyCrossSections,
  fitCoefficients, foldDecileEvidence, XS_METHOD_VERSION, XS_MIN_ESTIMATION_WEEKS
} from './cross-sectional.mjs';

const env = process.env;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
const has = (name) => process.argv.includes(`--${name}`);

// Sections between refits. At stride=1 a section is a day, so 30 means the
// betas a forecast is scored with are at most a month stale — well inside the
// window over which this lane's own coefficient history moves, and 60x cheaper
// than refitting on every section.
export const XS_REPLAY_REFIT_EVERY = 30;

// How the replay marks its rows. Deliberately NOT XS_METHOD_VERSION: mixing
// replayed and live observations in one decile cell would make the published
// evidence unauditable, and foldDecileEvidence groups by method_version, so a
// distinct version keeps the two populations in separate rows of
// xs_decile_evidence rather than silently pooled.
export const XS_REPLAY_METHOD_VERSION = `${XS_METHOD_VERSION}-replay`;

// Builds the matured forecast rows for one class and horizon, walk-forward.
// Exported for test-replay-xs.mjs; does no I/O of its own.
export function replayXsSections(sections, horizonDays, { refitEvery = XS_REPLAY_REFIT_EVERY, minSections = XS_MIN_ESTIMATION_WEEKS } = {}) {
  const out = [];
  let coefficients = null;
  let fittedThrough = -1;
  let fits = 0, skippedNoFit = 0;

  for (let i = 0; i < sections.length; i++) {
    // Refit on everything STRICTLY BEFORE this section. The slice bound is the
    // entire no-look-ahead guarantee for the coefficients, so it is written
    // once, here, rather than threaded through a helper.
    if (i >= minSections && (coefficients === null || i - fittedThrough >= refitEvery)) {
      const fit = fitCoefficients(sections.slice(0, i));
      fittedThrough = i;
      fits++;
      // A failed fit does not clear the previous one: the lane's honest state
      // is "the last thing we established", not "nothing". If nothing has ever
      // fitted, coefficients stays null and the sections below are skipped.
      if (fit && fit.ok) coefficients = fit.coefficients;
    }
    if (!coefficients) { skippedNoFit++; continue; }

    const section = sections[i];
    const panel = buildXsPanel(section.members.map((m) => m.metrics));
    if (!panel) continue;
    const forecasts = panel.map((row) => xsForecast(row.ranks, coefficients));
    const percentiles = xsPercentiles(forecasts);
    // The benchmark every excess return is measured against: the equal-weighted
    // return of the names actually scored in THIS section. Not the class as a
    // whole and not a fixed index — the claim being tested is "this decile beat
    // its own cross-section".
    const universeReturn = section.members.reduce((a, m) => a + m.forward, 0) / section.members.length;

    for (let k = 0; k < panel.length; k++) {
      const f = forecasts[k];
      if (!f || percentiles[k] == null) continue;
      const member = section.members[k];
      if (!member || !Number.isFinite(member.forward)) continue;
      out.push({
        run_at: `${section.date}T00:00:00.000Z`,
        symbol: member.symbol,
        // buildWeeklyCrossSections returns only the anchor date; the maturity
        // date is derived rather than defaulted to the anchor, which would file
        // every matured row as resolving on the day it was cast.
        target_date: new Date(Date.parse(`${section.date}T00:00:00Z`) + horizonDays * 86400000).toISOString().slice(0, 10),
        expected_return_pct: f.expectedReturnPct,
        percentile: Math.round(percentiles[k]),
        decile: Math.min(9, Math.floor(percentiles[k] / 10)),
        features_used: f.featuresUsed,
        universe_size: panel.length,
        realised_return_pct: member.forward,
        universe_return_pct: universeReturn
      });
    }
  }
  return { rows: out, fits, skippedNoFit };
}

async function writeRows(assetClass, horizonDays, rows, dryRun) {
  if (dryRun || !rows.length) return rows.length;
  const now = new Date().toISOString();
  const statements = chunk(rows, 4).map((batch) => ({
    sql: `INSERT INTO xs_forecast_log
            (run_at, asset_class, symbol, horizon_days, target_date, expected_return_pct,
             percentile, decile, entry_price, features_used, universe_size,
             realised_return_pct, universe_return_pct, observed_at, method_version, aggregated)
          VALUES ${batch.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)').join(',')}`,
    // entry_price is CHECK (> 0) and carries no information for an already
    // matured row — the return is stored directly — so it is filled with 1
    // rather than dragging close prices through the whole pipeline to satisfy
    // a constraint that exists for the live path's benefit.
    params: batch.flatMap((r) => [
      r.run_at, assetClass, r.symbol, horizonDays, r.target_date, r.expected_return_pct,
      r.percentile, r.decile, 1, r.features_used, r.universe_size,
      r.realised_return_pct, r.universe_return_pct, now, XS_REPLAY_METHOD_VERSION
    ])
  }));
  for (const group of chunk(statements, 25)) await d1Batch(env, group);
  return rows.length;
}

// ONE OBSERVATION PER SECTION PER DECILE, never one per asset.
//
// A decile holds ~10 names drawn from the same cross-section on the same day,
// so pooling them treats correlated draws as independent trials.
//
// Measured on this lane's own output, the inflation here is real but modest:
// decile 9 reads t=5.01 pooled per observation and t=4.53 per section. It is
// smaller than the sqrt(10) a naive argument would predict, and the reason is
// worth keeping: the excess return is already demeaned against its OWN
// section's universe return, which removes most of the common factor before
// the averaging happens. Both columns are printed so that stays visible
// instead of being asserted.
//
// This is the same correction Fama-MacBeth applies in the fit, the same one
// neweyWestSE applies to the beta series, and the same one that cut
// oi_px_divergence from 8.63 to 3.79. It has to apply here too or the gate is
// measuring something the rest of the engine has explicitly rejected.
function summarise(assetClass, horizonDays, rows) {
  const perSection = new Map(); // decile -> Map(sectionDate -> [excess])
  for (const r of rows) {
    if (!perSection.has(r.decile)) perSection.set(r.decile, new Map());
    const byDate = perSection.get(r.decile);
    if (!byDate.has(r.run_at)) byDate.set(r.run_at, []);
    byDate.get(r.run_at).push(r.realised_return_pct - r.universe_return_pct);
  }
  console.log(`\n[xs-replay] ${assetClass} ${horizonDays}d: decile evidence from ${rows.length} matured observations`);
  console.log('            decile   sections      obs   mean excess %   per-section t   pooled t (WRONG)');
  for (let d = 0; d <= 9; d++) {
    const byDate = perSection.get(d);
    if (!byDate || !byDate.size) { console.log(`            ${String(d).padStart(6)}          0`); continue; }
    const sectionMeans = [...byDate.values()].map((e) => e.reduce((a, b) => a + b, 0) / e.length);
    const obs = [...byDate.values()].reduce((a, e) => a + e.length, 0);
    const k = sectionMeans.length;
    const mean = sectionMeans.reduce((a, b) => a + b, 0) / k;
    const sd = k > 1 ? Math.sqrt(sectionMeans.reduce((a, b) => a + (b - mean) ** 2, 0) / (k - 1)) : 0;
    const t = sd > 0 ? mean / (sd / Math.sqrt(k)) : null;
    const flat = [...byDate.values()].flat();
    const pooledMean = flat.reduce((a, b) => a + b, 0) / flat.length;
    const pooledSd = flat.length > 1 ? Math.sqrt(flat.reduce((a, b) => a + (b - pooledMean) ** 2, 0) / (flat.length - 1)) : 0;
    const pooledT = pooledSd > 0 ? pooledMean / (pooledSd / Math.sqrt(flat.length)) : null;
    console.log(`            ${String(d).padStart(6)} ${String(k).padStart(10)} ${String(obs).padStart(8)} ${mean.toFixed(3).padStart(15)} ${String(t == null ? 'n/a' : t.toFixed(2)).padStart(15)} ${String(pooledT == null ? 'n/a' : pooledT.toFixed(2)).padStart(18)}`);
  }
  console.log('            Read the per-section column. The pooled one is printed only to show'
    + ' how much it overstates, and must never be quoted.');
  console.log('            Monotonicity matters more than any single decile: a real ranking signal'
    + ' rises across them. An effect in decile 9 alone is a top-decile effect, which is'
    + ' a narrower and more fragile claim than a ranking.');
}

async function main() {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN || !env.FCS_D1_DATABASE_ID) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and FCS_D1_DATABASE_ID are required');
  }
  const dryRun = has('dry-run');
  const classes = arg('asset-class') && arg('asset-class') !== true ? [String(arg('asset-class'))] : ['crypto'];
  const horizons = String(arg('horizons', '1,7')).split(',').map((s) => Number(s.trim())).filter(Boolean);

  console.log(`[xs-replay] method=${XS_REPLAY_METHOD_VERSION} refit every ${XS_REPLAY_REFIT_EVERY} sections${dryRun ? ' DRY RUN' : ''}`);

  for (const assetClass of classes) {
    const bars = await loadArchiveBars(env, assetClass, Number(arg('lookback', 2200)));
    if (!bars.size) { console.log(`[xs-replay] ${assetClass}: no bars`); continue; }
    const extras = await loadFundamentalsPanel(env, assetClass, bars);
    for (const horizonDays of horizons) {
      // Signature is (barsBySymbol, horizonDays, maxWeeks, extras) — passing
      // `extras` third puts the panel in the anchor-count slot, which yields a
      // NaN anchor count and silently zero sections rather than an error.
      const sections = buildWeeklyCrossSections(bars, horizonDays, null, extras);
      console.log(`[xs-replay] ${assetClass} ${horizonDays}d: ${sections.length} sections`);
      if (!sections.length) continue;
      const { rows, fits, skippedNoFit } = replayXsSections(sections, horizonDays);
      console.log(`[xs-replay] ${assetClass} ${horizonDays}d: ${fits} walk-forward refits, `
        + `${skippedNoFit} sections before the first fit, ${rows.length} matured observations`);
      summarise(assetClass, horizonDays, rows);
      await writeRows(assetClass, horizonDays, rows, dryRun);
    }
  }
  if (!dryRun) {
    const { deciles } = await foldDecileEvidence(env);
    console.log(`\n[xs-replay] folded ${deciles} decile rows`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('[xs-replay] failed:', e); process.exit(1); });
}
