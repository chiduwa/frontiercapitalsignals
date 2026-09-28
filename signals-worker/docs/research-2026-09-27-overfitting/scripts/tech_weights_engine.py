"""The prior-strength test on the data the engine actually reads.

The engine's reliability map (loadReliability) counts every confluence-v9
technique outcome, replayed history included: ~527k outcomes over 2021-2026,
not just the ~46k live ones. Cells are therefore much larger than in the
live-only test (tech_weights.py), which is exactly where trusting an asset's
own record could start to pay. Same scoring: the engine's own formula

  predicted = (correct1 + classAcc1 * N0) / (n1 + N0)

fitted on earlier years, scored by the binomial log-likelihood of later
years' outcomes. Composite is reported apart: it is the engine's output, not
a technique the per-asset weights act on.
"""
import os
SW = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))   # signals-worker/
import json, math, collections
import numpy as np
SP = os.environ.get('OVF_DATA', '.')
cells = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0]))   # (cls,s,t,hz) -> year -> [c,n]
for hz in (1440, 10080):
    for r in json.load(open(f'{SP}/engine_cells_{hz}.json')):
        v = cells[(r['cls'], r['s'], r['t'], hz)][int(r['y'])]; v[0] += r['c']; v[1] += r['n']

N0S = [0, 6, 12, 25, 50, 100, 200, 400, 1000, math.inf]
FOLDS = [('2021-23 -> 2024', range(2021, 2024), range(2024, 2025)),
         ('2021-24 -> 2025-26', range(2021, 2025), range(2025, 2027)),
         ('2025-26 -> 2021-24', range(2025, 2027), range(2021, 2025))]

def fold_terms(train_years, test_years, keep):
    """Per cell: (symbol, c1, n1, prior, c2, n2) with a leave-one-out class prior."""
    tot = collections.defaultdict(lambda: [0, 0])
    tr = {}
    for key, yrs in cells.items():
        if not keep(key): continue
        c1 = sum(yrs[y][0] for y in train_years if y in yrs); n1 = sum(yrs[y][1] for y in train_years if y in yrs)
        c2 = sum(yrs[y][0] for y in test_years if y in yrs); n2 = sum(yrs[y][1] for y in test_years if y in yrs)
        tr[key] = (c1, n1, c2, n2)
        t = tot[(key[0], key[2], key[3])]; t[0] += c1; t[1] += n1
    out = []
    for key, (c1, n1, c2, n2) in tr.items():
        if n2 == 0: continue
        t = tot[(key[0], key[2], key[3])]
        if t[1] - n1 < 50: continue
        prior = (t[0] - c1 + 1) / (t[1] - n1 + 2)
        out.append((key, c1, n1, prior, c2, n2))
    return out

def ll(terms, n0):
    s = 0.0; nn = 0
    for key, c1, n1, prior, c2, n2 in terms:
        p = prior if not math.isfinite(n0) else ((c1 + prior * n0) / (n1 + n0) if n1 + n0 > 0 else prior)
        p = min(max(p, 1e-4), 1 - 1e-4)
        s += c2 * math.log(p) + (n2 - c2) * math.log(1 - p); nn += n2
    return s, nn

def report(label, keep):
    print(f'\n##### {label}')
    res = {}
    for name, trn, tst in FOLDS:
        terms = fold_terms(list(trn), list(tst), keep)
        n1s = np.array([t[2] for t in terms if t[2] > 0])
        vals = {n0: ll(terms, n0) for n0 in N0S}
        per = {n0: v[0] / v[1] for n0, v in vals.items()}
        best = max(per, key=per.get)
        # cluster bootstrap over symbols for the 12 -> 400 gain
        by_sym = collections.defaultdict(list)
        for t in terms: by_sym[t[0][1]].append(t)
        syms = list(by_sym)
        g = {s: (ll(by_sym[s], 400)[0] - ll(by_sym[s], 12)[0], ll(by_sym[s], 12)[1]) for s in syms}
        rng = np.random.default_rng(1); boots = []
        arr_g = np.array([g[s][0] for s in syms]); arr_n = np.array([g[s][1] for s in syms])
        for _ in range(2000):
            idx = rng.integers(0, len(syms), len(syms)); boots.append(arr_g[idx].sum() / arr_n[idx].sum())
        lo, hi = np.percentile(boots, [2.5, 97.5])
        print(f'  {name}: {len(terms)} cells, {vals[12][1]} test outcomes, median train record {np.median(n1s):.0f} (90th pct {np.percentile(n1s, 90):.0f})')
        print('    ' + '  '.join(f'N0={n0}: {per[n0]:.5f}' for n0 in N0S))
        print(f'    best N0 = {best}; 400 vs 12: {per[400] - per[12]:+.5f} per outcome (95% CI over assets {lo:+.5f} to {hi:+.5f})')
        res[name] = {'cells': len(terms), 'testOutcomes': vals[12][1], 'medianTrainRecord': float(np.median(n1s)),
                     'p90TrainRecord': float(np.percentile(n1s, 90)), 'll': {str(k): v for k, v in per.items()},
                     'best': str(best), 'gain400vs12': per[400] - per[12], 'ci': [float(lo), float(hi)]}
    return res

# Every pre-2026 confluence-v9 outcome is a composite one (the replay records
# only the composite), so technique records exist only in 2026 and are tiny
# (median 5 outcomes a cell at 24h, 1 at 168h): the year folds apply to the
# composite alone, and the live half-split (tech_weights.py) is the technique test.
out = {'composite': report('composite only: does an asset own composite record persist across years?', lambda k: k[2] == 'composite')}

json.dump(out, open(f'{SP}/tech_weights_engine.json', 'w'), indent=1)
