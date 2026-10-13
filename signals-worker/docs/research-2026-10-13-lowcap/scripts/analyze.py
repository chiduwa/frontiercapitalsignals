"""Which observable factors preceded low-cap spikes on Binance?

Universe per anchor (every 14 days): pairs trading that day, >=120 days old, CMC market cap known,
<10 dead days in the last 30, and in the bottom LOWCAP_PCT of that day's Binance market caps.
Delisted pairs are included (no survivorship). Outcomes:
  y2c   daily CLOSE reaches 2x within 90 days (sellable spike)
  y2h   intraday HIGH reaches 2x within 90 days (includes wicks)
  y50   close reaches +50% within 30 days
  ret90 close-to-close 90d return (delisting exits at the last Binance close)
  tp2   sell at 2x if the close gets there, else hold 90d
Per feature, per anchor: top-quintile minus bottom-quintile outcome (rank within the anchor's
low-cap set). Mean over anchors with Newey-West t (lag 7: 90d windows overlap ~6.4 anchors),
both halves, Holm across all feature x outcome cells.
"""
import os, sys, json, math
import numpy as np, pandas as pd
from common import RAW, OUT

LOWCAP_PCT = float(os.environ.get('LOWCAP_PCT', '0.4'))
STEP = 14
NW_LAG = 7

FEATS = ['log_mcap', 'log_price', 'age', 'mom_7', 'mom_30', 'mom_90', 'mom_180', 'vol_30', 'vol_ratio',
         'range_30', 'max_ret_30', 'max_ret_90', 'dd_365', 'dd_ath', 'up_from_low_365', 'days_since_low',
         'log_qv30', 'vol_surge_7_90', 'vol_surge_30_90', 'turnover_30', 'amihud_30', 'taker_buy_7',
         'taker_buy_chg', 'taker_buy_30', 'trades_surge', 'avg_trade_usd', 'supply_growth_90',
         'supply_growth_365', 'has_perp', 'days_since_perp', 'prior_spikes', 'cat_mom_30',
         'log_lambda', 'net_flow_7', 'net_flow_30', 'dwf', 'binance_labs', 'top_vc', 'launchpool',
         'made_in_america', 'n_tags', 'upbit_krw', 'days_since_upbit', 'monitoring', 'dev_90', 'dev_growth', 'social_30', 'social_growth']
OUTCOMES = ['y2c', 'y2h', 'y50', 'ret90', 'tp2', 'inflow3x']


def nw_t(x, lag=NW_LAG):
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    n = len(x)
    if n < 10:
        return np.nan, n
    m = x.mean()
    e = x - m
    s = e @ e / n
    for k in range(1, lag + 1):
        w = 1 - k / (lag + 1)
        s += 2 * w * (e[k:] @ e[:-k]) / n
    return m / math.sqrt(max(s, 1e-18) / n), n


