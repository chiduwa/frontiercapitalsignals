import numpy as np, pandas as pd, statsmodels.api as sm
frames = pd.read_pickle('frames.pkl')
print('=== what came BEFORE the big moves (|move| > 2x usual) ===')
for name, df in frames.items():
    d = df.copy()
    cut = d.rel.expanding(120).quantile(1/3).shift(1)
    d['quiet_before'] = ((d.rel <= cut) & cut.notna()).astype(float).where(cut.notna())
    d = d.dropna(subset=['quiet_before', 'big', 'r'])
    big = d[d.big == 1]
    up, dn = big[big.r > 0], big[big.r < 0]
    print(f'{name:6} big days {len(big):3} (up {len(up)}, down {len(dn)}) | preceded by a quiet day: {big.quiet_before.mean():.0%} '
          f'(all days: {d.quiet_before.mean():.0%}) | quiet->big went down {((big.quiet_before==1)&(big.r<0)).sum()}/{int(big.quiet_before.sum())}')
print('\n=== direction of the break after a quiet day: does it follow the prior 7-day trend? ===')
for name, df in frames.items():
    d = df.copy()
    cut = d.rel.expanding(120).quantile(1/3).shift(1)
    d['quiet'] = (d.rel <= cut) & cut.notna()
    cum = d.r.fillna(0).cumsum(); d['trend7'] = cum.shift(1) - cum.shift(8)
    q = d[d.quiet].dropna(subset=['dir3', 'trend7'])
    agree = (np.sign(q.dir3) == np.sign(q.trend7)).mean()
    m = sm.OLS(q.dir3, sm.add_constant(np.sign(q.trend7))).fit(cov_type='HAC', cov_kwds={'maxlags': 8})
    print(f'{name:6} quiet days {len(q)}: next-3d move agrees with prior-7d trend {agree:.0%}; beta {m.params.iloc[1]:+.2f}% t {m.tvalues.iloc[1]:+.2f}')
