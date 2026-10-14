"""How long pull-aways last, by market regime, and what at the onset predicts it.

"Continuation" = the relative return after the onset close in the SAME direction as the
pull-away (side x R). Positive = it kept pulling away; negative = it gave some back.
Means clustered by onset date. Halves 2019-22 / 2023-26, both with bull and bear stretches.
Regime at the onset: BTC above/below its 200-day average (btc_bull); CMC altcoin market cap
above/below its own (alt_bull).
"""
import os
import numpy as np, pandas as pd
import statsmodels.api as sm

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, '../../reports/scenarios/2026-10-14-pullaways')
E = pd.read_parquet(os.path.join(RAW, 'events.parquet'))
C = pd.read_parquet(os.path.join(RAW, 'control.parquet'))
E['half'] = np.where(E.date < '2023-01-01', '2019-22', '2023-26')
C['half'] = np.where(C.date < '2023-01-01', '2019-22', '2023-26')
for h in (1, 3, 7, 14, 30, 60, 90):
    E[f'c{h}'] = E.side * E[f'R{h}']
E['day'] = E.date
E['regime'] = np.where(E.btc_bull == True, 'bull', np.where(E.btc_bull == False, 'bear', None))
C['regime'] = np.where(C.btc_bull == True, 'bull', np.where(C.btc_bull == False, 'bear', None))


def cm(y, g):
    y = np.asarray(y, float); g = np.asarray(g); ok = ~np.isnan(y); y, g = y[ok], g[ok]
    if len(y) < 15:
        return np.nan, np.nan, len(y)
    m = y.mean(); e = pd.Series(y - m).groupby(g).sum().values; G = len(e)
    v = (e ** 2).sum() / len(y) ** 2 * G / max(G - 1, 1)
    return m, m / np.sqrt(v), len(y)


def cdiff(y, x, g):
    df = pd.DataFrame({'y': y, 'x': x, 'g': g}).dropna()
    if len(df) < 40 or df.x.nunique() < 2:
        return np.nan, np.nan
    r = sm.OLS(df.y, sm.add_constant(df.x.astype(float))).fit(cov_type='cluster', cov_kwds={'groups': pd.factorize(df.g)[0]})
    return r.params.iloc[1], r.tvalues.iloc[1]


pct = lambda x: f'{100 * x:+.1f}%' if x == x else '  n/a'
out = []
out.append('== A. After a pull-away: does it keep going? (continuation = further relative move in the same direction)')
for side, nm in ((1, 'PULLING AHEAD'), (-1, 'FALLING BEHIND')):
    out.append(f'\n-- {nm}')
    for half in ('2019-22', '2023-26', 'all'):
        for reg in ('bull', 'bear', 'any'):
            X = E[(E.side == side) & ((E.half == half) if half != 'all' else True) & ((E.regime == reg) if reg != 'any' else True)]
            if len(X) < 30:
                continue
            parts = []
            for h in (1, 7, 30, 90):
                m, t, n = cm(X[f'c{h}'], X.day)
                parts.append(f'{h}d median {pct(X[f"c{h}"].median())} mean {pct(m)} (t {t:+.1f}) kept going {np.mean(X[f"c{h}"].dropna() > 0):.0%}')
            P = X.dropna(subset=['peak_day'])
            pk = pd.cut(P.peak_day, [-1, 0, 3, 14, 30, 60, 90], labels=['day0', '1-3d', '4-14d', '15-30d', '31-60d', '61-90d']).value_counts(normalize=True).sort_index()
            out.append(f'  {half} {reg:4} n {len(X):5} | ' + ' | '.join(parts))
            out.append(f'        peak of the lead (from the start of the move): ' + ' '.join(f'{k} {v:.0%}' for k, v in pk.items())
                       + f';  median peak day {P.peak_day.median():.0f}; half the onset lead given back by day 7 {np.mean(P.half_day <= 7):.0%}, by 30 {np.mean(P.half_day <= 30):.0%}, '
                       f'never in 90d {P.half_day.isna().mean():.0%}; all of it back within 90d {P.zero_day.notna().mean():.0%}')
out.append('\n-- CONTROL (random liquid coin-days, relative return either way, so continuation = |R| is not comparable; mean R shows drift)')
for half in ('2019-22', '2023-26'):
    for reg in ('bull', 'bear'):
        X = C[(C.half == half) & (C.regime == reg)]
        out.append(f'  {half} {reg}: n {len(X)}  mean R7 {pct(X.R7.mean())} R30 {pct(X.R30.mean())} R90 {pct(X.R90.mean())}; median R30 {pct(X.R30.median())}')

# B. onset factors -> continuation at 7 and 30 days, top vs bottom fifth, both halves
out.append('\n== B. What at the onset predicts the pull-away lasting (top fifth minus bottom fifth, cut on 2019-22, same cuts on 2023-26)')
FACT = ['rel3', 'z3', 'spike_share', 'vol3', 'vol_rel', 'liq', 'beta', 'mkt3', 'pre30', 'pre90', 'dist_hi365', 'age', 'breadth', 'btc_ret90', 'dom_chg30']
rows = []
for side, nm in ((1, 'ahead'), (-1, 'behind')):
    X = E[E.side == side]
    for f in FACT:
        cut = X[X.half == '2019-22'][f].dropna().quantile([.2, .8]).values
        res = {}
        for half in ('2019-22', '2023-26'):
            Y = X[(X.half == half) & X[f].notna()]
            top = (Y[f] >= cut[1]).astype(float).where((Y[f] >= cut[1]) | (Y[f] <= cut[0]))
            for h in (7, 30):
                d, t = cdiff(Y[f'c{h}'], top, Y.day)
                res[(half, h)] = (d, t, Y.loc[Y[f] >= cut[1], f'c{h}'].median(), Y.loc[Y[f] <= cut[0], f'c{h}'].median())
        both = lambda h: np.sign(res[('2019-22', h)][0]) == np.sign(res[('2023-26', h)][0]) and abs(res[('2019-22', h)][1]) >= 2 and abs(res[('2023-26', h)][1]) >= 2
        rows.append((nm, f, *[round(res[(hf, h)][i], 3) for h in (7, 30) for hf in ('2019-22', '2023-26') for i in (0, 1, 2, 3)], both(7), both(30)))
S = pd.DataFrame(rows, columns=['side', 'factor'] + [f'{k}{h}_{hf[:4]}' for h in (7, 30) for hf in ('2019-22', '2023-26') for k in ('d', 't', 'medTop', 'medBot')] + ['ok7', 'ok30'])
S.to_csv(os.path.join(HERE, 'factors.csv'), index=False)
pd.set_option('display.width', 250)
for _, r in S.iterrows():
    flag = ' <== both halves' if (r.ok7 or r.ok30) else ''
    out.append(f"  {r.side:6} {r.factor:12}  7d: {r['d7_2019']:+.3f} (t {r['t7_2019']:+.1f}) / {r['d7_2023']:+.3f} (t {r['t7_2023']:+.1f})   "
               f"30d: {r['d30_2019']:+.3f} (t {r['t30_2019']:+.1f}) / {r['d30_2023']:+.3f} (t {r['t30_2023']:+.1f})   "
               f"30d median top/bottom {pct(r['medTop30_2023'])} / {pct(r['medBot30_2023'])} (2023-26){flag}")
print('\n'.join(out))
