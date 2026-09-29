// Identity and precision audit of the daily crypto archive (asset_daily_bars).
//
// Found 2026-09-28 (docs/CADENCE.md, section 8). A ticker is not a token:
//
//   another token   Yahoo's SKY-USD is Skycoin, so "SKY" (Sky, ex-Maker) held
//                   Skycoin's prices from 2017 until Binance took over on
//                   2026-09-23. JUP before 2024-01-31 is Jupiter Project, not
//                   Jupiter.
//   rounding        Yahoo kept SHIB at six decimals before Binance listed it:
//                   1e-6 -> 2e-6 is a +69% "day" that never happened.
//   two tokens      one ticker alternating between two price levels.
//
// bar-quarantine.mjs looks for 4x spikes and 10x level shifts, and all three
// of these sit well inside those bars, so they passed as history.
//
// The reference is Binance's own daily candle for the same pair, where the
// coin trades there: one token per pair, full precision, a true UTC close.
// But a Binance ticker is not proof of identity either (Binance's ONE is
// Harmony; the universe's ONE is Cross), so Binance is the reference only when
// its latest close matches CoinGecko's current price for the universe's coin
// (the id the engine means) within 1.5x. Then, for that coin:
//
//   - every archived close that disagrees with Binance's close for the same
//     day by more than 10% is replaced by Binance's bar, after the old row is
//     copied to asset_daily_bars_backup;
//   - history from before Binance listed the coin is kept only if it was the
//     same token (the archive agreed with Binance through its first month
//     there) and is not rounded; otherwise a level-shift marker at the listing
//     tells every consumer (cleanBars) to start there.
//
// Coins Binance does not list, or lists as a different token, are left alone,
// with two exceptions:
//   - a coin whose latest archived close is 2x or more off the universe's
//     price (Yahoo's BEAM-USD is the old privacy coin, not Merit Circle's
//     Beam) is checked against CoinGecko's last year for the universe's id.
//     If the archive disagrees there too, the year is replaced by CoinGecko's
//     closes and everything before it is marked unusable;
//   - a close of zero is not a price (Yahoo rounds BABYDOGE and BTT away
//     entirely): every such row is quarantined as a spike.
//
// Dry run by default: prints a summary and writes a JSON report (--out).
// --apply writes. Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID.
import { writeFileSync } from 'node:fs';
import { d1, d1Batch, chunk } from './d1-client.mjs';
import { binanceDailyBars, coingeckoDailyBars, isQuantizedSeries, replaceBarsFromSource } from './archive.mjs';
import { detectBadBars } from './bar-quarantine.mjs';

export const AUDIT_VERSION = 'identity-audit-v1';
export const AUDIT = Object.freeze({
  rowGap: Math.log(1.1),        // a close more than 10% off Binance's for the same day is wrong
  identityMatch: Math.log(1.5), // Binance's latest close vs the universe's price: the coin the engine means
  identityOff: Math.log(2),     // ... this far off: Binance lists another token under the ticker
  sameTokenGap: 0.03,           // no universe price: the latest overlap must agree this closely instead
  recentDays: 90,               // ... measured over this many of the latest shared days
  minOverlap: 20,               // fewer shared days than this: unverifiable
  earlyDays: 30,                // the first month of Binance coverage decides the pre-listing history
  earlyMinRows: 5,              // ... if the archive has at least this many of its own rows in it
  earlyMismatchShare: 0.5,      // more than half of them wrong: the history before was another token
  joinGap: Math.log(3)          // otherwise: last archived close before the listing vs Binance's first
});

const dayShift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const logGap = (a, b) => Math.abs(Math.log(a / b));

export function quantizedAnywhere(closes, window = 60) {
  // A stretch too short for isQuantizedSeries (under 30 closes) still shows
  // rounding when most of its closes repeat a handful of values.
  if (closes.length >= 10 && closes.length < 30) {
    const flat = closes.slice(1).filter((c, i) => c === closes[i]).length / (closes.length - 1);
    return new Set(closes).size / closes.length < 0.5 || flat > 0.3;
  }
  for (let i = 0; i + window <= Math.max(closes.length, window); i += Math.max(1, Math.floor(window / 2))) {
    if (isQuantizedSeries(closes.slice(i, i + window), { window })) return true;
  }
  return false;
}

