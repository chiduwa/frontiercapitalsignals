"""Prints cadence_class.py's and cadence_resid.py's results: every class-wide
test, first and second period, against the shared-sign null, flagging what
holds in both (|z| >= 2, same sign), plus each class index's own tests.

usage: CAD_DATA=/data/cad python class_summary.py"""
import json, os
import numpy as np

CAD = os.environ.get('CAD_DATA', '.')


def both(a, b):
    return a['z'] is not None and b['z'] is not None and abs(a['z']) >= 2 and abs(b['z']) >= 2 and (a['z'] > 0) == (b['z'] > 0)


def show(title, tests, unit=1e4, width=22):
    print(f'\n== {title} ==')
    zs = []
    for t, (a, b) in tests.items():
        zs += [a['z'], b['z']]
        u = 1 if t.endswith(('_cv', '_alt')) else unit
        flag = '  <-- both periods' if both(a, b) else ''
        print(f"  {t:{width}s} {a['real'] * u:+9.2f} vs {a['sur'] * u:+9.2f} (z {a['z']:+5.1f})   {b['real'] * u:+9.2f} vs {b['sur'] * u:+9.2f} (z {b['z']:+5.1f}){flag}")
    zs = np.array([z for z in zs if z is not None])
    print(f'  {len(zs)} z-scores: |z| > 2 in {np.mean(np.abs(zs) > 2) * 100:.1f}% (chance: 4.6%)')


C = json.load(open(os.path.join(CAD, 'class_results.json')))
for key, r in C.items():
    show(f'{key}: class average, {r["assets"]} assets (bps; cv and alt as numbers)', r['tests'])
    show(f'{key}: pumps and breakdowns pooled (%)', r['episodes'], unit=100)
    ix = {t: (v['disc'], v['val']) for t, v in r['index']['tests'].items() if 'disc' in v and 'val' in v}
    ix = {t: ({'real': a['real'], 'sur': a['mu'], 'z': a['z']}, {'real': b['real'], 'sur': b['mu'], 'z': b['z']}) for t, (a, b) in ix.items()
          if a['z'] is not None and b['z'] is not None and a['real'] is not None and b['real'] is not None}
    show(f'{key}: the equal-weight index itself', ix, width=24)
    if 'index_episodes' in r:
        show(f'{key}: the index\'s own pumps and breakdowns (%)', r['index_episodes'], unit=100)
p = os.path.join(CAD, 'resid_results.json')
if os.path.exists(p):
    for key, tests in json.load(open(p)).items():
        show(f'{key}: moves relative to the rest of the class', tests)
