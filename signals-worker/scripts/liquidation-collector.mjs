// Records Binance USDT-M liquidation snapshots to local files, for research.
//
// Asked 2026-10-12 after the NEAR/RED liquidations: were liquidations clustered
// around resistance before those spikes? Binance publishes no liquidation
// history, so the only way to answer it is to start recording now.
//
// What the stream is (and is not): `!forceOrder@arr` sends at most ONE latest
// liquidation order per symbol per 1,000 ms. It is a sample of forced orders,
// not the complete liquidation tape; sums are "observed snapshots". It only works
// on the /market/ws route: the old /ws route accepts the connection and delivers
// nothing (that is why a 2026-09-12 test concluded the feed was empty).
//
// Writes one JSON line per message to <dir>/forceorder-YYYY-MM-DD.ndjson (UTC day
// of receipt) and gzips each finished day. No D1 writes, no pushes, no orders.
// Long-running: systemd restarts it daily (RuntimeMaxSec) so code updates apply.
//
// Env: LIQ_DATA_DIR (default /var/lib/fcs-liquidations), LIQ_WS_URL,
//      LIQ_RETENTION_DAYS (default 400), LIQ_MIN_FREE_BYTES (default 2 GB)
import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statfsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

export const WS_URL = process.env.LIQ_WS_URL || 'wss://fstream.binance.com/market/ws/!forceOrder@arr';
const DIR = process.env.LIQ_DATA_DIR || '/var/lib/fcs-liquidations';
const RETENTION_DAYS = Number(process.env.LIQ_RETENTION_DAYS || 400);
const MIN_FREE = Number(process.env.LIQ_MIN_FREE_BYTES || 2e9);

export function dayFile(dir, ms) {
  return join(dir, `forceorder-${new Date(ms).toISOString().slice(0, 10)}.ndjson`);
}

// Keep Binance's own fields verbatim (renaming invites mistakes) plus our
// receipt time. Returns null for anything that is not a forceOrder event.
export function recordFromMessage(text, receivedMs) {
  let m;
  try { m = JSON.parse(text); } catch { return null; }
  if (!m || m.e !== 'forceOrder' || !m.o || typeof m.o.s !== 'string') return null;
  const o = m.o;
  return { r: receivedMs, E: m.E, s: o.s, S: o.S, o: o.o, f: o.f, q: o.q, p: o.p, ap: o.ap, X: o.X, l: o.l, z: o.z, T: o.T };
}

export function expiredFiles(names, nowMs, retentionDays) {
  const cutoff = new Date(nowMs - retentionDays * 86_400_000).toISOString().slice(0, 10);
  return names.filter((n) => {
    const d = /^forceorder-(\d{4}-\d{2}-\d{2})\.ndjson(\.gz)?$/.exec(n);
    return d && d[1] < cutoff;
  });
}

async function gzipFinishedDays(today) {
  for (const n of readdirSync(DIR)) {
    const d = /^forceorder-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(n);
    if (!d || d[1] >= today) continue;
    const src = join(DIR, n);
    if (existsSync(src + '.gz')) continue;
    await pipeline(createReadStream(src), createGzip(), createWriteStream(src + '.gz.tmp'));
    // rename is atomic on one filesystem: a crash never leaves a half .gz behind
    renameSync(src + '.gz.tmp', src + '.gz');
    unlinkSync(src);
  }
  for (const n of expiredFiles(readdirSync(DIR), Date.now(), RETENTION_DAYS)) unlinkSync(join(DIR, n));
}

function freeBytes() {
  try { const s = statfsSync(DIR); return s.bavail * s.bsize; } catch { return Infinity; }
}

async function run() {
  mkdirSync(DIR, { recursive: true });
  let day = new Date().toISOString().slice(0, 10);
  await gzipFinishedDays(day).catch((e) => console.error('housekeeping failed (continuing):', e.message));
  let count = 0, dropped = 0, backoff = 1000;
  setInterval(() => {
    console.log(`liquidation-collector: ${count} events in the last 10 min${dropped ? `, ${dropped} not written (low disk)` : ''}`);
    count = 0; dropped = 0;
  }, 600_000).unref();

  for (;;) {
    await new Promise((resolve) => {
      const ws = new WebSocket(WS_URL);
      let silent;
      const resetSilence = () => {
        clearTimeout(silent);
        // A connection that stays silent for 2h is treated as dead: quiet hours
        // exist, but never that quiet across every USDT-M symbol.
        silent = setTimeout(() => { console.log('no messages for 2h, reconnecting'); try { ws.close(); } catch {} }, 7_200_000);
      };
      ws.onopen = () => { console.log(`connected ${WS_URL}`); backoff = 1000; resetSilence(); };
      ws.onmessage = (ev) => {
        const now = Date.now();
        resetSilence();
        const rec = recordFromMessage(String(ev.data), now);
        if (!rec) return;
        const d = new Date(now).toISOString().slice(0, 10);
        if (d !== day) {
          day = d;
          gzipFinishedDays(day).catch((e) => console.error('housekeeping failed (continuing):', e.message));
        }
        if (freeBytes() < MIN_FREE) { dropped++; return; }
        appendFileSync(dayFile(DIR, now), JSON.stringify(rec) + '\n');
        count++;
      };
      ws.onerror = (e) => console.error('websocket error:', e?.message || e?.type || e);
      ws.onclose = (e) => { clearTimeout(silent); console.log(`closed (code ${e?.code}); reconnecting in ${backoff / 1000}s`); resolve(); };
    });
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(60_000, backoff * 2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run().catch((e) => { console.error('liquidation-collector failed:', e); process.exit(1); });
}
