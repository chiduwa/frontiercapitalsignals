// Drives the per-asset multiple regression over the real archive.
//
// Two passes, because they answer different questions and only one of them is
// a forecast:
//
//   INFERENCE  - full-sample multiple regression per asset, with robust errors,
//                a nested test per data lane, and an FDR correction across the
//                whole sweep. Answers "what does this asset respond to".
//   PREDICTION - walk-forward panel, pooled and shrunk at each refit, scored on
//                non-overlapping outcomes. Answers "what would it have called".
//
// The inference pass uses the whole sample and is therefore NOT a track record.
// It is labelled as such everywhere it is written down.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { d1, d1Batch, chunk } from './d1-client.mjs';
import { buildQuarantineIndex, cleanBars } from './bar-quarantine.mjs';
import { buildZooSection, ZOO_VERSION } from './model-zoo.mjs';
import {
  HIERARCHICAL_VERSION, buildAssetSample, fitAssetRegression, poolAcrossAssets, walkForwardPanel
} from './hierarchical-model.mjs';
import { assessTrackedPanel } from './tracked-data-quality.mjs';
import { FEATURE_NAMES, BLOCK_NAMES } from './panel-features.mjs';

const exec = promisify(execFile);
const directory = dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mean = xs => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
const quote = s => "'" + String(s).replaceAll("'", "''") + "'";
const ORIGIN = '2021-01-01';
const SYMBOL_BATCH = 20;

export function wranglerQuery() {
  return async (_env, sql, params = []) => {
    if (params.length) throw new Error('Wrangler research adapter requires parameter-free read queries');
    if (!/^\s*SELECT\b/i.test(sql)) throw new Error('Wrangler adapter is read-only');
    const { stdout } = await exec(resolve(directory, '../../node_modules/.bin/wrangler'), [
      'd1', 'execute', 'frontier-capital-signals-reliability', '--remote', '--json', '--command', sql
    ], { cwd: resolve(directory, '..'), maxBuffer: 256 * 1024 * 1024, timeout: 180000 });
    return JSON.parse(stdout).flatMap(r => r.results || []);
  };
}

/**
 * Bars, derivatives and supply for every archived asset. Batched by symbol
 * because D1 answers an oversized SELECT with a 7010 that looks like an outage
 * and is really a size ceiling -- it fails identically on every retry.
 */
