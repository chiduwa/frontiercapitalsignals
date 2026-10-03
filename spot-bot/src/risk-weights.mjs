// Risk-based targets for the core sleeve, and orders that steer holdings
// toward them. Pure functions, no I/O: index.mjs supplies the klines and the
// balances. Off unless SPOT_RISK_MODE says otherwise (see config.mjs).
//
// Why (optimization-portfolio/crypto-risk-portfolio): with no direction skill,
// the portfolio to aim for is the one with the least variance. Six yearly
// windows 2020-2026, established coins only, weekly buys at this bot's real
// size (~$13 a week, $5 minimum order): steering holdings toward long-only
// minimum-variance targets (20% cap per coin, 180-day covariance) had lower
// volatility than today's even split in 5 of 6 windows and a smaller worst
// drawdown in 5 of 6 (e.g. -40% vs -51%, -52% vs -65%). Its Sharpe was higher
// in 4 of 6; the pooled gain, +0.15, has a 90% interval of -0.03 to +0.34, so
// lower risk is shown and a return gain is not.
//
// No expected return is used anywhere. The satellite sleeve stays equally
// weighted: with 3 coins a 20% cap cannot bind (3 x 20% < 100%).

const LOOKBACK = 180;      // daily returns used for the covariance
const MIN_COMMON = 90;     // fewer aligned days than this and no targets are set

// ---------------------------------------------------------------------------
// Covariance
// ---------------------------------------------------------------------------

// Daily klines per symbol -> aligned log-return matrix (rows = days).
// The final candle is the in-progress day and shapes nothing.
export function alignedReturns(klinesBySymbol, lookback = LOOKBACK) {
  const symbols = Object.keys(klinesBySymbol);
  const closes = symbols.map((s) => {
    const done = (klinesBySymbol[s] || []).slice(0, -1);
    return new Map(done.filter((k) => k.close > 0).map((k) => [k.openTime, k.close]));
  });
  let common = [...closes[0].keys()].filter((t) => closes.every((m) => m.has(t))).sort((a, b) => a - b);
  common = common.slice(-(lookback + 1));
  const R = [];
  for (let i = 1; i < common.length; i++) {
    R.push(closes.map((m) => Math.log(m.get(common[i]) / m.get(common[i - 1]))));
  }
  return { symbols, R };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); };

// Correlation shrunk toward the identity (Ledoit-Wolf 2004), matching the
// research code line for line (weights.py: ledoit_wolf_corr).
export function ledoitWolfCorr(R) {
  const T = R.length, N = R[0].length;
  const cols = Array.from({ length: N }, (_, j) => R.map((r) => r[j]));
  const mu = cols.map(mean), sg = cols.map(sd);
  const Z = R.map((r) => r.map((x, j) => (x - mu[j]) / sg[j]));
  const S = Array.from({ length: N }, () => new Array(N).fill(0));
  for (const z of Z) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) S[i][j] += z[i] * z[j] / T;
  let tr = 0; for (let i = 0; i < N; i++) tr += S[i][i];
  const m = tr / N;
  let d2 = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) d2 += (S[i][j] - (i === j ? m : 0)) ** 2;
  d2 /= N;
  let b2 = 0;
  for (const z of Z) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) b2 += (z[i] * z[j] - S[i][j]) ** 2;
  b2 = Math.min(b2 / (T * T) / N, d2);
  const delta = d2 > 0 ? b2 / d2 : 1;
  const Sig = S.map((row, i) => row.map((v, j) => delta * (i === j ? m : 0) + (1 - delta) * v));
  return Sig.map((row, i) => row.map((v, j) => v / Math.sqrt(Sig[i][i] * Sig[j][j])));
}

// Like the research code, only the last LOOKBACK rows count, however many are passed.
export function covariance(Rin) {
  const R = Rin.slice(-LOOKBACK);
  const N = R[0].length;
  const vols = Array.from({ length: N }, (_, j) => sd(R.map((r) => r[j])));
  const C = ledoitWolfCorr(R);
  return C.map((row, i) => row.map((c, j) => c * vols[i] * vols[j]));
}

// ---------------------------------------------------------------------------
// Minimum variance: min w'Sw  s.t.  sum w = 1, 0 <= w <= cap
// ---------------------------------------------------------------------------

function solveLinear(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) throw new Error('singular system');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / M[i][i]);
}

