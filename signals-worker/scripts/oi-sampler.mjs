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
import { planEntry } from './flush-entry.mjs';
import { summarise, formatSummary, formatHeadline, formatPct } from './price-change.mjs';

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

// The classifying cut, on OPEN INTEREST IN CONTRACTS.
//
// CORRECTED 2026-09-14, and this is the important number in this file.
//
// Everything here used to classify on oi_usd, which is contracts x mark price.
// A price move therefore shows up in it whether or not a single contract
// changed hands, and over 804k 5-minute bars across 38 symbols (2026-07-01 to
// 09-12) the USD change correlates r = 0.910 with the price move over the same
// bar. On bars that moved at least 2% in five minutes it read "new-position"
// 98.6% of the time price rose and "liquidation" 99.3% of the time price fell.
// It was sign(price) wearing an open-interest costume, and it is what sent
// "BTW keeps rising, open interest +4.0%" on 2026-09-14 while contracts were
// FALLING and the asset was 7% below its price an hour earlier.
//
// Contracts correlate r = 0.192 with the same price move: related, as real
// positioning should be, but not a restatement.
//
// The old cut of 1% cannot be carried across. On the bars this detector
// actually fires on (>= 4% in five minutes) the median |change| is 5.47% in
// USD but 0.247% in contracts, a 22x difference, so a 1% contracts cut would
// abstain on 94% of events and the classifier would be mute. 0.25% is the
// median of that same population: it speaks on the more active half of real
// events and abstains on the rest.
export const OI_DECISIVE_CONTRACTS_PCT = 0.25;
// Kept exported under the old name so nothing importing it breaks, but it is
// the notional-era value and must not be used to classify.
export const OI_DECISIVE_PCT = OI_DECISIVE_CONTRACTS_PCT;

// Measured medians from docs/FLUSH_EVIDENCE.md.
//
// SUPERSEDED, see docs/OI_MEASUREMENT_EVIDENCE.md. Those medians were measured
// on the notional column, so they describe episodes sorted partly by whether
// the move had already begun reversing inside the measurement window, not by
// what open interest did. Replicated on contracts over an independent 74-day
// window the separation collapses from 35.8 points of retrace (t = 8.02) to
// 6.1 points (t = 1.37) on dips, and from -38.6 (t = -7.75) to -4.9 (t = -1.22)
// on spikes. They are still written onto each event so old and new rows stay
// comparable, and nothing is allowed to act on them.
export const EXPECTED_RECOVERY = { liquidation: 0.503, 'new-position': 1.062, ambiguous: 0.622 };
export const EXPECTED_RECOVERY_IS_PROVEN = false;

// Flood control. One BTW move on 2026-09-13/14 produced 262 flush_event rows
// and an alert on almost every one, because the event id was keyed to the
// FIRST tick of a sliding five-minute window: that timestamp advances every
// sample, so each 20-second tick minted a brand new "event" for the same move
// and INSERT OR IGNORE never collided. Identity now comes from the move's own
// reference extreme, and a cooldown covers the case where even that scrolls.
export const ALERT_COOLDOWN_MIN = 30;
// Inside the cooldown, only a move that has extended this much further than the
// one already alerted is worth interrupting someone for again.
export const ALERT_EXTENSION_PCT = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Push via ntfy.sh, the same free topic-based transport scripts/notify.mjs
// already uses. Silently inert when NTFY_TOPIC is unset, so an unconfigured
// host samples and records normally instead of failing.
// The alert body.
//
// It used to be one number against an invisible anchor, which is how a reader
// got "BTW keeps rising, +4.1%" for an asset down 7% on the hour. Now the same
// notification carries the whole ladder, says which horizon the direction came
// from, and says out loud when the horizons disagree. See price-change.mjs.
export function buildAlert(symbol, move, ticks, nowMs) {
  const summary = summarise(ticks, { nowTs: nowMs, horizonsMin: [5, 15, 60], rangeWindowMin: 60 });
  const oi = move.oiChangePct == null ? 'not measurable' : `${formatPct(move.oiChangePct, 2)} (contracts)`;
  const title = summary
    ? formatHeadline(summary, { symbol })
    : `${symbol}: ${formatPct(move.movePct)} ${move.direction === 'up' ? 'spike' : 'drop'}`;
  const lines = [];
  if (summary) lines.push(formatSummary(summary, { symbol }));
  lines.push('');
  lines.push(`Detected: a ${formatPct(move.movePct)} ${move.direction === 'up' ? 'spike' : 'drop'} `
    + `off the ${move.direction === 'up' ? 'low' : 'high'} of the last ${MOVE_LOOKBACK_MIN} minutes. `
    + 'That is an excursion from an extreme, not a change since a fixed time, so it will not match the ladder above.');
  lines.push(`Open interest across the same span: ${oi}. Position count, not dollar value.`);
  lines.push('');
  lines.push('This is an observation, not a recommendation. The open-interest classification '
    + 'behind older versions of this alert was measured on dollar value, which is mostly just '
    + 'the price move again, so no continuation claim is made here.');
  return { title, body: lines.join('\n') };
}

