// Live open-interest sampler and flush classifier. Runs ONLY on the Oracle
// host — fapi.binance.com is HTTP 451 everywhere else in this system.
//
// It exists because the finding in docs/FLUSH_EVIDENCE.md is time-critical.
// OI direction during a violent move separates a dip that fully retraces
// (OI rising, ~106% median recovery) from one that does not (OI falling,
// ~50.3%), Spearman +0.505 over 189 events. But the portal publishes OI in
// 5-minute buckets after the day closes, and the live 5m aggregates lag 6-16
// minutes — useless for classifying a move that is over in five.
//
// /fapi/v1/openInterest is stamped ~8 seconds old and returns in ~0.6s
// (measured on this host 2026-09-12). It is a SNAPSHOT with no delta, so the
// history has to be sampled and kept locally. That is this loop's whole job.
//
// It observes and records. It does NOT place orders and does not talk to the
// trading bot's state. Separating detection from action means the classifier
// accrues its own track record before anything is allowed to trade on it.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
// Optional env: OI_SAMPLE_SYMBOLS, OI_SAMPLE_INTERVAL_SEC (default 20),
//   OI_SAMPLE_DURATION_MIN (default 5), OI_TICK_RETENTION_DAYS (default 7)
import { d1, d1Batch, chunk } from './d1-client.mjs';
import { planEntry, continuationCall } from './flush-entry.mjs';

// Credentials are resolved when the loop actually runs, NOT at import. The
// classifier below is the load-bearing logic and it is pure — a test suite
// must be able to import and exercise it without holding production secrets.
// Checking env at module scope made that impossible.
const env = {};
function requireEnv() {
  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID } = process.env;
  for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
    if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
  }
  Object.assign(env, { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID });
}

const FAPI = (process.env.BINANCE_FAPI_BASE || 'https://fapi.binance.com').replace(/\/$/, '');
const INTERVAL_SEC = Number(process.env.OI_SAMPLE_INTERVAL_SEC || 20);
// One systemd firing samples for this long, then exits. A long-lived daemon
// would be the obvious design, but a bounded one-shot matches every other unit
// on this host and cannot leak a wedged connection across days.
const DURATION_MIN = Number(process.env.OI_SAMPLE_DURATION_MIN || 5);
const RETENTION_DAYS = Number(process.env.OI_TICK_RETENTION_DAYS || 7);
// How many symbols to watch. Each costs one cheap request per interval, and
// the weight budget is shared with a live trading bot.
const MAX_SYMBOLS = Number(process.env.OI_SAMPLE_MAX_SYMBOLS || 40);

// Event geometry, matching the study these thresholds came from.
export const MOVE_PCT_TRIGGER = 4;      // %, over the lookback, either direction
export const MOVE_LOOKBACK_MIN = 5;
// The classifying cut. |OI change| below this is not evidence either way.
export const OI_DECISIVE_PCT = 1;
// Measured medians from docs/FLUSH_EVIDENCE.md. Stored on the event so a later
// scorer can compare what was expected against what happened.
export const EXPECTED_RECOVERY = { liquidation: 0.503, 'new-position': 1.062, ambiguous: 0.622 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Push via ntfy.sh, the same free topic-based transport scripts/notify.mjs
// already uses. Silently inert when NTFY_TOPIC is unset, so an unconfigured
// host samples and records normally instead of failing.
async function notifyContinuation(call, move) {
  const line = `${call.symbol} ${call.expectation} — ${call.basis}`;
  console.log(`    ALERT ${line} (median 12h ${call.median12hPct > 0 ? '+' : ''}${call.median12hPct}%)`);
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  const up = move.direction === 'up';
  const body = `${call.basis}\n\n`
    + `Median 12h move after this signature: ${call.median12hPct > 0 ? '+' : ''}${call.median12hPct}%\n`
    + `Caution: ${call.caution}\n\n`
    + `Measured over 248 episodes / 30 symbols / 60 days. Not a recommendation.`;
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        Title: `${call.symbol} ${call.expectation}`,
        Priority: 'default',
        Tags: up ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend'
      },
      body,
      signal: AbortSignal.timeout(10000)
    });
  } catch (e) {
    console.log(`    (alert delivery failed: ${String(e && e.message).slice(0, 60)})`);
  }
}

