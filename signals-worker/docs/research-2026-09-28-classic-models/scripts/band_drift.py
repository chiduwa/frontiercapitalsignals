"""The published band, rebuilt on every composite call the engine has made.

predictedRange draws a band of +-1 stdev of the asset's own past moves (the
'historical' basis) and shifts its centre toward the call by up to half a
stdev as the score rises (conviction = clamp((score - 50) / 50, 0, 1) x 0.5).
It is declared a 68% band. Using the engine's own composite calls (dir, score,
realized return; confluence-v9, replay and live), with each asset's stdev
learned only from its earlier outcomes (at least 20), this compares:

  centered        +-1 stdev, no shift
  drifted         the production band: +-1 stdev, shifted toward the call
  quantile        +-k stdev, k = the class's 68% quantile of |move / stdev|
                  from outcomes matured before the block (refitted every 28
                  days): the width that actually contains 68%, fat tails
                  and all (the Monte Carlo / empirical-quantile interval)
  quantileDrifted the same width, shifted as production shifts
Scored by coverage and the interval score (Gneiting & Raftery 2007).
"""
import glob, json, math, os, collections, importlib.util
import numpy as np

SW = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sp = importlib.util.spec_from_file_location('tr', os.path.join(SW, 'scripts', 'tracked-research.py'))
tr = importlib.util.module_from_spec(sp); sp.loader.exec_module(tr)
DATA = os.environ.get('OVF_DATA', '.')
ALPHA = 0.32


def iscore(lo, hi, y):
    return (hi - lo) + (2 / ALPHA) * np.maximum(lo - y, 0) + (2 / ALPHA) * np.maximum(y - hi, 0)


