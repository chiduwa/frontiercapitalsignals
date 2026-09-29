// scripts/coin-rotation.mjs and its I/O: the paper rotation's days, universe,
// cohorts, scoring, live record and push, on synthetic coins, with no network.
// Run: node test-coin-rotation.mjs
import {
  ROT, ROT_EXCLUDE, addDays, dailyFromHourly, rotationUniverse, formCohort, scoreCohort, neweyWestT,
  rotationRecord, rotationAlertState, rotationAlert, ROTATION_VERSION
} from './scripts/coin-rotation.mjs';
import { runCoinRotation, loadCoinRotation, latestCompleteDay, ROT_EVIDENCE } from './scripts/coin-rotation-io.mjs';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name} ${detail}`); }
};
const H = 3600000, DAY = 86400000;

console.log('\n== days: UTC calendar days, complete only, a clock change cannot touch them ==');
{
  const t0 = Date.UTC(2026, 2, 7);                  // 2026-03-07, the day before US clocks spring forward
  const bars = Array.from({ length: 24 * 3 + 5 }, (_, i) => ({ openTime: new Date(t0 + i * H).toISOString(), close: 100 + i, quoteVolume: 10 }));
  const d = dailyFromHourly(bars);
  check('three complete days, closed by their 23:00 UTC bar; the partial fourth is not a day',
    d.close.size === 3 && d.close.get('2026-03-07') === 123 && d.close.get('2026-03-09') === 171 && !d.close.has('2026-03-10'),
    JSON.stringify([...d.close]));
  check('a day\'s quote volume is its 24 hours', d.qv.get('2026-03-08') === 240);
  check('the latest complete day is yesterday in UTC, whatever the local clock',
    latestCompleteDay(Date.UTC(2026, 10, 1, 0, 5)) === '2026-10-31' && latestCompleteDay(Date.UTC(2026, 10, 1, 23, 59)) === '2026-10-31');
}

// ---- a synthetic market: 130 coins, 80 days
let seed = 3;
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const DAYS = 80, start = '2026-06-01';
function market({ reversal = 0 } = {}) {
  const coins = {};
  const names = Array.from({ length: 125 }, (_, i) => `C${i}`).concat(['USDC1', 'PAXG', 'NEWC', 'THIN', 'WBTC']);
  const common = Array.from({ length: DAYS }, () => 0.03 * (rand() - 0.5));
  const moves = {};
  for (const s of names) {
    const close = new Map(), qv = new Map();
    let p = 1 + rand() * 10, prev = 0;
    moves[s] = [];
    for (let d = 0; d < DAYS; d++) {
      const date = addDays(start, d);
      let r = s === 'USDC1' ? 0.0005 * (rand() - 0.5) : common[d] + 0.05 * (rand() - 0.5) - reversal * prev;
      if (s === 'USDC1') r = 0;
      prev = r - common[d];
      p *= Math.exp(r); moves[s].push(r);
      if (s === 'NEWC' && d < DAYS - 20) continue;           // listed 20 days ago
      close.set(date, s === 'USDC1' ? 1 + 0.0001 * (d % 2) : p);
      qv.set(date, s === 'THIN' ? 1 : 1e6 * (1 + (Number(s.slice(1)) || 0) % 50));
    }
    coins[s] = { close, qv };
  }
  return coins;
}

console.log('\n== the universe ==');
{
  const m = market();
  const formedOn = addDays(start, DAYS - 1);
  const uni = rotationUniverse(m, formedOn);
  check('the 100 most-traded coins with 41 days of history', uni.length === ROT.universeSize, String(uni.length));
  check('no stablecoin, no gold, no wrapped coin, no coin listed 20 days ago',
    !uni.includes('USDC1') && !uni.includes('PAXG') && !uni.includes('WBTC') && !uni.includes('NEWC') && ROT_EXCLUDE.has('PAXG'), JSON.stringify(uni.filter((s) => !/^C\d+$/.test(s))));
  check('ranked by volume: the thinnest coin is left out first', !uni.includes('THIN'));
}

console.log('\n== a cohort ==');
{
  const m = market();
  const formedOn = addDays(start, DAYS - 3);
  const uni = rotationUniverse(m, formedOn);
  const c = formCohort(m, uni, formedOn, 2);
  const all = [...c.longs, ...c.shorts];
  check('every member is a laggard or a leader, by its move against the others', all.length === uni.length && c.longs.every((x) => x[2] < 0) && c.shorts.every((x) => x[2] > 0));
  check('the laggards are listed most-lagging first', c.longs[0][2] <= c.longs[c.longs.length - 1][2]);
  const s0 = uni[5], i = all.findIndex((x) => x[0] === s0);
  const own = Math.log(m[s0].close.get(formedOn) / m[s0].close.get(addDays(formedOn, -2)));
  const others = uni.filter((x) => x !== s0).map((x) => Math.log(m[x].close.get(formedOn) / m[x].close.get(addDays(formedOn, -2))));
  const rel = own - others.reduce((a, b) => a + b, 0) / others.length;
  check('relative move = own 2-day log move less the mean of the other 99', Math.abs(all[i][2] - Math.round(rel * 1e6) / 1e6) < 1e-6, `${all[i][2]} vs ${rel}`);
  check('it matures k days later', c.maturesOn === addDays(formedOn, 2));
  const exit = (sym) => m[sym].close.get(c.maturesOn);
  const sc = scoreCohort(c, exit);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const L = mean(c.longs.map(([s, e]) => exit(s) / e - 1)), S = mean(c.shorts.map(([s, e]) => exit(s) / e - 1));
  check('spread = laggards\' mean return less the leaders\', net of 0.2%', Math.abs(sc.spread - (L - S)) < 1e-12 && Math.abs(sc.netSpread - (L - S - 0.002)) < 1e-12);
  check('a coin that stopped trading drops out instead of scoring zero',
    scoreCohort(c, (sym) => (sym === c.longs[0][0] ? null : exit(sym))).nScored === sc.nScored - 1);
}

console.log('\n== the replayed evidence: a planted reversal is found, none is not invented ==');
{
  const run = (reversal) => {
    const m = market({ reversal });
    const rows = [];
    for (let d = 41; d < DAYS - 2; d++) {
      const f = addDays(start, d);
      const c = formCohort(m, rotationUniverse(m, f), f, 2);
      const s = scoreCohort(c, (sym) => m[sym].close.get(c.maturesOn));
      rows.push({ formed_on: f, net_spread: s.netSpread + ROT.costSpread, laggards_excess: s.laggardsExcess });
    }
    return rotationRecord(rows, 2);
  };
  const planted = run(0.6), none = run(0);
  check('coins that give back 60% of yesterday\'s move against the market: the gross spread is positive and significant', planted.netPerCohort > 0 && planted.t > 3, JSON.stringify(planted));
  check('no reversal: no significant spread', Math.abs(none.t) < 3, JSON.stringify(none));
}

console.log('\n== the record and the alert ==');
{
  check('Newey-West t of a constant-sign series is large; of noise, small',
    neweyWestT(Array.from({ length: 200 }, () => 0.01 + 0.001 * (rand() - 0.5)), 1) > 20 && Math.abs(neweyWestT(Array.from({ length: 400 }, () => rand() - 0.5), 1)) < 4);
  const days = (n, v) => Array.from({ length: n }, (_, i) => ({ formed_on: addDays('2027-01-01', i), net_spread: v + 0.002 * (rand() - 0.5), laggards_excess: 0 }));
  const young = rotationRecord(days(100, 0.004), 2);
  check('not enough history: never "paying", however good', rotationAlertState(young, 'not') === 'not' && young.periods === 50);
  const good = rotationRecord(days(140, 0.004), 2);
  check('4+ months clearing its costs at t >= 2: paying', rotationAlertState(good, 'not') === 'paying', JSON.stringify(good));
  const soft = rotationRecord(days(140, 0.0004), 2);
  check('once paying, it stays paying until t falls under 1', rotationAlertState({ ...soft, t: 1.5 }, 'paying') === 'paying' && rotationAlertState({ ...soft, t: 0.5 }, 'paying') === 'not');
  const long = rotationRecord(days(300, 0.02), 40);
  check('the 40-day horizon needs a year (9 non-overlapping rounds)', long.periods === 7 && rotationAlertState(long, 'not') === 'not');
  const a = rotationAlert(good);
  check('the alert says paper, the costs, the history, and not advice; no em dashes',
    /On paper only/.test(a.message) && /after 0\.2% costs/.test(a.message) && /only saw coins still listed today/.test(a.message) && /Not financial advice/.test(a.message) && !/—/.test(a.title + a.message), a.message);
}

console.log('\n== the live loop, with no network ==');
{
  // hourly bars for 120 coins over 44 days, as the live scan fetches them
  const coins = {};
  const t0 = Date.UTC(2026, 7, 1);
  const hours = 44 * 24;
  for (let c = 0; c < 120; c++) {
    let p = 1 + c;
    coins[`K${c}`] = Array.from({ length: hours }, (_, i) => ({ openTime: new Date(t0 + i * H).toISOString(), close: (p *= Math.exp(0.004 * (rand() - 0.5))), quoteVolume: 1e5 * (1 + c) }));
  }
  const nowMs = t0 + hours * H + 5 * 60000;                 // 00:05 UTC after the last full day
  const db = { cohorts: new Map(), runs: [], alerts: new Map() };
  const query = async (env, text, p = []) => {
    const q = text.replace(/\s+/g, ' ');
    if (q.startsWith('SELECT 1 FROM coin_rotation_cohorts')) return db.cohorts.has(`${p[1]}|${p[2]}`) ? [{ 1: 1 }] : [];
    if (q.startsWith('INSERT INTO coin_rotation_cohorts')) { db.cohorts.set(`${p[1]}|${p[2]}`, { horizon_days: p[1], formed_on: p[2], matures_on: p[3], universe_n: p[4], longs_json: p[5], shorts_json: p[6], scored_at: null }); return []; }
    if (q.startsWith('SELECT horizon_days, formed_on, matures_on')) return [...db.cohorts.values()].filter((r) => !r.scored_at && r.matures_on <= p[1]);
    if (q.startsWith('UPDATE coin_rotation_cohorts')) { const r = db.cohorts.get(`${p[9]}|${p[10]}`); Object.assign(r, { net_spread: p[3], laggards_excess: p[5], scored_at: p[7] }); return []; }
    if (q.startsWith('SELECT formed_on, net_spread')) return [...db.cohorts.values()].filter((r) => r.scored_at && r.horizon_days === p[1]).sort((a, b) => a.formed_on.localeCompare(b.formed_on));
    if (q.startsWith('SELECT state FROM coin_rotation_alerts')) return db.alerts.has(p[1]) ? [{ state: db.alerts.get(p[1]) }] : [];
    if (q.startsWith('INSERT INTO coin_rotation_alerts')) { db.alerts.set(p[1], p[2]); return []; }
    if (q.startsWith('INSERT INTO coin_rotation_runs')) { db.runs.push(p[0]); return []; }
    if (q.startsWith('SELECT run_at FROM coin_rotation_runs')) return db.runs.length ? [{ run_at: db.runs[db.runs.length - 1] }] : [];
    if (q.startsWith('SELECT formed_on, matures_on, universe_n')) return [...db.cohorts.values()].filter((r) => r.horizon_days === p[1]).sort((a, b) => b.formed_on.localeCompare(a.formed_on)).slice(0, 1);
    if (q.startsWith('SELECT COUNT(*) AS n FROM coin_rotation_cohorts')) return [{ n: [...db.cohorts.values()].filter((r) => r.horizon_days === p[1] && !r.scored_at).length }];
    if (q.startsWith('SELECT state, changed_at')) return [];
    throw new Error('unexpected query: ' + q.slice(0, 80));
  };
  const r1 = await runCoinRotation({ env: {}, nowMs, barsBySymbol: coins, query, log: () => {} });
  check('forms both horizons for the latest complete day, over 100 coins', r1.formed === 2 && r1.universe === 100 && db.cohorts.size === 2, JSON.stringify(r1));
  const r2 = await runCoinRotation({ env: {}, nowMs: nowMs + H, barsBySymbol: coins, query, log: () => {} });
  check('an hour later: nothing new to form (one round per day per horizon)', r2.formed === 0 && db.cohorts.size === 2);
  // two days on: the 2-day round from then matures and is scored from the bars
  const later = {};
  for (const [s, bars] of Object.entries(coins)) {
    let p = bars[bars.length - 1].close;
    later[s] = bars.concat(Array.from({ length: 48 }, (_, i) => ({ openTime: new Date(t0 + (hours + i) * H).toISOString(), close: (p *= Math.exp(0.004 * (rand() - 0.5))), quoteVolume: 1e5 })));
  }
  const r3 = await runCoinRotation({ env: {}, nowMs: nowMs + 2 * DAY, barsBySymbol: later, query, log: () => {} });
  const two = [...db.cohorts.values()].filter((r) => r.horizon_days === 2);
  check('two days on: the first 2-day round is scored, and the missed day between is caught up', r3.scored >= 1 && two.some((r) => r.scored_at) && r3.formed === 2, JSON.stringify(r3));
  check('a heartbeat every run', db.runs.length === 3);
  check('a dry run writes nothing', (await (async () => {
    const writes = [];
    await runCoinRotation({ env: {}, nowMs: nowMs + 3 * DAY, barsBySymbol: later, dryRun: true, log: () => {},
      query: async (env, text) => { if (/^\s*(INSERT|UPDATE)/.test(text)) writes.push(text); return []; } });
    return writes.length === 0;
  })()));
  const loaded = await loadCoinRotation({}, nowMs + 2 * DAY, query);
  const h2 = loaded.horizons[2];
  check('the payload: live, each horizon\'s record, the latest round\'s top laggards and leaders, and the replay evidence',
    loaded.status === 'live' && h2.record.cohorts >= 1 && h2.current.laggards.length === 5 && h2.current.leaders.length === 5
    && loaded.horizons[40].record.cohorts === 0 && loaded.evidence === ROT_EVIDENCE, JSON.stringify(loaded).slice(0, 400));
  // the push fires once when a horizon starts clearing its costs
  const pushes = [];
  const alertQuery = async (env, text, p = []) => {
    const q = text.replace(/\s+/g, ' ');
    if (q.startsWith('SELECT formed_on, net_spread')) return Array.from({ length: 140 }, (_, i) => ({ formed_on: addDays('2027-01-01', i), net_spread: 0.004 + 0.002 * (rand() - 0.5), laggards_excess: 0 }));
    return query(env, text, p);
  };
  await runCoinRotation({ env: {}, nowMs: nowMs + 3 * DAY, barsBySymbol: later, query: alertQuery, log: () => {}, notify: async (x) => { pushes.push(x.title); return true; } });
  await runCoinRotation({ env: {}, nowMs: nowMs + 3 * DAY + H, barsBySymbol: later, query: alertQuery, log: () => {}, notify: async (x) => { pushes.push(x.title); return true; } });
  check('a horizon that starts clearing its costs pushes once, not every run (and only the 2-day one: the 40-day needs a year)',
    pushes.length === 1 && /\(2-day\) is clearing its costs on paper/.test(pushes[0]), JSON.stringify(pushes));
  check('nothing at all happens before the first run', (await loadCoinRotation({}, nowMs, async () => [])).status === 'awaiting-first-run');
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nCOIN ROTATION OK');
process.exit(failures ? 1 : 0);
