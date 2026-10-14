// Binance USDT-M forceOrder SNAPSHOTS, not a complete liquidation tape.
// At most the latest order per symbol per 1,000ms is published. Missing messages
// cannot be inferred to mean zero liquidations, even during a healthy connection.
// Local data/coverage files only: no orders, account access, pushes or D1 writes.
import { appendFileSync, closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createGzip, gunzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

export const WS_URL = process.env.LIQ_WS_URL || 'wss://fstream.binance.com/market/ws/!forceOrder@arr';
export const SOURCE = 'binance_usdm_forceOrder_snapshot';
export const SOURCE_VERSION = 1;
export const RECORD_SCHEMA_VERSION = 2;
export const HEALTH_SCHEMA_VERSION = 1;
export const SAMPLING = 'latest_order_per_symbol_per_1000ms_not_full_tape';
const DAY = 86_400_000;
const OWN_FILE = /^(forceorder|forceorder-health)-(\d{4}-\d{2}-\d{2})\.ndjson(\.gz(?:\.tmp)?)?$/;
const realClock = { now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval };
const errorText = (e) => String(e?.message || e).slice(0, 500);
const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

export function dayFile(dir, ms) {
  return join(dir, `forceorder-${new Date(ms).toISOString().slice(0, 10)}.ndjson`);
}
export function healthFile(dir, ms) {
  return join(dir, `forceorder-health-${new Date(ms).toISOString().slice(0, 10)}.ndjson`);
}

// Preserve the whole parsed exchange payload, including st/ps and future fields.
// Existing flattened fields retain their names/types for old readers.
export function recordFromMessage(text, receivedMs) {
  let m;
  try { m = JSON.parse(text); } catch { return null; }
  if (!m || m.e !== 'forceOrder' || !m.o || Array.isArray(m.o)
      || typeof m.o !== 'object' || typeof m.o.s !== 'string' || !m.o.s
      || !Number.isFinite(m.E) || !Number.isFinite(m.o.T)) return null;
  const o = m.o;
  return { schemaVersion: RECORD_SCHEMA_VERSION, source: SOURCE, sourceVersion: SOURCE_VERSION,
    sampling: SAMPLING, r: receivedMs, E: m.E, s: o.s, S: o.S, o: o.o, f: o.f,
    q: o.q, p: o.p, ap: o.ap, X: o.X, l: o.l, z: o.z, T: o.T, st: o.st, ps: o.ps, raw: m };
}

export function expiredFiles(names, nowMs, retentionDays) {
  const cutoff = new Date(nowMs - retentionDays * DAY).toISOString().slice(0, 10);
  return names.filter((n) => { const m = OWN_FILE.exec(n); return m && m[2] < cutoff; });
}

// Raw is authoritative if both raw and .gz exist (crash after rename, before
// unlink). Rebuild the gzip atomically, then remove raw. Repeating is safe even
// if an earlier gzip is stale/corrupt. Never touch another recorder's files.
export async function maintainArchive({ dir, nowMs = Date.now(), retentionDays = 400 }) {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  // Free expired data before compression needs temporary disk space.
  for (const n of expiredFiles(readdirSync(dir), nowMs, retentionDays)) {
    const path = join(dir, n);
    if (lstatSync(path).isFile()) unlinkSync(path);
  }
  for (const n of readdirSync(dir)) {
    const m = OWN_FILE.exec(n);
    if (!m || m[3] || m[2] >= today) continue;
    const src = join(dir, n), tmp = `${src}.gz.tmp`, gz = `${src}.gz`;
    if (!lstatSync(src).isFile()) continue;
    if (existsSync(gz) && !lstatSync(gz).isFile()) throw new Error(`Refusing non-file archive: ${n}.gz`);
    if (existsSync(tmp)) {
      if (!lstatSync(tmp).isFile()) throw new Error(`Refusing non-file temporary archive: ${n}.gz.tmp`);
      unlinkSync(tmp);
    }
    await pipeline(createReadStream(src), createGzip(), createWriteStream(tmp, { flags: 'wx' }));
    const fd = openSync(tmp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, gz);
    unlinkSync(src);
  }
  // A crash can also leave an unused temporary file alongside the canonical gzip.
  for (const n of readdirSync(dir)) {
    const m = OWN_FILE.exec(n);
    if (!m || m[3] !== '.gz.tmp' || m[2] >= today) continue;
    const tmp = join(dir, n), raw = tmp.slice(0, -7), gz = tmp.slice(0, -4);
    if (!existsSync(raw) && existsSync(gz) && lstatSync(tmp).isFile() && lstatSync(gz).isFile()) unlinkSync(tmp);
  }
}

function durableAppend(path, line) {
  const fd = openSync(path, 'a');
  try { writeFileSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
}
function freeBytes(dir) {
  const s = statfsSync(dir);
  const bytes = Number(s.bavail) * Number(s.bsize);
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error('invalid free-space result');
  return bytes;
}

// A bounded last-checkpoint read makes crash/restart uncertainty explicit. It
// cannot establish coverage before the latest persisted checkpoint.
export function lastHealthCheckpoint(dir) {
  const names = readdirSync(dir).filter((n) => /^forceorder-health-\d{4}-\d{2}-\d{2}\.ndjson(?:\.gz)?$/.test(n)).sort().reverse();
  for (const n of names.slice(0, 4)) {
    const path = join(dir, n), st = lstatSync(path);
    if (!st.isFile() || st.size > 8 * 1024 * 1024) continue;
    try {
      const raw = readFileSync(path);
      const text = n.endsWith('.gz') ? gunzipSync(raw, { maxOutputLength: 16 * 1024 * 1024 }).toString() : raw.toString();
      for (const line of text.trimEnd().split('\n').reverse()) {
        try { const r = JSON.parse(line); if (Number.isFinite(r.r) && r.source === SOURCE) return r; } catch {}
      }
    } catch {}
  }
  return null;
}

export function createRecorder({ dir, minFreeBytes = 2e9, now = Date.now,
  appendEvent = appendFileSync, appendHealth = durableAppend, probeFree = () => freeBytes(dir), log = console.error } = {}) {
  mkdirSync(dir, { recursive: true });
  const counts = { messages: 0, valid: 0, invalid: 0, written: 0, droppedLowDisk: 0,
    droppedStorageProbe: 0, droppedWriteError: 0, healthWriteErrors: 0 };
  let lastMessageMs = null, lastValidMs = null, lastWrittenMs = null, storageGap = null;
  const snapshot = () => ({ counts: { ...counts }, lastMessageMs, lastValidMs, lastWrittenMs,
    storageGap: storageGap ? { ...storageGap } : null });
  function health(kind, detail = {}) {
    const r = now();
    const row = { schemaVersion: HEALTH_SCHEMA_VERSION, source: SOURCE, sourceVersion: SOURCE_VERSION,
      sampling: SAMPLING, kind, r, ...snapshot(), ...detail };
    try { appendHealth(healthFile(dir, r), JSON.stringify(row) + '\n'); return true; }
    catch (e) {
      counts.healthWriteErrors++;
      log(JSON.stringify({ collector: SOURCE, kind: 'health_write_failed', r, error: errorText(e), ...snapshot() }));
      return false;
    }
  }
  function drop(reason, counter, at, epochId, detail = {}) {
    counts[counter]++;
    if (!storageGap || storageGap.reason !== reason) {
      if (storageGap) health('storage_gap_transition', { epochId, previousGap: { ...storageGap }, nextReason: reason });
      storageGap = { reason, startMs: storageGap?.startMs ?? at };
      health('storage_gap_start', { epochId, ...detail });
      log(JSON.stringify({ collector: SOURCE, kind: 'recording_paused', epochId, ...storageGap, ...detail }));
    }
  }
  function record(text, receivedMs = now(), epochId = null) {
    counts.messages++; lastMessageMs = receivedMs;
    const rec = recordFromMessage(text, receivedMs);
    if (!rec) { counts.invalid++; return { valid: false, written: false }; }
    counts.valid++; lastValidMs = receivedMs;
    let free;
    try {
      free = probeFree();
      if (!Number.isFinite(free) || free < 0) throw new Error('invalid free-space result');
    } catch (e) {
      drop('storage_probe_failed', 'droppedStorageProbe', receivedMs, epochId, { error: errorText(e) });
      return { valid: true, written: false };
    }
    if (free < minFreeBytes) {
      drop('low_disk', 'droppedLowDisk', receivedMs, epochId, { freeBytes: free, minFreeBytes });
      return { valid: true, written: false };
    }
    try { appendEvent(dayFile(dir, receivedMs), JSON.stringify({ ...rec, epochId }) + '\n'); }
    catch (e) {
      drop('event_write_failed', 'droppedWriteError', receivedMs, epochId, { error: errorText(e) });
      return { valid: true, written: false };
    }
    counts.written++; lastWrittenMs = receivedMs;
    if (storageGap) {
      const gap = storageGap; storageGap = null;
      health('storage_gap_end', { epochId, gap, endMs: receivedMs, durationMs: receivedMs - gap.startMs });
    }
    return { valid: true, written: true };
  }
  return { counts, snapshot, health, record };
}

// An unacknowledged close is fatal: the main process exits for systemd to restart,
// releasing the socket. Never retry indefinitely while orphaning live sockets.
export function collectConnection({ recorder, url = WS_URL, createWebSocket = (u) => new WebSocket(u),
  clock = realClock, epochId = randomUUID(), gapStartMs = clock.now(), signal,
  connectTimeoutMs = 30_000, silenceTimeoutMs = 600_000, closeTimeoutMs = 5_000, heartbeatMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    let ws, state = 'connecting', settled = false, opened = false, validMessages = 0;
    let connectTimer, silenceTimer, closeTimer, heartbeatTimer, closingReason, closingAt;
    let lastValidMs = null;
    const startedMs = clock.now();
    const health = (kind, detail = {}) => recorder.health(kind, { epochId, state, startedMs, lastEpochValidMs: lastValidMs, ...detail });
    function finish(reason, fatal = false, detail = {}) {
      if (settled) return;
      settled = true;
      for (const timer of [connectTimer, silenceTimer, closeTimer]) clock.clearTimeout(timer);
      clock.clearInterval(heartbeatTimer);
      signal?.removeEventListener('abort', abort);
      if (ws) { ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null; }
      const endedMs = clock.now(), nextGap = opened ? (closingAt ?? endedMs) : gapStartMs;
      state = 'closed';
      health('connection_end', { reason, fatal, endedMs, validMessages, ...detail });
      health('coverage_gap_start', { reason, gapStartMs: nextGap, certainty: 'transport_unavailable_or_unconfirmed' });
      resolve({ reason, fatal, opened, validMessages, endedMs, gapStartMs: nextGap });
    }
    function close(reason) {
      if (settled || state === 'closing') return;
      state = 'closing'; closingReason = reason; closingAt = clock.now();
      clock.clearTimeout(connectTimer); clock.clearTimeout(silenceTimer);
      health('connection_closing', { reason });
      closeTimer = clock.setTimeout(() => finish('close_timeout', true, { trigger: reason }), closeTimeoutMs);
      try {
        if (ws?.readyState === 3) finish(reason);
        else ws?.close(1000, reason);
      } catch (e) { health('close_error', { error: errorText(e) }); }
    }
    function abort() { close('shutdown'); }
    function resetSilence() {
      clock.clearTimeout(silenceTimer);
      silenceTimer = clock.setTimeout(() => {
        health('coverage_uncertain', { reason: 'no_valid_snapshots', sinceMs: lastValidMs ?? startedMs,
          silenceTimeoutMs, note: 'quiet market and broken feed cannot be distinguished from this stream alone' });
        close('valid_snapshot_silence');
      }, silenceTimeoutMs);
    }
    health('connection_attempt', { url, gapStartMs, connectTimeoutMs, silenceTimeoutMs, closeTimeoutMs });
    try { ws = createWebSocket(url); }
    catch (e) { finish('constructor_error', false, { error: errorText(e) }); return; }
    connectTimer = clock.setTimeout(() => close('connect_timeout'), connectTimeoutMs);
    heartbeatTimer = clock.setInterval(() => health('heartbeat'), heartbeatMs);
    ws.onopen = () => {
      if (settled || state !== 'connecting') return;
      state = 'open'; opened = true; clock.clearTimeout(connectTimer); resetSilence();
      health('connection_open');
      health('coverage_gap_end', { gapStartMs, endMs: clock.now(), durationMs: clock.now() - gapStartMs,
        note: 'transport connected; exchange feed remains sampled' });
    };
    ws.onmessage = (ev) => {
      if (settled || state !== 'open') return;
      const result = recorder.record(String(ev.data), clock.now(), epochId);
      if (result.valid) { validMessages++; lastValidMs = clock.now(); resetSilence(); }
    };
    ws.onerror = (e) => { if (!settled) { health('socket_error', { error: errorText(e?.message || e?.type || e) }); close('socket_error'); } };
    ws.onclose = (e) => finish(closingReason || 'remote_close', false, { code: e?.code ?? null, clean: e?.wasClean ?? null });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function pause(ms, signal) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}

export async function runCollector({ dir = process.env.LIQ_DATA_DIR || '/var/lib/fcs-liquidations', signal,
  url = WS_URL, createWebSocket, retentionDays = positive(process.env.LIQ_RETENTION_DAYS, 400),
  minFreeBytes = positive(process.env.LIQ_MIN_FREE_BYTES, 2e9),
  connectTimeoutMs = positive(process.env.LIQ_CONNECT_TIMEOUT_MS, 30_000),
  silenceTimeoutMs = positive(process.env.LIQ_SILENCE_TIMEOUT_MS, 600_000),
  closeTimeoutMs = positive(process.env.LIQ_CLOSE_TIMEOUT_MS, 5_000),
  heartbeatMs = positive(process.env.LIQ_HEARTBEAT_MS, 60_000) } = {}) {
  mkdirSync(dir, { recursive: true });
  const previous = lastHealthCheckpoint(dir), processId = randomUUID();
  const recorder = createRecorder({ dir, minFreeBytes });
  let gapStartMs = previous?.r ?? Date.now(), backoff = 1_000, maintenance;
  recorder.health('collector_start', { processId, previousCheckpointMs: previous?.r ?? null,
    previousCheckpointKind: previous?.kind ?? null, gapStartMs,
    note: 'coverage since previous checkpoint is uncertain, including process downtime' });
  const housekeeping = () => {
    if (maintenance) return maintenance;
    maintenance = maintainArchive({ dir, retentionDays }).catch((e) => recorder.health('housekeeping_error', { error: errorText(e) }))
      .finally(() => { maintenance = null; });
    return maintenance;
  };
  await housekeeping();
  const timer = setInterval(housekeeping, 3_600_000);
  try {
    while (!signal?.aborted) {
      const result = await collectConnection({ recorder, url, createWebSocket, signal, gapStartMs,
        connectTimeoutMs, silenceTimeoutMs, closeTimeoutMs, heartbeatMs });
      gapStartMs = result.gapStartMs;
      if (result.fatal) throw new Error(`WebSocket ${result.reason}; restart required to release transport`);
      if (signal?.aborted) break;
      if (result.opened && result.validMessages > 0) backoff = 1_000;
      recorder.health('reconnect_wait', { backoffMs: backoff, gapStartMs });
      await pause(backoff, signal);
      backoff = Math.min(60_000, backoff * 2);
    }
  } finally {
    clearInterval(timer);
    await maintenance;
    recorder.health('collector_stop', { processId, gapStartMs });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  runCollector({ signal: controller.signal }).catch((e) => { console.error('liquidation-collector failed:', e); process.exit(1); });
}
