"""Winner's curse in per-asset composite records.

Assets whose own 2021-24 composite record clearly beat their class (one-sided
Wilson lower bound above the class rate, z = 1.645): how did they do in
2025-26, against (a) their raw 2021-24 rate and (b) that rate shrunk toward
the class with a prior worth 300 outcomes (the out-of-time optimum measured in
tech_weights_engine.py was 200-400)? Also the mirror group that clearly
trailed its class.
"""
import os
SW = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))   # signals-worker/
import json, math, collections
import numpy as np
SP = os.environ.get('OVF_DATA', '.')
N0, Z = 300, 1.645
def wilson(c, n, z, lower=True):
    p = c / n; d = 1 + z * z / n; ctr = p + z * z / (2 * n); m = z * math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)
    return (ctr - m) / d if lower else (ctr + m) / d
out = {}
for hz in (1440, 10080):
    cells = collections.defaultdict(lambda: [0, 0, 0, 0])
    for r in json.load(open(f'{SP}/engine_cells_{hz}.json')):
        if r['t'] != 'composite': continue
        v = cells[(r['cls'], r['s'])]
        if int(r['y']) <= 2024: v[0] += r['c']; v[1] += r['n']
        else: v[2] += r['c']; v[3] += r['n']
    cls_rate = {}
    for cls in ('crypto', 'stock'):
        c = sum(v[0] for k, v in cells.items() if k[0] == cls); n = sum(v[1] for k, v in cells.items() if k[0] == cls)
        cls_rate[cls] = c / n
    for cls in ('crypto', 'stock'):
        for label, pick in (('beat class', lambda v, p: wilson(v[0], v[1], Z) > p), ('trailed class', lambda v, p: wilson(v[0], v[1], Z, lower=False) < p)):
            grp = [v for k, v in cells.items() if k[0] == cls and v[1] >= 20 and v[3] >= 20 and pick(v, cls_rate[cls])]
            if not grp: continue
            p0 = cls_rate[cls]
            raw = sum(v[0] / v[1] * v[3] for v in grp) / sum(v[3] for v in grp)
            shr = sum((v[0] + p0 * N0) / (v[1] + N0) * v[3] for v in grp) / sum(v[3] for v in grp)
            act = sum(v[2] for v in grp) / sum(v[3] for v in grp)
            # a naive standard error of the realized rate, clustered by asset
            rates = np.array([v[2] / v[3] for v in grp]); se = rates.std(ddof=1) / math.sqrt(len(grp)) if len(grp) > 1 else float('nan')
            key = f'{cls}|{hz // 60}h|{label}'
            out[key] = {'assets': len(grp), 'classRate2124': p0, 'raw2124': raw, 'shrunkForecast': shr, 'actual2526': act, 'actualSE': se,
                        'medianTrainN': float(np.median([v[1] for v in grp]))}
            print(f'{key:28s} assets {len(grp):3d} (median record {np.median([v[1] for v in grp]):.0f})  class {p0:.3f}  '
                  f'own record {raw:.3f}  shrunk forecast {shr:.3f}  what happened {act:.3f} (+-{se:.3f})')
json.dump(out, open(f'{SP}/composite_curse.json', 'w'), indent=1)
