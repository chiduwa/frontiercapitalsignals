"""Does choosing a volatility model PER ASSET overfit?

Same inputs and walk-forward as vol_calibration.py, all sources calibrated by
the empirical-Bayes shrunk factor (that file's best variant). At each refit
date, per asset:

  fixed       one source for every asset: garchWeekday
  perAsset    the source with the lowest QLIKE over the asset's trailing 360
              days of already-scored forecasts (what "pick this asset's best
              model" means, done honestly: only past forecasts decide)
  shrunkPick  per asset only if its best source beat the class's best source
              on that asset by a clear margin (t >= 2 over dates); else the
              class's best source over the same trailing window
  combo       equal-weight average of log variance across all sources

Scored only where every variant has a forecast (after the first 360 days).
"""
import os
SW = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))   # signals-worker/
import importlib.util, json, math, collections
import numpy as np

SP = os.environ.get('OVF_DATA', '.')
spec = importlib.util.spec_from_file_location('mt', os.path.join(SW, 'scripts', 'model-tournament.py'))
mt = importlib.util.module_from_spec(spec); spec.loader.exec_module(mt)
data = json.load(open(f'{SP}/tourn-input.json'))
cls_of = data['assetClassBySymbol']
by = collections.defaultdict(list)
for r in data['rows']: by[(r['symbol'], r['horizon'])].append(r)
for k in by: by[k].sort(key=lambda r: r['date'])
SOURCES = ('garchWeekday', 'garch', 'harWeekday', 'ewma', 'harEqual', 'trailing')
START, END, REFIT, LOOK = '2023-09-28', '2026-09-19', 28, 360
refits = []
d = np.datetime64(START)
while d <= np.datetime64(END): refits.append(str(d)); d += np.timedelta64(REFIT, 'D')

pre = {}
for key, rows in by.items():
    h = key[1]
    pre[key] = (np.array([r['date'] for r in rows]), np.array([r['targetDate'] for r in rows]),
                np.array([r['target'] is not None for r in rows]),
                np.array([mt.log_move(r) ** 2 if r['target'] is not None else np.nan for r in rows]),
                {s: np.array([mt.base_sigma(r, s, h) or np.nan for r in rows], dtype=float) for s in SOURCES})

def dl_tau2(y, v):
    w = 1 / v; mu = np.sum(w * y) / np.sum(w)
    q = np.sum(w * (y - mu) ** 2); c = np.sum(w) - np.sum(w ** 2) / np.sum(w)
    return max(0.0, (q - (len(y) - 1)) / c) if c > 0 else 0.0

def shrunk_k(keys, t0, src, h):
    est = {}
    for key in keys:
        dates, tdates, has, lm2, sig = pre[key]
        idx = np.nonzero(has & (tdates <= t0))[0][-mt.TRAIN_MAX:]
        s = sig[src][idx]; ok = np.isfinite(s) & (s > 0)
        rr = lm2[idx][ok] / s[ok] ** 2
        if len(rr) < 30: continue
        k = float(rr.mean()); se2 = float(rr.var(ddof=1) / max(len(rr) / h, 2)) / (k * k)
        est[key] = (math.log(k), se2)
    if len(est) < 3: return {}
    y = np.array([e[0] for e in est.values()]); v = np.array([e[1] for e in est.values()])
    tau2 = dl_tau2(y, v); w_all = 1 / (v + tau2); mu = float(np.sum(w_all * y) / np.sum(w_all))
    return {key: math.exp(mu + (tau2 / (tau2 + se2) if tau2 + se2 > 0 else 0) * (lk - mu)) for key, (lk, se2) in est.items()}