// Largest violation of the optimality conditions, relative to the gradient
// scale; ~0 proves w optimal (the problem is convex). Same test as the research.
export function kktViolation(S, w, cap) {
  const n = w.length;
  const g = w.map((_, i) => 2 * S[i].reduce((a, s, j) => a + s * w[j], 0));
  const at0 = w.map((x) => x <= 1e-7), atCap = w.map((x) => x >= cap - 1e-7);
  const free = w.map((_, i) => !at0[i] && !atCap[i]);
  const scale = Math.max(...g.map(Math.abs));
  let lam;
  const gf = g.filter((_, i) => free[i]).sort((a, b) => a - b);
  if (gf.length) lam = gf[gf.length >> 1];
  else {
    const lo = Math.max(...g.filter((_, i) => atCap[i]), -Infinity);
    const hi = Math.min(...g.filter((_, i) => at0[i]), Infinity);
    lam = isFinite(lo) && isFinite(hi) ? (lo + hi) / 2 : (isFinite(lo) ? lo : hi);
  }
  let v = Math.abs(w.reduce((a, b) => a + b, 0) - 1);
  for (let i = 0; i < n; i++) {
    if (free[i]) v = Math.max(v, Math.abs(g[i] - lam) / scale);
    if (at0[i]) v = Math.max(v, Math.max(0, lam - g[i]) / scale);
    if (atCap[i]) v = Math.max(v, Math.max(0, g[i] - lam) / scale);
    v = Math.max(v, Math.max(0, -w[i]), Math.max(0, w[i] - cap));
  }
  return v;
}

// Primal active-set method (Nocedal & Wright, Algorithm 16.3) specialised to
// one budget row and box bounds. Exact for this convex problem in finitely
// many steps; the KKT check afterwards is the proof, not the algorithm's word.
export function minVariance(S, capIn) {
  const n = S.length;
  const cap = Math.max(capIn, 1 / n);           // a cap below 1/n is infeasible
  // Rescale to unit average variance: daily variances (~1e-4) sit below solver tolerances.
  const avg = S.reduce((a, r, i) => a + r[i], 0) / n;
  const G = S.map((r) => r.map((v) => 2 * v / avg));  // Hessian of w'Sw
  let x = new Array(n).fill(1 / n);             // feasible start
  const W = new Array(n).fill(0);               // 0 free, -1 at 0, +1 at cap
  for (let i = 0; i < n; i++) if (Math.abs(cap - 1 / n) < 1e-15) W[i] = 1;
  for (let iter = 0; iter < 500; iter++) {
    const F = [...Array(n).keys()].filter((i) => W[i] === 0);
    const g = x.map((_, i) => G[i].reduce((a, v, j) => a + v * x[j], 0));
    let p = new Array(n).fill(0), mu;
    if (F.length) {
      const k = F.length;
      const A = Array.from({ length: k + 1 }, () => new Array(k + 1).fill(0));
      const b = new Array(k + 1).fill(0);
      F.forEach((fi, a) => {
        F.forEach((fj, c) => { A[a][c] = G[fi][fj]; });
        A[a][k] = 1; A[k][a] = 1; b[a] = -g[fi];
      });
      const sol = solveLinear(A, b);
      F.forEach((fi, a) => { p[fi] = sol[a]; });
      mu = -sol[k];                               // multiplier on sum(w) = 1
    }
    const step = Math.max(...p.map(Math.abs));
    if (step < 1e-13) {
      // At the working-set optimum: check bound multipliers.
      if (!F.length) {
        const lo = Math.max(...g.filter((_, i) => W[i] === 1), -Infinity);
        const hi = Math.min(...g.filter((_, i) => W[i] === -1), Infinity);
        mu = isFinite(lo) && isFinite(hi) ? (lo + hi) / 2 : (isFinite(lo) ? lo : hi);
      }
      let worst = -1, worstVal = -1e-12;
      for (let i = 0; i < n; i++) {
        const m = W[i] === -1 ? g[i] - mu : W[i] === 1 ? mu - g[i] : 0;   // must be >= 0
        if (m < worstVal) { worstVal = m; worst = i; }
      }
      if (worst < 0) break;                       // all multipliers non-negative: optimal
      W[worst] = 0;
      continue;
    }
    // Step toward the working-set optimum until a bound blocks.
    let alpha = 1, block = -1, side = 0;
    for (let i = 0; i < n; i++) {
      if (W[i] !== 0) continue;
      if (p[i] < -1e-15) { const a = (0 - x[i]) / p[i]; if (a < alpha) { alpha = a; block = i; side = -1; } }
      if (p[i] > 1e-15) { const a = (cap - x[i]) / p[i]; if (a < alpha) { alpha = a; block = i; side = 1; } }
    }
    x = x.map((v, i) => v + alpha * p[i]);
    if (block >= 0) { W[block] = side; x[block] = side === -1 ? 0 : cap; }
  }
  const sum = x.reduce((a, b) => a + b, 0);
  x = x.map((v) => Math.min(cap, Math.max(0, v / sum)));
  return { weights: x, cap, kkt: kktViolation(S, x, cap) };
}

// ---------------------------------------------------------------------------
// Targets and steering
// ---------------------------------------------------------------------------

