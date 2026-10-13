"""Catalyst event study on Binance spot closes, market-adjusted.

For each (sym, d): pre = close[d-1]/close[d-31]-1; day0 = close[d]/close[d-1]-1;
peak7 = max close d..d+7 / close[d-1] - 1; post7/30/90 = close[d+h]/close[d]-1 (delisting exits at
the last close). Each is reported raw and minus the median Binance alt over the same window.
Rows are split by year and by low-cap (bottom 40% Binance mcap on d-1)."""
import os
import numpy as np, pandas as pd
from common import RAW, OUT

F = pd.read_parquet(os.path.join(RAW, 'daily_features.parquet'), columns=['date', 'asset', 'sym', 'close', 'mcap', 'age', 'is_live_seg'])
F['date'] = pd.to_datetime(F.date)
F['mcap_pct'] = F.groupby('date').mcap.rank(pct=True)
C = F.pivot_table(index='date', columns='sym', values='close', aggfunc='last')
MP = F.pivot_table(index='date', columns='sym', values='mcap_pct', aggfunc='last')
E = pd.read_parquet(os.path.join(RAW, 'events.parquet'))


def win(sym, a, b):
    s = C[sym]
    va = s.asof(a) if a >= s.first_valid_index() else np.nan
    sv = s.loc[:b].dropna()
    vb = sv.iloc[-1] if len(sv) else np.nan
    return vb / va - 1 if va and va > 0 else np.nan


def mkt(a, b):
    ra = C.loc[:a].ffill().iloc[-1]
    rb = C.loc[:b].ffill().iloc[-1]
    r = (rb / ra - 1).replace([np.inf, -np.inf], np.nan).dropna()
    return r.median() if len(r) > 20 else np.nan


rows = []
for e in E.itertuples():
    if e.sym not in C.columns or e.kind in ('bn_support',) and e.date < pd.Timestamp('2020-01-01'):
        continue
    s = C[e.sym].dropna()
    if s.empty or e.date - pd.Timedelta(days=31) < s.index[0] or e.date > s.index[-1]:
        continue
    d = e.date
    d1 = d - pd.Timedelta(days=1)
    r = dict(sym=e.sym, date=d, kind=e.kind, year=d.year,
             lowcap=float(MP[e.sym].asof(d1) <= 0.4) if e.sym in MP and pd.notna(MP[e.sym].asof(d1)) else np.nan)
    r['pre'] = win(e.sym, d - pd.Timedelta(days=31), d1)
    r['pre_mkt'] = mkt(d - pd.Timedelta(days=31), d1)
    r['day0'] = win(e.sym, d1, d)
    r['day0_mkt'] = mkt(d1, d)
    seg = s.loc[d:d + pd.Timedelta(days=7)]
    r['peak7'] = seg.max() / s.asof(d1) - 1 if len(seg) else np.nan
    for h in (7, 30, 90):
        b = d + pd.Timedelta(days=h)
        if b > C.index[-1]:
            r[f'post{h}'] = np.nan
            continue
        r[f'post{h}'] = win(e.sym, d, b)
        r[f'post{h}_mkt'] = mkt(d, b)
    rows.append(r)
R = pd.DataFrame(rows)
for c in ('pre', 'day0', 'post7', 'post30', 'post90'):
    R[c + '_x'] = R[c] - R[c + '_mkt']
R.to_csv(os.path.join(OUT, 'event_study.csv'), index=False)


def summ(g):
    out = {'n': len(g)}
    for c in ('pre_x', 'day0_x', 'peak7', 'post7_x', 'post30_x', 'post90_x'):
        x = g[c].dropna()
        out[c + '_med'] = x.median()
        out[c + '_mean'] = x.clip(-1, 5).mean()
        out[c + '_pos'] = (x > 0).mean()
        if c == 'post90_x':
            out['post90_n'] = len(x)
    return pd.Series(out)


pd.set_option('display.width', 250)
pd.set_option('display.max_columns', 40)
cols = ['n', 'pre_x_med', 'day0_x_med', 'peak7_med', 'post7_x_med', 'post30_x_med', 'post30_x_pos', 'post90_x_med', 'post90_x_pos', 'post90_x_mean', 'post90_n']
print('=== by kind (all caps) ===')
print(R.groupby('kind').apply(summ, include_groups=False)[cols].round(3).to_string())
print('\n=== by kind, low-cap only ===')
print(R[R.lowcap == 1].groupby('kind').apply(summ, include_groups=False)[cols].round(3).to_string())
for k in ('upbit_krw', 'bn_perp', 'bn_monitoring', 'bn_delist'):
    print(f'\n=== {k} by year ===')
    print(R[R.kind == k].groupby('year').apply(summ, include_groups=False)[cols].round(3).to_string())
