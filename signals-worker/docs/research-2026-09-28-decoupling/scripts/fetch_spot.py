"""Binance spot hourly bars (the live scanner's own source, data-api.binance.vision)
for the same coins, saved in fetch_um.py's layout (<outdir>/<SYM>.npz, klines
only, no metrics) so decoupling_study.py can run on them unchanged.

usage: python fetch_spot.py <outdir> <first YYYY-MM-DD> <last YYYY-MM-DD> SYM [SYM ...]"""
import json, os, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np
BASE = 'https://data-api.binance.vision/api/v3/klines'


def get(url, tries=6):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'fcs-research'}), timeout=30) as r:
                return json.loads(r.read())
        except Exception:
            time.sleep(1.5 ** i)
    return None


def fetch(args):
    sym, first, last, outdir = args
    t = int(np.datetime64(first + 'T00:00', 'ms').astype('int64')); end = int((np.datetime64(last) + 1).astype('datetime64[ms]').astype('int64'))
    out = []
    while t < end:
        d = get(f'{BASE}?symbol={sym}USDT&interval=1h&startTime={t}&endTime={end - 1}&limit=1000')
        if not d: break
        out += d
        if len(d) < 1000: break
        t = d[-1][0] + 3600000
    kl = np.array([[k[0], *map(float, k[1:6]), float(k[7]), float(k[8]), float(k[9]), float(k[10])] for k in out], dtype=float).reshape(-1, 10)
    np.savez_compressed(os.path.join(outdir, f'{sym}.npz'), klines=kl, metrics=np.zeros((0, 7)))
    return sym, len(kl)


if __name__ == '__main__':
    outdir, first, last, syms = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
    os.makedirs(outdir, exist_ok=True)
    with ThreadPoolExecutor(6) as ex:
        for sym, n in ex.map(fetch, [(s, first, last, outdir) for s in syms]):
            print(f'{sym}: {n} hourly bars', flush=True)
