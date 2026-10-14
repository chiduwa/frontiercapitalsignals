"""Pull-aways: coins that move sharply away from the market, and what happens next.

Data: daily closes and quote volume for 685 Binance USDT spot pairs, 2017-08 .. 2026-10-11,
199 since delisted (the 2026-10-12 cycles study, reports/scenarios/2026-10-12-near-red/claude/
cycles/data/ALTS.parquet); BTC daily (Bitstamp) and CoinMarketCap's altcoin market cap for the
regime. Tokenized stocks, stables and pegged/wrapped tokens are dropped.

Market over any window = the median log return over exactly that window of the coins liquid
at its start (30-day median daily volume >= $1M, at least 30 coins). A delisted coin is held
at its last close (its exit). Relative return = coin log return - that median, same window.
(Summing daily medians instead drifts down over weeks, because daily returns are
right-skewed, and makes every coin look like it pulled away: tried first, dropped.)

Onset (day 0, at its close): the coin's 3-day relative return reaches >= 2.5 of its own 3-day
relative sd (90 days ending before the window) AND >= 5% in size. Side +1 pulling ahead, -1
falling behind. At most one event per coin and side in any 30 days. Only coins liquid that
day count.

Per event: relative return from the onset close at 1..90 days (R*), plain return (r*), and the
relative gain G measured from the START of the 3-day window for days 0..90: peak, the day it
peaked, and the days until half / all of the onset gain was given back. Onset features (known
at the day-0 close) for the factor tests. A control of random liquid coin-days gives the
baseline. Output: RAW/events.parquet, RAW/control.parquet
"""
import os, re
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '../../reports/scenarios/2026-10-12-near-red/claude/cycles/data')
RAW = os.path.join(HERE, '../../reports/scenarios/2026-10-14-pullaways')
os.makedirs(RAW, exist_ok=True)
H = [1, 3, 7, 14, 30, 60, 90]
LIQ = 1_000_000
STOCKS = set(re.findall(r"'([A-Z0-9]+)'", open(os.path.join(HERE, '../../scripts/exhaustion-gauge.mjs')).read()
                        .split('KNOWN_TOKENIZED_STOCKS = new Set([')[1].split('])')[0]))
PEG = re.compile(r'^(USDC|BUSD|TUSD|FDUSD|USDP|DAI|EUR|GBP|AEUR|PAXG|USD1|XUSD|BFUSD|RLUSD|U|EURI|USDE|PYUSD|USTC|UST|SUSD|USDS|XAUT|WBTC|WBETH|BETH|STETH|WSTETH|BNSOL|CBBTC)USDT$')


