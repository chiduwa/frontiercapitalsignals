"""Large-coin pull-aways against LARGE-coin random days (same half, regime, size band).

Large coins have outperformed the median coin since 2023 (alts bled), so judging them
against all random days credits size, not the pull-away. Control here = random days of
coins in the same liquidity band at that date. Difference in continuation = event minus
the control median, tested with day-clustered OLS on [event, control] stacked.
"""
import os
import numpy as np, pandas as pd
import statsmodels.api as sm

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, '../../reports/scenarios/2026-10-14-pullaways')
E = pd.read_parquet(os.path.join(RAW, 'events.parquet'))
C = pd.read_parquet(os.path.join(RAW, 'control.parquet'))
for X in (E, C):
    X['half'] = np.where(X.date < '2023-01-01', '2019-22', '2023-26')
    X['regime'] = np.where(X.btc_bull == True, 'bull', np.where(X.btc_bull == False, 'bear', None))
    X['band'] = pd.cut(X.liq, [0, 5e6, 20e6, 1e13], labels=['<$5M', '$5-20M', '>=$20M'])
P = E[E.side == 1].copy()
q_spk = P[P.half == '2019-22'].spike_share.median(); q_rel = P[P.half == '2019-22'].rel3.median(); q_vol = P[P.half == '2019-22'].vol_rel.median()
P['trxlike'] = (P.spike_share < q_spk) & (P.rel3 < q_rel)
P['heavy'] = (P.vol_rel >= q_vol) & (P.rel3 >= q_rel)
pct = lambda x: f'{100 * x:+.1f}%' if x == x else '  n/a'


def test(ev, ct, h):
    y = np.r_[ev[f'R{h}'].values, ct[f'R{h}'].values]
    x = np.r_[np.ones(len(ev)), np.zeros(len(ct))]
    g = np.r_[ev.date.values, ct.date.values]
    df = pd.DataFrame({'y': y, 'x': x, 'g': g}).dropna()
    if df.x.sum() < 15:
        return np.nan, np.nan
    r = sm.OLS(df.y, sm.add_constant(df.x)).fit(cov_type='cluster', cov_kwds={'groups': pd.factorize(df.g)[0]})
    return r.params['x'], r.tvalues['x']


out = []
for band in ('>=$20M', '$5-20M', '<$5M'):
    out.append(f'\n-- pulling ahead, coins with {band}/day median volume at the onset')
    for sub, m in (('all', P.side == 1), ('steady + moderate', P.trxlike), ('heavy volume + big move', P.heavy)):
        for half in ('2019-22', '2023-26'):
            for reg in ('bull', 'bear'):
                ev = P[m & (P.band == band) & (P.half == half) & (P.regime == reg)]
                ct = C[(C.band == band) & (C.half == half) & (C.regime == reg)]
                if len(ev) < 20:
                    continue
                parts = []
                for h in (7, 30, 90):
                    d, t = test(ev, ct, h)
                    parts.append(f'{h}d {pct(ev[f"R{h}"].median())} vs {pct(ct[f"R{h}"].median())} ahead {np.mean(ev[f"R{h}"].dropna() > 0):.0%}/{np.mean(ct[f"R{h}"].dropna() > 0):.0%} mean diff {pct(d)} (t {t:+.1f})')
                out.append(f'  {sub:24} {half} {reg:4} n {len(ev):4} | ' + ' | '.join(parts))
print('\n'.join(out))
