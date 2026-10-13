// Tests for the two research recorders that run on the bot host:
// scripts/liquidation-collector.mjs and scripts/fuel-shadow.mjs. Pure parts only;
// neither the WebSocket nor the network is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordFromMessage, dayFile, expiredFiles, WS_URL } from './scripts/liquidation-collector.mjs';
import { fuelState, valueAt, monthFile, THRESHOLDS } from './scripts/fuel-shadow.mjs';

test('liquidation stream uses the /market/ws route (the old /ws route delivers nothing)', () => {
  assert.match(WS_URL, /^wss:\/\/fstream\.binance\.com\/market\/ws\/!forceOrder@arr$/);
});

test('a forceOrder message keeps Binance fields verbatim plus receipt time', () => {
  const msg = JSON.stringify({ e: 'forceOrder', E: 1791825694197, o: { s: 'API3USDT', S: 'SELL', o: 'LIMIT', f: 'IOC', q: '295.5', p: '0.3070', ap: '0.3114', X: 'FILLED', l: '189.8', z: '295.5', T: 1791825693191 } });
  const r = recordFromMessage(msg, 1791825694300);
  assert.deepEqual(r, { r: 1791825694300, E: 1791825694197, s: 'API3USDT', S: 'SELL', o: 'LIMIT', f: 'IOC', q: '295.5', p: '0.3070', ap: '0.3114', X: 'FILLED', l: '189.8', z: '295.5', T: 1791825693191 });
  assert.equal(recordFromMessage('not json', 1), null);
  assert.equal(recordFromMessage(JSON.stringify({ e: 'aggTrade' }), 1), null);
});

test('files are per UTC day; retention removes only expired recorder files', () => {
  assert.equal(dayFile('/d', Date.parse('2026-10-12T23:59:59Z')), '/d/forceorder-2026-10-12.ndjson');
  assert.equal(dayFile('/d', Date.parse('2026-10-13T00:00:00Z')), '/d/forceorder-2026-10-13.ndjson');
  const names = ['forceorder-2025-01-01.ndjson.gz', 'forceorder-2026-10-01.ndjson.gz', 'forceorder-2026-10-12.ndjson', 'other.txt'];
  assert.deepEqual(expiredFiles(names, Date.parse('2026-10-13T00:00:00Z'), 400), ['forceorder-2025-01-01.ndjson.gz']);
});

const bars = (n, f = () => ({})) => Array.from({ length: n }, (_, i) => ({ t: i, o: 100, h: 101, l: 99, c: 100, qv: 1000, ...f(i) }));

test('fuel signs: unavailable inputs stay null, never a reassuring zero', () => {
  const s = fuelState({ k5: bars(12), prem: null, oi0: null, oi1: 10, gls0: 1.2, gls1: null });
  assert.equal(s.build, null); assert.equal(s.crowd, null); assert.equal(s.disc, null);
  assert.equal(s.signs3, null, 'no count when any of the three inputs is missing');
  assert.equal(s.signs4, null);
  const five = fuelState({ k5: bars(12), prem: [-0.001, -0.002, NaN, -0.001, -0.001, -0.001], oi0: 10, oi1: 11, gls0: 1.2, gls1: 1.0 });
  assert.equal(five.disc, null, 'a missing premium sample makes the premium sign unavailable');
});

test('fuel signs: thresholds as researched, counted only when all inputs exist', () => {
  const s = fuelState({ k5: bars(12), prem: [-0.004, -0.004, -0.003, -0.003, -0.003, -0.003], oi0: 100, oi1: 106, gls0: 1.5, gls1: 1.3 });
  assert.equal(s.build, true);                      // +6% contracts OI
  assert.equal(s.crowd, true);                      // -13.3% account ratio
  assert.equal(s.disc, true);                       // mean premium index -0.333%
  assert.equal(s.signs3, 3);
  const q = fuelState({ k5: bars(12), prem: [0, 0, 0, 0, 0, 0], oi0: 100, oi1: 104.9, gls0: 1.5, gls1: 1.36 });
  assert.equal(q.signs3, 0, `just inside every threshold ${JSON.stringify(THRESHOLDS)}`);
});

test('accelerating vs decaying thrust from three 15-minute blocks', () => {
  // rising volume, close at the top of the last block's range
  const acc = fuelState({ k5: bars(9, (i) => ({ qv: 100 * (i + 1), h: 101 + (i === 8 ? 1 : 0), c: i === 8 ? 102 : 100 })), prem: null, oi0: null, oi1: null, gls0: null, gls1: null });
  assert.equal(acc.accel, true); assert.equal(acc.decaying, false);
  // falling volume two blocks running, long upper wick
  const dec = fuelState({ k5: bars(9, (i) => ({ qv: 1000 - 100 * i, h: i === 7 ? 110 : 101, c: 100 })), prem: null, oi0: null, oi1: null, gls0: null, gls1: null });
  assert.equal(dec.decaying, true); assert.equal(dec.accel, false);
  assert.equal(fuelState({ k5: bars(5), prem: null }).accel, null, 'fewer than three 15-minute blocks: unavailable');
});

test('near-high and statistics lookups use only data at or before the time, and reject stale rows', () => {
  const s = fuelState({ k5: bars(12, (i) => ({ h: i === 3 ? 110 : 101, c: i === 11 ? 107 : 100 })), prem: null });
  assert.ok(Math.abs(s.below_high - (107 / 110 - 1)) < 1e-12);
  assert.equal(s.near_high, true);
  const rows = [{ timestamp: 1000, sumOpenInterest: '5' }, { timestamp: 2000, sumOpenInterest: '6' }, { timestamp: 9_000_000, sumOpenInterest: '9' }];
  assert.equal(valueAt(rows, 2500, 'sumOpenInterest'), 6, 'latest row at or before the time');
  assert.equal(valueAt(rows, 1_000_000, 'sumOpenInterest'), null, 'older than 10 minutes is unavailable');
  assert.equal(monthFile('/d', Date.parse('2026-10-31T23:59:59Z')), '/d/fuel-shadow-2026-10.ndjson');
});
