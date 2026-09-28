"""The same class-wide tests as cadence_class.py, on each asset's moves
RELATIVE to its market: its return less the equal-weight return of the other
assets in its class at the same hour or date. The market's own swings are the
biggest thing every asset shares, and they can drown a rhythm that belongs to
the assets themselves. Shared sign draw, as in cadence_class.py.

usage: CAD_DATA=/data/cad [CAD_SURROGATES=200] python cadence_resid.py
writes CAD_DATA/resid_results.json"""
import json, os, sys, zlib
from concurrent.futures import ProcessPoolExecutor
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cadence_study as cs
import cadence_class as cc


def resid_stats(job):
    res, sym, cls, times, close, seed, signs = job
    cfg = cs.CFG[res]
    lc = np.log(close); r = np.diff(lc); tt = times[1:]
    period = (tt >= (cs.HOURLY_SPLIT if res == 'hourly' else cs.DAILY_SPLIT)).astype(np.int8)
    if min((period == 0).sum(), (period == 1).sum()) < (2000 if res == 'hourly' else 250):
        return None
    R = cs.surrogate_paths(r, seed, signs)
    stats = {}
    for h in cfg['horizons']:
        s = cs.serial_stats(R, period, h)
        stats[f'serial_pnl_{h}'] = [s[0][1], s[1][1]]
    m = np.nanmean(r); a2 = (np.where(np.isfinite(r), r, m) - m) ** 2
    w = cfg['vol_win']
    csum = np.concatenate([[0.0], np.cumsum(a2)]); idx = np.arange(len(r)); lo = np.maximum(idx - w, 0)
    var = np.where(idx >= w, (csum[idx] - csum[lo]) / np.maximum(idx - lo, 1), np.nan)
    sig_day = np.sqrt(var * cfg['per_day'])
    LP = lc[0] + np.concatenate([np.zeros((R.shape[0], 1)), np.cumsum(R, axis=1)], axis=1)[:, 1:]
    for k, h in cfg['scales']:
        st, _ = cs.swing_stats(LP, k * sig_day, period, w, h)
        for key in ('mom', 'age', 'pullback'):
            stats[f'swing{k}_{key}'] = [st[0][key], st[1][key]]
    return sym, stats


if __name__ == '__main__':
    only = set(sys.argv[1:])                              # e.g. daily|crypto: rerun just that group
    path = os.path.join(cs.CAD, 'resid_results.json')
    results = json.load(open(path)) if only and os.path.exists(path) else {}
    for res, cls, assets, grid in cc.groups():
        key = f'{res}|{cls}'
        if only and key not in only: continue
        pos = {int(t): i for i, t in enumerate(grid)}
        M = np.full((len(assets), len(grid)), np.nan)
        for i, (s, tt, c) in enumerate(assets):
            ix = np.array([pos[int(t)] for t in tt])
            M[i, ix[1:]] = np.diff(np.log(c))
        tot = np.nansum(M, axis=0); cnt = np.sum(np.isfinite(M), axis=0)
        rng = np.random.default_rng(zlib.crc32(('resid|' + key).encode()))
        signs = rng.integers(0, 2, size=(cs.S, len(grid)), dtype=np.int8) * 2 - 1
        jobs = []
        for i, (s, tt, c) in enumerate(assets):
            ix = np.array([pos[int(t)] for t in tt])
            own = M[i, ix[1:]]
            others = np.where(cnt[ix[1:]] > 1, (tot[ix[1:]] - own) / np.maximum(cnt[ix[1:]] - 1, 1), 0.0)
            rel = own - others
            rel = np.where(np.isfinite(rel), rel, 0.0)
            close = 100 * np.exp(np.r_[0, np.cumsum(rel)])
            jobs.append((res, s, cls, tt, close, zlib.crc32(f'resid|{key}|{s}'.encode()), signs[:, ix[1:]]))
        print(f'{key}: {len(jobs)} assets, relative to the rest of the class', flush=True)
        per = {}
        with ProcessPoolExecutor(int(os.environ.get('CAD_WORKERS', 6))) as ex:
            for out in ex.map(resid_stats, jobs, chunksize=1):
                if out is None: continue
                for t, (v0, v1) in out[1].items():
                    per.setdefault(t, ([], []))
                    per[t][0].append(np.asarray(v0, float)); per[t][1].append(np.asarray(v1, float))
        results[key] = {t: [cc.zrow(np.nanmean(np.stack(a), axis=0)) for a in pair] for t, pair in per.items()}
        json.dump(results, open(os.path.join(cs.CAD, 'resid_results.json'), 'w'), indent=1)
        print(f'{key}: done', flush=True)
