import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sma, projectSma, trendFor, fetchTotalMarket, buildMarketTrend, MARKET_TREND_EVIDENCE, MA_WINDOWS
} from './scripts/market-trend.mjs';

const DAY = 86_400_000;
const T0 = Date.parse('2021-01-01T00:00:00Z');
const day = (i) => new Date(T0 + i * DAY).toISOString().slice(0, 10);
// a deterministic wavy uptrend, 2,000 days
const wave = (i) => 20000 * Math.exp(0.0008 * i + 0.25 * Math.sin(i / 37) + 0.05 * Math.sin(i / 5));
const series = Array.from({ length: 2000 }, (_, i) => ({ date: day(i), close: wave(i) }));
const closes = series.map((p) => p.close);

test('the projected average equals brute force over the extended series', () => {
  const path = (j) => 30000 + 100 * j;
  for (const n of [20, 200, 1400]) {
    const p = projectSma(closes, n, 30, path);
    const ext = closes.concat(Array.from({ length: 30 }, (_, j) => path(j + 1)));
    for (const k of [1, 7, 30]) assert.ok(Math.abs(p[k - 1] - sma(ext, n, closes.length - 1 + k)) < 1e-6, `n ${n} k ${k}`);
  }
});

test('keepRisingAbove is the close leaving the window, and price holding counts the rising days', () => {
  const t = trendFor(series, { kind: 'btc' });
  assert.equal(t.status, 'ok');
  const end = closes.length - 1, P = closes[end];
  for (const m of t.ma) {
    assert.ok(Math.abs(m.keepRisingAbove - closes[end - m.n + 1]) / closes[end - m.n + 1] < 1e-5);
    const above = sma(closes.concat([m.keepRisingAbove * 1.01]), m.n), below = sma(closes.concat([m.keepRisingAbove * 0.99]), m.n);
    assert.ok(above > sma(closes, m.n) && below < sma(closes, m.n), `n ${m.n}`);
    let rising = 0;
    for (let j = 1; j <= 30; j++) if (P > closes[end - m.n + j]) rising++;
    assert.equal(m.risingDaysIfFlat, rising);
    assert.ok(m.in30Low <= m.in30Flat && m.in30Flat <= m.in30High, `cone ordered n ${m.n}`);
  }
  assert.deepEqual(t.ma.map((m) => m.n), MA_WINDOWS);
});

test('ranges are ordered and the evidence for both periods rides on each signal', () => {
  const t = trendFor(series, { kind: 'btc' });
  for (const r of [t.range.d7, t.range.d30]) assert.ok(r.lo95 < r.lo68 && r.lo68 < t.value && t.value < r.hi68 && r.hi68 < r.hi95);
  assert.ok(t.range.d30.hi68 / t.value > t.range.d7.hi68 / t.value, '30-day band wider than 7-day');
  assert.ok(t.signals.length >= 3);
  for (const s of t.signals) {
    assert.ok(Number.isFinite(s.early.median) && Number.isFinite(s.late.median) && Number.isFinite(s.late.t));
  }
  const above = t.signals.find((s) => s.key === 'above200');
  const e = MARKET_TREND_EVIDENCE.btc.states.above200;
  assert.equal(above.late.median, above.now ? e.late90.trueMedian : e.late90.falseMedian);
  assert.equal(t.chart.close.length, 365);
  assert.equal(t.chart.projection.sma200.length, 30);
  assert.equal(trendFor(series.slice(0, 100), { kind: 'btc' }).status, 'unavailable');
});

test('the 50/200 cross: state, start date, and the meeting day if price holds', () => {
  // a gentle rise for 400 days, then a steady slide: the 50 drops under the 200
  const top = 100 * Math.exp(0.001 * 399);
  const s = Array.from({ length: 600 }, (_, i) => ({ date: day(i), close: i < 400 ? 100 * Math.exp(0.001 * i) : top * Math.exp(-0.004 * (i - 399)) }));
  const t = trendFor(s, { kind: 'btc' });
  assert.equal(t.cross.state, 'death');
  assert.ok(t.cross.sinceDays > 0 && t.cross.sinceDays < 200);
  // a rebound that will lift the 50 back over the 200 if price holds there
  const lift = sma(s.map((p) => p.close), 200) * 1.2;
  const r = s.concat(Array.from({ length: 3 }, (_, j) => ({ date: day(600 + j), close: lift })));
  const t2 = trendFor(r, { kind: 'btc' });
  assert.equal(t2.cross.state, 'death');
  assert.ok(Number.isInteger(t2.cross.meetInDaysIfFlat) && t2.cross.meetInDaysIfFlat > 0, 'flat price closes the gap');
});

