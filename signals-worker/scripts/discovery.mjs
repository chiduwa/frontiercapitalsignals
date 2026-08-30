// Continuous, self-validating pattern discovery across the archive.
//
// User-requested 2026-08-30: "build in a system that automatically tracks and
// looks for such and any other useful correlations/observations in assets, so
// it notifies me... all data should be logged and automatically learned from
// so that our predictions will be better continuously."
//
// WHY THIS IS ALLOWED TO MINE PER-SYMBOL, WHEN correlation-research.mjs IS NOT
//
// That module's own docs are emphatic that testing dozens of individual
// symbols is the multiple-testing trap, and pools by asset class instead. That
// reasoning is correct for a one-shot study, where the only evidence available
// is the data you searched. It does not bind a system that runs forever.
//
// The defence here is different and strictly stronger: a finding is never
// trusted on the data that produced it. It is recorded as `provisional` and
// then re-tested only on bars recorded AFTER its discovery date. Data that did
// not exist when the search ran cannot have been mined, so surviving that test
// is genuine out-of-sample evidence. A spurious pattern found by scanning 60
// symbols will not replicate; a real one will. That is what lets this look
// per-symbol at all, and it is why nothing is notified at `provisional`.
//
// Both guards still apply at discovery: a Bonferroni bar scaled to the actual
// number of hypotheses in the family, and the same chronological split-half
// check the rest of this engine uses. Out-of-sample confirmation is a third
// bar on top, not a replacement for them.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
// Optional: NTFY_TOPIC (status-change alerts)
import { twoSampleZTest, chronologicalHalfSplit, RELIABILITY_SIGNIFICANCE_Z } from '../worker.js';
import { d1 } from './d1-client.mjs';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID, NTFY_TOPIC } = process.env;
// Env is validated inside main(), not at module scope, so the pure statistical
// helpers below can be imported and unit-tested without credentials. Checking
// at import time made the whole module unloadable in the test suite.
const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID };

function requireEnv() {
  for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
    if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
  }
}

const MIN_SAMPLE = 60;          // per side of a two-sample test
const MIN_OOS_SAMPLE = 25;      // before an out-of-sample verdict is allowed at all
const DISCOVERY_ALPHA = 0.01;   // family-wide, matching RELIABILITY_SIGNIFICANCE_Z's two-tailed 0.01
const OOS_MIN_Z = 1.0;          // deliberately lenient — see evaluateOutOfSample

// Acklam's rational approximation to the inverse normal CDF. Needed because
// the Bonferroni bar depends on the family size, which is only known at
// runtime (it is however many symbols actually had enough data), so the
// critical value cannot be a hardcoded constant the way it is elsewhere.
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p > ph) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

// Two-tailed Bonferroni critical value for a family of `k` hypotheses. Scaling
// the bar to the number of tests ACTUALLY run is the whole point: scanning 60
// symbols and 5 weekdays is 300 chances for noise to clear a fixed bar.
export function familyZBar(k, alpha = DISCOVERY_ALPHA) {
  const tests = Math.max(1, k);
  return Math.abs(normalQuantile(1 - (alpha / tests) / 2));
}

// -------------------------------- FAMILIES ---------------------------------

// Family 1 — the equity overnight effect, which is what prompted all this:
// "buy at the close, sell at the open." Splits each session into the part that
// happens while the market is shut (previous close -> open) and the part that
// happens while it is open (open -> close), then asks whether they differ.
// Requires asset_daily_bars.open, added 2026-08-30 specifically for this.
export function overnightVsIntradaySamples(bars) {
  const overnight = [], intraday = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1], cur = bars[i];
    if (!prev.close || !cur.open || !cur.close) continue;
    if (prev.close <= 0 || cur.open <= 0) continue;
    const on = (cur.open / prev.close - 1) * 100;
    const id = (cur.close / cur.open - 1) * 100;
    // Same implausibility discipline as the rest of the archive work: a
    // >50% overnight gap on a large-cap is a split or a bad bar, not a move.
    if (!Number.isFinite(on) || !Number.isFinite(id) || Math.abs(on) > 50 || Math.abs(id) > 50) continue;
    overnight.push({ date: cur.date, value: on });
    intraday.push({ date: cur.date, value: id });
  }
  return { overnight, intraday };
}

