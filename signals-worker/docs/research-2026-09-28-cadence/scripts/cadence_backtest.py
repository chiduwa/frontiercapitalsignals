"""What the most tempting swing rules would actually have done, net of costs,
against buy-and-hold and against the same rule run on shared-sign surrogates
(same volatility, same co-movement, no direction in time: what the rule earns
from exposure and luck alone). Each is the rule a pooled first look suggested
and cadence_class.py then failed:

  stock_fade3      stocks, long-only: every 3 sessions hold the stocks down over
                   the last 3 (equal weight); 5 bps round trip
  crypto_trend20   coins, long-only: every 20 days hold the coins up over the
                   last 20; 20 bps round trip (spot)
  crypto_pullback  coins, hourly: in a rising 2-sd swing, buy once the pullback
                   from its high reaches half a reversal; hold 72 h; one trade
                   per coin at a time; 20 bps round trip
  crypto_deadcat   coins, daily, perps: after a 3-sd down day, short the first
                   1-sd bounce within 10 days for 5 days; 10 bps round trip

and the one family that held (cadence_resid.py): coins mean-revert against
the rest of the market.

  crypto_relrev2   perps, long/short: every 2 days long the coins that lagged
                   the market over the last 2 days, short the ones that led;
                   10 bps round trip
  crypto_relrev40  the same over 40 days
  crypto_laggards40  spot, long-only: every 40 days hold the coins that lagged
                   the market over the last 40; 20 bps round trip

Portfolio rules average three start dates so no single rebalance calendar
decides the answer. Periods as in cadence_study.py.

usage: CAD_DATA=/data/cad [CAD_BT_SURROGATES=100] python cadence_backtest.py"""
import json, os, sys, zlib
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cadence_study as cs
import cadence_class as cc

NS = int(os.environ.get('CAD_BT_SURROGATES', 100))


def aligned(res, cls):
    for r, c, assets, grid in cc.groups():
        if r == res and c == cls:
            pos = {int(t): i for i, t in enumerate(grid)}
            M = np.full((len(assets), len(grid)), np.nan)
            for i, (s, tt, cl) in enumerate(assets):
                ix = np.array([pos[int(t)] for t in tt])
                M[i, ix[1:]] = np.diff(np.log(cl))
            return [a[0] for a in assets], grid, M


def shared_surrogates(M, seed):
    """Row 0 real; rows 1..NS every asset flipped by the same sign at the same time."""
    rng = np.random.default_rng(seed)
    m = np.nanmean(M, axis=1, keepdims=True)
    signs = rng.integers(0, 2, size=(NS, M.shape[1]), dtype=np.int8) * 2 - 1
    out = [M]
    for k in range(NS):
        out.append(m + signs[k][None, :] * (M - m))          # signed moves, flipped together
    return out


def portfolio(X, per, signal_fn, hold, cost, bars_per_year):
    """Equal-weight long-only book rebalanced every `hold` bars from three offsets.
    X: assets x T log returns (NaN = not trading). Returns per-period net log
    return per year of the rule and of equal-weight buy-and-hold."""
    A, T = X.shape
    Xz = np.where(np.isfinite(X), X, 0.0)
    live = np.isfinite(X)
    sig = signal_fn(X)                                        # assets x T, known at the close of t
    res = {}
    for q in (0, 1):
        rule_tot, bh_tot, nb = 0.0, 0.0, 0
        for off in range(3):
            w_old = np.zeros(A); r_rule = []; r_bh = []
            t = off
            idx = np.nonzero(per == q)[0]
            if not len(idx): continue
            t = idx[0] + off
            while t + hold <= idx[-1]:
                pick = (sig[:, t] > 0) & live[:, t]
                w = pick / max(pick.sum(), 1)
                turn = np.abs(w - w_old).sum()
                seg = Xz[:, t + 1:t + hold + 1]
                gross = np.log(np.maximum((w[:, None] * np.expm1(seg)).sum(axis=0) + 1, 1e-9)).sum() if pick.any() else 0.0
                r_rule.append(gross - turn * cost / 2)
                alive = live[:, t]
                wb = alive / max(alive.sum(), 1)
                r_bh.append(np.log(np.maximum((wb[:, None] * np.expm1(seg)).sum(axis=0) + 1, 1e-9)).sum())
                w_old = w * np.exp(seg.sum(axis=1)); w_old = w_old / max(w_old.sum(), 1e-12) if pick.any() else np.zeros(A)
                t += hold
            yrs = len(r_rule) * hold / bars_per_year
            rule_tot += sum(r_rule) / yrs; bh_tot += sum(r_bh) / yrs; nb += 1
        res[q] = (rule_tot / nb, bh_tot / nb)
    return res