export async function loadHierarchicalPanel(query, env, asOf, { log = console.log, symbols = null } = {}) {
  const scope = symbols?.length ? ` AND symbol IN (${[...new Set([...symbols, 'BTC', 'SPY'])].map(quote).join(',')})` : '';
  const assets = await query(env, `SELECT DISTINCT asset_class, symbol FROM asset_daily_bars
    WHERE (asset_class IN ('crypto','stock') OR symbol IN ('SPY','MCAP:BROAD','MCAP:TOTAL'))
      AND date >= '${ORIGIN}'${scope} ORDER BY asset_class, symbol`);
  const quarantineRows = await query(env, `SELECT asset_class, symbol, date, reason
    FROM asset_bar_quarantine WHERE reason IN ('spike','level-shift')`);
  const quarantine = new Map([...new Set(assets.map(a => a.asset_class))].map(cls =>
    [cls, buildQuarantineIndex(quarantineRows.filter(r => r.asset_class === cls))]));

  const panel = [];
  for (const page of chunk(assets, SYMBOL_BATCH)) {
    const tuples = page.map(a => `(${quote(a.asset_class)},${quote(a.symbol)})`).join(',');
    const rows = await query(env, `SELECT asset_class, symbol, date, open, high, low, close, volume, source FROM asset_daily_bars
      WHERE (asset_class, symbol) IN (${tuples}) AND date >= '${ORIGIN}' AND date < '${asOf}'
      ORDER BY symbol, date`);
    for (const asset of page) {
      const own = rows.filter(r => r.symbol === asset.symbol && r.asset_class === asset.asset_class);
      const bars = cleanBars(quarantine.get(asset.asset_class), asset.symbol, own);
      panel.push({ symbol: asset.symbol, assetClass: asset.asset_class, bars,
        quarantined: own.length - bars.length });
    }
    log(`[hierarchical] bars ${panel.length}/${assets.length}`);
  }

  const derivativeSymbols = (await query(env,
    `SELECT DISTINCT symbol FROM derivatives_daily WHERE 1=1${scope} ORDER BY symbol`)).map(r => r.symbol);
  const derivatives = new Map();
  for (const page of chunk(derivativeSymbols, SYMBOL_BATCH)) {
    const rows = await query(env, `SELECT symbol, date, oi_usd_close, taker_buy_sell_ratio,
      all_account_ls, toptrader_position_ls, oi_qty_close, samples, source FROM derivatives_daily
      WHERE symbol IN (${page.map(quote).join(',')}) AND date < '${asOf}' ORDER BY symbol, date`);
    for (const symbol of page) derivatives.set(symbol, rows.filter(r => r.symbol === symbol));
  }
  log(`[hierarchical] derivatives for ${derivatives.size} symbols`);

  const supply = new Map();
  const supplySymbols = (await query(env,
    `SELECT DISTINCT symbol FROM asset_supply_daily WHERE 1=1${scope} ORDER BY symbol`)).map(r => r.symbol);
  // Maximum supply is time-varying metadata. Never project today's snapshot
  // backward. Historical ratios require a dated, matching observation.
  const supplySnapshots = await query(env, `SELECT symbol, date, circulating_supply, max_supply
    FROM asset_supply_snapshot_daily WHERE date < '${asOf}'${scope} ORDER BY symbol, date`);
  const snapshotByKey = new Map(supplySnapshots.map(r => [`${r.symbol}|${r.date}`, r]));
  for (const page of chunk(supplySymbols, SYMBOL_BATCH * 3)) {
    const rows = await query(env, `SELECT symbol, date, circulating_supply FROM asset_supply_daily
      WHERE symbol IN (${page.map(quote).join(',')}) AND date < '${asOf}' ORDER BY symbol, date`);
    for (const symbol of page) {
      supply.set(symbol, rows.filter(r => r.symbol === symbol)
        .map(r => ({ ...r, max_supply: snapshotByKey.get(`${symbol}|${r.date}`)?.max_supply ?? null,
          snapshot_circulating_supply: snapshotByKey.get(`${symbol}|${r.date}`)?.circulating_supply ?? null })));
    }
  }
  log(`[hierarchical] supply for ${supply.size} symbols`);

  // Perpetual funding, per asset. Batched for the same D1 size ceiling reason.
  const funding = new Map();
  const fundingSymbols = (await query(env,
    `SELECT DISTINCT symbol FROM funding_rate_daily WHERE 1=1${scope} ORDER BY symbol`)).map(r => r.symbol);
  for (const page of chunk(fundingSymbols, SYMBOL_BATCH * 3)) {
    const rows = await query(env, `SELECT symbol, date, funding_rate, source FROM funding_rate_daily
      WHERE symbol IN (${page.map(quote).join(',')}) AND date >= '${ORIGIN}' AND date < '${asOf}'
        AND funding_rate IS NOT NULL ORDER BY symbol, date`);
    for (const symbol of page) funding.set(symbol, rows.filter(r => r.symbol === symbol));
  }
  log(`[hierarchical] funding for ${funding.size} symbols`);

  // Market-wide sentiment rides the symbol='' sentinel row, one value per date.
  const sentimentRows = await query(env, `SELECT date, fear_greed_altme FROM sentiment_daily
    WHERE symbol = '' AND date >= '${ORIGIN}' AND date < '${asOf}'
      AND fear_greed_altme IS NOT NULL ORDER BY date`);
  log(`[hierarchical] sentiment for ${sentimentRows.length} dates`);

  // Only the bounded specialist audit uses order-book features. Do not add a
  // universe-wide unbounded SELECT to the existing daily regression job.
  const liquidity = [];
  if (symbols?.length) for (const page of chunk(symbols, SYMBOL_BATCH)) {
    liquidity.push(...await query(env, `SELECT symbol, date, book_imbalance_1pct, depth_1pct_usd, snapshots, source
      FROM asset_liquidity_daily WHERE date >= '${ORIGIN}' AND date < '${asOf}'
        AND symbol IN (${page.map(quote).join(',')}) ORDER BY symbol, date`));
  }
  return { asOf, assets: panel, liquidity,
    supplySnapshots,
    derivatives: Object.fromEntries(derivatives), supply: Object.fromEntries(supply),
    funding: Object.fromEntries(funding),
    sentiment: sentimentRows.map(r => [r.date, r.fear_greed_altme]) };
}

const modelClassOf = assetClass => (['stock', 'benchmark'].includes(assetClass) ? 'stock' : 'crypto');
const horizonsFor = modelClass => (modelClass === 'stock' ? [1, 5] : [1, 7]);

