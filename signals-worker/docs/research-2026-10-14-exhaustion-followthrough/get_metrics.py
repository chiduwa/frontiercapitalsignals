"""5-minute futures metrics around every alert with a perp (alert day -2 .. +3), kept raw.

Binance daily `metrics` files: open interest in contracts and in USDT (their ratio is the
price at the snapshot), all-account and top-trader long/short ratios, taker buy/sell volume
ratio. A row stamped T is a snapshot taken at T+5m (checked in the 2026-10-12 study), so
t below is create_time + 5 minutes.
Output: RAW/metrics5m/<PERP>.parquet  (t, oi, oiv, px, gls, tpl, tal, taker)
"""
import io, json, os, sys, time, zipfile, urllib.request, urllib.error
import concurrent.futures as cf
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
from perp import get, csv_zip, RAW

OUT = os.path.join(RAW, 'metrics5m')
os.makedirs(OUT, exist_ok=True)


def one(perp, days):
    fn = os.path.join(OUT, f'{perp}.parquet')
    if os.path.exists(fn):
        return perp, 'cached'
    B = 'https://data.binance.vision/data/futures/um/daily/metrics'
    with cf.ThreadPoolExecutor(16) as ex:
        blobs = list(ex.map(lambda d: get(f'{B}/{perp}/{perp}-metrics-{d}.zip'), days))
    fr = [csv_zip(b) for b in blobs if b]
    if not fr:
        pd.DataFrame().to_parquet(fn)
        return perp, 0
    m = pd.concat(fr)
    m['t'] = pd.to_datetime(m.create_time, utc=True).astype('int64') // 10**6 + 300_000
    out = pd.DataFrame({'t': m.t.values,
                        'oi': m.sum_open_interest.astype('float64').values,
                        'oiv': m.sum_open_interest_value.astype('float64').values,
                        'gls': m.count_long_short_ratio.astype('float32').values,
                        'tpl': m.sum_toptrader_long_short_ratio.astype('float32').values,
                        'tal': m.count_toptrader_long_short_ratio.astype('float32').values,
                        'taker': m.sum_taker_long_short_vol_ratio.astype('float32').values})
    out['px'] = out.oiv / out.oi
    out = out.drop_duplicates('t').sort_values('t')
    out.to_parquet(fn, index=False)
    return perp, len(out)


def main():
    F = pd.read_parquet(os.path.join(RAW, 'perp_feats.parquet'))
    F = F[F.k == 0][['symbol', 'ts', 'perp']]
    jobs = []
    for perp, g in F.groupby('perp'):
        days = set()
        for t in g.ts:
            for d in range(-2, 4):
                day = (t + pd.Timedelta(days=d)).normalize()
                if day < pd.Timestamp('2026-10-14', tz='UTC'):
                    days.add(day.strftime('%Y-%m-%d'))
        jobs.append((perp, sorted(days)))
    print(len(jobs), 'perps', sum(len(d) for _, d in jobs), 'perp-days', flush=True)
    with cf.ThreadPoolExecutor(6) as ex:
        for i, (p, n) in enumerate(ex.map(lambda j: one(*j), jobs)):
            if (i + 1) % 25 == 0:
                print(i + 1, p, n, flush=True)
    print('done', flush=True)


if __name__ == '__main__':
    main()
