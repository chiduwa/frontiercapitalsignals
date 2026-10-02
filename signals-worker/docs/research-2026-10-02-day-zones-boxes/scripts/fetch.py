"""Hourly Binance spot klines for the eight always-tracked coins (full history),
and Yahoo daily bars for the major US stocks and index ETFs."""
import json, os, sys, time, urllib.request
import numpy as np
from concurrent.futures import ThreadPoolExecutor
OUT = os.environ.get("DZ_DATA", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "reports", "day-zones"))   # fetch.py writes h1/ and d1s/ here (gitignored)
os.makedirs(os.path.join(OUT, 'h1'), exist_ok=True); os.makedirs(os.path.join(OUT, 'd1s'), exist_ok=True)
B = "https://data-api.binance.vision/api/v3/klines"
def get(u, tries=6):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0 fcs-research"}), timeout=30) as r: return json.loads(r.read())
        except Exception as e:
            time.sleep(2 ** i)
    return None
def hourly(sym):
    rows, t = [], 1483228800000
    while True:
        j = get(f"{B}?symbol={sym}USDT&interval=1h&startTime={t}&limit=1000")
        if not j: break
        rows += j
        if len(j) < 1000: break
        t = j[-1][0] + 3600000
    a = np.array([[float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[7])] for r in rows])
    np.savez_compressed(f"{OUT}/h1/{sym}.npz", t=np.array([r[0] for r in rows], dtype=np.int64), s=a)
    return sym, len(rows)
def yahoo(tk):
    j = get(f"https://query1.finance.yahoo.com/v8/finance/chart/{tk}?period1=0&period2={int(time.time())}&interval=1d")
    r = j["chart"]["result"][0]; q = r["indicators"]["quote"][0]
    t = np.array(r["timestamp"], dtype=np.int64) * 1000
    a = np.array([[q[k][i] if q[k][i] is not None else np.nan for k in ("open", "high", "low", "close", "volume")] for i in range(len(t))], dtype=float)
    adj = r["indicators"].get("adjclose", [{}])[0].get("adjclose")
    if adj: a = np.c_[a, np.array([x if x is not None else np.nan for x in adj])]
    np.savez_compressed(f"{OUT}/d1s/{tk}.npz", t=t, s=a)
    return tk, len(t)
with ThreadPoolExecutor(4) as ex:
    print(list(ex.map(hourly, ["BTC", "ETH", "SOL", "XLM", "XRP", "HYPE", "HBAR", "ARB"])), flush=True)
    print(list(ex.map(yahoo, ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "AVGO"])), flush=True)