def main():
    rows = collections.defaultdict(list)   # (class, h) -> rows
    for path in sorted(glob.glob(os.path.join(DATA, 'comp_*_*.json'))):
        cls = os.path.basename(path).split('_')[1]
        for r in json.load(open(path)):
            if r['dir'] in (-1, 1) and r['r'] is not None and r['score'] is not None:
                rows[(cls, int(r['h']))].append(r)
    out = {}
    for (cls, h), rs in sorted(rows.items()):
        rs.sort(key=lambda r: (r['d'], r['s']))
        # walk-forward stdev per asset from strictly earlier outcomes
        # A call made at (target date - h) may only use outcomes that had
        # matured by then: target dates <= d - h.
        acc = collections.defaultdict(lambda: [0, 0.0, 0.0])
        past = collections.defaultdict(list)
        items = []
        by_date = collections.defaultdict(list)
        for r in rs: by_date[r['d']].append(r)
        ordered = sorted(by_date); ptr = 0
        for d in ordered:
            known_until = str(np.datetime64(d) - np.timedelta64(h // 24, 'D'))
            while ptr < len(ordered) and ordered[ptr] <= known_until:
                for r in by_date[ordered[ptr]]:
                    a = acc[r['s']]; a[0] += 1; a[1] += r['r']; a[2] += r['r'] ** 2
                    past[r['s']].append(r['r'])
                ptr += 1
            for r in by_date[d]:
                n, s1, s2 = acc[r['s']]
                if n >= 20:
                    mu = s1 / n; sd = math.sqrt(max(s2 / n - mu * mu, 0))
                    if sd > 0:
                        conv = min(max((r['score'] - 50) / 50, 0), 1) * 0.5
                        pm = np.asarray(past[r['s']])
                        med = float(np.median(pm)); mad = 1.4826 * float(np.median(np.abs(pm - med)))
                        q = (float(np.quantile(np.abs(pm), 0.68)), float(np.quantile(pm, 0.16)), float(np.quantile(pm, 0.84))) if n >= 60 else None
                        mabs = float(np.mean(np.abs(pm)))
                        items.append((d, r['s'], r['r'], sd, r['dir'] * conv * sd, r['score'], mad if mad > 0 else sd, q, mabs))
        if not items: continue
        dates = sorted({i[0] for i in items})
        # class-level 68% quantile of |z|, refitted every 28 days on matured outcomes
        z_hist = [(i[0], abs(i[2]) / i[3]) for i in items]
        zr_sorted = sorted((i[0], abs(i[2]) / i[6]) for i in items)
        zrd = np.array([x[0] for x in zr_sorted]); zrv = np.array([x[1] for x in zr_sorted])
        za_sorted = sorted((i[0], abs(i[2]) / i[8]) for i in items if i[8] > 0)
        zad = np.array([x[0] for x in za_sorted]); zav = np.array([x[1] for x in za_sorted])
        k_at = {}
        starts = dates[0]
        block_k = None; block_end = None
        zs_sorted = sorted(z_hist)
        zd = np.array([x[0] for x in zs_sorted]); zv = np.array([x[1] for x in zs_sorted])
        for d in dates:
            if block_end is None or d >= block_end:
                cutoff = str(np.datetime64(d) - np.timedelta64(h // 24, 'D'))
                lo = str(np.datetime64(d) - np.timedelta64(730, 'D'))
                sel = zv[(zd < cutoff) & (zd >= lo)]
                block_k = float(np.quantile(sel, 0.68)) if len(sel) >= 500 else None
                selr = zrv[(zrd < cutoff) & (zrd >= lo)]
                block_kr = float(np.quantile(selr, 0.68)) if len(selr) >= 500 else None
                sela = zav[(zad < cutoff) & (zad >= lo)]
                block_ka = float(np.quantile(sela, 0.68)) if len(sela) >= 500 else None
                block_end = str(np.datetime64(d) + np.timedelta64(28, 'D'))
            k_at[d] = (block_k, block_kr, block_ka)
        res = {}
        variants = {'centered': lambda y, sd, c, k: (-sd, sd), 'drifted': lambda y, sd, c, k: (c - sd, c + sd),
                    'quantile': lambda y, sd, c, k: (-k * sd, k * sd), 'quantileDrifted': lambda y, sd, c, k: (c - k * sd, c + k * sd)}
        scored = [i for i in items if k_at.get(i[0]) and all(k_at[i[0]])]
        y = np.array([i[2] for i in scored]); sd = np.array([i[3] for i in scored]); c = np.array([i[4] for i in scored])
        k = np.array([k_at[i[0]][0] for i in scored]); d_arr = [i[0] for i in scored]; score = np.array([i[5] for i in scored])
        kr = np.array([k_at[i[0]][1] for i in scored]); mad = np.array([i[6] for i in scored])
        has_q = np.array([i[7] is not None for i in scored])
        q68 = np.array([i[7][0] if i[7] else np.nan for i in scored])
        q16 = np.array([i[7][1] if i[7] else np.nan for i in scored]); q84 = np.array([i[7][2] if i[7] else np.nan for i in scored])
        ka = np.array([k_at[i[0]][2] for i in scored]); mabs = np.array([i[8] for i in scored])
        variants['robustQuantile'] = lambda y, sd, c, k: (-kr * mad, kr * mad)
        variants['meanAbsQuantile'] = lambda y, sd, c, k: (-ka * mabs, ka * mabs)
        variants['assetQuantile'] = lambda y, sd, c, k: (np.where(has_q, -q68, -k * sd), np.where(has_q, q68, k * sd))
        variants['assetQuantileAsym'] = lambda y, sd, c, k: (np.where(has_q, q16, -k * sd), np.where(has_q, q84, k * sd))
        loss = {}
        for name, f in variants.items():
            lo, hi = f(y, sd, c, k)
            loss[name] = iscore(lo, hi, y)
            res[name] = {'coverage': float(np.mean((y >= lo) & (y <= hi))), 'meanWidth': float(np.mean(hi - lo)),
                         'medianWidth': float(np.median(hi - lo)), 'intervalScore': float(np.mean(loss[name])),
                         'medianIntervalScore': float(np.median(loss[name]))}
            # the same, on assets whose stdev is within 3x the class median (no glitch-inflated histories)
            sane = sd <= 3 * np.median(sd)
            res[name]['sane'] = {'share': float(np.mean(sane)), 'coverage': float(np.mean(((y >= lo) & (y <= hi))[sane])),
                                 'meanWidth': float(np.mean((hi - lo)[sane])), 'intervalScore': float(np.mean(loss[name][sane]))}
        def vs(a, b):
            per = collections.defaultdict(list)
            for dd, x in zip(d_arr, loss[a] - loss[b]): per[dd].append(x)
            return tr.block_interval(np.array([np.mean(per[dd]) for dd in sorted(per)]), 7 if h == 24 else 2)
        res['driftedVsCentered'] = vs('centered', 'drifted')       # positive = the shift helps
        res['quantileVsCentered'] = vs('centered', 'quantile')     # positive = quantile width helps
        res['quantileDriftedVsDrifted'] = vs('drifted', 'quantileDrifted')
        res['kMeanAbs68'] = {'median': float(np.median(ka)), 'min': float(np.min(ka)), 'max': float(np.max(ka)),
                             'last': float(ka[np.argmax(np.array(d_arr))])}
        for name in ('robustQuantile', 'assetQuantile', 'assetQuantileAsym', 'meanAbsQuantile'):
            res[f'{name}VsQuantile'] = vs('quantile', name)
        res['k68'] = {'median': float(np.median(k)), 'min': float(np.min(k)), 'max': float(np.max(k))}
        res['n'] = len(scored); res['first'] = min(d_arr); res['last'] = max(d_arr)
        # the shift by conviction: does it help where conviction is high?
        hi_conv = score >= 75
        if hi_conv.sum() >= 200:
            res['highConvictionShare'] = float(np.mean(hi_conv))
            res['driftHelpsAtScore75Plus'] = float(np.mean(loss['centered'][hi_conv] - loss['drifted'][hi_conv]))
            res['hitRateAtScore75Plus'] = float(np.mean(np.sign(y[hi_conv]) == np.sign(c[hi_conv])))
        out[f'{cls}|{h}h'] = res
        print(f"\n== {cls} {h}h: {res['n']} calls, {res['first']} to {res['last']}; class k68 median {res['k68']['median']:.3f}")
        for name in variants:
            v = res[name]; sv = v['sane']
            print(f"  {name:17s} coverage {v['coverage'] * 100:5.1f}%  width mean {v['meanWidth']:6.2f}% median {v['medianWidth']:5.2f}%  "
                  f"IS {v['intervalScore']:7.3f} | clean assets ({sv['share'] * 100:.0f}%): coverage {sv['coverage'] * 100:5.1f}% width {sv['meanWidth']:5.2f}% IS {sv['intervalScore']:6.3f}")
        print(f"  class multiplier on the mean |move| for 68%: median {res['kMeanAbs68']['median']:.3f} (range {res['kMeanAbs68']['min']:.3f} to {res['kMeanAbs68']['max']:.3f}; latest {res['kMeanAbs68']['last']:.3f})")
        for key in ('driftedVsCentered', 'quantileVsCentered', 'quantileDriftedVsDrifted', 'robustQuantileVsQuantile',
                    'assetQuantileVsQuantile', 'assetQuantileAsymVsQuantile', 'meanAbsQuantileVsQuantile'):
            b = res[key]; print(f"  {key:25s} {b['mean']:+.4f} (95% {b['low']:+.4f} to {b['high']:+.4f})")
        if 'driftHelpsAtScore75Plus' in res:
            print(f"  score >= 75 ({res['highConvictionShare'] * 100:.0f}% of calls): the shift changes the interval score by "
                  f"{res['driftHelpsAtScore75Plus']:+.4f}; direction right {res['hitRateAtScore75Plus'] * 100:.1f}%")
    json.dump(out, open(os.path.join(DATA, 'band_drift.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
