"""Walk-forward combined model on the low-cap panel.

Each test anchor t (2021-01 onward) is scored by a model fitted only on anchors whose 90-day
outcome window had closed (date <= t - 91d). Continuous features enter as within-anchor rank
percentiles; flags as 0/1; regime as raw values. Models: L2 logistic (y2c, inflow3x) and ridge (tp2),
plus a shallow gradient-boosted classifier. Baselines: volatility rank only, illiquidity rank only.

Per test anchor: within-anchor AUC, top-K hit rate minus anchor base, top-K mean tp2/ret90 minus the
anchor's equal-weight mean. NW t across anchors; halves 2021-23 vs 2024-26. Costs: a round trip of
COST (default 0.6%) is charged to every pick's tp2/ret90.
"""
import os, json, warnings
import numpy as np, pandas as pd
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score
from analyze import nw_t
from common import RAW, OUT

warnings.filterwarnings('ignore')
pct = float(os.environ.get('LOWCAP_PCT', '0.4'))
K = int(os.environ.get('TOPK', '10'))
COST = float(os.environ.get('COST', '0.006'))
L = pd.read_parquet(os.path.join(RAW, f'lowcap_panel{int(pct*100)}.parquet'))
L['date'] = pd.to_datetime(L.date)
cats = json.load(open(os.path.join(RAW, 'cmc_tags.json')))
L['cat'] = L.sym.map(lambda s: cats.get(s, 'other'))

CONT = ['log_mcap', 'log_price', 'age', 'mom_7', 'mom_30', 'mom_90', 'mom_180', 'vol_30', 'vol_ratio', 'range_30',
        'max_ret_30', 'max_ret_90', 'dd_365', 'dd_ath', 'up_from_low_365', 'days_since_low', 'log_qv30',
        'vol_surge_7_90', 'vol_surge_30_90', 'turnover_30', 'amihud_30', 'taker_buy_7', 'taker_buy_chg',
        'trades_surge', 'avg_trade_usd', 'supply_growth_90', 'log_lambda', 'net_flow_7', 'net_flow_30', 'cat_mom_30',
        'prior_spikes']
FLAG = ['dwf', 'top_vc', 'binance_labs', 'launchpool', 'made_in_america', 'has_perp', 'monitoring', 'upbit_krw']
CATS = ['meme', 'ai', 'gaming', 'fan_token', 'privacy', 'defi', 'l1_l2', 'rwa', 'depin']
REG = ['breadth_30', 'btc_mom_90', 'alt_med_mom_90']

X = pd.DataFrame(index=L.index)
for c in CONT:
    X[c] = L.groupby('date')[c].rank(pct=True).fillna(0.5)
for c in FLAG:
    X[c] = L[c].fillna(0.0)
for c in CATS:
    X['cat_' + c] = (L.cat == c).astype(float)
for c in REG:
    X[c] = L[c].fillna(L[c].median())
FEATS = list(X.columns)

dates = sorted(L.date.unique())
test_dates = [d for d in dates if d >= pd.Timestamp('2021-01-01')]


def fit_predict(target, kind, cols):
    preds = pd.Series(np.nan, index=L.index)
    for d in test_dates:
        tr = (L.date <= d - pd.Timedelta(days=91)) & L[target].notna()
        te = L.date == d
        if tr.sum() < 2000 or te.sum() < 20:
            continue
        Xtr, ytr, Xte = X.loc[tr, cols].values, L.loc[tr, target].values, X.loc[te, cols].values
        if kind == 'logit':
            m = LogisticRegression(C=0.05, max_iter=2000).fit(Xtr, ytr)
            preds[te] = m.predict_proba(Xte)[:, 1]
        elif kind == 'ridge':
            m = Ridge(alpha=50.0).fit(Xtr, ytr)
            preds[te] = m.predict(Xte)
        elif kind == 'gbm':
            m = HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=150, min_samples_leaf=200,
                                               l2_regularization=1.0).fit(Xtr, ytr)
            preds[te] = m.predict_proba(Xte)[:, 1]
    return preds


