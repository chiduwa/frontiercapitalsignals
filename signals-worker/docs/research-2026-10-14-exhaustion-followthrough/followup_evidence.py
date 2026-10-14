"""Evidence for the +1h follow-up push (live-scan.mjs): state of the first hour after a
pushed exhaustion alert, and what followed from the price at that hour's close.

State, exactly as production computes it from the bars it already has:
  vol1 = quote volume of the hour after the alert / the alert's 48h median hourly volume
  held = that hour's close >= the alert hour's close
  hotHeld = vol1 >= 20 and held; hotFaded = vol1 >= 20, not held; cooled = vol1 < 20
Outcomes from the +1h close: highest high within 24h (median, p90, share reaching +8.7%,
the distance a 10x short is liquidated at in the owner's fills), median return at 3 days,
share below the +1h price at 3 days. All PUSHED alerts (repeats included, as production
pushes them), both periods. Output: followup_evidence.json + .txt
"""
import json, os
import numpy as np, pandas as pd
from common import load, RAW
from paths import grid, G0, H

D = load(with_perp=False)
X = D[(D.k == 1) & D.period.isin(['disc', 'val'])].copy()
u = pd.Series(np.nan, index=X.index)
for sym, g in X.groupby('symbol'):
    G = grid(pd.read_parquet(os.path.join(RAW, f'spot1h/{sym}.parquet')))
    c, hi = G['close'], G['high']
    for i, r in zip(g.index, g.itertuples()):
        b = int((r.ts.value // 10**6 - G0) // H) + 1
        seg = hi[b + 1:b + 25]
        if len(seg) == 24 and np.isnan(seg).mean() < .2 and c[b] > 0:
            u[i] = np.nanmax(seg) / c[b] - 1
X['u24'] = u


def state(r):
    if not (r.v_last_k == r.v_last_k):
        return None
    if r.v_last_k >= 20:
        return 'hotHeld' if r.p_k >= 0 else 'hotFaded'
    return 'cooled'          # under 20x: 5-20x held/faded and <5x behaved alike (2026-10-14 first pass)


X['state'] = X.apply(state, axis=1)
ev, lines = {}, []
for per in ('disc', 'val'):
    Y0 = X[X.period == per]
    for st, Y in Y0.groupby('state'):
        u24 = Y.u24.dropna(); f72 = Y.f72.dropna()
        ev.setdefault(st, {})[per] = {
            'n': int(len(Y)), 'share': round(len(Y) / len(Y0), 3),
            'high24Median': round(float(u24.median()) * 100, 1), 'high24P90': round(float(u24.quantile(.9)) * 100, 1),
            'reach87': round(float(np.mean(u24 >= .087)), 3),
            'ret72Median': round(float(f72.median()) * 100, 1), 'below72': round(float(np.mean(f72 < 0)), 3)}
        e = ev[st][per]
        lines.append(f"{per} {st:9} n {e['n']:5} share {e['share']:.0%}  24h high median +{e['high24Median']}% p90 +{e['high24P90']}%  reach +8.7% {e['reach87']:.0%}  3d median {e['ret72Median']:+.1f}%  below at 3d {e['below72']:.0%}")
json.dump(ev, open('followup_evidence.json', 'w'), indent=1)
open('followup_evidence.txt', 'w').write('\n'.join(lines))
print('\n'.join(lines))
