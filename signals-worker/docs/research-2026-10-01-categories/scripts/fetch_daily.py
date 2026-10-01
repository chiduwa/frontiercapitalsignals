"""Binance spot daily klines (USDT pairs) from 2019-01-01, data-api mirror."""
import json, os, time, urllib.request
import numpy as np
from concurrent.futures import ThreadPoolExecutor
B = "https://data-api.binance.vision/api/v3"
def get(u):
    for i in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "fcs-research"}), timeout=30) as r: return json.loads(r.read())
        except Exception: time.sleep(2 ** i)
    return None
info = get(f"{B}/exchangeInfo")
STABLE = {"USDC","FDUSD","TUSD","BUSD","USDP","DAI","EUR","GBP","AEUR","EURI","USDE","XUSD","BFUSD","RLUSD","USD1","PAXG","WBTC","WBETH","BNSOL"}
syms = [s["baseAsset"] for s in info["symbols"] if s["status"] == "TRADING" and s["quoteAsset"] == "USDT" and s["baseAsset"] not in STABLE
        and s["baseAsset"].isascii() and s["baseAsset"].isalnum() and not s["baseAsset"].endswith(("UP", "DOWN", "BULL", "BEAR"))]
start = 1546300800000
def one(sym):
    out = f"daily/{sym}.npz"
    if os.path.exists(out): return
    rows, t = [], start
    while True:
        j = get(f"{B}/klines?symbol={sym}USDT&interval=1d&startTime={t}&limit=1000")
        if not j: break
        rows += j
        if len(j) < 1000: break
        t = j[-1][0] + 86400000
    if rows:
        np.savez_compressed(out, t=np.array([r[0] for r in rows], dtype=np.int64),
                            s=np.array([[float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[7])] for r in rows]))
with ThreadPoolExecutor(6) as ex: list(ex.map(one, syms))
print("done", len(syms), flush=True)