async function fapi(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${FAPI}${path}${qs ? `?${qs}` : ''}`, { signal: AbortSignal.timeout(10000) });
  if (res.status === 451 || res.status === 403) {
    throw new Error(`GEOBLOCKED: HTTP ${res.status} — oi-sampler only runs on the un-geo-blocked host`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

// Classifies a move from its OI change. This is the whole finding, in one
// function, deliberately kept tiny and pure so it can be tested directly.
export function classifyMove(oiChangePct, { decisive = OI_DECISIVE_PCT } = {}) {
  if (oiChangePct == null || !Number.isFinite(oiChangePct)) return 'ambiguous';
  if (oiChangePct <= -decisive) return 'liquidation';
  if (oiChangePct >= decisive) return 'new-position';
  return 'ambiguous';
}

// Given a symbol's recent ticks, is a move in progress, and what is its shape?
export function detectMove(ticks, { triggerPct = MOVE_PCT_TRIGGER, lookbackMin = MOVE_LOOKBACK_MIN } = {}) {
  if (!ticks || ticks.length < 3) return null;
  const now = ticks[ticks.length - 1];
  const cutoff = now.ts - lookbackMin * 60000;
  const window = ticks.filter((t) => t.ts >= cutoff && t.mark_price > 0);
  if (window.length < 3) return null;

  const first = window[0];
  // Direction comes from TIME ORDER, not from comparing magnitudes.
  //
  // The obvious-looking version — compute (low/high - 1) and (high/low - 1)
  // and take whichever is bigger — is broken, and a unit test caught it
  // classifying a 100 -> 94 collapse as an UP move. Both quantities are
  // derived from the same pair, and (high/low - 1) always exceeds
  // |low/high - 1| for any high > low, so the down branch was effectively
  // unreachable. What actually distinguishes the two cases is whether the low
  // came after the high (a drop) or the high came after the low (a spike).
  let hiIdx = 0, loIdx = 0;
  for (let k = 1; k < window.length; k++) {
    if (window[k].mark_price > window[hiIdx].mark_price) hiIdx = k;
    if (window[k].mark_price < window[loIdx].mark_price) loIdx = k;
  }
  const high = window[hiIdx].mark_price, low = window[loIdx].mark_price;

  let direction = null, refPrice = null, extremePrice = null, movePct = null;
  if (loIdx > hiIdx) {
    const pct = ((low / high) - 1) * 100;
    if (pct > -triggerPct) return null;
    direction = 'down'; refPrice = high; extremePrice = low; movePct = pct;
  } else if (hiIdx > loIdx) {
    const pct = ((high / low) - 1) * 100;
    if (pct < triggerPct) return null;
    direction = 'up'; refPrice = low; extremePrice = high; movePct = pct;
  } else return null;   // single flat point: no excursion to speak of

  const oiChangePct = (first.oi_usd > 0 && now.oi_usd > 0)
    ? ((now.oi_usd / first.oi_usd) - 1) * 100 : null;

  return {
    direction, refPrice, extremePrice, movePct, oiChangePct,
    firstTs: first.ts, lastTs: now.ts,
    classification: classifyMove(oiChangePct)
  };
}

async function watchlist() {
  if (process.env.OI_SAMPLE_SYMBOLS) {
    return process.env.OI_SAMPLE_SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  // The liquid head by recent open interest — where a flush is both most
  // likely to be tradeable and most likely to matter.
  const rows = await d1(env,
    `SELECT symbol FROM derivatives_daily WHERE date >= date('now','-14 day')
     GROUP BY symbol ORDER BY AVG(oi_usd_close) DESC LIMIT ?`, [MAX_SYMBOLS]);
  return rows.map((r) => r.symbol);
}

async function main() {
  requireEnv();
  try { await fapi('/fapi/v1/time'); }
  catch (e) { console.error(String(e && e.message)); process.exit(2); }

  const symbols = await watchlist();
  console.log(`oi-sampler: ${symbols.length} symbols, every ${INTERVAL_SEC}s for ${DURATION_MIN}min`);

  // Seed from what is already stored so a move that began during the previous
  // firing is still visible in this one — otherwise every restart is blind for
  // the first lookback window.
  const seedFrom = Date.now() - (MOVE_LOOKBACK_MIN + 2) * 60000;
  const seed = await d1(env,
    'SELECT symbol, ts, oi_usd, mark_price FROM oi_tick WHERE ts >= ? ORDER BY symbol, ts', [seedFrom]);
  const history = new Map(symbols.map((s) => [s, []]));
  for (const r of seed) if (history.has(r.symbol)) history.get(r.symbol).push(r);

  const deadline = Date.now() + DURATION_MIN * 60000;
  const announced = new Set();
  let samples = 0, detections = 0;

  while (Date.now() < deadline) {
    const started = Date.now();
    const batch = [];
    await Promise.all(symbols.map(async (symbol) => {
      try {
        const [oi, mark] = await Promise.all([
          fapi('/fapi/v1/openInterest', { symbol: `${symbol}USDT` }),
          fapi('/fapi/v1/premiumIndex', { symbol: `${symbol}USDT` })
        ]);
        const contracts = Number(oi.openInterest);
        const price = Number(mark.markPrice);
        const ts = Number(oi.time);
        if (!(contracts > 0) || !(price > 0) || !Number.isFinite(ts)) return;
        const row = { symbol, ts, oi_contracts: contracts, oi_usd: contracts * price, mark_price: price };
        batch.push(row);
        const h = history.get(symbol);
        h.push(row);
        while (h.length && h[0].ts < ts - (MOVE_LOOKBACK_MIN + 5) * 60000) h.shift();
      } catch { /* one symbol failing must not stop the sweep */ }
    }));
    samples += batch.length;

    if (batch.length) {
      const statements = chunk(batch, 20).map((g) => ({
        sql: 'INSERT OR REPLACE INTO oi_tick (symbol, ts, oi_contracts, oi_usd, mark_price) VALUES '
          + g.map(() => '(?, ?, ?, ?, ?)').join(', '),
        params: g.flatMap((r) => [r.symbol, r.ts, r.oi_contracts, r.oi_usd, r.mark_price])
      }));
      for (const grp of chunk(statements, 40)) await d1Batch(env, grp);
    }

    for (const symbol of symbols) {
      const move = detectMove(history.get(symbol));
      if (!move) continue;
      const id = `${symbol}|${move.firstTs}`;
      if (announced.has(id)) continue;
      announced.add(id);
      detections++;
      await d1(env,
        `INSERT OR IGNORE INTO flush_event
         (id, symbol, direction, detected_at, first_ts, ref_price, extreme_price, move_pct,
          oi_change_pct, classification, expected_recovery)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, symbol, move.direction, new Date().toISOString(), move.firstTs,
         move.refPrice, move.extremePrice, move.movePct, move.oiChangePct,
         move.classification, EXPECTED_RECOVERY[move.classification] ?? null]);
      const plan = planEntry({ ...move, symbol });
      console.log(`  FLUSH ${symbol} ${move.direction} ${move.movePct.toFixed(2)}% `
        + `OI ${move.oiChangePct == null ? 'n/a' : move.oiChangePct.toFixed(2) + '%'} `
        + `-> ${move.classification}`);
      if (plan.ok) {
        console.log(`    PLAN ${plan.side} entry ${plan.entryPrice.toPrecision(6)} `
          + `stop ${plan.stopPrice.toPrecision(6)} target ${plan.targetPrice.toPrecision(6)} `
          + `max ${plan.maxLeverage}x, hold <=${plan.maxHoldMinutes}m`);
      } else {
        console.log(`    NO TRADE: ${plan.reason}`);
      }

      // A continuation call is the alert the operator asked for: not "a flush
      // happened" but "this one is likely to keep going". It fires only on
      // rising open interest, which is the case the 12-hour numbers say
      // persists (+10.82% for spikes, -13.47% for dips).
      const cont = continuationCall({ ...move, symbol });
      if (cont) await notifyContinuation(cont, move);
    }

    const elapsed = Date.now() - started;
    await sleep(Math.max(0, INTERVAL_SEC * 1000 - elapsed));
  }

  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  await d1(env, 'DELETE FROM oi_tick WHERE ts < ?', [cutoff]);
  console.log(`done: ${samples} samples, ${detections} events detected`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
