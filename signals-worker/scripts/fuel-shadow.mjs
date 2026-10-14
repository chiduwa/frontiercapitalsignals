// Prospective squeeze-state research only: public reads, one D1 SELECT, local files.
// V2 is a new measurement protocol, not the historical panel's decision grid.
// Existing monthly event files are appended, never rewritten. Run manifests and
// immutable first-valid metric baselines use separate files under FUEL_DATA_DIR.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { d1 } from './d1-client.mjs';

const FIVE = 300_000, HOUR = 3_600_000;
const MAX_METRIC_AGE = 600_000, MAX_PRICE_AGE = 360_000, MAX_RUN_MS = 240_000;
export const WINDOW_HOURS = 12;
export const SCHEMA_VERSION = 2;
export const THRESHOLDS = Object.freeze({ crowd: -0.10, build: 0.05, disc: -0.003, nearHigh: -0.03 });
export const PROTOCOL = Object.freeze({
  id: 'fuel-shadow-prospective-v2',
  anchor: 'source alert candle close; actual notification receipt unknown',
  price_window: '[alert_close, price_asof); complete five-minute candles',
  premium: 'six complete five-minute premium-index candles ending at price_asof; mean of closes',
  metrics: 'published REST snapshot timestamp <= price_asof; no archive timestamp shift assumed',
  baseline: 'first valid historical snapshot at/before alert_close, frozen when first received',
  schedule: 'latest closed five-minute boundary at each observation; timer and manual runs retain actual run and receipt times',
  outcome_anchor: 'decision_available_at plus separately declared execution delay; never backdate to price_asof',
  max_metric_age_ms: MAX_METRIC_AGE, max_price_age_ms: MAX_PRICE_AGE
});
const sha = (x) => createHash('sha256').update(x).digest('hex');
const SOURCE_SHA256 = sha(readFileSync(new URL(import.meta.url)));
const iso = (ms) => new Date(ms).toISOString();
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const positive = (v) => finite(v) && v > 0;

// Reject null/blank/boolean before conversion; explicit zero is valid premium.
export function strictNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const validOHLC = (b, signed = false) => b && [b.o, b.h, b.l, b.c].every(signed ? finite : positive)
  && b.h >= Math.max(b.o, b.c, b.l) && b.l <= Math.min(b.o, b.c, b.h);

// Pure arithmetic for already time-validated samples; malformed independent
// inputs stay unavailable even for direct callers.
export function fuelState({ k5, prem, oi0, oi1, gls0, gls1, thrustBars = k5 } = {}) {
  const out = { d_oi: null, d_gls: null, prem30: null, below_high: null, accel: null, decaying: null,
    crowd: null, build: null, disc: null, signs3: null, signs4: null, near_high: null };
  if (positive(oi0) && positive(oi1)) {
    const change = oi1 / oi0 - 1;
    if (finite(change)) { out.d_oi = change; out.build = change >= THRESHOLDS.build; }
  }
  if (positive(gls0) && positive(gls1)) {
    const change = gls1 / gls0 - 1;
    if (finite(change)) { out.d_gls = change; out.crowd = change <= THRESHOLDS.crowd; }
  }
  if (Array.isArray(prem) && prem.length === 6 && prem.every(finite)) {
    const mean = prem.reduce((a, b) => a + b / 6, 0);
    if (finite(mean)) { out.prem30 = mean; out.disc = mean <= THRESHOLDS.disc; }
  }
  if (Array.isArray(k5) && k5.length && k5.every((b) => validOHLC(b))) {
    const hi = Math.max(...k5.map((b) => b.h));
    out.below_high = k5.at(-1).c / hi - 1;
    out.near_high = out.below_high > THRESHOLDS.nearHigh;
  }
  if (Array.isArray(thrustBars) && thrustBars.length >= 9) {
    const bars = thrustBars.slice(-9);
    if (bars.every((b) => validOHLC(b) && finite(b.qv) && b.qv >= 0)) {
      const blocks = [bars.slice(0, 3), bars.slice(3, 6), bars.slice(6)];
      const volumes = blocks.map((s) => s.reduce((a, b) => a + b.qv, 0));
      const last = blocks[2], hi = Math.max(...last.map((b) => b.h)), lo = Math.min(...last.map((b) => b.l));
      const range = hi - lo;
      if (range > 0 && volumes.every(finite)) {
        out.accel = volumes[2] > volumes[1] && (last[2].c - lo) / range >= 0.75;
        out.decaying = volumes[2] < volumes[1] && volumes[1] < volumes[0]
          && (hi - Math.max(last[0].o, last[2].c)) / range >= 0.5;
      }
    }
  }
  if (out.crowd != null && out.build != null && out.disc != null) {
    out.signs3 = Number(out.crowd) + Number(out.build) + Number(out.disc);
    if (out.accel != null) out.signs4 = out.signs3 + Number(out.accel);
  }
  return out;
}
export function monthFile(dir, ms) {
  return join(dir, 'fuel-shadow-' + iso(ms).slice(0, 7) + '.ndjson');
}

