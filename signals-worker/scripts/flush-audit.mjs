// Audits the flush_event rows against oi_tick, instead of clearing them.
//
// Those rows were written by a detector that classified moves on
// sum_open_interest_value — contracts multiplied by mark price. A price move
// shows up in that column whether or not a single contract changed hands, so
// the "open interest confirmation" in every one of those alerts was very
// nearly the price move restated. docs/OI_MEASUREMENT_EVIDENCE.md establishes
// that on 804,082 historical bars from a separate data source.
//
// The rows are still worth keeping, for one reason: oi_tick stores
// oi_contracts, oi_usd and mark_price side by side at the same timestamps, so
// the two measurements can be compared over the identical window on this
// project's own live production data. That makes these rows an independent
// replication of the historical finding rather than a record of a mistake.
//
// Read-only by default. --write annotates notes with the corrected
// measurement and never touches the original columns, so the rows stay
// exactly as the detector wrote them.
import { d1 } from './d1-client.mjs';
// One source of truth for the cut and the classification. oi-sampler.mjs owns
// both; duplicating them here is how the two would drift apart.
import { classifyMove, OI_DECISIVE_CONTRACTS_PCT } from './oi-sampler.mjs';

// How far back the comparison window reaches from each detection.
export const WINDOW_MS = 300000;

// Pure, so the numbers below can be regression-tested without a network.
export function compareMeasures(rows) {
  const usable = rows.filter((r) =>
    [r.c0, r.c1, r.u0, r.u1, r.p0, r.p1].every((v) => Number.isFinite(v) && v > 0));
  if (!usable.length) return { n: 0 };

  const pct = (a, b) => (b / a - 1) * 100;
  const c = usable.map((r) => pct(r.c0, r.c1));
  const u = usable.map((r) => pct(r.u0, r.u1));
  const p = usable.map((r) => pct(r.p0, r.p1));

  const corr = (x, y) => {
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < x.length; i++) { sxy += x[i] * y[i]; sxx += x[i] * x[i]; syy += y[i] * y[i]; }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
  };
  const share = (fn) => usable.reduce((a, _, i) => a + (fn(i) ? 1 : 0), 0) / usable.length;
  const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;

  return {
    n: usable.length,
    corrNotionalPrice: corr(u, p),
    corrContractsPrice: corr(c, p),
    notionalTracksPriceSign: share((i) => (u[i] > 0) === (p[i] > 0)),
    contractsTracksPriceSign: share((i) => (c[i] > 0) === (p[i] > 0)),
    meanAbsNotional: mean(u.map(Math.abs)),
    meanAbsContracts: mean(c.map(Math.abs)),
    signDisagreement: share((i) => (c[i] > 0) !== (u[i] > 0)),
    // The detector keyed its event id off the first tick of a sliding window,
    // so one move produced a row per sample. Episodes are what actually
    // happened; rows are how often it said so.
    rows: rows.length,
    episodes: new Set(rows.map((r) => `${r.symbol}|${r.direction}|${r.ref_price}`)).size
  };
}

// The classification the detector should have reached, given contracts.
// Direction does not enter it: open interest rising is new positioning and
// falling is positions being closed, whichever way price went.
export { OI_DECISIVE_CONTRACTS_PCT };

const SELECT = `
  SELECT e.id, e.symbol, e.direction, e.first_ts, e.ref_price, e.move_pct,
         e.oi_change_pct AS logged_oi_change_pct, e.classification, e.fwd_1h_pct, e.notes,
    (SELECT oi_contracts FROM oi_tick t WHERE t.symbol=e.symbol AND t.ts<=e.first_ts            ORDER BY t.ts DESC LIMIT 1) c1,
    (SELECT oi_contracts FROM oi_tick t WHERE t.symbol=e.symbol AND t.ts<=e.first_ts-?          ORDER BY t.ts DESC LIMIT 1) c0,
    (SELECT oi_usd       FROM oi_tick t WHERE t.symbol=e.symbol AND t.ts<=e.first_ts            ORDER BY t.ts DESC LIMIT 1) u1,
    (SELECT oi_usd       FROM oi_tick t WHERE t.symbol=e.symbol AND t.ts<=e.first_ts-?          ORDER BY t.ts DESC LIMIT 1) u0,
    (SELECT mark_price   FROM oi_tick t WHERE t.symbol=e.symbol AND t.ts<=e.first_ts            ORDER BY t.ts DESC LIMIT 1) p1,
    (SELECT mark_price   FROM oi_tick t WHERE t.symbol=e.symbol AND t.ts<=e.first_ts-?          ORDER BY t.ts DESC LIMIT 1) p0
  FROM flush_event e ORDER BY e.first_ts`;

export async function auditFlushEvents(env, { write = false } = {}) {
  const res = await d1(env, SELECT, [WINDOW_MS, WINDOW_MS, WINDOW_MS]);
  const rows = res?.[0]?.results ?? [];
  const summary = compareMeasures(rows);

  if (write) {
    // Additive only: the original columns are the detector's record and are
    // left alone. A second run overwrites its own annotation, not the row.
    const stmts = rows
      .filter((r) => Number.isFinite(r.c0) && r.c0 > 0 && Number.isFinite(r.c1))
      .map((r) => {
        const contracts = (r.c1 / r.c0 - 1) * 100;
        let prior = {};
        try { prior = r.notes ? JSON.parse(r.notes) : {}; } catch { prior = { unparsed: r.notes }; }
        const notes = JSON.stringify({
          ...prior,
          audit: {
            version: 'flush-audit-v1',
            contractsChangePct: Number(contracts.toPrecision(6)),
            loggedWasNotional: true,
            correctedClassification: classifyMove(contracts),
            note: 'logged oi_change_pct measured USD notional, which carries the price move; see docs/OI_MEASUREMENT_EVIDENCE.md'
          }
        });
        return { sql: 'UPDATE flush_event SET notes=? WHERE id=?', params: [notes, r.id] };
      });
    for (const s of stmts) await d1(env, s.sql, s.params);
    summary.annotated = stmts.length;
  }
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes('--write');
  const env = process.env;
  for (const k of ['CLOUDFLARE_ACCOUNT_ID', 'FCS_D1_DATABASE_ID', 'CLOUDFLARE_API_TOKEN']) {
    if (!env[k]) { console.error(`missing ${k}`); process.exit(1); }
  }
  const s = await auditFlushEvents(env, { write });
  const pc = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : 'n/a');
  console.log(`flush_event audit: ${s.rows} rows, ${s.episodes} episodes, ${s.n} comparable`);
  console.log(`  corr(notional OI, price)  ${s.corrNotionalPrice?.toFixed(3)}   sign match ${pc(s.notionalTracksPriceSign)}`);
  console.log(`  corr(contracts OI, price) ${s.corrContractsPrice?.toFixed(3)}   sign match ${pc(s.contractsTracksPriceSign)}`);
  console.log(`  mean |change|  notional ${s.meanAbsNotional?.toFixed(3)}%  contracts ${s.meanAbsContracts?.toFixed(3)}%`);
  console.log(`  the two columns disagree on sign ${pc(s.signDisagreement)}`);
  if (write) console.log(`  annotated ${s.annotated} rows`);
}
