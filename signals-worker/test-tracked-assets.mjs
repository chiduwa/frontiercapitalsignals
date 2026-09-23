// The always-tracked list is written down in fifteen places: the Worker, the
// Oracle-host samplers, the research lanes (two of them Python), the health
// monitor, two provider-id maps and a workflow argument. They cannot share one
// import -- worker.js is bundled by wrangler and must stay byte-identical to
// src/worker.js, the Oracle scripts stay light, and Python cannot import JS --
// so this test is what keeps them one list. Adding ARB on 2026-09-23 touched
// every copy; the next addition must fail here until it does the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FAVORITE_SYMBOLS } from './worker.js';
import { ALWAYS_TRACKED_OI } from './scripts/oi-sampler.mjs';
import { ALWAYS_TRACKED } from './scripts/tracked-data-quality.mjs';
import { TRACKED } from './scripts/tracked-research-data.mjs';
import { CMC_TRACKED_IDS } from './scripts/market-explanations.mjs';
import { INSTRUMENTS } from './scripts/session-data.mjs';
import { CRYPTO_IDS } from './scripts/stable-basket-data.mjs';

const canonical = [...FAVORITE_SYMBOLS].sort();
const sorted = xs => [...xs].sort();
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
/** The quoted tickers inside the first bracketed list matching `pattern`. */
const listIn = (text, pattern) => {
  const m = text.match(pattern);
  assert.ok(m, `pattern ${pattern} not found`);
  return [...m[1].matchAll(/['"]([A-Z0-9]+)['"]/g)].map(x => x[1]);
};

test('ARB is always tracked', () => {
  assert.ok(FAVORITE_SYMBOLS.has('ARB'));
});

test('every JS copy of the list equals FAVORITE_SYMBOLS', () => {
  assert.deepEqual(sorted(ALWAYS_TRACKED_OI), canonical, 'oi-sampler ALWAYS_TRACKED_OI');
  assert.deepEqual(sorted(ALWAYS_TRACKED), canonical, 'tracked-data-quality ALWAYS_TRACKED');
  assert.deepEqual(sorted(TRACKED), canonical, 'tracked-research-data TRACKED');
  assert.deepEqual(sorted(Object.keys(CMC_TRACKED_IDS)), canonical, 'market-explanations CMC_TRACKED_IDS');
  assert.deepEqual(sorted(listIn(source('./scripts/binance-direct-collect.mjs'), /const favorites = new Set\((\[[^\]]*\])\)/)),
    canonical, 'binance-direct-collect favorites');
  assert.deepEqual(sorted(listIn(source('./scripts/health-check.mjs'), /for \(const symbol of (\[[^\]]*\])\)/)),
    canonical, 'health-check OI collector list');
  const retro = source('./scripts/retrospective.mjs').match(/FAVORITE_COINGECKO_IDS = new Map\(\[([\s\S]*?)\]\);/);
  assert.ok(retro, 'retrospective FAVORITE_COINGECKO_IDS not found');
  assert.deepEqual(sorted([...retro[1].matchAll(/\['([A-Z0-9]+)',/g)].map(x => x[1])), canonical,
    'retrospective FAVORITE_COINGECKO_IDS');
});

test('the provider-id maps cover every tracked asset', () => {
  // CoinMarketCap liquidations are requested by numeric id, separately from
  // the symbol map; a missing id silently drops that asset's liquidation read.
  const ids = source('./scripts/cmc-research.mjs').match(/const ids='([0-9,]+)'/);
  assert.ok(ids, 'cmc-research id list not found');
  assert.deepEqual(ids[1].split(',').map(Number).sort((a, b) => a - b),
    Object.values(CMC_TRACKED_IDS).sort((a, b) => a - b), 'cmc-research ids match CMC_TRACKED_IDS');
  for (const s of canonical) assert.ok(CRYPTO_IDS[s], `stable-basket CRYPTO_IDS lacks ${s}`);
  // Every tracked asset needs a venue instrument, or the session study reads
  // no hourly bars for it and reports nothing without failing.
  const instruments = new Set(INSTRUMENTS.map(i => i.symbol));
  for (const s of canonical) assert.ok(instruments.has(s), `session-data INSTRUMENTS lacks ${s}`);
});

test('the Python research lanes and the workflow read the same list', () => {
  assert.deepEqual(sorted(listIn(source('./scripts/session-research.py'), /^SYMBOLS=(\[[^\]]*\])/m)), canonical,
    'session-research.py SYMBOLS');
  for (const file of ['signals-tracked-research.yml', 'signals-sequence-research.yml', 'signals-model-tournament.yml']) {
    const wf = source(`../.github/workflows/${file}`).match(/--symbols ([A-Z0-9,]+)/);
    assert.ok(wf, `${file} --symbols not found`);
    assert.deepEqual(sorted(wf[1].split(',')), canonical, `${file} --symbols`);
  }
});
