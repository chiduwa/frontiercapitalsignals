// Offline lifecycle and storage checks. No sockets, credentials or account APIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { collectConnection, createRecorder, dayFile, healthFile, lastHealthCheckpoint,
  maintainArchive, recordFromMessage, runCollector, SOURCE, SAMPLING } from './scripts/liquidation-collector.mjs';

const AT = Date.parse('2026-10-13T12:00:00Z');
const payload = { e: 'forceOrder', E: AT - 5, futureEnvelope: { value: 'kept' }, o: {
  s: 'REDUSDT', S: 'BUY', o: 'LIMIT', f: 'IOC', q: '12.50', p: '0.17', ap: '0.169', X: 'FILLED',
  l: '5', z: '12.50', T: AT - 10, st: 'CONTRACT_PRICE', ps: 'SHORT', futureOrderField: ['keep', 7] } };
const message = JSON.stringify(payload);
const rows = (file) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fcs-liquidation-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fakeClock(start = AT) {
  let now = start, seq = 0;
  const jobs = new Map();
  const clock = {
    now: () => now,
    setTimeout(fn, ms) { const id = ++seq; jobs.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    setInterval(fn, ms) { const id = ++seq; jobs.set(id, { fn, at: now + ms, interval: ms }); return id; },
    clearInterval(id) { jobs.delete(id); },
    tick(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...jobs].filter(([, j]) => j.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [id, job] = due; now = job.at;
        if (job.interval) job.at += job.interval; else jobs.delete(id);
        job.fn();
      }
      now = until;
    },
    pending: () => jobs.size,
  };
  return clock;
}
class Socket {
  readyState = 0;
  closes = [];
  autoClose = true;
  open() { this.readyState = 1; this.onopen?.({}); }
  message(data) { this.onmessage?.({ data }); }
  close(code, reason) {
    this.closes.push({ code, reason }); this.readyState = 2;
    if (this.autoClose) this.end(code);
  }
  end(code = 1000) { this.readyState = 3; this.onclose?.({ code, wasClean: code === 1000 }); }
}
function session(t, overrides = {}) {
  const dir = temp(t), clock = fakeClock(), ws = new Socket();
  const recorder = createRecorder({ dir, now: clock.now, minFreeBytes: 1, probeFree: () => 10, log: () => {} });
  const promise = collectConnection({ recorder, clock, createWebSocket: () => ws, epochId: 'epoch-test',
    connectTimeoutMs: 20, silenceTimeoutMs: 40, closeTimeoutMs: 5, heartbeatMs: 10, ...overrides });
  return { dir, clock, ws, recorder, promise, health: () => rows(healthFile(dir, AT)) };
}

test('full raw payload and new order fields survive without numeric coercion', () => {
  const r = recordFromMessage(message, AT);
  assert.deepEqual(r.raw, payload);
  assert.equal(r.ps, 'SHORT'); assert.equal(r.st, 'CONTRACT_PRICE');
  assert.equal(r.q, '12.50'); assert.equal(r.z, '12.50'); assert.equal(r.r, AT);
  assert.equal(r.schemaVersion, 2); assert.equal(r.sourceVersion, 1);
  assert.equal(r.sampling, SAMPLING);
  for (const bad of ['[]', 'null', '{}', '{', JSON.stringify({ ...payload, E: null }), JSON.stringify({ ...payload, o: { s: 'REDUSDT' } })]) {
    assert.equal(recordFromMessage(bad, AT), null);
  }
});

test('low disk, probe failure and write failure become visible gaps, never successful writes', (t) => {
  const dir = temp(t); let now = AT, free = 0, failProbe = false, failWrite = false;
  const log = [];
  const recorder = createRecorder({ dir, now: () => now, minFreeBytes: 100,
    probeFree: () => { if (failProbe) throw new Error('statfs failed'); return free; },
    appendEvent: (path, line) => { if (failWrite) throw new Error('ENOSPC'); appendFileSync(path, line); },
    log: (line) => log.push(JSON.parse(line)) });
  recorder.record(message, now, 'a'); now++;
  recorder.record(message, now, 'a');
  recorder.record('bad json', now, 'a');
  assert.equal(existsSync(dayFile(dir, now)), false);
  recorder.health('heartbeat', { epochId: 'a' });
  failProbe = true; now++; recorder.record(message, now, 'a');
  failProbe = false; free = 1000; failWrite = true; now++; recorder.record(message, now, 'a');
  failWrite = false; now++; recorder.record(message, now, 'a');
  assert.deepEqual(recorder.counts, { messages: 6, valid: 5, invalid: 1, written: 1,
    droppedLowDisk: 2, droppedStorageProbe: 1, droppedWriteError: 1, healthWriteErrors: 0 });
  const health = rows(healthFile(dir, now));
  assert.equal(health.filter((r) => r.kind === 'storage_gap_start' && r.storageGap.reason === 'low_disk').length, 1);
  assert.equal(health.find((r) => r.kind === 'heartbeat').counts.droppedLowDisk, 2);
  const recovered = health.find((r) => r.kind === 'storage_gap_end');
  assert.equal(recovered.gap.startMs, AT); assert.equal(recovered.endMs, now);
  assert.equal(recorder.snapshot().storageGap, null);
  assert.equal(rows(dayFile(dir, now))[0].epochId, 'a');
  assert.equal(log.length, 3, 'storage transitions are logged, not every dropped message');
});

