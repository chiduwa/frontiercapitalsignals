"""What the spot bot actually pays at each 4-hour firing, not how often a slot
is the day's cheapest. For every coin-day of the last 360 days with all six
opens: each open's distance from the day's average open (basis points), and
how often each slot was the day's cheapest and its dearest. Under a driftless
walk the ends are both more often cheapest AND more often dearest (arcsine
law), and every slot costs the same on average."""
import json, math, os, importlib.util
import numpy as np
SW = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sp = importlib.util.spec_from_file_location('tr', os.path.join(SW, 'scripts', 'tracked-research.py'))
tr = importlib.util.module_from_spec(sp); sp.loader.exec_module(tr)
DATA = os.environ.get('OVF_DATA', '.')
kl = json.load(open(os.path.join(DATA, 'klines.json')))['klines']
dev_by_day = {}; cheapest = np.zeros(6); dearest = np.zeros(6); n = 0
for sym, rows in kl.items():
    by = {}
    for t, o in rows:
        ts = np.datetime64(int(t), 'ms'); d = str(ts.astype('datetime64[D]'))
        slot = int((ts - ts.astype('datetime64[D]').astype('datetime64[ms]')) / np.timedelta64(4, 'h'))
        if o > 0: by.setdefault(d, {})[slot] = math.log(o)
    days = sorted(d for d, s in by.items() if len(s) == 6)[-360:]
    for d in days:
        v = np.array([by[d][k] for k in range(6)])
        dev_by_day.setdefault(d, []).append((v - v.mean()) * 1e4)
        cheapest[int(np.argmin(v))] += 1; dearest[int(np.argmax(v))] += 1; n += 1
res = {'coinDays': n, 'cheapestShare': (cheapest / n).tolist(), 'dearestShare': (dearest / n).tolist(), 'slots': {}}
dates = sorted(dev_by_day)
print(f'{n} coin-days, last 360 days per coin')
print('slot (UTC)   cheapest   dearest   mean distance from the day average (bp), 95% interval')
for k in range(6):
    per_day = np.array([np.mean([x[k] for x in dev_by_day[d]]) for d in dates])
    b = tr.block_interval(per_day, 7)
    res['slots'][f'{4 * k:02d}:00'] = {'meanBp': b['mean'], 'low': b['low'], 'high': b['high']}
    print(f'{4 * k:02d}:00      {cheapest[k] / n * 100:5.1f}%     {dearest[k] / n * 100:5.1f}%     {b["mean"]:+6.1f}  ({b["low"]:+.1f} to {b["high"]:+.1f})')
json.dump(res, open(os.path.join(DATA, 'timing_price.json'), 'w'), indent=1)
