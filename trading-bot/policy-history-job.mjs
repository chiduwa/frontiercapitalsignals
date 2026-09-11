import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { d1 } from '../signals-worker/scripts/d1-client.mjs';
import { acquireExecutionLease, releaseExecutionLease } from '../signals-worker/scripts/execution-lease.mjs';
import { comparePolicies } from './src/policy-replay.mjs';
import { HISTORY_METHOD, INTERVAL_MS, DISCOVERY_CUTOFF, COST_SCENARIOS,
  REGISTERED_POLICIES, referenceWindow, referenceEventId, publicHistoryClient, collectReferenceEvent } from './src/policy-history.mjs';

export const ARCHIVE_BUDGET_BYTES = 16 * 1024 * 1024;
const MAX_REPORT_EVENTS = 500;
export const CANDIDATE_SQL = `WITH horizons(hours) AS (VALUES(1),(6),(24))
  SELECT i.*, h.hours AS research_hours, e.attempts AS previous_attempts
  FROM trading_bot_entry_intents i CROSS JOIN horizons h
  LEFT JOIN policy_history_events e ON e.intent_id=i.client_order_id
    AND e.horizon_hours=h.hours AND e.method_version=?
  WHERE ((unixepoch(i.created_at)*1000 / 300000 + 1)*300000 + h.hours*3600000 + 60000) <= ?
    AND (e.event_id IS NULL OR (e.status='unavailable' AND e.attempts<3 AND e.retry_after<=?))
  ORDER BY i.created_at, i.client_order_id, h.hours LIMIT 2`;

export function compressEvent(event) {
  const raw = JSON.stringify(event);
  if (Buffer.byteLength(raw) > 262144) throw new Error('event-exceeds-capsule-budget');
  return gzipSync(raw).toString('base64');
}
export function expandEvent(encoded) {
  return JSON.parse(gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 262144 }).toString('utf8'));
}

export function buildHistoryReport(events, nowMs, health = {}) {
  const cohorts = new Map();
  for (const event of events) {
    const c = event.researchContext;
    const key = `${c.source}|${c.mode}|${c.horizonHours}h`;
    if (!cohorts.has(key)) cohorts.set(key, []);
    cohorts.get(key).push(event);
  }
  const studies = [];
  for (const [cohort, paths] of cohorts) {
    for (const scenario of COST_SCENARIOS) {
      const stressed = paths.map(p => ({ ...p, costs: { ...p.costs,
        feeRate: scenario.feeRate, slippagePct: scenario.slippagePct } }));
      for (const conditionOnMonth of [false, true]) {
        studies.push({ cohort, scenario: scenario.id, conditionOnMonth,
          ...comparePolicies(stressed, REGISTERED_POLICIES, {
            // Before the prespecified cutover, results are training-only.
            cutoffAt: Math.min(nowMs, DISCOVERY_CUTOFF), asOf: nowMs,
            baselineId: 'L5-S10-F75', conditionOnMonth
          }) });
      }
    }
  }
  return { method: HISTORY_METHOD, asOf: new Date(nowMs).toISOString(), liveEligible: false,
    phase: nowMs < DISCOVERY_CUTOFF ? 'collecting-training' : 'descriptive-holdout-only',
    fixedDiscoveryCutoff: new Date(DISCOVERY_CUTOFF).toISOString(),
    archivedPathsCompared: events.length, policiesPerCell: REGISTERED_POLICIES.length,
    costScenarios: COST_SCENARIOS, health, studies,
    limitations: ['Post-signal mark reference entries are NOT offset-limit fills or actual trading performance.',
      'Fees and slippage are explicit stress assumptions; funding uses observed settlements.',
      'No live parameter promotion; repeated testing, execution and liquidation still need independent validation.',
      'Current listed-contract verification can exclude delisted assets; archive starts at retained intent history.',
      'Month-specific evidence requires observations in matching months across years; unknown regime stays unknown.'] };
}

