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
// Monthly families get a lower floor purely because months are scarce: six
// years is ~72 of them. This buys nothing statistically — the z-test already
// accounts for sample size — it only stops the family from being skipped
// outright before it can ever be tested. The out-of-sample stage still has to
// pass, and with monthly data that takes real calendar time to accumulate.
const MIN_SAMPLE_MONTHLY = 8;

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

// Family 3 — turn-of-month, conditioned on how the month has actually gone.
// User's framing: "a drop or rise in the last few days of the month if an
// asset was bullish or bearish all month."
//
// The conditioning is the interesting part and also the risk: splitting each
// month into bullish/bearish doubles the hypothesis count, so both variants
// are counted in the family size rather than quietly tested for free.
//
// `trend` is judged on the month up to the start of the closing window, never
// including it — otherwise the condition would be partly made of the very
// returns being predicted, which guarantees a spurious result.
export function turnOfMonthSamples(bars, lastNDays, wantBullish) {
  const byMonth = {};
  for (const b of bars) {
    if (!b.close) continue;
    (byMonth[b.date.slice(0, 7)] ??= []).push(b);
  }
  // BOTH samples are closing-window returns. The first version compared the
  // closing window against THE SAME MONTH'S HEAD, and that was a selection
  // bias severe enough to manufacture findings: months are selected precisely
  // because their head rose (or fell), so the head's mean return is positive
  // (or negative) BY CONSTRUCTION. Comparing anything against it is comparing
  // unselected returns to returns hand-picked for their sign.
  //
  // It showed up exactly as it should have — 132 of 624 tests "passed" at a
  // |z| >= 4.31 bar where chance is ~0.001%, split roughly half positive and
  // half negative, i.e. the sign of the selection rather than of any pattern.
  //
  // Now the baseline is the closing window of months that did NOT meet the
  // trend condition. Same part of the month on both sides, so the only thing
  // that differs is the prior trend — which is the actual question.
  const matching = [], other = [];
  for (const month of Object.keys(byMonth).sort()) {
    const days = byMonth[month];
    if (days.length < lastNDays + 5) continue;   // need a real month, not a stub
    const cut = days.length - lastNDays;
    const head = days.slice(0, cut);
    const tail = days.slice(cut);
    const monthTrend = (head[head.length - 1].close / head[0].close - 1) * 100;
    if (!Number.isFinite(monthTrend)) continue;
    const isMatch = wantBullish ? monthTrend > 0 : monthTrend < 0;
    const target = isMatch ? matching : other;
    let prev = head[head.length - 1].close;
    for (const d of tail) {
      if (prev && d.close && prev > 0) {
        const ret = (d.close / prev - 1) * 100;
        if (Number.isFinite(ret) && Math.abs(ret) <= 50) target.push({ date: d.date, value: ret });
      }
      prev = d.close;
    }
  }
  return { a: matching, b: other };
}

// Family 4 — mean reversion after a run. User's framing: "crypto will usually
// have at least one bull month after two bear ones and vice versa."
//
// Tests exactly that: after `runLength` consecutive months in one direction,
// is the NEXT month's return different from an unconditional month? Monthly
// returns are built from the first and last close actually present in each
// month, so a missing day never fabricates a month boundary.
export function monthlyReturns(bars) {
  const byMonth = {};
  for (const b of bars) {
    if (!b.close) continue;
    (byMonth[b.date.slice(0, 7)] ??= []).push(b);
  }
  return Object.keys(byMonth).sort().map((m) => {
    const days = byMonth[m];
    const first = days[0].close, last = days[days.length - 1].close;
    return { month: m, days: days.length, value: first > 0 ? (last / first - 1) * 100 : null };
  }).filter((r) => r.value != null && Number.isFinite(r.value) && Math.abs(r.value) <= 200 && r.days >= 15);
}

export function runReversalSamples(bars, runLength, wantDownRun) {
  const months = monthlyReturns(bars);
  const after = [], baseline = [];
  for (let i = 0; i < months.length; i++) {
    if (i >= runLength) {
      const run = months.slice(i - runLength, i);
      const matches = run.every((m) => (wantDownRun ? m.value < 0 : m.value > 0));
      if (matches) {
        after.push({ date: months[i].month, value: months[i].value });
        continue;
      }
    }
    baseline.push({ date: months[i].month, value: months[i].value });
  }
  return { a: after, b: baseline };
}

