"""Build the anchor panel for the low-cap spike study.

Each anchor date t (every 14 days, 2019-01-01 .. last date with a full forward window) holds every
Binance USDT pair that traded on t with >= 120 days of history and a CMC market cap on t.
Features use data up to and including t only. Outcomes use t+1 .. t+H, including pairs that were
later delisted (their last Binance close is the exit).

Series are split at reused tickers / redenominations: a 30+ day gap or a 10x one-day close jump
starts a new segment, and a segment is its own asset.
"""
import os, json
import numpy as np, pandas as pd
from common import RAW, load

STEP = 14
HORIZONS = (30, 90)
MIN_HIST = 120


def segments(df):
    """Split one symbol's bars into contiguous segments."""
    d = df.sort_index()
    gap = d.index.to_series().diff().dt.days.fillna(1) > 30
    r = (d.close / d.close.shift()).fillna(1)
    jump = (r > 10) | (r < 0.1)
    seg = (gap | jump).cumsum()
    return [g for _, g in d.groupby(seg)]


def build():
    K = pd.read_parquet(os.path.join(RAW, 'klines.parquet'))
    H = pd.read_parquet(os.path.join(RAW, 'cmc_hist.parquet'))
    choice = load('cmc_choice.json')
    H['date'] = pd.to_datetime(H.date).dt.tz_localize(None)
    mc = H.pivot_table(index='date', columns='cmc_id', values='mcap', aggfunc='last')
    circ = H.pivot_table(index='date', columns='cmc_id', values='circ', aggfunc='last')
    cmcvol = H.pivot_table(index='date', columns='cmc_id', values='volume', aggfunc='last')
    perp = load('perp_launch.json')

    frames = []
    for sym, g in K.groupby('sym'):
        g = g[(g.close > 0)].drop(columns=['sym'])
        live = bool(g.live.iloc[-1])
        segs = segments(g)
        for i, s in enumerate(segs):
            if len(s) < MIN_HIST + 10:
                continue
            idx = pd.date_range(s.index[0], s.index[-1], freq='D')
            s = s.reindex(idx)
            s['traded'] = s.close.notna()
            for c in ('close', 'open'):
                s[c] = s[c].ffill()
            s['high'] = s.high.fillna(s.close)
            s['low'] = s.low.fillna(s.close)
            for c in ('qv', 'trades', 'tbqv'):
                s[c] = s[c].fillna(0.0)
            s['asset'] = f'{sym}#{i}' if len(segs) > 1 else sym
            s['sym'] = sym
            # Only the last segment of a live pair is still trading today.
            s['is_live_seg'] = live and i == len(segs) - 1
            cid = choice.get(sym)
            s['cmc_id'] = cid
            if cid and cid in mc.columns:
                m = mc[cid].reindex(idx)
                # CMC mcap must agree with this segment's Binance price, else a reused ticker.
                cm_close = H[H.cmc_id == cid].set_index('date').close.reindex(idx)
                mult = 1e6 if sym.startswith('1M') else 1000.0 if sym.startswith('1000') else 1.0
                ok = (np.abs(np.log(cm_close * mult / s.close)) < 0.25)
                s['mcap'] = m.where(ok & (m > 0))
                s['circ'] = circ[cid].reindex(idx).where(ok)
            else:
                s['mcap'] = np.nan
                s['circ'] = np.nan
            p = perp.get(sym) or perp.get('1000' + sym)
            s['perp_date'] = pd.Timestamp(p) if p else pd.NaT
            frames.append(s)
    D = pd.concat(frames)
    D.index.name = 'date'
    return D.reset_index()


