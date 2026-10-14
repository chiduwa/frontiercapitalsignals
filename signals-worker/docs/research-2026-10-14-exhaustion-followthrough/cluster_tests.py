"""E (tests). Do the estimated liquidation bands from clusters.py tell where the price goes?

T1 magnet   reach band b in 24h (high >= b - 0.5%)  ~  band FE + fuel-heavy (top 20% of fuel
            at that distance) + controls (alert's total fuel within 15%, coin hourly vol)
T2 cascade  given the high reached b: also reached b + 3%  ~  same
T3 top      given reached b: the 24h high stopped inside [b, b + 2%)  ~  same
T4 placebo  |24h high - densest short-liquidation band|: real pairing vs the same alerts'
            densest bands shuffled among alerts of the same period/checkpoint AND the same
            volatility fifth (500 shuffles), so a volatile coin's wide map cannot pass as skill
Longs mirror it below the price with the 24h low. Linear probability, clustered by day.
"""
import os
import numpy as np, pandas as pd
import statsmodels.api as sm
from common import RAW, load

R = pd.read_parquet(os.path.join(RAW, 'clusters.parquet'))
F = pd.read_parquet(os.path.join(RAW, 'cluster_feats.parquet'))
P = load(with_perp=False)
P = P[P.k == 0][['symbol', 'ts', 'liq30d']].merge(pd.read_parquet(os.path.join(RAW, 'prints.parquet'))[['symbol', 'ts', 'hourVol']], on=['symbol', 'ts'], how='left')
R = R.merge(P, on=['symbol', 'ts'], how='left').merge(F[['symbol', 'ts', 'k', 'sfuel15_10', 'lfuel15_10']], on=['symbol', 'ts', 'k'], how='left')


def lpm(y, X, g):
    df = pd.concat([y.rename('y'), X, g.rename('g')], axis=1).dropna()
    r = sm.OLS(df.y.astype(float), sm.add_constant(df.drop(columns=['y', 'g']).astype(float))).fit(
        cov_type='cluster', cov_kwds={'groups': pd.factorize(df.g)[0]})
    return r.params['heavy'], r.tvalues['heavy'], len(df)


out = []
for side, fuel, move, tot in (('shorts (above)', 'sfuel', 'up24', 'sfuel15_10'), ('longs (below)', 'lfuel', 'dn24', 'lfuel15_10')):
    out.append(f'\n######## {side}')
    for L in (10, 20):
        for k in (1, 4, 12):
            for per in ('disc', 'val'):
                X = R[(R.L == L) & (R.k == k) & (R.period == per) & (R.band <= 25)].copy()
                if X.empty:
                    continue
                q = X.groupby('band')[fuel].transform(lambda s: s.quantile(0.8))
                X['heavy'] = ((X[fuel] >= q) & (X[fuel] > 0)).astype(float)
                bands = pd.get_dummies(X.band, prefix='b', drop_first=True).astype(float)
                ctrl = pd.DataFrame({'tot': np.log1p(X[tot].fillna(0) * 100), 'vol': X.hourVol})
                reach = (X[move] >= X.band - 0.5).astype(float)
                d1, t1, n1 = lpm(reach, pd.concat([X[['heavy']], bands, ctrl], axis=1), X.day)
                Y = X[X[move] >= X.band]
                bY = pd.get_dummies(Y.band, prefix='b', drop_first=True).astype(float)
                cY = pd.DataFrame({'tot': np.log1p(Y[tot].fillna(0) * 100), 'vol': Y.hourVol})
                ext = (Y[move] >= Y.band + 3).astype(float)
                d2, t2, n2 = lpm(ext, pd.concat([Y[['heavy']], bY, cY], axis=1), Y.day)
                top = ((Y[move] >= Y.band) & (Y[move] < Y.band + 2)).astype(float)
                d3, t3, n3 = lpm(top, pd.concat([Y[['heavy']], bY, cY], axis=1), Y.day)
                out.append(f'  {L}x +{k:2}h {per}: magnet reach {d1:+.3f} (t {t1:+.1f}, n {n1});  cascade +3% {d2:+.3f} (t {t2:+.1f}, n {n2});  '
                           f'top stops in band {d3:+.3f} (t {t3:+.1f})   base reach {reach.mean():.0%}, heavy share {X.heavy.mean():.0%}')
# T4: does the 24h high land near the densest short band more than chance?
rng = np.random.default_rng(0)
F = F.merge(P[['symbol', 'ts', 'hourVol']], on=['symbol', 'ts'], how='left')
out.append('\n######## T4 placebo: |24h extreme - densest band| (%), real vs shuffled densest band')
for col, move in (('speak_10', 'up24'), ('speak_20', 'up24'), ('lpeak_10', 'dn24'), ('lpeak_20', 'dn24')):
    for k in (1, 4, 12):
        for per in ('disc', 'val'):
            X = F[(F.k == k) & (F.period == per)].dropna(subset=[col, move])
            if len(X) < 100:
                continue
            real = np.median(np.abs(X[move].values - (X[col].values - 0.5)))
            near = np.mean(np.abs(X[move].values - (X[col].values - 0.5)) <= 1.5)
            sh = []; shn = []
            strata = pd.qcut(X.hourVol.rank(method='first'), 5, labels=False).values      # shuffle within volatility fifths
            for _ in range(500):
                p = X[col].values.copy()
                for s_ in range(5):
                    ix = np.flatnonzero(strata == s_)
                    p[ix] = p[rng.permutation(ix)]
                dd = np.abs(X[move].values - (p - 0.5))
                sh.append(np.median(dd)); shn.append(np.mean(dd <= 1.5))
            sh, shn = np.array(sh), np.array(shn)
            out.append(f'  {col} +{k:2}h {per}: n {len(X)}  median gap real {real:.2f}% vs shuffled {sh.mean():.2f}% (p {np.mean(sh <= real):.3f});  '
                       f'within 1.5% real {near:.1%} vs shuffled {shn.mean():.1%} (p {np.mean(shn >= near):.3f});  densest band median {X[col].median():.0f}%')
print('\n'.join(out))