// Family 2 — day-of-week. Each weekday against all the others, for any asset
// with daily bars, crypto included (crypto trades weekends, which is itself
// worth testing rather than assuming).
export function dayOfWeekSamples(bars, weekday) {
  const on = [], off = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1], cur = bars[i];
    if (!prev.close || !cur.close || prev.close <= 0) continue;
    const ret = (cur.close / prev.close - 1) * 100;
    if (!Number.isFinite(ret) || Math.abs(ret) > 50) continue;
    const dow = new Date(`${cur.date}T00:00:00Z`).getUTCDay();
    (dow === weekday ? on : off).push({ date: cur.date, value: ret });
  }
  return { on, off };
}

// Runs the discovery-time guards: family-corrected pooled bar, then the
// chronological split-half check. Returns null unless both pass.
export function guardedDiscovery(sampleA, sampleB, zBar) {
  if (sampleA.length < MIN_SAMPLE || sampleB.length < MIN_SAMPLE) return null;
  const pooled = twoSampleZTest(sampleA.map((p) => p.value), sampleB.map((p) => p.value));
  if (pooled.z == null || Math.abs(pooled.z) < zBar) return null;

  const { firstHalf, secondHalf } = chronologicalHalfSplit([...sampleA.map((p) => p.date), ...sampleB.map((p) => p.date)]);
  const h1 = twoSampleZTest(sampleA.filter((p) => firstHalf.has(p.date)).map((p) => p.value), sampleB.filter((p) => firstHalf.has(p.date)).map((p) => p.value));
  const h2 = twoSampleZTest(sampleA.filter((p) => secondHalf.has(p.date)).map((p) => p.value), sampleB.filter((p) => secondHalf.has(p.date)).map((p) => p.value));
  const sameSign = h1.effectSize != null && h2.effectSize != null && Math.sign(h1.effectSize) === Math.sign(h2.effectSize);
  const bothOk = h1.z != null && h2.z != null && Math.abs(h1.z) >= RELIABILITY_SIGNIFICANCE_Z && Math.abs(h2.z) >= RELIABILITY_SIGNIFICANCE_Z;
  if (!sameSign || !bothOk) return null;

  return {
    n: pooled.n, effectSize: pooled.effectSize, z: pooled.z,
    notes: `pooled z=${pooled.z.toFixed(2)}; h1 z=${h1.z.toFixed(2)} eff=${h1.effectSize.toFixed(4)}; h2 z=${h2.z.toFixed(2)} eff=${h2.effectSize.toFixed(4)}`
  };
}

// ----------------------------- OUT-OF-SAMPLE -------------------------------

// Re-tests one registry entry using ONLY bars dated after it was discovered.
//
// The bar here is deliberately lenient (same sign, |z| >= 1.0) rather than the
// strict discovery bar, and that is a considered choice, not a shortcut.
// Out-of-sample windows are short by construction — a finding discovered last
// month has a month of new data — so demanding z >= 2.576 would reject almost
// everything real for lack of samples and turn this into a null generator.
// What actually matters at this stage is direction: a spurious pattern has no
// reason to keep pointing the same way on data it was not fitted to, while a
// real one does. Sign agreement across an independent window is the signal;
// the small |z| floor just excludes pure coin-flips.
export function evaluateOutOfSample(entry, samples) {
  const { a, b } = samples;
  if (!a || !b || a.length < MIN_OOS_SAMPLE || b.length < MIN_OOS_SAMPLE) {
    return { verdict: 'insufficient', n: (a ? a.length : 0) + (b ? b.length : 0) };
  }
  const r = twoSampleZTest(a.map((p) => p.value), b.map((p) => p.value));
  if (r.z == null || r.effectSize == null) return { verdict: 'insufficient', n: r.n || 0 };
  const sameSign = Math.sign(r.effectSize) === Math.sign(entry.discovery_effect);
  const strongEnough = Math.abs(r.z) >= OOS_MIN_Z;
  // Actively contradicted: pointing the other way with real force. That is
  // worth demoting on, where merely "not yet significant" is not.
  const contradicted = !sameSign && Math.abs(r.z) >= OOS_MIN_Z;
  return {
    verdict: contradicted ? 'contradicted' : (sameSign && strongEnough ? 'held' : 'inconclusive'),
    n: r.n, effectSize: r.effectSize, z: r.z
  };
}

// provisional -> confirmed once it has held on data it was never fitted to.
// Anything -> decayed the moment it is actively contradicted, including a
// previously confirmed finding: a pattern that stops working is the dangerous
// case, because it keeps its authority while quietly costing money.
export function nextStatus(current, verdict) {
  if (verdict === 'contradicted') return 'decayed';
  if (verdict === 'held') return 'confirmed';
  return current;
}

async function loadRegistry() {
  const rows = await d1(env, 'SELECT * FROM research_registry');
  return rows;
}