/** The inference pass: one multiple regression per asset, corrected as a family. */
export function runInference(panel, { asOf, minObservations = 60, maxVif = 10, log = console.log } = {}) {
  const derivatives = new Map(Object.entries(panel.derivatives || {}));
  const supply = new Map(Object.entries(panel.supply || {}));
  const benchmarks = {
    crypto: panel.assets.find(a => a.symbol === 'BTC' && a.assetClass === 'crypto')?.bars || [],
    stock: panel.assets.find(a => a.symbol === 'SPY')?.bars || []
  };
  const funding = new Map(Object.entries(panel.funding || {}));
  const sentimentByDate = new Map(panel.sentiment || []);
  const out = {};
  for (const modelClass of ['crypto', 'stock']) {
    const benchmarkByDate = new Map(benchmarks[modelClass].map(b => [b.date, b.close]));
    for (const horizon of horizonsFor(modelClass)) {
      const fits = [];
      const members = panel.assets.filter(a => modelClassOf(a.assetClass) === modelClass);
      log(`[hierarchical] fitting ${members.length} ${modelClass} assets at ${horizon}d`);
      let done = 0;
      for (const asset of panel.assets) {
        if (modelClassOf(asset.assetClass) !== modelClass) continue;
        // A silent fifteen-minute pass is indistinguishable from a hang.
        if (++done % 50 === 0) log(`[hierarchical]   ${done}/${members.length} ${modelClass} ${horizon}d`);
        const sample = buildAssetSample(asset.bars, {
          horizon, assetClass: modelClass, benchmarkByDate,
          funding: funding.get(asset.symbol) || [], sentimentByDate,
          derivatives: derivatives.get(asset.symbol) || [],
          supply: supply.get(asset.symbol) || []
        });
        fits.push(fitAssetRegression(sample, { symbol: asset.symbol, assetClass: modelClass,
          horizon, maxVif, minObservations }));
      }
      const fitted = fits.filter(f => f.status === 'fitted');
      out[`${modelClass}|${horizon}`] = {
        assetClass: modelClass, horizon, asOf,
        attempted: fits.length, fitted: fitted.length,
        pooling: fitted.length >= 2 ? poolAcrossAssets(fitted) : null,
        laneEvidence: summarizeLanes(fitted),
        fits: fitted.map(compactFit)
      };
    }
  }
  return out;
}

/** Across every asset: how often did each lane clear its own nested test? */
export function summarizeLanes(fits) {
  const out = {};
  for (const block of BLOCK_NAMES) {
    const tests = fits.map(f => f.blocks?.[block]).filter(Boolean);
    if (!tests.length) continue;
    const significant = tests.filter(t => t.pValue != null && t.pValue < 0.05).length;
    out[block] = {
      assetsTested: tests.length, significantAt5pct: significant,
      // Under a true null, 5% of tests land below 0.05 by construction. The
      // comparison that matters is observed-vs-expected, not the raw count.
      expectedUnderNull: tests.length * 0.05,
      medianIncrementalRSquared: medianOf(tests.map(t => t.incrementalRSquared).filter(Number.isFinite))
    };
  }
  return out;
}

const medianOf = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const compactFit = f => ({
  symbol: f.symbol, observations: f.observations, rSquared: f.regression.rSquared,
  adjustedRSquared: f.regression.adjustedRSquared,
  jointPValue: f.regression.jointSignificance?.pValue ?? null,
  maxVif: Math.max(0, ...Object.values(f.regression.vif).filter(Number.isFinite)),
  durbinWatson: f.regression.residualDiagnostics.durbinWatson,
  ljungBoxP: f.regression.residualDiagnostics.ljungBox?.pValue ?? null,
  breuschPaganP: f.regression.residualDiagnostics.breuschPagan?.pValue ?? null,
  jarqueBeraP: f.regression.residualDiagnostics.jarqueBera?.pValue ?? null,
  aic: f.regression.residualDiagnostics.aic, bic: f.regression.residualDiagnostics.bic,
  lanes: f.lanesPresent, blocks: f.blocks,
  coefficients: f.regression.coefficients.map(c => ({
    name: c.name, estimate: c.estimate, standardError: c.standardError,
    tStatistic: c.tStatistic, pValue: c.pValue
  }))
});