def evaluate(score, name):
    rows = []
    for d in test_dates:
        g = L[L.date == d].assign(s=score[L.date == d]).dropna(subset=['s'])
        if len(g) < 20:
            continue
        top = g.nlargest(K, 's')
        r = dict(date=d, n=len(g))
        for out in ('y2c', 'inflow3x'):
            gg = g.dropna(subset=[out])
            if gg[out].nunique() == 2:
                r[f'auc_{out}'] = roc_auc_score(gg[out], gg.s)
            r[f'hit_{out}'] = top[out].mean() - g[out].mean()
            r[f'top_{out}'] = top[out].mean()
            r[f'base_{out}'] = g[out].mean()
        for out in ('tp2', 'ret90'):
            r[f'x_{out}'] = top[out].mean() - g[out].mean()
            r[f'top_{out}_net'] = top[out].mean() - COST
            r[f'all_{out}_net'] = g[out].mean() - COST
        rows.append(r)
    R = pd.DataFrame(rows).set_index('date')
    h1, h2 = R.index < pd.Timestamp('2024-01-01'), R.index >= pd.Timestamp('2024-01-01')
    out = {'model': name, 'anchors': len(R)}
    for c in ('auc_y2c', 'hit_y2c', 'top_y2c', 'base_y2c', 'auc_inflow3x', 'hit_inflow3x', 'x_tp2', 'top_tp2_net', 'all_tp2_net', 'x_ret90', 'top_ret90_net'):
        v = R[c] - 0.5 if c.startswith('auc') else R[c]
        out[c] = R[c].mean()
        if c.startswith(('auc', 'hit', 'x_')):
            out[c + '_t'] = nw_t(v.values)[0]
            out[c + '_h1'] = R[c][h1].mean()
            out[c + '_h2'] = R[c][h2].mean()
    return out, R


if __name__ == '__main__':
    res, keep = [], {}
    specs = [
        ('logit_all_y2c', 'y2c', 'logit', FEATS),
        ('gbm_all_y2c', 'y2c', 'gbm', FEATS),
        ('ridge_all_tp2', 'tp2', 'ridge', FEATS),
        ('logit_all_inflow', 'inflow3x', 'logit', FEATS),
        ('logit_noregime_y2c', 'y2c', 'logit', [f for f in FEATS if f not in REG]),
    ]
    for name, target, kind, cols in specs:
        p = fit_predict(target, kind, cols)
        keep[name] = p
        o, R = evaluate(p, name)
        res.append(o)
        R.to_csv(os.path.join(OUT, f'wf_{name}_lowcap{int(pct*100)}.csv'))
        print(name, 'done', flush=True)
    for name, col, sign in (('vol_only', 'vol_30', 1), ('illiq_only', 'amihud_30', 1), ('small_only', 'log_mcap', -1),
                            ('volsurge_only', 'vol_surge_7_90', 1)):
        o, R = evaluate(sign * X[col], name)
        res.append(o)
    T = pd.DataFrame(res)
    pd.set_option('display.width', 300)
    pd.set_option('display.max_columns', 60)
    T.to_csv(os.path.join(OUT, f'walkforward_lowcap{int(pct*100)}_k{K}.csv'), index=False)
    cols = ['model', 'anchors', 'auc_y2c', 'auc_y2c_t', 'auc_y2c_h1', 'auc_y2c_h2', 'top_y2c', 'base_y2c', 'hit_y2c_t',
            'auc_inflow3x', 'auc_inflow3x_t', 'x_tp2', 'x_tp2_t', 'x_tp2_h1', 'x_tp2_h2', 'top_tp2_net', 'all_tp2_net',
            'x_ret90', 'x_ret90_t', 'top_ret90_net']
    print(T[cols].round(3).to_string(index=False))
    pd.DataFrame(keep).assign(date=L.date, sym=L.sym).to_parquet(os.path.join(RAW, f'wf_scores_lowcap{int(pct*100)}.parquet'))
    # Final fit on everything with a closed window, for the live ranking.
    tr = L.date <= L.date.max() - pd.Timedelta(days=0)
    m = LogisticRegression(C=0.05, max_iter=2000).fit(X.loc[L.y2c.notna(), FEATS].values, L.loc[L.y2c.notna(), 'y2c'].values)
    coef = pd.Series(m.coef_[0], index=FEATS).sort_values()
    print('\nfull-sample logit coefficients (y2c), rank-percentile scale:')
    print(coef.round(3).to_string())
