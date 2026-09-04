// One-time-ish research pass: backtest-seeds intraday_backtest_reliability
// by replaying replayIntradaySignal (worker.js) against ~2 years of real
// Binance.US 15-minute history for the day-trading watchlist. Deliberately
// NOT a daily/resumable job (see .github/workflows/signals-backtest-intraday.yml
// — workflow_dispatch only): each run recomputes the FULL current 2-year
// window fresh and replaces the aggregate row per (symbol, horizon)
// (INSERT OR REPLACE), so there's nothing to resume or budget across runs
// the way the incremental price/hourly-bar backfills need — a fixed,
// bounded 2-year klines fetch per symbol, one pass, done.
//
// Kept deliberately separate from the LIVE intraday_reliability table:
// backtested accuracy on dense, regular Binance candles isn't automatically
// comparable to live accuracy on genuinely irregular real-world ticks
// without its own scrutiny first (not wired into buildIntradayDisplayPayload's
// adaptive-horizon selection this round).
//
// Also pools every scored call's {date, outcome} across the WHOLE
// watchlist per horizon and tests the polarity question this backtest
// itself surfaced (see git history / correlation-research.mjs for the
// full writeup): is a "wrong" call more often wrongOpposite (a genuine
// reversal — the market moved, just not the way the call predicted) or
// wrongFlat (the market never moved enough either way to be right or
// wrong about)? Conditional on a real move happening (correct +
// wrongOpposite), is that move opposite the call's direction significantly
// more than half the time, and does that hold independently in both
// chronological halves of history? A validated finding here goes into
// correlation_research_findings (hypothesis intraday_reversal_${h}min) —
// same table, same guardrail discipline as every other finding in this
// project, not a new one-off table for a single question.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
import { getCryptoMarkets, getFundingMap, CRYPTO_BLOCKLIST, CRYPTO_MIN_MCAP, CRYPTO_MIN_VOLUME, STOCK_WATCHLIST, replayIntradaySignal, chronologicalHalfSplit, isReliabilitySignificant, RELIABILITY_SIGNIFICANCE_Z, hasCrossClassTickerCollision } from '../worker.js';
import { binanceUsExchangeInfo, binanceUsKlines } from './archive.mjs';
import { selectIntradayWatchlist, INTRADAY_HORIZONS_MIN } from './intraday.mjs';
import { d1, chunk } from './d1-client.mjs';

// Same normal-approximation one-proportion test isReliabilitySignificant
// uses internally, exposed here as a raw z-value (not just true/false) so
// the log output can show the actual number, not just a verdict.
function proportionZ(count, total) {
  if (!total) return null;
  const se = Math.sqrt(0.25 / total);
  return (count / total - 0.5) / se;
}

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID } = process.env;
for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID };

// 730 days x 96 (15-min bars/day) = 70,080 bars/symbol -> ~71 requests/symbol
// (Binance's 1000-candle-per-request cap) x 25 watchlist symbols ~= 1775
// requests total, ~9 minutes at the 300ms pacing below. Single pass, no
// resumability needed — see the top-of-file comment for why.
const BACKTEST_WINDOW_DAYS = 730;
const MIN_BARS_TO_SCORE = 100; // a recently-listed symbol with too little real Binance.US history to say anything meaningful

