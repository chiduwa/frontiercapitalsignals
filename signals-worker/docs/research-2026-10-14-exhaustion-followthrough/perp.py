"""USDT-M perp state at each checkpoint, for alerts on coins that had a perp at the time.

Sources (data.binance.vision, parsed in memory, nothing written but the result):
  monthly 1h klines + 1h premiumIndexKlines + fundingRate for the months around each alert,
  daily metrics (5m OI, long/short ratios, taker ratio) for alert day -1 .. +3,
  daily files for October 2026 (no monthly yet).
Perp <-> spot: same name, or a 1000/10000/1000000/1M-prefixed contract (price scaled).
Delisted perps are included (symbol list from the S3 listing).

Per (alert, k), with T0 = alert close and Tk = T0 + k hours, only data at or before Tk:
  fund_k    last settled funding rate at Tk
  prem_k    premium index, close of the 1h bar ending at Tk; prem_avg_k mean over (T0, Tk]
  oi_k      contracts OI(Tk) / OI(T0) - 1   (metrics row stamped T is a snapshot at T+5m)
  oi_pre24  OI(T0) / OI(T0 - 24h) - 1
  gls_k     all-account long/short ratio change since T0; tpl_k top-trader position ratio change
  taker_k   mean 5m taker buy/sell volume ratio over (T0, Tk]
  pvol_k    perp quote volume / spot quote volume over (T0, Tk]   (k = 0: the alert hour)
Output: RAW/perp_feats.parquet keyed by (symbol, ts, k)
"""
import io, os, re, sys, time, zipfile, urllib.request, urllib.error
import concurrent.futures as cf
import numpy as np, pandas as pd

RAW = os.environ.get('RAW', os.path.join(os.path.dirname(__file__), '../../reports/scenarios/2026-10-14-followthrough/raw'))
UA = {'User-Agent': 'Mozilla/5.0 FCS research'}
H = 3_600_000
K = [0, 1, 2, 4, 8, 12, 24, 48, 72]
KL = ['open_time', 'open', 'high', 'low', 'close', 'volume', 'close_time', 'quote_volume', 'count',
      'taker_buy_volume', 'taker_buy_quote_volume', 'ignore']
LAG = 300_000


def get(url, tries=5):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (400, 403, 404):
                return None
            time.sleep(2 * (i + 1))
        except Exception:
            time.sleep(2 * (i + 1))
    return None


def perp_symbols():
    syms, marker = [], ''
    while True:
        x = get('https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?delimiter=/&prefix=data/futures/um/monthly/klines/'
                + ('&marker=' + marker if marker else ''))
        ps = re.findall(r'<Prefix>data/futures/um/monthly/klines/([^<]+)/</Prefix>', x.decode())
        syms += ps
        if b'<IsTruncated>true</IsTruncated>' not in x or not ps:
            break
        marker = 'data/futures/um/monthly/klines/' + ps[-1] + '/'
    # pairs listed only recently have daily files but no monthly ones yet
    return set(syms)


def csv_zip(b, cols=None):
    with zipfile.ZipFile(io.BytesIO(b)) as z:
        raw = z.read(z.namelist()[0])
    first = raw[:200].decode(errors='ignore').split('\n')[0]
    hdr = any(c.isalpha() for c in first.split(',')[0])
    df = pd.read_csv(io.BytesIO(raw), header=0 if hdr else None)
    if not hdr and cols:
        df.columns = cols[:df.shape[1]]
    return df


