// Forward-looking surge scanner: the "tell me BEFORE it moves" half of the
// 2026-09-01 request, built to the evidence rather than to the hope.
//
// Read worker.js's SURGE_CONFIGS docs first. The short version: the naive
// reading of the retrospective's volume tell — big spike means get in — is
// not weak, it is inverted. Measured over 176K hourly observations, mean
// forward return falls monotonically as the spike grows, reaching roughly
// -3% at 20x. The only configuration that survived both the significance
// bar and the chronological-half split is an EXHAUSTION warning, and that
// is the only one allowed to notify on day one.
//
// The other two configurations are unproven and deliberately kept anyway.
// They are cast, logged and scored on live forward data every hour, and
// they stay silent until their own real record clears the bar. That is the
// "learn from all findings automatically" part of the request done
// honestly: a candidate earns the right to interrupt you, it is not
// granted it because a backtest liked it.
//
// Notification gate (surgeNotifyGate, worker.js), in order:
//   proven at discovery                  -> notifies, until its live record
//                                           trails the same-window market
//                                           (day-clustered t <= -2)
//   beats the same-window market in its
//     called direction, t >= 2 over >= 30
//     casts and >= 10 days               -> notifies (graduated)
//   otherwise                             -> logged, silent
// Until 2026-09-24 the bar was a coin flip, which a rally clears for any
// long call: two configurations graduated on market drift (MISSED_MOVES.md).
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
// Optional env: NTFY_TOPIC, LIVE_SCAN_SYMBOLS, LIVE_SCAN_MAX_ALERTS
// Invoked hourly by .github/workflows/signals-live-scan.yml.
import { d1, chunk, forEachConcurrent, readAllRows } from './d1-client.mjs';
import {
  binanceGlobalTradablePairs, binanceGlobalKlines,
  SURGE_CONFIGS, scanSurgeConfigs, scoreSurgeCast, lowerConfidenceBound,
  marketWindow, surgeExcessRecord, surgeNotifyGate, FAVORITE_SYMBOLS
} from '../worker.js';
import {
  recentPrints, latestReading, marketGauge, describeGauge, exhaustionAlertBody, hourLabel
} from './exhaustion-gauge.mjs';
import { formatPct } from './price-change.mjs';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID, NTFY_TOPIC } = process.env;
for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID, NTFY_TOPIC };
// LIVE_SCAN_DRY_RUN=1 reads everything and writes nothing: no casts, no
// scoring, no gauge row, no pushes. What it would have sent is printed.
const DRY_RUN = process.env.LIVE_SCAN_DRY_RUN === '1';

// How many symbols to scan. Wider than the ranked universe on purpose:
// the retrospective's standing finding is that ~80% of missed moves were
// assets never fetched at all, and this scanner is not bound by the
// CoinGecko page size that causes it.
const MAX_SYMBOLS = Number(process.env.LIVE_SCAN_SYMBOLS || 500);
// 1000 hours: the per-coin calibration needs 30 days (720h) behind the bar it
// scores, plus the last day of bars the gauge reads, plus slack. One request
// per coin either way; Binance serves up to 1000 bars per call.
const BARS = 1000;
const FETCH_CONCURRENCY = 4;
// A per-coin print on a coin you do not hold is announced only when it is this
// extreme AND the 20x rule did not already cover it: about 1.6 new alerts a
// day across the market, measured at -3.2% vs the market over 24h.
const CALIBRATED_BROADCAST_VOLZ = 4;
// A cap on how much this can interrupt you in one run, worst case. The
// proven configuration fires on well under 1% of bars, but a market-wide
// blowoff could light up many symbols at once, and forty pushes in a
// minute is indistinguishable from no alerting at all.
const MAX_ALERTS = Number(process.env.LIVE_SCAN_MAX_ALERTS || 6);
// Graduation thresholds live with the gate: SURGE_MIN_BASELINE_* in worker.js.
const PACING_MS = 120;

