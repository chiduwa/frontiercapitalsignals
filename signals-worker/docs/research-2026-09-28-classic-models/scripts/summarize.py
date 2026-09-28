"""Summaries of classic-models-research.py reports for docs/CLASSIC_MODELS.md.

python summarize.py <assets report.json> [<report.json with global and intervals>]
Writes summary.json next to the first report."""
import json, math, sys, collections
from pathlib import Path
import numpy as np

A = json.loads(Path(sys.argv[1]).read_text())
B = json.loads(Path(sys.argv[2]).read_text()) if len(sys.argv) > 2 else A
MARKET = ('MKT_CRYPTO', 'MKT_STOCK', 'SPY')
DIRECTION = ['logistic', 'naiveBayes', 'naiveBayesCompact', 'stump', 'baggedStumps', 'adaBoostStumps', 'gradientBoostedStumps',
             'randomForest', 'randomForestBalanced', 'logisticBalanced', 'holtPrice', 'holtWintersPrice']
SIZE = ['ses', 'holt', 'holtWintersAdd', 'holtWintersMul', 'holtWintersTriple', 'autoEts', 'garchEtsCombo']
out = {'familySize': A.get('familySize'), 'direction': {}, 'size': {}, 'market': {}, 'autoEtsPicks': {}}
holm = {(t['cell'], t['model'], t['question']): t for t in A.get('tests', [])}
med = lambda xs: float(np.median(xs)) if len(xs) else None


def group(sym):
    if sym in MARKET: return 'market'
    return 'stock' if sym in A['assets'] and ('5' in A['assets'][sym]) else 'crypto'


cells = collections.defaultdict(list)
for sym, hs in A['assets'].items():
    for h, r in hs.items():
        if r.get('observations'): cells[(group(sym), h)].append((sym, r))

print(f"family size (tests corrected together): {A.get('familySize')}")
for key in sorted(cells):
    g, h = key
    if g == 'market': continue
    rs = cells[key]
    print(f'\n=== {g} {h}: {len(rs)} assets ===')
    print('direction (Brier vs own base rate)   better  median diff(e-3)  Holm/BH passes  AUC   balAcc  MCC    cal.slope  logloss diff(e-3)')
    for m in DIRECTION:
        d = [r['direction'][m] for _, r in rs if m in r['direction']]
        if not d: continue
        better = sum(x['brierImprovement']['mean'] > 0 for x in d)
        passes = [(s, holm.get((f'{s}|{h}', m, 'direction'), {})) for s, _ in rs]
        hp = sum(1 for _, t in passes if t.get('holmP', 1) < 0.05 and t.get('mean', 0) > 0)
        bp = sum(1 for _, t in passes if t.get('bhQ', 1) < 0.05 and t.get('mean', 0) > 0)
        row = {'cells': len(d), 'better': better, 'medianBrierDiff': med([x['brierImprovement']['mean'] for x in d]),
               'holm': hp, 'bh': bp, 'auc': med([x['auc'] for x in d if x['auc'] is not None]),
               'balancedAccuracy': med([x['balancedAccuracy'] for x in d]), 'mcc': med([x['mcc'] for x in d]),
               'calibrationSlope': med([x['calibrationSlope'] for x in d if x['calibrationSlope'] is not None]),
               'logLossDiff': med([x['logLossImprovement']['mean'] for x in d])}
        out['direction'][f'{g}|{h}|{m}'] = row
        print(f"  {m:22s} {better:3d}/{len(d):3d}   {row['medianBrierDiff'] * 1e3:+8.2f}        {hp:2d} / {bp:2d}       {row['auc']:.3f} {row['balancedAccuracy']:.3f}  {row['mcc']:+.3f}  {row['calibrationSlope']:+6.2f}    {row['logLossDiff'] * 1e3:+8.2f}")
    print('size vs GARCH + weekday             MAE better  median MAE diff  QLIKE better  median QLIKE diff  Holm/BH (MAE)  Holm/BH (QLIKE)')
    for m in SIZE:
        d = [(s, r['magnitude'][m]) for s, r in rs if m in r['magnitude'] and 'vsGarchWeekday' in r['magnitude'][m]]
        if not d: continue
        mb = sum(x['vsGarchWeekday']['mean'] > 0 for _, x in d)
        qb = sum(x.get('qlikeVsGarchWeekday', {}).get('mean', -1) > 0 for _, x in d)
        def passes(q):
            hp = sum(1 for s, _ in d if holm.get((f'{s}|{h}', m, q), {}).get('holmP', 1) < 0.05 and holm.get((f'{s}|{h}', m, q), {}).get('mean', 0) > 0)
            bp = sum(1 for s, _ in d if holm.get((f'{s}|{h}', m, q), {}).get('bhQ', 1) < 0.05 and holm.get((f'{s}|{h}', m, q), {}).get('mean', 0) > 0)
            return hp, bp
        row = {'cells': len(d), 'maeBetter': mb, 'medianMaeDiff': med([x['vsGarchWeekday']['mean'] for _, x in d]),
               'qlikeBetter': qb, 'medianQlikeDiff': med([x['qlikeVsGarchWeekday']['mean'] for _, x in d if 'qlikeVsGarchWeekday' in x]),
               'maePasses': passes('sizeMaeVsGarch'), 'qlikePasses': passes('sizeQlikeVsGarch')}
        out['size'][f'{g}|{h}|{m}'] = row
        print(f"  {m:18s}              {mb:3d}/{len(d):3d}    {row['medianMaeDiff']:+.4f}          {qb:3d}/{len(d):3d}      {row['medianQlikeDiff']:+.4f}          {row['maePasses']}          {row['qlikePasses']}")
    sr = [r['signed'] for _, r in rs]
    for m in ('holtPrice', 'holtWintersPrice'):
        v = [x[m]['oosR2'] for x in sr if m in x and x[m]['oosR2'] is not None]
        out['size'][f'{g}|{h}|signedR2|{m}'] = {'positive': sum(x > 0 for x in v), 'cells': len(v), 'median': med(v)}
        print(f'  signed R2 {m}: positive in {sum(x > 0 for x in v)}/{len(v)}, median {med(v):+.4f}')

