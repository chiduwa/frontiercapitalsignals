"""Exit rules on daily close paths for low-cap baskets (2021-01 .. latest complete anchor).

Selections per anchor: all low caps (equal weight), walk-forward GBM top-K, illiquidity top-K,
GBM top-K excluding monitoring-tag / fan tokens. Exit: first daily close >= entry*(1+TP), else the close
at day HOLD (or the last Binance close if delisted first). Optional regime gate: buy only when
breadth_30 (share of Binance alts up over 30d) >= 0.5 - a fixed, a-priori threshold.
Every variant is printed (no picking the best one silently). Cost: 0.6% round trip per trade.
"""
import os, json
import numpy as np, pandas as pd
from analyze import nw_t
from common import RAW, OUT

pct = float(os.environ.get('LOWCAP_PCT', '0.4'))
K = 10
COST = 0.006
L = pd.read_parquet(os.path.join(RAW, f'lowcap_panel{int(pct*100)}.parquet'))
L['date'] = pd.to_datetime(L.date)
S = pd.read_parquet(os.path.join(RAW, f'wf_scores_lowcap{int(pct*100)}.parquet'))
S['date'] = pd.to_datetime(S.date)
L = L.merge(S[['date', 'sym', 'gbm_all_y2c']].rename(columns={'gbm_all_y2c': 'gbm'}), on=['date', 'sym'], how='left')
cats = json.load(open(os.path.join(RAW, 'cmc_tags.json')))
L['cat'] = L.sym.map(lambda s: cats.get(s, 'other'))
D = pd.read_parquet(os.path.join(RAW, 'daily_features.parquet'), columns=['date', 'asset', 'close', 'is_live_seg'])
D['date'] = pd.to_datetime(D.date)
paths = {a: g.set_index('date').close for a, g in D.groupby('asset')}
live = D.groupby('asset').is_live_seg.last()


def trade(asset, d, tp, hold):
    c = paths[asset]
    p0 = c.get(d)
    fut = c.loc[d + pd.Timedelta(days=1): d + pd.Timedelta(days=hold)]
    if p0 is None or fut.empty:
        return np.nan
    if live.get(asset, True) and (d + pd.Timedelta(days=hold)) > c.index[-1]:
        return np.nan  # window not finished yet
    if tp is not None:
        hit = fut[fut >= p0 * (1 + tp)]
        if len(hit):
            return hit.iloc[0] / p0 - 1 - COST
    return fut.iloc[-1] / p0 - 1 - COST


sels = {
    'all_lowcaps': lambda g: g,
    'gbm_top10': lambda g: g.nlargest(K, 'gbm'),
    'gbm_top10_clean': lambda g: g[(g.monitoring.fillna(0) == 0) & (g.cat != 'fan_token')].nlargest(K, 'gbm'),
    'illiq_top10': lambda g: g.nlargest(K, 'amihud_30'),
}
anchors = sorted(d for d in L.date.unique() if d >= pd.Timestamp('2021-01-01'))
rows = []
for d in anchors:
    g = L[(L.date == d)].dropna(subset=['gbm'])
    if len(g) < 20:
        continue
    br = g.breadth_30.iloc[0]
    for sname, f in sels.items():
        picks = f(g)
        for tp in (0.3, 0.5, 1.0, 2.0, None):
            for hold in (30, 90):
                r = [trade(a, d, tp, hold) for a in picks.asset]
                r = [x for x in r if np.isfinite(x)]
                if len(r) < max(3, len(picks) // 2):
                    continue
                rows.append(dict(date=d, sel=sname, tp=tp if tp else 'none', hold=hold, ret=np.mean(r), med=np.median(r),
                                 win=np.mean([x > 0 for x in r]), breadth=br, n=len(r)))
R = pd.DataFrame(rows)
R.to_csv(os.path.join(OUT, f'strategy_lowcap{int(pct*100)}.csv'), index=False)

out = []
for (sname, tp, hold), g in R.groupby(['sel', 'tp', 'hold']):
    g = g.set_index('date').sort_index()
    base = R[(R.sel == 'all_lowcaps') & (R.tp == tp) & (R.hold == hold)].set_index('date').ret
    ex = (g.ret - base.reindex(g.index)).dropna()
    lag = 7 if hold == 90 else 2
    gate = g[g.breadth >= 0.5]
    out.append(dict(sel=sname, tp=tp, hold=hold, anchors=len(g), mean=g.ret.mean(), t=nw_t(g.ret.values, lag)[0],
                    median_trade=g.med.median(), win=g.win.mean(), h1=g.ret[g.index < '2024-01-01'].mean(),
                    h2=g.ret[g.index >= '2024-01-01'].mean(), excess=ex.mean(), excess_t=nw_t(ex.values, lag)[0],
                    gated_anchors=len(gate), gated_mean=gate.ret.mean(), gated_t=nw_t(gate.ret.values, lag)[0],
                    ungated_mean=g[g.breadth < 0.5].ret.mean()))
T = pd.DataFrame(out)
pd.set_option('display.width', 250)
print(f'Per-anchor basket return per trade, net of {COST:.1%} round trip; NW t; breadth gate = buy only when >=50% of alts are up over 30d')
print(T.round(3).to_string(index=False))
T.to_csv(os.path.join(OUT, f'strategy_summary_lowcap{int(pct*100)}.csv'), index=False)
