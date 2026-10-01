"""Spot 1h klines 2026-08-01 -> now for every coin in the cached panel (data-api mirror)."""
import json, os, sys, time, glob, urllib.request
import numpy as np
from concurrent.futures import ThreadPoolExecutor
OLD = "/private/tmp/claude-501/-Users-owner/b677f588-0ff8-4f26-8c37-a5e343026c67/scratchpad/exh/data"
OUT = sys.argv[1]
start = 1785542400000  # 2026-08-01
def get(u):
    for i in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "fcs-research"}), timeout=30) as r: return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 400: return None
            time.sleep(2 ** i)
        except Exception: time.sleep(2 ** i)
    return None
def one(f):
    coin = os.path.basename(f)[:-4]; out = os.path.join(OUT, coin + ".npz")
    if os.path.exists(out): return
    z = np.load(f)
    if "spot" not in z.files: return
    sym = str(z["spot"][0]); rows = []; t = start
    while True:
        j = get(f"https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval=1h&startTime={t}&limit=1000")
        if not j: break
        rows += j
        if len(j) < 1000: break
        t = j[-1][0] + 3600000
    if not rows: return
    a = np.array([[float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[7]), float(r[8]), float(r[10])] for r in rows])
    np.savez_compressed(out, t=np.array([r[0] for r in rows], dtype=np.int64), s=a)
with ThreadPoolExecutor(8) as ex: list(ex.map(one, sorted(glob.glob(OLD + "/*.npz"))))
print("done", len(os.listdir(OUT)))