def add_extras(P):
    """Static backer flags, point-in-time event state, Santiment dev activity."""
    fl = json.load(open(os.path.join(RAW, 'cmc_flags.json')))
    for k in ('dwf', 'binance_labs', 'top_vc', 'launchpool', 'made_in_america', 'n_tags'):
        P[k] = P.sym.map(lambda s: float((fl.get(s) or {}).get(k, np.nan)))
    ev_path = os.path.join(RAW, 'events.parquet')
    P['upbit_krw'] = np.nan
    P['days_since_upbit'] = np.nan
    P['monitoring'] = np.nan
    if os.path.exists(ev_path):
        E = pd.read_parquet(ev_path)
        first_upbit = E[E.kind == 'upbit_krw'].groupby('sym').date.min()
        up_start = E[E.kind == 'upbit_krw'].date.min()
        # On Upbit KRW today with no listing notice since 2022-03 => listed before the notice history.
        krw_now = {m['market'][4:] + 'USDT' for m in json.load(open(os.path.join(RAW, 'upbit_markets.json'))) if m['market'].startswith('KRW-')}
        for s in krw_now:
            if s not in first_upbit.index:
                first_upbit[s] = pd.Timestamp('2000-01-01')
        fu = P.sym.map(first_upbit)
        # Before Upbit's notice history starts we cannot know the state.
        P['upbit_krw'] = np.where(P.date < up_start, np.nan, (fu <= P.date).astype(float))
        P['days_since_upbit'] = (P.date - fu).dt.days.where((fu <= P.date) & (fu > pd.Timestamp('2001-01-01')))
        mon = E[E.kind == 'bn_monitoring'][['sym', 'date']]
        mon_start = mon.date.min()
        last_mon = []
        for s, d in zip(P.sym, P.date):
            m = mon[(mon.sym == s) & (mon.date <= d)]
            last_mon.append((d - m.date.max()).days if len(m) else np.nan)
        P['monitoring'] = np.where(P.date < mon_start, np.nan, (pd.Series(last_mon, index=P.index) <= 365).astype(float))
    san_path = os.path.join(RAW, 'santiment.parquet')
    P['dev_90'] = np.nan
    P['dev_growth'] = np.nan
    P['social_30'] = np.nan
    P['social_growth'] = np.nan
    if os.path.exists(san_path):
        S = pd.read_parquet(san_path)
        pairs = dict(json.load(open(os.path.join(RAW, 'santiment_pairs.json'))))
        for metric, a, b in (('dev_activity', 'dev_90', 'dev_growth'), ('social_volume_total', 'social_30', 'social_growth')):
            M = S[S.metric == metric].pivot_table(index='date', columns='slug', values='value', aggfunc='sum')
            M = M.reindex(pd.date_range(M.index.min(), M.index.max(), freq='D')).fillna(0)
            w = 90 if metric == 'dev_activity' else 30
            lvl = M.rolling(w, min_periods=w).sum()
            prev = M.shift(w).rolling(w, min_periods=w).sum()
            gr = np.log((lvl + 1) / (prev + 1))
            st = lvl.stack().rename(a).reset_index().rename(columns={'level_0': 'date'})
            sg = gr.stack().rename(b).reset_index().rename(columns={'level_0': 'date'})
            st['sym_slug'] = st.slug
            P['slug'] = P.sym.map(pairs)
            P = P.drop(columns=[a, b]).merge(st[['date', 'slug', a]], on=['date', 'slug'], how='left') \
                .merge(sg[['date', 'slug', b]], on=['date', 'slug'], how='left')
            P[a] = np.log1p(P[a])
    return P


def load_panel():
    F = pd.read_parquet(os.path.join(RAW, 'daily_features.parquet'))
    F['date'] = pd.to_datetime(F.date)
    # Prior spikes: how many times in the past 365d did the close double within 90 days?
    # (uses only windows that finished before t)
    F = F.sort_values(['asset', 'date'])
    F['past_y2c'] = F.groupby('asset').maxc_90.shift(90) >= 1.0
    F['prior_spikes'] = F.groupby('asset').past_y2c.transform(lambda s: s.astype(float).rolling(365, min_periods=1).sum() / 30)
    end = F.date.max()
    anchors = pd.date_range('2019-01-01', end, freq=f'{STEP}D')
    P = F[F.date.isin(anchors)].copy()
    P = P[(P.age >= 120) & P.mcap.notna() & (P.dead_days_30 < 10)]
    P['mcap_pct'] = P.groupby('date').mcap.rank(pct=True)
    # Category momentum: mean 30d return of the coin's Binance tag peers (excluding itself)
    tags = json.load(open(os.path.join(RAW, 'cmc_tags.json'))) if os.path.exists(os.path.join(RAW, 'cmc_tags.json')) else {}
    P['cat'] = P.sym.map(lambda s: tags.get(s, 'other'))
    g = P.groupby(['date', 'cat']).mom_30
    P['cat_mom_30'] = (g.transform('sum') - P.mom_30.fillna(0)) / (g.transform('count') - 1).replace(0, np.nan)
    P = add_extras(P)
    P['inflow3x'] = (P.fwd_qv_ratio_30 >= 3).astype(float).where(P.fwd_qv_ratio_30.notna())
    P['y2c'] = (P.maxc_90 >= 1.0).astype(float)
    P['y2h'] = (P.maxh_90 >= 1.0).astype(float)
    P['y50'] = (P.maxc_30 >= 0.5).astype(float)
    P['ret90'] = P.ret_90.clip(-1, 20)
    P['tp2'] = P.tp2_90.clip(-1, 1)
    P['complete'] = P.complete_90
    return F, P


