"""How much of an asset's own technique record should the engine trust?

Live outcomes only (forecast_outcomes, provenance live, independent rows),
split at 2026-09-16. For every (symbol, technique, horizon) cell the first
half's record is used to predict the second half's hit rate, with the
engine's own shrinkage formula:

  predicted = (correct1 + priorAcc * N0) / (n1 + N0)

where priorAcc is the technique's class-wide first-half hit rate. N0 = 0 is
"trust the asset's own record", N0 = infinity is "the class record only", and
the engine uses N0 = 12 today. Scored by the binomial log-likelihood of the
second half's outcomes (higher is better), then the halves are swapped as a
check that the answer is not an accident of one split.
"""
import os
SW = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))   # signals-worker/
import json, math, collections
import numpy as np
SP = os.environ.get('OVF_DATA', '.')
rows = json.load(open(f'{SP}/tech_halves.json'))
cells = collections.defaultdict(dict)
for r in rows:
    cells[(r['asset_class'], r['symbol'], r['tech'], r['hz'])][r['half']] = (r['c'], r['n'])

def evaluate(train_half, test_half, n0s):
    cls_tot = collections.defaultdict(lambda: [0, 0])
    for (cls, sym, tech, hz), hv in cells.items():
        if train_half in hv:
            c, n = hv[train_half]; cls_tot[(cls, tech, hz)][0] += c; cls_tot[(cls, tech, hz)][1] += n
    out = {}
    for n0 in n0s:
        ll = 0.0; nn = 0
        for (cls, sym, tech, hz), hv in cells.items():
            if train_half not in hv or test_half not in hv: continue
            c1, n1 = hv[train_half]; c2, n2 = hv[test_half]
            ct = cls_tot[(cls, tech, hz)]
            prior = (ct[0] - c1 + 1) / (ct[1] - n1 + 2)          # class record WITHOUT this cell
            p = (c1 + prior * n0) / (n1 + n0) if math.isfinite(n0) else prior
            p = min(max(p, 1e-4), 1 - 1e-4)
            ll += c2 * math.log(p) + (n2 - c2) * math.log(1 - p); nn += n2
        out[n0] = ll / nn
    return out

n0s = [0, 3, 6, 12, 25, 50, 100, 200, 400, 1000, math.inf]
for tr, te in ((1, 2), (2, 1)):
    res = evaluate(tr, te, n0s)
    best = max(res, key=res.get)
    print(f'train half {tr} -> predict half {te}: mean log-likelihood per outcome (higher is better)')
    for n0 in n0s:
        mark = '  <- engine today' if n0 == 12 else ('  <- best' if n0 == best else '')
        print(f'   N0 = {str(n0):>5s}: {res[n0]:.5f}{mark}')
    print(f'   best N0 = {best}; gain over the engine {res[best] - res[12]:+.5f} per outcome')

# The direct persistence check: does an asset's first-half edge over its class
# predict its second-half edge? Only cells with at least 15 outcomes in both.
xs, ys = [], []
cls_rate = collections.defaultdict(lambda: [0, 0, 0, 0])
for (cls, sym, tech, hz), hv in cells.items():
    for hlf in (1, 2):
        if hlf in hv:
            k = cls_rate[(cls, tech, hz)]; k[2 * (hlf - 1)] += hv[hlf][0]; k[2 * (hlf - 1) + 1] += hv[hlf][1]
for (cls, sym, tech, hz), hv in cells.items():
    if 1 in hv and 2 in hv and hv[1][1] >= 15 and hv[2][1] >= 15:
        k = cls_rate[(cls, tech, hz)]
        xs.append(hv[1][0] / hv[1][1] - k[0] / k[1]); ys.append(hv[2][0] / hv[2][1] - k[2] / k[3])
xs, ys = np.array(xs), np.array(ys)
if len(xs) < 3:
    print(f'\ncells with >= 15 outcomes in both halves: {len(xs)}; too few for the persistence check')
    raise SystemExit
print(f'\ncells with >= 15 outcomes in both halves: {len(xs)}; correlation of edge-over-class, half 1 vs half 2: {np.corrcoef(xs, ys)[0,1]:+.3f}')
q = np.quantile(xs, [0.2, 0.8])
print(f'   cells in the top fifth in half 1 (edge {xs[xs >= q[1]].mean():+.3f}) had {ys[xs >= q[1]].mean():+.3f} in half 2; bottom fifth {xs[xs <= q[0]].mean():+.3f} -> {ys[xs <= q[0]].mean():+.3f}')
