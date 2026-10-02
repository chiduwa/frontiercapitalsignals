// Day zones (scripts/day-zones.mjs): the live forecast must be the study's
// forecast, to the digit, on real bars; nothing after today's open may move
// it; and a coin Binance spot lists too recently falls back to Hyperliquid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dayZoneForecast, buildDayZones, DAY_ZONE } from './scripts/day-zones.mjs';

const fixture = JSON.parse(readFileSync(new URL('./test-fixtures/day-zones-2026-09-30.json', import.meta.url), 'utf8'));
const toBars = (rows) => rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));

test('the forecast reproduces the study (docs/research-2026-10-02-day-zones, daytop.py) on real BTC and HBAR bars', () => {
  for (const [sym, f] of Object.entries(fixture)) {
    const z = dayZoneForecast(toBars(f.bars), f.now);
    assert.ok(z, `${sym}: a zone`);
    assert.equal(z.date, '2026-09-30');
    assert.equal(z.open, f.open);
    assert.ok(Math.abs(z.upLog - f.upLog) < 1e-12, `${sym} up ${z.upLog} vs ${f.upLog}`);
    assert.ok(Math.abs(z.downLog - f.downLog) < 1e-12, `${sym} down ${z.downLog} vs ${f.downLog}`);
    assert.ok(Math.abs(z.top - f.open * Math.exp(f.upLog)) < 1e-9 * f.open);
    assert.equal(z.windows, DAY_ZONE.windows);
  }
});

test('nothing after today\'s open changes the zone', () => {
  const f = fixture.BTC;
  const bars = toBars(f.bars);
  const base = dayZoneForecast(bars, f.now);
  const open = Date.parse('2026-09-30T00:00:00Z');
  const later = bars.filter(b => b.t <= open).concat(
    [1, 2, 3].map(k => ({ t: open + k * 3600e3, o: 1, h: 1e9, l: 1e-9, c: 1 })));
  const z = dayZoneForecast(later, f.now);
  assert.equal(z.upLog, base.upLog);
  assert.equal(z.downLog, base.downLog);
});

test('no zone without today\'s 00:00 bar or without 60 complete days', () => {
  const f = fixture.BTC;
  const bars = toBars(f.bars);
  assert.equal(dayZoneForecast(bars.filter(b => b.t !== Date.parse('2026-09-30T00:00:00Z')), f.now), null);
  assert.equal(dayZoneForecast(bars.filter(b => b.t >= Date.parse('2026-08-15T00:00:00Z')), f.now), null);
});

test('a coin Binance spot cannot cover falls back to Hyperliquid; a coin neither covers is reported missing', async () => {
  const f = fixture.HBAR;
  const bars = toBars(f.bars);
  const calls = [];
  const out = await buildDayZones(f.now, {
    symbols: ['BTC', 'HYPE', 'ARB'],
    binance: async (s) => { calls.push(['binance', s]); return s === 'BTC' ? bars : bars.slice(-200); },
    hyperliquid: async (s) => { calls.push(['hyperliquid', s]); if (s === 'ARB') throw new Error('HTTP 500'); return bars; }
  });
  assert.equal(out.bySymbol.BTC.source, 'binance-spot');
  assert.equal(out.bySymbol.HYPE.source, 'hyperliquid-perp');
  assert.deepEqual(out.missing, ['ARB']);
  assert.ok(!calls.some(c => c[0] === 'hyperliquid' && c[1] === 'BTC'), 'Hyperliquid is only the fallback');
  assert.equal(out.date, '2026-09-30');
  assert.equal(out.refHourUtc, 0);
});