// Equal-weight monthly return series for a whole asset class.
//
// The run-reversal question ("does crypto bounce after two bear months?") is
// asked at monthly resolution, which is inherently sample-starved: six years is
// ~72 months, and "after two down months" might occur a dozen times. The
// tempting fix — pool 83 coins to get 83x the observations — is invalid here,
// because crypto monthly returns are near-perfectly correlated: those are not
// 83 independent observations of a month, they are one month observed 83 times.
// That is the same correlation trap horizonEstimate and the class-skill gate
// already guard against elsewhere in this engine.
//
// So symbols are averaged WITHIN each month first, making the month the unit of
// observation and n the honest count of months. This produces fewer, real
// samples instead of many fake ones, and it means these families will often
// return nothing — which is a valid answer, not a failure.
export function classMonthlySeries(bySymbol, assetClass) {
  const perMonth = {};
  for (const [, rec] of Object.entries(bySymbol)) {
    if (rec.assetClass !== assetClass) continue;
    for (const m of monthlyReturns(rec.bars)) {
      (perMonth[m.month] ??= []).push(m.value);
    }
  }
  return Object.keys(perMonth).sort()
    .filter((m) => perMonth[m].length >= 3)
    .map((m) => ({ month: m, value: perMonth[m].reduce((a, b) => a + b, 0) / perMonth[m].length }));
}

export function runReversalFromSeries(series, runLength, wantDownRun) {
  const after = [], baseline = [];
  for (let i = 0; i < series.length; i++) {
    if (i >= runLength) {
      const run = series.slice(i - runLength, i);
      if (run.every((m) => (wantDownRun ? m.value < 0 : m.value > 0))) {
        after.push({ date: series[i].month, value: series[i].value });
        continue;
      }
    }
    baseline.push({ date: series[i].month, value: series[i].value });
  }
  return { a: after, b: baseline };
}

