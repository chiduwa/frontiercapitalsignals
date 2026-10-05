"""Out of sample: does total-market relative volume sharpen the next-day SIZE
forecast beyond (a) GARCH(1,1)+weekday, the size model production already
trusts, and (b) the coin's own relative volume, which the day-zone band uses?

Expanding window from 2022-01-10, GARCH refit every 30 days on all history
since 2018 (returns only, so the 2022 volume-method break does not touch it).
Challengers scale the GARCH+weekday variance by exp(a + b*x), with a, b fitted
on strictly earlier rows by regressing log(r^2 / sigma^2) on x. Loss: QLIKE.
Paired loss differences, Newey-West t (lags 5). Negative = challenger better.
"""
import json, warnings
import numpy as np, pandas as pd, statsmodels.api as sm
from arch import arch_model
warnings.filterwarnings('ignore')

frames = pd.read_pickle('frames.pkl')


def own_rel(sym):
    k = json.load(open(f'bn_{sym}USDT_1d.json'))
    d = pd.DataFrame(k, columns=['t', 'o', 'h', 'l', 'c', 'qv'])
    d['ts'] = pd.to_datetime(d.t, unit='ms'); d = d.set_index('ts')
    lq = np.log(d.qv).shift(1)                          # yesterday's volume, known at D 00:00
    return lq - lq.shift(1).rolling(30, min_periods=25).median(), np.log(d.c / d.o)


def garch_weekday(r, start):
    r = r.dropna() * 100
    sig2 = pd.Series(np.nan, index=r.index)
    days = r.index[r.index >= start]
    for i in range(0, len(days), 30):
        block = days[i:i + 30]
        hist = r[r.index < block[0]]
        res = arch_model(hist, vol='GARCH', p=1, q=1, mean='Constant', dist='normal').fit(disp='off')
        om, al, be = res.params['omega'], res.params['alpha[1]'], res.params['beta[1]']
        mu = res.params['mu']
        s2 = res.conditional_volatility.iloc[-1] ** 2
        e2 = (hist.iloc[-1] - mu) ** 2
        for d in block:
            s2 = om + al * e2 + be * s2
            sig2[d] = s2
            e2 = (r[d] - mu) ** 2
    out = pd.DataFrame({'r2': r ** 2, 'g': sig2})
    out['ratio'] = np.log(out.r2 / out.g + 1e-6)
    wd = out.index.dayofweek
    # weekday factor from strictly earlier rows (expanding mean of r^2/sigma^2 per weekday)
    rr = (out.r2 / out.g)
    f = rr.groupby(wd).transform(lambda s: s.shift(1).expanding(20).mean())
    out['gw'] = out.g * f / rr.shift(1).expanding(100).mean()
    return out


def qlike(r2, s2):
    return r2 / s2 - np.log(r2 / s2 + 1e-12) - 1


def scaled(base, x, y_ratio, min_n=150):
    """exp(a + b x) correction fitted on earlier rows only (refit every 30 rows)."""
    out = pd.Series(np.nan, index=base.index)
    idx = base.index
    for i in range(min_n, len(idx), 30):
        tr = pd.DataFrame({'y': y_ratio.iloc[:i], 'x': x.iloc[:i]}).dropna()
        if len(tr) < min_n: continue
        m = sm.OLS(tr.y, sm.add_constant(tr[['x']])).fit()
        blk = idx[i:i + 30]
        # log-normal bias: E[r2/s2 | x] = exp(a + b x) * E[exp(resid)]
        adj = np.log(np.mean(np.exp(m.resid)))
        out[blk] = base[blk] * np.exp(m.params['const'] + m.params['x'] * x[blk] + adj)
    return out


rows = []
for name in ('MARKET', 'BTC', 'ETH', 'SOL'):
    f = frames[name]
    if name == 'MARKET':
        full_r = None
    g = json.load(open('cmc_global_daily.json'))
    if name == 'MARKET':
        gg = pd.DataFrame(g); gg['ts'] = pd.to_datetime(gg.ts).dt.tz_localize(None); gg = gg.set_index('ts').sort_index()
        full_r = np.log(gg.mcap.shift(-1) / gg.mcap)
        full_r = full_r[full_r.index >= '2018-01-01']
        orel = None
    else:
        orel, full_r = own_rel(name)
        full_r = full_r[full_r.index >= '2018-01-01']
    gw = garch_weekday(full_r, '2022-01-10')
    d = gw.join(f[['rel']], how='inner')
    if orel is not None:
        d['orel'] = orel.reindex(d.index)
    d = d.dropna(subset=['gw', 'rel', 'r2'])
    y = np.log(d.r2 / d.gw + 1e-6)
    d['tot'] = scaled(d.gw, d.rel, y)
    cands = {'+ total volume': 'tot'}
    if orel is not None:
        d['own'] = scaled(d.gw, d.orel, y)
        # both: two-variable correction
        out = pd.Series(np.nan, index=d.index)
        for i in range(150, len(d), 30):
            tr = pd.DataFrame({'y': y.iloc[:i], 'a': d.rel.iloc[:i], 'b': d.orel.iloc[:i]}).dropna()
            m = sm.OLS(tr.y, sm.add_constant(tr[['a', 'b']])).fit()
            blk = d.index[i:i + 30]; adj = np.log(np.mean(np.exp(m.resid)))
            out[blk] = d.gw[blk] * np.exp(m.params['const'] + m.params['a'] * d.rel[blk] + m.params['b'] * d.orel[blk] + adj)
        d['both'] = out
        cands.update({'+ own volume': 'own', '+ own AND total': 'both'})
    ev = d.dropna(subset=[c for c in cands.values()])
    base = qlike(ev.r2, ev.gw)
    for label, col in cands.items():
        diff = qlike(ev.r2, ev[col]) - base
        m = sm.OLS(diff, np.ones(len(diff))).fit(cov_type='HAC', cov_kwds={'maxlags': 5})
        half = len(diff) // 2
        rows.append({'asset': name, 'model': f'GARCH+weekday {label}', 'n': len(diff),
                     'qlike_change_pct': 100 * diff.mean() / base.mean(), 't': m.tvalues.iloc[0],
                     't_first_half': sm.OLS(diff[:half], np.ones(half)).fit(cov_type='HAC', cov_kwds={'maxlags': 5}).tvalues.iloc[0],
                     't_second_half': sm.OLS(diff[half:], np.ones(len(diff) - half)).fit(cov_type='HAC', cov_kwds={'maxlags': 5}).tvalues.iloc[0]})
    if orel is not None:
        # does total volume add beyond own volume? compare 'both' vs 'own'
        diff = qlike(ev.r2, ev.both) - qlike(ev.r2, ev.own)
        m = sm.OLS(diff, np.ones(len(diff))).fit(cov_type='HAC', cov_kwds={'maxlags': 5})
        rows.append({'asset': name, 'model': 'total volume ON TOP of own volume', 'n': len(diff),
                     'qlike_change_pct': 100 * diff.mean() / qlike(ev.r2, ev.own).mean(), 't': m.tvalues.iloc[0],
                     't_first_half': np.nan, 't_second_half': np.nan})
res = pd.DataFrame(rows)
print(res.round(3).to_string(index=False))
res.to_csv('oos_size.csv', index=False)
