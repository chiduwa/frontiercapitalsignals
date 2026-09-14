import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { d1, d1Batch, chunk } from './d1-client.mjs';
import { buildQuarantineIndex, cleanBars } from './bar-quarantine.mjs';
import { ADAPTIVE_VERSION, walkForwardAsset } from './adaptive-model.mjs';

const exec = promisify(execFile);
const directory = dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mean = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
const TARGET_SCOPES = {
  BTC: 'Bitcoin; crypto benchmark, not the entire crypto market',
  SPY: 'US large-cap equity ETF proxy',
  'MCAP:BROAD': 'Equal-weight tracked-crypto proxy; historical membership is not point-in-time',
  'MCAP:TOTAL': 'Archived total crypto market capitalization; not an executable asset'
};

// Local research can use Wrangler's existing OAuth session without reading,
// displaying or copying its credential. Actions use the existing REST client.
export function wranglerQuery() {
  return async (_env, sql, params = []) => {
    if (params.length) throw new Error('Wrangler research adapter requires parameter-free read queries');
    if (!/^\s*SELECT\b/i.test(sql)) throw new Error('Wrangler adapter is read-only');
    const { stdout } = await exec(resolve(directory, '../../node_modules/.bin/wrangler'), [
      'd1', 'execute', 'frontier-capital-signals-reliability', '--remote', '--json', '--command', sql
    ], { cwd: resolve(directory, '..'), maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
    return JSON.parse(stdout).flatMap(r => r.results || []);
  };
}

export async function loadAdaptivePanel(query, env, asOf) {
  // Anchor the study at an absolute date. A sliding start would change all
  // subsequent training states each day and make repeated runs incomparable.
  const since = '2021-01-01';
  const assets = await query(env, `SELECT DISTINCT asset_class, symbol FROM asset_daily_bars
    WHERE (asset_class IN ('crypto','stock') OR symbol IN ('SPY','MCAP:BROAD','MCAP:TOTAL'))
      AND date >= '${since}' ORDER BY asset_class, symbol`);
  const quarantineRows = await query(env, `SELECT asset_class, symbol, date, reason FROM asset_bar_quarantine
    WHERE reason IN ('spike','level-shift')`);
  const quarantine = new Map([...new Set(assets.map(a => a.asset_class))].map(cls =>
    [cls, buildQuarantineIndex(quarantineRows.filter(r => r.asset_class === cls))]));
  const panel = [];
  const quote = s => "'" + s.replaceAll("'", "''") + "'";
  for (const page of chunk(assets, 20)) {
    const tuples = page.map(a => `(${quote(a.asset_class)},${quote(a.symbol)})`).join(',');
    const rows = await query(env, `SELECT asset_class, symbol, date, close, volume, source FROM asset_daily_bars
      WHERE (asset_class, symbol) IN (${tuples}) AND date >= '${since}' AND date < '${asOf}' ORDER BY symbol, date`);
    // Query includes identities below so same-ticker asset classes stay apart.
    for (const asset of page) {
      const own = rows.filter(r => r.symbol === asset.symbol && r.asset_class === asset.asset_class);
      const bars = cleanBars(quarantine.get(asset.asset_class), asset.symbol, own);
      panel.push({ symbol: asset.symbol, assetClass: asset.asset_class, bars, quarantined: own.length - bars.length });
    }
    console.log(`[adaptive] loaded ${panel.length}/${assets.length} assets`);
  }
  return panel;
}

export function buildAdaptiveReport(panel, { asOf, costBps = 20, now = new Date().toISOString() } = {}) {
  const assets = [], periodGroups = new Map();
  const btc = panel.find(a => a.symbol === 'BTC' && a.assetClass === 'crypto')?.bars || [];
  const spy = panel.find(a => a.symbol === 'SPY')?.bars || [];
  for (const asset of panel) {
    const modelClass = ['stock', 'benchmark'].includes(asset.assetClass) ? 'stock' : 'crypto';
    const benchmark = modelClass === 'stock' ? spy : btc;
    for (const horizon of modelClass === 'stock' ? [1, 5] : [1, 7]) {
      const result = walkForwardAsset(asset.bars, { symbol: asset.symbol, assetClass: modelClass,
        horizon, asOf, costBps, benchmark });
      for (const o of result.outcomes) {
        const key = `${asset.assetClass}|${horizon}|${o.asOf}`;
        const group = periodGroups.get(key) || [];
        group.push(o.netReturnPct);
        periodGroups.set(key, group);
      }
      const { outcomes, ...summary } = result;
      assets.push({ ...summary, archiveClass: asset.assetClass, scope: TARGET_SCOPES[asset.symbol] || 'individual asset',
        quarantined: asset.quarantined || 0,
        limitations: asset.assetClass === 'market' ? ['proxy-or-capitalization-target-not-tradable'] : [] });
    }
  }
  const grouped = {};
  for (const [key, values] of periodGroups) {
    const [cls, h] = key.split('|');
    (grouped[`${cls}|${h}`] ||= []).push(mean(values));
  }
  const summary = {
    modelVersion: ADAPTIVE_VERSION, asOf, generatedAt: now, status: 'shadow', actionable: false,
    assets: panel.length, assetHorizons: assets.length,
    freshForecasts: assets.filter(a => a.forecast).length,
    staleOrUnavailable: assets.filter(a => !a.forecast).length,
    costs: { roundTripBps: costBps, fundingBorrowAndImpactIncluded: false },
    groups: Object.fromEntries(Object.entries(grouped).map(([key, values]) => [key,
      { decisionDates: values.length, equalWeightMeanNetPct: mean(values), inference: 'descriptive; no pooled asset significance' }])),
    limitations: [
      'Historical walk-forward research, not a live trading track record; daily closes are not executable issue-time quotes.',
      'The archive uses current/historical tracked membership and retrospective quarantine; survivorship and data revisions remain.',
      'Rolling residual coverage is measured, not a distribution-free guarantee under market regime changes.',
      'No automatic promotion. Require unseen forward performance, calibrated intervals, and venue-specific costs before trading.'
    ]
  };
  const inputHash = hash(panel);
  return { runId: hash({ version: ADAPTIVE_VERSION, asOf, costBps, inputHash }), inputHash, summary, assets };
}

export async function persistAdaptiveReport(env, report, { batch = d1Batch, query = d1 } = {}) {
  const statements = report.assets.map(a => ({
    sql: `INSERT OR IGNORE INTO adaptive_research_snapshots
      (run_id, asset_class, symbol, horizon, snapshot_json) VALUES (?,?,?,?,?)`,
    params: [report.runId, a.archiveClass, a.symbol, a.horizon, JSON.stringify(a)]
  }));
  for (const group of chunk(statements, 20)) await batch(env, group);
  // Only completed snapshots become discoverable. Retrying the same input
  // hash is idempotent, and no old forecast ledger or weight is overwritten.
  await query(env, `INSERT OR IGNORE INTO adaptive_research_runs
    (run_id, model_version, created_at, as_of, input_hash, summary_json) VALUES (?,?,?,?,?,?)`,
  [report.runId, ADAPTIVE_VERSION, report.summary.generatedAt, report.summary.asOf, report.inputHash, JSON.stringify(report.summary)]);
}

export async function loadAdaptiveHealth(env, nowMs = Date.now(), query = d1) {
  const rows = await query(env, `SELECT created_at, summary_json FROM adaptive_research_runs
    WHERE model_version = ? ORDER BY created_at DESC LIMIT 1`, [ADAPTIVE_VERSION]);
  if (!rows.length) return { status: 'awaiting-first-run', actionable: false };
  const summary = JSON.parse(rows[0].summary_json);
  const ageHours = (nowMs - Date.parse(rows[0].created_at)) / 3600000;
  return { ...summary, ageHours, status: !Number.isFinite(ageHours) || ageHours < 0 || ageHours > 36 ? 'stale' : 'shadow', actionable: false };
}

export function reportMarkdown(report) {
  const lines = [
    '# FCS adaptive model research', '',
    `As of ${report.summary.asOf}. Model: ${ADAPTIVE_VERSION}. Input hash: ${report.inputHash}.`, '',
    `Shadow study across ${report.summary.assets} assets; ${report.summary.freshForecasts}/${report.summary.assetHorizons} asset/horizon forecasts have fresh inputs. No trade promotion.`, '',
    `Cost assumption: ${report.summary.costs.roundTripBps} basis points per round trip. Borrow, funding and market impact remain unmodelled.`, '',
    '| Asset | Horizon | Observations | MAE % | Zero-forecast MAE % | Band coverage | Mean net % / period | Recent net % |',
    '|---|---|---:|---:|---:|---:|---:|---:|'
  ];
  const num = x => x == null ? '—' : x.toFixed(3);
  for (const a of report.assets) lines.push(`| ${a.symbol} (${a.archiveClass}) | ${a.horizon} ${a.assetClass === 'stock' ? 'sessions' : 'days'} | ${a.metrics.observations} | ${num(a.metrics.meanAbsoluteErrorPct)} | ${num(a.metrics.zeroForecastErrorPct)} | ${a.metrics.intervalCoverage == null ? '—' : num(a.metrics.intervalCoverage * 100) + '%'} | ${num(a.metrics.meanNetReturnPct)} | ${num(a.recentMetrics.meanNetReturnPct)} |`);
  lines.push('', ...report.summary.limitations.map(s => `- ${s}`), '');
  return lines.join('\n');
}

async function main() {
  const arg = name => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; };
  const asOf = arg('as-of') || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !Number.isFinite(Date.parse(asOf))) throw new Error('Invalid --as-of date');
  const input = arg('input'), useWrangler = process.argv.includes('--wrangler');
  const dryRun = process.argv.includes('--dry-run');
  if (useWrangler && !dryRun) throw new Error('--wrangler is read-only; add --dry-run');
  if (!input && !useWrangler && !['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'FCS_D1_DATABASE_ID'].every(k => process.env[k])) {
    throw new Error('D1 credentials, --wrangler --dry-run, or --input <panel.json> required');
  }
  const panel = input ? JSON.parse(await readFile(input, 'utf8'))
    : await loadAdaptivePanel(useWrangler ? wranglerQuery() : d1, process.env, asOf);
  if (arg('save-input')) await writeFile(resolve(arg('save-input')), JSON.stringify(panel));
  if (!panel.length) throw new Error('No archived assets; refusing an empty successful run');
  const output = resolve(arg('output') || 'reports/adaptive');
  const report = buildAdaptiveReport(panel, { asOf, costBps: Number(arg('cost-bps') ?? 20) });
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(output, 'report.md'), reportMarkdown(report));
  if (!dryRun) await persistAdaptiveReport(process.env, report);
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Report: ${resolve(output, 'report.md')}${dryRun ? ' (no D1 writes)' : ''}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