// The audit of one coin, pure. rows: the archive's rows for the coin, date
// ascending ({ date, open, close, high, low, volume, source }); binance: its
// Binance daily bars, date ascending ({ date, open, high, low, close, volume }).
export function auditCoin(rows, binance, { refPrice = null } = {}) {
  const base = { rows: rows.length };
  const lastArchive = [...rows].reverse().find((r) => r.close > 0);
  const archiveGap = refPrice > 0 && lastArchive ? logGap(lastArchive.close, refPrice) : null;
  if (!binance || !binance.length) {
    return { ...base, verdict: 'no-binance', archiveGap, archiveSuspect: archiveGap != null && archiveGap > AUDIT.identityOff };
  }
  // Is Binance's pair the coin the engine means?
  const binanceGap = refPrice > 0 ? logGap(binance[binance.length - 1].close, refPrice) : null;
  if (binanceGap != null && binanceGap > AUDIT.identityOff) return { ...base, verdict: 'different-token', binanceGap, archiveGap };
  if (binanceGap != null && binanceGap > AUDIT.identityMatch) return { ...base, verdict: 'unverifiable', binanceGap, archiveGap };
  // A redenomination on Binance's side (SUN swapped 1,000 to 1 in 2021) is a
  // level shift in Binance's own series: compare only after its last one.
  const shifts = detectBadBars(binance).filter((x) => x.reason === 'level-shift').map((x) => x.date);
  const from = shifts.length ? shifts[shifts.length - 1] : binance[0].date;
  const ref = binance.filter((b) => b.date >= from);
  const byDate = new Map(ref.map((b) => [b.date, b]));
  const firstBinance = ref[0].date;
  // Like with like: a CoinGecko row dated D holds D-1's close (archive.mjs).
  const refFor = (r) => byDate.get(r.source === 'coingecko' ? dayShift(r.date, -1) : r.date);
  const overlap = rows.map((r) => ({ r, b: refFor(r) })).filter((x) => x.b && x.r.close > 0);
  if (overlap.length < AUDIT.minOverlap) return { ...base, verdict: 'unverifiable', overlap: overlap.length, firstBinance, binanceGap };
  const recent = overlap.slice(-AUDIT.recentDays).map((x) => logGap(x.r.close, x.b.close)).sort((a, b) => a - b);
  const medianGap = recent[Math.floor(recent.length / 2)];
  // With a universe price, Binance matching it settles identity, and archive
  // rows that disagree are the wrong ones. Without one, the archive and
  // Binance must agree recently, or nothing is changed.
  if (binanceGap == null && medianGap > AUDIT.sameTokenGap) {
    return { ...base, verdict: 'unverifiable', overlap: overlap.length, medianGap, firstBinance };
  }
  // Rows that disagree with Binance on the same day. Replacement writes
  // Binance's bar for the row's own date (source binance, no day shift), as
  // coinGeckoReplacement does.
  const replace = overlap
    .filter((x) => x.r.source !== 'binance' && logGap(x.r.close, x.b.close) > AUDIT.rowGap)
    .map((x) => ({ date: x.r.date, source: x.r.source, oldClose: x.r.close, newBar: byDate.get(x.r.date) }))
    .filter((x) => x.newBar);
  // The history from before Binance's coverage
  const pre = rows.filter((r) => r.date < firstBinance && r.close > 0);
  let preVerdict = null;
  if (pre.length) {
    // Two ways the history before the listing shows it was another token: the
    // archive's own rows in Binance's first month mostly disagree with Binance
    // (it was still carrying the other token), or the series jumps 3x or more
    // at the listing (the supplier re-pointed the ticker then: WLD sat at
    // $0.008 until Worldcoin listed at $2.16). Listing days really do move
    // 1.5-2x, so smaller jumps do not count.
    const early = overlap.filter((x) => x.r.date < dayShift(firstBinance, AUDIT.earlyDays) && x.r.source !== 'binance');
    const earlyWrong = early.length ? early.filter((x) => logGap(x.r.close, x.b.close) > AUDIT.rowGap).length / early.length : 0;
    const join = logGap(pre[pre.length - 1].close, ref[0].close);
    const rounded = quantizedAnywhere(pre.map((r) => r.close));
    const why = [];
    if (early.length >= AUDIT.earlyMinRows && earlyWrong > AUDIT.earlyMismatchShare) {
      why.push(`${Math.round(earlyWrong * 100)}% of its first ${early.length} days on Binance disagreed: another token`);
    }
    if (join > AUDIT.joinGap) {
      why.push(`last close before the listing ${pre[pre.length - 1].close.toPrecision(4)} vs Binance's first ${ref[0].close.toPrecision(4)}`);
    }
    if (rounded) why.push('rounded to too few decimals');
    preVerdict = { rows: pre.length, first: pre[0].date, keep: why.length === 0, why };
  }
  return { ...base, verdict: 'verified', overlap: overlap.length, medianGap, binanceGap, archiveGap, firstBinance, redenominated: shifts.length > 0, replace, pre: preVerdict };
}

