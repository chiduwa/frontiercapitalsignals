// Reads the replayed ledger and answers the only question that matters:
// does the composite model beat its own no-skill baseline?
//
// WHY NOT JUST AVG(correct)
//
// Two traps, both of which this engine has fallen into before and both of which
// make a useless model look informative:
//
// 1. THE BASELINE IS NOT 0.5. Outcomes are three-way (up / flat / down, the
//    0.5% deadband) while a technique only ever votes +1 or -1, so a flat
//    outcome marks an up-call AND a down-call wrong. A coin-flip caller scores
//    ~38-45% here, not 50%. The right null is the technique's OWN vote mix
//    scored against the period's OWN outcome mix:
//        base = P(vote up) * P(actual up) + P(vote down) * P(actual down)
//
// 2. CASTS IN THE SAME PERIOD ARE NOT INDEPENDENT. ~60 crypto assets scored on
//    one date move together; counting them as 60 trials is precisely the v6
//    defect that inflated every confidence bound in this project. The effective
//    sample size is the number of PERIODS, not the number of casts.
//
// So this computes one edge per period (accuracy minus that period's own
// baseline) and t-tests the series of edges — Fama-MacBeth, the same method the
// cross-sectional and derivatives lanes use. A pooled z-score over every cast
// would read roughly 8x larger and mean nothing.
//
// Serial correlation in the period-edge series is handled with Newey-West
// (Bartlett) standard errors, for the same reason cross-sectional.mjs adopted
// them: consecutive daily edges cluster, and discarding data to fix that is the
// wrong remedy. That correction cut oi_px_divergence from t=8.63 to t=3.79 when
// it was applied there; expect it to matter here too.
//
// Usage:
//   node scripts/replay-report.mjs
//   node scripts/replay-report.mjs --asset-class crypto --horizon 24
//   node scripts/replay-report.mjs --provenance live     # same test, live ledger

import { d1 } from './d1-client.mjs';
import { OUTCOME_MODEL_VERSION } from './reliability.mjs';

const env = process.env;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

// Bartlett kernel, same implementation shape as cross-sectional.mjs's
// neweyWestSE. lag = floor(4 * (n/100)^(2/9)) is the standard Newey-West rule.
export function neweyWestSE(series) {
  const n = series.length;
  if (n < 3) return null;
  const mean = series.reduce((a, b) => a + b, 0) / n;
  const dev = series.map((v) => v - mean);
  const lag = Math.max(1, Math.floor(4 * Math.pow(n / 100, 2 / 9)));
  let s = dev.reduce((a, d) => a + d * d, 0) / n;
  for (let L = 1; L <= lag && L < n; L++) {
    let cov = 0;
    for (let t = L; t < n; t++) cov += dev[t] * dev[t - L];
    cov /= n;
    s += 2 * (1 - L / (lag + 1)) * cov;
  }
  if (!(s > 0)) return null;
  return Math.sqrt(s / n);
}

function summarize(rows, label) {
  // One edge per period. A period with too few casts is dropped rather than
  // contributing a hit rate computed over three assets.
  const edges = [];
  let casts = 0, correct = 0;
  for (const r of rows) {
    const n = Number(r.n);
    if (n < 10) continue;
    const down = n - Number(r.up);
    const pUp = Number(r.au) / n;
    const pDown = Number(r.ad) / n;
    const base = (Number(r.up) / n) * pUp + (down / n) * pDown;
    edges.push(Number(r.corr) / n - base);
    casts += n;
    correct += Number(r.corr);
  }
  const k = edges.length;
  if (k < 3) return { label, periods: k, insufficient: true };
  const mean = edges.reduce((a, b) => a + b, 0) / k;
  const naiveSd = Math.sqrt(edges.reduce((a, b) => a + (b - mean) ** 2, 0) / (k - 1));
  const naiveT = mean / (naiveSd / Math.sqrt(k));
  const nwSe = neweyWestSE(edges);
  const nwT = nwSe ? mean / nwSe : null;
  return {
    label, periods: k, casts,
    rawAccuracy: correct / casts,
    meanEdgePts: mean * 100,
    naiveT,
    neweyWestT: nwT,
    periodsPositive: edges.filter((e) => e > 0).length
  };
}

async function main() {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN || !env.FCS_D1_DATABASE_ID) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and FCS_D1_DATABASE_ID are required');
  }
  const provenance = String(arg('provenance', 'replay'));
  const classes = arg('asset-class') && arg('asset-class') !== true ? [String(arg('asset-class'))] : ['crypto', 'stock'];
  const horizons = arg('horizon') && arg('horizon') !== true ? [Number(arg('horizon'))] : [24, 168];

  console.log(`\nComposite skill vs its own no-skill baseline`);
  console.log(`model=${OUTCOME_MODEL_VERSION}  provenance=${provenance}\n`);

  const out = [];
  for (const assetClass of classes) {
    for (const h of horizons) {
      const rows = await d1(env, `
        SELECT substr(run_at, 1, 10) AS d, COUNT(*) AS n, SUM(correct) AS corr,
               SUM(CASE WHEN dir = 1 THEN 1 ELSE 0 END) AS up,
               SUM(CASE WHEN actual_dir = 1 THEN 1 ELSE 0 END) AS au,
               SUM(CASE WHEN actual_dir = -1 THEN 1 ELSE 0 END) AS ad
          FROM forecast_outcomes
         WHERE provenance = ? AND asset_class = ? AND horizon_minutes = ?
           AND series_kind = 'technique' AND series_key = 'composite'
           AND aggregated = 1 AND model_version = ?
         GROUP BY substr(run_at, 1, 10) ORDER BY d
      `, [provenance, assetClass, h * 60, OUTCOME_MODEL_VERSION]);
      const s = summarize(rows, `${assetClass} ${h}h`);
      out.push(s);
    }
  }

  const pad = (v, w) => String(v).padStart(w);
  console.log('  slice           periods    casts   raw acc   edge pts   naive t    NW t   periods +');
  for (const s of out) {
    if (s.insufficient) { console.log(`  ${s.label.padEnd(14)}  ${pad(s.periods, 7)}   (too few periods to test)`); continue; }
    console.log(`  ${s.label.padEnd(14)}  ${pad(s.periods, 7)} ${pad(s.casts, 8)}  ${pad(s.rawAccuracy.toFixed(4), 8)}  ${pad(s.meanEdgePts.toFixed(2), 9)}  ${pad(s.naiveT.toFixed(2), 8)}  ${pad(s.neweyWestT == null ? 'n/a' : s.neweyWestT.toFixed(2), 6)}  ${pad(`${s.periodsPositive}/${s.periods}`, 10)}`);
  }

  console.log(`
  edge pts = mean per-period (accuracy - that period's own no-skill baseline),
             in percentage points. Positive means the model beat a coin weighted
             by the period's own up/down mix.
  naive t  = t-stat treating each PERIOD as one observation. Already far more
             honest than a per-cast z, which would read ~8x larger.
  NW t     = the same t with Newey-West (Bartlett) standard errors, which is the
             number to quote. Serial correlation in the edge series makes the
             naive one optimistic.

  For reference, the publication gate (assetClassSkill) needs the Wilson lower
  bound on edge to be ABOVE zero and significant. A negative mean edge cannot
  clear it at any sample size, which is the correct outcome, not a bug.
`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('[replay-report] failed:', e); process.exit(1); });
}