/** The prediction pass: walk-forward, pooled and shrunk at every refit. */
export function runPrediction(panel, { asOf, costBps = 20, refitEvery = 21, log = console.log } = {}) {
  const derivatives = new Map(Object.entries(panel.derivatives || {}));
  const supply = new Map(Object.entries(panel.supply || {}));
  const fundingBySymbol = new Map(Object.entries(panel.funding || {}));
  const sentimentByDate = new Map(panel.sentiment || []);
  const benchmarks = {
    crypto: panel.assets.find(a => a.symbol === 'BTC' && a.assetClass === 'crypto')?.bars || [],
    stock: panel.assets.find(a => a.symbol === 'SPY')?.bars || []
  };
  const out = {};
  for (const modelClass of ['crypto', 'stock']) {
    const members = panel.assets.filter(a => modelClassOf(a.assetClass) === modelClass);
    if (!members.length) continue;
    for (const horizon of horizonsFor(modelClass)) {
      log(`[hierarchical] walk-forward ${modelClass} ${horizon}d over ${members.length} assets`);
      const result = walkForwardPanel(members, {
        horizon, assetClass: modelClass, asOf, benchmark: benchmarks[modelClass],
        derivativesBySymbol: derivatives, supplyBySymbol: supply,
        fundingBySymbol, sentimentByDate, costBps, refitEvery
      });
      const { outcomes, ...rest } = result;
      // Score the whole candidate field on the same forecasts, split by
      // survivorship cohort. This exists because a combination rule once
      // cleared every persistence check this project had and was still an
      // artifact of recently-listed assets; a cohort split catches that class
      // of error automatically instead of relying on someone thinking to look.
      let zoo = null;
      try {
        zoo = buildZooSection(members, outcomes, { horizon, costPct: costBps / 100 });
      } catch (error) {
        // The field is diagnostic. It must never be able to fail the run that
        // produces the actual research output.
        zoo = { zooVersion: ZOO_VERSION, actionable: false, status: 'failed', error: String(error?.message || error) };
      }
      out[`${modelClass}|${horizon}`] = { ...rest, zoo };
    }
  }
  return out;
}

export function buildHierarchicalReport(panel, {
  asOf, costBps = 20, refitEvery = 21, now = new Date().toISOString(), log = console.log
} = {}) {
  const inference = runInference(panel, { asOf, log });
  const prediction = runPrediction(panel, { asOf, costBps, refitEvery, log });
  const inputHash = hash(panel);
  const summary = {
    modelVersion: HIERARCHICAL_VERSION, asOf, generatedAt: now,
    status: 'shadow', actionable: false,
    dataQuality: assessTrackedPanel({ ...panel, asOf }),
    features: FEATURE_NAMES.length, lanes: BLOCK_NAMES,
    assets: panel.assets.length,
    costs: { roundTripBps: costBps, fundingBorrowAndImpactIncluded: false },
    inference: Object.fromEntries(Object.entries(inference).map(([key, v]) => [key, {
      attempted: v.attempted, fitted: v.fitted,
      multipleComparisons: v.pooling?.multipleComparisons ?? null,
      lanes: v.laneEvidence,
      heterogeneity: v.pooling ? topHeterogeneity(v.pooling.heterogeneity) : null
    }])),
    prediction: Object.fromEntries(Object.entries(prediction).map(([key, v]) => [key, {
      assets: v.assets?.length ?? 0, metrics: v.metrics, byDate: v.byDate,
      // Two different populations, and they do not agree -- deliberately.
      // `atFinalRefit` is the per-asset mean at the END of the walk-forward.
      // `overScoredForecasts` averages across every forecast ever made,
      // including the long early stretch when no heterogeneity was yet
      // detectable and every asset was fully pooled. Reporting only the first
      // would overstate how long the model has actually been learning per asset.
      shrinkage: {
        atFinalRefit: mean((v.assets || []).map(a => a.meanShrinkage).filter(Number.isFinite)),
        overScoredForecasts: v.metrics?.meanShrinkage ?? null,
        learnedFeatures: learnedFeatures(v.prior)
      },
      // The candidate field, always cohort-split. A number here that appears
      // only under `recent` is survivorship until shown otherwise.
      zoo: v.zoo ?? null
    }])),
    limitations: [
      'Walk-forward research over archived daily closes. Daily closes are not executable issue-time quotes, so none of this is a live track record.',
      'The inference pass uses the FULL sample by design. Its coefficients describe the history; they are not out-of-sample evidence.',
      'Shrinkage weights report how much per-asset variation the data supports. A low weight is a measurement, not a failure to fit.',
      'Costs are a flat round-trip assumption. Funding, borrow, market impact and venue spread are not modelled.',
      'No automatic promotion. Publication still requires clearing the existing evidence gate on unseen forward outcomes.'
    ]
  };
  return { runId: hash({ version: HIERARCHICAL_VERSION, asOf, costBps, refitEvery, inputHash }),
    inputHash, summary, inference, prediction };
}

