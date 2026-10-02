// One push per run (scripts/push-batch.mjs), and the post-move notifier that
// uses it (scripts/notify.mjs checkAndNotifySuddenMoves), run for real against
// SQLite built from the schema: D1's REST calls are served locally and ntfy is
// intercepted. A single alert must go out exactly as before; several must go
// out as one push; every coin must still get its own dedup state and log row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { combinePushes, NTFY_BODY_LIMIT } from './scripts/push-batch.mjs';

const push = (title, priority = 'high', tags = ['rocket']) => ({ title, message: `${title} full detail`, priority, tags, click: 'https://x/' });

test('one alert goes out exactly as it was written', () => {
  const p = push('AI: post-move spike detected');
  assert.equal(combinePushes([{ symbol: 'AI', line: 'AI +19%', push: p }], { noun: 'Post-move' }), p);
  assert.equal(combinePushes([], { noun: 'x' }), null);
});

test('several alerts become one push: every coin named, the highest priority kept, the footer once', () => {
  const items = ['AI', 'DEXE', 'SAND', 'MANA', 'GALA', 'ZK'].map((s, i) => ({ symbol: s, line: `${s} +1${i}% over 6h`, push: push(`${s} spike`, i === 3 ? 'urgent' : 'high', i === 3 ? ['warning'] : ['rocket']) }));
  const out = combinePushes(items, { noun: 'Post-move', footer: 'Observed after the moves.' });
  assert.equal(out.title, 'Post-move: AI, DEXE, SAND, MANA +2');
  assert.equal(out.priority, 'urgent');
  assert.deepEqual(out.tags, ['rocket', 'warning']);
  for (const it of items) assert.ok(out.message.includes(it.line), it.symbol);
  assert.equal(out.message.split('Observed after the moves.').length, 2);
});

test('a burst too long for one ntfy message keeps every line it can and says how many more', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ symbol: `C${i}`, line: `C${i} ${'x'.repeat(120)}`, push: push(`C${i}`) }));
  const out = combinePushes(items, { noun: 'Post-move', footer: 'f' });
  assert.ok(new TextEncoder().encode(out.message).length < NTFY_BODY_LIMIT);
  assert.match(out.message, /\+\d+ more on the signals page\./);
});

// ---- the notifier itself, end to end ----
function harness() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./scripts/schema.sql', import.meta.url), 'utf8'));
  const pushes = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://ntfy.sh/')) { pushes.push({ title: init.headers.Title, priority: init.headers.Priority, body: init.body }); return { ok: true, status: 200 }; }
    const { sql, params } = JSON.parse(init.body);
    const st = db.prepare(sql);
    const rows = /^\s*(SELECT|WITH)/i.test(sql) ? st.all(...(params || [])) : (st.run(...(params || [])), []);
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: rows }] }) };
  };
  return { db, pushes };
}
const env = { NTFY_TOPIC: 't', CLOUDFLARE_API_TOKEN: 'x', CLOUDFLARE_ACCOUNT_ID: 'a', FCS_D1_DATABASE_ID: 'd' };
function prices(db, nowIso, moves) {
  const ins = db.prepare('INSERT INTO asset_price_log (run_at, asset_class, symbol, price) VALUES (?, ?, ?, ?)');
  const now = Date.parse(nowIso);
  for (const [symbol, pct] of Object.entries(moves)) {
    for (let h = 7; h >= 0; h--) ins.run(new Date(now - h * 3600e3).toISOString(), 'crypto', symbol, 100 * (1 + (pct / 100) * (7 - h) / 7));
  }
}

test('a build with several movers sends one push and records each coin as before; a rerun sends nothing', async () => {
  const { db, pushes } = harness();
  const { checkAndNotifySuddenMoves } = await import('./scripts/notify.mjs');
  const nowIso = '2026-10-02T08:15:00.000Z';
  prices(db, nowIso, { AI: 19, DEXE: 11, SAND: -12, QUIET: 1 });
  const sent = await checkAndNotifySuddenMoves(env, nowIso);
  assert.equal(sent, 3);
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /^Post-move: /);
  for (const s of ['AI', 'DEXE', 'SAND']) assert.match(pushes[0].body, new RegExp(`^${s} [+-]\\d`, 'm'));
  assert.equal(pushes[0].priority, 'urgent', 'a drop among them keeps its urgent priority');
  const log = db.prepare("SELECT symbol, title, message FROM notification_log WHERE kind = 'suddenmove' ORDER BY symbol").all();
  assert.deepEqual(log.map(r => r.symbol), ['AI', 'DEXE', 'SAND']);
  assert.ok(log.every(r => /Observed after the move: /.test(r.message)), 'each coin keeps its own full message in the log');
  assert.equal(await checkAndNotifySuddenMoves(env, nowIso), 0);
  assert.equal(pushes.length, 1, 'dedup per coin is unchanged');
});

test('a build with one mover sends the same push it always did', async () => {
  const { db, pushes } = harness();
  const { checkAndNotifySuddenMoves } = await import('./scripts/notify.mjs');
  const nowIso = '2026-10-02T09:15:00.000Z';
  prices(db, nowIso, { ULTIMA: 11, QUIET: 1 });
  assert.equal(await checkAndNotifySuddenMoves(env, nowIso), 1);
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /^ULTIMA: /);
  assert.match(pushes[0].body, /^Observed after the move: ULTIMA \(crypto\) changed \+11\.0%/);
});