async function upsertProvisional(entry, nowIso) {
  await d1(env, `
    INSERT INTO research_registry
      (hypothesis, family, asset_class, symbol, horizon_days, status, discovered_at,
       discovery_n, discovery_effect, discovery_z, tests_in_family, last_checked_at, status_changed_at, notes)
    VALUES (?, ?, ?, ?, ?, 'provisional', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (hypothesis) DO UPDATE SET
      last_checked_at = excluded.last_checked_at
  `, [entry.hypothesis, entry.family, entry.assetClass, entry.symbol, entry.horizonDays, nowIso,
      entry.n, entry.effectSize, entry.z, entry.testsInFamily, nowIso, nowIso, entry.notes]);
}

async function recordOosResult(hypothesis, status, statusChanged, oos, nowIso) {
  await d1(env, `
    UPDATE research_registry SET
      status = ?, oos_n = ?, oos_effect = ?, oos_z = ?, oos_checks = oos_checks + 1,
      last_checked_at = ?, status_changed_at = COALESCE(?, status_changed_at)
    WHERE hypothesis = ?
  `, [status, oos.n || 0, oos.effectSize ?? null, oos.z ?? null, nowIso, statusChanged ? nowIso : null, hypothesis]);
}

async function notify(title, body, priority = 'default') {
  if (!NTFY_TOPIC) return false;
  try {
    const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST', headers: { Title: title, Priority: priority, Tags: 'microscope' }, body
    });
    return res.ok;
  } catch (e) {
    console.error('discovery notify failed:', e.message);
    return false;
  }
}

// --------------------------------- MAIN ------------------------------------

function groupBars(rows) {
  const bySymbol = {};
  for (const r of rows) (bySymbol[r.symbol] ??= { assetClass: r.asset_class, bars: [] }).bars.push(r);
  for (const v of Object.values(bySymbol)) v.bars.sort((a, b) => (a.date < b.date ? -1 : 1));
  return bySymbol;
}

// Builds the two samples for a hypothesis, optionally restricted to bars after
// `sinceDate` — which is exactly how an out-of-sample re-test is expressed.
function samplesFor(family, param, entry, bySymbol, sinceDate) {
  const rec = bySymbol[entry.symbol];
  if (!rec) return null;
  const bars = sinceDate ? rec.bars.filter((b) => b.date > sinceDate) : rec.bars;
  if (bars.length < 3) return null;
  if (family === 'overnight-vs-intraday') {
    const { overnight, intraday } = overnightVsIntradaySamples(bars);
    return { a: overnight, b: intraday };
  }
  if (family === 'day-of-week') {
    const { on, off } = dayOfWeekSamples(bars, Number(param));
    return { a: on, b: off };
  }
  return null;
}