// Quarantine rows for a coin's audit: one level-shift marker at the start of
// Binance's coverage when the history before it cannot be kept.
export function quarantineFor(symbol, audit, detectedAt) {
  if (audit.verdict !== 'verified' || !audit.pre || audit.pre.keep) return [];
  return [['crypto', symbol, audit.firstBinance, 'level-shift',
    `identity audit: the ${audit.pre.rows} bars before Binance's coverage (${audit.pre.first} on) are unusable: ${audit.pre.why.join('; ')}`,
    AUDIT_VERSION, detectedAt]];
}

// A coin not on Binance whose archive looks like another token, checked
// against CoinGecko's daily history for the universe's id (a row dated D holds
// D-1's close, so an archive close for D is compared with CoinGecko's D+1).
export function coingeckoCheck(rows, gecko) {
  const byDate = new Map(gecko.map((b) => [b.date, b]));
  const pairs = rows.filter((r) => r.close > 0 && r.source !== 'coingecko')
    .map((r) => ({ r, g: byDate.get(dayShift(r.date, 1)) })).filter((x) => x.g && x.g.close > 0);
  if (pairs.length < AUDIT.minOverlap) return { verdict: 'unverifiable', overlap: pairs.length };
  const gaps = pairs.map((x) => logGap(x.r.close, x.g.close)).sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)];
  if (medianGap <= AUDIT.rowGap) return { verdict: 'agrees', overlap: pairs.length, medianGap };
  const first = gecko[0].date;
  return {
    verdict: 'another-token', overlap: pairs.length, medianGap, firstGecko: first,
    replace: rows.filter((r) => r.source === 'yahoo' && byDate.has(r.date)).map((r) => ({ date: r.date, source: 'yahoo', oldClose: r.close, newBar: byDate.get(r.date) })),
    preRows: rows.filter((r) => r.date < first).length
  };
}

