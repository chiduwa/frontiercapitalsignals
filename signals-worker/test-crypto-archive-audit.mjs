// scripts/crypto-archive-audit.mjs: which archived crypto closes are another
// token, rounded, or zero, and what the audit would do about each. Pure checks
// on synthetic series shaped like the real cases (SKY, WLD, SHIB, ONE, BEAM).
// Run: node test-crypto-archive-audit.mjs
import { auditCoin, quarantineFor, coingeckoCheck, quantizedAnywhere, AUDIT } from './scripts/crypto-archive-audit.mjs';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name} ${detail}`); }
};

const day = (i) => new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10);
let seed = 5;
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const walk = (n, start, vol = 0.03) => { let p = start; return Array.from({ length: n }, () => (p *= Math.exp(vol * (rand() - 0.5) * 2))); };
const bars = (closes, from = 0) => closes.map((c, k) => ({ date: day(from + k), open: c, high: c, low: c, close: c, volume: 1 }));
const rowsOf = (closes, from = 0, source = 'yahoo') => closes.map((c, k) => ({ date: day(from + k), open: null, close: c, high: null, low: null, volume: 1, source }));

console.log('\n== the same token, clean ==');
{
  const px = walk(400, 1.0);
  const binance = bars(px.slice(100), 100);                           // listed on day 100
  const rows = rowsOf(px.map((c, k) => c * (1 + 0.01 * (rand() - 0.5))));   // yahoo within 0.5% of it
  const a = auditCoin(rows, binance, { refPrice: px[px.length - 1] });
  check('verified, nothing to replace, the history before the listing kept', a.verdict === 'verified' && a.replace.length === 0 && a.pre.keep, JSON.stringify({ v: a.verdict, r: a.replace?.length, pre: a.pre }));
  check('and no quarantine marker', quarantineFor('X', a, 'now').length === 0);
}

console.log('\n== a few wrong closes (a glitch, a rounding flip) ==');
{
  const px = walk(300, 50);
  const binance = bars(px);
  const rows = rowsOf(px.slice());
  rows[120] = { ...rows[120], close: px[120] * 1.3 };                    // 30% off Binance's close that day
  rows[200] = { ...rows[200], close: px[200] * 0.85 };
  rows[201] = { ...rows[201], source: 'binance', close: px[201] * 0.5 }; // a Binance-sourced row is never replaced
  const a = auditCoin(rows, binance, { refPrice: px[px.length - 1] });
  check('only the yahoo rows more than 10% off are replaced, with Binance\'s bar for the same date',
    a.replace.length === 2 && a.replace[0].date === day(120) && a.replace[0].newBar.close === px[120] && a.replace[1].date === day(200), JSON.stringify(a.replace.map((x) => x.date)));
}

console.log('\n== another token under the ticker (SKY: Skycoin until the switch) ==');
{
  const sky = walk(500, 0.08);                                           // the coin the engine means, on Binance from day 400
  const skycoin = walk(500, 0.30);                                       // a different token the archive carried
  const binance = bars(sky.slice(400), 400);
  const rows = rowsOf(skycoin.slice(0, 495)).concat(rowsOf(sky.slice(495), 495, 'binance'));
  const a = auditCoin(rows, binance, { refPrice: sky[sky.length - 1] });
  check('identity comes from Binance matching the universe\'s price, not from the archive', a.verdict === 'verified', a.verdict);
  check('every archived close since the listing is replaced', a.replace.length === 95, String(a.replace.length));
  check('the history before the listing is unusable: another token', a.pre && !a.pre.keep && /another token/.test(a.pre.why.join(' ')), JSON.stringify(a.pre));
  const q = quarantineFor('SKY', a, 'now');
  check('one level-shift marker at the start of Binance\'s coverage', q.length === 1 && q[0][2] === day(400) && q[0][3] === 'level-shift' && q[0][5] === 'identity-audit-v1', JSON.stringify(q));
}

console.log('\n== re-pointed at the listing (WLD: $0.008 before, Worldcoin $2.16 after) ==');
{
  const before = walk(200, 0.0076, 0.02);
  const after = walk(100, 2.16);
  const binance = bars(after, 200);
  const rows = rowsOf(before).concat(rowsOf(after.map((c) => c * 1.002), 200));   // the archive agrees once Worldcoin exists
  const a = auditCoin(rows, binance, { refPrice: after[after.length - 1] });
  check('agreeing after the listing does not save a history 280x below it', a.verdict === 'verified' && a.pre && !a.pre.keep && /last close before the listing/.test(a.pre.why.join(' ')), JSON.stringify(a.pre));
}

console.log('\n== a real listing-day jump of the same token ==');
{
  const px = walk(300, 1.0, 0.02);
  const rows = rowsOf(px.slice(0, 150)).concat(rowsOf(px.slice(150).map((c) => c * 2.2), 150));   // +120% on the listing day, then the same series
  const binance = bars(px.slice(150).map((c) => c * 2.2), 150);
  const a = auditCoin(rows, binance, { refPrice: px[px.length - 1] * 2.2 });
  check('a 2.2x listing day is kept: listing days really do move that much', a.pre && a.pre.keep, JSON.stringify(a.pre));
}

console.log('\n== rounded to too few decimals (SHIB before Binance) ==');
{
  const shib = walk(260, 0.000009);
  const rounded = shib.slice(0, 200).map((c) => Math.max(1e-6, Math.round(c * 1e6) / 1e6));
  const rows = rowsOf(rounded).concat(rowsOf(shib.slice(200), 200, 'binance'));
  const a = auditCoin(rows, bars(shib.slice(200), 200), { refPrice: shib[shib.length - 1] });
  check('a long rounded stretch is unusable', a.pre && !a.pre.keep && /rounded/.test(a.pre.why.join(' ')), JSON.stringify(a.pre));
  check('a short one too (under 30 closes)', quantizedAnywhere([1e-6, 1e-6, 2e-6, 2e-6, 2e-6, 1e-6, 2e-6, 3e-6, 3e-6, 2e-6, 2e-6, 3e-6]) === true
    && quantizedAnywhere(walk(20, 1.0)) === false);
}

console.log('\n== Binance lists another token under the ticker (ONE: Harmony vs Cross) ==');
{
  const cross = walk(300, 0.137);
  const harmony = walk(300, 0.005);
  const a = auditCoin(rowsOf(cross), bars(harmony), { refPrice: cross[cross.length - 1] });
  check('left alone: Binance is 27x off the coin the engine means', a.verdict === 'different-token' && !a.replace, JSON.stringify(a));
  const b = auditCoin(rowsOf(cross), bars(cross.map((c) => c * 1.7)), { refPrice: cross[cross.length - 1] });
  check('between 1.5x and 2x: unverifiable, nothing changed', b.verdict === 'unverifiable' && !b.replace, b.verdict);
}

console.log('\n== Binance\'s own redenomination (SUN swapped 1,000 to 1) ==');
{
  const px = walk(300, 0.02);
  const binance = bars(px.map((c, k) => (k < 100 ? c / 1000 : c)));   // Binance's series jumps 1000x on day 100
  const rows = rowsOf(px);                                              // the archive holds the redenominated price throughout
  const a = auditCoin(rows, binance, { refPrice: px[px.length - 1] });
  check('compared only after the swap: nothing replaced, nothing called another token', a.verdict === 'verified' && a.redenominated && a.replace.length === 0 && a.firstBinance === day(100),
    JSON.stringify({ v: a.verdict, r: a.replace?.length, f: a.firstBinance }));
}

console.log('\n== no universe price: the archive must agree with Binance ==');
{
  const px = walk(300, 3.0);
  const a = auditCoin(rowsOf(px), bars(px), { refPrice: null });
  check('agreeing: verified', a.verdict === 'verified', a.verdict);
  const b = auditCoin(rowsOf(walk(300, 9.0)), bars(px), { refPrice: null });
  check('disagreeing, with nothing to say which is right: unverifiable, nothing changed', b.verdict === 'unverifiable' && !b.replace, b.verdict);
}

console.log('\n== CoinGecko, for a coin Binance does not list (BEAM) ==');
{
  const beam = walk(365, 0.002);
  const gecko = beam.map((c, k) => ({ date: day(1000 + k + 1), close: c, high: null, low: null, volume: 1 }));   // D holds D-1's close
  const same = coingeckoCheck(rowsOf(beam, 1000), gecko);
  check('the same coin agrees, with CoinGecko\'s one-day label shift allowed for', same.verdict === 'agrees', JSON.stringify(same));
  const privacyCoin = rowsOf(walk(365 + 900, 0.012), 1000 - 900);
  const other = coingeckoCheck(privacyCoin, gecko);
  check('another token: its year is replaced, and the older bars are counted as unusable',
    other.verdict === 'another-token' && other.replace.length > 300 && other.preRows >= 900 && other.firstGecko === day(1001), JSON.stringify({ ...other, replace: other.replace?.length }));
}

console.log('\n== no archive coverage to judge ==');
{
  const a = auditCoin([], bars(walk(100, 1)), { refPrice: 1 });
  check('an empty archive is unverifiable, not an error', a.verdict === 'unverifiable', a.verdict);
  const n = auditCoin(rowsOf(walk(100, 1)), [], { refPrice: 5 });
  check('not on Binance: reported, and flagged when 2x+ off the universe\'s price', n.verdict === 'no-binance' && n.archiveSuspect === true, JSON.stringify(n));
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nCRYPTO ARCHIVE AUDIT OK');
process.exit(failures ? 1 : 0);
