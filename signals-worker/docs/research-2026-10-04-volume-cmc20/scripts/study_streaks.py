import numpy as np, pandas as pd, statsmodels.api as sm
frames = pd.read_pickle('frames.pkl')
WD = [f'd{d}' for d in range(1, 7)]
def hac(y, X, lags):
    return sm.OLS(y, sm.add_constant(X), missing='drop').fit(cov_type='HAC', cov_kwds={'maxlags': lags})
print('=== era split: t on rel (relative volume) ===')
for name, df in frames.items():
    row = [name]
    for lo, hi in (('2022-01-10', '2023-12-31'), ('2024-01-01', '2026-12-31')):
        d = df.loc[lo:hi]
        for y in ('big', 'size', 'swing3'):
            ctrl = ['x_rv', 'x_last'] + WD
            dd = d[[y, 'rel'] + ctrl].dropna(); m = hac(dd[y], dd[['rel'] + ctrl], 6 if y != 'swing3' else 8)
            row.append(f'{y}{lo[:4]}: {m.tvalues["rel"]:+.2f}')
    print('  '.join(row))
print('\n=== low60 next-7d return by year (raw mean %, share of days below 60B) ===')
for name in ('MARKET', 'BTC'):
    df = frames[name]
    t = df.groupby([df.index.year, 'low60']).dir7.mean().unstack().round(2)
    t['share_low'] = df.groupby(df.index.year).low60.mean().round(2)
    print(name); print(t.to_string())
    # within-year demeaned test: does low60 still predict dir7 once each year's drift is removed?
    d = df.dropna(subset=['dir7', 'low60']).copy()
    d['dir7_dm'] = d.dir7 - d.groupby(d.index.year).dir7.transform('mean')
    m = hac(d.dir7_dm, d[['low60'] + WD], 12)
    print(f'  low60 -> next-7d return, year-demeaned: beta {m.params["low60"]:+.2f}%  t {m.tvalues["low60"]:+.2f}')
print('\n=== quiet streaks: consecutive days with relative volume in its bottom third (trailing cut) ===')
for name, df in frames.items():
    d = df.copy()
    cut = d.rel.expanding(120).quantile(1/3).shift(1)
    quiet = (d.rel <= cut) & cut.notna()
    streak = quiet.groupby((~quiet).cumsum()).cumsum()
    d['streak'] = streak.where(quiet, 0)
    d['sb'] = pd.cut(d.streak, [-1, 0, 1, 2, 4, 100], labels=['0', '1', '2', '3-4', '5+'])
    tab = d.dropna(subset=['big']).groupby('sb', observed=True).agg(days=('big', 'size'), big_rate=('big', 'mean'),
        move_vs_usual=('size', lambda s: np.exp(s).median()), swing7=('swing7', lambda s: np.exp(s).median()))
    print(name); print(tab.round(3).to_string())
    dd = d[['big', 'streak', 'x_rv', 'x_last'] + WD].dropna(); dd = dd[dd.streak > 0]
    m = hac(dd.big, dd[['streak', 'x_rv', 'x_last'] + WD], 6)
    print(f'  within quiet spells, each extra quiet day -> big-move prob {m.params["streak"]*100:+.2f} pts, t {m.tvalues["streak"]:+.2f} (n={len(dd)})')