// selected: the bot's selection (core + satellite, each with .symbol, .sleeve).
// dailyKlines: { symbol: klines } for the core assets.
// Returns { ok, targets: { symbol: share of the whole portfolio }, detail } or
// { ok: false, reason } -- the caller then keeps today's even split.
export function riskTargets(selected, dailyKlines, opts = {}) {
  const cap = opts.cap ?? 0.20, coreWeight = opts.coreWeight ?? 0.75;
  const core = selected.filter((a) => a.sleeve === 'core');
  const sat = selected.filter((a) => a.sleeve === 'satellite');
  if (core.length < 2) return { ok: false, reason: `only ${core.length} core asset(s); nothing to weight` };
  const series = {};
  for (const a of core) {
    if (!Array.isArray(dailyKlines[a.symbol])) return { ok: false, reason: `no daily klines for ${a.symbol}` };
    series[a.symbol] = dailyKlines[a.symbol];
  }
  const { symbols, R } = alignedReturns(series);
  if (R.length < MIN_COMMON) return { ok: false, reason: `${R.length} aligned daily returns, needs ${MIN_COMMON}` };
  const S = covariance(R);
  if (!S.every((r) => r.every(Number.isFinite))) return { ok: false, reason: 'covariance is not finite' };
  const { weights, kkt, cap: usedCap } = minVariance(S, cap);
  if (!(kkt < 1e-6)) return { ok: false, reason: `optimality check failed (${kkt.toExponential(2)})` };
  const coreShare = sat.length ? coreWeight : 1;
  const targets = {};
  symbols.forEach((s, i) => { targets[s] = coreShare * weights[i]; });
  for (const a of sat) targets[a.symbol] = (1 - coreShare) / sat.length;
  return { ok: true, targets, detail: { days: R.length, cap: usedCap, kkt, core: Object.fromEntries(symbols.map((s, i) => [s, Number(weights[i].toFixed(4))])) } };
}

// Orders that move holdings toward the targets, each at or above its minimum.
// candidates: assets that may be bought this cycle (triggered); values: USD
// value currently held per symbol. Mirrors bot_policy.py: steer().
export function steer(candidates, targets, values, budget, minNotionalFor) {
  if (!candidates.length || !(budget > 0)) return [];
  const heldTotal = Object.keys(targets).reduce((a, s) => a + (values[s] || 0), 0);
  const total = heldTotal + budget;
  const gapOf = (a) => Math.max(0, (targets[a.symbol] || 0) * total - (values[a.symbol] || 0));
  let order = candidates.filter((a) => gapOf(a) > 0).sort((a, b) => gapOf(b) - gapOf(a));
  const byGap = order.length > 0;
  if (!byGap) order = [...candidates].sort((a, b) => (targets[b.symbol] || 0) - (targets[a.symbol] || 0));
  for (let k = order.length; k >= 1; k--) {
    const top = order.slice(0, k);
    const weightsK = top.map((a) => (byGap ? gapOf(a) : (targets[a.symbol] || 0)));
    const sumK = weightsK.reduce((a, b) => a + b, 0);
    const prop = top.map((a, i) => ({ ...a, quote: sumK > 0 ? budget * weightsK[i] / sumK : budget / k }));
    if (prop.every((a) => a.quote >= minNotionalFor(a.symbol))) return prop;
    const even = top.map((a) => ({ ...a, quote: budget / k }));
    if (even.every((a) => a.quote >= minNotionalFor(a.symbol))) return even;
  }
  return [];
}

// The whole risk-weighted plan for one cycle. Exchange access is passed in
// (fetchDaily, fetchAccount, fetchPrice) so this is testable without Binance.
// Holdings are valued at this cycle's measured prices; a held coin that was not
// measured is priced on demand. Returns { ok: false, reason } on any shortfall.
export async function planRiskOrders({ selected, triggered, measured, pool, minNotionalFor,
  cap = 0.20, coreWeight = 0.75, fetchDaily, fetchAccount, fetchPrice }) {
  const core = selected.filter((a) => a.sleeve === 'core');
  const daily = {};
  for (const a of core) daily[a.symbol] = await fetchDaily(a.symbol);
  const rt = riskTargets(selected, daily, { cap, coreWeight });
  if (!rt.ok) return { ok: false, reason: rt.reason };
  const account = await fetchAccount();
  const priceOf = new Map(measured.map((a) => [a.symbol, a.price]));
  const values = {};
  for (const a of selected) {
    const bal = (account.balances || []).find((b) => b.asset === a.signalSymbol);
    const qty = bal ? Number(bal.free) + Number(bal.locked) : 0;
    let price = priceOf.get(a.symbol);
    if (!(price > 0) && qty > 0) price = await fetchPrice(a.symbol);
    values[a.symbol] = qty > 0 && price > 0 ? qty * price : 0;
  }
  const orders = steer(triggered, rt.targets, values, pool, minNotionalFor);
  return { ok: true, targets: rt.targets, detail: rt.detail, values, orders };
}