def ms(s):
    s = s.astype('int64').values
    return np.where(s > 10**14, s // 1000, s)


def asof(t, v, x, tol=None):
    """Last value at or before x; NaN if none, or if it is older than tol ms."""
    i = np.searchsorted(t, x, side='right') - 1
    if i < 0 or (tol is not None and x - t[i] > tol):
        return np.nan
    return v[i]


def one(perp, mult, alerts, spot):
    """alerts: DataFrame (symbol, ts, open_time) for this perp."""
    days = set(); months = set()
    for t in alerts.open_time.values:
        for d in range(-1, 4):
            day = pd.Timestamp(int(t) + d * 86_400_000, unit='ms', tz='UTC')
            if day >= pd.Timestamp('2026-10-14', tz='UTC'):
                continue
            days.add(day.strftime('%Y-%m-%d'))
            months.add(day.strftime('%Y-%m'))
    B = 'https://data.binance.vision/data/futures/um/'
    jobs = []      # (kind, url)
    for mo in sorted(months):
        if mo >= '2026-10':
            continue
        jobs += [('kl', f'{B}monthly/klines/{perp}/1h/{perp}-1h-{mo}.zip'),
                 ('pr', f'{B}monthly/premiumIndexKlines/{perp}/1h/{perp}-1h-{mo}.zip'),
                 ('fu', f'{B}monthly/fundingRate/{perp}/{perp}-fundingRate-{mo}.zip')]
    for d in sorted(days):
        jobs.append(('mt', f'{B}daily/metrics/{perp}/{perp}-metrics-{d}.zip'))
        if d >= '2026-10-01':
            jobs += [('kl', f'{B}daily/klines/{perp}/1h/{perp}-1h-{d}.zip'),
                     ('pr', f'{B}daily/premiumIndexKlines/{perp}/1h/{perp}-1h-{d}.zip')]
    with cf.ThreadPoolExecutor(16) as ex:
        blobs = list(ex.map(lambda j: get(j[1]), jobs))
    kl, pr, fu, mt = [], [], [], []
    for (kind, _), b in zip(jobs, blobs):
        if not b:
            continue
        if kind == 'kl':
            kl.append(csv_zip(b, KL))
        elif kind == 'pr':
            pr.append(csv_zip(b, KL))
        elif kind == 'fu':
            fu.append(csv_zip(b, ['calc_time', 'funding_interval_hours', 'last_funding_rate']))
        else:
            mt.append(csv_zip(b))
    if not kl:
        return []
    k = pd.concat(kl); k['t'] = ms(k.open_time); k = k.drop_duplicates('t').sort_values('t')
    kt, kq = k.t.values, k.quote_volume.astype(float).values
    if pr:
        p = pd.concat(pr); p['t'] = ms(p.open_time); p = p.drop_duplicates('t').sort_values('t')
        pt, pc = p.t.values, p.close.astype(float).values
    else:
        pt, pc = np.array([], dtype='int64'), np.array([])
    if fu:
        f = pd.concat(fu); f['t'] = ms(f.calc_time); f = f.drop_duplicates('t').sort_values('t')
        ft, fr = f.t.values, f.last_funding_rate.astype(float).values
    else:
        ft, fr = np.array([], dtype='int64'), np.array([])
    if mt:
        m = pd.concat(mt)
        m['t'] = pd.to_datetime(m.create_time, utc=True).astype('int64') // 10**6 + LAG
        m = m.drop_duplicates('t').sort_values('t')
        mtt = m.t.values
        oi = m.sum_open_interest.astype(float).values
        gls = m.count_long_short_ratio.astype(float).values
        tpl = m.sum_toptrader_long_short_ratio.astype(float).values
        tkr = m.sum_taker_long_short_vol_ratio.astype(float).values
    else:
        mtt = None
    st, sq = spot
    rows = []
    for r in alerts.itertuples():
        T0 = int(r.open_time) + H
        if not len(kt) or kt[0] > T0 - H or kt[-1] < T0 - H:
            continue                                   # no perp at the alert hour
        oi0 = asof(mtt, oi, T0, 900_000) if mtt is not None else np.nan
        for kk in K:
            Tk = T0 + kk * H
            if Tk > kt[-1] + H:
                break
            rec = {'symbol': r.symbol, 'ts': r.ts, 'k': kk, 'perp': perp}
            rec['fund_k'] = asof(ft, fr, Tk, 9 * H) if len(ft) else np.nan
            if len(pt):
                rec['prem_k'] = asof(pt, pc, Tk - H, 0)
                a, b = np.searchsorted(pt, T0), np.searchsorted(pt, Tk)
                rec['prem_avg_k'] = pc[a:b].mean() if b > a else rec['prem_k']
            lo, hi = (T0 - H, T0) if kk == 0 else (T0, Tk)
            a, b = np.searchsorted(kt, lo), np.searchsorted(kt, hi)
            sa, sb = np.searchsorted(st, lo), np.searchsorted(st, hi)
            pq, sv = kq[a:b].sum(), np.nansum(sq[sa:sb])
            rec['pvol_k'] = pq / sv if sv > 0 and b > a else np.nan
            if mtt is not None:
                ok = asof(mtt, oi, Tk, 900_000)
                rec['oi_k'] = ok / oi0 - 1 if oi0 > 0 else np.nan
                if kk == 0:
                    o24 = asof(mtt, oi, T0 - 24 * H, 900_000)
                    rec['oi_pre24'] = oi0 / o24 - 1 if o24 > 0 else np.nan
                    o4 = asof(mtt, oi, T0 - 4 * H, 900_000)
                    rec['oi_pre4'] = oi0 / o4 - 1 if o4 > 0 else np.nan
                g0, gk = asof(mtt, gls, T0, 900_000), asof(mtt, gls, Tk, 900_000)
                rec['gls_k'] = gk / g0 - 1 if g0 > 0 else np.nan
                rec['gls_lvl_k'] = gk
                t0_, tk_ = asof(mtt, tpl, T0, 900_000), asof(mtt, tpl, Tk, 900_000)
                rec['tpl_k'] = tk_ / t0_ - 1 if t0_ > 0 else np.nan
                j1, j2 = np.searchsorted(mtt, (T0 - H) if kk == 0 else T0, side='right'), np.searchsorted(mtt, Tk, side='right')
                rec['taker_k'] = np.nanmean(tkr[j1:j2]) if j2 > j1 else np.nan
            rows.append(rec)
    return rows


def main():
    P = pd.read_parquet(os.path.join(RAW, 'prints.parquet'))
    P = P[P.pushed & (P.ts < '2026-10-12')]
    perps = perp_symbols()
    print(len(perps), 'perp symbols in the archive', flush=True)
    pairs = []
    for s in sorted(P.symbol.unique()):
        base = s[:-4]
        for pre, mult in (('', 1), ('1000', 1000), ('10000', 10000), ('1000000', 1e6), ('1M', 1e6)):
            if pre + base + 'USDT' in perps:
                pairs.append((s, pre + base + 'USDT', mult))
                break
    print(len(pairs), 'spot coins with a perp', flush=True)

    def job(x):
        s, perp, mult = x
        sp = pd.read_parquet(os.path.join(RAW, f'spot1h/{s}.parquet'), columns=['open_time', 'quote_volume'])
        try:
            return one(perp, mult, P[P.symbol == s][['symbol', 'ts', 'open_time']], (sp.open_time.values, sp.quote_volume.values))
        except Exception as e:
            print('fail', perp, e, flush=True)
            return []
    rows = []
    with cf.ThreadPoolExecutor(6) as ex:
        for i, rr in enumerate(ex.map(job, pairs)):
            rows += rr
            if (i + 1) % 25 == 0:
                print(i + 1, len(rows), flush=True)
    D = pd.DataFrame(rows)
    D.to_parquet(os.path.join(RAW, 'perp_feats.parquet'), index=False)
    print(D.shape, D.drop_duplicates(['symbol', 'ts']).shape[0], 'alerts with perp data', flush=True)


if __name__ == '__main__':
    main()