def portfolio_ls(X, per, k, hold, cost, bars_per_year):
    """Long the coins that lagged the class average over the last k bars, short
    the ones that led, equal gross weight, rebalanced every `hold` bars from
    three offsets. Net log return per year, per period."""
    A, T = X.shape
    Xz = np.where(np.isfinite(X), X, 0.0); live = np.isfinite(X)
    P = past(X, k)
    res = {}
    for q in (0, 1):
        idx = np.nonzero(per == q)[0]; tot = 0.0
        for off in range(3):
            w_old = np.zeros(A); rets = []
            t = idx[0] + off
            while t + hold <= idx[-1]:
                ok = live[:, t] & np.isfinite(P[:, t])
                w = np.zeros(A)
                if ok.sum() >= 10:
                    rel = P[ok, t] - P[ok, t].mean()
                    w[ok] = -np.sign(rel) / ok.sum()
                seg = Xz[:, t + 1:t + hold + 1]
                gross = (w[:, None] * np.expm1(seg)).sum(axis=0)
                rets.append(np.log(np.maximum(1 + gross, 1e-9)).sum() - np.abs(w - w_old).sum() * cost / 2)
                w_old = w
                t += hold
            tot += sum(rets) / (len(rets) * hold / bars_per_year)
        res[q] = tot / 3
    return res


def past(X, k):
    Xz = np.where(np.isfinite(X), X, 0.0)
    c = np.concatenate([np.zeros((X.shape[0], 1)), np.cumsum(Xz, axis=1)], axis=1)
    out = np.full(X.shape, np.nan)
    out[:, k - 1:] = c[:, k:] - c[:, :-k]
    return out


def summarize(name, real, sur, unit):
    sur = np.array(sur)
    z = (real - sur.mean()) / sur.std(ddof=1)
    return dict(rule=name, real=float(real), surrogate_mean=float(sur.mean()), surrogate_sd=float(sur.std(ddof=1)), z=float(z), unit=unit)


out = {}
# ---- 1 and 2: portfolio rules
for name, res, cls, k, hold, cost, sign, bpy in (('stock_fade3', 'daily', 'stock', 3, 3, 0.0005, -1, 252),
                                                  ('crypto_trend20', 'daily', 'crypto', 20, 20, 0.0020, 1, 365)):
    syms, grid, M = aligned(res, cls)
    per = (grid >= cs.DAILY_SPLIT).astype(np.int8)
    paths = shared_surrogates(M, zlib.crc32(name.encode()))
    fn = (lambda X, k=k, sign=sign: sign * past(X, k))
    vals = [portfolio(X, per, fn, hold, cost, bpy) for X in paths]
    out[name] = {}
    for q, lab in ((0, 'first'), (1, 'second')):
        real_rule, real_bh = vals[0][q]
        edge = [v[q][0] - v[q][1] for v in vals]
        out[name][lab] = dict(rule_per_year=real_rule, buy_hold_per_year=real_bh, **summarize(name, edge[0], edge[1:], 'log return per year, rule minus buy-and-hold'))
        print(f'{name:16s} {lab:6s} rule {np.expm1(real_rule) * 100:+7.1f}%/yr  buy-and-hold {np.expm1(real_bh) * 100:+7.1f}%/yr  '
              f'edge {edge[0] * 100:+6.1f} pts vs chance {np.mean(edge[1:]) * 100:+6.1f} (z {out[name][lab]["z"]:+.1f})', flush=True)