def regime(F, P):
    btc = F[F.sym == 'BTCUSDT'].set_index('date').close
    r = pd.DataFrame(index=sorted(P.date.unique()))
    r['btc_mom_90'] = (btc / btc.shift(90) - 1).reindex(r.index)
    r['btc_mom_30'] = (btc / btc.shift(30) - 1).reindex(r.index)
    allp = F[F.date.isin(r.index) & (F.age >= 120)]
    r['breadth_30'] = allp.groupby('date').mom_30.apply(lambda s: (s > 0).mean())
    r['alt_med_mom_90'] = allp.groupby('date').mom_90.median()
    return r


def quintile_spread(P, feat, out):
    rows = []
    for d, g in P.groupby('date'):
        g = g[[feat, out]].dropna()
        if len(g) < 25 or g[feat].nunique() < 5:
            continue
        q = g[feat].rank(pct=True)
        top, bot = g[out][q > 0.8].mean(), g[out][q <= 0.2].mean()
        rows.append((d, top - bot, top, bot, g[out].mean()))
    return pd.DataFrame(rows, columns=['date', 'spread', 'top', 'bot', 'base']).set_index('date')


if __name__ == '__main__':
    F, P = load_panel()
    R = regime(F, P)
    P = P.join(R, on='date')
    L = P[(P.mcap_pct <= LOWCAP_PCT) & P.complete].copy()
    print(f'low-cap panel: {len(L)} rows, {L.asset.nunique()} assets, {L.date.nunique()} anchors, '
          f'{L.date.min():%Y-%m-%d}..{L.date.max():%Y-%m-%d}; later-delisted assets {L[~L.is_live_seg].asset.nunique()}')
    print('median mcap of low-cap set by year:', L.groupby(L.date.dt.year).mcap.median().map(lambda x: f'{x/1e6:.1f}M').to_dict())
    base = L.groupby('date')[OUTCOMES].mean()
    print('\nBASE RATES (mean over anchors):', base.mean().round(4).to_dict())
    print('base y2c by year:', base.y2c.groupby(base.index.year).mean().round(3).to_dict())
    print('base ret90 median by year:', L.groupby(L.date.dt.year).ret90.median().round(3).to_dict())
    print('share delisted within 90d:', round(L.delist_90.mean(), 4))
    # Compare with larger caps
    U = P[(P.mcap_pct > 0.6) & P.complete]
    print('upper-40% caps base:', U.groupby('date')[OUTCOMES].mean().mean().round(4).to_dict())

    mid = L.date.min() + (L.date.max() - L.date.min()) / 2
    res = []
    for feat in FEATS:
        if feat not in L or L[feat].notna().sum() < 1000:
            continue
        for out in OUTCOMES:
            qs = quintile_spread(L, feat, out)
            if qs.empty:
                continue
            t, n = nw_t(qs.spread)
            t1, _ = nw_t(qs.spread[qs.index < mid])
            t2, _ = nw_t(qs.spread[qs.index >= mid])
            res.append(dict(feat=feat, out=out, n=n, spread=qs.spread.mean(), top=qs.top.mean(), bot=qs.bot.mean(),
                            base=qs.base.mean(), t=t, t_h1=t1, t_h2=t2,
                            h1=qs.spread[qs.index < mid].mean(), h2=qs.spread[qs.index >= mid].mean()))
    T = pd.DataFrame(res)
    from scipy.stats import norm
    T['p'] = 2 * norm.sf(T.t.abs())
    T = T.sort_values('p')
    m = len(T)
    T['holm'] = [min(1.0, p * (m - i)) for i, p in enumerate(T.p)]
    T['holm'] = T.holm.cummax()
    T['both_halves'] = np.sign(T.h1) == np.sign(T.h2)
    T['survives'] = (T.holm < 0.05) & T.both_halves
    T.to_csv(os.path.join(OUT, f'univariate_lowcap{int(LOWCAP_PCT*100)}.csv'), index=False)
    pd.set_option('display.width', 250)
    pd.set_option('display.max_rows', 300)
    for out in OUTCOMES:
        print(f'\n=== {out}: top-minus-bottom quintile (NW t, halves) ===')
        x = T[T.out == out].sort_values('t', key=abs, ascending=False)
        print(x[['feat', 'n', 'base', 'top', 'bot', 'spread', 't', 't_h1', 't_h2', 'holm', 'survives']].round(4).to_string(index=False))
    L.to_parquet(os.path.join(RAW, f'lowcap_panel{int(LOWCAP_PCT*100)}.parquet'))
