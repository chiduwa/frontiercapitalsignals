"""Pull Binance-global spot klines (USDT pairs) for exhaustion research.

Source: data-api.binance.vision (the public market-data mirror, reachable from
this Mac; api.binance.com is HTTP 451 here). One .npz per symbol.

usage: python3 fetch_klines.py <interval> <start YYYY-MM-DD> <outdir> [max_symbols]
"""
import json, sys, time, os, urllib.request, urllib.error, threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import numpy as np

BASE = "https://data-api.binance.vision/api/v3"
interval, start, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
max_symbols = int(sys.argv[4]) if len(sys.argv) > 4 else 10_000
os.makedirs(outdir, exist_ok=True)
start_ms = int(datetime.strptime(start, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)
step_ms = {"1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}[interval]

def get(url, tries=6):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "fcs-research"}), timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (418, 429) or e.code >= 500:
                time.sleep(2 ** i); continue
            raise
        except Exception:
            time.sleep(2 ** i)
    raise RuntimeError("gave up: " + url)

info = get(f"{BASE}/exchangeInfo")
STABLE = {"USDC", "FDUSD", "TUSD", "BUSD", "USDP", "DAI", "EUR", "GBP", "AEUR", "EURI", "USDE", "XUSD", "BFUSD", "RLUSD", "USD1", "PAXG", "WBTC", "WBETH", "BNSOL"}
syms = [s["baseAsset"] for s in info["symbols"]
        if s["status"] == "TRADING" and s["quoteAsset"] == "USDT" and s["baseAsset"] not in STABLE
        and not any(s["baseAsset"].endswith(x) for x in ("UP", "DOWN", "BULL", "BEAR"))
        and s["baseAsset"].isascii() and s["baseAsset"].isalnum()]
syms = syms[:max_symbols]
print(f"{len(syms)} symbols, interval {interval}, from {start}", flush=True)

lock = threading.Lock()
done = [0]

def fetch(sym):
    path = os.path.join(outdir, f"{sym}.npz")
    if os.path.exists(path):
        return
    rows, t = [], start_ms
    now_ms = int(time.time() * 1000)
    while t < now_ms:
        j = get(f"{BASE}/klines?symbol={sym}USDT&interval={interval}&startTime={t}&limit=1000")
        if not j:
            break
        rows.extend(j)
        nxt = j[-1][0] + step_ms
        if nxt <= t or len(j) < 1000:
            break
        t = nxt
        time.sleep(0.05)
    if rows:
        a = np.array([[r[0], float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5]), float(r[7]), float(r[8]), float(r[10])] for r in rows], dtype=np.float64)
        # drop the still-forming bar
        a = a[a[:, 0] + step_ms <= now_ms]
        np.savez_compressed(path, t=a[:, 0].astype(np.int64), o=a[:, 1], h=a[:, 2], l=a[:, 3], c=a[:, 4],
                            v=a[:, 5], qv=a[:, 6], n=a[:, 7], tbq=a[:, 8])
    with lock:
        done[0] += 1
        if done[0] % 25 == 0:
            print(f"  {done[0]}/{len(syms)}", flush=True)

with ThreadPoolExecutor(max_workers=6) as ex:
    list(ex.map(fetch, syms))
print("done", flush=True)
