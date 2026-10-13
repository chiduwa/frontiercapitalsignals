"""Live ranking of Binance low caps as of the last day with a CMC market cap.

Validated parts (walk-forward 2021-26): GBM P(close doubles within 90d) - modest skill (top-10 hit
15.8% vs 11.0% base); logit P(30d volume triples) - strong skill (AUC 0.67). Both are refit on every
anchor whose window has closed and applied to today's cross-section.
Overlays (not validated, or validated only as warnings): order-book cost to lift price, monitoring tag,
Upbit warning/caution, Korean listing optionality, dilution, backers, watchers, Santiment social.
Output: results/ranking_YYYY-MM-DD.csv
"""
import os, json
import numpy as np, pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingClassifier
from common import RAW, OUT, load
import analyze

F, P = analyze.load_panel()
R = analyze.regime(F, P)
P = P.join(R, on='date')
asof = F[F.mcap.notna()].date.max()
# Today's cross-section: the last daily row (not an anchor) per live segment.
D = F[(F.date == asof) & F.is_live_seg & F.mcap.notna() & (F.age >= 120)].copy()
# Re-derive the anchor-only columns for the live day.
D['mcap_pct'] = D.mcap.rank(pct=True)
r_now = analyze.regime(F, D.assign(date=asof))
for c in r_now.columns:
    D[c] = r_now[c].iloc[0]
cats = json.load(open(os.path.join(RAW, 'cmc_tags.json')))
D['cat'] = D.sym.map(lambda s: cats.get(s, 'other'))
g = D.groupby('cat').mom_30
D['cat_mom_30'] = (g.transform('sum') - D.mom_30.fillna(0)) / (g.transform('count') - 1).replace(0, np.nan)
D = analyze.add_extras(D)
D['monitoring'] = D.sym.isin({p['s'] for p in load('bapi_products.json') if 'Monitoring' in (p.get('tags') or [])}).astype(float)
LOW = D[D.mcap_pct <= 0.4].copy()

# Training panel = closed low-cap anchors (same features as model.py)
import model as M  # builds X/L for pct=0.4 on import
TR = M.L
Xtr = M.X
FEATS = M.FEATS


def design(df):
    X = pd.DataFrame(index=df.index)
    for c in M.CONT:
        X[c] = df[c].rank(pct=True).fillna(0.5) if c in df else 0.5
    for c in M.FLAG:
        X[c] = df[c].fillna(0.0) if c in df else 0.0
    for c in M.CATS:
        X['cat_' + c] = (df.cat == c).astype(float)
    for c in M.REG:
        X[c] = df[c].fillna(TR[c].median())
    return X[FEATS]


ok = TR.y2c.notna()
gbm = HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=150, min_samples_leaf=200,
                                     l2_regularization=1.0).fit(Xtr.loc[ok].values, TR.loc[ok, 'y2c'].values)
oki = TR.inflow3x.notna()
inflow = LogisticRegression(C=0.05, max_iter=2000).fit(Xtr.loc[oki].values, TR.loc[oki, 'inflow3x'].values)
XL = design(LOW)
LOW['p_double_90d'] = gbm.predict_proba(XL.values)[:, 1]
LOW['p_inflow_30d'] = inflow.predict_proba(XL.values)[:, 1]
LOW['p_double_rank'] = LOW.p_double_90d.rank(pct=True)

# Overlays
depth = load('snap_depth.json')
snapc = {int(k): v for k, v in load('snap_cmc.json').items() if v}
cg = load('snap_cg.json').get('coins', {})
up = load('upbit_by_base.json')
bith = set(load('bithumb_krw.json'))
um = load('upbit_markets.json')
upbit_flag = {}
for x in um:
    ev = x.get('market_event') or {}
    if ev.get('warning') or any((ev.get('caution') or {}).values()):
        upbit_flag[x['market'].split('-')[1]] = 'warning' if ev.get('warning') else 'caution'
flags = load('cmc_flags.json')
prod = {p['s']: p for p in load('bapi_products.json')}


def ov(row):
    s, base = row.sym, prod.get(row.sym, {}).get('b', row.sym[:-4])
    d = depth.get(s) or {}
    c = snapc.get(int(row.cmc_id)) if pd.notna(row.cmc_id) else None
    st = (c or {}).get('statistics') or {}
    sup = (c or {}).get('supplyDetails') or {}
    tot = ((sup.get('totalSupply') or {}).get('value')) or st.get('totalSupply')
    circ = ((sup.get('circulatingSupply') or {}).get('value')) or st.get('circulatingSupply')
    hold = (c or {}).get('holders') or {}
    top10 = sum(h.get('share', 0) for h in (hold.get('holderList') or [])[:10]) if hold.get('holderList') else np.nan
    urls = (c or {}).get('urls') or {}
    g = cg.get(s) or {}
    ups = up.get(base, [])
    return pd.Series({
        'usd_to_lift_10pct': d.get('ask_usd_10'), 'usd_to_lift_20pct': d.get('ask_usd_20'), 'usd_to_lift_50pct': d.get('ask_usd_50'),
        'usd_to_drop_10pct': d.get('bid_usd_10'), 'spread_bp': d.get('spread_bp'),
        'float_pct': (circ / tot * 100) if circ and tot else np.nan,
        'fdv_to_mcap': (tot / circ) if circ and tot else np.nan,
        'cmc_watchers': float(c.get('watchCount') or np.nan) if c else np.nan,
        'holders': hold.get('holderCount'), 'top10_holder_pct': top10,
        'certik': ((c or {}).get('cryptoRating') or [{}])[0].get('score') if (c or {}).get('cryptoRating') else np.nan,
        'twitter': (urls.get('twitter') or [''])[0], 'website': (urls.get('website') or [''])[0],
        'github': (urls.get('source_code') or [''])[0],
        'cg_watchlist': g.get('watchlist_users'), 'cg_sentiment_up': g.get('sentiment_up'),
        'upbit_markets': ','.join(ups), 'upbit_krw_now': 'KRW' in ups, 'bithumb_krw': base in bith,
        'korea_optional': ('KRW' not in ups) and (bool(ups) or base in bith),
        'upbit_flag': upbit_flag.get(base, ''),
        'name': (c or {}).get('name'), 'binance_tags': ','.join(t for t in prod.get(s, {}).get('tags') or []),
    })


