// Hourly SHADOW run for the pump-fade lane (rules and evidence in
// pump-fade-rules.mjs). Each run does two things:
//
//   1. records the short it WOULD open on any coin whose first 10% pump of
//      the UTC day just closed with every horizon agreeing, at the perp's
//      mark price, with the funding rate at that moment;
//   2. scores every record whose 24-hour hold has finished: 15% stop on 5m
//      bars, the funding a short would actually have received or paid, and
//      0.15% costs.
//
// It places no orders. There is no order code in this file and it imports
// none, so no setting can make it trade. Going live is a separate, later
// change, made on this ledger's forward record (owner's decision 2026-10-05:
// shadow first, live at floor size once it has a few weeks).
//
// Needs only public Binance endpoints and the D1 credentials already in
// /etc/fcs-trading-bot.env. fapi.binance.com answers from the Oracle host and
// is HTTP 451 elsewhere, so this runs there.
import { d1 } from '../../signals-worker/scripts/d1-client.mjs';
import {
  PUMP_FADE_VERSION, STOP_PCT, HOLD_HOURS, COST_PCT,
  closedHourBars, detectPump, shortStopPrice, settleShort, shortFundingPct, netPct, summariseLedger
} from './pump-fade-rules.mjs';

const FAPI = (process.env.BINANCE_FAPI_BASE || 'https://fapi.binance.com').replace(/\/$/, '');
const HOUR = 3600_000;
const FIVE_MIN = 300_000;
const KLINE_LIMIT = 60;          // today's bars plus 25h before the first one; under 100 keeps weight 1
const CONCURRENCY = 8;
const SETTLE_GRACE_MS = 10 * 60_000;

// 'shadow' (default) or 'off'. Anything else is refused rather than guessed
// at: there is no live mode to fall back to.
export function loadMode(envVars = process.env) {
  const mode = String(envVars.PUMP_FADE_MODE || 'shadow').trim().toLowerCase();
  return mode === 'off' || mode === 'shadow' ? mode : 'refused';
}

async function getJson(url, { attempts = 3, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let a = 0; a < attempts; a++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.status === 400) return null;                 // unknown or delisted symbol
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * (a + 1)));
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error(`${url.replace(FAPI, '')}: ${lastErr && lastErr.message}`);
}

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).catch((e) => ({ error: e }));
    }
  }));
  return out;
}