test('failed health persistence is counted and survives into a later checkpoint', (t) => {
  const dir = temp(t); let failed = true; const errors = [];
  const recorder = createRecorder({ dir, now: () => AT, minFreeBytes: 1,
    probeFree: () => Infinity, log: (x) => errors.push(JSON.parse(x)),
    appendHealth: (path, line) => { if (failed) throw new Error('disk full'); appendFileSync(path, line); } });
  recorder.record(message, AT, 'a');
  assert.equal(recorder.counts.written, 0, 'unknown capacity fails closed');
  assert.equal(recorder.counts.droppedStorageProbe, 1);
  assert.equal(recorder.counts.healthWriteErrors, 1);
  assert.equal(errors[0].kind, 'health_write_failed');
  failed = false; recorder.health('heartbeat');
  assert.equal(rows(healthFile(dir, AT))[0].counts.healthWriteErrors, 1);
});

test('archive rotation canonicalizes raw plus stale gzip and orphan temporary files, idempotently', async (t) => {
  const dir = temp(t), yesterday = AT - 86_400_000;
  const raw = dayFile(dir, yesterday), health = healthFile(dir, yesterday);
  const eventLine = JSON.stringify(recordFromMessage(message, yesterday)) + '\n';
  const healthLine = JSON.stringify({ r: yesterday, source: SOURCE, kind: 'heartbeat' }) + '\n';
  writeFileSync(raw, eventLine); writeFileSync(raw + '.gz', gzipSync('old\n')); // rename/unlink crash or stale archive
  writeFileSync(raw + '.gz.tmp', 'partial');
  writeFileSync(health, healthLine);
  writeFileSync(dayFile(dir, AT), 'current\n');
  writeFileSync(join(dir, 'fuel-shadow-2020-01.ndjson'), 'unrelated\n');
  writeFileSync(join(dir, 'forceorder-health-2020-01-01.ndjson.gz'), 'expired');
  const orphan = dayFile(dir, yesterday - 86_400_000);
  writeFileSync(orphan + '.gz', gzipSync('canonical\n')); writeFileSync(orphan + '.gz.tmp', 'partial');
  await maintainArchive({ dir, nowMs: AT, retentionDays: 400 });
  assert.equal(existsSync(raw), false); assert.equal(existsSync(raw + '.gz.tmp'), false);
  assert.equal(gunzipSync(readFileSync(raw + '.gz')).toString(), eventLine);
  assert.equal(gunzipSync(readFileSync(health + '.gz')).toString(), healthLine);
  assert.equal(existsSync(orphan + '.gz.tmp'), false);
  assert.equal(existsSync(dayFile(dir, AT)), true);
  assert.equal(existsSync(join(dir, 'forceorder-health-2020-01-01.ndjson.gz')), false);
  assert.equal(readFileSync(join(dir, 'fuel-shadow-2020-01.ndjson'), 'utf8'), 'unrelated\n');
  const canonical = readdirSync(dir).sort();
  await maintainArchive({ dir, nowMs: AT, retentionDays: 400 });
  assert.deepEqual(readdirSync(dir).sort(), canonical);
  assert.equal(lastHealthCheckpoint(dir).r, yesterday);
});

