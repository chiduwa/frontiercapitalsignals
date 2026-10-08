import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { checkAndNotifyReversals } from './scripts/notify.mjs';
import { OUTCOME_MODEL_VERSION, OUTCOME_LABEL_VERSION } from './scripts/reliability.mjs';

for (const [model, label, expected] of [
  ['confluence-v7', OUTCOME_LABEL_VERSION, 0],
  [OUTCOME_MODEL_VERSION, 'obsolete-label', 0],
  [OUTCOME_MODEL_VERSION, OUTCOME_LABEL_VERSION, 1]
]) {
  test(`reversal evidence ${model}/${label}: ${expected ? 'qualifies' : 'cannot authorize a push'}`, async t => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec(readFileSync(new URL('./scripts/schema.sql', import.meta.url), 'utf8'));
    for (const [hour, dir] of [[8, 0], [9, 1], [10, 1]]) {
      const at = `2026-10-08T${String(hour).padStart(2, '0')}:00:00.000Z`;
      db.prepare('INSERT INTO technique_votes(run_at,asset_class,symbol,technique_id,dir) VALUES (?, ?, ?, ?, ?)')
        .run(at, 'crypto', 'BTC', 'reversal', dir);
      db.prepare('INSERT INTO forecast_run_versions(run_at,model_version) VALUES (?, ?)').run(at, OUTCOME_MODEL_VERSION);
    }
    const insert = db.prepare(`INSERT INTO forecast_outcomes
      (run_at,asset_class,symbol,horizon_minutes,series_kind,series_key,dir,actual_dir,correct,
       model_version,label_version,evaluated_at,aggregated) VALUES (?,'crypto','BTC',1440,'technique','reversal',1,1,1,?,?,?,1)`);
    for (let i = 0; i < 100; i++) insert.run(new Date(Date.UTC(2026, 0, i + 1)).toISOString(), model, label, '2026-10-08');
    // Deliberately misleading legacy counters: the new loader derives its
    // null from the version-matched immutable ledger instead.
    db.prepare('INSERT INTO direction_baseline VALUES (?,?,?,?,?,?)').run('crypto', 24, 50, 0, 50, '2026-10-08');
    // The valid current baseline includes both directions on another asset.
    const baseline = db.prepare(`INSERT INTO forecast_outcomes
      (run_at,asset_class,symbol,horizon_minutes,series_kind,series_key,dir,actual_dir,correct,
       model_version,label_version,evaluated_at,aggregated) VALUES (?,'crypto','ETH',1440,'market','market',1,?,0,?,?,?,1)`);
    for (let i = 0; i < 400; i++) baseline.run(new Date(Date.UTC(2024, 0, i + 1)).toISOString(), i % 2 ? 1 : -1,
      OUTCOME_MODEL_VERSION, OUTCOME_LABEL_VERSION, '2026-10-08');
    let pushes = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      if (String(url).startsWith('https://ntfy.sh/')) { pushes++; return { ok: true }; }
      const { sql, params = [] } = JSON.parse(init.body);
      const stmt = db.prepare(sql);
      const rows = /^\s*(SELECT|WITH)/i.test(sql) ? stmt.all(...params) : (stmt.run(...params), []);
      return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: rows }] }) };
    });
    const sent = await checkAndNotifyReversals({ NTFY_TOPIC: 'test' }, '2026-10-08T10:15:00.000Z');
    assert.equal(sent, expected);
    assert.equal(pushes, expected);
  });
}
