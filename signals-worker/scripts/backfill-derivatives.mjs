// Resumable deep-history backfill of derivatives_daily from Binance's public
// data portal (migration 0033). Safe to re-run and safe to interrupt: every
// run reads what is already stored, fetches only missing dates, and records
// how far it reached, so a budget cut-off just means the next run continues.
//
// Why it is budgeted rather than one-shot: the portal serves ONE FILE PER
// SYMBOL PER DAY and publishes no monthly metrics roll-up (checked live
// 2026-09-11), so full depth across the tracked universe is ~141k requests.
// That does not fit one Actions job, and it should not hold the daily pipeline
// hostage while it runs.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
// Optional env:
//   DERIV_START_DATE   (default 2023-01-01) oldest date to reach for
//   DERIV_ROW_BUDGET   (default 120000) rows written before stopping cleanly
//   DERIV_TIME_BUDGET_MIN (default 90)
//   DERIV_SYMBOLS      comma list, restricts the run (used by tests/spot-checks)
//   DERIV_FETCH_CONCURRENCY (default 32)
import { d1, d1Batch, chunk } from './d1-client.mjs';
import {
  fetchMetricsDay, venueSymbol, buildDerivInsert,
  DERIV_ROWS_PER_STATEMENT, dateRange
} from './derivatives-archive.mjs';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID } = process.env;
for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID };

const START_DATE = process.env.DERIV_START_DATE || '2023-01-01';
const ROW_BUDGET = Number(process.env.DERIV_ROW_BUDGET || 120000);
const TIME_BUDGET_MS = Number(process.env.DERIV_TIME_BUDGET_MIN || 90) * 60000;
const CONCURRENCY = Number(process.env.DERIV_FETCH_CONCURRENCY || 32);
// Consecutive 404s walking backwards that mean "this contract did not exist
// yet", as opposed to an ordinary hole in the portal's coverage. Binance gaps
// are typically a day or two; three weeks of silence is a listing boundary.
const LISTING_BOUNDARY_MISSES = 21;

const started = Date.now();
const outOfTime = () => Date.now() - started > TIME_BUDGET_MS;
const today = new Date().toISOString().slice(0, 10);
// The portal publishes a day's file after that UTC day closes, so the newest
// reliably-present date is yesterday.
const endDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

async function targetSymbols() {
  if (process.env.DERIV_SYMBOLS) return process.env.DERIV_SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean);
  // The tracked perp universe as the live logger sees it. Using
  // funding_rate_daily rather than CRYPTO_UNIVERSE keeps the backfill aligned
  // with the assets the engine actually models a perp for.
  const rows = await d1(env, 'SELECT DISTINCT symbol FROM funding_rate_daily ORDER BY symbol');
  return rows.map((r) => r.symbol);
}

async function loadState() {
  const rows = await d1(env, 'SELECT * FROM derivatives_backfill_state');
  return new Map(rows.map((r) => [r.symbol, r]));
}

async function storedDates(symbol) {
  const rows = await d1(env, 'SELECT date FROM derivatives_daily WHERE symbol = ? ORDER BY date', [symbol]);
  return new Set(rows.map((r) => r.date));
}

async function writeRows(rows) {
  if (!rows.length) return;
  const statements = chunk(rows, DERIV_ROWS_PER_STATEMENT).map(buildDerivInsert);
  // 40 statements per request. D1's 100-bound-param cap is per STATEMENT, not
  // per batch, so depth is recovered by batching many small multi-row inserts:
  // 40 x 7 = 280 rows per round trip instead of one row at a time.
  for (const group of chunk(statements, 40)) await d1Batch(env, group);
}

async function upsertState(symbol, patch) {
  const cols = ['venue_symbol', 'status', 'earliest_date', 'latest_date', 'earliest_probed', 'days_stored', 'last_run_at', 'notes'];
  const vals = cols.map((c) => (patch[c] === undefined ? null : patch[c]));
  await d1(env,
    `INSERT INTO derivatives_backfill_state (symbol, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
     ON CONFLICT(symbol) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`,
    [symbol, ...vals]);
}

// Bounded-concurrency map that preserves input order in the result.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

