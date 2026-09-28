"""Summarizes cadence_episodes.py: for each class and side (pump, breakdown),
pooled over its assets, each statistic's real value against the same statistic
pooled over the surrogates (surrogate k of every asset), in both periods.

NAIVE: each asset's surrogates are drawn independently, but crashes and
rallies hit a class on the same days, so one market-wide event counts once per
asset and these z-scores overstate. The valid class test shares one sign draw
across the class (cadence_class.py; class_summary.py prints it).

usage: CAD_DATA=/data/cad python episodes_summary.py"""
import json, math, os
import numpy as np

CAD = os.environ.get('CAD_DATA', '.')
EXCLUDE = {'JPYC', 'SUN'}
out = {}
for res in ('hourly', 'daily'):
    path = os.path.join(CAD, f'episodes_{res}.npz')
    if not os.path.exists(path): continue
    z = np.load(path)
    syms, cls, stats, data = z['syms'], z['cls'], list(z['stats']), z['data'].astype(np.float64)   # (A, side, period, stat, sum/count, P)
    keep = np.array([s not in EXCLUDE for s in syms])
    syms, cls, data = syms[keep], cls[keep], data[keep]
    print(f'\n== {res}: {len(syms)} assets (NAIVE pooling: overstates; see class_summary.py) ==')
    for c in sorted(set(cls)):
        sel = cls == c
        if sel.sum() < 3: continue
        for si, side in enumerate(('pump', 'breakdown')):
            print(f'  {c} {side}s')
            for k, st in enumerate(stats):
                vals = []
                for q in (0, 1):
                    sm = data[sel, si, q, k, 0, :].sum(axis=0); ct = data[sel, si, q, k, 1, :].sum(axis=0)
                    v = sm / np.maximum(ct, 1)
                    zz = (v[0] - v[1:].mean()) / v[1:].std(ddof=1)
                    vals.append((v[0], v[1:].mean(), zz, int(ct[0])))
                scale = 100 if st.startswith(('fwd', 'dip')) else 100
                unit = '%' if st.startswith(('fwd', 'dip')) else '% of episodes'
                flag = '  <-- both periods' if abs(vals[0][2]) >= 3 and abs(vals[1][2]) >= 3 and np.sign(vals[0][2]) == np.sign(vals[1][2]) else ''
                print(f'    {st:9s} ' + '   '.join(f'{v * scale:+7.2f} vs {m * scale:+7.2f}{unit[:1]} (z {zz:+5.1f}, n {n})' for v, m, zz, n in vals) + flag)
                out[f'{res}|{c}|{side}|{st}'] = [dict(real=float(v), sur=float(m), z=float(zz), n=n) for v, m, zz, n in vals]
json.dump(out, open(os.path.join(CAD, 'episodes_summary.json'), 'w'), indent=1)
