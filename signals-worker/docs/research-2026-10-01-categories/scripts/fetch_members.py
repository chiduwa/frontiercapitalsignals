"""Category membership via /coins/markets?category=<id>, top 500 by market cap per category."""
import json, os, time, urllib.request, urllib.error
from taxonomy import UTILITY, ECOSYSTEMS
known = {x["id"] for x in json.load(open("categories.json"))}
ids = sorted({c for _, cats in UTILITY.values() for c in cats} | set(ECOSYSTEMS))
missing = [c for c in ids if c not in known]
print("unknown ids skipped:", missing, flush=True)
ids = [c for c in ids if c in known]
mc = {x["id"]: (x.get("market_cap") or 0) for x in json.load(open("categories.json"))}
# biggest categories first; skip niche ones under $150M total (few of our coins, if any)
ids = sorted([c for c in ids if mc.get(c, 0) >= 1.5e8 or c in ECOSYSTEMS], key=lambda c: -mc.get(c, 0))
print(len(ids), "categories to fetch", flush=True)
def get(u):
    for i in range(8):
        try:
            return json.loads(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "fcs-research"}), timeout=30).read())
        except urllib.error.HTTPError as e:
            if e.code == 429: time.sleep(65); continue
            return []
        except Exception: time.sleep(10)
    return None
for c in ids:
    out = f"mem/{c}.json"
    if os.path.exists(out): continue
    rows = []
    for page in (1, 2):
        j = get(f"https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category={c}&order=market_cap_desc&per_page=250&page={page}")
        if j is None: break
        rows += [{"id": r["id"], "symbol": r["symbol"].upper(), "mcap": r.get("market_cap"), "rank": r.get("market_cap_rank")} for r in j]
        time.sleep(21)
        if len(j) < 250 or (j and (j[-1].get("market_cap") or 0) < 2e7): break
    json.dump(rows, open(out, "w")); print(c, len(rows), flush=True)
print("done", flush=True)
