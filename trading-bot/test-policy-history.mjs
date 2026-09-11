import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { referenceWindow, parseMarkBars, parseFunding, trailingRegime, publicHistoryClient,
  collectReferenceEvent, HISTORY_METHOD, INTERVAL_MS, REGISTERED_POLICIES } from './src/policy-history.mjs';
import { runHistoryJob, buildHistoryReport, compressEvent, expandEvent, CANDIDATE_SQL } from './policy-history-job.mjs';

const now = Date.parse('2026-09-11T06:30:00Z');
const intent = { client_order_id: 'test-intent', symbol: 'SOLUSDT', signal_symbol: 'SOL',
  asset_class: 'crypto', side: 'BUY', source: 'active-limit-v1', mode: 'shadow',
  created_at: '2026-09-10T21:15:00.717Z', signal_price_at: '2026-09-10T21:10:00Z',
  signal_price: 100, limit_price: 92 };
const w = referenceWindow(intent, 1, now);
assert.equal(w.entryAt, Date.parse('2026-09-10T21:20:00Z'));
assert.equal(w.mature, true);
assert.equal(referenceWindow(intent, 24, now).mature, false);
assert.equal(referenceWindow({ ...intent, signal_price_at: '2025-01-01' }, 1, now), null);
assert.equal(referenceWindow({ ...intent, symbol: 'SOLUSDT?evil=1' }, 1, now), null);
assert.equal(REGISTERED_POLICIES.length, 24);
const info = { symbols: [{ symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT', marginAsset: 'USDT',
  status: 'TRADING', underlyingType: 'COIN', contractType: 'PERPETUAL' }] };
const bars = (at, end, step = INTERVAL_MS) => Array.from({ length: (end - at) / step }, (_, i) =>
  [at + i * step, '100', '100.2', '99.8', '100', '0', at + (i + 1) * step - 1]);
assert.equal(parseMarkBars(bars(w.entryAt,w.endAt), w.entryAt,w.endAt).length, 12);
assert.throws(() => parseMarkBars(bars(w.entryAt,w.endAt).slice(1), w.entryAt,w.endAt), /incomplete/);
const duplicate = bars(w.entryAt,w.endAt); duplicate[1] = duplicate[0];
assert.throws(() => parseMarkBars(duplicate, w.entryAt,w.endAt), /malformed/);
const funding = [{ symbol: 'SOLUSDT', fundingTime: w.entryAt, fundingRate: '0.001', markPrice: '100' }];
assert.equal(parseFunding(funding,'SOLUSDT',w.entryAt,w.endAt)[0].rate,0.001);
assert.throws(() => parseFunding([...funding,...funding],'SOLUSDT',w.entryAt,w.endAt), /malformed/);
assert.throws(() => parseFunding([{ ...funding[0],markPrice: null }],'SOLUSDT',w.entryAt,w.endAt), /malformed/);
const dailyEnd = Math.floor(w.entryAt / 86_400_000) * 86_400_000;
const daily = bars(dailyEnd-50*86_400_000,dailyEnd,86_400_000);
assert.equal(trailingRegime(daily,w.entryAt).regime,'range');
assert.equal(trailingRegime(daily.slice(1),w.entryAt).regime,'unknown');
assert.equal(trailingRegime([...daily, [dailyEnd,100,10000,1,10000,0,dailyEnd+86_399_999]],w.entryAt).regime,'range');

