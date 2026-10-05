"""Intraday: does a quiet stretch predict a sudden swing in the next few hours?

Non-overlapping 4-hour blocks from 2022-01-10. At each block start t:
  rel24   CMC total 24h volume at t vs its median over the prior 30 days (same hour)
  relH    BTC Binance quote volume over the last 4h vs its median for the same
          clock hours over the prior 30 days (strips the daily cycle)
Outcome over [t, t+4h) and [t, t+12h): |return| / usual size for that clock
block (trailing 30 days), and big = |return| > 3x usual.
Controls: last-4h move vs usual, last-24h realised vs usual, block-of-day and
weekend dummies. HAC lags 12.
"""
import json
import numpy as np, pandas as pd, statsmodels.api as sm


def bn(sym):
    k = json.load(open(f'bn_{sym}USDT_1h.json'))
    d = pd.DataFrame(k, columns=['t', 'o', 'h', 'l', 'c', 'qv'])
    d['ts'] = pd.to_datetime(d.t, unit='ms')
    return d.set_index('ts').sort_index()


g = pd.DataFrame(json.load(open('cmc_global_hourly.json')))
g['ts'] = pd.to_datetime(g.ts).dt.tz_localize(None).dt.floor('h')
g = g.drop_duplicates('ts').set_index('ts').sort_index()
v24 = g.vol
med = v24.rolling(15 * 24, center=True, min_periods=48).median()
v24 = v24.where((v24 / med < 3) & (v24 / med > 1 / 3))

btc = bn('BTC')
idx = pd.date_range('2021-11-01', btc.index.max(), freq='h')
qv = btc.qv.reindex(idx)
lv24 = np.log(v24.reindex(idx).ffill(limit=2))
rel24 = lv24 - lv24.shift(1).rolling(30 * 24, min_periods=20 * 24).median()
qv4 = qv.rolling(4).sum()                                  # volume in hours t-4..t-1 when read at t (shift below)
lq4 = np.log(qv4.shift(1))
hour = pd.Series(idx.hour, index=idx)
relH = lq4 - lq4.groupby(hour).transform(lambda s: s.shift(1).rolling(30, min_periods=20).median())

rows = []
for sym in ('BTC', 'ETH', 'SOL'):
    p = bn(sym).c.reindex(idx).ffill(limit=2)
    lp = np.log(p)
    r4b = lp - lp.shift(4)                                 # move over the last 4h, known at t
    r4f = lp.shift(-4) - lp                                # next 4h
    r12f = lp.shift(-12) - lp
    r1 = lp.diff()
    rv24 = np.sqrt((r1 ** 2).rolling(24).sum())
    usual4 = r4f.abs().groupby(hour).transform(lambda s: s.shift(5).rolling(30, min_periods=20).median())
    usual12 = r12f.abs().groupby(hour).transform(lambda s: s.shift(13).rolling(30, min_periods=20).median())
    usual24 = rv24.shift(24).rolling(30 * 24, min_periods=20 * 24).median()
    d = pd.DataFrame({'rel24': rel24, 'relH': relH,
                      'size4': np.log(r4f.abs() / usual4 + 1e-3), 'big4': (r4f.abs() > 3 * usual4).astype(float),
                      'size12': np.log(r12f.abs() / usual12 + 1e-3), 'big12': (r12f.abs() > 3 * usual12).astype(float),
                      'dir4': r4f * 100, 'dir12': r12f * 100,
                      'x_last': np.log(r4b.abs() / usual4.shift(4) + 1e-3), 'x_rv': np.log(rv24 / usual24),
                      'hour': hour, 'wknd': (idx.dayofweek >= 5).astype(float)}, index=idx)
    d = d[(d.index >= '2022-01-10') & (d.index.hour % 4 == 0)].dropna()
    for hb in (4, 8, 12, 16, 20):
        d[f'h{hb}'] = (d.hour == hb).astype(float)
    ctrl = ['x_last', 'x_rv', 'wknd'] + [f'h{hb}' for hb in (4, 8, 12, 16, 20)]
    for pred in ('rel24', 'relH'):
        for y in ('size4', 'big4', 'size12', 'big12', 'dir4', 'dir12'):
            c = ctrl if not y.startswith('dir') else ['wknd'] + [f'h{hb}' for hb in (4, 8, 12, 16, 20)]
            m = sm.OLS(d[y], sm.add_constant(d[[pred] + c])).fit(cov_type='HAC', cov_kwds={'maxlags': 12})
            rows.append({'asset': sym, 'pred': pred, 'y': y, 'n': len(d), 'beta': m.params[pred], 't': m.tvalues[pred]})
    # raw: quietest fifth of the last 4h (trailing cut) vs the rest
    cut = d.relH.expanding(500).quantile(0.2).shift(1)
    q = d[d.relH <= cut]; o = d[(d.relH > cut) & cut.notna()]
    print(f'{sym}: quietest-fifth 4h blocks n={len(q)}: big4 {q.big4.mean():.3f} vs {o.big4.mean():.3f}, '
          f'big12 {q.big12.mean():.3f} vs {o.big12.mean():.3f}, next-4h up share {(q.dir4>0).mean():.3f} vs {(o.dir4>0).mean():.3f}')
res = pd.DataFrame(rows)
print(res.pivot_table(index=['pred', 'y'], columns='asset', values='t').round(2).to_string())
res.to_csv('hourly_regressions.csv', index=False)
