"""Per pushed up-alert: the path for 30 days after, and checkpoint snapshots.

All offsets are by timestamp on a full hourly grid (missing hours are NaN), never by row.
Alert close C0 = close of the alert bar; checkpoint k = k hours after that close.

Rows: one per (alert, k), k in K (k = 0 is the alert itself).
  state at k  (only bars up to the checkpoint close): price vs alert, run-up high, drawdown
              from the high, volume vs the pre-alert 48h baseline (mean since alert, last hour,
              last 3 hours), volume vs the alert bar, volume trend (second half vs first half),
              spot taker-buy share, re-alerts, green-bar share, market move
  forward     (from the checkpoint close): returns at 24/72/168/336h (plain and minus the
              equal-weight market), peak within 14 days and hours to it, trough within 14 days,
              first passage +10/-10 and +20/-20 (on highs/lows; a bar touching both = adverse)
A coin delisted before the horizon is exited at its last close (flag `exit_last`); a listed
coin whose data simply ends (recent alerts) is NaN for that horizon.
Output: RAW/panel.parquet, RAW/market.parquet
"""
import glob, json, os, zlib
import numpy as np, pandas as pd

RAW = os.environ.get('RAW', os.path.join(os.path.dirname(__file__), '../../reports/scenarios/2026-10-14-followthrough/raw'))
H = 3_600_000
K = [0, 1, 2, 4, 8, 12, 24, 48, 72]
FWD = [24, 72, 168, 336]
G0 = int(pd.Timestamp('2022-11-01', tz='UTC').timestamp() * 1000)
G1 = int(pd.Timestamp('2026-10-14 12:00', tz='UTC').timestamp() * 1000)
NG = (G1 - G0) // H