let requests = [];
const client = () => publicHistoryClient({ fetchImpl: async (url, options) => {
  requests.push(url); assert.equal(options.method,'GET'); assert.equal(options.headers,undefined);
  const u = new URL(url); const p = u.searchParams;
  let value;
  if (u.pathname === '/fapi/v1/exchangeInfo') value = info;
  else if (u.pathname === '/fapi/v1/fundingRate') value = [];
  else if (p.get('interval') === '1d') value = daily;
  else value = bars(Number(p.get('startTime')),Number(p.get('endTime'))+1);
  return { ok:true,json: async()=>value };
} });
const event = await collectReferenceEvent(intent,1,now,client(),info);
assert.equal(event.entryPrice,100); assert.notEqual(event.entryPrice,intent.limit_price);
assert.equal(event.liveEligible,false);
assert.match(event.researchContext.entryScope,/NOT a limit fill/);
assert.deepEqual(expandEvent(compressEvent(event)),event);
const historical = buildHistoryReport([event],now);
assert.equal(historical.phase,'collecting-training');
assert.equal(historical.studies.length,4);
assert.ok(historical.studies.every(s=>s.liveEligible===false && s.cells.every(c=>c.status==='insufficient-data')));
const forbidden = client();
await assert.rejects(forbidden.get('/fapi/v1/order'),/not-allowed/);
assert.equal(forbidden.requests,0);
const bounded = publicHistoryClient({ maxRequests:0,fetchImpl:async()=>{throw new Error('must not call');} });
await assert.rejects(bounded.get('/fapi/v1/exchangeInfo'),/budget/);
assert.equal(bounded.requests,0);

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../signals-worker/migrations/0030_futures_limit_entry_intents.sql',import.meta.url),'utf8'));
db.exec(readFileSync(new URL('../signals-worker/migrations/0032_policy_history_research.sql',import.meta.url),'utf8'));
db.exec('CREATE TABLE research_registry(hypothesis TEXT,status TEXT); CREATE TABLE microstructure_findings(hypothesis TEXT,trade_decision TEXT,updated_at TEXT)');
const insert = db.prepare(`INSERT INTO trading_bot_entry_intents
  (client_order_id,mode,status,created_at,updated_at,expires_at,asset_class,symbol,signal_symbol,side,source,
   signal_price_at,signal_price,limit_price,offset_pct,offset_basis)
  VALUES(?,?,'proposed',?,?,?, ?,?,?,?,?, ?,?,?,8,'test')`);
insert.run(intent.client_order_id,intent.mode,intent.created_at,intent.created_at,'2026-09-11T21:10:00Z',
  intent.asset_class,intent.symbol,intent.signal_symbol,intent.side,intent.source,intent.signal_price_at,intent.signal_price,intent.limit_price);
const query = async (_env,sql,params=[])=>db.prepare(sql).all(...params);
const candidates = await query({},CANDIDATE_SQL,[HISTORY_METHOD,now,now]);
assert.deepEqual(candidates.map(c=>c.research_hours),[1,6]);
requests = [];
const first = await runHistoryJob({}, { query,client:client(),nowMs:now });
assert.equal(first.archived,2); assert.equal(first.attempted,2); assert.equal(first.apiRequests,7);
assert.ok(first.archiveBytes>0);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policy_history_events').get().n,2);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trading_bot_entry_intents').get().n,1);
assert.throws(()=>db.exec('UPDATE policy_history_events SET live_eligible=1'),/CHECK/);
assert.throws(()=>db.exec('UPDATE policy_history_reports SET live_eligible=1'),/CHECK/);
requests = [];
const second = await runHistoryJob({}, { query,client:client(),nowMs:now });
assert.equal(second.archived,0); assert.equal(second.apiRequests,0);
assert.equal(second.archiveBytes,first.archiveBytes);
assert.equal(requests.length,0);
const published = JSON.parse(db.prepare('SELECT report_json FROM policy_history_reports').get().report_json);
assert.equal(published.liveEligible,false); assert.equal(published.archivedPathsCompared,2);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policy_history_runs').get().n,2);
insert.run('bad-old-intent',intent.mode,'2026-09-10T20:15:00.717Z',intent.created_at,'2026-09-11T21:10:00Z',
  intent.asset_class,intent.symbol,intent.signal_symbol,intent.side,intent.source,'2026-09-10T19:00:00Z',100,92);
const quarantined = await runHistoryJob({}, { query,client:client(),nowMs:now });
assert.equal(quarantined.unavailable,2);
assert.ok(db.prepare("SELECT attempts,reason FROM policy_history_events WHERE intent_id='bad-old-intent'").all()
  .every(r=>r.attempts===3 && r.reason==='invalid-intent-reference'));
assert.equal((await runHistoryJob({}, { query,client:client(),nowMs:now })).attempted,0);
db.close();
console.log('POLICY HISTORY OK: real-SQL idempotency, reference provenance, GET allowlist, budgets, archives and non-promotion');
