// The archive's Binance tier: added 2026-09-23 because ARB -- an always-
// tracked asset -- had no daily bar after 2026-09-06. Its Yahoo ticker is a
// different token and the anonymous CoinGecko fallback had stopped answering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { binanceDailyBars, withoutCoinGeckoSeam, coinGeckoReplacement, replaceCoinGeckoBars, alignRowsByTrueClose } from './scripts/archive.mjs';
import { selectArchiveUpdates } from './scripts/archive-policy.mjs';

const DAY = 86400000;
const t0 = Date.UTC(2023, 2, 23);
const kline = (i, close) => [t0 + i * DAY, String(close), String(close * 1.02), String(close * 0.97), String(close), '1000', t0 + (i + 1) * DAY - 1, String(close * 1000)];

function fakeBinance(days, price = 0.25) {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    const start = Number(new URL(url).searchParams.get('startTime'));
    const first = Math.max(0, Math.round((start - t0) / DAY));
    return Array.from({ length: Math.max(0, Math.min(1000, days - first)) }, (_, k) => kline(first + k, price));
  };
  return { fetcher, calls };
}

test('pages forward from the listing until caught up, and keeps quote volume', async () => {
  const { fetcher, calls } = fakeBinance(1280);
  const nowMs = t0 + 1280 * DAY + 3600000; // an hour into the day after the last bar
  const bars = await binanceDailyBars('ARB', 0.25, { fetcher, nowMs, startMs: Date.UTC(2017, 0, 1) });
  assert.equal(calls.length, 2, 'two pages of at most 1000 days');
  assert.equal(bars.length, 1280);
  assert.equal(bars[0].date, '2023-03-23');
  assert.equal(bars[0].volume, 250, 'quote (USDT) volume, the unit every other crypto source stores');
  assert.ok(bars.every(b => b.high >= b.close && b.low <= b.close && b.open > 0));
});

test('today\'s unfinished bar is never archived', async () => {
  const { fetcher } = fakeBinance(400);
  const nowMs = t0 + 399 * DAY + 3600000; // the 400th bar is still in progress
  const bars = await binanceDailyBars('ARB', 0.25, { fetcher, nowMs });
  assert.equal(bars.length, 399);
});

test('a same-ticker different asset, or a dead listing, is refused rather than archived', async () => {
  const live = fakeBinance(400);
  const nowMs = t0 + 400 * DAY + 3600000;
  await assert.rejects(binanceDailyBars('ARB', 25, { fetcher: live.fetcher, nowMs }), /different asset/);
  const dead = fakeBinance(200);
  await assert.rejects(binanceDailyBars('ARB', 0.25, { fetcher: dead.fetcher, nowMs }), /stale/);
  await assert.rejects(binanceDailyBars('ARB', 0.25, { fetcher: async () => [], nowMs }), /thin history/);
});

test('bars that would collide with CoinGecko history after alignment are left out', () => {
  const bars = ['2025-08-29', '2025-08-30', '2025-08-31', '2026-09-05', '2026-09-06', '2026-09-07'].map(date => ({ date, close: 1 }));
  // CoinGecko rows are midnight samples: the row dated 08-31 is the close of 08-30.
  const kept = withoutCoinGeckoSeam(bars, new Set(['2025-08-31', '2026-09-06'])).map(b => b.date);
  assert.deepEqual(kept, ['2025-08-29', '2026-09-07']);
  assert.equal(withoutCoinGeckoSeam(bars, new Set()).length, bars.length, 'no CoinGecko rows, nothing dropped');
});

// The hole those two rules leave (2026-09-23): CoinGecko's slot D holds D-1's
// close, so after a CoinGecko -> Binance switch the true close of the last
// CoinGecko date had nowhere to go. One missing day voids every 60-day crypto
// feature window across it; 32 coins lost two months of research rows.
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const D0 = Date.UTC(2025, 0, 1);
const close = i => 1 + 0.2 * Math.sin(i / 9) + i * 0.001;       // true close of day i
const binanceBar = i => ({ date: iso(D0 + i * DAY), open: close(i), high: close(i) * 1.01, low: close(i) * 0.99, close: close(i), volume: 5 });

function archive({ cgFrom, cgTo, binanceFrom, binanceTo }) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./scripts/schema.sql', import.meta.url), 'utf8').match(/CREATE TABLE IF NOT EXISTS asset_daily_bars \([\s\S]*?\);/)[0]);
  const put = db.prepare('INSERT INTO asset_daily_bars (symbol, asset_class, date, open, close, high, low, volume, source) VALUES (?,?,?,?,?,?,?,?,?)');
  // Binance history before the CoinGecko span, less the bar the seam rule
  // dropped; CoinGecko midnight samples (slot i holds close i-1); Binance after.
  for (let i = binanceFrom; i < cgFrom - 1; i++) { const b = binanceBar(i); put.run('ARB', 'crypto', b.date, b.open, b.close, b.high, b.low, 5, 'binance'); }
  for (let i = cgFrom; i <= cgTo; i++) put.run('ARB', 'crypto', iso(D0 + i * DAY), null, close(i - 1), null, null, 9, 'coingecko');
  for (let i = cgTo + 1; i <= binanceTo; i++) { const b = binanceBar(i); put.run('ARB', 'crypto', b.date, b.open, b.close, b.high, b.low, 5, 'binance'); }
  const batch = async (_env, statements) => { for (const st of statements) db.prepare(st.sql).run(...st.params); };
  return { db, batch };
}

