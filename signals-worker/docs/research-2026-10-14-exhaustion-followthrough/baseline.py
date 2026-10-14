"""A. What happens after an up exhaustion alert, over days (alert close = 0).

Per period and sample (all pushed alerts / episode-first): further run-up (peak within 14
and 30 days, hours to it), returns at 1/3/7/14/30 days plain and vs the market, how often
and how soon price closes back below the alert close, and how the long runners split.
"""
import numpy as np, pandas as pd
from common import load, cmean, pct

import os
from common import RAW
D = load(with_perp=False)
A = D[D.k == 0]
C = pd.read_parquet(os.path.join(RAW, 'control.parquet'))
C['day'] = C.ts.dt.floor('D')
C['period'] = np.where(C.ts >= '2025-01-01', 'disc', 'val')
out = []
for per in ('disc', 'val'):
    for samp in ('all', 'first'):
        X = A[(A.period == per) & ((A['first']) if samp == 'first' else True)]
        out.append(f'\n=== {per} / {samp}: {len(X)} alerts, {X.symbol.nunique()} coins, {X.day.nunique()} days, delisted-now coins {(~X.listed_now).mean():.0%}')
        for h, nm in ((24, '1d'), (72, '3d'), (168, '7d'), (336, '14d')):
            y = X[f'f{h}']; xx = X[f'x{h}']
            m, t, n = cmean(np.log1p(y), X.day)
            mx, tx, _ = cmean(xx, X.day)
            out.append(f'  {nm:>3}: median {pct(y.median())}  below alert {np.mean(y.dropna() < 0):.0%}  mean log {m:+.3f} (t {t:+.1f})  vs market log {mx:+.3f} (t {tx:+.1f})  n {n}')
        y = X.r720.dropna()
        out.append(f'  30d: median {pct(y.median())}  below alert {np.mean(y < 0):.0%}  n {len(y)}')
        pk = X.fpeak.dropna(); ph = X.fpeak_h[X.fpeak.notna()]
        out.append(f'  peak within 14d above alert close: median {pct(pk.median())}; >=+10% {np.mean(pk >= .10):.0%}, >=+20% {np.mean(pk >= .20):.0%}, >=+50% {np.mean(pk >= .50):.0%}, >=+100% {np.mean(pk >= 1):.0%}')
        bins = [0, 1, 6, 24, 72, 168, 336]
        lab = ['<=1h', '1-6h', '6-24h', '1-3d', '3-7d', '7-14d']
        hb = pd.cut(ph, bins, labels=lab).value_counts(normalize=True).reindex(lab)
        out.append('  hours to the 14d peak: ' + '  '.join(f'{k} {v:.0%}' for k, v in hb.items()))
        # among the ones that ran >= +20%: how long and how big
        big = X[X.fpeak >= .20]
        out.append(f'  ran >=+20% ({len(big)}): median peak {pct(big.fpeak.median())}, median hours to peak {big.fpeak_h.median():.0f}, '
                   f'median 14d return from alert {pct(big.f336.median())}, below alert at 14d {np.mean(big.f336.dropna() < 0):.0%}')
        b = X.below_alert_30d.dropna()
        hb = X.h_below_alert.dropna()
        out.append(f'  closed below the alert close within 30d: {b.mean():.0%}; hours to first close below: median {hb.median():.0f}, '
                   f'p75 {hb.quantile(.75):.0f}, p90 {hb.quantile(.9):.0f}; within 1h {np.mean(hb <= 1) * b.mean():.0%}, within 24h {np.mean(hb <= 24) * b.mean():.0%}')
        never = X[X.below_alert_30d == False]
        out.append(f'  never closed below alert in 30d: {len(never)} ({len(never) / max(len(b), 1):.0%}); their median 30d return {pct(never.r720.median())}, median peak30 {pct(never.peak30.median())}')
        tr = X.ftrough.dropna()
        out.append(f'  lowest low within 14d below alert close: median {pct(tr.median())}; <= -20% {np.mean(tr <= -.2):.0%}, <= -40% {np.mean(tr <= -.4):.0%}')
        for t in ('thin', 'mid', 'major'):
            Y = X[X.tier == t]
            if len(Y) > 50:
                out.append(f'    tier {t:5} n {len(Y):5}: 7d median {pct(Y.f168.median())}, 14d below alert {np.mean(Y.f336.dropna() < 0):.0%}, peak>=20% {np.mean(Y.fpeak.dropna() >= .2):.0%}, 30d below-alert-ever {Y.below_alert_30d.dropna().mean():.0%}')
        for lab_, msk in (('listed now', X.listed_now), ('delisted since', ~X.listed_now)):
            Y = X[msk]
            if len(Y) > 50:
                out.append(f'    {lab_:14} n {len(Y):5}: 7d median {pct(Y.f168.median())}, 30d median {pct(Y.r720.median())}, peak>=20% {np.mean(Y.fpeak.dropna() >= .2):.0%}')
for per in ('disc', 'val'):
    X = C[C.period == per]
    out.append(f'\n=== CONTROL {per}: {len(X)} ordinary hours on the same coins (nowhere near a print)')
    for h, nm in ((24, '1d'), (72, '3d'), (168, '7d'), (336, '14d')):
        y = X[f'f{h}']
        mx, tx, _ = cmean(X[f'x{h}'], X.day)
        out.append(f'  {nm:>3}: median {pct(y.median())}  below start {np.mean(y.dropna() < 0):.0%}  vs market log {mx:+.3f} (t {tx:+.1f})')
    pk = X.fpeak.dropna(); ph = X.fpeak_h[X.fpeak.notna()]
    out.append(f'  peak within 14d: median {pct(pk.median())}; >=+10% {np.mean(pk >= .10):.0%}, >=+20% {np.mean(pk >= .20):.0%}, >=+50% {np.mean(pk >= .50):.0%}, >=+100% {np.mean(pk >= 1):.0%}')
    hb = pd.cut(ph, [0, 1, 6, 24, 72, 168, 336], labels=['<=1h', '1-6h', '6-24h', '1-3d', '3-7d', '7-14d']).value_counts(normalize=True).sort_index()
    out.append('  hours to the 14d peak: ' + '  '.join(f'{k} {v:.0%}' for k, v in hb.items()))
    out.append(f'  +20% before -20%: {np.mean(X.fp20.dropna() == "up"):.0%} (none {np.mean(X.fp20.dropna() == "none"):.0%});  +10% before -10%: {np.mean(X.fp10.dropna() == "up"):.0%}')
    b = X.below_alert_30d.dropna(); hb = X.h_below_alert.dropna()
    out.append(f'  closed below the start within 30d: {b.mean():.0%}; hours to first close below: median {hb.median():.0f}, p75 {hb.quantile(.75):.0f}, p90 {hb.quantile(.9):.0f}')
    tr = X.ftrough.dropna()
    out.append(f'  lowest low within 14d: median {pct(tr.median())}; <= -20% {np.mean(tr <= -.2):.0%}')
for per in ('disc', 'val'):
    X = A[(A.period == per) & A['first']]
    out.append(f'  ALERTS {per}/first: +20% before -20%: {np.mean(X.fp20.dropna() == "up"):.0%} (none {np.mean(X.fp20.dropna() == "none"):.0%}); +10% before -10%: {np.mean(X.fp10.dropna() == "up"):.0%}')
print('\n'.join(out))
