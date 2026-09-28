// scripts/decoupling-watch.mjs and its I/O: hours are UTC buckets that a
// daylight-saving change cannot touch, the rule reads only closed hours at or
// before the one judged, a market-wide volume rush is not a coin's own, setups
// are scored on the next 24 hours against the same-window base rate, only the
// side that held in both study years is pushed, and the push is gated on that
// side's live record.
// Run: node test-decoupling-watch.mjs
const m = await import('./scripts/decoupling-watch.mjs');
const io = await import('./scripts/decoupling-watch-io.mjs');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name} ${detail}`); }
};
const HOUR = 3600000;

console.log('\n== UTC hours: a daylight-saving change can neither skip nor repeat one ==');
for (const [label, iso] of [['US clocks forward', '2026-03-08T00:00:00Z'], ['US clocks back', '2026-11-01T00:00:00Z'],
  ['EU clocks forward', '2026-03-29T00:00:00Z'], ['EU clocks back', '2026-10-25T00:00:00Z']]) {
  const start = Date.parse(iso);
  const buckets = Array.from({ length: 24 * 60 }, (_, k) => m.hourStart(start + k * 60000 + 17));
  const distinct = [...new Set(buckets)];
  check(`${label} (${iso.slice(0, 10)}): 24 distinct, consecutive hour buckets`,
    distinct.length === 24 && distinct.every((b, k) => b === start + k * HOUR), JSON.stringify(distinct.slice(0, 4)));
}

// ---- synthetic market: a common factor, per-coin noise, steady volume
let seed = 11;
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return (seed + 0.5) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());
const COINS = ['BTC', 'ETH', 'XRP', 'SOL', 'ADA', 'HBAR', 'XLM', 'LINK', 'DOGE', 'AVAX'];
function market(hours, t0, plants = {}) {
  const common = Array.from({ length: hours }, () => 0.004 * gauss());
  const out = {};
  for (const s of COINS) {
    const bars = []; let px = 100;
    for (let i = 0; i < hours; i++) {
      const p = plants[s] && plants[s][i];
      px *= Math.exp(0.9 * common[i] + 0.003 * gauss() + (p ? p.ret : 0));
      bars.push({ openTime: new Date(t0 + i * HOUR).toISOString(), close: px, quoteVolume: 1e6 * (0.8 + 0.4 * rand()) * (p ? p.vol : 1) });
    }
    out[s] = bars;
  }
  return out;
}
const T0 = Date.parse('2026-06-01T00:00:00Z');
const N = 1700;
const plantRun = (from, to, ret, vol) => Object.fromEntries(Array.from({ length: to - from + 1 }, (_, k) => [from + k, { ret, vol }]));
// One hour on 20x volume carrying a 4% move net of the market: the 8-hour
// volume first clears 3x at the last closed hour, N-1, so the rule cannot
// have held any earlier.
const plantSetup = (ret) => ({ [N - 1]: { ret, vol: 20 } });
const bars = market(N, T0, {
  HBAR: plantSetup(0.04),                           // pulling ahead of the market on heavy volume
  SOL: plantSetup(-0.04),                           // the mirror
  XLM: plantRun(N - 8, N - 1, 0, 6),                // volume without a move
  LINK: plantRun(N - 8, N - 1, 0.006, 1)            // a move without volume
});
const nowMs = T0 + N * HOUR + 60000;                // one minute into the next hour: every planted hour is closed

console.log('\n== the panel ==');
{
  const withOpen = { ...bars, BTC: [...bars.BTC, { openTime: new Date(T0 + N * HOUR).toISOString(), close: 1, quoteVolume: 1 }] };
  const p = m.hourlyPanel(withOpen, { universe: COINS, nowMs });
  check('an hour still open is not a bar yet', p.n === N && p.close.BTC[N - 1] === bars.BTC[N - 1].close, String(p.n));
  const q = m.withMarket(p);
  const i = 500, others = COINS.filter((s) => s !== 'ETH').map((s) => q.r[s][i]);
  check('the market is the equal-weight return of the OTHER coins', Math.abs(q.mkt.ETH[i] - others.reduce((a, b) => a + b, 0) / others.length) < 1e-15);
  const c = new Map();
  const dayStart = m.dayBeta(q, 'ETH', 24 * 40, c), dayEnd = m.dayBeta(q, 'ETH', 24 * 40 + 23, c);
  check('beta is fixed for a whole UTC day (fitted on the 30 days before its midnight)', dayStart === dayEnd && dayStart > 0.5 && dayStart < 1.4, `${dayStart} ${dayEnd}`);
  check('no beta before 30 days of history exist', Number.isNaN(m.dayBeta(q, 'ETH', 700, c)));
}

console.log('\n== the rule ==');
const { setups, evaluated } = m.decouplingSetups(bars, { universe: COINS, nowMs });
const bySym = Object.fromEntries(setups.map((s) => [s.symbol, s]));
check('every coin with enough history is evaluated', evaluated === COINS.length, String(evaluated));
check('a coin pulling away from the market on 5x volume is a setup, side +1', bySym.HBAR && bySym.HBAR.side === 1 && bySym.HBAR.volumeRatio >= 3 && bySym.HBAR.excessZ >= 2,
  JSON.stringify(bySym.HBAR));
check('the mirror, falling away from the market, is side -1', bySym.SOL && bySym.SOL.side === -1 && bySym.SOL.excessZ <= -2, JSON.stringify(bySym.SOL));
check('volume without a move is not a setup', !bySym.XLM);
check('a move without volume is not a setup', !bySym.LINK);
check('ordinary coins stay quiet', setups.length === 2, setups.map((s) => s.symbol).join(','));
check('the setup is read at the last closed hour', bySym.HBAR && bySym.HBAR.at === new Date(T0 + (N - 1) * HOUR).toISOString());
check('its volume is measured against the median coin too', bySym.HBAR && bySym.HBAR.marketVolumeRatio > 0.8 && bySym.HBAR.marketVolumeRatio < 1.25
  && Math.abs(bySym.HBAR.relVolume - bySym.HBAR.volumeRatio / bySym.HBAR.marketVolumeRatio) < 1e-12, JSON.stringify(bySym.HBAR));
{
  // The same HBAR move, but on an hour when most of the market is also on 5x
  // volume: the surge is not its own, and in the study such setups did no
  // better than any coin in those hours.
  const rush = market(N, T0, {
    HBAR: plantRun(N - 8, N - 1, 0.006, 5),
    ...Object.fromEntries(['BTC', 'ETH', 'XRP', 'SOL', 'ADA', 'XLM', 'DOGE'].map((c) => [c, plantRun(N - 8, N - 1, 0, 5)]))
  });
  const r = m.decouplingSetups(rush, { universe: COINS, nowMs });
  const st = m.coinState(m.withMarket(m.hourlyPanel(rush, { universe: COINS, nowMs })), 'HBAR', N - 1);
  check('a market-wide volume rush is not a setup, however far the coin moves', !r.setups.some((x) => x.symbol === 'HBAR')
    && st && st.volumeRatio >= 3 && st.excessZ >= 2 && st.relVolume < 2, JSON.stringify(st && { v: st.volumeRatio, rel: st.relVolume, z: st.excessZ }));
  const edge = { ...st, relVolume: 2 };
  check('twice the median coin is enough (the threshold is inclusive)', m.setupSide(edge) === 1 && m.setupSide({ ...st, relVolume: 1.99 }) === 0);
}

console.log('\n== the cooldown chain: first hour only, never late ==');
{
  const at = (i) => new Date(T0 + i * HOUR).toISOString();
  const first = m.decouplingChain(bars, { universe: COINS, nowMs });
  check('a setup that begins at the last closed hour is taken there', first.taken.some((x) => x.symbol === 'HBAR' && x.index === N - 1 && x.at === at(N - 1)),
    JSON.stringify(first.taken.map((x) => [x.symbol, x.index])));
  // Mid-move at start-up: HBAR has met the rule for hours already. Its first
  // hour is inside the replay window, so the current hour is cooldown, not news.
  const mid = market(N, T0, { HBAR: plantRun(N - 16, N - 1, 0.006, 5) });
  const mc = m.decouplingChain(mid, { universe: COINS, nowMs });
  const hb = mc.taken.filter((x) => x.symbol === 'HBAR');
  check('a coin already mid-move when the watch starts is taken at its first hour, so nothing is announced late',
    hb.length === 1 && hb[0].index < N - 1 - 2 && m.setupSide(m.coinState(mc.panel, 'HBAR', N - 1)) === 1, JSON.stringify(hb.map((x) => x.index)));
  // A streak longer than the cooldown is taken again once 24 hours have passed, as the study took it.
  const long = market(N, T0, { HBAR: plantRun(N - 44, N - 1, 0.006, 5) });
  const lc = m.decouplingChain(long, { universe: COINS, nowMs }).taken.filter((x) => x.symbol === 'HBAR').map((x) => x.index);
  check('a streak longer than a day is taken again 24 hours after its first hour', lc.length === 2 && lc[1] - lc[0] === 24, JSON.stringify(lc));
  // Seeded with the last logged setup, the live chain continues the logged one.
  const seeded = m.decouplingChain(long, { universe: COINS, nowMs, lastCastMs: { HBAR: Date.parse(at(lc[0] + 3)) } }).taken.filter((x) => x.symbol === 'HBAR').map((x) => x.index);
  check('seeded with the last logged setup, the chain continues from it', seeded.length === 1 && seeded[0] === lc[0] + 27, JSON.stringify(seeded));
}

console.log('\n== no look-ahead ==');
{
  const later = market(N + 60, T0, { HBAR: { ...plantRun(N - 8, N - 1, 0.006, 5), ...plantRun(N, N + 59, -0.02, 20) } });
  // same seed stream is not guaranteed across calls, so compare the state at one hour on truncated vs extended copies
  const cut = Object.fromEntries(Object.entries(later).map(([s, b]) => [s, b.slice(0, N)]));
  const pa = m.withMarket(m.hourlyPanel(cut, { universe: COINS, nowMs: T0 + (N + 200) * HOUR }));
  const pb = m.withMarket(m.hourlyPanel(later, { universe: COINS, nowMs: T0 + (N + 200) * HOUR }));
  const a = m.coinState(pa, 'HBAR', N - 1), b = m.coinState(pb, 'HBAR', N - 1);
  check('adding 60 later hours (a crash) changes nothing about the setup at hour N-1',
    a && b && a.volumeRatio === b.volumeRatio && a.excessZ === b.excessZ && a.threshold === b.threshold, JSON.stringify({ a, b }));
}

console.log('\n== scoring on the next 24 hours ==');
{
  const cast = N - 1;
  const after = market(N + 30, T0, { HBAR: { ...plantRun(N - 8, N - 1, 0.006, 5), ...plantRun(N, N + 23, 0.004, 3) } });
  const castAt = new Date(T0 + cast * HOUR).toISOString();
  check('not scored until its 24 hours have closed', m.scoreDecoupling(after, 'HBAR', castAt, { universe: COINS, nowMs: T0 + (N + 20) * HOUR }) === null);
  const r = m.scoreDecoupling(after, 'HBAR', castAt, { universe: COINS, nowMs: T0 + (N + 30) * HOUR });
  check('a further +10% away from the market within the day is a big move, up', r && r.big === 1 && r.up === 1 && r.excessPct > 5, JSON.stringify(r));
  check('scored against the same 24 hours of every coin (the base rate)', r && r.marketN === COINS.length && r.baseRate > 0 && r.baseRate <= 0.2, JSON.stringify(r));
}

console.log('\n== the push gate ==');
{
  check('notifies from the start: it held in both years at discovery', m.decouplingNotifyGate([]).allowed);
  const day = (k) => `2026-10-${String(1 + (k % 20)).padStart(2, '0')}T0${k % 9}:00:00.000Z`;
  const bad = Array.from({ length: 40 }, (_, k) => ({ cast_at: day(k), big: 0, base_rate: 0.03 + 0.01 * (k % 3) }));
  const g = m.decouplingNotifyGate(bad);
  check('goes silent once its live record trails the same-window base rate (t <= -2, >= 30 setups, >= 10 days)', !g.allowed && g.record.scored === 40, JSON.stringify(g));
  check('but not on too little evidence', m.decouplingNotifyGate(bad.slice(0, 20)).allowed);
}

console.log('\n== the alert ==');
{
  const a = m.decouplingAlert(bySym.HBAR, { oiChangePct: 10.3 });
  check('says which way the coin is pulling, against what, and as of which hour', a.title === 'HBAR pulling away from the market'
    && new RegExp(`against the market in the 8 hours to ${new Date(T0 + N * HOUR).toISOString().slice(11, 16)} UTC`).test(a.message), a.message.slice(0, 160));
  check('quotes its own measured rates against the same hours and says direction is not predictable',
    /18-20% of setups like this/.test(a.message) && /against 4-6% of all the large coins over the same hours/.test(a.message)
    && /not predictable/.test(a.message) && /not a buy or sell signal/.test(a.message), a.message);
  check('says how its volume compares with the typical coin', /x the typical large coin's/.test(a.message));
  check('carries open interest when the sampler watches the coin', /Open interest: \+10\.3% in contracts/.test(a.message));
  const b = m.decouplingAlert(bySym.SOL);
  check('the falling side quotes its own, weaker rates', b.title === 'SOL falling away from the market' && /8-10% of setups/.test(b.message) && /against 3-4%/.test(b.message), b.message);
  check('only the side that held in both years may push', m.DW_EVIDENCE.ahead.push === true && m.DW_EVIDENCE.behind.push === false
    && m.DW_EVIDENCE.ahead.t.every((t) => t >= 2) && !m.DW_EVIDENCE.behind.t.every((t) => t >= 2));
  check('no em dashes in anything a person reads', !/—/.test(a.title + a.message + b.title + b.message));
}

console.log('\n== the I/O loop, with no network ==');
{
  // serve the synthetic bars as Binance kline pages, newest page first
  const pages = (sym) => bars[sym].map((b) => [Date.parse(b.openTime), '0', '0', '0', String(b.close), '0', 0, String(b.quoteVolume), 1]);
  const fetchJson = async (url) => {
    const sym = decodeURIComponent(url.match(/symbol=([^&]+)/)[1]).replace(/USDT$/, '');
    const all = pages(sym); const end = url.match(/endTime=(\d+)/);
    const upto = end ? all.filter((r) => r[0] <= Number(end[1])) : all;
    return upto.slice(-1000);
  };
  const deep = await io.fetchDeepBars('HBAR', { fetchJson });
  check('history pages back past 1000 bars to the full request', deep.length === N && deep[0].openTime === bars.HBAR[0].openTime, String(deep.length));
  const sql = [];
  const query = async (env, text, params = []) => {
    sql.push({ text: text.replace(/\s+/g, ' ').trim(), params });
    if (/MAX\(cast_at\) AS last_cast/.test(text)) return [{ symbol: 'SOL', last_cast: new Date(T0 + (N - 3) * HOUR).toISOString() }];   // SOL fired within the day
    return [];
  };
  const pushed = [];
  const run = await io.runDecouplingWatch({ env: {}, nowMs, tradable: new Set(COINS), query, fetchJson, log: () => {},
    notify: async (x) => { pushed.push(x.title); return true; } });
  const inserts = sql.filter((q) => q.text.startsWith('INSERT INTO decoupling_watch ('));
  check('logs the new setup before its outcome exists', inserts.length === 1 && inserts[0].params[1] === 'HBAR', JSON.stringify(inserts.map((q) => q.params[1])));
  check('a coin that already fired today is not logged or pushed again', !inserts.some((q) => q.params[1] === 'SOL') && !pushed.includes('SOL falling away from the market'));
  check('pushes and marks it notified', pushed.length === 1 && sql.some((q) => /SET notified = 1/.test(q.text)), JSON.stringify(pushed));
  check('writes a heartbeat row even so', sql.some((q) => q.text.startsWith('INSERT INTO decoupling_watch_runs')));
  check('stores the volume against the median coin with the setup', inserts.length === 1 && inserts[0].params[6] === bySym.HBAR.relVolume, JSON.stringify(inserts[0]?.params));
  check('the gate reads only the pushed side\'s live record', sql.some((q) => /scored_at IS NOT NULL AND side IN \(1\)/.test(q.text)));
  const sql2 = [], pushed2 = [];
  await io.runDecouplingWatch({ env: {}, nowMs, tradable: new Set(COINS), fetchJson, log: () => {},
    query: async (env, text, params = []) => { sql2.push({ text: text.replace(/\s+/g, ' ').trim(), params }); return []; },
    notify: async (x) => { pushed2.push(x.title); return true; } });
  const logged2 = sql2.filter((q) => q.text.startsWith('INSERT INTO decoupling_watch (')).map((q) => q.params[1]).sort();
  check('a coin falling behind is logged and scored but never pushed', logged2.join(',') === 'HBAR,SOL'
    && pushed2.length === 1 && pushed2[0] === 'HBAR pulling away from the market', JSON.stringify({ logged2, pushed2 }));
  check('only the hours of this universe are fetched', run.evaluated === COINS.length);
  // A skipped run: the setup's hour closed two runs ago. It is caught up, logged
  // with its own hour, and pushed. A coin mid-move at start-up is not pushed.
  {
    const skippedNow = nowMs + 2 * HOUR;
    const later = market(N + 2, T0, { HBAR: plantSetup(0.04), ALGO: {} });
    const pagesL = (sym) => (later[sym] || []).map((b) => [Date.parse(b.openTime), '0', '0', '0', String(b.close), '0', 0, String(b.quoteVolume), 1]);
    const fetchL = async (url) => {
      const sym = decodeURIComponent(url.match(/symbol=([^&]+)/)[1]).replace(/USDT$/, '');
      const all = pagesL(sym); const end = url.match(/endTime=(\d+)/);
      return (end ? all.filter((r) => r[0] <= Number(end[1])) : all).slice(-1000);
    };
    const sqlS = [], pushedS = [];
    await io.runDecouplingWatch({ env: {}, nowMs: skippedNow, tradable: new Set(COINS), fetchJson: fetchL, log: () => {},
      query: async (env, text, params = []) => { sqlS.push({ text: text.replace(/\s+/g, ' ').trim(), params }); return []; },
      notify: async (x) => { pushedS.push(x.title); return true; } });
    const ins = sqlS.filter((q) => q.text.startsWith('INSERT INTO decoupling_watch (')).find((q) => q.params[1] === 'HBAR');
    check('a setup from up to two skipped runs ago is caught up, logged at its own hour and pushed',
      ins && ins.params[2] === new Date(T0 + (N - 1) * HOUR).toISOString() && pushedS.includes('HBAR pulling away from the market'), JSON.stringify({ ins: ins?.params?.slice(0, 3), pushedS }));
    const midBars = market(N, T0, { HBAR: plantRun(N - 16, N - 1, 0.006, 5) });
    const pagesM = (sym) => midBars[sym].map((b) => [Date.parse(b.openTime), '0', '0', '0', String(b.close), '0', 0, String(b.quoteVolume), 1]);
    const fetchM = async (url) => {
      const sym = decodeURIComponent(url.match(/symbol=([^&]+)/)[1]).replace(/USDT$/, '');
      const all = pagesM(sym); const end = url.match(/endTime=(\d+)/);
      return (end ? all.filter((r) => r[0] <= Number(end[1])) : all).slice(-1000);
    };
    const pushedM = [];
    const r = await io.runDecouplingWatch({ env: {}, nowMs, tradable: new Set(COINS), fetchJson: fetchM, log: () => {},
      query: async () => [], notify: async (x) => { pushedM.push(x.title); return true; } });
    check('the first run does not announce a coin already mid-move', pushedM.length === 0 && r.setups.length === 0, JSON.stringify(pushedM));
  }
  const dry = [];
  await io.runDecouplingWatch({ env: {}, nowMs, tradable: new Set(COINS), dryRun: true, fetchJson, log: () => {},
    query: async (env, text) => { dry.push(text); return []; }, notify: async () => false });
  check('a dry run writes nothing', !dry.some((t) => /^\s*(INSERT|UPDATE)/.test(t)));
  const scoredRows = [
    ...Array.from({ length: 6 }, (_, k) => ({ cast_at: `2026-08-0${k + 1}T03:00:00.000Z`, side: 1, big: k < 2 ? 1 : 0, base_rate: 0.05 })),
    ...Array.from({ length: 4 }, (_, k) => ({ cast_at: `2026-08-0${k + 1}T05:00:00.000Z`, side: -1, big: 0, base_rate: 0.04 }))
  ];
  const loaded = await io.loadDecouplingWatch({}, nowMs, async (env, text) => {
    if (/FROM decoupling_watch_runs/.test(text)) return [{ run_at: new Date(nowMs - 30 * 60000).toISOString(), evaluated: 37 }];
    if (/scored_at IS NOT NULL/.test(text)) return scoredRows;
    return [{ symbol: 'HBAR', cast_at: '2026-08-11T03:00:00.000Z', side: 1, volume_ratio: 5, rel_volume: 4.2, excess_z: 3 }];
  });
  check('the payload says live, with recent setups, each side\'s live record and the evidence it quotes',
    loaded.status === 'live' && loaded.recent.length === 1 && loaded.notifying === true && loaded.universe === 40
    && loaded.live.ahead.scored === 6 && Math.abs(loaded.live.ahead.hitRate - 2 / 6) < 1e-12 && loaded.live.behind.scored === 4
    && loaded.evidence.ahead.hitRate[1] === 0.199, JSON.stringify(loaded));
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nDECOUPLING WATCH OK');
process.exit(failures ? 1 : 0);