picks = collections.Counter()
for k, st in A.get('stats', {}).items():
    for f, n in (st.get('autoEtsPick') or {}).items(): picks[f] += n
out['autoEtsPicks'] = dict(picks)
print('\nautomated ETS picked (fold count):', dict(picks))

print('\n=== the market as a whole: equal-weight indexes and SPY ===')
for sym in MARKET:
    for h, r in (A['assets'].get(sym) or {}).items():
        if not r.get('observations'): continue
        # Holm and BH live on the run's test list, not on the per-asset scores.
        with_holm = lambda b, m, q: {**b, 'holmP': holm.get((f'{sym}|{h}', m, q), {}).get('holmP'), 'bhQ': holm.get((f'{sym}|{h}', m, q), {}).get('bhQ')}
        best_d = sorted(((m, with_holm(r['direction'][m]['brierImprovement'], m, 'direction')) for m in DIRECTION if m in r['direction']),
                        key=lambda x: -x[1]['mean'])[:3]
        best_s = sorted(((m, with_holm(r['magnitude'][m]['qlikeVsGarchWeekday'], m, 'sizeQlikeVsGarch')) for m in SIZE
                         if m in r['magnitude'] and 'qlikeVsGarchWeekday' in r['magnitude'][m]), key=lambda x: -x[1]['mean'])[:3]
        out['market'][f'{sym}|{h}'] = {'n': r['observations'], 'bestDirection': [(m, b['mean'], b['p'], b.get('holmP')) for m, b in best_d],
                                       'bestSize': [(m, b['mean'], b['p'], b.get('holmP')) for m, b in best_s]}
        fmt = lambda x: 'n/a' if x is None else f'{x:.2f}'
        print(f"{sym} {h}: n {r['observations']}; best direction " + ', '.join(f"{m} {b['mean'] * 1e3:+.2f}e-3 (p {b['p']:.3f}, Holm {fmt(b['holmP'])})" for m, b in best_d))
        print(f"   best size vs GARCH (QLIKE) " + ', '.join(f"{m} {b['mean']:+.4f} (p {b['p']:.3f}, Holm {fmt(b['holmP'])})" for m, b in best_s))

if B.get('global'):
    out['global'] = {}
    print('\n=== one model for the whole class (global) ===')
    for key, g in sorted(B['global'].items()):
        if not g.get('observations'): continue
        print(f"{key}: {g['observations']} outcomes, {g['assets']} assets, up rate {g['upRate']:.3f}")
        for m, v in g['models'].items():
            if m in ('baseRate',): continue
            a, c = v['vsOwnBaseRate'], v['vsClassBaseRate']
            out['global'][f'{key}|{m}'] = {'vsOwn': a, 'vsClass': c, 'auc': v['auc'], 'calibrationSlope': v['calibrationSlope']}
            print(f"  {m:22s} vs own base rate {a['mean'] * 1e3:+.2f}e-3 (p {a['p']:.3f})  vs class base rate {c['mean'] * 1e3:+.2f}e-3 (p {c['p']:.3f})  AUC {v['auc']:.3f}  cal.slope {v['calibrationSlope'] if v['calibrationSlope'] is None else round(v['calibrationSlope'], 2)}")

if B.get('intervals'):
    out['intervals'] = B['intervals']
    print('\n=== prediction intervals ===')
    for key, iv in sorted(B['intervals'].items()):
        print(f"{key}: {iv['testRows']} test rows")
        for lv in (68, 95):
            for src in ('garch', 'vol90', 'ewma'):
                for mth in ('gaussRaw', 'gaussVarAsset', 'gaussVarClass', 'quantAsset', 'quantClass', 'monteCarlo'):
                    e = iv['byMethod'].get(f'{src}|{mth}|{lv}')
                    if not e: continue
                    vs = e.get('vsWorkerBand')
                    print(f"  {lv}% {src:5s} {mth:13s} coverage {e['coverage'] * 100:5.1f}%  width {e['width']:6.2f}  IS {e['intervalScore']:7.3f}"
                          + (f"  vs worker band {vs['mean']:+.4f} (p {vs['p']:.3f})" if vs else '  (worker band)'))
Path(sys.argv[1]).with_name('summary.json').write_text(json.dumps(out, indent=1, default=float))
