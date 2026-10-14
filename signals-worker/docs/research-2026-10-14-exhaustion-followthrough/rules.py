"""B. Single-variable "if" tests at each checkpoint, forward from the checkpoint close.

For each checkpoint k and state variable: quintiles cut on discovery, applied unchanged to
validation. Per bucket: P(+20% before -20%), median further peak in 14d, median hours to it,
median 3d return, mean 3d log return vs market. Effect = top quintile minus bottom quintile,
cluster-robust t by alert day, in BOTH periods. A variable "survives" when both periods agree
in sign with |t| >= 2 on the market-relative 3d return or on the up-first rate.
Sample: episode-first alerts (no pushed alert on the coin in the prior 72h), so a run that
alerts five times counts once; re-alerts after the first are themselves a state variable.
"""
import os, sys
import numpy as np, pandas as pd
from common import load, cmean, cdiff, pct

SAMPLE = sys.argv[1] if len(sys.argv) > 1 else 'first'
KS = [int(x) for x in sys.argv[2].split(',')] if len(sys.argv) > 2 else [1, 2, 4, 8, 12, 24, 48, 72]
VARS = sys.argv[3].split(',') if len(sys.argv) > 3 else None
D = load()
if SAMPLE == 'first':
    D = D[D['first']]
D['up20'] = (D.fp20 == 'up').astype(float).where(D.fp20.notna())
D['lfpeak'] = np.log1p(D.fpeak)
STATE = ['p_k', 'hi_k', 'dd_k', 'v_k', 'v_last_k', 'v_last3_k', 'v_decay_k', 'v_trend_k', 'tb_k', 'realert_k', 'green_k', 'mkt_k',
         'oi_k', 'fund_k', 'prem_k', 'prem_avg_k', 'gls_k', 'long_pct_k', 'tpl_k', 'taker_k', 'pvol_k']
lines, summ = [], []
for k in KS:
    X = D[D.k == k]
    lines.append(f'\n######## checkpoint +{k}h  (disc n {int((X.period == "disc").sum())}, val n {int((X.period == "val").sum())})')
    base = {}
    for per in ('disc', 'val'):
        Y = X[X.period == per]
        m, t, n = cmean(Y.x72, Y.day)
        base[per] = Y.up20.mean()
        lines.append(f'  base {per}: up-first {Y.up20.mean():.0%}, median further peak {pct(Y.fpeak.median())} at {Y.fpeak_h.median():.0f}h, '
                     f'median 3d {pct(Y.f72.median())}, mean 3d log vs mkt {m:+.3f} (t {t:+.1f})')
    for v in (VARS or STATE):
        if v not in X or X[v].notna().sum() < 300:
            continue
        Xd = X[X.period == 'disc']
        vals = Xd[v].dropna()
        if vals.nunique() < 3:
            continue
        if v == 'realert_k':
            cuts = [-0.5, 0.5, 1.5, np.inf]; labs = ['0', '1', '2+']
        else:
            q = np.unique(np.quantile(vals, [0, .2, .4, .6, .8, 1]))
            cuts = np.r_[-np.inf, q[1:-1], np.inf]; labs = [f'Q{i + 1}' for i in range(len(cuts) - 1)]
        lines.append(f'  -- {v}  cuts ' + ', '.join(f'{c:.3g}' for c in cuts[1:-1]))
        res = {}
        for per in ('disc', 'val'):
            Y = X[(X.period == per) & X[v].notna()].copy()
            if len(Y) < 100:
                continue
            Y['b'] = pd.cut(Y[v], cuts, labels=labs)
            row = []
            for b in labs:
                Z = Y[Y.b == b]
                if len(Z) < 15:
                    row.append(f'{b}: n{len(Z)}'); continue
                m, t, n = cmean(Z.x72, Z.day)
                row.append(f'{b}: n{len(Z)} up {Z.up20.mean():.0%} pk {pct(Z.fpeak.median())}@{Z.fpeak_h.median():.0f}h 3d {pct(Z.f72.median())} xm {m:+.3f}')
            lines.append(f'     {per}: ' + ' | '.join(row))
            hi_, lo_ = labs[-1], labs[0]
            S = Y[Y.b.isin([hi_, lo_])]
            dx, tx = cdiff(S.x72, (S.b == hi_).astype(float), S.day)
            du, tu = cdiff(S.up20, (S.b == hi_).astype(float), S.day)
            dp, tp = cdiff(S.lfpeak, (S.b == hi_).astype(float), S.day)
            res[per] = (dx, tx, du, tu, dp, tp)
            lines.append(f'        top-bottom: 3d vs mkt {dx:+.3f} (t {tx:+.1f}); up-first {du:+.2f} (t {tu:+.1f}); log further peak {dp:+.3f} (t {tp:+.1f})')
        if len(res) == 2:
            a, b = res['disc'], res['val']
            ok_x = np.sign(a[0]) == np.sign(b[0]) and abs(a[1]) >= 2 and abs(b[1]) >= 2
            ok_u = np.sign(a[2]) == np.sign(b[2]) and abs(a[3]) >= 2 and abs(b[3]) >= 2
            ok_p = np.sign(a[4]) == np.sign(b[4]) and abs(a[5]) >= 2 and abs(b[5]) >= 2
            summ.append((k, v, a[0], a[1], b[0], b[1], a[2], a[3], b[2], b[3], a[4], a[5], b[4], b[5], ok_x, ok_u, ok_p))
S = pd.DataFrame(summ, columns=['k', 'var', 'dx_d', 't_d', 'dx_v', 't_v', 'du_d', 'tu_d', 'du_v', 'tu_v', 'dp_d', 'tp_d', 'dp_v', 'tp_v', 'ok_3d', 'ok_up', 'ok_peak'])
tag = SAMPLE + ('' if VARS is None else '_' + os.environ.get('TAG', 'alert'))
S.to_csv(f'rules_summary_{tag}.csv', index=False)
open(f'rules_{tag}.txt', 'w').write('\n'.join(lines))
pd.set_option('display.width', 250); pd.set_option('display.max_rows', 400)
print(S[S.ok_3d | S.ok_up | S.ok_peak].round(3).to_string())
