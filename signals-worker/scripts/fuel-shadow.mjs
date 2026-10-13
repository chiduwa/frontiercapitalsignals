// Shadow log of squeeze-warning states after exhaustion alerts. Research data only.
//
// From the NEAR/RED liquidation review (reports/scenarios/2026-10-12-near-red,
// CLAUDE-RESPONSE*.md and Codex's COMBINED-FINDINGS.md): while the price holds
// near its post-alert high, a new +5% leg within two hours became more likely
// when, relative to the alert,
//   build   contracts open interest rose 5% or more          (replicated 2023-24)
//   disc    Binance's premium index averaged <= -0.3% over the last 30 min (replicated)
//   crowd   the all-account long/short ratio fell 10% or more (did NOT replicate alone)
//   accel   15-minute volume still rising with the close in the top quarter (Copilot idea; replicated)
// These are candidates, not validated triggers. This job only RECORDS them, every
// 15 minutes for 12 hours after each pushed exhaustion alert, with receipt times,
// so a later study can judge them on data collected before the outcomes.
// No pushes, no orders, no D1 writes (one small D1 read per run).
//
// Writes <dir>/fuel-shadow-YYYY-MM.ndjson. Missing or stale inputs are recorded as
// null and the sign count as null: unavailable is never "no sign".
// Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID (read),
//      FUEL_DATA_DIR (default /var/lib/fcs-fuel-shadow), BINANCE_FAPI_BASE
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { d1 } from './d1-client.mjs';

const FAPI = (process.env.BINANCE_FAPI_BASE || 'https://fapi.binance.com').replace(/\/$/, '');
const DIR = process.env.FUEL_DATA_DIR || '/var/lib/fcs-fuel-shadow';
const FIVE = 300_000, HOUR = 3_600_000;
export const WINDOW_HOURS = 12;
export const THRESHOLDS = Object.freeze({ crowd: -0.10, build: 0.05, disc: -0.003, nearHigh: -0.03 });

// Pure: the state at decision time `now` from data that existed then.
//   k5:  5m klines [{t, o, h, l, c, qv}] from the alert close (T0) to now, closed bars only
//   prem: last six CLOSED 5m premium-index closes
//   oi0/oi1, gls0/gls1: contracts OI and account ratio at T0 and now (null if unavailable)
export function fuelState({ k5, prem, oi0, oi1, gls0, gls1 }) {
  const ok = (v) => Number.isFinite(v) && v > 0;
  const out = { d_oi: null, d_gls: null, prem30: null, below_high: null, accel: null, decaying: null,
    crowd: null, build: null, disc: null, signs3: null, signs4: null, near_high: null };
  if (ok(oi0) && ok(oi1)) { out.d_oi = oi1 / oi0 - 1; out.build = out.d_oi >= THRESHOLDS.build; }
  if (ok(gls0) && ok(gls1)) { out.d_gls = gls1 / gls0 - 1; out.crowd = out.d_gls <= THRESHOLDS.crowd; }
  if (Array.isArray(prem) && prem.length === 6 && prem.every(Number.isFinite)) {
    out.prem30 = prem.reduce((a, b) => a + b, 0) / 6;
    out.disc = out.prem30 <= THRESHOLDS.disc;
  }
  if (Array.isArray(k5) && k5.length >= 1) {
    const hi = Math.max(...k5.map((b) => b.h));
    out.below_high = k5[k5.length - 1].c / hi - 1;
    out.near_high = out.below_high > THRESHOLDS.nearHigh;
  }
  if (Array.isArray(k5) && k5.length >= 9) {
    const q = [k5.slice(-9, -6), k5.slice(-6, -3), k5.slice(-3)];
    const vol = q.map((s) => s.reduce((a, b) => a + b.qv, 0));
    const last = q[2], hi3 = Math.max(...last.map((b) => b.h)), lo3 = Math.min(...last.map((b) => b.l));
    const rng = hi3 - lo3;
    const closePos = rng > 0 ? (last[2].c - lo3) / rng : null;
    const wick = rng > 0 ? (hi3 - Math.max(last[0].o, last[2].c)) / rng : null;
    out.accel = closePos == null ? null : vol[2] > vol[1] && closePos >= 0.75;
    out.decaying = wick == null ? null : vol[2] < vol[1] && vol[1] < vol[0] && wick >= 0.5;
  }
  if (out.crowd != null && out.build != null && out.disc != null) {
    out.signs3 = Number(out.crowd) + Number(out.build) + Number(out.disc);
    if (out.accel != null) out.signs4 = out.signs3 + Number(out.accel);
  }
  return out;
}