async function main() {
  const now = Date.now();
  const windowStartMs = now - BACKTEST_WINDOW_DAYS * 24 * 3600 * 1000;
  const windowStartIso = new Date(windowStartMs).toISOString();
  const nowIso = new Date(now).toISOString();
  console.log(`backtest-intraday starting: replaying ${BACKTEST_WINDOW_DAYS} days (${windowStartIso} to ${nowIso})`);

  const cryptoRaw = await getCryptoMarkets();
  const cryptoUniverse = cryptoRaw
    .filter((c) => !CRYPTO_BLOCKLIST.has((c.symbol || '').toLowerCase()))
    .filter((c) => !hasCrossClassTickerCollision(c.symbol))
    .filter((c) => (c.market_cap || 0) >= CRYPTO_MIN_MCAP && (c.total_volume || 0) >= CRYPTO_MIN_VOLUME)
    .map((c) => ({ symbol: (c.symbol || '').toUpperCase(), id: c.id }));
  const fundingMap = await getFundingMap();
  const watchlist = selectIntradayWatchlist(cryptoUniverse, fundingMap, STOCK_WATCHLIST).filter((w) => w.assetClass === 'crypto');
  const tradablePairs = await binanceUsExchangeInfo();
  console.log(`watchlist: ${watchlist.length} crypto symbols, ${tradablePairs.size} tradable Binance.US pairs`);

  let ok = 0, skippedNoPair = 0, thin = 0;
  const failed = [];
  const pooledObservations = Object.fromEntries(INTRADAY_HORIZONS_MIN.map((h) => [h, []])); // pooled across the whole watchlist, for the polarity check below
  for (const w of watchlist) {
    const pairSymbol = `${w.symbol}USDT`;
    if (!tradablePairs.has(pairSymbol)) { skippedNoPair++; continue; }
    try {
      const bars = await binanceUsKlines(pairSymbol, '15m', windowStartMs, now);
      if (bars.length < MIN_BARS_TO_SCORE) { thin++; continue; }
      const ticks = bars.map((b) => ({ tick_at: b.ts, price: b.close }));
      const results = replayIntradaySignal(ticks, 'crypto', INTRADAY_HORIZONS_MIN);
      const rows = Object.entries(results)
        .filter(([, r]) => r.total > 0)
        .map(([h, r]) => ({ horizonMinutes: Number(h), correct: r.correct, wrongOpposite: r.wrongOpposite, wrongFlat: r.wrongFlat, total: r.total, accuracy: r.correct / r.total }));
      for (const [h, r] of Object.entries(results)) pooledObservations[h].push(...r.observations);
      if (rows.length) {
        // 11 cols x 9 rows = 99 params, under D1's confirmed 100-bound-
        // param ceiling. INSERT OR REPLACE, not an incremental upsert —
        // each run's accuracy is a fresh computation over the current
        // window, not something to accumulate across runs.
        for (const batch of chunk(rows, 9)) {
          const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?,?,?)').join(',');
          const params = batch.flatMap((r) => ['crypto', w.symbol, r.horizonMinutes, r.correct, r.wrongOpposite, r.wrongFlat, r.total, r.accuracy, windowStartIso, nowIso, nowIso]);
          await d1(env, `INSERT OR REPLACE INTO intraday_backtest_reliability (asset_class, symbol, horizon_minutes, correct, wrong_opposite, wrong_flat, total, accuracy, window_start, window_end, updated_at) VALUES ${placeholders}`, params);
        }
        const summary = Object.fromEntries(rows.map((r) => [r.horizonMinutes, `${r.correct}/${r.total} (${(r.accuracy * 100).toFixed(1)}%), wrongOpposite=${r.wrongOpposite}, wrongFlat=${r.wrongFlat}`]));
        console.log(`${w.symbol}: ${bars.length} bars replayed — ${JSON.stringify(summary)}`);
      } else {
        console.log(`${w.symbol}: ${bars.length} bars replayed, no scoreable calls at any horizon`);
      }
      ok++;
    } catch (e) {
      failed.push(`${w.symbol} (${e.message})`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`backtest-intraday: ok ${ok}, no pair ${skippedNoPair}, thin history ${thin}, failed ${failed.length}`);
  if (failed.length) console.log(`  failures: ${failed.slice(0, 10).join('; ')}${failed.length > 10 ? ` (+${failed.length - 10} more)` : ''}`);

  // Polarity check: conditional on a real move happening (correct +
  // wrongOpposite, excluding wrongFlat), did that move go opposite the
  // call's direction significantly more than half the time — pooled
  // across the whole watchlist, and independently confirmed in both
  // chronological halves of history, same as every other finding in this
  // project has to clear (see correlation-research.mjs).
  console.log('\n--- intraday polarity check: is a "wrong" call more often a reversal, or just a flat market? ---');
  const findings = [];
  for (const h of INTRADAY_HORIZONS_MIN) {
    const obs = pooledObservations[h];
    const correct = obs.filter((o) => o.outcome === 'correct').length;
    const wrongOpposite = obs.filter((o) => o.outcome === 'wrongOpposite').length;
    const wrongFlat = obs.filter((o) => o.outcome === 'wrongFlat').length;
    const directional = correct + wrongOpposite; // excludes wrongFlat — only counts calls scored against a real (non-flat) move
    const pooledZ = proportionZ(wrongOpposite, directional);
    console.log(`[intraday_reversal_${h}min] pooled: total=${obs.length}, correct=${correct}, wrongOpposite=${wrongOpposite}, wrongFlat=${wrongFlat}, directional=${directional}, reversalRate=${directional ? (100 * wrongOpposite / directional).toFixed(1) : 'n/a'}%, z=${pooledZ?.toFixed(3) ?? 'n/a'} (bar=${RELIABILITY_SIGNIFICANCE_Z})`);
    if (!directional || !isReliabilitySignificant(wrongOpposite, directional) || pooledZ <= 0) {
      console.log(`[intraday_reversal_${h}min] does not clear the pooled significance bar in the reversal direction — no finding`);
      continue;
    }

    const { firstHalf, secondHalf } = chronologicalHalfSplit(obs.map((o) => o.date));
    const splitStats = (half) => {
      const halfObs = obs.filter((o) => half.has(o.date));
      const c = halfObs.filter((o) => o.outcome === 'correct').length;
      const wo = halfObs.filter((o) => o.outcome === 'wrongOpposite').length;
      return { wo, dir: c + wo, z: proportionZ(wo, c + wo) };
    };
    const first = splitStats(firstHalf);
    const second = splitStats(secondHalf);
    console.log(`[intraday_reversal_${h}min] first half: directional=${first.dir}, z=${first.z?.toFixed(3) ?? 'n/a'} — second half: directional=${second.dir}, z=${second.z?.toFixed(3) ?? 'n/a'}`);

    const firstOk = isReliabilitySignificant(first.wo, first.dir) && first.z > 0;
    const secondOk = isReliabilitySignificant(second.wo, second.dir) && second.z > 0;
    if (!firstOk || !secondOk) {
      console.log(`[intraday_reversal_${h}min] cleared the pooled bar but did NOT hold up independently, reversal-favoring, in both chronological halves — not recorded as a validated finding`);
      continue;
    }

    console.log(`[intraday_reversal_${h}min] VALIDATED — a real move within ${h} minutes of a call goes opposite the call's direction significantly more often than not, independently in both halves of history`);
    findings.push({
      hypothesis: `intraday_reversal_${h}min`, assetClass: 'crypto', horizonDays: null, n: directional,
      effectSize: wrongOpposite / directional - 0.5, z: pooledZ,
      notes: `pooled reversalRate=${(100 * wrongOpposite / directional).toFixed(1)}%, z=${pooledZ.toFixed(3)}; first-half z=${first.z.toFixed(3)}, n=${first.dir}; second-half z=${second.z.toFixed(3)}, n=${second.dir}; wrongFlat excluded from this rate (${wrongFlat} of ${obs.length} total observations)`
    });
  }

  if (findings.length) {
    for (const f of findings) {
      await d1(env, `
        INSERT INTO correlation_research_findings (hypothesis, asset_class, horizon_days, n, effect_size, z, split_consistent, computed_at, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [f.hypothesis, f.assetClass, f.horizonDays, f.n, f.effectSize, f.z, 1, nowIso, f.notes]);
    }
    console.log(`\n${findings.length} validated polarity finding(s) written to correlation_research_findings`);
  } else {
    console.log('\nno polarity finding cleared both guardrails — nothing written (a complete, valid research outcome)');
  }
}

main().catch((e) => { console.error('backtest-intraday failed:', e); process.exit(1); });
