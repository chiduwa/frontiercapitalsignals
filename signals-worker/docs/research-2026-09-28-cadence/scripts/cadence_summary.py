"""Reads cadence_study.py's results and answers, per test:
  1. is there more signal than noise at all? (share of |z| > 2 and > 3 in the
     first period, against the 4.6% and 0.27% that pure chance gives)
  2. which asset-tests survive a false-discovery correction (Benjamini-Hochberg,
     q = 0.05, across every test on every asset) in the first period AND repeat
     in the second (same sign, one-sided p < 0.05)?
  3. naive pooling: Stouffer's z over a class's assets. This OVERSTATES class
     patterns many times over, because assets in a class move together and
     their z-scores are not independent. Kept to show the trap; the class-wide
     answer is cadence_class.py's shared-sign test (class_summary.py).
  4. for anything that holds: how big is it next to trading costs?

usage: CAD_DATA=/data/cad python cadence_summary.py   -> prints, and writes cadence_summary.json"""
import json, math, os, collections
import numpy as np

CAD = os.environ.get('CAD_DATA', '.')
COST = {'crypto': 0.0020, 'stock': 0.0005, 'market': 0.0005}   # round trip, log-return units
PRIMARY = lambda k: not k.startswith('serial_rho_')            # rho and pnl are the same question; pnl is the tradable one


def norm_p(z):
    return math.erfc(abs(z) / math.sqrt(2))


def family(key):
    if key.startswith('serial_'): return 'serial'
    if key.startswith('cycle_'): return 'cycle'
    if key.startswith('swing'): return 'swing_' + key.split('_', 1)[1]
    return key


rows = []
for res in ('hourly', 'daily'):
    path = os.path.join(CAD, f'cadence_{res}.jsonl')
    if not os.path.exists(path): continue
    for line in open(path):
        a = json.loads(line)
        for key, t in a['tests'].items():
            d, v = t.get('disc'), t.get('val')
            rows.append(dict(res=res, sym=a['symbol'], cls=a['cls'], key=key,
                             zd=d['z'] if d else None, zv=v['z'] if v else None,
                             eff_d=(d['real'] - d['mu']) if d and d['real'] is not None and d['mu'] is not None else None,
                             eff_v=(v['real'] - v['mu']) if v and v['real'] is not None and v['mu'] is not None else None,
                             info=a['info']))
print(f'{len(rows)} asset-tests from {len({(r["res"], r["sym"]) for r in rows})} asset series')

out = {'calibration': {}, 'survivors': [], 'class': [], 'cycles': {}, 'swings': {}}

# 1. is there more signal than noise?
print('\n1. first-period z-scores against chance (4.6% beyond 2, 0.27% beyond 3)')
by = collections.defaultdict(list)
for r in rows:
    if r['zd'] is not None and r['key'] != 'cycle_carry':
        by[(r['res'], family(r['key']))].append(r['zd'])
for (res, fam), zs in sorted(by.items()):
    zs = np.array(zs)
    out['calibration'][f'{res}|{fam}'] = dict(n=len(zs), gt2=float(np.mean(np.abs(zs) > 2)), gt3=float(np.mean(np.abs(zs) > 3)), mean=float(zs.mean()))
    print(f'  {res:6s} {fam:18s} n {len(zs):5d}  |z|>2 {np.mean(np.abs(zs) > 2) * 100:5.1f}%  |z|>3 {np.mean(np.abs(zs) > 3) * 100:5.2f}%  mean z {zs.mean():+.2f}')

# 2. per asset-test: BH on the first period, then repeat in the second
prim = [r for r in rows if PRIMARY(r['key']) and r['zd'] is not None and r['key'] != 'cycle_carry']
ps = np.array([norm_p(r['zd']) for r in prim])
order = np.argsort(ps); m = len(ps)
thresh = 0.05 * np.arange(1, m + 1) / m
passed = np.zeros(m, bool)
below = np.nonzero(ps[order] <= thresh)[0]
if len(below): passed[order[:below.max() + 1]] = True
surv = [r for r, ok in zip(prim, passed) if ok]
rep = [r for r in surv if r['zv'] is not None and np.sign(r['zv']) == np.sign(r['zd']) and abs(r['zv']) >= 1.645]
print(f'\n2. {m} primary tests; {len(surv)} pass BH in the first period; {len(rep)} repeat in the second '
      f'(chance alone would repeat about {len(surv) * 0.05:.0f})')
