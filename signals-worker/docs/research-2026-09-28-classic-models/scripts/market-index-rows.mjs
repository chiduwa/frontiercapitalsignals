// The market as a whole, as research rows: an equal-weight index of the
// tournament's coins, one of its stocks, and SPY, built by the same row
// builder every asset uses (tracked-research-data.mjs researchRows, tournament
// mode, so each row carries GARCH + weekday). Feeds classic-models-research.py
// --extra. Read-only.
//
// node --max-old-space-size=6144 market-index-rows.mjs <panel.json> <universe.json> <out.json>
//   universe.json: {"crypto": [...symbols], "stock": [...symbols]}
import { readFile, writeFile } from 'node:fs/promises';

const SW = new URL('../../../', import.meta.url);
const { researchRows } = await import(new URL('scripts/tracked-research-data.mjs', SW));
const { sanitizeBars } = await import(new URL('scripts/panel-features.mjs', SW));
const [panelPath, universePath, outPath] = process.argv.slice(2);
const panel = JSON.parse(await readFile(panelPath, 'utf8'));
const universe = JSON.parse(await readFile(universePath, 'utf8'));
const asOf = panel.asOf;

// Daily equal-weight return over the constituents quoted on both days; a
// one-day move beyond +-300% is a known archive artifact and is skipped.
function equalWeight(symbols, assetClass) {
  const series = symbols
    .map((s) => panel.assets.find((a) => a.symbol === s && a.assetClass === assetClass))
    .filter(Boolean)
    .map((a) => new Map(sanitizeBars(a.bars, { asOf }).map((b) => [b.date, b.close])));
  const dates = [...new Set(series.flatMap((m) => [...m.keys()]))].sort();
  const bars = [];
  let level = 100, prev = null;
  for (const d of dates) {
    if (prev) {
      const rets = series
        .map((m) => (m.get(d) > 0 && m.get(prev) > 0 ? m.get(d) / m.get(prev) - 1 : null))
        .filter((x) => x !== null && Math.abs(x) < 3);
      if (rets.length >= 5) {
        level *= 1 + rets.reduce((a, b) => a + b, 0) / rets.length;
        bars.push({ date: d, close: level, volume: null, high: null, low: null, source: 'equal-weight-index' });
      }
    }
    prev = d;
  }
  return { bars, constituents: series.length };
}

const crypto = equalWeight(universe.crypto, 'crypto');
const stock = equalWeight(universe.stock, 'stock');
const btc = panel.assets.find((a) => a.symbol === 'BTC' && a.assetClass === 'crypto');
const spy = panel.assets.find((a) => a.symbol === 'SPY');
const mini = {
  asOf,
  assets: [
    { symbol: 'MKT_CRYPTO', assetClass: 'crypto', bars: crypto.bars },
    btc,
    { symbol: 'MKT_STOCK', assetClass: 'stock', bars: stock.bars },
    { ...spy, assetClass: 'stock' },
  ],
  derivatives: {}, funding: {}, liquidity: [], supply: {},
};
const c = researchRows(mini, { symbols: ['MKT_CRYPTO'], assetClass: 'crypto', tournament: true });
const s = researchRows(mini, { symbols: ['MKT_STOCK', 'SPY'], assetClass: 'stock', tournament: true });
const out = {
  asOf,
  symbols: ['MKT_CRYPTO', 'MKT_STOCK', 'SPY'],
  assetClassBySymbol: { MKT_CRYPTO: 'crypto', MKT_STOCK: 'stock', SPY: 'stock' },
  constituents: { MKT_CRYPTO: crypto.constituents, MKT_STOCK: stock.constituents },
  rows: [...c.rows, ...s.rows],
};
await writeFile(outPath, JSON.stringify(out));
console.log(`crypto index: ${crypto.bars.length} days from ${crypto.bars[0]?.date} (${crypto.constituents} coins); ` +
  `stock index: ${stock.bars.length} sessions from ${stock.bars[0]?.date} (${stock.constituents} stocks); ` +
  `SPY bars ${spy?.bars?.length}; rows ${out.rows.length}`);
