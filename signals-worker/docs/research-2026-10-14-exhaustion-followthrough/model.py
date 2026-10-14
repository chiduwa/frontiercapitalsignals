"""C. Combined: does everything known at the checkpoint predict "keeps rising"?

Target up20 = +20% from the checkpoint close before -20% (14 days). Gradient boosting fit on
one period, scored on the other (both directions); AUC, decile lift, permutation importance
on the held-out period. Then a depth-3 tree fit on discovery, printed as if-statements with
each leaf's held-out (validation) up-first rate, further peak and hours to it, so a rule
is only quoted with numbers from data it never saw.
"""
import sys
import numpy as np, pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.tree import DecisionTreeClassifier
from sklearn.metrics import roc_auc_score
from sklearn.inspection import permutation_importance
from common import load, pct

D = load()
D = D[D['first']].copy()
D['up20'] = (D.fp20 == 'up').astype(float).where(D.fp20.notna())
D['tier_n'] = D.tier.map({'thin': 0, 'mid': 1, 'major': 2})
D['young'] = D.young.astype(float)
D['e20'] = D.e20.astype(float)
ALERT = ['ratio', 'tradeRatio', 'barPct', 'volZ', 'run24Z', 'tier_n', 'e20', 'breadth24', 'pre24', 'pre7d', 'pre30d',
         'dist_hi30', 'dist_hi90', 'upper_wick', 'tb_alert', 'btc_pre24', 'btc_pre7d', 'mkt_pre7d', 'young']  # age_days is truncated at the data start (2022-11), so it means different things in each period
STATE = ['p_k', 'hi_k', 'dd_k', 'v_k', 'v_last_k', 'v_last3_k', 'v_decay_k', 'v_trend_k', 'tb_k', 'realert_k', 'green_k', 'mkt_k']
PERP = ['oi_k', 'fund_k', 'prem_k', 'prem_avg_k', 'gls_k', 'long_pct_k', 'tpl_k', 'taker_k', 'pvol_k', 'fund0', 'prem0', 'oi_pre24', 'oi_pre4', 'long_pct0',
        'sfuel15_10', 'lfuel15_10', 'sfuel15_20', 'short_basis', 'oi_built48', 'speak_10', 'lpeak_10']
out = []
for k in [int(x) for x in (sys.argv[1:] or ['0', '1', '4', '12', '24', '48'])]:
    X = D[(D.k == k) & D.up20.notna()]
    feats = ALERT + ([] if k == 0 else STATE) + [p for p in PERP if p in X and X[p].notna().mean() > 0.2 and not (k == 0 and p.endswith('_k') and p not in ('fund_k', 'prem_k'))]
    out.append(f'\n######## checkpoint +{k}h  features {len(feats)}')
    for tr, te in (('disc', 'val'), ('val', 'disc')):
        A, B = X[X.period == tr], X[X.period == te]
        m = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.04, max_leaf_nodes=15, min_samples_leaf=80,
                                           l2_regularization=1.0, random_state=0).fit(A[feats], A.up20)
        p = m.predict_proba(B[feats])[:, 1]
        auc = roc_auc_score(B.up20, p)
        dec = pd.qcut(p, 10, labels=False, duplicates='drop')
        Bq = B.assign(dec=dec)
        g = Bq.groupby('dec').agg(n=('up20', 'size'), up=('up20', 'mean'), pk=('fpeak', 'median'), h=('fpeak_h', 'median'), f72=('f72', 'median'))
        out.append(f'  fit {tr} -> score {te}: AUC {auc:.3f}  base up-first {B.up20.mean():.0%}  (n train {len(A)}, test {len(B)})')
        out.append('    deciles (low->high) up-first: ' + ' '.join(f'{x:.0%}' for x in g.up) )
        out.append('    deciles further peak median:  ' + ' '.join(pct(x) for x in g.pk))
        out.append('    deciles hours to peak median: ' + ' '.join(f'{x:.0f}' for x in g.h))
        out.append('    deciles 3d return median:     ' + ' '.join(pct(x) for x in g.f72))
        if tr == 'disc':
            pi = permutation_importance(m, B[feats], B.up20, scoring='roc_auc', n_repeats=5, random_state=0)
            imp = sorted(zip(feats, pi.importances_mean), key=lambda z: -z[1])[:10]
            out.append('    held-out importance (AUC drop): ' + ', '.join(f'{f} {v:.3f}' for f, v in imp))
    # interpretable tree on discovery, judged on validation
    A, B = X[X.period == 'disc'], X[X.period == 'val']
    tf = [f for f in feats if X[f].notna().mean() > 0.95]
    t = DecisionTreeClassifier(max_depth=3, min_samples_leaf=150, random_state=0).fit(A[tf].fillna(A[tf].median()), A.up20)
    la, lb = t.apply(A[tf].fillna(A[tf].median())), t.apply(B[tf].fillna(A[tf].median()))
    tree = t.tree_
    def path(node, conds, acc):
        if tree.children_left[node] == -1:
            acc.append((node, conds)); return
        f, th = tf[tree.feature[node]], tree.threshold[node]
        path(tree.children_left[node], conds + [f'{f} <= {th:.3g}'], acc)
        path(tree.children_right[node], conds + [f'{f} > {th:.3g}'], acc)
    leaves = []
    path(0, [], leaves)
    out.append(f'  depth-3 tree (fit 2025-26, numbers below are 2023-24 held-out | 2025-26 in-sample):')
    for node, conds in leaves:
        a, b = A[la == node], B[lb == node]
        out.append(f'    IF {" AND ".join(conds)}')
        out.append(f'       held-out n {len(b)}: up-first {b.up20.mean():.0%}, further peak median {pct(b.fpeak.median())} at {b.fpeak_h.median():.0f}h, 3d {pct(b.f72.median())}, 7d {pct(b.f168.median())}'
                   f'  | in-sample n {len(a)}: up-first {a.up20.mean():.0%}, peak {pct(a.fpeak.median())} at {a.fpeak_h.median():.0f}h')
print('\n'.join(out))