/**
 * Features whose between-asset spread exceeded sampling noise at the final
 * refit -- i.e. the ones where the model ended up genuinely per-asset. An
 * empty list is the expected result, not an error.
 */
const learnedFeatures = (prior, threshold = 0.05) => !prior ? [] :
  Object.entries(prior)
    .filter(([, v]) => v && Number.isFinite(v.iSquared) && v.iSquared > threshold && v.tauSquared > 0)
    .sort((a, b) => b[1].iSquared - a[1].iSquared)
    .map(([feature, v]) => ({ feature, iSquared: v.iSquared, assets: v.assets }));

const topHeterogeneity = (heterogeneity, limit = 8) =>
  Object.entries(heterogeneity)
    .filter(([, v]) => Number.isFinite(v.iSquared))
    .sort((a, b) => b[1].iSquared - a[1].iSquared)
    .slice(0, limit)
    .map(([name, v]) => ({ feature: name, iSquared: v.iSquared, tau: v.tau, assets: v.assets }));

export function reportMarkdown(report) {
  const n = (x, digits = 4) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(digits));
  const pct = x => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(2)}%`);
  const lines = [
    '# FCS per-asset multiple regression research', '',
    `As of ${report.summary.asOf}. Model \`${report.summary.modelVersion}\`. Input hash \`${report.inputHash}\`.`,
    '',
    `${report.summary.assets} assets, ${report.summary.features} candidate regressors across ` +
    `${report.summary.lanes.length} data lanes. Shadow research; \`actionable: false\`.`, '',
    '## Prediction — walk-forward, pooled, shrunk', '',
    '| Class / horizon | Assets | Scored | Direction | MAE % | Zero-forecast MAE % | OOS R² | Band coverage | Net %/period | Dates | t |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
  ];
  for (const [key, v] of Object.entries(report.summary.prediction)) {
    const m = v.metrics || {};
    lines.push(`| ${key} | ${v.assets} | ${m.observations ?? 0} | ${pct(m.directionalAccuracy)} | ` +
      `${n(m.meanAbsoluteErrorPct, 3)} | ${n(m.zeroForecastErrorPct, 3)} | ${n(m.outOfSampleR2, 5)} | ` +
      `${pct(m.intervalCoverage)} | ${n(m.meanNetReturnPct, 4)} | ${v.byDate?.decisionDates ?? '—'} | ` +
      `${n(v.byDate?.tStatistic, 2)} |`);
  }
  lines.push('', '## What the walk-forward actually learned per asset', '',
    'Shrinkage is per feature: 0 means the asset was handed its class coefficient,',
    '1 means its own history earned the right to differ. These are the features whose',
    'between-asset spread exceeded sampling noise by the final refit.', '',
    '| Class / horizon | Mean shrinkage (final) | Mean over all forecasts | Features learned per asset |',
    '|---|---:|---:|---|');
  for (const [key, v] of Object.entries(report.summary.prediction)) {
    const learned = (v.shrinkage.learnedFeatures || [])
      .map(f => `${f.feature} (I²=${(f.iSquared * 100).toFixed(0)}%, n=${f.assets})`).join('; ');
    lines.push(`| ${key} | ${n(v.shrinkage.atFinalRefit, 4)} | ${n(v.shrinkage.overScoredForecasts, 4)} | ${learned || '**none**'} |`);
  }
  lines.push('', '## Does any asset deserve its own coefficients? (full sample)', '',
    'I² is the share of between-asset spread that is real rather than sampling noise.',
    'At I² ≈ 0 every asset is handed its class coefficient, automatically.', '');
  for (const [key, v] of Object.entries(report.summary.inference)) {
    lines.push(`**${key}** — ${v.fitted}/${v.attempted} fitted; ` +
      `${v.multipleComparisons?.discoveries ?? 0} of ${v.multipleComparisons?.tests ?? 0} ` +
      'coefficient tests survive Benjamini-Hochberg at q=0.10.', '',
      '| Feature | I² | τ | Assets |', '|---|---:|---:|---:|');
    for (const h of v.heterogeneity || []) {
      lines.push(`| ${h.feature} | ${pct(h.iSquared)} | ${n(h.tau)} | ${h.assets} |`);
    }
    lines.push('');
  }
  lines.push('## Which data lanes earned their degrees of freedom?', '',
    'Nested Wald test per lane, per asset. Compare `significant` against `expected under null`:',
    'a lane that only matches the null rate has explained nothing.', '');
  for (const [key, v] of Object.entries(report.summary.inference)) {
    lines.push(`**${key}**`, '', '| Lane | Assets tested | Significant at 5% | Expected under null | Median incremental R² |',
      '|---|---:|---:|---:|---:|');
    for (const [lane, s] of Object.entries(v.lanes || {})) {
      lines.push(`| ${lane} | ${s.assetsTested} | ${s.significantAt5pct} | ${s.expectedUnderNull.toFixed(1)} | ${n(s.medianIncrementalRSquared, 5)} |`);
    }
    lines.push('');
  }
  lines.push('## Limitations', '', ...report.summary.limitations.map(s => `- ${s}`), '');
  return lines.join('\n');
}

