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
// Notification gate, in order:
//   proven at discovery                  -> notifies
//   >= MIN_LIVE_SAMPLES live casts and
//     Wilson lower bound > flat-rate      -> notifies (graduated)
//   otherwise                             -> logged, silent
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
// Optional env: NTFY_TOPIC, LIVE_SCAN_SYMBOLS, LIVE_SCAN_MAX_ALERTS
// Invoked hourly by .github/workflows/signals-live-scan.yml.
import { d1, chunk, forEachConcurrent } from './d1-client.mjs';
import {
  binanceGlobalTradablePairs, binanceGlobalKlines,
  SURGE_CONFIGS, scanSurgeConfigs, scoreSurgeCast, lowerConfidenceBound
} from '../worker.js';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID, NTFY_TOPIC } = process.env;
for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID, NTFY_TOPIC };

// How many symbols to scan. Wider than the ranked universe on purpose:
// the retrospective's standing finding is that ~80% of missed moves were
// assets never fetched at all, and this scanner is not bound by the
// CoinGecko page size that causes it.
const MAX_SYMBOLS = Number(process.env.LIVE_SCAN_SYMBOLS || 250);
// A cap on how much this can interrupt you in one run, worst case. The
// proven configuration fires on well under 1% of bars, but a market-wide
// blowoff could light up many symbols at once, and forty pushes in a
// minute is indistinguishable from no alerting at all.
const MAX_ALERTS = Number(process.env.LIVE_SCAN_MAX_ALERTS || 6);
// Before a candidate may graduate to notifying. Matches the project's
// existing MIN_RELIABILITY_SAMPLES discipline.
const MIN_LIVE_SAMPLES = 30;
const PACING_MS = 120;

async function notify({ title, message, priority = 'default', tags = [] }) {
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
async function scoreMatured(nowIso, priceBySymbol) {
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
      await d1(env, 'UPDATE surge_signal_log SET outcome = ?, exit_price = ?, move_pct = ?, scored_at = ? WHERE id = ?',
        [r.outcome, exit, r.pct, nowIso, row.id]);
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
      lowerBound: decided ? lowerConfidenceBound(r.correct, decided) : null
    };
  }
  return out;
}

function mayNotify(cfg, rec) {
  if (cfg.proven) return { allowed: true, why: 'proven at discovery (significant and consistent across both chronological halves)' };
  if (!rec || rec.decided < MIN_LIVE_SAMPLES) {
    return { allowed: false, why: `still proving itself — ${rec ? rec.decided : 0}/${MIN_LIVE_SAMPLES} scored casts` };
  }
  if (rec.lowerBound != null && rec.lowerBound > 0.5) {
    return { allowed: true, why: `graduated on live evidence — ${(rec.accuracy * 100).toFixed(0)}% over ${rec.decided} scored casts, lower bound ${(rec.lowerBound * 100).toFixed(0)}%` };
  }
  return { allowed: false, why: `live record does not clear a coin flip — ${(rec.accuracy * 100).toFixed(0)}% over ${rec.decided}, lower bound ${(rec.lowerBound * 100).toFixed(0)}%` };
}

