"""Cadence inside pumps and breakdowns. A pump starts when an asset's move over
the last day is at least 3 of its own recent daily standard deviations (hourly
data: the last 24 hours, read every hour; daily data: one session), a
breakdown when it is at most -3. At most one of each per asset per 72 hours
(hourly) or 10 sessions (daily). The same rule runs on the real returns and on
cadence_study.py's sign-randomized surrogates, so every number is compared with
what a pump or breakdown looks like when the size of moves is real but their
direction is chance.

From the close of the bar that shows the episode (the earliest a trader could
act), per episode:
  fwd_h      return h bars later (continuation or give-back)
  peak_b     when the pump's high (breakdown's low) of the next week came
  second     a second leg: the move extends at least 1 sd past its extreme
             at detection, within 3 days (hourly) or 10 sessions (daily)
  dip        pumps: buy the first pullback of 1 sd from the running high
             within that window, hold 1 day (hourly) or 5 sessions (daily);
             breakdowns: the same after the first 1 sd bounce off the low

usage: CAD_DATA=/data/cad [CAD_SURROGATES=200] python cadence_episodes.py [hourly|daily|all]
writes CAD_DATA/episodes_<res>.npz"""
import os, sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cadence_study as cs

CFG = {
    'hourly': dict(look=24, per_day=24, vol_win=720, refractory=72, fwd=[4, 12, 24, 48, 72, 168], window=168,
                   peak_edges=[0, 4, 12, 24, 72, 169], leg_window=72, hold=24),
    'daily': dict(look=1, per_day=1, vol_win=30, refractory=10, fwd=[1, 3, 5, 10, 20], window=20,
                  peak_edges=[0, 1, 3, 5, 10, 21], leg_window=10, hold=5),
}
SIDES = ('pump', 'breakdown')


def stat_names(res):
    c = CFG[res]
    return [f'fwd_{h}' for h in c['fwd']] + [f'peak_{i}' for i in range(len(c['peak_edges']) - 1)] + ['second', 'dip']


def episodes(job):
    res, sym, cls, times, close, seed = job[:6]
    signs = job[6] if len(job) > 6 else None          # a class-wide sign draw (cadence_class.py)
    c = CFG[res]
    lc = np.log(close); r = np.diff(lc); tt = times[1:]
    split = cs.HOURLY_SPLIT if res == 'hourly' else cs.DAILY_SPLIT
    period = (tt >= split).astype(np.int8)
    if min((period == 0).sum(), (period == 1).sum()) < (2000 if res == 'hourly' else 250):
        return None
    R = cs.surrogate_paths(r, seed, signs)
    P, T = R.shape
    LP = lc[0] + np.concatenate([np.zeros((P, 1)), np.cumsum(R, axis=1)], axis=1)     # LP[:, i] = log price at bar i (i = 0..T)
    m = np.nanmean(r); a2 = (np.where(np.isfinite(r), r, m) - m) ** 2
    w = c['vol_win']
    csum = np.concatenate([[0.0], np.cumsum(a2)])
    idx = np.arange(T)
    lo = np.maximum(idx - w, 0)
    var = np.where(idx >= w, (csum[idx] - csum[lo]) / np.maximum(idx - lo, 1), np.nan)
    sig = np.sqrt(var * c['per_day'])                        # one day's sd, known before return i
    names = stat_names(res)
    out = np.zeros((2, 2, len(names), 2, P), dtype=np.float64)   # side, period, stat, (sum, count), path
    L = c['look']
    for p in range(P):
        lp = LP[p]
        move = lp[L:] - lp[:-L]                              # move over the last L bars, ending at bar i+L
        bar = np.arange(L, T + 1)                            # the bar that shows it
        s = sig[bar - 1]
        for si, side in enumerate(SIDES):
            hit = (move >= 3 * s) if side == 'pump' else (move <= -3 * s)
            hit &= np.isfinite(s)
            starts = []; last = -10 ** 9
            for b in bar[hit]:
                if b - last >= c['refractory'] and b + c['window'] <= T:
                    starts.append(b); last = b
            if not starts: continue
            st = np.array(starts)
            per = period[st - 1]
            sg = 1 if side == 'pump' else -1
            k = 0
            for h in c['fwd']:
                v = lp[st + h] - lp[st]
                for q in (0, 1):
                    sel = per == q
                    out[si, q, k, 0, p] += v[sel].sum(); out[si, q, k, 1, p] += sel.sum()
                k += 1
            W = c['window']
            paths = lp[st[:, None] + np.arange(0, W + 1)[None, :]]            # (n, W+1)
            when = (np.argmax(paths, axis=1) if side == 'pump' else np.argmin(paths, axis=1))
            edges = c['peak_edges']
            for b in range(len(edges) - 1):
                inb = (when >= edges[b]) & (when < edges[b + 1])
                for q in (0, 1):
                    sel = per == q
                    out[si, q, k, 0, p] += inb[sel].sum(); out[si, q, k, 1, p] += sel.sum()
                k += 1
            # a second leg past the extreme at detection
            LW = c['leg_window']
            ext0 = np.array([lp[max(0, b - L):b + 1].max() if side == 'pump' else lp[max(0, b - L):b + 1].min() for b in st])
            fut = paths[:, 1:LW + 1]
            sd_at = s[st - L]
            second = ((fut.max(axis=1) >= ext0 + sd_at) if side == 'pump' else (fut.min(axis=1) <= ext0 - sd_at)).astype(float)
            for q in (0, 1):
                sel = per == q
                out[si, q, k, 0, p] += second[sel].sum(); out[si, q, k, 1, p] += sel.sum()
            k += 1
            # buy the first pullback (pumps) / the first bounce (breakdowns), hold
            hold = c['hold']
            for e, b in enumerate(st):
                seg = lp[b:b + LW + 1]
                run = np.maximum.accumulate(seg) if side == 'pump' else np.minimum.accumulate(seg)
                trig = np.nonzero((seg <= run - sd_at[e]) if side == 'pump' else (seg >= run + sd_at[e]))[0]
                if not len(trig): continue
                ti = b + trig[0]
                if ti + hold > T: continue
                q = per[e]
                out[si, q, k, 0, p] += lp[ti + hold] - lp[ti]; out[si, q, k, 1, p] += 1
    return sym, cls, out


if __name__ == '__main__':
    kinds = ['hourly', 'daily'] if len(sys.argv) < 2 or sys.argv[1] == 'all' else [sys.argv[1]]
    for kind in kinds:
        todo = list(cs.jobs(kind))
        syms, clss, arrs = [], [], []
        with ProcessPoolExecutor(int(os.environ.get('CAD_WORKERS', 6))) as ex:
            for n, res in enumerate(ex.map(episodes, todo, chunksize=1)):
                if res is None: continue
                syms.append(res[0]); clss.append(res[1]); arrs.append(res[2].astype(np.float32))
                if (n + 1) % 50 == 0: print(f'  {kind} {n + 1}/{len(todo)}', flush=True)
        np.savez_compressed(os.path.join(cs.CAD, f'episodes_{kind}.npz'), syms=np.array(syms), cls=np.array(clss),
                            stats=np.array(stat_names(kind)), data=np.stack(arrs))
        print(f'{kind}: {len(syms)} assets', flush=True)