async function notify({ title, message, priority = 'default', tags = [] }) {
  if (DRY_RUN) { console.log(`\n[dry run] would push (${priority}) ${title}\n${message}\n`); return false; }
  if (!NTFY_TOPIC) return false;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8', Title: title, Priority: priority,
        ...(tags.length ? { Tags: tags.join(',') } : {}),
        Click: 'https://frontiercapitalsignals.com/signals/'
      },
      body: message, signal: ctrl.signal
    });
    return true;
  } catch (e) {
    console.error('ntfy failed (non-fatal):', e.message || e);
    return false;
  } finally { clearTimeout(t); }
}

// Score every cast whose horizon has elapsed, against the price now. Runs
// before casting so a config's record is as current as possible when the
// notification gate reads it.
async function scoreMatured(nowIso, priceBySymbol, closesBySymbol) {
  const due = await d1(env, `
    SELECT id, config_id, symbol, dir, cast_at, entry_price, horizon_hours
      FROM surge_signal_log
     WHERE outcome IS NULL
       AND datetime(cast_at, '+' || horizon_hours || ' hours') <= datetime(?)`, [nowIso]);
  if (!due.length) { console.log('no casts matured this run'); return 0; }
  let scored = 0;
  await forEachConcurrent(chunk(due, 15), 3, async (batch) => {
    for (const row of batch) {
      const exit = priceBySymbol[row.symbol];
      // No current price means the symbol stopped trading or was not in
      // this run's scan set. Leave it unscored rather than inventing an
      // exit — it will resolve on a later run, or stay honestly open.
      if (!exit) continue;
      const r = scoreSurgeCast(row.dir, row.entry_price, exit, 1);
      if (!r) continue;
      // What every scanned coin did over the same hours: the bar a call has
      // to beat, not a coin flip.
      const mw = marketWindow(closesBySymbol, row.cast_at, priceBySymbol, row.dir);
      await d1(env, `UPDATE surge_signal_log SET outcome = ?, exit_price = ?, move_pct = ?, scored_at = ?,
          market_move_pct = ?, base_rate = ?, market_n = ? WHERE id = ?`,
        [r.outcome, exit, r.pct, nowIso, mw?.marketMovePct ?? null, mw?.baseRate ?? null, mw?.n ?? null, row.id]);
      scored++;
    }
  });
  console.log(`scored ${scored} matured cast(s)`);
  return scored;
}

// A configuration's own live, forward-tested record. Deliberately NOT the
// backtest — the backtest is what has to be proven, not what proves.
async function loadLiveRecords() {
  const rows = await d1(env, `
    SELECT config_id,
           SUM(outcome = 'correct') AS correct,
           SUM(outcome = 'wrong')   AS wrong,
           SUM(outcome = 'flat')    AS flat,
           COUNT(*)                 AS total,
           AVG(move_pct)            AS avg_move
      FROM surge_signal_log
     WHERE outcome IS NOT NULL
     GROUP BY config_id`);
  const scored = await readAllRows(env, `SELECT config_id, dir, move_pct, market_move_pct, base_rate, outcome, cast_at
      FROM surge_signal_log WHERE outcome IS NOT NULL ORDER BY id`);
  const out = {};
  for (const r of rows) {
    const decided = (r.correct || 0) + (r.wrong || 0);
    const acc = decided ? r.correct / decided : null;
    out[r.config_id] = {
      correct: r.correct || 0, wrong: r.wrong || 0, flat: r.flat || 0,
      total: r.total, decided, accuracy: acc, avgMove: r.avg_move,
      // The project's existing one-sided Wilson lower bound, reused rather
      // than reimplemented — the same "prove it, do not merely look good"
      // test assetPredictionScore already applies to every other call.
      lowerBound: decided ? lowerConfidenceBound(r.correct, decided) : null,
      excess: surgeExcessRecord(scored.filter((x) => x.config_id === r.config_id))
    };
  }
  return out;
}

function mayNotify(cfg, rec) {
  return surgeNotifyGate(cfg, rec?.excess);
}