def main():
    A = pd.read_parquet(os.path.join(SRC, 'ALTS.parquet'))
    A = A[A.index < '2026-10-12']                     # the file's last day is partial
    A = A[~A.sym.str[:-4].isin(STOCKS) & ~A.sym.str.match(PEG)]
    C = A.pivot_table(index=A.index, columns='sym', values='close').sort_index()
    V = A.pivot_table(index=A.index, columns='sym', values='qv').sort_index()
    listed = A.groupby('sym').listed.first()
    C = C.where(C > 0)
    dates, syms = C.index, list(C.columns)
    col = {s: k for k, s in enumerate(syms)}
    L = np.log(C)
    for s in syms:                                     # delisted: held at the last close
        if not listed.get(s, False):
            lv = L[s].last_valid_index()
            L.loc[lv:, s] = L.loc[lv, s]
    r = L.diff()
    r = r.where(r.abs() < 1.5)                         # corrupt prints
    liq = V.rolling(30, min_periods=20).median().shift(1)
    liquid = (liq >= LIQ) & L.notna()
    n_liq = liquid.sum(axis=1)
    ok_day = (n_liq >= 30).values
    Lv, lq = L.values, liquid.values

    def wrel(a, b):
        """per coin: log return a->b minus the median of coins liquid at a (NaN row if < 30)"""
        if a < 0 or b >= len(dates):
            return None, np.nan
        m = lq[a] & ~np.isnan(Lv[b])
        if m.sum() < 30:
            return None, np.nan
        d = Lv[b] - Lv[a]
        med = np.median(d[m])
        return d - med, med

    # daily relative scale and beta (scale only; windows use wrel)
    Md = r.where(liquid).median(axis=1)
    rel_d = r.sub(Md, axis=0)
    sd3 = (rel_d.rolling(90, min_periods=60).std().shift(3) * np.sqrt(3)).values
    Mx = pd.DataFrame(np.repeat(Md.values[:, None], r.shape[1], axis=1), index=r.index, columns=r.columns)
    cov = (r * Mx).rolling(90, min_periods=60).mean() - r.rolling(90, min_periods=60).mean() * Mx.rolling(90, min_periods=60).mean()
    beta = (cov / Mx.rolling(90, min_periods=60).var(ddof=0)).shift(1).values
    vol3 = (V.rolling(3).sum() / (3 * V.rolling(30, min_periods=20).median().shift(3)))
    vmed = vol3.where(liquid).median(axis=1).values
    vol3 = vol3.values
    liqv = liq.values
    first_day = {s: C[s].first_valid_index() for s in syms}
    btc = pd.read_parquet(os.path.join(SRC, 'BTC.parquet')).close
    btc = btc[~btc.index.duplicated()].sort_index()
    btc_bull = (btc > btc.rolling(200).mean()).reindex(dates).values
    btc_ret90 = np.log(btc).diff(90).reindex(dates).values
    mk = pd.read_parquet(os.path.join(SRC, 'MKT.parquet'))
    mk = mk[~mk.index.duplicated()].sort_index()
    alt_bull = (mk.alt_mcap > mk.alt_mcap.rolling(200).mean()).reindex(dates).values
    dom_chg30 = mk.btc_dom.diff(30).reindex(dates).values

    # 3-day relative per day (onset test), and the forward windows
    REL3 = np.full(Lv.shape, np.nan); M3 = np.full(len(dates), np.nan)
    FW = {h: np.full(Lv.shape, np.nan) for h in H}
    for t in range(len(dates)):
        if not ok_day[t]:
            continue
        x, m = wrel(t - 3, t)
        if x is not None:
            REL3[t] = x; M3[t] = m
        for h in H:
            x, _ = wrel(t, t + h)
            if x is not None:
                FW[h][t] = x
    Z3 = REL3 / sd3
    hit = {1: (Z3 >= 2.5) & (REL3 >= 0.05) & lq, -1: (Z3 <= -2.5) & (REL3 <= -0.05) & lq}
    breadth = {k: v.sum(axis=1) for k, v in hit.items()}

    def path(a, i0, i1, k):
        """coin minus the median coin liquid at a, log, from day a to each of days i0..i1"""
        m = lq[a]
        seg = Lv[i0:i1 + 1][:, m] - Lv[a, m]
        return (Lv[i0:i1 + 1, k] - Lv[a, k]) - np.nanmedian(seg, axis=1)

    ev = []
    for s in syms:
        k = col[s]
        last = {1: -10**9, -1: -10**9}
        for i in range(len(dates)):
            for side in (1, -1):
                if not hit[side][i, k] or i - last[side] <= 30:
                    continue
                last[side] = i
                rec = {'sym': s, 'date': dates[i], 'side': side, 'z3': Z3[i, k], 'rel3': REL3[i, k],
                       'rel1': rel_d.values[i, k], 'mkt3': M3[i], 'mkt1': Md.values[i], 'beta': beta[i, k],
                       'vol3': vol3[i, k], 'vol_rel': vol3[i, k] / vmed[i], 'liq': liqv[i, k],
                       'age': (dates[i] - first_day[s]).days, 'btc_bull': btc_bull[i], 'alt_bull': alt_bull[i],
                       'btc_ret90': btc_ret90[i], 'dom_chg30': dom_chg30[i], 'breadth': breadth[side][i],
                       'listed_now': bool(listed.get(s, False)), 'n_liq': n_liq.values[i]}
                for nm, a in (('pre30', i - 33), ('pre90', i - 93)):
                    x, _ = wrel(a, i - 3)
                    rec[nm] = x[k] if x is not None else np.nan
                past = Lv[max(0, i - 365):i, k]
                rec['dist_hi365'] = Lv[i, k] - np.nanmax(past) if np.isfinite(past).sum() > 30 else np.nan
                d3 = rel_d.values[i - 2:i + 1, k]
                rec['spike_share'] = np.nanmax(side * d3) / (side * REL3[i, k])
                for h in H:
                    rec[f'R{h}'] = FW[h][i, k]
                    rec[f'r{h}'] = Lv[i + h, k] - Lv[i, k] if i + h < len(dates) else np.nan
                if i + 90 < len(dates) and lq[i - 3].sum() >= 30:
                    G = side * path(i - 3, i, i + 90, k)
                    if np.isfinite(G).sum() > 60:
                        pk = int(np.nanargmax(G))
                        rec['peak_day'], rec['peak_gain'], rec['g0'] = pk, G[pk], G[0]
                        hb = np.flatnonzero(G[1:] <= G[0] / 2)
                        rec['half_day'] = int(hb[0]) + 1 if len(hb) else np.nan
                        zb = np.flatnonzero(G[1:] <= 0)
                        rec['zero_day'] = int(zb[0]) + 1 if len(zb) else np.nan
                ev.append(rec)
    E = pd.DataFrame(ev)
    E.to_parquet(os.path.join(RAW, 'events.parquet'), index=False)
    rng = np.random.default_rng(0)
    ctrl = []
    for s in syms:
        k = col[s]
        cand = np.flatnonzero(lq[:, k] & ok_day)
        for i in (rng.choice(cand, size=min(len(cand), 40), replace=False) if len(cand) else []):
            rec = {'sym': s, 'date': dates[i], 'btc_bull': btc_bull[i], 'alt_bull': alt_bull[i], 'liq': liqv[i, k], 'beta': beta[i, k]}
            for h in H:
                rec[f'R{h}'] = FW[h][i, k]
            ctrl.append(rec)
    pd.DataFrame(ctrl).to_parquet(os.path.join(RAW, 'control.parquet'), index=False)
    print(len(E), 'events', E.groupby('side').size().to_dict(), E.sym.nunique(), 'coins;', len(ctrl), 'control days')
    print(E.groupby([E.date.dt.year, 'side']).size().unstack().to_string())


if __name__ == '__main__':
    main()
