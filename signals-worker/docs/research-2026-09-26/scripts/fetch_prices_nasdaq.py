"""Daily split-adjusted history (max 10y) from Nasdaq's public quote API,
reduced to weekly rows (last trading day of each ISO week) to keep it small.
Yahoo rate-limited this Mac mid-download, so this is the backtest's price
source. Prices are NOT dividend-adjusted, which understates dividend payers'
returns, i.e. biases against profitable companies. Stated, not corrected."""
import json, os, sys, time, threading, urllib.request, urllib.error
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "pxn")
OUTD = os.path.join(HERE, "pxd")
os.makedirs(OUT, exist_ok=True)
os.makedirs(OUTD, exist_ok=True)
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
TODAY = datetime.utcnow().strftime("%Y-%m-%d")
universe = [r for r in json.load(open(os.path.join(HERE, "universe.json"))) if r["mcap"] >= 50e6]
print(f"{len(universe)} symbols", flush=True)
lock = threading.Lock(); st = {"done": 0, "none": 0, "err": 0}

def num(x):
    try: return float(str(x).replace("$", "").replace(",", ""))
    except Exception: return None

def fetch(row):
    sym = row["symbol"]
    path = os.path.join(OUT, f"{sym}.json")
    dpath = os.path.join(OUTD, f"{sym}.json")
    if (os.path.exists(path) and os.path.exists(dpath)) or os.path.exists(path + ".none"):
        return
    url = (f"https://api.nasdaq.com/api/quote/{sym}/historical?assetclass=stocks"
           f"&fromdate=2015-01-01&limit=9999&todate={TODAY}")
    data = None
    for i in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=45) as r:
                data = json.loads(r.read())
            break
        except urllib.error.HTTPError as e:
            if e.code == 404: break
            time.sleep(3 * (i + 1))
        except Exception:
            time.sleep(3 * (i + 1))
    rows = (((data or {}).get("data") or {}).get("tradesTable") or {}).get("rows") or []
    if not rows:
        open(path + ".none", "w").close()
        with lock: st["none"] += 1
    else:
        daily = []
        for r in rows:
            try:
                daily.append((datetime.strptime(r["date"], "%m/%d/%Y").strftime("%Y-%m-%d"),
                              num(r["open"]), num(r["high"]), num(r["low"]), num(r["close"]), num(r["volume"])))
            except Exception:
                pass
        daily.sort()
        json.dump({k: [x[i] for x in daily] for i, k in enumerate(("d", "o", "h", "l", "c", "v"))}, open(dpath, "w"))
        wk = {}
        for r in rows:
            try:
                d = datetime.strptime(r["date"], "%m/%d/%Y")
            except Exception:
                continue
            c, v = num(r["close"]), num(r["volume"])
            if c is None: continue
            key = d.isocalendar()[:2]
            prev = wk.get(key)
            dv = (c * v) if v is not None else 0.0
            if prev is None:
                wk[key] = [d.strftime("%Y-%m-%d"), c, dv]
            else:
                if d.strftime("%Y-%m-%d") > prev[0]:
                    prev[0], prev[1] = d.strftime("%Y-%m-%d"), c
                prev[2] += dv
        out = sorted(wk.values())
        json.dump({"d": [x[0] for x in out], "c": [x[1] for x in out], "dv": [x[2] for x in out]}, open(path, "w"))
    with lock:
        st["done"] += 1
        if st["done"] % 250 == 0:
            print(f"  {st['done']}/{len(universe)} (no data {st['none']})", flush=True)

with ThreadPoolExecutor(max_workers=6) as ex:
    list(ex.map(fetch, universe))
print("nasdaq prices done", flush=True)
