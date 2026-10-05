"""Can CMC20 help find trends / predict the tracked coins?

CMC20: cap-weighted top-20 (ex-stables), ~69% BTC / 13% ETH. Daily values from
2024-01-01 (its first print). Each test is run twice: once with the CMC20 version
of the signal and once with the plain BTC version, because an index that is
two-thirds BTC only earns a place if it beats BTC at the same job.

Targets: next-day and next-7-day returns of CMC20 itself and of BTC, ETH, SOL,
XRP, XLM, HBAR, ARB, DOGE, ADA (Binance daily, open 00:00 UTC).
Signals (known at D 00:00):
  mom7 / mom30     sign of the trailing 7 / 30 day return
  ma20 / ma50      above / below the 20 / 50 day moving average
  alt_lead         yesterday's non-BTC part of CMC20 (r20 - beta*rBTC), for alts
  breadth          CMC100 minus CMC20 trailing 7d return (broad vs large caps)
HAC t (lags h+5); Holm across the whole family; both halves must agree in sign.
"""
import json
import numpy as np, pandas as pd, statsmodels.api as sm
from statsmodels.stats.multitest import multipletests


def idx(name):
    d = pd.DataFrame(json.load(open(f'{name}_daily.json')))
    d['ts'] = pd.to_datetime(d.date)
    return d.set_index('ts').value.sort_index()


def bn(sym):
    k = json.load(open(f'bn_{sym}USDT_1d.json'))
    d = pd.DataFrame(k, columns=['t', 'o', 'h', 'l', 'c', 'qv'])
    d['ts'] = pd.to_datetime(d.t, unit='ms')
    return d.set_index('ts').sort_index()


c20 = idx('cmc20')
try:
    c100 = idx('cmc100')
except FileNotFoundError:
    c100 = None

btc = bn('BTC')
# Alignment: is CMC20 at D 00:00 the value AT that instant (i.e. after day D-1)?
r20 = np.log(c20 / c20.shift(1))                      # change from D-1 00:00 to D 00:00
rb_same = np.log(btc.c / btc.o)                       # BTC day D
al = pd.DataFrame({'r20': r20, 'btc_dm1': rb_same.shift(1), 'btc_d': rb_same}).dropna()
print('alignment: corr(CMC20 D-1->D, BTC day D-1) =', round(al.r20.corr(al.btc_dm1), 3),
      '| corr with BTC day D =', round(al.r20.corr(al.btc_d), 3))

# So the return OF day D is c20[D+1]/c20[D]; signals at D use c20 up to D.
lv20 = np.log(c20)
coins = ['BTC', 'ETH', 'SOL', 'XRP', 'XLM', 'HBAR', 'ARB', 'DOGE', 'ADA']
px = {s: bn(s) for s in coins}
day = pd.date_range('2024-01-01', c20.index.max(), freq='D')
lbtc_open = np.log(px['BTC'].o).reindex(day)


def signals(lp):
    """lp: log level known at D 00:00 (index D)."""
    s = pd.DataFrame(index=day)
    s['mom7'] = np.sign(lp - lp.shift(7))
    s['mom30'] = np.sign(lp - lp.shift(30))
    s['ma20'] = np.sign(lp - np.log(np.exp(lp).rolling(20).mean()))
    s['ma50'] = np.sign(lp - np.log(np.exp(lp).rolling(50).mean()))
    return s


sig20 = signals(lv20.reindex(day))
sigB = signals(lbtc_open)
beta = r20.rolling(60).cov(rb_same.shift(1)) / rb_same.shift(1).rolling(60).var()
sig20['alt_lead'] = np.sign(r20 - beta * rb_same.shift(1)).reindex(day)
sigB['alt_lead'] = np.nan
if c100 is not None:
    br = (np.log(c100 / c100.shift(7)) - np.log(c20 / c20.shift(7))).reindex(day)
    sig20['breadth'] = np.sign(br)

rows = []
targets = {'CMC20': np.log(c20.shift(-1) / c20).reindex(day)}
for s in coins:
    targets[s] = np.log(px[s].c / px[s].o).reindex(day)
for tname, r in targets.items():
    cum = r.fillna(0).cumsum()
    for h in (1, 7):
        y = (cum.shift(-(h - 1)) - cum.shift(1)) * 100 if h > 1 else r * 100
        for source, S in (('CMC20', sig20), ('BTC', sigB)):
            for sname in S.columns:
                if sname == 'alt_lead' and (source == 'BTC' or tname in ('CMC20', 'BTC')):
                    continue
                d = pd.DataFrame({'y': y, 'x': S[sname]}).dropna()
                d = d[d.x != 0]
                if len(d) < 200: continue
                m = sm.OLS(d.y, sm.add_constant(d.x)).fit(cov_type='HAC', cov_kwds={'maxlags': h + 5})
                half = len(d) // 2
                b1 = sm.OLS(d.y[:half], sm.add_constant(d.x[:half])).fit().params['x']
                b2 = sm.OLS(d.y[half:], sm.add_constant(d.x[half:])).fit().params['x']
                rows.append({'target': tname, 'h': h, 'source': source, 'signal': sname, 'n': len(d),
                             'edge_pct': m.params['x'], 't': m.tvalues['x'], 'p': m.pvalues['x'],
                             'halves_agree': np.sign(b1) == np.sign(b2)})
res = pd.DataFrame(rows)
res['p_holm'] = multipletests(res.p, method='holm')[1]
res['survives'] = (res.p_holm < 0.05) & res.halves_agree
pd.set_option('display.width', 220)
print(f'\n{len(res)} tests; surviving Holm + both halves: {int(res.survives.sum())}')
print(res.sort_values('p').head(15).round(4).to_string(index=False))
print('\nmean |t| by source:', res.groupby('source').t.apply(lambda t: t.abs().mean()).round(2).to_dict())
piv = res[res.signal.isin(['mom7', 'mom30', 'ma20', 'ma50'])].pivot_table(index=['target', 'h', 'signal'], columns='source', values='t')
print('\nCMC20 vs BTC version of the same trend signal (t):')
print(piv.round(2).to_string())
res.to_csv('cmc20_tests.csv', index=False)
# How much of CMC20 is BTC?
both = pd.DataFrame({'r20': targets['CMC20'], 'rb': targets['BTC'], 're': targets['ETH']}).dropna()
print('\ncorr(CMC20, BTC) daily:', round(both.r20.corr(both.rb), 3), ' R2 on BTC+ETH:',
      round(sm.OLS(both.r20, sm.add_constant(both[['rb', 're']])).fit().rsquared, 3))