async function backfillSymbol(symbol, state, budget) {
  const have = await storedDates(symbol);
  // Newest-first: recent history is what the research and the live features
  // need soonest, and a run that is cut short should leave a usable recent
  // window rather than a usable ancient one.
  const wanted = dateRange(START_DATE, endDate).reverse().filter((d) => !have.has(d));
  if (!wanted.length) {
    await upsertState(symbol, {
      venue_symbol: venueSymbol(symbol), status: 'complete',
      earliest_date: [...have].sort()[0] || null, latest_date: [...have].sort().pop() || null,
      earliest_probed: START_DATE, days_stored: have.size, last_run_at: new Date().toISOString(), notes: null
    });
    return { symbol, written: 0, status: 'complete', have: have.size };
  }

  const buffer = [];
  let written = 0, consecutiveMisses = 0, probed = null, hitAny = have.size > 0, stopped = null;
  let exhaustedWindow = true;   // false as soon as any group is skipped by a break

  for (const group of chunk(wanted, CONCURRENCY)) {
    if (outOfTime() || budget.rows <= 0) { stopped = 'budget'; exhaustedWindow = false; break; }
    let results;
    try {
      results = await pool(group, CONCURRENCY, (d) => fetchMetricsDay(symbol, d));
    } catch (e) {
      if (/portal blocked/.test(String(e && e.message))) throw e;  // loud: geo-block regression
      stopped = `fetch error: ${String(e && e.message).slice(0, 120)}`;
      exhaustedWindow = false;
      break;
    }
    probed = group[group.length - 1];
    for (const r of results) {
      if (r) { buffer.push(r); hitAny = true; consecutiveMisses = 0; }
      else consecutiveMisses++;
    }
    if (buffer.length >= 600) { await writeRows(buffer.splice(0)); }
    written = have.size + buffer.length;
    budget.rows -= results.filter(Boolean).length;
    // Walking backwards past a contract's listing date returns nothing but
    // 404s forever; stop rather than spending the budget on empty air.
    if (hitAny && consecutiveMisses >= LISTING_BOUNDARY_MISSES) { stopped = 'listing-boundary'; break; }
    if (!hitAny && consecutiveMisses >= LISTING_BOUNDARY_MISSES) { stopped = 'unavailable'; break; }
  }
  await writeRows(buffer.splice(0));

  const after = await d1(env, 'SELECT MIN(date) lo, MAX(date) hi, COUNT(*) n FROM derivatives_daily WHERE symbol = ?', [symbol]);
  const { lo, hi, n } = after[0] || {};
  // 'complete' means this symbol needs no further work: either the requested
  // window was fetched end to end, or walking backwards hit the contract's
  // listing boundary and there is genuinely nothing older to get. Only a run
  // that was cut short (budget, transport error) leaves it 'partial'.
  const status = !n ? 'unavailable'
    : (exhaustedWindow || stopped === 'listing-boundary') ? 'complete' : 'partial';
  await upsertState(symbol, {
    venue_symbol: venueSymbol(symbol), status,
    earliest_date: lo || null, latest_date: hi || null, earliest_probed: probed,
    days_stored: n || 0, last_run_at: new Date().toISOString(),
    notes: stopped && stopped !== 'listing-boundary' ? stopped : null
  });
  return { symbol, written: (n || 0) - have.size, status, have: n || 0, stopped };
}

async function main() {
  const symbols = await targetSymbols();
  const state = await loadState();
  // Anything never attempted first, then whatever is least complete, so repeat
  // runs spread depth across the universe instead of perfecting one symbol.
  const ordered = symbols.slice().sort((a, b) => {
    const sa = state.get(a), sb = state.get(b);
    const rank = (s) => (!s ? 0 : s.status === 'partial' ? 1 : s.status === 'complete' ? 3 : 4);
    return rank(sa) - rank(sb) || (sa?.days_stored || 0) - (sb?.days_stored || 0);
  });
  console.log(`derivatives backfill: ${ordered.length} symbols, window ${START_DATE}..${endDate}, `
    + `row budget ${ROW_BUDGET}, time budget ${Math.round(TIME_BUDGET_MS / 60000)}min`);

  const budget = { rows: ROW_BUDGET };
  let totalWritten = 0, done = 0, unavailable = 0;
  for (const symbol of ordered) {
    if (outOfTime() || budget.rows <= 0) { console.log(`\nbudget reached after ${done} symbols — re-run to continue`); break; }
    try {
      const r = await backfillSymbol(symbol, state.get(symbol), budget);
      totalWritten += Math.max(0, r.written);
      if (r.status === 'unavailable') unavailable++;
      done++;
      console.log(`  ${symbol.padEnd(10)} +${String(Math.max(0, r.written)).padStart(5)} rows  total=${String(r.have).padStart(5)}  ${r.status}${r.stopped && r.stopped !== 'listing-boundary' ? ` (${r.stopped})` : ''}`);
    } catch (e) {
      console.error(`  ${symbol.padEnd(10)} FAILED: ${String(e && e.message).slice(0, 160)}`);
      if (/portal blocked/.test(String(e && e.message))) { console.error('portal geo-block detected — aborting run'); process.exit(1); }
    }
  }
  const tot = await d1(env, 'SELECT COUNT(*) n, COUNT(DISTINCT symbol) s, MIN(date) lo, MAX(date) hi FROM derivatives_daily');
  console.log(`\ndone: +${totalWritten} rows this run. archive now ${tot[0].n} rows / ${tot[0].s} symbols / ${tot[0].lo}..${tot[0].hi}`);
  if (unavailable) console.log(`${unavailable} symbol(s) have no Binance USDT perp — recorded 'unavailable', they will abstain.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