// Runs the discovery-time guards: family-corrected pooled bar, then the
// chronological split-half check. Returns null unless both pass.
export function guardedDiscovery(sampleA, sampleB, zBar, minSample = MIN_SAMPLE) {
  if (sampleA.length < minSample || sampleB.length < minSample) return null;
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
  const floor = samples.minSample != null ? Math.min(samples.minSample, MIN_OOS_SAMPLE) : MIN_OOS_SAMPLE;
  if (!a || !b || a.length < floor || b.length < floor) {
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

// ----------------------------- LIVE TRIGGERS -------------------------------

// A confirmed pattern is only useful if you are told when its precondition is
// actually live. This checks the CURRENT state of the archive against each
// confirmed finding and reports the ones whose setup is in place right now.
//
// Confirmed only, never provisional: a provisional finding has been tested
// solely on the data that produced it, and firing alerts off those would
// reintroduce exactly the noise the lifecycle exists to prevent.
export function evaluateLiveTriggers(registry, bySymbol, nowIso) {
  const today = nowIso.slice(0, 10);
  const out = [];
  for (const entry of registry) {
    if (entry.status !== 'confirmed') continue;
    const parts = entry.hypothesis.split('|');
    const family = parts[0];

    if (family === 'run-reversal') {
      const [, cls, rl, dir] = parts;
      const series = classMonthlySeries(bySymbol, cls);
      const need = Number(rl);
      if (series.length < need) continue;
      // The run must be COMPLETE and immediately prior — the last `need`
      // finished months all in the same direction.
      const run = series.slice(-need);
      const matches = run.every((m) => (dir === 'down' ? m.value < 0 : m.value > 0));
      if (!matches) continue;
      out.push({
        entry, kind: 'run-reversal',
        detail: `${cls} has just closed ${need} consecutive ${dir} months (${run.map((m) => `${m.month} ${m.value >= 0 ? '+' : ''}${m.value.toFixed(1)}%`).join(', ')})`,
        expectation: `after this setup the next month has averaged ${entry.discovery_effect >= 0 ? '+' : ''}${entry.discovery_effect.toFixed(2)}% versus other months`
      });
      continue;
    }

    if (family === 'turn-of-month') {
      const [, symbol, win, trend] = parts;
      const rec = bySymbol[symbol];
      if (!rec || !rec.bars.length) continue;
      const month = today.slice(0, 7);
      const days = rec.bars.filter((b) => b.date.slice(0, 7) === month);
      if (days.length < Number(win) + 5) continue;
      // Only interesting while the closing window is approaching or open.
      const daysLeftGuess = 30 - Number(today.slice(8, 10));
      if (daysLeftGuess > Number(win) + 2) continue;
      const head = days.slice(0, Math.max(1, days.length - Number(win)));
      const monthTrend = (head[head.length - 1].close / head[0].close - 1) * 100;
      const isBull = monthTrend > 0;
      if ((trend === 'bull') !== isBull) continue;
      out.push({
        entry, kind: 'turn-of-month',
        detail: `${symbol} is ${isBull ? 'up' : 'down'} ${monthTrend.toFixed(1)}% so far this month and its final ${win} sessions are starting`,
        expectation: `in this setup those closing sessions have averaged ${entry.discovery_effect >= 0 ? '+' : ''}${entry.discovery_effect.toFixed(3)}%/day versus the rest of the month`
      });
      continue;
    }

    if (family === 'day-of-week') {
      const [, symbol, wd] = parts;
      if (new Date(`${today}T00:00:00Z`).getUTCDay() !== Number(wd)) continue;
      const name = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][Number(wd)];
      out.push({
        entry, kind: 'day-of-week',
        detail: `today is ${name}, ${symbol}'s confirmed ${entry.discovery_effect >= 0 ? 'strong' : 'weak'} weekday`,
        expectation: `${name}s have averaged ${entry.discovery_effect >= 0 ? '+' : ''}${entry.discovery_effect.toFixed(3)}% versus other days`
      });
    }
  }
  return out;
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
  // asset_daily_bars has PRIMARY KEY (symbol, date) with no asset_class, so a
  // ticker used by two different assets leaves one interleaved series. DASH is
  // the live case: Dash the crypto (~$41) and DoorDash the equity (~$237)
  // alternate in the same rows. The first discovery run found exactly one
  // "overnight effect" in the whole crypto universe and it was DASH, at -5.96%
  // with z=-12.84 — which is not a market pattern, it is two assets being
  // differenced against each other.
  //
  // dailyRangeStatsFromRows already drops these; this module needs the same
  // guard, and so will anything else built on this table until the key is
  // widened.
  const classes = {};
  for (const r of rows) (classes[r.symbol] ??= new Set()).add(r.asset_class);
  const ambiguous = Object.entries(classes).filter(([, set]) => set.size > 1).map(([sym]) => sym);
  if (ambiguous.length) console.log(`excluded ${ambiguous.length} symbol(s) present under more than one asset class: ${ambiguous.join(', ')}`);

  const bySymbol = {};
  for (const r of rows) {
    if (classes[r.symbol].size > 1) continue;
    (bySymbol[r.symbol] ??= { assetClass: r.asset_class, bars: [] }).bars.push(r);
  }
  for (const v of Object.values(bySymbol)) v.bars.sort((a, b) => (a.date < b.date ? -1 : 1));
  return bySymbol;
}

// Builds the two samples for a hypothesis, optionally restricted to bars after
// `sinceDate` — which is exactly how an out-of-sample re-test is expressed.
function samplesFor(entry, bySymbol, sinceDate) {
  const parts = entry.hypothesis.split('|');
  const family = parts[0];

  // Class-level family: rebuild the composite from bars after `sinceDate`.
  if (family === 'run-reversal') {
    const [, cls, rl, dir] = parts;
    const sliced = {};
    for (const [sym, rec] of Object.entries(bySymbol)) {
      if (rec.assetClass !== cls) continue;
      sliced[sym] = { assetClass: rec.assetClass, bars: sinceDate ? rec.bars.filter((b) => b.date > sinceDate) : rec.bars };
    }
    const series = classMonthlySeries(sliced, cls);
    if (series.length < 3) return null;
    return { ...runReversalFromSeries(series, Number(rl), dir === 'down'), minSample: MIN_SAMPLE_MONTHLY };
  }

  const rec = bySymbol[entry.symbol];
  if (!rec) return null;
  const bars = sinceDate ? rec.bars.filter((b) => b.date > sinceDate) : rec.bars;
  if (bars.length < 3) return null;
  if (family === 'overnight-vs-intraday') {
    const { overnight, intraday } = overnightVsIntradaySamples(bars);
    return { a: overnight, b: intraday };
  }
  if (family === 'day-of-week') {
    const { on, off } = dayOfWeekSamples(bars, Number(parts[2]));
    return { a: on, b: off };
  }
  if (family === 'turn-of-month') {
    return turnOfMonthSamples(bars, Number(parts[2]), parts[3] === 'bull');
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
  // Family 3 — turn-of-month, split by how the month had gone up to that point.
  // Two windows x two trend conditions x every symbol, all counted in the bar.
  const tomWindows = [3, 5];
  const tomZBar = familyZBar(dowSymbols.length * tomWindows.length * 2);
  console.log(`family turn-of-month: ${dowSymbols.length * tomWindows.length * 2} hypotheses, corrected |z| bar = ${tomZBar.toFixed(3)}`);
  for (const [symbol, v] of dowSymbols) {
    for (const win of tomWindows) {
      for (const bullish of [true, false]) {
        const { a, b } = turnOfMonthSamples(v.bars, win, bullish);
        const res = guardedDiscovery(a, b, tomZBar);
        if (res) {
          candidates.push({
            hypothesis: `turn-of-month|${symbol}|${win}|${bullish ? 'bull' : 'bear'}`, family: 'turn-of-month',
            assetClass: v.assetClass, symbol, horizonDays: win,
            testsInFamily: dowSymbols.length * tomWindows.length * 2, ...res
          });
        }
      }
    }
  }

  // Family 4 — reversal after a directional run, at CLASS level (see
  // classMonthlySeries for why this is not per-symbol).
  const runLengths = [2, 3];
  const classes = ['crypto', 'stock'];
  const runZBar = familyZBar(classes.length * runLengths.length * 2);
  console.log(`family run-reversal: ${classes.length * runLengths.length * 2} hypotheses, corrected |z| bar = ${runZBar.toFixed(3)}`);
  for (const cls of classes) {
    const series = classMonthlySeries(bySymbol, cls);
    console.log(`  ${cls}: ${series.length} months of composite history`);
    for (const rl of runLengths) {
      for (const down of [true, false]) {
        const { a, b } = runReversalFromSeries(series, rl, down);
        const res = guardedDiscovery(a, b, runZBar, MIN_SAMPLE_MONTHLY);
        console.log(`  ${cls} after ${rl} ${down ? 'down' : 'up'} months: n_after=${a.length}, n_base=${b.length}${res ? ` -> VALIDATED z=${res.z.toFixed(2)}` : ''}`);
        if (res) {
          candidates.push({
            hypothesis: `run-reversal|${cls}|${rl}|${down ? 'down' : 'up'}`, family: 'run-reversal',
            assetClass: cls, symbol: null, horizonDays: 30,
            testsInFamily: classes.length * runLengths.length * 2, ...res
          });
        }
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
    const samples = samplesFor(entry, bySymbol, entry.discovered_at.slice(0, 10));
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

  // ---- live triggers: tell the user the setup is ON, ahead of the move ----
  const finalRegistry = await loadRegistry();
  const triggers = evaluateLiveTriggers(finalRegistry, bySymbol, nowIso);
  for (const t of triggers) {
    const e = t.entry;
    await notify(
      `Setup live: ${e.symbol || e.asset_class} ${t.kind}`,
      `${t.detail}. Historically, ${t.expectation} `
      + `(discovered ${e.discovered_at.slice(0, 10)}, z=${e.discovery_z.toFixed(2)}, n=${e.discovery_n}; `
      + `confirmed out-of-sample on ${e.oos_n} later observations). `
      + `This is a historical tendency, not a forecast — size it against your costs.`
    );
  }
  console.log(`live triggers fired: ${triggers.length}`);

  const counts = {};
  for (const r of finalRegistry) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log(`registry status: ${JSON.stringify(counts)} | ${transitions.length} transition(s) notified this run`);
}

// Only run when executed directly. Importing this module (the test suite does)
// must not kick off a full research pass against the live database.
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