# ---- the relative-reversal family
syms, grid, M = aligned('daily', 'crypto')
per = (grid >= cs.DAILY_SPLIT).astype(np.int8)
paths = shared_surrogates(M, zlib.crc32(b'crypto_relrev'))
for name, k, hold in (('crypto_relrev2', 2, 2), ('crypto_relrev40', 40, 40)):
    vals = [portfolio_ls(X, per, k, hold, 0.0010, 365) for X in paths]
    out[name] = {}
    for q, lab in ((0, 'first'), (1, 'second')):
        out[name][lab] = summarize(name, vals[0][q], [v[q] for v in vals[1:]], 'net log return per year, long/short')
        print(f'{name:16s} {lab:6s} net {np.expm1(vals[0][q]) * 100:+7.1f}%/yr  chance {np.expm1(np.mean([v[q] for v in vals[1:]])) * 100:+7.1f}%/yr '
              f'(z {out[name][lab]["z"]:+.1f})', flush=True)
fn = lambda X: -(past(X, 40) - np.nanmean(past(X, 40), axis=0, keepdims=True))
vals = [portfolio(X, per, fn, 40, 0.0020, 365) for X in paths]
out['crypto_laggards40'] = {}
for q, lab in ((0, 'first'), (1, 'second')):
    edge = [v[q][0] - v[q][1] for v in vals]
    out['crypto_laggards40'][lab] = dict(rule_per_year=vals[0][q][0], buy_hold_per_year=vals[0][q][1],
                                         **summarize('crypto_laggards40', edge[0], edge[1:], 'log return per year, rule minus buy-and-hold'))
    print(f'crypto_laggards40 {lab:6s} rule {np.expm1(vals[0][q][0]) * 100:+7.1f}%/yr  buy-and-hold {np.expm1(vals[0][q][1]) * 100:+7.1f}%/yr  '
          f'edge {edge[0] * 100:+6.1f} pts vs chance {np.mean(edge[1:]) * 100:+6.1f} (z {out["crypto_laggards40"][lab]["z"]:+.1f})', flush=True)

# ---- 3: hourly pullback buying, per trade (every path of a coin at once)
syms, grid, M = aligned('hourly', 'crypto')
per = (grid >= cs.HOURLY_SPLIT).astype(np.int8)
paths = shared_surrogates(M, zlib.crc32(b'crypto_pullback'))
NP = len(paths)
sums = {q: np.zeros(NP) for q in (0, 1)}; cnts = {q: np.zeros(NP) for q in (0, 1)}
bsum = {q: np.zeros(NP) for q in (0, 1)}; bcnt = {q: np.zeros(NP) for q in (0, 1)}
H = 72; w = 720
for i in range(M.shape[0]):
    ok = np.isfinite(M[i])
    if ok.sum() < 5000: continue
    first = np.argmax(ok)
    Rr = np.stack([np.where(np.isfinite(X[i]), X[i], 0.0)[first:] for X in paths])       # (NP, T)
    LPp = np.cumsum(Rr, axis=1)
    m = Rr[0].mean(); a2 = (Rr[0] - m) ** 2
    cs2 = np.r_[0, np.cumsum(a2)]; idx = np.arange(Rr.shape[1]); lo = np.maximum(idx - w, 0)
    sig_day = np.sqrt(np.where(idx >= w, (cs2[idx] - cs2[lo]) / np.maximum(idx - lo, 1), np.nan) * 24)
    D, AGE, PB, _ = cs.zigzag(LPp, 2.0 * sig_day, w)
    pt = per[first:][:Rr.shape[1]]
    T = Rr.shape[1]
    for pth in range(NP):
        t = w
        sig_ok = (D[pth] == 1) & (PB[pth] >= 0.5)
        cand = np.nonzero(sig_ok[w:T - H])[0] + w
        last = -10 ** 9
        for t in cand:
            if t - last < H: continue
            last = t
            q = pt[t]; sums[q][pth] += LPp[pth, t + H] - LPp[pth, t] - 0.002; cnts[q][pth] += 1
        for t0 in range(w, T - H, H):
            q = pt[t0]; bsum[q][pth] += LPp[pth, t0 + H] - LPp[pth, t0] - 0.002; bcnt[q][pth] += 1
