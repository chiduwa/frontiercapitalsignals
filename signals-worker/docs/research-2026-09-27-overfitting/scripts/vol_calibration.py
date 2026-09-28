"""Overfitting audit, volatility side: is the tournament's per-asset
calibration factor fitting noise, and does shrinking it help out of sample?

Uses model-tournament.py's own base_sigma / log_move / matured and its QLIKE
loss on its own input rows. Walk-forward: at every refit date the factors are
estimated only from labels matured by then (the tournament's own `matured`),
then frozen and scored on the following dates.

Variants per (asset, base source):
  raw        k = 1 (no calibration)
  perAsset   k = mean(ratio) over the asset's matured labels (what the
             tournament's `calibrated` scale does today)
  pooled     one k per class and source, from every asset's labels
  shrunk     per-asset log k pulled toward the class by empirical Bayes:
             w = tau^2 / (tau^2 + se^2), se from the asset's own ratio spread
             and its effective sample size (overlapping labels divided by h)
"""
import os
SW = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))   # signals-worker/
import importlib.util, json, math, sys, collections
import numpy as np

SP = os.environ.get('OVF_DATA', '.')
spec = importlib.util.spec_from_file_location('mt', os.path.join(SW, 'scripts', 'model-tournament.py'))
mt = importlib.util.module_from_spec(spec); spec.loader.exec_module(mt)

data = json.load(open(f'{SP}/tourn-input.json'))
cls_of = data['assetClassBySymbol']
by = collections.defaultdict(list)
for r in data['rows']:
    by[(r['symbol'], r['horizon'])].append(r)
for k in by: by[k].sort(key=lambda r: r['date'])

SOURCES = ('garchWeekday', 'garch', 'harWeekday', 'ewma', 'harEqual', 'trailing')
START, END, REFIT = '2024-09-27', '2026-09-19', 28
refits = []
d = np.datetime64(START)
while d <= np.datetime64(END):
    refits.append(str(d)); d += np.timedelta64(REFIT, 'D')

def ratios(rows, src, h):
    out = []
    for r in rows:
        s = mt.base_sigma(r, src, h)
        if s: out.append(mt.log_move(r) ** 2 / s ** 2)
    return np.array(out)

def dl_tau2(y, v):
    """DerSimonian-Laird between-asset variance of estimates y with variances v."""
    w = 1 / v
    mu = np.sum(w * y) / np.sum(w)
    q = np.sum(w * (y - mu) ** 2)
    c = np.sum(w) - np.sum(w ** 2) / np.sum(w)
    return max(0.0, (q - (len(y) - 1)) / c) if c > 0 else 0.0

# Precompute per (asset, horizon): dates, target dates, realized log move^2,
# and each source's sigma, as arrays. The loss and the estimates below are the
# tournament's own formulas applied to these arrays.
pre = {}
for key, rows in by.items():
    h = key[1]
    dates = np.array([r['date'] for r in rows])
    tdates = np.array([r['targetDate'] for r in rows])
    has = np.array([r['target'] is not None for r in rows])
    lm2 = np.array([mt.log_move(r) ** 2 if r['target'] is not None else np.nan for r in rows])
    sig = {src: np.array([mt.base_sigma(r, src, h) or np.nan for r in rows], dtype=float) for src in SOURCES}
    pre[key] = (dates, tdates, has, lm2, sig)

TRAIN_MAX = mt.TRAIN_MAX
losses = collections.defaultdict(list)   # (cls, h, src, variant) -> [(date, symbol, loss)]
weights_seen = collections.defaultdict(list)
for i, t0 in enumerate(refits):
    t1 = refits[i + 1] if i + 1 < len(refits) else END
    for cls in ('crypto', 'stock'):
        for h in ((1, 7) if cls == 'crypto' else (1, 5)):
            keys = [k for k in by if k[1] == h and cls_of.get(k[0]) == cls]
            for src in SOURCES:
                est = {}
                for key in keys:
                    dates, tdates, has, lm2, sig = pre[key]
                    m = has & (tdates <= t0)
                    idx = np.nonzero(m)[0][-TRAIN_MAX:]
                    s = sig[src][idx]
                    ok = np.isfinite(s) & (s > 0)
                    rr = lm2[idx][ok] / s[ok] ** 2
                    if len(rr) < 30: continue
                    k = float(rr.mean())
                    neff = max(len(rr) / h, 2)
                    se2 = float(rr.var(ddof=1) / neff) / (k * k)      # delta method, variance of log k
                    est[key] = (math.log(k), se2, len(rr))
                if len(est) < 3: continue
                y = np.array([e[0] for e in est.values()]); v = np.array([e[1] for e in est.values()])
                tau2 = dl_tau2(y, v)
                w_all = 1 / (v + tau2)
                mu = float(np.sum(w_all * y) / np.sum(w_all))
                for key, (lk, se2, n) in est.items():
                    w = tau2 / (tau2 + se2) if tau2 + se2 > 0 else 0.0
                    weights_seen[(cls, h, src)].append(w)
                    ks = {'raw': 1.0, 'perAsset': math.exp(lk), 'pooled': math.exp(mu), 'shrunk': math.exp(mu + w * (lk - mu))}
                    dates, tdates, has, lm2, sig = pre[key]
                    sel = np.nonzero((dates > t0) & (dates <= t1) & has & np.isfinite(sig[src]) & (sig[src] > 0))[0]
                    if not len(sel): continue
                    s2 = sig[src][sel] ** 2
                    for name, kk in ks.items():
                        L = lm2[sel] / (kk * s2) + np.log(kk * s2)
                        losses[(cls, h, src, name)].extend(zip(dates[sel], [key[0]] * len(sel), L))
    print(f'refit {t0} done', flush=True)

def clustered_diff(a, b, step):
    """mean(a - b) with a t-stat over dates, keeping one date per `step` days."""
    da = collections.defaultdict(list)
    mb = {(dd, s): L for dd, s, L in b}
    for dd, s, L in a:
        if (dd, s) in mb: da[dd].append(L - mb[(dd, s)])
    dates = sorted(da)
    if step > 1: dates = dates[::step]
    m = np.array([np.mean(da[x]) for x in dates])
    if len(m) < 3: return None, None, len(m)
    return float(m.mean()), float(m.mean() / (m.std(ddof=1) / math.sqrt(len(m)))), len(m)

out = {}
for cls in ('crypto', 'stock'):
    for h in ((1, 7) if cls == 'crypto' else (1, 5)):
        print(f'\n=== {cls} {h}d  (QLIKE, lower is better; diff vs perAsset = what the tournament does now) ===')
        for src in SOURCES:
            base = losses.get((cls, h, src, 'perAsset'))
            if not base: continue
            w = weights_seen[(cls, h, src)]
            row = {'n': len(base), 'meanWeight': float(np.mean(w)) if w else None}
            line = f'{src:13s} n={len(base):6d}  mean EB weight on own estimate {np.mean(w):.2f} | '
            for name in ('raw', 'pooled', 'shrunk'):
                m, t, nd = clustered_diff(losses[(cls, h, src, name)], base, h)
                row[name] = {'diff': m, 't': t, 'dates': nd}
                line += f'{name} {m:+.4f} (t {t:+.1f})  '
            print(line)
            out[f'{cls}|{h}|{src}'] = row
json.dump(out, open(f'{SP}/vol_calibration.json', 'w'), indent=1)