// Exact grids reject duplicates, stale last bars, missing interior bars and
// forming/unexpected rows. Price and volume validity remain independent.
export function validateCandles(rows, start, end, { premium = false } = {}) {
  const reasons = [];
  const expected = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start % FIVE === 0
    && end % FIVE === 0 && end > start && end - start <= WINDOW_HOURS * HOUR
    ? Array.from({ length: (end - start) / FIVE }, (_, i) => start + i * FIVE) : [];
  if (!expected.length) reasons.push('no_complete_expected_window');
  if (!Array.isArray(rows)) reasons.push('non_array_response');
  if (Array.isArray(rows) && rows.length > 200) reasons.push('too_many_rows');
  const raw = Array.isArray(rows) ? rows.slice(0, 200) : [];
  const byTime = new Map();
  const samples = raw.map((r) => {
    const row = Array.isArray(r) ? r : [];
    const b = { t: strictNumber(row[0]), o: strictNumber(row[1]), h: strictNumber(row[2]),
      l: strictNumber(row[3]), c: strictNumber(row[4]), close_t: strictNumber(row[6]), qv: strictNumber(row[7]) };
    if (!Number.isSafeInteger(b.t) || b.t % FIVE !== 0) reasons.push('invalid_open_time');
    else {
      if (byTime.has(b.t)) reasons.push('duplicate_open_time');
      byTime.set(b.t, b);
      if (b.t < start || b.t >= end) reasons.push('unexpected_open_time');
    }
    if (b.close_t !== b.t + FIVE - 1) reasons.push('invalid_close_time');
    return b;
  });
  if (expected.some((t) => !byTime.has(t))) reasons.push('missing_expected_bar');
  const gridValid = reasons.length === 0 && raw.length === expected.length;
  const priceValid = gridValid && samples.every((b) => validOHLC(b, premium));
  const volumeValid = gridValid && samples.every((b) => finite(b.qv) && b.qv >= 0);
  if (!samples.every((b) => validOHLC(b, premium))) reasons.push('invalid_ohlc');
  if (!samples.every((b) => finite(b.qv) && b.qv >= 0)) reasons.push('invalid_quote_volume');
  return { grid_valid: gridValid, price_valid: priceValid, volume_valid: volumeValid,
    expected_count: expected.length, observed_count: Array.isArray(rows) ? rows.length : null,
    start: iso(start), end: iso(end), reasons: [...new Set(reasons)],
    samples: samples.sort((a, b) => (a.t ?? 0) - (b.t ?? 0)), raw_rows: raw };
}
const sliceRows = (rows, start, end) => Array.isArray(rows)
  ? rows.filter((r) => { const t = strictNumber(r?.[0]); return t != null && t >= start && t < end; }) : null;

export function metricSample(rows, ts, field, { availableAt = ts, current = false, grid = true } = {}) {
  const empty = (reason, extra = {}) => ({ value: null, timestamp: null, reason, ...extra });
  if (!Array.isArray(rows) || rows.length > 200) return empty('invalid_metric_response');
  const parsed = rows.map((raw) => ({ raw, t: strictNumber(raw?.timestamp) }));
  if (parsed.some((r) => !Number.isSafeInteger(r.t) || r.t < 0 || (grid && r.t % FIVE !== 0))) return empty('invalid_metric_timestamp');
  const past = parsed.filter((r) => r.t <= ts).sort((a, b) => b.t - a.t);
  if (!past.length) return empty('no_metric_at_or_before_asof');
  const best = past[0], age = ts - best.t, receiptAge = availableAt - best.t;
  const details = { timestamp: best.t, asof_age_ms: age, available_age_ms: receiptAge, raw: best.raw };
  if (past.filter((r) => r.t === best.t).length > 1) return empty('duplicate_metric_timestamp', details);
  if (age > MAX_METRIC_AGE || (current && receiptAge > MAX_METRIC_AGE)) return empty('stale_metric', details);
  const value = strictNumber(best.raw[field]);
  if (!positive(value)) return empty('invalid_metric_value', details);
  return { value, ...details, reason: null };
}
export function valueAt(rows, ts, field) {
  return metricSample(rows, ts, field, { grid: false }).value;
}

