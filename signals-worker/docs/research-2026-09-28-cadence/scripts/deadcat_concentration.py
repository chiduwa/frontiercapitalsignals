"""The dead-cat short (cadence_backtest.py's crypto_deadcat) on real data only:
how concentrated in time are its trades and its profit? Crashes hit every coin
in the same week, so 900 trades can be a handful of bets on the market.

usage: CAD_DATA=/data/cad python deadcat_concentration.py"""
import collections, math, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cadence_study as cs
import cadence_class as cc

for res, cls, assets, grid in cc.groups():
    if (res, cls) != ('daily', 'crypto'): continue
    trades = []
    for s, tt, c in assets:
        r = np.diff(np.log(c)); lp = np.log(c)
        m = r.mean(); a2 = (r - m) ** 2
        w = 30; cs2 = np.r_[0, np.cumsum(a2)]; idx = np.arange(len(r)); lo = np.maximum(idx - w, 0)
        sd = np.sqrt(np.where(idx >= w, (cs2[idx] - cs2[lo]) / np.maximum(idx - lo, 1), np.nan))
        t = w
        while t < len(r) - 16:
            if np.isfinite(sd[t]) and r[t] <= -3 * sd[t]:
                b = t + 1
                seg = lp[b:b + 11]; low = np.minimum.accumulate(seg)
                trig = np.nonzero(seg >= low + sd[t])[0]
                if len(trig) and b + trig[0] + 5 < len(lp):
                    e = b + trig[0]
                    trades.append((int(tt[e]), s, -(lp[e + 5] - lp[e]) - 0.001))
                t += 10
            else:
                t += 1
    for lab, lo_, hi_ in (('first', -10 ** 9, cs.DAILY_SPLIT), ('second', cs.DAILY_SPLIT, 10 ** 9)):
        T = [x for x in trades if lo_ <= x[0] < hi_]
        wk = collections.defaultdict(list)
        for d, s, v in T: wk[d // 7].append(v)
        wm = np.array([np.mean(v) for v in wk.values()]); wsum = {k: np.sum(v) for k, v in wk.items()}
        t_week = wm.mean() / (wm.std(ddof=1) / math.sqrt(len(wm)))
        tot = sum(v for _, _, v in T); top = sorted(wsum.values(), reverse=True)[:5]
        rest = [v for k, vs in wk.items() if wsum[k] not in top for v in vs]
        busiest = sorted(wk.items(), key=lambda kv: -len(kv[1]))[:3]
        print(f'{lab}: {len(T)} shorts in {len(wk)} weeks, {np.mean([v for _, _, v in T]) * 100:+.2f}% per short; week-clustered t {t_week:.2f}; '
              f'5 best weeks = {sum(top) / tot * 100:.0f}% of the profit; without them {np.mean(rest) * 100:+.2f}% per short; busiest weeks: '
              + ', '.join(f"{np.datetime64(int(k * 7), 'D')} ({len(v)} shorts, {np.mean(v) * 100:+.1f}%)" for k, v in busiest))
