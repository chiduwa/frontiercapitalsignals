"""Binance spot daily candles (close, quote volume) for every currently tradable
USDT pair, 2021-01-01 to 2026-09-27, for rotation_replay.mjs.

usage: python fetch_daily_all.py binance_tradable.json daily_all.json"""
import json, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
pairs = json.load(open(sys.argv[1])); out_path = sys.argv[2]
START = 1609459200000; END = 1790467200000   # 2021-01-01 .. 2026-09-27 00:00 UTC
def get(url):
    for k in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'fcs-research'}), timeout=30) as r:
                return json.loads(r.read())
        except Exception:
            time.sleep(1.5 ** k)
    return None
def fetch(sym):
    t, rows = START, []
    while t <= END:
        page = get(f'https://data-api.binance.vision/api/v3/klines?symbol={sym}USDT&interval=1d&startTime={t}&endTime={END}&limit=1000')
        if not page: break
        rows += [[int(k[0]), float(k[4]), float(k[7])] for k in page]
        if len(page) < 1000: break
        t = page[-1][0] + 86400000
    return sym, rows
res = {}
with ThreadPoolExecutor(4) as ex:
    for sym, rows in ex.map(fetch, pairs):
        if len(rows) >= 60: res[sym] = rows
json.dump(res, open(out_path, 'w'))
print(len(res), 'pairs with 60+ days')
