"""F. How far above the alert close does the squeeze reach? Quantiles of the highest high
within 24h and 72h after the alert close (the adverse move for a short entered at the close),
split by what is known when shorting. Episode-first alerts, both periods side by side.
"""
import numpy as np, pandas as pd
from common import load

D = load()
D = D[D['first'] & D.period.isin(['disc', 'val'])]
A = D[D.k == 0].set_index(['symbol', 'ts'])
for k in (1, 24, 72):
    A[f'hi{k}'] = D[D.k == k].set_index(['symbol', 'ts']).hi_k
A['v1'] = D[D.k == 1].set_index(['symbol', 'ts']).v_last_k
A = A.reset_index()
GROUPS = {
    'all': lambda X: pd.Series('all', index=X.index),
    'alert bar size': lambda X: pd.cut(X.barPct, [0, 7, 14, 1e9], labels=['+5-7%', '+7-14%', '>=+14%']),
    'accounts long at alert': lambda X: pd.cut(X.long_pct0, [0, .5, .65, 1], labels=['<50% (shorts majority)', '50-65%', '>65%']),
    'market 24h before': lambda X: pd.cut(X.mkt_pre24, [-9, -0.01, 0.01, 9], labels=['falling', 'flat', 'rising']),
    'volume in hour 1 after (x baseline)': lambda X: pd.cut(X.v1, [0, 5, 20, 1e9], labels=['<5x', '5-20x', '>=20x']),
    'size tier': lambda X: X.tier,
}
out = []
for name, f in GROUPS.items():
    out.append(f'\n-- {name}')
    for per in ('disc', 'val'):
        X = A[A.period == per]
        g = f(X)
        for lab, Y in X.groupby(g, observed=True):
            if len(Y) < 40:
                continue
            q24 = Y.hi24.quantile([.5, .75, .9]).values * 100
            q72 = Y.hi72.quantile([.5, .75, .9]).values * 100
            out.append(f'  {per} {str(lab):24} n {len(Y):5}  24h high above alert close: median {q24[0]:4.1f}%  p75 {q24[1]:5.1f}%  p90 {q24[2]:5.1f}%  '
                       f'reach +8.7% (10x liq) {np.mean(Y.hi24 >= .087):4.0%}  | 72h: median {q72[0]:4.1f}% p75 {q72[1]:5.1f}% p90 {q72[2]:5.1f}% reach +8.7% {np.mean(Y.hi72 >= .087):4.0%}')
print('\n'.join(out))

# ---- from the price one hour after the alert close (what a person who waits an hour faces)
import os
from common import RAW
from paths import grid, G0, H
X = D[(D.k == 1)].copy()
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
X['vb'] = pd.cut(X.v_last_k, [0, 5, 20, 1e9], labels=['<5x', '5-20x', '>=20x'])
X['pb'] = pd.cut(X.p_k, [-9, 0, 9], labels=['below alert close', 'at/above alert close'])
out = ['\n-- from the +1h price: hour-1 volume (x pre-alert baseline) and price vs the alert close']
for per in ('disc', 'val'):
    for keys in (['vb'], ['vb', 'pb']):
        for lab, Y in X[X.period == per].groupby(keys, observed=True):
            q = Y.u24.quantile([.5, .75, .9]).values * 100
            out.append(f'  {per} {str(lab):42} n {len(Y):5}  24h high above the +1h price: median {q[0]:4.1f}% p75 {q[1]:5.1f}% p90 {q[2]:5.1f}%  '
                       f'reach +8.7% {np.mean(Y.u24 >= .087):4.0%}  3d median {Y.f72.median() * 100:+.1f}%  share {len(Y) / (X.period == per).sum():.0%}')
print('\n'.join(out))
