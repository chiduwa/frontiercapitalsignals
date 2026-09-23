// The archive's Binance tier: added 2026-09-23 because ARB -- an always-
// tracked asset -- had no daily bar after 2026-09-06. Its Yahoo ticker is a
// different token and the anonymous CoinGecko fallback had stopped answering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { binanceDailyBars, withoutCoinGeckoSeam } from './scripts/archive.mjs';

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