def features(D):
    out = []
    for a, s in D.groupby('asset'):
        s = s.set_index('date').sort_index()
        c, h, l, qv = s.close, s.high, s.low, s.qv
        lr = np.log(c).diff()
        f = pd.DataFrame(index=s.index)
        f['asset'], f['sym'], f['cmc_id'] = a, s.sym, s.cmc_id
        f['is_live_seg'] = s.is_live_seg
        f['close'] = c
        f['mcap'] = s.mcap
        f['age'] = np.arange(len(s))
        f['log_mcap'] = np.log(s.mcap)
        f['log_price'] = np.log(c)
        for w in (7, 30, 90, 180):
            f[f'mom_{w}'] = c / c.shift(w) - 1
        f['vol_30'] = lr.rolling(30).std()
        f['vol_ratio'] = lr.rolling(30).std() / lr.rolling(180, min_periods=120).std()
        f['range_30'] = h.rolling(30).max() / l.rolling(30).min() - 1
        f['max_ret_30'] = lr.rolling(30).max()
        f['max_ret_90'] = lr.rolling(90).max()
        f['dd_365'] = c / h.rolling(365, min_periods=MIN_HIST).max() - 1
        f['dd_ath'] = c / h.cummax() - 1
        f['up_from_low_365'] = c / l.rolling(365, min_periods=MIN_HIST).min() - 1
        low_idx = l.rolling(365, min_periods=MIN_HIST).apply(lambda x: len(x) - 1 - np.argmin(x), raw=True)
        f['days_since_low'] = low_idx
        qv7, qv30, qv90 = qv.rolling(7).mean(), qv.rolling(30).mean(), qv.rolling(90).mean()
        f['log_qv30'] = np.log1p(qv30)
        f['vol_surge_7_90'] = np.log((qv7 + 1) / (qv90 + 1))
        f['vol_surge_30_90'] = np.log((qv30 + 1) / (qv90 + 1))
        f['turnover_30'] = qv30 / s.mcap
        f['amihud_30'] = (lr.abs() / (qv + 1)).rolling(30).mean() * 1e6
        tb = s.tbqv.rolling(7).sum() / (qv.rolling(7).sum() + 1)
        tb30 = s.tbqv.rolling(30).sum() / (qv.rolling(30).sum() + 1)
        f['taker_buy_7'] = tb
        f['taker_buy_chg'] = tb - s.tbqv.rolling(90).sum() / (qv.rolling(90).sum() + 1)
        f['taker_buy_30'] = tb30
        # Price impact per $1M of net aggressive buying (Kyle's lambda), 90d rolling OLS slope of
        # daily log return on net taker flow (taker buy minus taker sell, USD).
        nf = (2 * s.tbqv - qv) / 1e6
        cov = (lr * nf).rolling(90, min_periods=60).mean() - lr.rolling(90, min_periods=60).mean() * nf.rolling(90, min_periods=60).mean()
        var = nf.rolling(90, min_periods=60).var(ddof=0)
        f['kyle_lambda'] = cov / var.replace(0, np.nan)
        f['log_lambda'] = np.log(f.kyle_lambda.clip(lower=1e-6))
        f['net_flow_7'] = nf.rolling(7).sum() * 1e6 / (s.mcap)
        f['net_flow_30'] = nf.rolling(30).sum() * 1e6 / (s.mcap)
        f['trades_surge'] = np.log((s.trades.rolling(7).mean() + 1) / (s.trades.rolling(90).mean() + 1))
        f['avg_trade_usd'] = np.log1p(qv30 / (s.trades.rolling(30).mean() + 1))
        f['supply_growth_90'] = s.circ / s.circ.shift(90) - 1
        f['supply_growth_365'] = s.circ / s.circ.shift(365) - 1
        f['has_perp'] = (s.perp_date <= s.index).astype(float)
        f['days_since_perp'] = (s.index.to_series() - s.perp_date).dt.days.where(s.perp_date <= s.index)
        f['dead_days_30'] = (~s.traded).rolling(30).sum() + (qv < 1000).rolling(30).sum()
        # Outcomes (t+1 .. t+H); a segment that ends inside the window exits at its last close.
        last = s.index[-1]
        # Forward inflow: mean daily quote volume over t+1..t+30 vs the trailing 90d mean.
        fqv = qv[::-1].rolling(30, min_periods=30).mean()[::-1].shift(-1)
        f['fwd_qv_ratio_30'] = fqv / (qv90 + 1)
        fnf = nf[::-1].rolling(30, min_periods=30).sum()[::-1].shift(-1)
        f['fwd_net_flow_30'] = fnf * 1e6 / s.mcap
        for H in HORIZONS:
            fc = c.shift(-H)
            ended = (s.index + pd.Timedelta(days=H)) > last
            delisted_exit = ended & (~s.is_live_seg)
            f[f'ret_{H}'] = np.where(delisted_exit, c.iloc[-1] / c - 1, fc / c - 1)
            fmax_c = c[::-1].rolling(H, min_periods=1).max()[::-1].shift(-1)
            fmax_h = h[::-1].rolling(H, min_periods=1).max()[::-1].shift(-1)
            f[f'maxc_{H}'] = fmax_c / c - 1
            f[f'maxh_{H}'] = fmax_h / c - 1
            # Exit at 2x if the CLOSE reaches it, else hold to t+H (or delisting).
            hit2 = f[f'maxc_{H}'] >= 1.0
            f[f'tp2_{H}'] = np.where(hit2, 1.0, f[f'ret_{H}'])
            f[f'complete_{H}'] = (~ended) | delisted_exit
            f[f'delist_{H}'] = delisted_exit
        out.append(f)
    return pd.concat(out)


if __name__ == '__main__':
    D = build()
    print('daily rows', len(D), 'assets', D.asset.nunique(), flush=True)
    F = features(D)
    F.index.name = 'date'
    F = F.reset_index()
    F.to_parquet(os.path.join(RAW, 'daily_features.parquet'))
    print('features', F.shape, flush=True)