test('retention and compression leave unrelated names and symlink targets alone', async (t) => {
  const dir = temp(t), target = join(dir, 'outside-data');
  writeFileSync(target, 'keep');
  symlinkSync(target, dayFile(dir, AT - 86_400_000));
  symlinkSync(target, join(dir, 'forceorder-health-2020-01-01.ndjson'));
  writeFileSync(join(dir, 'forceorder-extra-2020-01-01.ndjson'), 'keep too');
  await maintainArchive({ dir, nowMs: AT, retentionDays: 400 });
  assert.equal(readFileSync(target, 'utf8'), 'keep');
  assert.equal(readFileSync(join(dir, 'forceorder-extra-2020-01-01.ndjson'), 'utf8'), 'keep too');
});

test('connect timeout and unacknowledged close are bounded, with a fatal restart result', async (t) => {
  const s = session(t, { gapStartMs: AT - 10_000 }); s.ws.autoClose = false;
  s.clock.tick(20);
  assert.equal(s.ws.closes[0].reason, 'connect_timeout');
  s.clock.tick(5);
  const result = await s.promise;
  assert.equal(result.reason, 'close_timeout'); assert.equal(result.fatal, true);
  assert.equal(result.gapStartMs, AT - 10_000, 'failed connection attempts preserve the full outage interval');
  assert.equal(s.clock.pending(), 0);
  assert.ok(s.health().some((r) => r.kind === 'connection_end' && r.trigger === 'connect_timeout'));
  assert.ok(s.health().some((r) => r.kind === 'coverage_gap_start'));
});

test('valid messages reset silence, malformed messages do not; heartbeats persist counters', async (t) => {
  const s = session(t); s.ws.open();
  s.clock.tick(30); s.ws.message(message);
  s.clock.tick(30); s.ws.message('bad json');
  const checkpoint = s.health().filter((r) => r.kind === 'heartbeat').at(-1);
  assert.equal(checkpoint.counts.valid, 1); assert.equal(checkpoint.counts.written, 1);
  s.clock.tick(10);
  const result = await s.promise;
  assert.equal(result.reason, 'valid_snapshot_silence'); assert.equal(result.fatal, false);
  const end = s.health().find((r) => r.kind === 'connection_end');
  assert.equal(end.counts.invalid, 1); assert.equal(end.validMessages, 1);
  assert.ok(s.health().some((r) => r.kind === 'coverage_uncertain' && r.sinceMs === AT + 30));
  assert.equal(s.clock.pending(), 0);
});

test('socket errors close promptly, while saved late callbacks cannot append after epoch end', async (t) => {
  const s = session(t); s.ws.open(); const late = s.ws.onmessage;
  s.ws.onerror({ type: 'error', message: 'transport failed' });
  assert.equal((await s.promise).reason, 'socket_error');
  late({ data: message }); s.ws.end(1006);
  assert.equal(s.recorder.counts.messages, 0);
  assert.equal(s.health().filter((r) => r.kind === 'connection_end').length, 1);
  assert.equal(s.clock.pending(), 0);
});

test('clean shutdown and constructor failures persist their connection end', async (t) => {
  const controller = new AbortController(), s = session(t, { signal: controller.signal });
  s.ws.open(); controller.abort();
  assert.equal((await s.promise).reason, 'shutdown');
  const dir = temp(t), clock = fakeClock();
  const recorder = createRecorder({ dir, now: clock.now, log: () => {} });
  const result = await collectConnection({ recorder, clock, createWebSocket: () => { throw new Error('no transport'); } });
  assert.equal(result.reason, 'constructor_error'); assert.equal(result.fatal, false);
  assert.equal(clock.pending(), 0);
});

test('collector startup records previous checkpoint and graceful shutdown without a network', async (t) => {
  const dir = temp(t), previousMs = Date.now() - 10_000;
  writeFileSync(healthFile(dir, previousMs), JSON.stringify({ r: previousMs, source: SOURCE, kind: 'heartbeat' }) + '\n');
  const controller = new AbortController();
  await runCollector({ dir, signal: controller.signal, minFreeBytes: 1, createWebSocket: () => {
    const ws = new Socket();
    queueMicrotask(() => { ws.open(); ws.message(message); controller.abort(); });
    return ws;
  } });
  const all = readdirSync(dir).filter((n) => /^forceorder-health-.*\.ndjson$/.test(n)).flatMap((n) => rows(join(dir, n)));
  assert.equal(all.find((r) => r.kind === 'collector_start').previousCheckpointMs, previousMs);
  assert.equal(all.filter((r) => r.kind === 'connection_end').length, 1);
  assert.equal(all.at(-1).kind, 'collector_stop');
  assert.equal(all.at(-1).counts.written, 1);
});
