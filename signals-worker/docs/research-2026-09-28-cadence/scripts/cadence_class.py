"""Class-wide rhythm, tested so that co-movement cannot fake it.

Coins (and stocks) rise and fall together, so one market-wide swing shows up
as a hundred per-asset "effects", and pooling independent per-asset z-scores
overstates a class pattern many times over. Here every asset in a class gets
the SAME sign draw at the same hour or date: surrogate k flips all of them the
same way at the same time, which keeps their co-movement and still removes
any direction in time. The class statistic is the average over its assets,
computed for the real data and for each surrogate.

Also run on each class's equal-weight index (the market's own rhythm), with
the index's own surrogates, through cadence_study.analyze and
cadence_episodes.episodes.

Tests: the serial P&L at every horizon; the swing tests (mom, age, pullback,
cv, alt) at every size; and every pump / breakdown statistic.

usage: CAD_DATA=/data/cad [CAD_SURROGATES=200] python cadence_class.py
writes CAD_DATA/class_results.json"""
import json, os, sys, zlib
from concurrent.futures import ProcessPoolExecutor
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cadence_study as cs
import cadence_episodes as ce

EXCLUDE = cs.EXCLUDE
SWING_KEYS = ('mom', 'age', 'pullback', 'cv', 'alt')


def raw_stats(job):
    """The selected tests' per-path values (row 0 real) for one asset, with a
    shared sign draw."""
    res, sym, cls, times, close, seed, signs = job
    cfg = cs.CFG[res]
    lc = np.log(close); r = np.diff(lc); tt = times[1:]
    period = (tt >= (cs.HOURLY_SPLIT if res == 'hourly' else cs.DAILY_SPLIT)).astype(np.int8)
    if min((period == 0).sum(), (period == 1).sum()) < (2000 if res == 'hourly' else 250):
        return None
    R = cs.surrogate_paths(r, seed, signs)
    out = {}
    for h in cfg['horizons']:
        s = cs.serial_stats(R, period, h)
        out[f'serial_pnl_{h}'] = [s[0][1], s[1][1]]
    m = np.nanmean(r); a2 = (np.where(np.isfinite(r), r, m) - m) ** 2
    w = cfg['vol_win']
    csum = np.concatenate([[0.0], np.cumsum(a2)]); idx = np.arange(len(r)); lo = np.maximum(idx - w, 0)
    var = np.where(idx >= w, (csum[idx] - csum[lo]) / np.maximum(idx - lo, 1), np.nan)
    sig_day = np.sqrt(var * cfg['per_day'])
    LP = lc[0] + np.concatenate([np.zeros((R.shape[0], 1)), np.cumsum(R, axis=1)], axis=1)[:, 1:]
    for k, h in cfg['scales']:
        st, _ = cs.swing_stats(LP, k * sig_day, period, w, h)
        for key in SWING_KEYS:
            out[f'swing{k}_{key}'] = [st[0][key], st[1][key]]
    ep = ce.episodes(job)
    return sym, {k: [np.asarray(v[0], np.float64), np.asarray(v[1], np.float64)] for k, v in out.items()}, (ep[2] if ep else None)


def groups():
    z = np.load(os.path.join(cs.CAD, 'hourly.npz'))
    N = z['close'].shape[1]
    grid = z['t0'] + cs.H_MS * np.arange(N, dtype=np.int64)
    assets = []
    for j, s in enumerate(z['syms']):
        c = z['close'][j]; ok = np.isfinite(c); first = np.argmax(ok)
        c = c[first:].copy(); tt = grid[first:]
        for i in range(1, len(c)):
            if not np.isfinite(c[i]): c[i] = c[i - 1]
        assets.append((str(s), tt, c))
    yield 'hourly', 'crypto', assets, grid
    d = np.load(os.path.join(cs.CAD, 'daily.npz'))
    for cls in ('crypto', 'stock'):
        assets = [(str(s), d[f'{s}|date'], d[f'{s}|close']) for s, c in zip(d['syms'], d['cls']) if c == cls and s not in EXCLUDE]
        grid = np.unique(np.concatenate([a[1] for a in assets]))
        yield 'daily', cls, assets, grid