async function main() {
  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID } = process.env;
  for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
    if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
  }
  const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID };
  const APPLY = process.argv.includes('--apply');
  const outArg = process.argv.find((a) => a.startsWith('--out='));
  const only = process.argv.filter((a) => a.startsWith('--symbol=')).map((a) => a.slice(9).toUpperCase());
  const { binanceGlobalTradablePairs, getCryptoMarkets } = await import('../worker.js');
  const tradable = new Set(await binanceGlobalTradablePairs());
  // The universe's coins and their current prices: the identity reference.
  const universe = new Map();
  for (const c of await getCryptoMarkets()) {
    const sym = String(c.symbol || '').toUpperCase();
    if (!universe.has(sym) && c.current_price > 0) universe.set(sym, { id: c.id, price: c.current_price });
  }
  const symbols = (await d1(env, "SELECT DISTINCT symbol FROM asset_daily_bars WHERE asset_class = 'crypto' ORDER BY symbol"))
    .map((r) => r.symbol).filter((s) => !only.length || only.includes(s));
  const now = new Date().toISOString();
  const run = `${AUDIT_VERSION}|${now}`;
  const report = { version: AUDIT_VERSION, at: now, coins: {} };
  const counts = { verified: 0, 'different-token': 0, unverifiable: 0, 'no-binance': 0, pegged: 0 };
  const suspects = [];
  let toReplace = 0; const quarantine = [];
  for (const s of symbols) {
    const rows = await d1(env, "SELECT date, open, close, high, low, volume, source FROM asset_daily_bars WHERE asset_class = 'crypto' AND symbol = ? ORDER BY date", [s]);
    const closes = rows.map((r) => r.close).filter((c) => c > 0);
    const moves = closes.slice(1).map((c, i) => Math.abs(Math.log(c / closes[i]))).sort((a, b) => a - b);
    if (moves.length > 30 && moves[Math.floor(moves.length / 2)] < 0.003) { counts.pegged++; continue; }   // a stablecoin has no history to fix
    let binance = [];
    if (tradable.has(s)) {
      try { binance = await binanceDailyBars(s, null); } catch (e) { binance = []; }
    }
    const a = auditCoin(rows, binance, { refPrice: universe.get(s)?.price ?? null });
    a.universeId = universe.get(s)?.id ?? null;
    counts[a.verdict]++;
    if (a.archiveSuspect) suspects.push(`${s} (archive ${rows[rows.length - 1].close.toPrecision(4)} vs ${a.universeId} ${universe.get(s).price.toPrecision(4)})`);
    toReplace += a.replace?.length || 0;
    quarantine.push(...quarantineFor(s, a, now));
    report.coins[s] = { ...a, replace: a.replace?.map((x) => ({ date: x.date, source: x.source, old: x.oldClose, binance: x.newBar.close })) };
    if ((a.replace?.length || 0) > 0 || (a.pre && !a.pre.keep)) {
      console.log(`${s.padEnd(10)} ${a.replace.length} rows off Binance by >10%` + (a.pre ? `; ${a.pre.rows} bars before the listing ${a.pre.keep ? 'kept' : 'unusable: ' + a.pre.why.join('; ')}` : ''));
    }
  }
  // Coins not on Binance that look like another token: CoinGecko's year for the universe's id
  const geckoPlans = [];
  for (const [s, a] of Object.entries(report.coins)) {
    if (a.verdict !== 'no-binance' || !a.archiveSuspect || !a.universeId) continue;
    try {
      const gecko = await coingeckoDailyBars(a.universeId, 365);
      const rows = await d1(env, "SELECT date, open, close, high, low, volume, source FROM asset_daily_bars WHERE asset_class = 'crypto' AND symbol = ? ORDER BY date", [s]);
      const c = coingeckoCheck(rows, gecko);
      a.coingecko = { verdict: c.verdict, overlap: c.overlap, medianGap: c.medianGap, replace: c.replace?.length || 0, preRows: c.preRows || 0 };
      console.log(`${s.padEnd(10)} vs CoinGecko ${a.universeId}: ${c.verdict}` + (c.verdict === 'another-token' ? ` (median gap ${Math.expm1(c.medianGap).toFixed(1)}x); ${c.replace.length} rows to replace, ${c.preRows} older bars unusable` : ''));
      if (c.verdict === 'another-token') {
        geckoPlans.push({ symbol: s, rows: c.replace });
        toReplace += c.replace.length;
        quarantine.push(['crypto', s, c.firstGecko, 'level-shift',
          `identity audit: the archive is another token than ${a.universeId} (CoinGecko disagrees by a median ${Math.expm1(c.medianGap).toFixed(1)}x over ${c.overlap} days); the ${c.preRows} bars before CoinGecko's year are unusable`,
          AUDIT_VERSION, now]);
      }
    } catch (e) { a.coingecko = { verdict: 'error', error: e.message }; }
  }
  // A close of zero is not a price.
  const zeros = await d1(env, "SELECT symbol, date FROM asset_daily_bars WHERE asset_class = 'crypto' AND close <= 0");
  for (const z of zeros) {
    quarantine.push(['crypto', z.symbol, z.date, 'spike', 'identity audit: close of zero, the supplier rounded the price away', AUDIT_VERSION, now]);
  }
  // one marker per (symbol, date): a level-shift outranks a zero-close spike
  const byKey = new Map();
  for (const q of quarantine) {
    const k = `${q[1]}|${q[2]}`;
    if (!byKey.has(k) || q[3] === 'level-shift') byKey.set(k, q);
  }
  quarantine.length = 0; quarantine.push(...byKey.values());
  report.summary = { ...counts, rowsToReplace: toReplace, quarantineMarkers: quarantine.length, zeroCloses: zeros.length, suspects };
  if (suspects.length) console.log(`\nnot on Binance, latest archived close 2x+ off the universe's coin (look at these): ${suspects.join(', ')}`);
  const diff = Object.entries(report.coins).filter(([, a]) => a.verdict === 'different-token').map(([s, a]) => `${s} (${a.universeId})`);
  if (diff.length) console.log(`Binance lists another token under the ticker, left alone: ${diff.join(', ')}`);
  console.log(`\n${symbols.length} coins: ${JSON.stringify(counts)}; ${toReplace} rows to replace; ${quarantine.filter((q) => q[3] === 'level-shift').length} coins whose early history is unusable; ${zeros.length} zero closes quarantined`);
  if (outArg) writeFileSync(outArg.slice(6), JSON.stringify(report, null, 1));
  if (!APPLY) { console.log('DRY RUN: nothing written. Re-run with --apply.'); return; }

  // 1. back up every row about to change, 2. replace, 3. mark unusable history
  for (const [s, a] of Object.entries(report.coins)) {
    const reps = (a.replace || []);
    if (!reps.length) continue;
    const old = await d1(env, `SELECT symbol, date, open, close, high, low, volume, source FROM asset_daily_bars
      WHERE asset_class = 'crypto' AND symbol = ? AND date IN (${reps.map(() => '?').join(',')})`, [s, ...reps.map((x) => x.date)]);
    for (const group of chunk(old, 10)) {
      await d1(env, `INSERT OR IGNORE INTO asset_daily_bars_backup (audit_run, symbol, date, open, close, high, low, volume, source)
        VALUES ${group.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')}`,
        group.flatMap((r) => [run, r.symbol, r.date, r.open, r.close, r.high, r.low, r.volume, r.source]));
    }
    const full = new Map((await binanceDailyBars(s, null)).map((b) => [b.date, b]));
    for (const src of ['yahoo', 'coingecko']) {
      const bars = reps.filter((x) => x.source === src).map((x) => full.get(x.date)).filter(Boolean)
        .map((b) => ({ symbol: s, assetClass: 'crypto', ...b, source: 'binance' }));
      if (bars.length) await replaceBarsFromSource(env, bars, src);
    }
  }
  for (const plan of geckoPlans) {
    if (!plan.rows.length) continue;
    const old = await d1(env, `SELECT symbol, date, open, close, high, low, volume, source FROM asset_daily_bars
      WHERE asset_class = 'crypto' AND symbol = ? AND date IN (${plan.rows.map(() => '?').join(',')})`, [plan.symbol, ...plan.rows.map((x) => x.date)]);
    for (const group of chunk(old, 10)) {
      await d1(env, `INSERT OR IGNORE INTO asset_daily_bars_backup (audit_run, symbol, date, open, close, high, low, volume, source)
        VALUES ${group.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')}`,
        group.flatMap((r) => [run, r.symbol, r.date, r.open, r.close, r.high, r.low, r.volume, r.source]));
    }
    await replaceBarsFromSource(env, plan.rows.map((x) => ({ symbol: plan.symbol, assetClass: 'crypto', ...x.newBar, source: 'coingecko' })), 'yahoo');
  }
  await d1(env, 'DELETE FROM asset_bar_quarantine WHERE detector_version = ?', [AUDIT_VERSION]);
  for (const group of chunk(quarantine, 14)) {
    await d1Batch(env, [{ sql: `INSERT OR REPLACE INTO asset_bar_quarantine (asset_class, symbol, date, reason, detail, detector_version, detected_at)
      VALUES ${group.map(() => '(?,?,?,?,?,?,?)').join(',')}`, params: group.flat() }]);
  }
  console.log(`applied: ${toReplace} rows replaced (old rows in asset_daily_bars_backup, audit_run ${run}); ${quarantine.length} level-shift markers`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => { console.error('crypto archive audit failed:', e); process.exit(1); });
}
