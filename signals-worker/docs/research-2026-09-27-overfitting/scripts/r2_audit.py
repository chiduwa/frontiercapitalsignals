"""R-squared overfitting audit of the per-asset regression (hierarchical-mlr-v4).

In-sample: the full-sample per-asset fit (production's own inference pass).
Out-of-sample: production's own walk-forward forecasts, scored against the
zero-return forecast the model is benchmarked on.

Then a correction applied honestly to the walk-forward forecasts: each
forecast is multiplied by a calibration slope estimated ONLY from that asset's
earlier (already matured) forecasts, partially pooled toward the class slope,
and clipped to [0, 1]. A slope below 1 is the textbook symptom of overfitting:
forecasts too extreme for what follows them.
"""
import os
SW = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))   # signals-worker/
import json, math, collections
import numpy as np

SP = os.environ.get('OVF_DATA', '.')
fits = json.load(open(f'{SP}/is_fits.json'))
wf = json.load(open(f'{SP}/wf_outcomes.json'))

# ---- out-of-sample R^2 per asset
by = collections.defaultdict(list)
for lane, sym, asof, target, pred, act in wf:
    if pred is None or act is None or not math.isfinite(pred) or not math.isfinite(act): continue
    by[(lane, sym)].append((asof, target, pred, act))
oos = {}
for key, rows in by.items():
    p = np.array([r[2] for r in rows]); a = np.array([r[3] for r in rows])
    if len(rows) < 40: continue
    oos[key] = (1 - np.sum((a - p) ** 2) / np.sum(a ** 2), len(rows))

report = {}
print('lane       assets  IS R2 (median)  adjusted R2  what pure noise gives  OOS R2 (median)  OOS R2 > 0   corr(IS, OOS) across assets')
for lane in ('crypto|1', 'crypto|7', 'stock|1', 'stock|5'):
    rows = [f for f in fits if f['lane'] == lane and f['r2'] is not None and (lane, f['symbol']) in oos]
    if not rows: continue
    is_r2 = np.array([f['r2'] for f in rows]); adj = np.array([f['adjR2'] if f['adjR2'] is not None else np.nan for f in rows])
    null = np.array([(f['p'] - 1) / (f['n'] - 1) for f in rows])
    o = np.array([oos[(lane, f['symbol'])][0] for f in rows])
    rho = np.corrcoef(np.argsort(np.argsort(is_r2)), np.argsort(np.argsort(o)))[0, 1]
    beats_null = float(np.mean(is_r2 > 2 * null))
    report[lane] = {'assets': len(rows), 'isR2': float(np.median(is_r2)), 'adjR2': float(np.nanmedian(adj)),
                    'nullR2': float(np.median(null)), 'oosR2': float(np.median(o)), 'oosPositive': float(np.mean(o > 0)),
                    'spearmanIsOos': float(rho), 'medianN': float(np.median([f['n'] for f in rows])),
                    'medianP': float(np.median([f['p'] for f in rows])), 'shareIsAboveTwiceNull': beats_null}
    r = report[lane]
    print(f"{lane:10s} {r['assets']:5d}   {r['isR2']:.4f}          {r['adjR2']:+.4f}      {r['nullR2']:.4f} (p={r['medianP']:.0f}, n={r['medianN']:.0f})     {r['oosR2']:+.4f}        {r['oosPositive']*100:4.0f}%       {rho:+.2f}")

# ---- the honest correction: a per-asset calibration slope from past forecasts only
def corrected(lane, prior_n=300):
    rows = [(k[1], r) for k, rs in by.items() if k[0] == lane for r in rs]
    rows.sort(key=lambda x: x[1][0])                        # by as-of date
    h = int(lane.split('|')[1])
    # running sums per asset and for the class, updated only once a forecast's target has passed
    s_pa = collections.defaultdict(float); s_pp = collections.defaultdict(float)
    c_pa = 0.0; c_pp = 0.0
    pending = []   # (targetDate, sym, p, a)
    raw_err = shr_err = pool_err = zero_err = 0.0
    per_asset = collections.defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])
    slopes = []
    import heapq
    for sym, (asof, target, p, a) in rows:
        while pending and pending[0][0] <= asof:
            _, s2, pp, aa = heapq.heappop(pending)
            s_pa[s2] += pp * aa; s_pp[s2] += pp * pp; c_pa += pp * aa; c_pp += pp * pp
        b_pool = min(1.0, max(0.0, c_pa / c_pp)) if c_pp > 0 else 0.0
        # partial pooling: the asset's own slope counts in proportion to its evidence
        if s_pp[sym] > 0:
            n_eff = s_pp[sym] / (c_pp / max(1, len(s_pp))) if c_pp > 0 else 0
            w = n_eff / (n_eff + prior_n / 100)
            b_own = s_pa[sym] / s_pp[sym]
            b = min(1.0, max(0.0, w * b_own + (1 - w) * b_pool))
        else:
            b = b_pool
        slopes.append(b)
        raw_err += (a - p) ** 2; shr_err += (a - b * p) ** 2; pool_err += (a - b_pool * p) ** 2; zero_err += a * a
        e = per_asset[sym]; e[0] += (a - p) ** 2; e[1] += (a - b * p) ** 2; e[2] += a * a; e[3] += 1
        heapq.heappush(pending, (target, sym, p, a))
    better = sum(1 for e in per_asset.values() if e[3] >= 40 and e[1] < e[0])
    counted = sum(1 for e in per_asset.values() if e[3] >= 40)
    return {'rawR2': 1 - raw_err / zero_err, 'shrunkR2': 1 - shr_err / zero_err, 'pooledSlopeR2': 1 - pool_err / zero_err,
            'medianSlope': float(np.median(slopes)), 'assetsImproved': better, 'assets': counted}

print('\nCorrection: forecasts scaled by a calibration slope learned from each asset\'s own past forecasts (partially pooled)')
for lane in ('crypto|1', 'crypto|7', 'stock|1', 'stock|5'):
    c = corrected(lane)
    report[lane]['correction'] = c
    print(f"{lane:10s} pooled OOS R2: raw {c['rawR2']:+.5f} -> corrected {c['shrunkR2']:+.5f} (class slope only {c['pooledSlopeR2']:+.5f}); "
          f"median slope {c['medianSlope']:.2f}; assets improved {c['assetsImproved']}/{c['assets']}")
json.dump(report, open(f'{SP}/r2_audit.json', 'w'), indent=1)
