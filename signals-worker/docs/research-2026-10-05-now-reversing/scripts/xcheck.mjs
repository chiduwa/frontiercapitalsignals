import { readFileSync, readdirSync } from 'node:fs';
import { closedHourBars, detectPump } from '../../../../trading-bot/src/pump-fade-rules.mjs';
const py = JSON.parse(readFileSync('py_pumps.json', 'utf8'));
const syms = readdirSync('h1').map((f) => f.slice(0, -5)).filter((s) => s !== 'BTC').sort().filter((_, i) => i % 6 === 0);
let same = 0, onlyJs = 0, onlyPy = 0; const diffs = [];
for (const s of syms) {
  const k = JSON.parse(readFileSync(`h1/${s}.json`, 'utf8'));
  if (k.length < 500) continue;
  const js = new Set();
  // Python stops 49 bars before the end (it needs the forward window); match that.
  for (let i = 25; i < k.length - 49; i++) {
    const win = k.slice(Math.max(0, i - 59), i + 1);
    const r = detectPump(closedHourBars(win, k[i][0] + 3600_000 + 60_000), { maxLagBars: 0 });
    if (r.setup) js.add(r.setup.barTs);
  }
  const p = new Set(py[s] || []);
  for (const t of js) p.has(t) ? same++ : (onlyJs++, diffs.push(`${s} js-only ${new Date(t).toISOString()}`));
  for (const t of p) if (!js.has(t)) { onlyPy++; diffs.push(`${s} py-only ${new Date(t).toISOString()}`); }
}
console.log(`symbols ${syms.length}: identical ${same}, JS-only ${onlyJs}, Python-only ${onlyPy}`);
console.log(diffs.slice(0, 12).join('\n'));
