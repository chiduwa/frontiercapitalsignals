// computeLeadLag, rewritten 2026-09-23 for two reasons: it ran past the
// nightly job's 120-minute limit every day (and everything queued after it
// stopped), and most of what it registered was a timestamp artifact -- a
// same-day move read as a one-day lead because CoinGecko and DeFiLlama rows
// are midnight samples of the PREVIOUS day's close.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLeadLag, laggedCorrelationDense, denseReturnsBySymbol, alignRowsByTrueClose } from './scripts/archive.mjs';
import { laggedCorrelation } from './worker.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
}
const normal = r => Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r());
const day = i => new Date(Date.UTC(2022, 0, 1 + i)).toISOString().slice(0, 10);

test('the dense correlation is identical to the date-keyed reference, gaps and all', () => {
  const r = rng(7);
  let compared = 0;
  for (let trial = 0; trial < 150; trial++) {
    const series = (off, len, gap) => {
      const o = {};
      for (let i = 0; i < len; i++) if (r() > gap) o[day(off + i)] = normal(r) * 3;
      return o;
    };
    const a = series(Math.floor(r() * 40), 60 + Math.floor(r() * 300), r() * 0.4);
    const b = series(Math.floor(r() * 40), 60 + Math.floor(r() * 300), r() * 0.4);
    const d = denseReturnsBySymbol({ a, b });
    for (const lag of [1, 2, 3, 4, 5, 7, 10]) {
      const ref = laggedCorrelation(a, b, lag), fast = laggedCorrelationDense(d.get('a'), d.get('b'), lag);
      assert.equal(fast === null, ref === null, `null disagreement at lag ${lag}`);
      if (!ref) continue;
      assert.equal(fast.samples, ref.samples);
      assert.ok(Math.abs(fast.corr - ref.corr) < 1e-12, `corr ${fast.corr} vs ${ref.corr}`);
      compared++;
    }
  }
  assert.ok(compared > 800, `only ${compared} compared`);
});

test('midnight samples move back a day, and a seam keeps the true close', () => {
  const rows = [
    { symbol: 'X', date: '2026-01-02', close: 1, source: 'binance' },
    { symbol: 'X', date: '2026-01-03', close: 2, source: 'coingecko' },
    { symbol: 'X', date: '2026-01-02', close: 9, source: 'coingecko' },
    { symbol: 'TVL:X', date: '2026-01-05', close: 5, source: 'defillama' },
    { symbol: 'Y', date: '2026-01-05', close: 3, source: 'yahoo' }
  ];
  const out = alignRowsByTrueClose(rows).map(r => `${r.symbol}|${r.date}|${r.close}`);
  assert.deepEqual(out, ['X|2026-01-01|9', 'X|2026-01-02|1', 'TVL:X|2026-01-04|5', 'Y|2026-01-05|3']);
});

test('same-day co-movement is not registered as a lead; a genuine lag still is', () => {
  const r = rng(11), n = 400;
  const leader = Array.from({ length: n }, () => normal(r) * 0.02);
  const rows = [];
  const push = (symbol, source, closes, shift = 0) => closes.forEach((c, i) => rows.push({ symbol, date: day(i + shift), close: c, source }));
  const walk = rets => { let p = 100; return [p, ...rets.map(x => (p *= Math.exp(x)))]; };
  push('LEAD', 'yahoo', walk(leader));
  // The same asset's moves, sampled at midnight by CoinGecko: every close is
  // stamped one day late. Unaligned, this reads as "LEAD leads TWIN by a day".
  push('TWIN', 'coingecko', walk(leader.map(x => x + normal(r) * 0.004)), 1);
  // A real two-day follower.
  push('FOLLOW', 'yahoo', walk(leader.map((_, i) => (i >= 2 ? leader[i - 2] : 0) + normal(r) * 0.01)));
  return computeLeadLag({}, rows).then(signals => {
    const pairs = signals.map(s => `${s.leaderSymbol}>${s.followerSymbol}@${s.lagDays}`);
    assert.ok(!pairs.includes('LEAD>TWIN@1'), `artifact registered: ${pairs.join(', ')}`);
    assert.ok(pairs.includes('LEAD>FOLLOW@2'), `real lag missed: ${pairs.join(', ')}`);
    // And the unaligned reading really would have produced the artifact.
    return computeLeadLag({}, rows.map(x => ({ ...x, source: 'raw' }))).then(raw => {
      assert.ok(raw.some(s => s.leaderSymbol === 'LEAD' && s.followerSymbol === 'TWIN' && s.lagDays === 1));
    });
  });
});
