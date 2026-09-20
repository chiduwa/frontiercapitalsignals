import { writeFile } from 'node:fs/promises';
import { collectMarkets } from './src/data.mjs';
try {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) throw new Error('Usage: node collect.mjs NEW_DATASET.json');
  const data = await collectMarkets();
  await writeFile(path, JSON.stringify(data), { flag: 'wx' });
  console.log(JSON.stringify({ path, asOf: data.asOf, series: data.series.map(s => ({ symbol: s.symbol, bars: s.bars.length, ...s.dataQuality })) }, null, 2));
} catch (e) { console.error(e.message); process.exitCode = 1; }