export async function runHistoryJob(env, { query = d1, client = publicHistoryClient(), nowMs = Date.now() } = {}) {
  const startedAt = new Date(nowMs).toISOString();
  const runId = randomUUID();
  const [usage] = await query(env, 'SELECT COALESCE(SUM(archive_bytes),0) AS bytes FROM policy_history_events');
  let archiveBytes = Number(usage?.bytes);
  if (!Number.isFinite(archiveBytes) || archiveBytes < 0) throw new Error('archive-size-unavailable');
  const candidates = archiveBytes < ARCHIVE_BUDGET_BYTES
    ? await query(env, CANDIDATE_SQL, [HISTORY_METHOD, nowMs, nowMs]) : [];
  let attempted = 0, archived = 0, unavailable = 0;
  const problems = [];
  const exchangeInfo = candidates.length ? await client.get('/fapi/v1/exchangeInfo') : null;
  for (const intent of candidates) {
    const validatedWindow = referenceWindow(intent, intent.research_hours, nowMs);
    // Quarantine malformed old intents once instead of letting two bad rows
    // monopolize the oldest-first queue forever. SQL already proves a mature
    // parseable created_at and one of the registered horizon values.
    const referenceAt = (Math.floor(Date.parse(intent.created_at) / INTERVAL_MS) + 1) * INTERVAL_MS;
    const w = validatedWindow || { id: referenceEventId(intent.client_order_id,intent.research_hours),
      entryAt: referenceAt, endAt: referenceAt+intent.research_hours*3_600_000, horizonHours:intent.research_hours };
    if (!Number.isFinite(w.entryAt) || w.endAt + 60_000 > nowMs) throw new Error('candidate-window-query-mismatch');
    attempted++;
    let capsule = null, reason = null;
    let attempts = Number(intent.previous_attempts || 0) + 1;
    try {
      if (!validatedWindow) { attempts=3; throw new Error('invalid-intent-reference'); }
      const overlaps = await query(env, `SELECT 1 AS present FROM policy_history_events
        WHERE method_version=? AND status='ready' AND symbol=? AND source=? AND horizon_hours=?
          AND reference_at < ? AND end_at > ? LIMIT 1`,
      [HISTORY_METHOD, intent.symbol, `${intent.source}|${intent.mode}`, w.horizonHours, w.endAt, w.entryAt]);
      if (overlaps.length) { attempts = 3; throw new Error('overlapping-cohort-window'); }
      capsule = compressEvent(await collectReferenceEvent(intent, w.horizonHours, nowMs, client, exchangeInfo));
      if (archiveBytes + Buffer.byteLength(capsule) > ARCHIVE_BUDGET_BYTES) {
        problems.push('archive-budget-reached-no-history-deleted'); break;
      }
    } catch (error) { reason = error.message; problems.push(reason); }
    const bytes = capsule ? Buffer.byteLength(capsule) : 0;
    await query(env, `INSERT INTO policy_history_events
      (event_id,method_version,intent_id,symbol,asset_class,source,side,horizon_hours,reference_at,end_at,
       status,reason,attempts,retry_after,updated_at,event_gzip_base64,archive_bytes,live_eligible)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
      ON CONFLICT(event_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,
        attempts=excluded.attempts,retry_after=excluded.retry_after,updated_at=excluded.updated_at,
        event_gzip_base64=excluded.event_gzip_base64,archive_bytes=excluded.archive_bytes
      WHERE policy_history_events.status!='ready'`,
    [w.id,HISTORY_METHOD,intent.client_order_id,intent.symbol,intent.asset_class,`${intent.source}|${intent.mode}`,
      intent.side,w.horizonHours,w.entryAt,w.endAt,capsule ? 'ready' : 'unavailable',reason,attempts,
      capsule ? null : nowMs + 6 * 3_600_000,startedAt,capsule,bytes]);
    archiveBytes += bytes;
    if (capsule) archived++; else unavailable++;
  }
  const [coverage] = await query(env, `SELECT COUNT(*) AS total,MIN(reference_at) AS firstAt,MAX(reference_at) AS lastAt
    FROM policy_history_events WHERE method_version=? AND status='ready'`, [HISTORY_METHOD]);
  const trainingLimit = nowMs < DISCOVERY_CUTOFF ? MAX_REPORT_EVENTS : MAX_REPORT_EVENTS / 2;
  const rows = await query(env, `SELECT event_gzip_base64 FROM policy_history_events
    WHERE method_version=? AND status='ready' AND end_at < ?
    ORDER BY reference_at DESC,event_id LIMIT ?`, [HISTORY_METHOD, DISCOVERY_CUTOFF, trainingLimit]);
  if (nowMs >= DISCOVERY_CUTOFF) rows.push(...await query(env, `SELECT event_gzip_base64 FROM policy_history_events
    WHERE method_version=? AND status='ready' AND reference_at >= ?
    ORDER BY reference_at DESC,event_id LIMIT ?`, [HISTORY_METHOD, DISCOVERY_CUTOFF, MAX_REPORT_EVENTS / 2]));
  const events = [];
  for (const row of rows) {
    try { events.push(expandEvent(row.event_gzip_base64)); }
    catch { problems.push('corrupt-archived-capsule'); }
  }
  let microstructure;
  try { microstructure = await query(env, `SELECT r.status, f.trade_decision, COUNT(*) AS n, MAX(f.updated_at) AS latest
    FROM microstructure_findings f JOIN research_registry r ON r.hypothesis=f.hypothesis
    GROUP BY r.status,f.trade_decision`); } catch { microstructure = { status: 'unavailable' }; }
  const health = { coverage, reportWindow: nowMs < DISCOVERY_CUTOFF
    ? `most recent ${MAX_REPORT_EVENTS} training capsules; older history retained`
    : 'most recent 250 training plus 250 validation capsules; older history retained',
    archiveBytes, archiveBudgetBytes: ARCHIVE_BUDGET_BYTES, microstructure,
    excludedOrUnavailable: problems, attempted, archived, unavailable, apiRequests: client.requests };
  let report = buildHistoryReport(events, nowMs, health);
  if (Buffer.byteLength(JSON.stringify(report)) > 512 * 1024) {
    report = { ...report, studies: [], reportStatus: 'comparison-output-budget-exceeded',
      omittedStudyCount: report.studies.length };
  }
  await query(env, `INSERT INTO policy_history_reports(method_version,updated_at,report_json,live_eligible)
    VALUES(?,?,?,0) ON CONFLICT(method_version) DO UPDATE SET updated_at=excluded.updated_at,report_json=excluded.report_json`,
  [HISTORY_METHOD,startedAt,JSON.stringify(report)]);
  const status = problems.length ? 'partial' : archiveBytes >= ARCHIVE_BUDGET_BYTES ? 'storage-budget' : archived ? 'ok' : 'awaiting-data';
  await query(env, `INSERT INTO policy_history_runs
    (run_id,started_at,completed_at,status,attempted,archived,unavailable,api_requests,archive_bytes,details_json)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, [runId,startedAt,new Date().toISOString(),status,attempted,archived,unavailable,
    client.requests,archiveBytes,JSON.stringify({ problems, compared: events.length, liveEligible: false })]);
  return { status, ...health, phase: report.phase, liveEligible: false };
}

async function main() {
  const env = Object.fromEntries(['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','FCS_D1_DATABASE_ID'].map(k => [k,process.env[k]]));
  if (Object.values(env).some(v => !v)) throw new Error('policy research requires existing D1 credentials');
  if (process.argv[2] === '--report') {
    const [row] = await d1(env, 'SELECT report_json FROM policy_history_reports WHERE method_version=?', [HISTORY_METHOD]);
    console.log(row?.report_json || JSON.stringify({ status: 'no-report', liveEligible: false }));
    return;
  }
  if (process.argv.length > 2) throw new Error('Usage: node trading-bot/policy-history-job.mjs [--report]');
  const lease = await acquireExecutionLease(env, 'policy-history-research', 300);
  if (!lease) { console.log('policy history: overlapping research run skipped'); return; }
  try { console.log(JSON.stringify(await runHistoryJob(env))); }
  finally { await releaseExecutionLease(env, lease); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('policy-history-failed:', error.message); process.exitCode = 1; });
}