async function main() {
  requireEnv();
  const nowIso = new Date().toISOString();
  console.log(`discovery run @ ${nowIso}`);

  // One read. asset_daily_bars is the largest table here, so this is the whole
  // D1 cost of the run — every family below works off this same slice.
  const rows = await d1(env, "SELECT symbol, asset_class, date, open, close FROM asset_daily_bars WHERE symbol NOT LIKE 'SECTOR:%' AND symbol NOT LIKE 'MCAP:%' ORDER BY symbol, date");
  const bySymbol = groupBars(rows);
  console.log(`loaded ${rows.length} bars across ${Object.keys(bySymbol).length} symbols`);
  const withOpen = Object.values(bySymbol).filter((v) => v.bars.some((b) => b.open != null)).length;
  console.log(`symbols with at least one open price: ${withOpen} (the overnight family needs these)`);

  // ---- discovery ----
  const candidates = [];

  // Family sizes must be counted BEFORE testing, so the Bonferroni bar
  // reflects every hypothesis the scan could have surfaced, not just the ones
  // that happened to produce a sample.
  const overnightSymbols = Object.entries(bySymbol).filter(([, v]) => v.bars.some((b) => b.open != null));
  const overnightZBar = familyZBar(overnightSymbols.length);
  console.log(`family overnight-vs-intraday: ${overnightSymbols.length} hypotheses, corrected |z| bar = ${overnightZBar.toFixed(3)}`);
  for (const [symbol, v] of overnightSymbols) {
    const { overnight, intraday } = overnightVsIntradaySamples(v.bars);
    const res = guardedDiscovery(overnight, intraday, overnightZBar);
    if (res) {
      candidates.push({
        hypothesis: `overnight-vs-intraday|${symbol}`, family: 'overnight-vs-intraday',
        assetClass: v.assetClass, symbol, horizonDays: 1, testsInFamily: overnightSymbols.length, ...res
      });
    }
  }

  const dowSymbols = Object.entries(bySymbol);
  const dowZBar = familyZBar(dowSymbols.length * 7);
  console.log(`family day-of-week: ${dowSymbols.length * 7} hypotheses, corrected |z| bar = ${dowZBar.toFixed(3)}`);
  for (const [symbol, v] of dowSymbols) {
    for (let wd = 0; wd < 7; wd++) {
      const { on, off } = dayOfWeekSamples(v.bars, wd);
      const res = guardedDiscovery(on, off, dowZBar);
      if (res) {
        candidates.push({
          hypothesis: `day-of-week|${symbol}|${wd}`, family: 'day-of-week',
          assetClass: v.assetClass, symbol, horizonDays: 1, testsInFamily: dowSymbols.length * 7, ...res
        });
      }
    }
  }
  console.log(`discovery: ${candidates.length} candidate(s) cleared BOTH the family-corrected bar and the split-half check`);

  const existing = new Set((await loadRegistry()).map((r) => r.hypothesis));
  let newlyProvisional = 0;
  for (const c of candidates) {
    if (!existing.has(c.hypothesis)) newlyProvisional++;
    await upsertProvisional(c, nowIso);
    await d1(env, `INSERT INTO correlation_research_findings (hypothesis, asset_class, horizon_days, n, effect_size, z, split_consistent, computed_at, notes)
                   VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [c.hypothesis, c.assetClass, c.horizonDays, c.n, c.effectSize, c.z, nowIso, c.notes]);
  }
  console.log(`registry: ${newlyProvisional} newly provisional, ${candidates.length - newlyProvisional} already known`);

  // ---- out-of-sample re-validation ----
  const registry = await loadRegistry();
  const transitions = [];
  for (const entry of registry) {
    const [family, , param] = entry.hypothesis.split('|');
    const samples = samplesFor(family, param, entry, bySymbol, entry.discovered_at.slice(0, 10));
    if (!samples) continue;
    const oos = evaluateOutOfSample(entry, samples);
    const next = nextStatus(entry.status, oos.verdict);
    const changed = next !== entry.status;
    await recordOosResult(entry.hypothesis, next, changed, oos, nowIso);
    console.log(`[${entry.hypothesis}] status=${entry.status}->${next} oos=${oos.verdict} n=${oos.n} z=${oos.z != null ? oos.z.toFixed(2) : 'n/a'}`);
    if (changed) transitions.push({ entry, next, oos });
  }

  // ---- notify only on genuine status changes ----
  // Never on discovery: at that point the finding has only been tested on the
  // data used to find it, and notifying there would be exactly the noise this
  // design exists to avoid.
  for (const t of transitions) {
    const e = t.entry;
    const dir = e.discovery_effect >= 0 ? 'higher' : 'lower';
    if (t.next === 'confirmed') {
      await notify(
        `Confirmed: ${e.symbol} ${e.family}`,
        `${e.hypothesis} held up out-of-sample. Discovered ${e.discovered_at.slice(0, 10)} `
        + `(effect ${e.discovery_effect.toFixed(4)}%, z=${e.discovery_z.toFixed(2)}, n=${e.discovery_n}); `
        + `since then, on ${t.oos.n} bars it did not exist for at discovery, effect ${t.oos.effectSize.toFixed(4)}% (z=${t.oos.z.toFixed(2)}), same direction — ${dir}. `
        + `One of ${e.tests_in_family} hypotheses tested in this family, so the bar it cleared was corrected for that. `
        + `Effect size is what matters next: check it against your round-trip costs before trading it.`
      );
    } else if (t.next === 'decayed') {
      await notify(
        `Decayed: ${e.symbol} ${e.family}`,
        `${e.hypothesis} has stopped working and should no longer be relied on. `
        + `It was ${e.status} (discovered ${e.discovered_at.slice(0, 10)}, effect ${e.discovery_effect.toFixed(4)}%, z=${e.discovery_z.toFixed(2)}), `
        + `but on ${t.oos.n} newer bars it now runs the OTHER way: effect ${t.oos.effectSize.toFixed(4)}% (z=${t.oos.z.toFixed(2)}).`,
        'high'
      );
    }
  }

  const counts = {};
  for (const r of await loadRegistry()) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log(`registry status: ${JSON.stringify(counts)} | ${transitions.length} transition(s) notified this run`);
}

// Only run when executed directly. Importing this module (the test suite does)
// must not kick off a full research pass against the live database.
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