def zrow(vals):
    real, mu, sd, z = cs.zscore(np.asarray(vals))
    return dict(real=float(real), sur=float(mu), sd=float(sd), z=float(z))


if __name__ == '__main__':
    only = set(sys.argv[1:])                              # e.g. daily|crypto: rerun just that group
    path = os.path.join(cs.CAD, 'class_results.json')
    results = json.load(open(path)) if only and os.path.exists(path) else {}
    for res, cls, assets, grid in groups():
        key = f'{res}|{cls}'
        if only and key not in only: continue
        rng = np.random.default_rng(zlib.crc32(key.encode()))
        signs = (rng.integers(0, 2, size=(cs.S, len(grid)), dtype=np.int8) * 2 - 1)
        pos = {int(t): i for i, t in enumerate(grid)}
        jobs = []
        for s, tt, c in assets:
            ix = np.array([pos[int(t)] for t in tt[1:]])            # each return's date on the class grid
            jobs.append((res, s, cls, tt, c, zlib.crc32(f'{key}|{s}'.encode()), signs[:, ix]))
        print(f'{key}: {len(jobs)} assets', flush=True)
        per_test = {}; ep_sum = None; n_ok = 0
        with ProcessPoolExecutor(int(os.environ.get('CAD_WORKERS', 6))) as ex:
            for out in ex.map(raw_stats, jobs, chunksize=1):
                if out is None: continue
                sym, stats, ep = out; n_ok += 1
                for t, (v0, v1) in stats.items():
                    per_test.setdefault(t, ([], []))
                    per_test[t][0].append(v0); per_test[t][1].append(v1)
                if ep is not None:
                    ep_sum = ep if ep_sum is None else ep_sum + ep
        R = {'assets': n_ok, 'tests': {}, 'episodes': {}}
        for t, (a0, a1) in per_test.items():
            R['tests'][t] = [zrow(np.nanmean(np.stack(a), axis=0)) for a in (a0, a1)]
        names = ce.stat_names(res)
        for si, side in enumerate(ce.SIDES):
            for k, st in enumerate(names):
                R['episodes'][f'{side}|{st}'] = [dict(n=int(ep_sum[si, q, k, 1, 0]), **zrow(ep_sum[si, q, k, 0, :] / np.maximum(ep_sum[si, q, k, 1, :], 1)))
                                                  for q in (0, 1)]
        # the class's own equal-weight index
        M = np.full((len(assets), len(grid)), np.nan)
        for i, (s, tt, c) in enumerate(assets):
            ix = np.array([pos[int(t)] for t in tt])
            M[i, ix[1:]] = np.diff(np.log(c))
        idx_r = np.nanmean(M, axis=0)
        idx_r = np.where(np.isfinite(idx_r), idx_r, 0.0)
        idx_close = 100 * np.exp(np.cumsum(idx_r))
        first = np.argmax((~np.isnan(M)).sum(axis=0) >= 5)
        ijob = (res, f'INDEX_{cls}', 'market', grid[first:], idx_close[first:], zlib.crc32(f'{key}|index'.encode()))
        R['index'] = cs.analyze(ijob)
        iep = ce.episodes(ijob)
        if iep:
            R['index_episodes'] = {f'{side}|{st}': [dict(n=int(iep[2][si, q, k, 1, 0]), **zrow(iep[2][si, q, k, 0, :] / np.maximum(iep[2][si, q, k, 1, :], 1)))
                                                     for q in (0, 1)] for si, side in enumerate(ce.SIDES) for k, st in enumerate(names)}
        results[key] = R
        json.dump(results, open(os.path.join(cs.CAD, 'class_results.json'), 'w'), indent=1, default=float)
        print(f'{key}: done', flush=True)