# history[key][src] = list of (date, loss) of shrunk-calibrated forecasts
history = collections.defaultdict(lambda: collections.defaultdict(list))
scores = collections.defaultdict(list)     # (cls, h, variant) -> [(date, sym, loss)]
picks = collections.Counter()
for i, t0 in enumerate(refits):
    t1 = refits[i + 1] if i + 1 < len(refits) else END
    for cls in ('crypto', 'stock'):
        for h in ((1, 7) if cls == 'crypto' else (1, 5)):
            keys = [k for k in by if k[1] == h and cls_of.get(k[0]) == cls]
            ks = {src: shrunk_k(keys, t0, src, h) for src in SOURCES}
            lo = str(np.datetime64(t0) - np.timedelta64(LOOK, 'D'))
            # the class's best source over the trailing window, pooled over assets
            cls_mean = {}
            for src in SOURCES:
                vals = [L for key in keys for (dd, L) in history[key][src] if lo < dd <= t0]
                if len(vals) > 1000: cls_mean[src] = float(np.mean(vals))
            cls_best = min(cls_mean, key=cls_mean.get) if cls_mean else None
            for key in keys:
                dates, tdates, has, lm2, sig = pre[key]
                # choose per asset from its own trailing scored forecasts
                trail = {src: [(dd, L) for (dd, L) in history[key][src] if lo < dd <= t0] for src in SOURCES}
                enough = {src: v for src, v in trail.items() if len(v) >= 180}
                own_best = min(enough, key=lambda s: np.mean([L for _, L in enough[s]])) if len(enough) == len(SOURCES) else None
                pick_shrunk = cls_best
                if own_best and cls_best and own_best != cls_best:
                    a = dict(enough[own_best]); b = dict(enough[cls_best])
                    diffs = np.array([a[x] - b[x] for x in a if x in b])
                    if h > 1: diffs = diffs[::h]
                    if len(diffs) > 20 and diffs.std(ddof=1) > 0 and diffs.mean() / (diffs.std(ddof=1) / math.sqrt(len(diffs))) <= -2:
                        pick_shrunk = own_best
                sel = np.nonzero((dates > t0) & (dates <= t1) & has)[0]
                if not len(sel): continue
                logv = {}
                for src in SOURCES:
                    k = ks[src].get(key)
                    s = sig[src][sel]
                    if k is None: continue
                    v = k * s ** 2
                    logv[src] = np.where(np.isfinite(v) & (v > 0), np.log(v), np.nan)
                    L = lm2[sel] / np.exp(logv[src]) + logv[src]
                    for dd, l in zip(dates[sel], L):
                        if np.isfinite(l): history[key][src].append((dd, float(l)))
                if len(logv) < len(SOURCES) or own_best is None or cls_best is None: continue
                variants = {
                    'fixed': logv['garchWeekday'],
                    'perAsset': logv[own_best],
                    'shrunkPick': logv[pick_shrunk],
                    'classBest': logv[cls_best],
                    'combo': np.mean(np.vstack([logv[s] for s in SOURCES]), axis=0),
                }
                picks[(cls, h, 'perAsset', own_best)] += 1
                picks[(cls, h, 'shrunkPick', pick_shrunk)] += 1
                ok = np.all(np.isfinite(np.vstack(list(variants.values()))), axis=0)
                for name, lv in variants.items():
                    L = lm2[sel][ok] / np.exp(lv[ok]) + lv[ok]
                    scores[(cls, h, name)].extend(zip(dates[sel][ok], [key[0]] * int(ok.sum()), L))

def vs(a, b, step):
    mb = {(dd, s): L for dd, s, L in b}; per = collections.defaultdict(list)
    for dd, s, L in a:
        if (dd, s) in mb: per[dd].append(L - mb[(dd, s)])
    ds = sorted(per)[::step]
    m = np.array([np.mean(per[x]) for x in ds])
    return float(m.mean()), float(m.mean() / (m.std(ddof=1) / math.sqrt(len(m)))), len(m)

out = {}
for cls in ('crypto', 'stock'):
    for h in ((1, 7) if cls == 'crypto' else (1, 5)):
        base = scores[(cls, h, 'fixed')]
        print(f'\n=== {cls} {h}d: QLIKE difference vs one fixed model (GARCH + weekday, shrunk calibration); negative = better ===')
        for name in ('perAsset', 'shrunkPick', 'classBest', 'combo'):
            m, t, n = vs(scores[(cls, h, name)], base, h)
            out[f'{cls}|{h}|{name}'] = {'diff': m, 't': t, 'dates': n}
            print(f'  {name:11s} {m:+.4f}  t {t:+.1f}  ({n} dates)')
        top = collections.Counter({k[3]: v for k, v in picks.items() if k[:3] == (cls, h, 'perAsset')}).most_common(3)
        print('  per-asset picks:', top)
json.dump(out, open(f'{SP}/vol_selection.json', 'w'), indent=1)
