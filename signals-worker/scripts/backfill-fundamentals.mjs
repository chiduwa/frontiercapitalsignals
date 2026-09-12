// Backfills the four fundamentals lanes (migration 0036). Resumable and
// budgeted, same shape as backfill-derivatives.mjs.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
// Optional env:
//   FUND_LANES              comma list of: liquidity,supply,chain,network (default all)
//   FUND_LIQUIDITY_SYMBOLS  how many top-OI symbols to cover (default 50)
//   FUND_LIQUIDITY_DAYS     days of book history (default 365)
//   FUND_TIME_BUDGET_MIN    default 90
import { d1, d1Batch, chunk } from './d1-client.mjs';
import {
  fetchBookDepthDay, fetchChainTvl, fetchStablecoinSupply, fetchBtcChart, mergeBtcSeries
} from './fundamentals-archive.mjs';
import { venueSymbol, dateRange } from './derivatives-archive.mjs';
import { getCryptoMarkets } from '../worker.js';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID } = process.env;
for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID };

const LANES = (process.env.FUND_LANES || 'supply,chain,network,liquidity').split(',').map((s) => s.trim());
// Book-depth files are ~530KB each against ~11KB for the metrics files, so
// this lane is bounded by breadth x depth in a way the derivatives backfill
// was not: the whole universe at full depth would be tens of gigabytes. The
// liquid head of the universe is also where the feature is meaningful — depth
// on an asset nobody quotes is not informative — so it is capped by default.
const LIQUIDITY_SYMBOLS = Number(process.env.FUND_LIQUIDITY_SYMBOLS || 50);
const LIQUIDITY_DAYS = Number(process.env.FUND_LIQUIDITY_DAYS || 365);
const TIME_BUDGET_MS = Number(process.env.FUND_TIME_BUDGET_MIN || 90) * 60000;
const CONCURRENCY = Number(process.env.FUND_CONCURRENCY || 24);

const started = Date.now();
const outOfTime = () => Date.now() - started > TIME_BUDGET_MS;
const endDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

async function writeRows(table, cols, rows, perStatement) {
  if (!rows.length) return;
  const statements = chunk(rows, perStatement).map((group) => ({
    sql: `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES `
      + group.map(() => `(${cols.map(() => '?').join(', ')})`).join(', '),
    params: group.flatMap((r) => cols.map((c) => (r[c] === undefined ? null : r[c])))
  }));
  for (const batch of chunk(statements, 40)) await d1Batch(env, batch);
}

// --- supply: zero additional API cost, see migration 0036 ---
async function laneSupply() {
  console.log('\n[supply] one getCryptoMarkets call, already made by every hourly build');
  const markets = await getCryptoMarkets();
  const tracked = new Set((await d1(env, 'SELECT DISTINCT symbol FROM derivatives_daily')).map((r) => r.symbol));
  const date = new Date().toISOString().slice(0, 10);
  const best = new Map();
  for (const m of markets) {
    const sym = String(m.symbol || '').toUpperCase();
    if (!sym || !tracked.has(sym)) continue;
    const prev = best.get(sym);
    if (!prev || (m.market_cap || 0) > (prev.market_cap || 0)) best.set(sym, m);
  }
  const rows = [...best.entries()].map(([symbol, m]) => ({
    symbol, date,
    circulating_supply: m.circulating_supply ?? null,
    total_supply: m.total_supply ?? null,
    max_supply: m.max_supply ?? null,
    market_cap: m.market_cap ?? null,
    source: 'coingecko-markets'
  }));
  await writeRows('asset_supply_snapshot_daily',
    ['symbol', 'date', 'circulating_supply', 'total_supply', 'max_supply', 'market_cap', 'source'], rows, 14);
  console.log(`[supply] ${rows.length} symbols captured for ${date}`);
}

// --- chain activity + macro liquidity ---
const TVL_CHAINS = ['Ethereum', 'Solana', 'Arbitrum', 'Base', 'BSC', 'Avalanche', 'Polygon', 'Sui', 'Aptos', 'Tron'];
async function laneChain() {
  console.log('\n[chain] DefiLlama TVL + stablecoin supply');
  const rows = [];
  for (const chain of TVL_CHAINS) {
    try {
      const r = await fetchChainTvl(chain);
      rows.push(...r);
      console.log(`  ${chain.padEnd(12)} ${r.length} days`);
    } catch (e) { console.log(`  ${chain.padEnd(12)} FAILED ${String(e && e.message).slice(0, 50)}`); }
  }
  try {
    const s = await fetchStablecoinSupply();
    rows.push(...s);
    console.log(`  stablecoins  ${s.length} days`);
  } catch (e) { console.log(`  stablecoins  FAILED ${String(e && e.message).slice(0, 50)}`); }
  await writeRows('chain_metrics_daily', ['chain', 'date', 'metric', 'value', 'source'],
    rows.map((r) => ({ ...r, source: 'defillama' })), 20);
  console.log(`[chain] ${rows.length} rows`);
}

