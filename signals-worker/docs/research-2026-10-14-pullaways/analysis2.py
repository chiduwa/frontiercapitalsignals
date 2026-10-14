"""Pull-aways judged against random days in the same regime and half; profiles; TRX.

Random liquid coin-days have a mean relative return that is not zero (the market is a
median and returns are skewed), so every comparison here is event vs control in the same
half and regime: median continuation and the share that kept going, where for the control
"kept going" means a relative move in the same direction as the event side.
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
pct = lambda x: f'{100 * x:+.1f}%' if x == x else '  n/a'
HS = (7, 30, 90)


def vs_control(X, side, half, regime, label):
    Y = C[(C.half == half) & (C.regime == regime)] if half != 'all' else C[(C.regime == regime) if regime != 'any' else True]
    parts = []
    for h in HS:
        ev = side * X[f'R{h}'].dropna(); ct = side * Y[f'R{h}'].dropna()
        # Mann-Whitney style: share of event > control median, and medians
        parts.append(f'{h}d med {pct(ev.median())} vs {pct(ct.median())}, kept going {np.mean(ev > 0):.0%} vs {np.mean(ct > 0):.0%}')
    return f'  {label:44} n {len(X):5} | ' + ' | '.join(parts)


out = ['== A2. Events vs random days in the same half and regime (continuation in the event direction)']
for side, nm in ((1, 'PULLING AHEAD'), (-1, 'FALLING BEHIND')):
    out.append(f'\n-- {nm}')
    for half in ('2019-22', '2023-26'):
        for reg in ('bull', 'bear'):
            X = E[(E.side == side) & (E.half == half) & (E.regime == reg)]
            out.append(vs_control(X, side, half, reg, f'{half} {reg}'))

# B2. profiles
E['large'] = E.liq >= 20e6
q_vol = E[E.half == '2019-22'].vol_rel.median(); q_spk = E[E.half == '2019-22'].spike_share.median(); q_rel = E[E.half == '2019-22'].rel3.median()
out.append(f'\n== B2. Profiles (pulling ahead). Large = 30-day median volume >= $20M/day. Low volume = own-vs-market surge below the 2019-22 median ({q_vol:.2f}); '
           f'steady = biggest day under {q_spk:.0%} of the move; moderate = 3-day lead under {q_rel:.0%}')
P = E[E.side == 1]
prof = {
    'large coin': P.large,
    'small coin': ~P.large,
    'large + low volume surge': P.large & (P.vol_rel < q_vol),
    'large + steady + moderate (TRX-like)': P.large & (P.spike_share < q_spk) & (P.rel3 < q_rel),
    'small + heavy volume + big move': ~P.large & (P.vol_rel >= q_vol) & (P.rel3 >= q_rel),
    'pulled ahead while the market fell 5%+': P.mkt3 <= -0.05,
    'pulled ahead while the market rose 5%+': P.mkt3 >= 0.05,
}
for name, m in prof.items():
    for half in ('2019-22', '2023-26'):
        for reg in ('bull', 'bear'):
            X = P[m & (P.half == half) & (P.regime == reg)]
            if len(X) >= 25:
                out.append(vs_control(X, 1, half, reg, f'{name} | {half} {reg}'))
# how long, for the profiles that last vs fade: retention of the onset lead
out.append('\n== C. How long the lead lasts (pulling ahead): share that has given back half / all of the onset lead by day d')
for name, m in (('all', P.side == 1), ('large + steady + moderate (TRX-like)', prof['large + steady + moderate (TRX-like)']),
                ('small + heavy volume + big move', prof['small + heavy volume + big move'])):
    for reg in ('bull', 'bear'):
        X = P[m & (P.regime == reg)].dropna(subset=['peak_day'])
        if len(X) < 25:
            continue
        hb = [np.mean(X.half_day <= d) for d in (3, 7, 14, 30, 60, 90)]
        zb = [np.mean(X.zero_day <= d) for d in (3, 7, 14, 30, 60, 90)]
        out.append(f'  {name:40} {reg:4} n {len(X):5}  half back by 3/7/14/30/60/90d: ' + ' '.join(f'{x:.0%}' for x in hb)
                   + '  | all back: ' + ' '.join(f'{x:.0%}' for x in zb) + f'  | median peak day {X.peak_day.median():.0f}')
# D. TRX against its own ordinary days
out.append('\n== D. TRX: its pull-aheads vs its own random days')
T = E[(E.sym == 'TRXUSDT') & (E.side == 1)]; TC = C[C.sym == 'TRXUSDT']
for h in HS:
    out.append(f'  {h}d: TRX after pull-aheads median {pct(T[f"R{h}"].median())} ahead in {np.mean(T[f"R{h}"].dropna() > 0):.0%} (n {T[f"R{h}"].notna().sum()}) | '
               f'TRX on random days median {pct(TC[f"R{h}"].median())} ahead in {np.mean(TC[f"R{h}"].dropna() > 0):.0%} (n {TC[f"R{h}"].notna().sum()})')
for half in ('2019-22', '2023-26'):
    TT, TTC = T[T.half == half], TC[TC.half == half]
    out.append(f'  {half}: 30d after pull-aheads median {pct(TT.R30.median())} (n {len(TT)}) vs random days {pct(TTC.R30.median())} (n {len(TTC)}); '
               f'share of TRX pull-aheads with the market down 5%+ over the 3 days: {np.mean(TT.mkt3 <= -0.05):.0%}; TRX beta median {TT.beta.median():.2f}')
print('\n'.join(out))