// The replay's universe: coins the engine tracks that have a Binance USD-M
// perpetual (derivatives_daily, refreshed daily), restricted to contracts
// that are trading right now.
export async function loadUniverse(env, nowMs = Date.now()) {
  const since = new Date(nowMs - 7 * 86400_000).toISOString().slice(0, 10);
  const rows = await d1(env,
    'SELECT symbol, MAX(venue_symbol) AS venue FROM derivatives_daily WHERE date >= ? GROUP BY symbol', [since]);
  const info = await getJson(`${FAPI}/fapi/v1/exchangeInfo`);
  const trading = new Set((info && info.symbols || [])
    .filter((s) => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT')
    .map((s) => s.symbol));
  return rows.filter((r) => r.venue && trading.has(r.venue)).map((r) => ({ symbol: r.symbol, venue: r.venue }));
}

export async function detectAll(env, { nowMs = Date.now(), log = console.log } = {}) {
  const universe = await loadUniverse(env, nowMs);
  const results = await mapLimited(universe, CONCURRENCY, async (u) => {
    const k = await getJson(`${FAPI}/fapi/v1/klines?symbol=${u.venue}&interval=1h&limit=${KLINE_LIMIT}`);
    return { ...u, ...detectPump(closedHourBars(k, nowMs)) };
  });
  const errors = results.filter((r) => r && r.error);
  if (errors.length) log(`pump-fade: ${errors.length} of ${universe.length} symbols failed to load (${errors[0].error.message})`);
  const setups = results.filter((r) => r && r.setup);
  const reversing = results.filter((r) => r && /reversing/.test(r.reason || '')).length;
  log(`pump-fade: scanned ${universe.length} perps, ${setups.length} aligned pump(s), ${reversing} skipped as "now reversing"`);
  return { universe: universe.length, setups, errors: errors.length };
}

async function recordSetups(env, setups, { nowMs = Date.now(), log = console.log, dryRun = false } = {}) {
  if (!setups.length) return 0;
  const marks = await getJson(`${FAPI}/fapi/v1/premiumIndex`);
  const bySymbol = new Map((marks || []).map((m) => [m.symbol, m]));
  let written = 0;
  for (const s of setups) {
    const m = bySymbol.get(s.venue);
    const entry = m && Number(m.markPrice);
    if (!(entry > 0)) { log(`  skip ${s.symbol}: no mark price`); continue; }
    const row = {
      symbol: s.symbol, venue: s.venue, day: s.setup.signalDay,
      stop: shortStopPrice(entry, STOP_PCT)
    };
    log(`  SHADOW SHORT ${s.symbol} (${s.venue}) at ${entry} after +${s.setup.move6h.toFixed(1)}% over 6h `
      + `(1h +${s.setup.move1h.toFixed(1)}%, 1d +${s.setup.move24h.toFixed(1)}%), stop ${row.stop.toPrecision(6)}, `
      + `funding ${(Number(m.lastFundingRate) * 100).toFixed(4)}%${s.setup.lagBars ? `, ${s.setup.lagBars} bar late` : ''}`);
    if (dryRun) continue;
    const res = await d1(env, `
      INSERT OR IGNORE INTO pump_fade_shadow (
        symbol, venue_symbol, signal_day, model_version, bar_close_ts, bar_close_price, lag_bars,
        move_1h_pct, move_3h_pct, move_6h_pct, move_24h_pct,
        entry_ts, entry_price, stop_price, funding_rate_at_entry, detected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING symbol`, [
      s.symbol, s.venue, s.setup.signalDay, PUMP_FADE_VERSION, s.setup.barCloseTs, s.setup.barClose, s.setup.lagBars,
      s.setup.move1h, s.setup.move3h, s.setup.move6h, s.setup.move24h,
      nowMs, entry, row.stop, Number.isFinite(Number(m.lastFundingRate)) ? Number(m.lastFundingRate) : null,
      new Date(nowMs).toISOString()
    ]);
    written += res.length;
  }
  return written;
}

export async function settleDue(env, { nowMs = Date.now(), log = console.log, dryRun = false } = {}) {
  const due = await d1(env, `
    SELECT symbol, venue_symbol, signal_day, entry_ts, entry_price FROM pump_fade_shadow
    WHERE settled_at IS NULL AND entry_ts <= ? ORDER BY entry_ts`,
    [nowMs - HOLD_HOURS * HOUR - SETTLE_GRACE_MS]);
  let settled = 0;
  for (const r of due) {
    const start = r.entry_ts - (r.entry_ts % FIVE_MIN);
    const k = await getJson(`${FAPI}/fapi/v1/klines?symbol=${r.venue_symbol}&interval=5m&startTime=${start}&limit=300`);
    const bars = (k || []).map((x) => ({
      ts: Number(x[0]), open: Number(x[1]), high: Number(x[2]), low: Number(x[3]), close: Number(x[4]),
      closeTs: Number(x[0]) + FIVE_MIN
    }));
    const out = settleShort({ entryPrice: r.entry_price, entryTs: r.entry_ts, bars });
    if (!out) { log(`  ${r.symbol} ${r.signal_day}: bars incomplete, will retry`); continue; }
    const funding = await getJson(`${FAPI}/fapi/v1/fundingRate?symbol=${r.venue_symbol}&startTime=${r.entry_ts}&endTime=${out.exitTs}&limit=100`);
    const fundingPct = shortFundingPct((funding || []).map((f) => f.fundingRate));
    const net = netPct({ grossPct: out.grossPct, fundingPct, costPct: COST_PCT });
    log(`  SETTLED ${r.symbol} ${r.signal_day}: ${out.exitReason} at ${out.exitPrice}, gross ${out.grossPct.toFixed(2)}%, `
      + `funding ${fundingPct.toFixed(3)}%, net ${net.toFixed(2)}%`);
    if (dryRun) continue;
    await d1(env, `
      UPDATE pump_fade_shadow SET settled_at = ?, exit_ts = ?, exit_price = ?, exit_reason = ?,
        gross_pct = ?, funding_pct = ?, cost_pct = ?, net_pct = ?, max_adverse_pct = ?, max_favourable_pct = ?
      WHERE symbol = ? AND signal_day = ? AND settled_at IS NULL`, [
      new Date(nowMs).toISOString(), out.exitTs, out.exitPrice, out.exitReason,
      out.grossPct, fundingPct, COST_PCT, net, out.maxAdversePct, out.maxFavourablePct,
      r.symbol, r.signal_day
    ]);
    settled++;
  }
  return settled;
}

export async function report(env, { log = console.log } = {}) {
  const rows = await d1(env, 'SELECT * FROM pump_fade_shadow ORDER BY entry_ts');
  const s = summariseLedger(rows);
  const open = rows.filter((r) => !r.settled_at).length;
  log(`pump-fade shadow ledger: ${rows.length} recorded, ${open} still inside their 24h hold`);
  if (!s.n) { log('  nothing settled yet'); return s; }
  log(`  settled ${s.n} across ${s.days} days: mean net ${s.meanNetPct.toFixed(2)}% a trade, `
    + `win ${(100 * s.winRate).toFixed(0)}%, stopped ${(100 * s.stopRate).toFixed(0)}%, `
    + `funding ${s.meanFundingPct.toFixed(3)}% a trade, t (by day) ${s.dayClusteredT == null ? 'n/a' : s.dayClusteredT.toFixed(2)}`);
  log('  replay expectation at this stop: +0.25% a trade before funding, t 4.3 over 775 days');
  return s;
}

export async function runOnce(env, { log = console.log, dryRun = false, nowMs = Date.now() } = {}) {
  const mode = loadMode();
  if (mode === 'off') { log('pump-fade: PUMP_FADE_MODE=off — nothing done'); return { mode }; }
  if (mode === 'refused') {
    log(`pump-fade: PUMP_FADE_MODE=${process.env.PUMP_FADE_MODE} is not a mode this version has. `
      + 'Only "shadow" and "off" exist; there is no live path. Nothing done.');
    return { mode };
  }
  const settled = await settleDue(env, { nowMs, log, dryRun });
  const { setups } = await detectAll(env, { nowMs, log });
  const recorded = await recordSetups(env, setups, { nowMs, log, dryRun });
  return { mode, settled, recorded };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = {
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    FCS_D1_DATABASE_ID: process.env.FCS_D1_DATABASE_ID
  };
  const job = process.argv.includes('--report')
    ? report(env)
    : runOnce(env, { dryRun: process.argv.includes('--dry') })
      .then((r) => console.log(`pump-fade done: ${JSON.stringify(r)}`));
  job.catch((e) => { console.error(e); process.exit(1); });
}