test('CMC values are filed under the day they cover, and the live reading is today', async () => {
  const now = Date.parse('2026-10-14T19:00:00Z');
  const quotes = Array.from({ length: 300 }, (_, i) => ({
    timestamp: new Date(Date.parse('2025-12-19T02:30:00Z') + i * DAY).toISOString(), btcDominance: 59,
    quote: [{ totalMarketCap: 2e12 + i * 1e9, totalVolume24H: 1e11 }]
  }));
  const fetchJson = async (url) => (url.includes('/latest') ? { data: { btcDominance: 60, quotes: [{ totalMarketCap: 2.7e12, totalVolume24H: 4e10 }] } } : { data: { quotes } });
  const { rows, live } = await fetchTotalMarket({ fetchJson, nowMs: now });
  assert.equal(live, true);
  assert.equal(rows[0].date, '2025-12-18');
  assert.equal(rows[rows.length - 1].date, '2026-10-14');
  assert.equal(rows[rows.length - 1].close, 2.7e12);
  assert.equal(rows[rows.length - 2].date, '2026-10-13');
  const noLatest = await fetchTotalMarket({ fetchJson: async (u) => { if (u.includes('/latest')) throw new Error('down'); return { data: { quotes } }; }, nowMs: now });
  assert.equal(noLatest.live, false);
  assert.equal(noLatest.rows[noLatest.rows.length - 1].date, '2026-10-13');
});

test('a source that fails keeps the previous hour, marked stale; no previous means unavailable', async () => {
  const fail = async () => { throw new Error('offline'); };
  const fresh = await buildMarketTrend({ fetchJson: fail });
  assert.equal(fresh.btc.status, 'unavailable');
  assert.equal(fresh.total.status, 'unavailable');
  const prev = { btc: trendFor(series, { kind: 'btc' }), total: trendFor(series, { kind: 'total' }) };
  const carried = await buildMarketTrend({ fetchJson: fail, previous: prev });
  assert.equal(carried.btc.stale, true);
  assert.equal(carried.btc.value, prev.btc.value);
  assert.equal(carried.total.stale, true);
});

test('the quiet-volume read uses the rank within the past 30 days', () => {
  const vol = Array.from({ length: 60 }, (_, i) => ({ date: day(1940 + i), volume: 100 + (i % 10) }));
  vol[vol.length - 1].volume = 50;
  const t = trendFor(series, { kind: 'total', volume: vol });
  assert.equal(t.volume.quiet, true);
  assert.equal(t.volume.rank30, 0);
  vol[vol.length - 1].volume = 500;
  assert.equal(trendFor(series, { kind: 'total', volume: vol }).volume.quiet, false);
});

test('the evidence file is the research output', () => {
  const ev = JSON.parse(readFileSync(new URL('./docs/research-2026-10-14-moving-averages/ma_evidence.json', import.meta.url)));
  for (const s of ['btc', 'total']) {
    for (const k of ['above200', 'golden', 'rising200', 'stack_bull', 'stack_bear']) {
      assert.deepEqual(MARKET_TREND_EVIDENCE[s].states[k].early90, ev[s].states[k].early90, `${s} ${k}`);
      assert.deepEqual(MARKET_TREND_EVIDENCE[s].states[k].late90, ev[s].states[k].late90, `${s} ${k}`);
    }
    assert.deepEqual(MARKET_TREND_EVIDENCE[s].range.late30, ev[s].range.late30);
    for (const b of ev[s].mayerBands) assert.equal(MARKET_TREND_EVIDENCE[s].mayerBands[b.band][b.half].median90, b.median90);
  }
});