async function main() {
  const nowIso = new Date().toISOString();
  const pairs = [...await binanceGlobalTradablePairs()]
    .filter((s) => !/^(USD|BUSD|TUSD|FDUSD|EUR|DAI|GBP|AEUR)/.test(s))
    .slice(0, MAX_SYMBOLS);
  console.log(`live-scan: ${pairs.length} symbols on Binance global`);

  const priceBySymbol = {};
  const fired = [];
  let scanned = 0;
  for (const sym of pairs) {
    let bars;
    try { bars = await binanceGlobalKlines(sym, '1h', 200); }
    catch { await new Promise((r) => setTimeout(r, PACING_MS)); continue; }
    if (bars.length) priceBySymbol[sym] = bars[bars.length - 1].close;
    scanned++;
    for (const hit of scanSurgeConfigs(bars)) fired.push({ symbol: sym, ...hit });
    await new Promise((r) => setTimeout(r, PACING_MS));
  }
  console.log(`live-scan: scanned ${scanned}, ${fired.length} configuration hit(s)`);

  await scoreMatured(nowIso, priceBySymbol);
  const records = await loadLiveRecords();

  // Log every cast, proven or not. This IS the learning loop — an unproven
  // configuration can only ever earn its way in by accumulating a real
  // forward record, and it cannot accumulate one if it is not cast.
  if (fired.length) {
    await forEachConcurrent(chunk(fired, 10), 3, async (batch) => {
      for (const f of batch) {
        await d1(env, `
          INSERT INTO surge_signal_log
            (config_id, symbol, dir, cast_at, entry_price, horizon_hours, ratio, trade_ratio, bar_pct, liquidity, notified)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(config_id, symbol, cast_at) DO NOTHING`,
          [f.config.id, f.symbol, f.config.dir, f.features.at, f.features.close, f.config.horizonHours,
           f.features.ratio, f.features.tradeRatio, f.features.barPct, f.features.liquidity, 0]);
      }
    });
  }

  // Notify, gated.
  let sent = 0;
  const byConfig = {};
  for (const f of fired) (byConfig[f.config.id] ??= []).push(f);
  for (const cfg of SURGE_CONFIGS) {
    const hits = byConfig[cfg.id] || [];
    const gate = mayNotify(cfg, records[cfg.id]);
    console.log(`  ${cfg.id.padEnd(14)} ${String(hits.length).padStart(3)} hit(s)  ${gate.allowed ? 'NOTIFY' : 'silent'} — ${gate.why}`);
    if (!gate.allowed || !hits.length) continue;
    // Loudest first: the biggest ratio on the deepest book is the most
    // informative instance of whatever the configuration is describing.
    const top = hits.sort((a, b) => b.features.ratio - a.features.ratio).slice(0, MAX_ALERTS - sent);
    for (const h of top) {
      const dirWord = cfg.dir === -1 ? 'weakness ahead' : 'strength ahead';
      const ok = await notify({
        title: `${h.symbol}: ${cfg.label}`,
        message: `${h.symbol} just printed ${h.features.ratio.toFixed(1)}x its 48h median hourly volume`
          + `${h.features.tradeRatio != null ? ` on ${h.features.tradeRatio.toFixed(1)}x the trades` : ''}`
          + `, bar ${h.features.barPct >= 0 ? '+' : ''}${h.features.barPct.toFixed(1)}%.\n\n`
          + `Read: ${dirWord} over ~${cfg.horizonHours}h. ${cfg.note}\n\n`
          + `Basis: ${gate.why}. Not financial advice.`,
        priority: cfg.dir === -1 ? 'high' : 'default',
        tags: [cfg.dir === -1 ? 'warning' : 'chart_with_upwards_trend']
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
  for (const cfg of SURGE_CONFIGS) {
    const r = records[cfg.id];
    const gate = mayNotify(cfg, r);
    await d1(env, `
      INSERT INTO surge_config_status
        (config_id, label, dir, horizon_hours, proven_at_discovery, correct, wrong, flat, decided, accuracy, lower_bound, avg_move_pct, notifying, status_note, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(config_id) DO UPDATE SET
        label=excluded.label, dir=excluded.dir, horizon_hours=excluded.horizon_hours,
        proven_at_discovery=excluded.proven_at_discovery, correct=excluded.correct, wrong=excluded.wrong,
        flat=excluded.flat, decided=excluded.decided, accuracy=excluded.accuracy, lower_bound=excluded.lower_bound,
        avg_move_pct=excluded.avg_move_pct, notifying=excluded.notifying, status_note=excluded.status_note,
        updated_at=excluded.updated_at`,
      [cfg.id, cfg.label, cfg.dir, cfg.horizonHours, cfg.proven ? 1 : 0,
       r ? r.correct : 0, r ? r.wrong : 0, r ? r.flat : 0, r ? r.decided : 0,
       r ? r.accuracy : null, r ? r.lowerBound : null, r ? r.avgMove : null,
       gate.allowed ? 1 : 0, gate.why, nowIso]);
  }

  console.log(`\nlive-scan: ${fired.length} cast(s) logged, ${sent} notification(s) sent`);
}

main().catch((e) => { console.error('live-scan failed:', e); process.exit(1); });
