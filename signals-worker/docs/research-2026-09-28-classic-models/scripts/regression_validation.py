"""Statistical validation for regression: does the per-asset regression's
in-sample joint test (HAC Wald, production's hierarchical-model.mjs) pick fits
that work out of sample? Inputs are the overfitting audit's (2026-09-27):
is_fits.json and wf_outcomes.json (docs/research-2026-09-27-overfitting)."""
import json, math, os, collections
import numpy as np
from scipy import stats
DATA = os.environ.get('OVF_DATA', '.')
fits = json.load(open(os.path.join(DATA, 'is_fits.json'))); wf = json.load(open(os.path.join(DATA, 'wf_outcomes.json')))
by = collections.defaultdict(list)
for lane, sym, asof, target, pred, act in wf:
    if pred is None or act is None or not (math.isfinite(pred) and math.isfinite(act)): continue
    by[(lane, sym)].append((pred, act))
oos = {k: 1 - sum((a - p) ** 2 for p, a in v) / sum(a * a for p, a in v) for k, v in by.items() if len(v) >= 40 and sum(a * a for p, a in v) > 0}
out = {}
for lane in ('crypto|1', 'crypto|7', 'stock|1', 'stock|5'):
    rows = [f for f in fits if f['lane'] == lane and f.get('jointP') is not None and (lane, f['symbol']) in oos]
    sig = [f for f in rows if f['jointP'] < 0.05]; ns = [f for f in rows if f['jointP'] >= 0.05]
    o = lambda fs: np.array([oos[(lane, f['symbol'])] for f in fs])
    rk = lambda x: np.argsort(np.argsort(x))
    # A p-value that underflowed to 0 is significant under either reference
    # distribution; the F version is recomputed for the rest.
    good = [f for f in rows if f['jointP'] > 0]
    q = np.array([f['p'] - 1 for f in good]); n = np.array([f['n'] for f in good]); p = np.array([f['p'] for f in good])
    W = stats.chi2.isf(np.array([f['jointP'] for f in good]), q)
    f_sig = int(np.sum(stats.f.sf(W / q, q, n - p) < 0.05)) + (len(rows) - len(good))
    out[lane] = {'fits': len(rows), 'shareSignificant': len(sig) / len(rows), 'underflowed': len(rows) - len(good),
                 'shareSignificantF': f_sig / len(rows),
                 'oosMedianSignificant': float(np.median(o(sig))) if sig else None, 'oosMedianOther': float(np.median(o(ns))) if ns else None,
                 'oosPositiveSignificant': float(np.mean(o(sig) > 0)) if sig else None, 'oosPositiveOther': float(np.mean(o(ns) > 0)) if ns else None,
                 'spearmanJointPvsOosR2': float(np.corrcoef(rk(np.array([f['jointP'] for f in rows])), rk(o(rows)))[0, 1])}
    print(lane, json.dumps(out[lane]))
json.dump(out, open(os.path.join(DATA, 'regression_validation.json'), 'w'), indent=1)
