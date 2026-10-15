"""Do moving-average states predict BTC or total crypto market cap? (2026-10-14)

BTC: Bitstamp daily close 2011-08 .. 2026-10-13. Total market cap: CoinMarketCap daily
2013-04 .. 2026-10-11 (data of the 2026-10-12 cycles study). Forward log returns at 30, 90
and 180 days from each day's close, by state at that close; differences tested by OLS on a
state dummy with Newey-West errors (lags = horizon, the windows overlap). Halves split at
2019-01-01. Also: calibration of a volatility-based expected range (EWMA, lambda 0.94),
the share of 7- and 30-day moves inside +-1 and +-2 forecast sd.
Output: ma_evidence.json, ma_research.txt
"""
import json, os
import numpy as np, pandas as pd
import statsmodels.api as sm

SRC = os.path.join(os.path.dirname(__file__), '../../reports/scenarios/2026-10-12-near-red/claude/cycles/data')
btc = pd.read_parquet(os.path.join(SRC, 'BTC.parquet')).close
mk = pd.read_parquet(os.path.join(SRC, 'MKT.parquet')).close
SER = {}
for name, s in (('btc', btc), ('total', mk)):
    s = s[~s.index.duplicated()].sort_index().asfreq('D').ffill()
    SER[name] = s
H = (30, 90, 180)


def hac(y, x, lags):
    df = pd.DataFrame({'y': y, 'x': x}).dropna()
    if df.x.nunique() < 2 or len(df) < 100:
        return np.nan, np.nan
    r = sm.OLS(df.y, sm.add_constant(df.x.astype(float))).fit(cov_type='HAC', cov_kwds={'maxlags': lags})
    return r.params['x'], r.tvalues['x']