LOW = pd.concat([LOW, LOW.apply(ov, axis=1)], axis=1)
S = pd.read_parquet(os.path.join(RAW, 'santiment.parquet'))
pairs = dict(json.load(open(os.path.join(RAW, 'santiment_pairs.json'))))
SV = S[S.metric == 'social_volume_total'].pivot_table(index='date', columns='slug', values='value', aggfunc='sum').fillna(0)
last30, prev30 = SV.iloc[-30:].sum(), SV.iloc[-60:-30].sum()
LOW['social_30'] = LOW.sym.map(pairs).map(last30)
LOW['social_growth'] = np.log((LOW.sym.map(pairs).map(last30) + 1) / (LOW.sym.map(pairs).map(prev30) + 1))
LOW['social_asof'] = SV.index.max().strftime('%Y-%m-%d')
LOW['lift20_pct_of_mcap'] = LOW.usd_to_lift_20pct / LOW.mcap * 100
red = []
for _, r in LOW.iterrows():
    f = []
    if r.monitoring == 1: f.append('Binance monitoring tag')
    if r.upbit_flag: f.append('Upbit ' + r.upbit_flag)
    if r['cat'] == 'fan_token': f.append('fan token')
    if pd.notna(r.supply_growth_90) and r.supply_growth_90 > 0.15: f.append(f'supply +{r.supply_growth_90:.0%} in 90d')
    if pd.notna(r.fdv_to_mcap) and r.fdv_to_mcap > 3: f.append(f'FDV {r.fdv_to_mcap:.1f}x mcap')
    if pd.notna(r.top10_holder_pct) and r.top10_holder_pct > 80: f.append(f'top-10 wallets {r.top10_holder_pct:.0f}%')
    if r.dead_days_30 >= 3: f.append('thin trading days')
    red.append('; '.join(f))
LOW['red_flags'] = red
LOW['eligible'] = (LOW.monitoring != 1) & (LOW.upbit_flag == '') & (LOW.cat != 'fan_token')
LOW = LOW.sort_values(['eligible', 'p_double_90d'], ascending=[False, False])
cols = ['sym', 'name', 'cat', 'mcap', 'p_double_90d', 'p_inflow_30d', 'eligible', 'red_flags', 'mom_30', 'mom_90', 'dd_365', 'dd_ath',
        'vol_30', 'amihud_30', 'log_qv30', 'supply_growth_90', 'fdv_to_mcap', 'float_pct', 'usd_to_lift_10pct', 'usd_to_lift_20pct',
        'usd_to_lift_50pct', 'lift20_pct_of_mcap', 'spread_bp', 'has_perp', 'upbit_markets', 'upbit_krw_now', 'bithumb_krw',
        'korea_optional', 'dwf', 'top_vc', 'binance_labs', 'cmc_watchers', 'cg_watchlist', 'cg_sentiment_up', 'holders',
        'top10_holder_pct', 'certik', 'social_30', 'social_growth', 'dev_90', 'twitter', 'website', 'github', 'binance_tags']
out = LOW[cols].reset_index(drop=True)
out.index += 1
path = os.path.join(OUT, f'ranking_{asof:%Y-%m-%d}.csv')
out.to_csv(path)
print('as of', asof.date(), '| low-cap set', len(LOW), '| eligible', int(LOW.eligible.sum()),
      '| regime breadth_30', round(D.breadth_30.iloc[0], 3), 'btc_mom_90', round(D.btc_mom_90.iloc[0], 3),
      '| historical base P(double) in low caps', round(TR.y2c.mean(), 3))
pd.set_option('display.width', 300)
pd.set_option('display.max_colwidth', 40)
show = out.head(40).assign(mcap=lambda x: (x.mcap / 1e6).round(1), usd_to_lift_20pct=lambda x: (x.usd_to_lift_20pct / 1e3).round(0))
print(show[['sym', 'cat', 'mcap', 'p_double_90d', 'p_inflow_30d', 'eligible', 'mom_30', 'dd_ath', 'usd_to_lift_20pct', 'fdv_to_mcap',
            'upbit_markets', 'bithumb_krw', 'has_perp', 'dwf', 'top_vc', 'red_flags']].round(3).to_string())
print(path)
