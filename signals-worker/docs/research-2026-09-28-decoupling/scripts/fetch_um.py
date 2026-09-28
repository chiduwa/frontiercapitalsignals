"""Binance USD-M perpetual history for the decoupling study, from the public
bulk mirror (data.binance.vision; api.binance.com is HTTP 451 from here).

Per symbol, two arrays in <outdir>/<SYMBOL>.npz:
  klines  1-hour bars: open_time_ms, open, high, low, close, volume,
          quote_volume, trades, taker_buy_volume, taker_buy_quote_volume
  metrics 5-minute rows: create_time_ms, open interest (contracts),
          open interest (USD), top-trader account long/short ratio,
          top-trader position long/short ratio, all-account long/short ratio,
          taker buy/sell volume ratio
A metrics row stamped T is the snapshot taken at T + 5 minutes
(OI_MEASUREMENT_EVIDENCE.md), which the study accounts for.

usage: python fetch_um.py <outdir> <first YYYY-MM-DD> <last YYYY-MM-DD> SYM [SYM ...]
Monthly kline files cover whole months; the current month comes from daily
files. Resumable: finished symbols are skipped.
"""
import csv, io, os, sys, time, zipfile, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
import numpy as np

B = 'https://data.binance.vision/data/futures/um'


def get(url, tries=5):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'fcs-research'}), timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            time.sleep(1.5 ** i)
        except Exception:
            time.sleep(1.5 ** i)
    return None


def rows(blob):
    if not blob: return []
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        text = z.read(z.namelist()[0]).decode()
    out = list(csv.reader(io.StringIO(text)))
    return out[1:] if out and not out[0][0][:1].isdigit() else out


def ts(s):
    return int(np.datetime64(s.replace(' ', 'T'), 'ms').astype('int64'))


def fetch_symbol(sym, first, last, outdir, pool):
    dest = os.path.join(outdir, f'{sym}.npz')
    if os.path.exists(dest): return sym, 'cached'
    pair = f'{sym}USDT'
    months = [str(m) for m in np.arange(np.datetime64(first[:7]), np.datetime64(last[:7]))]
    this_month_days = [str(d) for d in np.arange(np.datetime64(last[:7] + '-01'), np.datetime64(last) + 1)]
    kurls = [f'{B}/monthly/klines/{pair}/1h/{pair}-1h-{m}.zip' for m in months] + \
            [f'{B}/daily/klines/{pair}/1h/{pair}-1h-{d}.zip' for d in this_month_days]
    days = [str(d) for d in np.arange(np.datetime64(first), np.datetime64(last) + 1)]
    murls = [f'{B}/daily/metrics/{pair}/{pair}-metrics-{d}.zip' for d in days]
    kl = []
    for blob in pool.map(get, kurls):
        for r in rows(blob):
            kl.append([int(r[0]), *map(float, r[1:6]), float(r[7]), float(r[8]), float(r[9]), float(r[10])])
    me = []
    for blob in pool.map(get, murls):
        for r in rows(blob):
            f = lambda x: float(x) if x not in ('', None) else np.nan
            me.append([ts(r[0]), f(r[2]), f(r[3]), f(r[4]), f(r[5]), f(r[6]), f(r[7])])
    kl = np.array(sorted({r[0]: r for r in kl}.values()), dtype=float).reshape(-1, 10)
    me = np.array(sorted({r[0]: r for r in me}.values()), dtype=float).reshape(-1, 7)
    np.savez_compressed(dest, klines=kl, metrics=me)
    return sym, f'{len(kl)} hourly bars, {len(me)} five-minute rows'


if __name__ == '__main__':
    outdir, first, last, syms = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
    os.makedirs(outdir, exist_ok=True)
    with ThreadPoolExecutor(32) as pool:
        for s in syms:
            t0 = time.time()
            sym, msg = fetch_symbol(s, first, last, outdir, pool)
            print(f'{sym}: {msg} ({time.time() - t0:.0f}s)', flush=True)