def grid(df):
    idx = ((df.open_time.values - G0) // H).astype(int)
    ok = (idx >= 0) & (idx < NG)
    out = {}
    for c in ('open', 'high', 'low', 'close', 'quote_volume', 'count', 'taker_buy_quote_volume'):
        a = np.full(NG, np.nan)
        a[idx[ok]] = df[c].values[ok]
        out[c] = a
    return out


def build_market(files):
    """Log-close matrix (coins x hours) for the same-window market: the median coin's log
    return over exactly the alert's window. A coin counts in an hour only if it traded
    >= $20k that hour. (Summing hourly medians drifts negative over days, because hourly
    returns are right-skewed; the window median does not.)"""
    L, names = [], []
    for fn in files:
        df = pd.read_parquet(fn)
        if len(df) < 100:
            continue
        g = grid(df)
        lc = np.log(g['close'])
        lc[~(g['quote_volume'] >= 20_000)] = np.nan
        L.append(lc.astype(np.float32)); names.append(os.path.basename(fn)[:-8])
    return np.vstack(L), names


def mwin(LC, b, e):
    """Median coin log return from hour b to hour e (arrays of equal length)."""
    out = np.full(len(b), np.nan)
    for i in range(0, len(b), 2000):
        bb, ee = b[i:i + 2000], e[i:i + 2000]
        r = LC[:, ee] - LC[:, bb]
        n = np.sum(~np.isnan(r), axis=0)
        m = np.nanmedian(r, axis=0)
        out[i:i + 2000] = np.where(n >= 20, m, np.nan)
    return out


def first_true(x):
    w = np.flatnonzero(x)
    return int(w[0]) if len(w) else -1


def forward(rec, c, hi, lo, b, last, listed, win, row):
    """Outcomes from the close of hour b: returns, peak/trough within 14 days, first passage."""
    Pk = c[b]
    for fh in FWD:
        e = b + fh
        ex = False
        if e > last:
            if listed:
                rec[f'f{fh}'] = np.nan; rec[f'x{fh}'] = np.nan
                continue
            e = last; ex = True
        ce = c[e]
        if not (ce > 0):
            w = np.flatnonzero(~np.isnan(c[b:e + 1]))
            e = b + int(w[-1]); ce = c[e]
        rec[f'f{fh}'] = ce / Pk - 1
        rec[f'x{fh}'] = np.log(ce / Pk)
        win.append((row, f'm{fh}', b, e))
        if fh == 336:
            rec['exit_last'] = ex
    e = min(b + 336, last)
    if e - b >= 336 or not listed:
        hseg, lseg = hi[b + 1:e + 1], lo[b + 1:e + 1]
        if np.sum(~np.isnan(hseg)) > 0:
            j = int(np.nanargmax(hseg))
            rec['fpeak'] = hseg[j] / Pk - 1
            rec['fpeak_h'] = j + 1
            rec['ftrough'] = np.nanmin(lseg) / Pk - 1
            for X in (0.10, 0.20):
                up = first_true(hseg >= Pk * (1 + X)); dn = first_true(lseg <= Pk * (1 - X))
                rec[f'fp{int(X * 100)}'] = ('down' if dn >= 0 and (up < 0 or dn <= up) else ('up' if up >= 0 else 'none'))
            j0 = first_true(c[b + 1:e + 1] < Pk)
            rec['h_below_pk'] = j0 + 1 if j0 >= 0 else np.nan


def forward30(rec, c, hi, a, last, listed):
    C0 = c[a]
    e30 = min(a + 720, last)
    if e30 - a >= 720 or not listed:
        cseg = c[a + 1:e30 + 1]
        jb = first_true(cseg < C0)
        rec['h_below_alert'] = jb + 1 if jb >= 0 else np.nan
        rec['below_alert_30d'] = bool(jb >= 0)
        rec['peak30'] = np.nanmax(hi[a + 1:e30 + 1]) / C0 - 1
        rec['peak30_h'] = int(np.nanargmax(hi[a + 1:e30 + 1])) + 1
        rec['r720'] = c[e30] / C0 - 1 if c[e30] > 0 else np.nan


def main():
    files = sorted(glob.glob(os.path.join(RAW, 'spot1h/*.parquet')))
    mfn = os.path.join(RAW, 'logclose.npy')
    if os.path.exists(mfn):
        LC = np.load(mfn)
    else:
        LC, names = build_market(files)
        np.save(mfn, LC)
        json.dump(names, open(os.path.join(RAW, 'logclose_names.json'), 'w'))
    names = json.load(open(os.path.join(RAW, 'logclose_names.json')))
    btc = np.exp(LC[names.index('BTCUSDT')].astype(float))
    win = []      # (row, column, b, e): market windows filled in one vectorized pass at the end
    P = pd.read_parquet(os.path.join(RAW, 'prints.parquet'))
    allp = P.copy()
    P = P[P.pushed].copy()
    # market breadth: pushed alerts across all coins in the 24h before each alert
    at = np.sort(P.open_time.values)
    P['breadth24'] = np.searchsorted(at, P.open_time.values, side='left') - np.searchsorted(at, P.open_time.values - 24 * H, side='left')
    rows, ctrl, cwin = [], [], []
    for sym, g in P.groupby('symbol'):
        df = pd.read_parquet(os.path.join(RAW, f'spot1h/{sym}.parquet'))
        A = grid(df)
        o, hi, lo, c, qv, tb = A['open'], A['high'], A['low'], A['close'], A['quote_volume'], A['taker_buy_quote_volume']
        last = int(np.flatnonzero(~np.isnan(c))[-1])
        listed = bool(g.listed_now.iloc[0])
        pushed_idx = ((allp[(allp.symbol == sym) & allp.pushed].open_time.values - G0) // H).astype(int)
        for r in g.itertuples():
            a = int((r.open_time - G0) // H)
            C0, H0, base = c[a], hi[a], r.base48
            if not (C0 > 0) or not (base > 0):
                continue
            pre = {}
            for nm, d in (('pre24', 24), ('pre7d', 168), ('pre30d', 720)):
                pre[nm] = C0 / c[a - d] - 1 if a - d >= 0 and c[a - d] > 0 else np.nan
            for nm, d in (('dist_hi30', 720), ('dist_hi90', 2160)):
                w = hi[max(0, a - d):a]
                pre[nm] = C0 / np.nanmax(w) - 1 if np.sum(~np.isnan(w)) > d * 0.5 else np.nan
            rng = hi[a] - lo[a]
            pre['upper_wick'] = (hi[a] - max(o[a], c[a])) / rng if rng > 0 else np.nan
            pre['tb_alert'] = tb[a] / qv[a] if qv[a] > 0 else np.nan
            pre['btc_pre24'] = btc[a] / btc[a - 24] - 1 if a >= 24 else np.nan
            pre['btc_pre7d'] = btc[a] / btc[a - 168] - 1 if a >= 168 else np.nan
            win.append((len(rows), 'mkt_pre24', a - 24, a))
            win.append((len(rows), 'mkt_pre7d', a - 168, a))
            pre['age_days'] = (r.open_time - r.first_bar) / 86_400_000
            pre['young'] = (r.first_bar > G0 + 2 * H) and pre['age_days'] < 180
            for k in K:
                b = a + k
                if b > last:
                    break
                Pk = c[b]
                if not (Pk > 0):
                    continue
                rec = {'symbol': sym, 'ts': r.ts, 'k': k, 'listed_now': listed}
                seg = slice(a + 1, b + 1)
                if k > 0:
                    v = qv[seg]
                    if np.isnan(v).mean() > 0.2:
                        continue
                    rec['p_k'] = Pk / C0 - 1
                    rec['hi_k'] = np.nanmax(hi[seg]) / C0 - 1
                    rec['new_high_k'] = bool(np.nanmax(hi[seg]) > H0)
                    rec['dd_k'] = Pk / np.nanmax(hi[a:b + 1]) - 1
                    rec['v_k'] = np.nanmean(v) / base
                    rec['v_last_k'] = qv[b] / base if qv[b] == qv[b] else np.nan
                    rec['v_last3_k'] = np.nanmean(qv[max(a + 1, b - 2):b + 1]) / base
                    rec['v_decay_k'] = np.nanmean(v) / qv[a] if qv[a] > 0 else np.nan
                    if k >= 2:
                        h2 = k // 2
                        f1, f2 = np.nanmean(v[:h2]), np.nanmean(v[h2:])
                        rec['v_trend_k'] = f2 / f1 if f1 > 0 else np.nan
                    rec['tb_k'] = np.nansum(tb[seg]) / np.nansum(v) if np.nansum(v) > 0 else np.nan
                    rec['realert_k'] = int(((pushed_idx > a) & (pushed_idx <= b)).sum())
                    rec['green_k'] = float(np.nanmean(c[seg] > o[seg]))
                    win.append((len(rows), 'mkt_k', a, b))
                forward(rec, c, hi, lo, b, last, listed, win, len(rows))
                if k == 0:
                    forward30(rec, c, hi, a, last, listed)
                    rec.update({x: getattr(r, x) for x in ('ratio', 'tradeRatio', 'barPct', 'volZ', 'barZ', 'run24Z', 'liq30d',
                                                          'e20', 'cal', 'tier', 'prior72', 'breadth24', 'quote_volume', 'base48')})
                    rec.update(pre)
                rows.append(rec)
        # control: ordinary hours on the same coin, nowhere near any up print (72h before to 14d after)
        rng = np.random.default_rng(zlib.crc32(sym.encode()))
        near = np.zeros(NG, bool)
        for p in ((allp[allp.symbol == sym].open_time.values - G0) // H).astype(int):
            near[max(0, p - 72):p + 337] = True
        lo_i = int((pd.Timestamp('2023-01-01', tz='UTC').timestamp() * 1000 - G0) // H)
        cand = np.flatnonzero(~near & (c > 0) & (qv > 0) & (np.arange(NG) >= lo_i) & (np.arange(NG) <= last - (0 if not listed else 336)))
        for a in rng.choice(cand, size=min(len(cand), 2 * len(g)), replace=False) if len(cand) else []:
            rec = {'symbol': sym, 'ts': pd.Timestamp(G0 + int(a) * H, unit='ms', tz='UTC'), 'k': 0, 'listed_now': listed}
            forward(rec, c, hi, lo, int(a), last, listed, cwin, len(ctrl))
            forward30(rec, c, hi, int(a), last, listed)
            ctrl.append(rec)
    D = pd.DataFrame(rows)
    W = pd.DataFrame(win, columns=['row', 'col', 'b', 'e'])
    W = W[W.b >= 0]
    W['m'] = mwin(LC, W.b.values, W.e.values)
    for col, g in W.groupby('col'):
        D.loc[g.row.values, col] = g.m.values
    for fh in FWD:
        D[f'x{fh}'] = D[f'x{fh}'] - D[f'm{fh}']
    D.to_parquet(os.path.join(RAW, 'panel.parquet'), index=False)
    C = pd.DataFrame(ctrl)
    W = pd.DataFrame(cwin, columns=['row', 'col', 'b', 'e'])
    W['m'] = mwin(LC, W.b.values, W.e.values)
    for col, g in W.groupby('col'):
        C.loc[g.row.values, col] = g.m.values
    for fh in FWD:
        C[f'x{fh}'] = C[f'x{fh}'] - C[f'm{fh}']
    C.to_parquet(os.path.join(RAW, 'control.parquet'), index=False)
    print('control', C.shape)
    print(D.shape, D.groupby('k').size().to_dict())


if __name__ == '__main__':
    main()