// --- production cost (BTC) ---
async function laneNetwork() {
  console.log('\n[network] blockchain.info BTC hashrate / difficulty / miner revenue');
  const [hashrate, difficulty, revenue, transactions] = await Promise.all([
    fetchBtcChart('hash-rate'), fetchBtcChart('difficulty'),
    fetchBtcChart('miners-revenue'), fetchBtcChart('n-transactions')
  ]);
  const rows = mergeBtcSeries({ hashrate, difficulty, revenue, transactions });
  await writeRows('network_cost_daily',
    ['network', 'date', 'hashrate', 'difficulty', 'miners_revenue_usd', 'transactions', 'source'], rows, 14);
  console.log(`[network] ${rows.length} days ${rows[0]?.date}..${rows[rows.length - 1]?.date}`);
}

// --- order-book liquidity ---
async function laneLiquidity() {
  console.log(`\n[liquidity] Binance bookDepth, top ${LIQUIDITY_SYMBOLS} symbols by open interest, ${LIQUIDITY_DAYS}d`);
  const top = await d1(env,
    `SELECT symbol, AVG(oi_usd_close) oi FROM derivatives_daily
     WHERE date >= date('now', '-30 day') GROUP BY symbol ORDER BY oi DESC LIMIT ?`, [LIQUIDITY_SYMBOLS]);
  const symbols = top.map((r) => r.symbol);
  console.log(`  universe: ${symbols.join(' ')}`);
  const from = new Date(Date.now() - LIQUIDITY_DAYS * 86400000).toISOString().slice(0, 10);
  const cols = ['symbol', 'date', 'venue_symbol', 'bid_notional_1pct', 'ask_notional_1pct',
    'bid_notional_5pct', 'ask_notional_5pct', 'book_imbalance_1pct', 'book_imbalance_5pct',
    'depth_1pct_usd', 'snapshots', 'source'];

  for (const symbol of symbols) {
    if (outOfTime()) { console.log('  time budget reached — re-run to continue'); break; }
    const have = new Set((await d1(env, 'SELECT date FROM asset_liquidity_daily WHERE symbol = ?', [symbol])).map((r) => r.date));
    const wanted = dateRange(from, endDate).reverse().filter((d) => !have.has(d));
    if (!wanted.length) { console.log(`  ${symbol.padEnd(8)} already complete (${have.size}d)`); continue; }
    let written = 0, misses = 0;
    for (const group of chunk(wanted, CONCURRENCY)) {
      if (outOfTime()) break;
      let results;
      try { results = await pool(group, CONCURRENCY, (d) => fetchBookDepthDay(symbol, d)); }
      catch (e) {
        if (/portal blocked/.test(String(e && e.message))) throw e;
        break;
      }
      const good = results.filter(Boolean);
      misses += results.length - good.length;
      if (good.length) { await writeRows('asset_liquidity_daily', cols, good, 8); written += good.length; }
      // bookDepth coverage starts later than klines for many contracts; stop
      // walking back once the portal has clearly run out of files.
      if (!good.length && misses > 40) break;
    }
    console.log(`  ${symbol.padEnd(8)} +${written} days`);
  }
  const tot = await d1(env, 'SELECT COUNT(*) n, COUNT(DISTINCT symbol) s, MIN(date) lo, MAX(date) hi FROM asset_liquidity_daily');
  console.log(`[liquidity] archive now ${tot[0].n} rows / ${tot[0].s} symbols / ${tot[0].lo}..${tot[0].hi}`);
}

async function main() {
  console.log(`fundamentals backfill: lanes = ${LANES.join(', ')}`);
  const runners = { supply: laneSupply, chain: laneChain, network: laneNetwork, liquidity: laneLiquidity };
  for (const lane of LANES) {
    const fn = runners[lane];
    if (!fn) { console.log(`unknown lane "${lane}", skipping`); continue; }
    try { await fn(); }
    catch (e) { console.error(`[${lane}] FAILED: ${String(e && e.message).slice(0, 160)}`); }
  }
  console.log('\ndone');
}

main().catch((e) => { console.error(e); process.exit(1); });
