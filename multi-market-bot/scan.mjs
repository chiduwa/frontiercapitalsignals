import { readDataset } from './src/data.mjs';
import { VERSION, validateSeries, indicators, signalAt } from './src/strategies.mjs';
try {
  if (process.argv.length !== 3) throw new Error('Usage: node scan.mjs DATASET.json');
  const data = await readDataset(process.argv[2]);
  if (data?.version !== 1 || data.series?.length !== 5 || new Set(data.series.map(s => s.symbol)).size !== 5) throw new Error('Expected all five unique markets');
  const observations = data.series.map(s => {
    validateSeries(s, data.asOf);
    const decision = signalAt(s.symbol, s.bars, indicators(s.bars), s.bars.length - 1);
    return { symbol: s.symbol, observedAt: s.bars.at(-1).end,
      ageAtCollectionHours: (data.asOf - s.bars.at(-1).end) / 3_600_000,
      ...decision, executable: false, source: s.source };
  });
  console.log(JSON.stringify({ version: VERSION, mode: 'historical-snapshot', liveEligible: false, observations }, null, 2));
} catch (e) { console.error(e.message); process.exitCode = 1; }