// The nightly path in backfill-history.mjs, step for step.
async function nightly({ db, batch }, fetched, nowMs) {
  const stored = db.prepare("SELECT date, source, close FROM asset_daily_bars WHERE symbol = 'ARB'").all();
  const coingecko = stored.filter(r => r.source === 'coingecko');
  const replacement = coinGeckoReplacement(fetched, coingecko, { nowMs });
  await replaceCoinGeckoBars({}, replacement.map(b => ({ symbol: 'ARB', assetClass: 'crypto', ...b, source: 'binance' })), { batch });
  const replaced = new Set(replacement.map(b => b.date));
  for (const r of coingecko) if (replaced.has(r.date)) r.source = 'binance';
  const joinable = withoutCoinGeckoSeam(fetched, new Set(coingecko.filter(r => r.source === 'coingecko').map(r => r.date)));
  const missing = selectArchiveUpdates(joinable, { existingDates: stored.map(r => r.date), minDate: stored[0].date, maxDate: stored.at(-1).date }, 1e9, { nowMs });
  const put = db.prepare("INSERT INTO asset_daily_bars (symbol, asset_class, date, open, close, high, low, volume, source) VALUES ('ARB','crypto',?,?,?,?,?,?,'binance')");
  for (const b of missing) put.run(b.date, b.open, b.close, b.high, b.low, b.volume);
  return { replaced: replacement.length, filled: missing.length };
}

const alignedHoles = db => {
  const rows = alignRowsByTrueClose(db.prepare("SELECT symbol, date, close, source FROM asset_daily_bars ORDER BY date").all());
  const holes = [];
  for (let k = 1; k < rows.length; k++) {
    const gap = (Date.parse(rows[k].date) - Date.parse(rows[k - 1].date)) / DAY;
    if (gap !== 1) holes.push(`${rows[k - 1].date}..${rows[k].date}`);
  }
  return { rows, holes };
};

test('when Binance covers the whole CoinGecko span, the seam hole disappears and every close is the true one', async () => {
  const a = archive({ cgFrom: 200, cgTo: 560, binanceFrom: 0, binanceTo: 575 });
  assert.equal(alignedHoles(a.db).holes.length, 1, 'the archive as the Binance tier left it: one hole at the seam');
  const nowMs = D0 + 576 * DAY + 3600000;
  const fetched = Array.from({ length: 577 }, (_, i) => binanceBar(i)); // includes today's unfinished bar
  const run = await nightly(a, fetched, nowMs);
  assert.equal(run.replaced, 361);
  const { rows, holes } = alignedHoles(a.db);
  assert.deepEqual(holes, []);
  assert.equal(rows.length, 576, 'days 0..575, each once');
  for (const r of rows) assert.ok(Math.abs(r.close - close(Math.round((Date.parse(r.date) - D0) / DAY))) < 1e-12, `wrong close on ${r.date}`);
  assert.equal(a.db.prepare("SELECT COUNT(*) AS n FROM asset_daily_bars WHERE source = 'coingecko'").get().n, 0);
  assert.equal(a.db.prepare(`SELECT COUNT(*) AS n FROM asset_daily_bars WHERE date = '${iso(nowMs)}'`).get().n, 0, 'today\'s bar is never written');
  const again = await nightly(a, fetched, nowMs);
  assert.deepEqual(again, { replaced: 0, filled: 0 }, 'a second night is a no-op');
});

test('when Binance listed later, the hole moves back to the listing and the recent windows are whole', async () => {
  const a = archive({ cgFrom: 200, cgTo: 560, binanceFrom: 400, binanceTo: 575 });
  const nowMs = D0 + 576 * DAY + 3600000;
  const fetched = Array.from({ length: 176 }, (_, i) => binanceBar(400 + i));
  const run = await nightly(a, fetched, nowMs);
  assert.equal(run.replaced, 161, 'CoinGecko days 400..560');
  const { holes } = alignedHoles(a.db);
  assert.deepEqual(holes, [`${iso(D0 + 398 * DAY)}..${iso(D0 + 400 * DAY)}`], 'n slots cannot hold n+1 closes: one day is lost, at the listing');
  assert.equal(a.db.prepare("SELECT COUNT(*) AS n FROM asset_daily_bars WHERE source = 'coingecko'").get().n, 200, 'CoinGecko history before the listing is kept');
});

test('a Binance series that disagrees with CoinGecko on price is a different asset and replaces nothing', async () => {
  const a = archive({ cgFrom: 200, cgTo: 560, binanceFrom: 0, binanceTo: 575 });
  const nowMs = D0 + 576 * DAY + 3600000;
  const impostor = Array.from({ length: 576 }, (_, i) => ({ ...binanceBar(i), close: close(i) * 40 }));
  assert.deepEqual(coinGeckoReplacement(impostor, a.db.prepare("SELECT date, source, close FROM asset_daily_bars WHERE source = 'coingecko'").all(), { nowMs }), []);
});

test('the replacement SQL rewrites only CoinGecko rows, whatever it is handed', async () => {
  const a = archive({ cgFrom: 200, cgTo: 560, binanceFrom: 0, binanceTo: 575 });
  const before = a.db.prepare("SELECT date, close, source FROM asset_daily_bars WHERE source != 'coingecko' ORDER BY date").all();
  const everything = Array.from({ length: 576 }, (_, i) => ({ symbol: 'ARB', assetClass: 'crypto', ...binanceBar(i), close: 777, source: 'binance' }));
  await replaceCoinGeckoBars({}, everything, { batch: a.batch });
  const after = a.db.prepare(`SELECT date, close, source FROM asset_daily_bars WHERE date IN (${before.map(r => `'${r.date}'`).join(',')}) ORDER BY date`).all();
  assert.deepEqual(after, before, 'Binance rows untouched');
  assert.equal(a.db.prepare("SELECT COUNT(*) AS n FROM asset_daily_bars WHERE close = 777").get().n, 361 + 1, 'the 361 CoinGecko slots, plus the one free slot the seam rule had emptied');
});