for r in sorted(rep, key=lambda r: -abs(r['zd'])):
    cost = COST.get(r['cls'], 0.002)
    tradable = r['key'].startswith(('serial_pnl', 'swing')) and r['key'].split('_')[-1] in ('mom', 'age', 'pullback') or r['key'].startswith('serial_pnl')
    out['survivors'].append(dict(res=r['res'], sym=r['sym'], cls=r['cls'], key=r['key'], zd=r['zd'], zv=r['zv'],
                                 eff_d=r['eff_d'], eff_v=r['eff_v'], cost=cost if tradable else None))
    print(f"  {r['res']:6s} {r['sym']:8s} {r['cls']:6s} {r['key']:24s} z {r['zd']:+6.2f} / {r['zv']:+6.2f}   effect "
          f"{(r['eff_d'] or 0) * 1e4:+8.1f} / {(r['eff_v'] or 0) * 1e4:+8.1f} bps" + (f"   cost {cost * 1e4:.0f} bps" if tradable else ''))

# 3. class-wide patterns
print('\n3. NAIVE pooling (Stouffer Z, assumes assets move independently; they do not, so this overstates):')
print('   the valid class-wide test is class_summary.py')
grp = collections.defaultdict(lambda: ([], [], [], []))
for r in rows:
    if r['zd'] is None or r['zv'] is None or r['key'] == 'cycle_carry': continue
    g = grp[(r['res'], r['cls'], r['key'])]
    g[0].append(r['zd']); g[1].append(r['zv']); g[2].append(r['eff_d'] or 0); g[3].append(r['eff_v'] or 0)
for (res, cls, key), (zd, zv, ed, ev) in sorted(grp.items()):
    if len(zd) < 5: continue
    Zd, Zv = np.sum(zd) / math.sqrt(len(zd)), np.sum(zv) / math.sqrt(len(zv))
    rec = dict(res=res, cls=cls, key=key, n=len(zd), Zd=float(Zd), Zv=float(Zv), eff_d=float(np.mean(ed)), eff_v=float(np.mean(ev)),
               share_same_sign=float(np.mean(np.sign(zd) == np.sign(Zd))))
    out['class'].append(rec)
    if abs(Zd) >= 3 and abs(Zv) >= 3 and np.sign(Zd) == np.sign(Zv):
        print(f'  {res:6s} {cls:6s} {key:24s} n {len(zd):3d}  Z {Zd:+6.1f} / {Zv:+6.1f}   mean effect {np.mean(ed) * 1e4:+8.2f} / {np.mean(ev) * 1e4:+8.2f} bps'
              f'   {np.mean(np.sign(zd) == np.sign(Zd)) * 100:.0f}% of assets agree')

# cycles: does the dominant period repeat?
print('\n4. dominant cycles: same period (within 10%) in both halves, against chance')
for res in ('hourly', 'daily'):
    cyc = [(r['sym'], r['info']['cycle_period'], r['zv']) for r in rows if r['res'] == res and r['key'] == 'cycle_carry']
    same = [c for c in cyc if c[1][0] and c[1][1] and abs(c[1][0] - c[1][1]) / c[1][0] < 0.1]
    carry = np.array([c[2] for c in cyc if c[2] is not None])
    out['cycles'][res] = dict(n=len(cyc), same_period=len(same), carry_gt2=int(np.sum(carry > 2)), examples=same[:10])
    print(f'  {res}: {len(same)} of {len(cyc)} series have the same dominant period in both halves; '
          f'{int(np.sum(carry > 2))} keep the first half\'s cycle at z > 2 (chance: ~{len(cyc) * 0.023:.0f})')

# swings: typical lengths, for the record
print('\n5. typical swing lengths (median bars per leg, first / second period), a few assets')
for res, scales in (('hourly', (0.5, 1.0, 2.0)), ('daily', (1.0, 2.0, 4.0))):
    seen = {}
    for r in rows:
        if r['res'] == res and r['key'] == f'swing{scales[1]}_cv' and r['sym'] not in seen:
            seen[r['sym']] = {k: r['info'].get(f'swing{k}', {}).get('median_leg_bars') for k in scales}
    out['swings'][res] = seen
    for s in list(seen)[:6]:
        print(f'  {res:6s} {s:8s} ' + '  '.join(f'{k}sd: {seen[s][k]}' for k in scales))

json.dump(out, open(os.path.join(CAD, 'cadence_summary.json'), 'w'), indent=1, default=float)
