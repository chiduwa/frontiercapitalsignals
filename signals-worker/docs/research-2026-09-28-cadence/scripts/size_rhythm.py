"""The rhythm that is real: how big moves are, by hour of day (UTC) and on
weekends, for the 38 largest coins, and how stable that profile is between
the two periods; plus the typical swing length at each size from
cadence_study.py's zigzag.

usage: CAD_DATA=/data/cad python size_rhythm.py   -> prints, writes CAD_DATA/size_rhythm.json"""
import collections, json, os
import numpy as np

CAD = os.environ.get('CAD_DATA', '.')
z = np.load(os.path.join(CAD, 'hourly.npz'))
C, syms, t0 = z['close'], z['syms'], int(z['t0'])
H = 3600000
t = t0 + H * np.arange(C.shape[1], dtype=np.int64)
hod = ((t // H) % 24)[1:]; dow = (((t // (24 * H)) + 3) % 7)[1:]
per = (t >= int(np.datetime64('2025-09-01T00:00', 'ms').astype(np.int64))).astype(int)[1:]
R = np.diff(np.log(C), axis=1)
out = {}; corr = []; peak = []; ratio = []; wk = []
for i, s in enumerate(syms):
    r = R[i]; ok = np.isfinite(r)
    prof = []
    for q in (0, 1):
        m = np.array([np.nanmean(np.abs(r[(hod == h) & (per == q) & ok])) for h in range(24)])
        prof.append(m / m.mean())
    both = (prof[0] + prof[1]) / 2
    corr.append(np.corrcoef(prof[0], prof[1])[0, 1]); peak.append(int(np.argmax(both))); ratio.append(both.max() / both.min())
    we = np.nanmean(np.abs(r[(dow >= 5) & ok])) / np.nanmean(np.abs(r[(dow < 5) & ok])); wk.append(we)
    out[str(s)] = dict(hour_profile=[round(float(x), 2) for x in both], busiest_hour_utc=int(np.argmax(both)), quietest_hour_utc=int(np.argmin(both)),
                       busiest_vs_quietest=round(float(both.max() / both.min()), 2), weekend_vs_weekday=round(float(we), 2),
                       profile_corr_between_periods=round(float(corr[-1]), 2))
avg = np.mean([out[s]['hour_profile'] for s in out], axis=0)
print('move size by UTC hour, average of the 38 coins (1.00 = a typical hour):')
print('  ' + '  '.join(f'{h:02d}:{v:.2f}' for h, v in enumerate(avg)))
print(f'profile agreement between periods: median corr {np.median(corr):.2f} (lowest {np.min(corr):.2f})')
print('busiest hour (UTC), coins:', collections.Counter(peak).most_common(4), f'| busiest/quietest median {np.median(ratio):.2f}')
print(f'weekend moves vs weekday: median {np.median(wk):.2f} (range {np.min(wk):.2f} to {np.max(wk):.2f})')
res = {'coins': out, 'average_hour_profile': [round(float(x), 3) for x in avg]}
for res_kind, keys in (('hourly', ('swing0.5', 'swing1.0', 'swing2.0')), ('daily', ('swing1.0', 'swing2.0', 'swing4.0'))):
    path = os.path.join(CAD, f'cadence_{res_kind}.jsonl')
    if not os.path.exists(path): continue
    rows = [json.loads(l) for l in open(path)]
    for cls in sorted({a['cls'] for a in rows}):
        med = {k: [x for a in rows if a['cls'] == cls for x in a['info'][k]['median_leg_bars'] if x] for k in keys}
        unit = 'h' if res_kind == 'hourly' else 'd'
        print(f'{res_kind} {cls}: median swing length ' + ', '.join(f'{k[5:]} sd {np.median(v):.0f}{unit} (middle half {np.percentile(v, 25):.0f}-{np.percentile(v, 75):.0f})' for k, v in med.items()))
        res[f'swing_length|{res_kind}|{cls}'] = {k: float(np.median(v)) for k, v in med.items()}
json.dump(res, open(os.path.join(CAD, 'size_rhythm.json'), 'w'), indent=1)