export function createBaselineStore(dir) {
  const baseDir = join(dir, 'baselines', PROTOCOL.id);
  return {
    getOrCreate(key, candidate) {
      mkdirSync(baseDir, { recursive: true });
      const file = join(baseDir, sha(key) + '.json');
      const read = () => {
        const value = JSON.parse(readFileSync(file, 'utf8'));
        if (value.key !== key || value.protocol_id !== PROTOCOL.id || !positive(value.sample?.value)
          || !Number.isSafeInteger(value.sample?.timestamp)) throw new Error('invalid frozen baseline ' + sha(key));
        return value;
      };
      try { return { baseline: read(), origin: 'frozen' }; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!candidate) return { baseline: null, origin: 'unavailable' };
      const tmp = file + '.' + randomUUID() + '.tmp';
      try {
        writeFileSync(tmp, JSON.stringify(candidate) + '\n', { flag: 'wx', mode: 0o600 });
        try { linkSync(tmp, file); }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
      } finally { try { unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
      return { baseline: read(), origin: 'first_valid' };
    }
  };
}
function fileSink(dir) {
  mkdirSync(dir, { recursive: true });
  return (kind, record) => {
    const at = Date.parse(record.received || record.at || record.run_started_at);
    const file = kind === 'event' ? monthFile(dir, at)
      : join(dir, 'fuel-shadow-runs-' + iso(at).slice(0, 7) + '.ndjson');
    appendFileSync(file, JSON.stringify(record) + '\n');
  };
}
const errorText = (e) => String(e?.message || e).slice(0, 500);
const sourceMeta = ({ data, ...meta }) => meta;

// Injected dependencies test the real request-to-record path completely offline.
export async function runShadow(options = {}) {
  const env = options.env || process.env;
  const clock = options.clock || Date.now;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const query = options.query || d1;
  const dir = options.dir || env.FUEL_DATA_DIR || '/var/lib/fcs-fuel-shadow';
  const emit = options.emit || fileSink(dir);
  const store = options.baselineStore || createBaselineStore(dir);
  const log = options.log || console.log;
  const base = (env.BINANCE_FAPI_BASE || 'https://fapi.binance.com').replace(/\/$/, '');
  const started = clock(), runId = options.runId || randomUUID();
  const version = { sha256: SOURCE_SHA256, revision: env.FCS_SOURCE_REVISION || null };
  const common = { schema_version: SCHEMA_VERSION, protocol: PROTOCOL, source_version: version, run_id: runId,
    run_started_at: iso(started) };
  emit('run', { ...common, at: iso(started), record_type: 'run_started', expected_events: null });
  const capture = async (name, fn, request = {}) => {
    const before = clock();
    try {
      const data = await fn();
      return { name, request, requested_at: iso(before), received_at: iso(clock()), status: 'ok',
        payload_sha256: sha(JSON.stringify(data) ?? 'undefined'), row_count: Array.isArray(data) ? data.length : null, data };
    } catch (e) {
      return { name, request, requested_at: iso(before), received_at: iso(clock()), status: 'error', error: errorText(e), data: null };
    }
  };
  const fapi = (path, params = {}) => capture(path, async () => {
    const qs = new URLSearchParams(params).toString();
    const res = await fetchFn(base + path + (qs ? '?' + qs : ''), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(String(res.status) + ' ' + path);
    return res.json();
  }, { endpoint: path, params });
  const alertsResult = await capture('d1_alerts', () => query({
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
    FCS_D1_DATABASE_ID: env.FCS_D1_DATABASE_ID
  }, 'SELECT symbol, cast_at, MAX(entry_price) AS entry_price, GROUP_CONCAT(config_id) AS configs '
    + 'FROM surge_signal_log WHERE notified = 1 AND dir = -1 AND cast_at >= ? '
    + 'GROUP BY symbol, cast_at ORDER BY cast_at, symbol', [iso(started - (WINDOW_HOURS + 1) * HOUR)]));
  if (alertsResult.status !== 'ok' || !Array.isArray(alertsResult.data)) {
    const result = { ...common, at: iso(clock()), record_type: 'run_complete', status: 'failed',
      expected_events: null, written_events: 0, reason: 'alert_cohort_unavailable', sources: { alerts: sourceMeta(alertsResult) } };
    emit('run', result);
    return result;
  }
  const eligible = [], skipped = [];
  for (const a of alertsResult.data) {
    const anchor = Date.parse(a.cast_at) + HOUR;
    if (typeof a.symbol !== 'string' || !a.symbol.trim() || !Number.isSafeInteger(anchor) || anchor % HOUR !== 0) {
      skipped.push({ symbol: a.symbol ?? null, cast_at: a.cast_at ?? null, reason: 'invalid_alert_identity' });
    } else if (started < anchor || started - anchor > WINDOW_HOURS * HOUR) {
      skipped.push({ symbol: a.symbol, cast_at: a.cast_at, reason: 'outside_observation_window' });
    } else {
      eligible.push({ ...a, anchor, event_id: sha(a.symbol + '|' + iso(anchor)) });
    }
  }
  emit('run', { ...common, at: iso(clock()), record_type: 'run_plan', expected_events: eligible.length,
    cohort: eligible.map((a) => ({ event_id: a.event_id, symbol: a.symbol, cast_at: a.cast_at })),
    skipped, sources: { alerts: sourceMeta(alertsResult) } });
  const info = eligible.length ? await fapi('/fapi/v1/exchangeInfo') : null;
  const infoValid = info?.status === 'ok' && Array.isArray(info.data?.symbols);
  const perps = new Set(infoValid ? info.data.symbols.filter((s) => s.contractType === 'PERPETUAL' && s.status === 'TRADING').map((s) => s.symbol) : []);
  const counts = { complete: 0, partial: 0, unavailable: 0 };
  let written = 0;
  for (const a of eligible) {
    const now = clock(), closedTo = Math.floor(now / FIVE) * FIVE;
    const candidates = [a.symbol + 'USDT', '1000' + a.symbol + 'USDT', '1000000' + a.symbol + 'USDT'];
    const perp = candidates.find((p) => perps.has(p)) || null;
    const rec = { ...common, record_type: 'state', event_id: a.event_id,
      check_id: sha(PROTOCOL.id + '|' + a.event_id + '|' + closedTo), observation_id: randomUUID(),
      at: iso(now), check_at: iso(closedTo), price_asof: iso(closedTo), symbol: a.symbol, perp,
      alert_close: iso(a.anchor), cast_at: a.cast_at, configs: a.configs, alert_reference_price: strictNumber(a.entry_price),
      minutes_since_alert: Math.round((now - a.anchor) / 60000), thresholds: THRESHOLDS,
      mapping: { candidates, selected: perp, source_received_at: info?.received_at || null },
      ...fuelState(), price: null, high_since_alert: null, entry_reference_5m: null, high_since_entry: null, runup: null,
      status: 'unavailable', reasons: [], sources: {}, inputs: {} };
    if (now - started > (options.maxRunMs ?? MAX_RUN_MS)) rec.reasons.push('run_budget_exceeded');
    else if (now - a.anchor > WINDOW_HOURS * HOUR) rec.reasons.push('observation_window_elapsed_during_run');
    else if (!infoValid) {
      rec.reasons.push('exchange_info_unavailable');
      rec.sources.exchange_info = sourceMeta(info || { status: 'error', error: 'not requested' });
    } else if (!perp) rec.reasons.push('unsupported_perp');
    else {
      const [kl, pk, oi, gls] = await Promise.all([
        fapi('/fapi/v1/klines', { symbol: perp, interval: '5m', startTime: a.anchor, endTime: closedTo - 1, limit: 200 }),
        fapi('/fapi/v1/premiumIndexKlines', { symbol: perp, interval: '5m', startTime: closedTo - 6 * FIVE, endTime: closedTo - 1, limit: 6 }),
        fapi('/futures/data/openInterestHist', { symbol: perp, period: '5m', startTime: a.anchor - 30 * 60000, endTime: closedTo, limit: 200 }),
        fapi('/futures/data/globalLongShortAccountRatio', { symbol: perp, period: '5m', startTime: a.anchor - 30 * 60000, endTime: closedTo, limit: 200 })
      ]);
      const available = clock();
      rec.sources = { klines: sourceMeta(kl), premium: sourceMeta(pk), oi: sourceMeta(oi), gls: sourceMeta(gls) };
      for (const [name, result] of Object.entries(rec.sources)) if (result.status !== 'ok') rec.reasons.push(name + '_source_error');
      const candles = validateCandles(kl.data, a.anchor, closedTo);
      const thrust = validateCandles(sliceRows(kl.data, closedTo - 9 * FIVE, closedTo), closedTo - 9 * FIVE, closedTo);
      const latest = validateCandles(sliceRows(kl.data, closedTo - FIVE, closedTo), closedTo - FIVE, closedTo);
      const premium = validateCandles(pk.data, closedTo - 6 * FIVE, closedTo, { premium: true });
      const fresh = available >= closedTo && available - closedTo <= MAX_PRICE_AGE;
      rec.inputs = { candles, thrust, latest, premium, metrics: {} };
      if (!fresh) rec.reasons.push('price_asof_stale_at_receipt');
      for (const [name, checked] of Object.entries({ candles, thrust, premium })) {
        if (!checked.price_valid || (name === 'thrust' && !checked.volume_valid)) rec.reasons.push(name + '_quality_unavailable');
      }
      const baselineValues = {}, currentValues = {};
      for (const [name, result, field] of [['oi', oi, 'sumOpenInterest'], ['gls', gls, 'longShortRatio']]) {
        const reference = metricSample(result.data, a.anchor, field, { availableAt: available });
        const current = metricSample(result.data, closedTo, field, { availableAt: available, current: true });
        const key = a.event_id + '|' + perp + '|' + name;
        const candidate = reference.value != null ? { key, protocol_id: PROTOCOL.id, event_id: a.event_id, perp,
          field, alert_close: iso(a.anchor), first_received_at: result.received_at,
          source_version: version, source: sourceMeta(result), sample: reference } : null;
        try {
          const stored = store.getOrCreate(key, candidate), frozen = stored.baseline;
          const prior = frozen?.sample;
          const changed = !!(prior && reference.value != null && (prior.value !== reference.value || prior.timestamp !== reference.timestamp));
          rec.inputs.metrics[name] = { reference_candidate: reference, current, baseline: frozen, baseline_origin: stored.origin,
            baseline_revision_observed: changed };
          baselineValues[name] = prior?.value ?? null;
        } catch (e) {
          rec.inputs.metrics[name] = { reference_candidate: reference, current, baseline: null, baseline_error: errorText(e) };
          rec.reasons.push(name + '_baseline_unavailable');
          baselineValues[name] = null;
        }
        currentValues[name] = current.value;
        if (baselineValues[name] == null || current.value == null) rec.reasons.push(name + '_metric_unavailable');
      }
      Object.assign(rec, fuelState({
        k5: fresh && candles.price_valid ? candles.samples : null,
        thrustBars: fresh && thrust.price_valid && thrust.volume_valid ? thrust.samples : null,
        prem: fresh && premium.price_valid ? premium.samples.map((s) => s.c) : null,
        oi0: baselineValues.oi, oi1: currentValues.oi, gls0: baselineValues.gls, gls1: currentValues.gls
      }));
      if (fresh && latest.price_valid) rec.price = latest.samples[0].c;
      if (fresh && candles.price_valid) {
        rec.high_since_alert = Math.max(...candles.samples.map((s) => s.h));
        rec.entry_reference_5m = candles.samples.find((s) => s.t === a.anchor + FIVE)?.o ?? null;
        if (positive(rec.entry_reference_5m)) {
          rec.high_since_entry = Math.max(...candles.samples.filter((s) => s.t >= a.anchor + FIVE).map((s) => s.h));
          rec.runup = rec.high_since_entry / rec.entry_reference_5m - 1;
        }
      }
      const values = ['crowd', 'build', 'disc', 'near_high', 'accel'].map((k) => rec[k]);
      rec.status = values.every((v) => v != null) ? 'complete' : values.some((v) => v != null) ? 'partial' : 'unavailable';
    }
    rec.reasons = [...new Set(rec.reasons)];
    rec.received = iso(clock());
    rec.decision_available_at = rec.received;
    rec.price_age_at_available_ms = Date.parse(rec.received) - closedTo;
    emit('event', rec);
    counts[rec.status]++;
    written++;
  }
  const summary = { ...common, at: iso(clock()), record_type: 'run_complete', status: 'complete',
    expected_events: eligible.length, written_events: written, counts, skipped_alerts: skipped.length };
  emit('run', summary);
  log('fuel-shadow: ' + eligible.length + ' eligible alert(s), ' + written + ' coverage row(s), ' + JSON.stringify(counts));
  return summary;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runShadow().then((summary) => { if (summary.status === 'failed') process.exitCode = 1; })
    .catch((e) => { console.error('fuel-shadow failed:', e); process.exitCode = 1; });
}
