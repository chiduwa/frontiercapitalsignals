// Offline JSON -> JSON research report. Never imports account/execution code.
import { readFile, stat } from 'node:fs/promises';
import { comparePolicies } from './src/policy-replay.mjs';

try {
  const filename = process.argv[2];
  if (!filename || process.argv.length !== 3) throw new Error('Usage: node trading-bot/policy-research.mjs /path/to/replay-input.json');
  if ((await stat(filename)).size > 32 * 1024 * 1024) throw new Error('input exceeds 32 MiB research budget');
  const input = JSON.parse(await readFile(filename, 'utf8'));
  console.log(JSON.stringify(comparePolicies(input.events, input.policies, input.comparison), null, 2));
} catch (error) {
  console.error(`Policy research failed: ${error.message}`);
  process.exitCode = 1;
}
