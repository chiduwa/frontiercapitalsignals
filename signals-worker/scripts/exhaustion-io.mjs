// D1 side of the exhaustion view: the newest market reading the live scanner
// wrote (market_exhaustion_log) and the live record of each exhaustion rule
// (surge_config_status), shaped for the payload. The meaning of every number
// lives in exhaustion-gauge.mjs; this only reads.
import { d1 } from './d1-client.mjs';
import { describeGauge, EXHAUSTION_EVIDENCE, BREADTH_REFERENCE } from './exhaustion-gauge.mjs';

// Measured 2026-09-26 on 4,578 US stocks over ten years of daily bars: no
// version of a volume-climax rule held up in both halves of the history, and
// the best was about -0.8% against the market over ten days. Stated on the page
// so its absence is a finding rather than an omission.
export const STOCK_EXHAUSTION_FINDING = Object.freeze({
  stocksTested: 4578, years: 10,
  note: 'On US stocks, no version of this signal held up in both halves of ten years of daily data (the best was about -0.8% against the market over 10 days), so there are no stock sell warnings.'
});

const parse = (s) => { try { return s ? JSON.parse(s) : []; } catch { return []; } };

export async function loadExhaustion(env, nowMs = Date.now(), query = d1) {
  const [rows, status] = await Promise.all([
    query(env, `SELECT at, scanned, index_coins, breadth, prints_24h, agg_volume_z, market_run72_z, market_ret24_pct,
        prints_json, watch_json, created_at FROM market_exhaustion_log ORDER BY at DESC LIMIT 1`),
    query(env, `SELECT config_id, label, dir, horizon_hours, notifying, decided, accuracy, base_rate, excess_pct, excess_t,
        excess_days, status_note, updated_at FROM surge_config_status WHERE dir = -1`)
  ]);
  const configs = status.map((r) => ({
    id: r.config_id, label: r.label, notifying: !!r.notifying, casts: r.decided, accuracy: r.accuracy, baseRate: r.base_rate,
    excessPct: r.excess_pct, excessT: r.excess_t, days: r.excess_days, note: r.status_note
  }));
  const base = { evidence: EXHAUSTION_EVIDENCE, reference: BREADTH_REFERENCE, stocks: STOCK_EXHAUSTION_FINDING, configs };
  if (!rows.length) return { status: 'awaiting-first-run', ...base };
  const r = rows[0];
  const gauge = {
    scanned: r.scanned, indexCoins: r.index_coins, breadth: r.breadth, prints24h: r.prints_24h,
    aggVolumeZ: r.agg_volume_z, marketRun72Z: r.market_run72_z, marketRet24Pct: r.market_ret24_pct
  };
  const ageHours = (nowMs - Date.parse(r.created_at)) / 3600000;
  return {
    status: Number.isFinite(ageHours) && ageHours <= 3 ? 'live' : 'stale',
    at: r.at, createdAt: r.created_at, ageHours,
    gauge: { ...gauge, ...describeGauge(gauge) },
    prints: parse(r.prints_json), watch: parse(r.watch_json),
    ...base
  };
}
