"""Binary flags, categories and market regime on the low-cap panel.

Flags: per anchor, mean outcome where flag=1 minus where flag=0 (both groups >= 5 coins), NW t over
anchors, halves. Categories: same, category vs the rest. Regime: anchor-level base rates by
tercile of BTC 90d momentum and alt breadth (this is timing, not selection).
"""
import os, sys, json
import numpy as np, pandas as pd
from analyze import nw_t, OUTCOMES
from common import RAW, OUT

pct = os.environ.get('LOWCAP_PCT', '0.4')
L = pd.read_parquet(os.path.join(RAW, f'lowcap_panel{int(float(pct)*100)}.parquet'))
L['date'] = pd.to_datetime(L.date)
FLAGS = ['dwf', 'binance_labs', 'top_vc', 'launchpool', 'made_in_america', 'upbit_krw', 'monitoring', 'has_perp']
cats = json.load(open(os.path.join(RAW, 'cmc_tags.json')))
L['cat'] = L.sym.map(lambda s: cats.get(s, 'other'))
for c in sorted(L.cat.unique()):
    L['cat_' + c] = (L.cat == c).astype(float)
# Recent Upbit KRW listing (0-30 days ago) and new perp (0-30 days) as event-state flags
L['upbit_recent'] = ((L.days_since_upbit >= 0) & (L.days_since_upbit <= 30)).astype(float).where(L.upbit_krw.notna())
L['perp_recent'] = ((L.days_since_perp >= 0) & (L.days_since_perp <= 30)).astype(float)
FLAGS += ['upbit_recent', 'perp_recent'] + ['cat_' + c for c in sorted(L.cat.unique())]
mid = L.date.min() + (L.date.max() - L.date.min()) / 2


def flag_test(flag, out):
    rows = []
    for d, g in L.groupby('date'):
        g = g[[flag, out]].dropna()
        a, b = g[out][g[flag] == 1], g[out][g[flag] == 0]
        if len(a) >= 5 and len(b) >= 5:
            rows.append((d, a.mean() - b.mean(), a.mean(), b.mean(), len(a)))
    return pd.DataFrame(rows, columns=['date', 'diff', 'yes', 'no', 'n_yes']).set_index('date')


res = []
for f in FLAGS:
    for out in OUTCOMES:
        x = flag_test(f, out)
        if len(x) < 15:
            continue
        t, n = nw_t(x['diff'])
        res.append(dict(flag=f, out=out, anchors=n, n_yes=x.n_yes.mean(), yes=x.yes.mean(), no=x.no.mean(),
                        diff=x['diff'].mean(), t=t, t_h1=nw_t(x['diff'][x.index < mid])[0], t_h2=nw_t(x['diff'][x.index >= mid])[0],
                        first=x.index.min().strftime('%Y-%m')))
T = pd.DataFrame(res)
from scipy.stats import norm
T['p'] = 2 * norm.sf(T.t.abs())
T = T.sort_values('p')
m = len(T)
T['holm'] = np.minimum(1, T.p * (m - np.arange(m))).cummax()
T.to_csv(os.path.join(OUT, f'flags_lowcap{int(float(pct)*100)}.csv'), index=False)
pd.set_option('display.width', 250)
for out in ('y2c', 'tp2', 'ret90', 'inflow3x'):
    print(f'\n=== {out}: flag=1 minus flag=0 ===')
    print(T[T.out == out].sort_values('t', key=abs, ascending=False)[['flag', 'anchors', 'first', 'n_yes', 'yes', 'no', 'diff', 't', 't_h1', 't_h2', 'holm']].round(4).to_string(index=False))

# Regime: anchor-level base rates
A = L.groupby('date').agg(y2c=('y2c', 'mean'), tp2=('tp2', 'mean'), ret90=('ret90', 'median'), btc=('btc_mom_90', 'first'),
                          breadth=('breadth_30', 'first'), alt=('alt_med_mom_90', 'first'), n=('y2c', 'size'))
print('\n=== regime (anchor-level): base rates by tercile ===')
for col in ('btc', 'breadth', 'alt'):
    A['q'] = pd.qcut(A[col], 3, labels=['low', 'mid', 'high'])
    print(col, A.groupby('q', observed=True)[['y2c', 'tp2', 'ret90']].mean().round(3).to_dict('index'))
    # Does this anchor's regime predict this anchor's spike rate? Spearman over anchors, NW on ranks.
    r = A[[col, 'y2c']].dropna().rank()
    z = (r[col] - r[col].mean()) * (r.y2c - r.y2c.mean()) / (r[col].std() * r.y2c.std())
    print('   rank corr', round(z.mean(), 3), 'NW t', round(nw_t(z.values)[0], 2))
A.to_csv(os.path.join(OUT, 'regime_anchor_rates.csv'))
