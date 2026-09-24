// The wide sequence screen, step 1 of 3: split one whole-archive panel into
// small per-batch panels (docs/SEQUENCE_MODELS.md, "The wide screen").
// Research only: reads a saved panel file, writes files, touches nothing live.
//
//   node scripts/sequence-wide-batches.mjs <panel.json> <outDir> [--min-bars 600] [--size 8]
//
// Every crypto or stock asset with enough daily bars is kept, except the
// always-tracked 8 (the weekly sequence lane already scores them), pegs, and
// series stored at too few decimals to have a real return (isQuantizedSeries).
// Each batch panel carries its own assets plus the inputs they read -- the
// always-tracked coins as crypto leaders, SPY as the stocks' benchmark -- so
// an asset's rows never depend on which batch it landed in.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isNonDirectionalAsset } from '../worker.js';
import { sanitizeBars } from './panel-features.mjs';
import { isQuantizedSeries } from './archive.mjs';
import { TRACKED } from './tracked-research-data.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const k = args.indexOf(name); return k >= 0 ? Number(args[k + 1]) : fallback; };
const [panelPath, outDir] = args.filter((a, i) => !a.startsWith('--') && !['--min-bars', '--size'].includes(args[i - 1]));
if (!panelPath || !outDir) throw new Error('usage: sequence-wide-batches.mjs <panel.json> <outDir> [--min-bars 600] [--size 8]');
const minBars = flag('--min-bars', 600), size = flag('--size', 8);

const p = JSON.parse(readFileSync(panelPath, 'utf8'));
const eligible = { crypto: [], stock: [] }, skipped = { peg: [], quantized: [] };
for (const a of p.assets) {
  if (!['crypto', 'stock'].includes(a.assetClass)) continue;
  if (a.assetClass === 'crypto' && TRACKED.includes(a.symbol)) continue;
  // Usable bars, not stored ones: a coin once stored at six decimals keeps
  // years of zero closes (BABYDOGE: 1,929 bars, 11 of them usable).
  const closes = sanitizeBars(a.bars, { asOf: p.asOf }).map(b => b.close);
  if (closes.length < minBars) continue;
  // Quantization is judged on the bars as stored: sanitizing drops repeated
  // closes, which is exactly what hides it.
  if (isQuantizedSeries(a.bars.map(b => b.close))) { skipped.quantized.push(a.symbol); continue; }
  if (a.assetClass === 'crypto' && isNonDirectionalAsset({ symbol: a.symbol }, closes)) { skipped.peg.push(a.symbol); continue; }
  eligible[a.assetClass].push(a.symbol);
}
const pick = (obj, keep) => obj ? Object.fromEntries(Object.entries(obj).filter(([k]) => keep.has(k))) : obj;
mkdirSync(join(outDir, 'panels'), { recursive: true });
const batches = [];
for (const cls of ['crypto', 'stock']) {
  const list = eligible[cls].sort();
  for (let i = 0; i < list.length; i += size) {
    const batch = list.slice(i, i + size);
    const keep = new Set([...batch, ...(cls === 'crypto' ? TRACKED : ['SPY'])]);
    const panel = { asOf: p.asOf, assets: p.assets.filter(a => keep.has(a.symbol)),
      derivatives: pick(p.derivatives, keep), funding: pick(p.funding, keep), supply: pick(p.supply, keep),
      liquidity: (p.liquidity || []).filter(r => keep.has(r.symbol)), supplySnapshots: [], sentiment: p.sentiment };
    const id = `${cls}-${String(batches.length).padStart(3, '0')}`;
    writeFileSync(join(outDir, 'panels', `${id}.json`), JSON.stringify(panel));
    batches.push({ id, assetClass: cls, symbols: batch });
  }
}
writeFileSync(join(outDir, 'batches.json'), JSON.stringify(batches, null, 1));
console.log(`as of ${p.asOf}: crypto ${eligible.crypto.length}, stocks ${eligible.stock.length}, ${batches.length} batches; ` +
  `skipped ${skipped.peg.length} pegs, ${skipped.quantized.length} quantized (${skipped.quantized.join(',') || 'none'})`);
