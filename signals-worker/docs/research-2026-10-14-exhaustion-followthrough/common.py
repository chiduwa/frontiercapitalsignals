"""Shared loading and statistics for the follow-through study."""
import os
import numpy as np, pandas as pd
import statsmodels.api as sm

RAW = os.environ.get('RAW', os.path.join(os.path.dirname(__file__), '../../reports/scenarios/2026-10-14-followthrough/raw'))
DISC = ('2025-01-01', '2026-10-12')     # discovery: the regime the alerts run in now
VAL = ('2023-01-01', '2025-01-01')      # validation: older, untouched by any choice made here
ALERT_COLS = ['ratio', 'tradeRatio', 'barPct', 'volZ', 'barZ', 'run24Z', 'liq30d', 'e20', 'cal', 'tier', 'prior72',
              'breadth24', 'pre24', 'pre7d', 'pre30d', 'dist_hi30', 'dist_hi90', 'upper_wick', 'tb_alert',
              'btc_pre24', 'btc_pre7d', 'mkt_pre24', 'mkt_pre7d', 'age_days', 'young', 'quote_volume', 'base48']


def load(with_perp=True):
    D = pd.read_parquet(os.path.join(RAW, 'panel.parquet'))
    A = D[D.k == 0][['symbol', 'ts'] + ALERT_COLS + ['h_below_alert', 'below_alert_30d', 'peak30', 'peak30_h', 'r720']]
    D = D.drop(columns=[c for c in ALERT_COLS + ['h_below_alert', 'below_alert_30d', 'peak30', 'peak30_h', 'r720'] if c in D])
    D = D.merge(A, on=['symbol', 'ts'], how='left')
    if with_perp and os.path.exists(os.path.join(RAW, 'perp_feats.parquet')):
        Pf = pd.read_parquet(os.path.join(RAW, 'perp_feats.parquet'))
        P0 = Pf[Pf.k == 0][['symbol', 'ts', 'fund_k', 'prem_k', 'oi_pre24', 'oi_pre4', 'gls_lvl_k', 'pvol_k', 'taker_k']]
        P0 = P0.rename(columns={'fund_k': 'fund0', 'prem_k': 'prem0', 'gls_lvl_k': 'gls0', 'pvol_k': 'pvol0', 'taker_k': 'taker0'})
        D = D.merge(Pf.drop(columns=['oi_pre24', 'oi_pre4'], errors='ignore'), on=['symbol', 'ts', 'k'], how='left')
        D = D.merge(P0, on=['symbol', 'ts'], how='left')
        D['has_perp'] = D.perp.notna()
        # Binance all-account long/short ratio -> share of accounts net long
        D['long_pct_k'] = D.gls_lvl_k / (1 + D.gls_lvl_k)
        D['long_pct0'] = D.gls0 / (1 + D.gls0)
    cf_ = os.path.join(RAW, 'cluster_feats.parquet')
    if with_perp and os.path.exists(cf_):
        C = pd.read_parquet(cf_).drop(columns=['period', 'day', 'up24', 'dn24'], errors='ignore')
        D = D.merge(C, on=['symbol', 'ts', 'k'], how='left')
    D['day'] = D.ts.dt.floor('D')
    D['period'] = np.where((D.ts >= DISC[0]) & (D.ts < DISC[1]), 'disc', np.where((D.ts >= VAL[0]) & (D.ts < VAL[1]), 'val', 'other'))
    D['first'] = D.prior72 == 0
    return D


def cmean(y, g):
    """Mean with a cluster-robust (by g) t statistic."""
    y = np.asarray(y, float); g = np.asarray(g)
    ok = ~np.isnan(y); y, g = y[ok], g[ok]
    n = len(y)
    if n < 10:
        return np.nan, np.nan, n
    m = y.mean()
    e = pd.Series(y - m).groupby(g).sum().values
    G = len(e)
    v = (e ** 2).sum() / n ** 2 * G / max(G - 1, 1)
    return m, m / np.sqrt(v) if v > 0 else np.nan, n


def cdiff(y, x, g):
    """y on [1, x] with cluster-robust SE by g: (coef on x, t)."""
    df = pd.DataFrame({'y': y, 'x': x, 'g': g}).dropna()
    if len(df) < 30 or df.x.nunique() < 2:
        return np.nan, np.nan
    r = sm.OLS(df.y.astype(float), sm.add_constant(df.x.astype(float))).fit(cov_type='cluster', cov_kwds={'groups': pd.factorize(df.g)[0]})
    return r.params.iloc[1], r.tvalues.iloc[1]


def pct(x):
    return f'{100 * x:+.1f}%' if x == x else '  n/a'
