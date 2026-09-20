import { readDataset } from './src/data.mjs';
import { researchReport } from './src/replay.mjs';
try {
  if (process.argv.length !== 3) throw new Error('Usage: node research.mjs DATASET.json');
  console.log(JSON.stringify(researchReport(await readDataset(process.argv[2])), null, 2));
} catch (e) { console.error(e.message); process.exitCode = 1; }
