"""Walk-forward check of the PRODUCTION configuration before it ships (lowcap-watch-v1).

Production can compute every day: Binance kline features, CMC market cap and 90-day supply growth,
whether a USD-M perp exists, Upbit KRW status, Binance monitoring tag. It drops the static CMC tags
(DWF/VC/categories) and the regime inputs (constant within a day, so they never change a rank).
The gradient-boosted model is made deterministic (early_stopping=False, random_state=0).
Run with the CI-pinned libraries (numpy 2.4.6, pandas 3.0.6, scikit-learn 1.9.1).
"""
import os, sys, json, warnings
import numpy as np, pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score
from analyze import nw_t
from common import RAW, OUT

warnings.filterwarnings('ignore')
COST = 0.006
PROD_CONT = ['log_mcap', 'log_price', 'age', 'mom_7', 'mom_30', 'mom_90', 'mom_180', 'vol_30', 'vol_ratio', 'range_30',
             'max_ret_30', 'max_ret_90', 'dd_365', 'dd_ath', 'up_from_low_365', 'days_since_low', 'log_qv30',
             'vol_surge_7_90', 'vol_surge_30_90', 'turnover_30', 'amihud_30', 'taker_buy_7', 'taker_buy_chg',
             'trades_surge', 'avg_trade_usd', 'supply_growth_90', 'log_lambda', 'net_flow_7', 'net_flow_30', 'prior_spikes']
PROD_FLAG = ['has_perp', 'monitoring', 'upbit_krw']

L = pd.read_parquet(os.path.join(RAW, 'lowcap_panel40.parquet'))
L['date'] = pd.to_datetime(L.date)
X = pd.DataFrame(index=L.index)
for c in PROD_CONT:
    X[c] = L.groupby('date')[c].rank(pct=True).fillna(0.5)
for c in PROD_FLAG:
    X[c] = L[c].fillna(0.0)
FEATS = list(X.columns)
dates = sorted(L.date.unique())
test_dates = [d for d in dates if d >= pd.Timestamp('2021-01-01')]


def gbm():
    return HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=150, min_samples_leaf=200,
                                          l2_regularization=1.0, early_stopping=False, random_state=0)


def walk(target, make):
    preds = pd.Series(np.nan, index=L.index)
    for d in test_dates:
        tr = (L.date <= d - pd.Timedelta(days=91)) & L[target].notna()
        te = L.date == d
        if tr.sum() < 2000 or te.sum() < 20:
            continue
        m = make().fit(X.loc[tr, FEATS].values, L.loc[tr, target].values)
        preds[te] = m.predict_proba(X.loc[te, FEATS].values)[:, 1]
    return preds


def report(score, name, target):
    rows = []
    for d, g in L.assign(s=score).dropna(subset=['s']).groupby('date'):
        if len(g) < 20:
            continue
        top = g.nlargest(10, 's')
        gg = g.dropna(subset=[target])
        rows.append(dict(date=d, auc=roc_auc_score(gg[target], gg.s) if gg[target].nunique() == 2 else np.nan,
                         top=top[target].mean(), base=g[target].mean(),
                         x_tp2=top.tp2.mean() - g.tp2.mean(), top_tp2_net=top.tp2.mean() - COST))
    R = pd.DataFrame(rows).set_index('date')
    out = dict(model=name, target=target, anchors=len(R), first=R.index.min().date().isoformat(), last=R.index.max().date().isoformat(),
               auc=R.auc.mean(), auc_t=nw_t((R.auc - 0.5).values)[0], top10=R.top.mean(), base=R.base.mean(),
               hit_t=nw_t((R.top - R.base).values)[0], x_tp2=R.x_tp2.mean(), x_tp2_t=nw_t(R.x_tp2.values)[0],
               top_tp2_net=R.top_tp2_net.mean())
    by = R.groupby(R.index.year).agg(n=('top', 'size'), top10=('top', 'mean'), base=('base', 'mean'), auc=('auc', 'mean'), x_tp2=('x_tp2', 'mean'))
    return out, by


res = {}
for name, target, make in (('inflow_logit_prod', 'inflow3x', lambda: LogisticRegression(C=0.05, max_iter=2000)),
                           ('spike_gbm_prod', 'y2c', gbm)):
    p = walk(target, make)
    o, by = report(p, name, target)
    res[name] = {**o, 'by_year': {int(k): {kk: round(float(vv), 4) for kk, vv in v.items()} for k, v in by.to_dict('index').items()}}
    print(json.dumps(o, default=float, indent=None))
    print(by.round(3).to_string())
    L[name] = p
json.dump(res, open(os.path.join(OUT, 'prod_validation.json'), 'w'), indent=1, default=float)
L[['date', 'sym', 'inflow_logit_prod', 'spike_gbm_prod']].to_parquet(os.path.join(RAW, 'prod_wf_scores.parquet'))