async function pushAlert({ title, body, up }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        Title: title,
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

// Alert state survives a restart, which the old in-memory Set did not: this
// script is a bounded one-shot that systemd fires repeatedly, so every firing
// used to start with no memory of what it had already said.
const ALERT_STATE_KIND = 'flush-alert';

async function loadAlertState(symbols) {
  const out = new Map();
  const rows = await d1(env, `SELECT symbol, last_value FROM notification_state WHERE kind = ?`, [ALERT_STATE_KIND]);
  for (const r of rows) {
    if (!symbols.includes(r.symbol)) continue;
    try { out.set(r.symbol, JSON.parse(r.last_value)); } catch { /* unreadable state is no state */ }
  }
  return out;
}

async function saveAlertState(symbol, record, nowIso) {
  await d1(env, `
    INSERT INTO notification_state (kind, symbol, last_value, last_sent_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (kind, symbol) DO UPDATE SET last_value = excluded.last_value, last_sent_at = excluded.last_sent_at
  `, [ALERT_STATE_KIND, symbol, JSON.stringify(record), nowIso]);
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

// Classifies a move from its OI change. Takes a change measured in CONTRACTS.
// Passing it a notional change produces a confident reading of the price move
// it already knows about; see OI_DECISIVE_CONTRACTS_PCT for the measurement.
export function classifyMove(oiChangePct, { decisive = OI_DECISIVE_CONTRACTS_PCT } = {}) {
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

  let direction = null, refPrice = null, extremePrice = null, movePct = null, refIdx = null;
  if (loIdx > hiIdx) {
    const pct = ((low / high) - 1) * 100;
    if (pct > -triggerPct) return null;
    direction = 'down'; refPrice = high; extremePrice = low; movePct = pct; refIdx = hiIdx;
  } else if (hiIdx > loIdx) {
    const pct = ((high / low) - 1) * 100;
    if (pct < triggerPct) return null;
    direction = 'up'; refPrice = low; extremePrice = high; movePct = pct; refIdx = loIdx;
  } else return null;   // single flat point: no excursion to speak of

  // Anchor the open-interest change to the MOVE's own window, not the sliding
  // sample window's first tick. The two are different spans, and the old code
  // used the second while reporting it as the first: "open interest rose 4.0%
  // through a 4.1% spike" was comparing an OI reading from before the move
  // began against one from after it, on a window whose start crept forward
  // every 20 seconds.
  const refTick = window[refIdx];
  const oiChangePct = (refTick.oi_contracts > 0 && now.oi_contracts > 0)
    ? ((now.oi_contracts / refTick.oi_contracts) - 1) * 100 : null;
  // Kept only so the two can be compared in the archive, never to classify on.
  const oiNotionalChangePct = (refTick.oi_usd > 0 && now.oi_usd > 0)
    ? ((now.oi_usd / refTick.oi_usd) - 1) * 100 : null;

  return {
    direction, refPrice, extremePrice, movePct,
    oiChangePct, oiNotionalChangePct,
    refTs: refTick.ts, firstTs: first.ts, lastTs: now.ts,
    // Identity of the MOVE, stable while the same reference extreme stands,
    // rather than of the sample window that happened to observe it.
    episodeId: `${direction}|${refTick.ts}`,
    classification: classifyMove(oiChangePct)
  };
}

// Should this detection interrupt someone? Pure, so the flood that prompted it
// is a test case rather than something only production can reveal.
// `last` is the previously alerted move for this symbol, or null.
export function shouldAlert(last, move, nowMs, { cooldownMin = ALERT_COOLDOWN_MIN, extensionPct = ALERT_EXTENSION_PCT } = {}) {
  if (!move) return { alert: false, reason: 'no move' };
  if (!last) return { alert: true, reason: 'first alert for this symbol' };
  if (last.episodeId === move.episodeId) {
    // Same move, still running. The only thing worth saying again is that it
    // has gone materially further than when we last spoke.
    const extended = Math.abs(move.movePct) - Math.abs(last.movePct);
    if (extended >= extensionPct) return { alert: true, reason: `same move, extended ${extended.toFixed(1)} points further` };
    return { alert: false, reason: 'same move, no material extension' };
  }
  const ageMin = (nowMs - last.alertedAtMs) / 60000;
  if (ageMin >= cooldownMin) return { alert: true, reason: `new move, ${ageMin.toFixed(0)}min since last alert` };
  const extended = Math.abs(move.movePct) - Math.abs(last.movePct);
  if (extended >= extensionPct) return { alert: true, reason: `new move inside cooldown but ${extended.toFixed(1)} points larger` };
  return { alert: false, reason: `within ${cooldownMin}min cooldown` };
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

// Scores events whose recovery window has closed, against the outcome the
// classification PREDICTED. This is what turns the classifier from an in-sample
// study into something with a live track record — and it is the precondition
// for ever letting it size a real order. Without it the system would keep
// generating confident plans and never learn whether any of them were right.
//
// Resolution is by price only. It does not know or care whether a trade was
// taken; it measures what the setup did.
export const RESOLVE_AFTER_MIN = 30;

async function resolveMaturedEvents() {
  const cutoffTs = Date.now() - RESOLVE_AFTER_MIN * 60000;
  const pending = await d1(env,
    `SELECT id, symbol, direction, first_ts, ref_price, extreme_price, classification, expected_recovery
     FROM flush_event WHERE resolved_at IS NULL AND first_ts <= ? LIMIT 50`, [cutoffTs]);
  if (!pending.length) return 0;

  let n = 0;
  for (const e of pending) {
    // The best price reached in the window after the move, from our own ticks.
    const after = await d1(env,
      'SELECT mark_price FROM oi_tick WHERE symbol = ? AND ts > ? AND ts <= ? ORDER BY ts',
      [e.symbol, e.first_ts, e.first_ts + RESOLVE_AFTER_MIN * 60000]);
    if (after.length < 3) {
      // Not enough of our own samples to judge — mark it resolved with a note
      // rather than leaving it pending forever and silently inflating the
      // "awaiting outcome" count.
      await d1(env, 'UPDATE flush_event SET resolved_at = ?, notes = ? WHERE id = ?',
        [new Date().toISOString(), 'insufficient tick coverage to score', e.id]);
      n++;
      continue;
    }
    const prices = after.map((r) => r.mark_price).filter((p) => p > 0);
    const isDip = e.direction === 'down';
    const best = isDip ? Math.max(...prices) : Math.min(...prices);
    const span = e.ref_price - e.extreme_price;
    const actual = span !== 0 ? (best - e.extreme_price) / span : null;
    const last = prices[prices.length - 1];
    const fwd1h = e.ref_price > 0 ? ((last / e.ref_price) - 1) * 100 : null;
    await d1(env,
      'UPDATE flush_event SET resolved_at = ?, actual_recovery = ?, fwd_1h_pct = ? WHERE id = ?',
      [new Date().toISOString(), actual, fwd1h, e.id]);
    n++;
    const err = (actual != null && e.expected_recovery != null)
      ? ` (expected ${(e.expected_recovery * 100).toFixed(0)}%, got ${(actual * 100).toFixed(0)}%)` : '';
    console.log(`  RESOLVED ${e.symbol} ${e.classification}${err}`);
  }
  return n;
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
  const alertState = await loadAlertState(symbols);
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
      // One row per MOVE. Keying on the reference extreme instead of the
      // sliding window's first tick is what stops 262 rows being written for
      // one BTW move, as happened on 2026-09-13.
      const id = `${symbol}|${move.episodeId}`;
      const nowMs = Date.now();
      if (!announced.has(id)) {
        announced.add(id);
        detections++;
        await d1(env,
          `INSERT OR IGNORE INTO flush_event
           (id, symbol, direction, detected_at, first_ts, ref_price, extreme_price, move_pct,
            oi_change_pct, classification, expected_recovery, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, symbol, move.direction, new Date(nowMs).toISOString(), move.refTs,
           move.refPrice, move.extremePrice, move.movePct, move.oiChangePct,
           move.classification, EXPECTED_RECOVERY[move.classification] ?? null,
           `oi_notional_change_pct=${move.oiNotionalChangePct == null ? 'null' : move.oiNotionalChangePct.toFixed(4)}`]);
        const plan = planEntry({ ...move, symbol });
        console.log(`  FLUSH ${symbol} ${move.direction} ${move.movePct.toFixed(2)}% `
          + `OI ${move.oiChangePct == null ? 'n/a' : move.oiChangePct.toFixed(2) + '%'} contracts `
          + `(notional would have read ${move.oiNotionalChangePct == null ? 'n/a' : move.oiNotionalChangePct.toFixed(2) + '%'}) `
          + `-> ${move.classification}`);
        console.log(plan.ok ? `    PLAN ${plan.side} entry ${plan.entryPrice.toPrecision(6)} `
          + `stop ${plan.stopPrice.toPrecision(6)} target ${plan.targetPrice.toPrecision(6)} `
          + `max ${plan.maxLeverage}x, hold <=${plan.maxHoldMinutes}m`
          : `    NO TRADE: ${plan.reason}`);
      }

      // Whether to interrupt someone is a separate decision from whether to
      // record. Recording is cheap and wants every distinct move; alerting is
      // expensive to the reader and wants only material ones.
      const verdict = shouldAlert(alertState.get(symbol), move, nowMs);
      if (!verdict.alert) continue;
      const { title, body } = buildAlert(symbol, move, history.get(symbol), nowMs);
      console.log(`    ALERT (${verdict.reason}): ${title}`);
      await pushAlert({ title, body, up: move.direction === 'up' });
      const record = { episodeId: move.episodeId, movePct: move.movePct, alertedAtMs: nowMs };
      alertState.set(symbol, record);
      await saveAlertState(symbol, record, new Date(nowMs).toISOString());
    }

    const elapsed = Date.now() - started;
    await sleep(Math.max(0, INTERVAL_SEC * 1000 - elapsed));
  }

  const scored = await resolveMaturedEvents();
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  await d1(env, 'DELETE FROM oi_tick WHERE ts < ?', [cutoff]);
  console.log(`done: ${samples} samples, ${detections} events detected, ${scored} resolved`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