// Coins you hold or always track. Favorites are fixed in worker.js; anything
// the spot bot has bought is added from its own fill log, so a coin it holds
// gets a sell warning without anyone having to remember to list it.
async function loadWatchSet() {
  const watch = new Set(FAVORITE_SYMBOLS);
  try {
    const rows = await d1(env, 'SELECT DISTINCT symbol FROM spot_bot_fills');
    for (const r of rows) watch.add(String(r.symbol || '').toUpperCase().replace(/USDT$/, ''));
  } catch (e) {
    console.log(`watch set: spot-bot fills unavailable (${e.message}); favorites only`);
  }
  watch.delete('');
  return watch;
}

async function fetchAllBars(pairs) {
  const out = {};
  await forEachConcurrent(pairs, FETCH_CONCURRENCY, async (sym) => {
    try { out[sym] = await binanceGlobalKlines(sym, '1h', BARS); }
    catch { /* a coin the venue would not serve this run simply sits it out */ }
    await new Promise((r) => setTimeout(r, PACING_MS));
  });
  return out;
}

async function main() {
  const nowIso = new Date().toISOString();
  const pairs = [...await binanceGlobalTradablePairs()]
    .filter((s) => !/^(USD|BUSD|TUSD|FDUSD|EUR|DAI|GBP|AEUR)/.test(s))
    .filter((s) => /^[A-Z0-9]+$/.test(s))
    .slice(0, MAX_SYMBOLS);
  console.log(`live-scan: ${pairs.length} symbols on Binance global`);
  const watch = await loadWatchSet();

  const barsBySymbol = await fetchAllBars(pairs);
  const priceBySymbol = {};
  const closesBySymbol = {};
  const printsBySymbol = {};
  const fired = [];
  for (const [sym, bars] of Object.entries(barsBySymbol)) {
    if (!bars.length) continue;
    priceBySymbol[sym] = bars[bars.length - 1].close;
    closesBySymbol[sym] = new Map(bars.map((b) => [b.openTime, b.close]));
    for (const hit of scanSurgeConfigs(bars)) fired.push({ symbol: sym, ...hit });
    printsBySymbol[sym] = recentPrints(sym, bars);
  }
  const scanned = Object.keys(priceBySymbol).length;
  console.log(`live-scan: scanned ${scanned}, ${fired.length} configuration hit(s)`);

  if (!DRY_RUN) await scoreMatured(nowIso, priceBySymbol, closesBySymbol);
  const records = await loadLiveRecords();

  // Log every cast, proven or not. This IS the learning loop — an unproven
  // configuration can only ever earn its way in by accumulating a real
  // forward record, and it cannot accumulate one if it is not cast.
  if (fired.length && !DRY_RUN) {
    await forEachConcurrent(chunk(fired, 10), 3, async (batch) => {
      for (const f of batch) {
        await d1(env, `
          INSERT INTO surge_signal_log
            (config_id, symbol, dir, cast_at, entry_price, horizon_hours, ratio, trade_ratio, bar_pct, liquidity, notified,
             vol_z, bar_z, run24_z, liquidity_30d)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(config_id, symbol, cast_at) DO NOTHING`,
          [f.config.id, f.symbol, f.config.dir, f.features.at, f.features.close, f.config.horizonHours,
           f.features.ratio, f.features.tradeRatio, f.features.barPct, f.features.liquidity, 0,
           f.features.volZ, f.features.barZ, f.features.run24Z, f.features.liquidity30d]);
      }
    });
  }

  // The market-wide reading and the recent prints behind it, for the
  // dashboard. Never an alert: see exhaustion-gauge.mjs for why.
  try {
    const gauge = marketGauge(barsBySymbol, printsBySymbol);
    const state = describeGauge(gauge);
    const prints = Object.values(printsBySymbol).flat()
      .filter((p) => p.configs.length)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : (b.volZ ?? 0) - (a.volZ ?? 0)))
      .slice(0, 60)
      .map((p) => ({ ...p, moveSincePct: priceBySymbol[p.symbol] && p.close > 0 ? (priceBySymbol[p.symbol] / p.close - 1) * 100 : null }));
    const watchRows = [...watch].sort().map((sym) => {
      const bars = barsBySymbol[sym];
      if (!bars || !bars.length) return { symbol: sym, onVenue: false };
      const reading = latestReading(sym, bars);
      const last = recentPrints(sym, bars, { lookback: 72 }).find((p) => p.configs.length) || null;
      return { ...reading, onVenue: true, lastPrint: last, moveSinceLastPrintPct: last && last.close > 0 ? (bars[bars.length - 1].close / last.close - 1) * 100 : null };
    });
    if (DRY_RUN) console.log('[dry run] gauge', JSON.stringify(gauge), JSON.stringify(state), `\n[dry run] ${prints.length} prints, e.g.`, JSON.stringify(prints.slice(0, 3)), '\n[dry run] watch', JSON.stringify(watchRows));
    else await d1(env, `
      INSERT INTO market_exhaustion_log
        (at, scanned, index_coins, breadth, prints_24h, agg_volume_z, market_run72_z, market_ret24_pct, state, prints_json, watch_json, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(at) DO UPDATE SET scanned=excluded.scanned, index_coins=excluded.index_coins, breadth=excluded.breadth,
        prints_24h=excluded.prints_24h, agg_volume_z=excluded.agg_volume_z, market_run72_z=excluded.market_run72_z,
        market_ret24_pct=excluded.market_ret24_pct, state=excluded.state, prints_json=excluded.prints_json,
        watch_json=excluded.watch_json, created_at=excluded.created_at`,
      [gauge.at, gauge.scanned, gauge.indexCoins, gauge.breadth, gauge.prints24h, gauge.aggVolumeZ, gauge.marketRun72Z,
       gauge.marketRet24Pct, state.state, JSON.stringify(prints), JSON.stringify(watchRows), nowIso]);
    console.log(`market gauge at ${gauge.at}: ${state.state} — breadth ${gauge.breadth != null ? (gauge.breadth * 100).toFixed(1) + '%' : 'n/a'} of ${gauge.scanned}, `
      + `aggregate volume z ${gauge.aggVolumeZ?.toFixed(2) ?? 'n/a'}, market 72h run z ${gauge.marketRun72Z?.toFixed(2) ?? 'n/a'}; ${prints.length} recent print(s); watching ${watchRows.length}`);
  } catch (e) {
    console.error('market gauge failed (casts and alerts unaffected):', e.message || e);
  }

  // Notify, gated. The 20x rule behaves exactly as before. The per-coin rule
  // speaks for coins you hold or always track, and elsewhere only for the most
  // extreme prints the 20x rule did not already cover, so one hour never
  // produces two pushes for the same coin.
  let sent = 0;
  const byConfig = {};
  for (const f of fired) (byConfig[f.config.id] ??= []).push(f);
  const e20Syms = new Set((byConfig.exhaustion20 || []).map((h) => h.symbol));
  const calSyms = new Set((byConfig.exhaustion_calibrated || []).map((h) => h.symbol));
  for (const cfg of SURGE_CONFIGS) {
    let hits = byConfig[cfg.id] || [];
    const gate = mayNotify(cfg, records[cfg.id]);
    if (cfg.id === 'exhaustion_calibrated') {
      hits = hits.filter((h) => !e20Syms.has(h.symbol) && (watch.has(h.symbol) || h.features.volZ >= CALIBRATED_BROADCAST_VOLZ));
    }
    console.log(`  ${cfg.id.padEnd(21)} ${String((byConfig[cfg.id] || []).length).padStart(3)} hit(s), ${String(hits.length).padStart(3)} eligible  ${gate.allowed ? 'NOTIFY' : 'silent'} — ${gate.why}`);
    if (!gate.allowed || !hits.length) continue;
    // Coins you hold first, then the most extreme print.
    const key = (h) => (watch.has(h.symbol) ? 1e9 : 0) + (cfg.id === 'exhaustion_calibrated' ? (h.features.volZ ?? 0) : h.features.ratio);
    const top = hits.sort((a, b) => key(b) - key(a)).slice(0, MAX_ALERTS - sent);
    for (const h of top) {
      const bars = barsBySymbol[h.symbol];
      const exhaustion = cfg.dir === -1;
      const message = exhaustion && bars
        ? exhaustionAlertBody(h, bars, gate.why, {
            rulesFired: [e20Syms.has(h.symbol) && 'exhaustion20', calSyms.has(h.symbol) && 'exhaustion_calibrated'].filter(Boolean)
          })
        : `${h.symbol} just printed ${h.features.ratio.toFixed(1)}x its 48h median hourly volume`
          + `${h.features.tradeRatio != null ? ` on ${h.features.tradeRatio.toFixed(1)}x the trades` : ''}`
          + `; the ${hourLabel(h.features.at)} closed ${formatPct(h.features.barPct)} (open to close).\n\n`
          + `Read: strength ahead over ~${cfg.horizonHours}h. ${cfg.note}\n\nBasis: ${gate.why}. Not financial advice.`;
      const held = watch.has(h.symbol);
      const ok = await notify({
        title: `${h.symbol}: ${exhaustion ? (held ? 'sell warning, ' : '') + cfg.label.toLowerCase() : cfg.label}`,
        message,
        priority: exhaustion ? 'high' : 'default',
        tags: [exhaustion ? 'warning' : 'chart_with_upwards_trend']
      });
      if (ok) {
        sent++;
        await d1(env, 'UPDATE surge_signal_log SET notified = 1 WHERE config_id = ? AND symbol = ? AND cast_at = ?',
          [cfg.id, h.symbol, h.features.at]);
      }
      if (sent >= MAX_ALERTS) break;
    }
    if (sent >= MAX_ALERTS) break;
  }

  // Roll up each configuration's standing so the dashboard and any human
  // reading D1 can see what is proving out and what is not.
  for (const cfg of DRY_RUN ? [] : SURGE_CONFIGS) {
    const r = records[cfg.id];
    const gate = mayNotify(cfg, r);
    await d1(env, `
      INSERT INTO surge_config_status
        (config_id, label, dir, horizon_hours, proven_at_discovery, correct, wrong, flat, decided, accuracy, lower_bound, avg_move_pct, notifying, status_note, updated_at,
         excess_pct, excess_t, excess_days, base_rate)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(config_id) DO UPDATE SET
        label=excluded.label, dir=excluded.dir, horizon_hours=excluded.horizon_hours,
        proven_at_discovery=excluded.proven_at_discovery, correct=excluded.correct, wrong=excluded.wrong,
        flat=excluded.flat, decided=excluded.decided, accuracy=excluded.accuracy, lower_bound=excluded.lower_bound,
        avg_move_pct=excluded.avg_move_pct, notifying=excluded.notifying, status_note=excluded.status_note,
        updated_at=excluded.updated_at, excess_pct=excluded.excess_pct, excess_t=excluded.excess_t,
        excess_days=excluded.excess_days, base_rate=excluded.base_rate`,
      [cfg.id, cfg.label, cfg.dir, cfg.horizonHours, cfg.proven ? 1 : 0,
       r ? r.correct : 0, r ? r.wrong : 0, r ? r.flat : 0, r ? r.decided : 0,
       r ? r.accuracy : null, r ? r.lowerBound : null, r ? r.avgMove : null,
       gate.allowed ? 1 : 0, gate.why, nowIso,
       r?.excess?.meanExcessPct ?? null, r?.excess?.t ?? null, r?.excess?.days ?? null, r?.excess?.baseRate ?? null]);
  }

  console.log(`\nlive-scan: ${fired.length} cast(s) ${DRY_RUN ? "found (dry run: nothing written)" : "logged"}, ${sent} notification(s) sent`);
}

main().catch((e) => { console.error('live-scan failed:', e); process.exit(1); });
