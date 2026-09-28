"""Parity: the production module (scripts/decoupling-watch.mjs) against the
study (decoupling_study.py) on the same spot bars. Writes the bars as JSON,
has node compute the rule's inputs at sampled hours, and compares them with
the study's panel: log volume ratio, log volume against the median coin,
8-hour excess z, the big-move threshold, and whether the rule fires.

usage: DC_DATA=/path/to/spot python parity.py   (run from signals-worker/)"""
import glob, json, math, os, subprocess, sys
import numpy as np

D = os.environ.get('DC_DATA', '.')
bars = {}
for f in sorted(glob.glob(os.path.join(D, '*.npz'))):
    s = os.path.basename(f)[:-4]
    if s == 'decoupling_panel': continue
    k = np.load(f)['klines']
    bars[s] = [{'openTime': int(r[0]), 'close': float(r[4]), 'quoteVolume': float(r[6])} for r in k]
bars_path = os.path.join(D, 'parity_bars.json')
json.dump(bars, open(bars_path, 'w'))
here = os.path.dirname(os.path.abspath(__file__))
js = subprocess.run(['node', os.path.join(here, 'parity.mjs'), bars_path], capture_output=True, text=True, check=True)
J = json.loads(js.stdout)
Z = np.load(os.path.join(D, 'decoupling_panel.npz'))
hours = Z['hours'].astype('datetime64[h]')
assert J['t0'] == int(hours[0].astype('datetime64[ms]').astype('int64')), 'panels start on different hours'
worst = {'lvr': 0.0, 'lvrx': 0.0, 'z': 0.0, 'thr': 0.0}
n, side_mismatch = 0, []
for r in J['rows']:
    py = {'lvr': Z[f"{r['s']}|vr_8"][r['i']], 'lvrx': Z[f"{r['s']}|vrx_8"][r['i']], 'z': Z[f"{r['s']}|excz_8"][r['i']], 'thr': Z[f"{r['s']}|thr"][r['i']]}
    for k in worst:
        a, b = r[k], py[k]
        if a is None or not np.isfinite(b):
            assert (a is None) == (not np.isfinite(b)), (r, k, b)
            continue
        worst[k] = max(worst[k], abs(a - b)); n += 1
    with np.errstate(invalid='ignore'):
        pside = int(np.sign(py['z'])) if (py['lvr'] >= math.log(3) and py['lvrx'] >= math.log(2) and abs(py['z']) >= 2) else 0
    if pside != r['side']: side_mismatch.append((r['s'], r['i'], pside, r['side']))
res = {'values': n, 'maxAbsDiff': worst, 'sideMismatches': side_mismatch}
print(json.dumps(res))
json.dump(res, open(os.path.join(D, 'parity.json'), 'w'), indent=1)
sys.exit(1 if side_mismatch or max(worst.values()) > 1e-9 else 0)