res3 = {q: sums[q] / np.maximum(cnts[q], 1) for q in (0, 1)}
base3 = {q: bsum[q] / np.maximum(bcnt[q], 1) for q in (0, 1)}
n_trades = {q: int(cnts[q][0]) for q in (0, 1)}
out['crypto_pullback'] = {}
for q, lab in ((0, 'first'), (1, 'second')):
    edge = np.array(res3[q]) - np.array(base3[q])
    out['crypto_pullback'][lab] = dict(per_trade=float(res3[q][0]), random_entry=float(base3[q][0]), trades=n_trades[q],
                                       **summarize('crypto_pullback', edge[0], edge[1:], 'net log return per 72h trade, minus random entry'))
    print(f'crypto_pullback  {lab:6s} {n_trades[q]} trades, net {np.expm1(res3[q][0]) * 100:+.2f}% per trade, random entry {np.expm1(base3[q][0]) * 100:+.2f}%, '
          f'edge {edge[0] * 100:+.2f} vs chance {np.nanmean(edge[1:]) * 100:+.2f} (z {out["crypto_pullback"][lab]["z"]:+.1f})', flush=True)

# ---- 4: short the first bounce after a breakdown (perps), per trade
syms, grid, M = aligned('daily', 'crypto')
per = (grid >= cs.DAILY_SPLIT).astype(np.int8)
paths = shared_surrogates(M, zlib.crc32(b'crypto_deadcat'))
res4 = {0: [], 1: []}
for X in paths:
    trades = {0: [], 1: []}
    for i in range(X.shape[0]):
        x = X[i]; ok = np.isfinite(x)
        if ok.sum() < 400: continue
        first = np.argmax(ok); r = np.where(ok, x, 0.0)[first:]
        lp = np.r_[0, np.cumsum(r)]
        m = r.mean(); a2 = (r - m) ** 2
        w = 30; cs2 = np.r_[0, np.cumsum(a2)]; idx = np.arange(len(r)); lo = np.maximum(idx - w, 0)
        sd = np.sqrt(np.where(idx >= w, (cs2[idx] - cs2[lo]) / np.maximum(idx - lo, 1), np.nan))
        pt = per[first:]
        t = w
        while t < len(r) - 16:
            if np.isfinite(sd[t]) and r[t] <= -3 * sd[t]:
                b = t + 1                                                   # the breakdown's close is lp[b]
                seg = lp[b:b + 11]; low = np.minimum.accumulate(seg)
                trig = np.nonzero(seg >= low + sd[t])[0]
                if len(trig) and b + trig[0] + 5 < len(lp):
                    e = b + trig[0]
                    trades[pt[min(e, len(pt) - 1)]].append(-(lp[e + 5] - lp[e]) - 0.001)
                t += 10
            else:
                t += 1
    for q in (0, 1):
        res4[q].append(np.mean(trades[q]) if trades[q] else np.nan)
    if len(res4[0]) == 1:
        n4 = {q: len(trades[q]) for q in (0, 1)}
out['crypto_deadcat'] = {}
for q, lab in ((0, 'first'), (1, 'second')):
    v = np.array(res4[q])
    out['crypto_deadcat'][lab] = dict(per_trade=float(v[0]), trades=n4[q], **summarize('crypto_deadcat', v[0], v[1:], 'net log return per 5-day short'))
    print(f'crypto_deadcat   {lab:6s} {n4[q]} trades, net {np.expm1(v[0]) * 100:+.2f}% per short, chance {np.expm1(np.nanmean(v[1:])) * 100:+.2f}% '
          f'(z {out["crypto_deadcat"][lab]["z"]:+.1f})', flush=True)

json.dump(out, open(os.path.join(cs.CAD, 'backtest_results.json'), 'w'), indent=1)