ev, out = {}, []
for name, s in SER.items():
    L = np.log(s)
    sma = {n: s.rolling(n).mean() for n in (20, 50, 100, 200, 1400)}
    st = pd.DataFrame(index=s.index)
    st['above200'] = s > sma[200]
    st['above50'] = s > sma[50]
    st['golden'] = sma[50] > sma[200]
    st['rising200'] = sma[200] > sma[200].shift(20)
    st['stack_bull'] = (s > sma[20]) & (sma[20] > sma[50]) & (sma[50] > sma[200])
    st['stack_bear'] = (s < sma[20]) & (sma[20] < sma[50]) & (sma[50] < sma[200])
    st['above200w'] = s > sma[1400]
    mayer = s / sma[200]
    st['mayer'] = mayer
    F = {h: L.shift(-h) - L for h in H}
    ok = sma[200].notna()
    ev[name] = {'states': {}, 'mayerBands': [], 'range': {}}
    out.append(f'\n######## {name}  {s.index[0].date()} .. {s.index[-1].date()}')
    for half, m in (('all', ok), ('early', ok & (s.index < '2019-01-01')), ('late', ok & (s.index >= '2019-01-01'))):
        line = []
        for h in H:
            f = F[h][m].dropna()
            line.append(f'{h}d mean {f.mean():+.3f} median {f.median():+.3f} up {np.mean(f > 0):.0%}')
        out.append(f'  base {half}: ' + ' | '.join(line))
    for k in ('above200', 'above50', 'golden', 'rising200', 'stack_bull', 'stack_bear', 'above200w'):
        rec = {}
        out.append(f'  -- {k}')
        for half, m in (('early', ok & (s.index < '2019-01-01')), ('late', ok & (s.index >= '2019-01-01'))):
            x = st[k].where(m)
            if k == 'above200w':
                x = x.where(sma[1400].notna())
            for h in H:
                y = F[h].where(x.notna())
                d, t = hac(y, x.astype(float), h)
                a = F[h][(x == True)].dropna(); b = F[h][(x == False)].dropna()
                rec[f'{half}{h}'] = {'diff': round(float(d), 4) if d == d else None, 't': round(float(t), 2) if t == t else None,
                                     'trueMedian': round(float(a.median()), 4) if len(a) else None, 'falseMedian': round(float(b.median()), 4) if len(b) else None,
                                     'trueUp': round(float(np.mean(a > 0)), 3) if len(a) else None, 'falseUp': round(float(np.mean(b > 0)), 3) if len(b) else None,
                                     'nTrue': int(len(a)), 'nFalse': int(len(b))}
                out.append(f'     {half} {h}d: true median {a.median():+.3f} up {np.mean(a > 0):.0%} (n {len(a)}) | false median {b.median():+.3f} up {np.mean(b > 0):.0%} (n {len(b)}) | mean diff {d:+.3f} (HAC t {t:+.1f})')
        ev[name]['states'][k] = rec
    # Mayer multiple bands
    bands = [0, 0.8, 1.0, 1.2, 1.5, 2.0, 99]
    lab = ['<0.8', '0.8-1.0', '1.0-1.2', '1.2-1.5', '1.5-2.0', '>2.0']
    out.append('  -- price / 200-day average (Mayer multiple)')
    for half, m in (('early', ok & (s.index < '2019-01-01')), ('late', ok & (s.index >= '2019-01-01'))):
        b = pd.cut(mayer[m], bands, labels=lab)
        for l in lab:
            sel = b[b == l].index
            if len(sel) < 30:
                continue
            f90 = F[90].reindex(sel).dropna(); f180 = F[180].reindex(sel).dropna(); f30 = F[30].reindex(sel).dropna()
            ev[name]['mayerBands'].append({'half': half, 'band': l, 'days': int(len(sel)), 'median30': round(float(f30.median()), 4),
                                            'median90': round(float(f90.median()), 4), 'up90': round(float(np.mean(f90 > 0)), 3),
                                            'median180': round(float(f180.median()), 4), 'up180': round(float(np.mean(f180 > 0)), 3)})
            out.append(f'     {half} {l:8} days {len(sel):5} | 30d median {f30.median():+.3f} | 90d median {f90.median():+.3f} up {np.mean(f90 > 0):.0%} | 180d median {f180.median():+.3f} up {np.mean(f180 > 0):.0%}')
    # volatility-based expected range: EWMA daily variance, lambda 0.94
    r = L.diff()
    var = r.pow(2).ewm(alpha=0.06, adjust=False).mean().shift(0)
    sd1 = np.sqrt(var)
    out.append('  -- expected range calibration (EWMA 0.94; share of moves inside +-1sd / +-2sd of sqrt(h) x daily sd)')
    for half, m in (('early', ok & (s.index < '2019-01-01')), ('late', ok & (s.index >= '2019-01-01'))):
        for h in (7, 30):
            f = (L.shift(-h) - L)[m]; sd = (sd1 * np.sqrt(h))[m]
            z = (f / sd).dropna()
            in1, in2 = float(np.mean(np.abs(z) <= 1)), float(np.mean(np.abs(z) <= 2))
            ev[name]['range'][f'{half}{h}'] = {'in1sd': round(in1, 3), 'in2sd': round(in2, 3)}
            out.append(f'     {half} {h}d: inside 1sd {in1:.0%} (normal 68%), inside 2sd {in2:.0%} (95%)')
json.dump(ev, open('ma_evidence.json', 'w'), indent=1)
open('ma_research.txt', 'w').write('\n'.join(out))
print('\n'.join(out))

# empirical band multipliers: the |z| quantiles that make the EWMA range hold 68% / 95% of
# moves, per series and horizon, early / late; the module uses the late (2019-26) values
for name, s in SER.items():
    L = np.log(s); r = L.diff()
    sd1 = np.sqrt(r.pow(2).ewm(alpha=0.06, adjust=False).mean())
    ok = s.rolling(200).mean().notna()
    for half, m in (('early', ok & (s.index < '2019-01-01')), ('late', ok & (s.index >= '2019-01-01'))):
        for h in (7, 30):
            z = ((L.shift(-h) - L) / (sd1 * np.sqrt(h)))[m].dropna().abs()
            ev[name]['range'][f'{half}{h}']['k68'] = round(float(z.quantile(.68)), 3)
            ev[name]['range'][f'{half}{h}']['k95'] = round(float(z.quantile(.95)), 3)
json.dump(ev, open('ma_evidence.json', 'w'), indent=1)
print({n: ev[n]['range'] for n in ev})