export function monthFile(dir, ms) {
  return join(dir, `fuel-shadow-${new Date(ms).toISOString().slice(0, 7)}.ndjson`);
}

async function fapi(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${FAPI}${path}${qs ? `?${qs}` : ''}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

// Value of a 5m statistics series at time ts: the latest row stamped at or before ts
// (fapi stamps these rows at the snapshot instant), and no older than 10 minutes.
export function valueAt(rows, ts, field) {
  let best = null;
  for (const r of rows) if (Number(r.timestamp) <= ts && (!best || Number(r.timestamp) > Number(best.timestamp))) best = r;
  if (!best || ts - Number(best.timestamp) > 600_000) return null;
  const v = Number(best[field]);
  return Number.isFinite(v) ? v : null;
}

async function main() {
  const now = Date.now();
  mkdirSync(DIR, { recursive: true });
  const since = new Date(now - (WINDOW_HOURS + 1) * HOUR).toISOString();
  const alerts = await d1({ CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    FCS_D1_DATABASE_ID: process.env.FCS_D1_DATABASE_ID }, `SELECT symbol, MIN(cast_at) AS cast_at, MAX(entry_price) AS entry_price,
      GROUP_CONCAT(config_id) AS configs FROM surge_signal_log
     WHERE notified = 1 AND dir = -1 AND cast_at >= ? GROUP BY symbol, cast_at`, [since]);
  if (!alerts.length) { console.log('fuel-shadow: no pushed exhaustion alerts in the window'); return; }
  const info = await fapi('/fapi/v1/exchangeInfo');
  const perps = new Set(info.symbols.filter((s) => s.contractType === 'PERPETUAL' && s.status === 'TRADING').map((s) => s.symbol));
  let written = 0;
  for (const a of alerts) {
    const T0 = Date.parse(a.cast_at) + HOUR;              // the alert bar's close
    if (now - T0 > WINDOW_HOURS * HOUR || now < T0) continue;
    const perp = [`${a.symbol}USDT`, `1000${a.symbol}USDT`, `1000000${a.symbol}USDT`].find((p) => perps.has(p));
    if (!perp) continue;
    const rec = { at: new Date(now).toISOString(), symbol: a.symbol, perp, alert_close: new Date(T0).toISOString(), configs: a.configs,
      minutes_since_alert: Math.round((now - T0) / 60000) };
    try {
      const closedTo = Math.floor(now / FIVE) * FIVE;     // only bars that have closed
      const [kl, pk, oiH, glsH] = await Promise.all([
        fapi('/fapi/v1/klines', { symbol: perp, interval: '5m', startTime: T0, endTime: closedTo - 1, limit: 200 }),
        fapi('/fapi/v1/premiumIndexKlines', { symbol: perp, interval: '5m', endTime: closedTo - 1, limit: 6 }),
        fapi('/futures/data/openInterestHist', { symbol: perp, period: '5m', startTime: T0 - 30 * 60000, limit: 200 }),
        fapi('/futures/data/globalLongShortAccountRatio', { symbol: perp, period: '5m', startTime: T0 - 30 * 60000, limit: 200 })
      ]);
      const k5 = kl.filter((r) => r[0] + FIVE <= closedTo).map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], qv: +r[7] }));
      const prem = pk.filter((r) => r[0] + FIVE <= closedTo).map((r) => Number(r[4]));
      Object.assign(rec, fuelState({
        k5, prem: prem.length === 6 ? prem : null,
        oi0: valueAt(oiH, T0, 'sumOpenInterest'), oi1: valueAt(oiH, closedTo, 'sumOpenInterest'),
        gls0: valueAt(glsH, T0, 'longShortRatio'), gls1: valueAt(glsH, closedTo, 'longShortRatio')
      }));
      rec.price = k5.length ? k5[k5.length - 1].c : null;
      rec.high_since_alert = k5.length ? Math.max(...k5.map((b) => b.h)) : null;
    } catch (e) {
      rec.error = String(e.message || e);
    }
    rec.received = new Date().toISOString();
    appendFileSync(monthFile(DIR, now), JSON.stringify(rec) + '\n');
    written++;
  }
  console.log(`fuel-shadow: ${alerts.length} recent pushed alert(s), ${written} state row(s) recorded`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error('fuel-shadow failed:', e); process.exit(1); });
}
