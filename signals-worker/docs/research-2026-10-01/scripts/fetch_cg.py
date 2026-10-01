import json, time, os, urllib.request, urllib.error
mp = json.load(open("cg/map.json"))
# MOVR first so the case study never waits on the queue
order = ["MOVR"] + sorted(c for c in mp if c != "MOVR")
days = "1100"
def get(u):
    for i in range(8):
        try:
            return json.loads(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "fcs-research"}), timeout=30).read())
        except urllib.error.HTTPError as e:
            body = e.read()[:300].decode(errors="ignore")
            if e.code == 429: time.sleep(65); continue
            return {"_err": e.code, "_body": body}
        except Exception: time.sleep(10)
    return {"_err": "gave up"}
for c in order:
    out = f"cg/{c}.json"
    if os.path.exists(out): continue
    j = get(f"https://api.coingecko.com/api/v3/coins/{mp[c]}/market_chart?vs_currency=usd&days={days}&interval=daily")
    if "_err" in j and days == "1100":
        print("1100 refused:", j, flush=True); days = "365"
        j = get(f"https://api.coingecko.com/api/v3/coins/{mp[c]}/market_chart?vs_currency=usd&days={days}&interval=daily")
    json.dump(j, open(out, "w")); print(c, days, len(j.get("market_caps", [])), flush=True)
    time.sleep(13)
print("done")