export async function persistHierarchicalReport(env, report, { batch = d1Batch, query = d1 } = {}) {
  const statements = [];
  for (const [key, value] of Object.entries(report.prediction)) {
    const [assetClass, horizon] = key.split('|');
    for (const asset of value.assets || []) {
      statements.push({
        sql: `INSERT OR IGNORE INTO hierarchical_research_assets
          (run_id, asset_class, symbol, horizon, snapshot_json) VALUES (?,?,?,?,?)`,
        params: [report.runId, assetClass, asset.symbol, Number(horizon), JSON.stringify(asset)]
      });
    }
  }
  for (const group of chunk(statements, 20)) await batch(env, group);
  // The run row lands last, so a partially written snapshot set is never
  // discoverable as a completed run.
  await query(env, `INSERT OR IGNORE INTO hierarchical_research_runs
    (run_id, model_version, created_at, as_of, input_hash, summary_json) VALUES (?,?,?,?,?,?)`,
  [report.runId, HIERARCHICAL_VERSION, report.summary.generatedAt, report.summary.asOf,
    report.inputHash, JSON.stringify(report.summary)]);
}

export async function loadHierarchicalHealth(env, nowMs = Date.now(), query = d1) {
  const rows = await query(env, `SELECT created_at, summary_json FROM hierarchical_research_runs
    WHERE model_version = ? ORDER BY created_at DESC LIMIT 1`, [HIERARCHICAL_VERSION]);
  if (!rows.length) return { status: 'awaiting-first-run', actionable: false };
  const summary = JSON.parse(rows[0].summary_json);
  const ageHours = (nowMs - Date.parse(rows[0].created_at)) / 3600000;
  return { ...summary, ageHours,
    status: !Number.isFinite(ageHours) || ageHours < 0 || ageHours > 36 ? 'stale' : 'shadow',
    actionable: false };
}

async function main() {
  const arg = name => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; };
  const asOf = arg('as-of') || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !Number.isFinite(Date.parse(asOf))) throw new Error('Invalid --as-of date');
  const input = arg('input'), useWrangler = process.argv.includes('--wrangler');
  const dryRun = process.argv.includes('--dry-run');
  if (useWrangler && !dryRun) throw new Error('--wrangler is read-only; add --dry-run');
  const panel = input
    ? JSON.parse(await readFile(input, 'utf8'))
    : await loadHierarchicalPanel(useWrangler ? wranglerQuery() : d1, process.env, asOf, { symbols: arg('symbols')?.split(',') });
  if (arg('save-input')) {
    await writeFile(resolve(arg('save-input')), JSON.stringify(panel));
    console.log(`Panel saved: ${resolve(arg('save-input'))}`);
    if (process.argv.includes('--load-only')) return;
  }
  if (!panel.assets?.length) throw new Error('No archived assets; refusing an empty successful run');
  const output = resolve(arg('output') || 'reports/hierarchical');
  const report = buildHierarchicalReport(panel, { asOf, costBps: Number(arg('cost-bps') ?? 20),
    refitEvery: Number(arg('refit-every') ?? 21) });
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(output, 'report.md'), reportMarkdown(report));
  if (!dryRun) await persistHierarchicalReport(process.env, report);
  console.log(JSON.stringify(report.summary.prediction, null, 2));
  console.log(`Report: ${resolve(output, 'report.md')}${dryRun ? ' (no D1 writes)' : ''}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
}
