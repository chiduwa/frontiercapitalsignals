import json, time, urllib.request, sys
from datetime import datetime, timedelta, timezone
name = sys.argv[1]  # cmc20 | cmc100
out = {}
cur = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
empty = 0
while empty < 2:
    url = f"https://pro-api.coinmarketcap.com/public-api/v3/index/{name}-historical?count=10&interval=daily&time_end={cur.strftime('%Y-%m-%dT%H:%M:%SZ')}"
    for attempt in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30) as r:
                j = json.loads(r.read()); break
        except urllib.error.HTTPError as e:
            j = None; time.sleep(30 * (attempt + 1))
        except Exception:
            j = None; time.sleep(10)
    rows = (j or {}).get("data") or []
    if not rows:
        empty += 1; cur -= timedelta(days=10); time.sleep(6); continue
    empty = 0
    for x in rows:
        out[x["update_time"][:10]] = {"date": x["update_time"][:10], "value": x["value"],
            "w": {(c.get("symbol") or c.get("id")): c.get("weight") for c in (x.get("constituents") or [])}}
    earliest = min(datetime.fromisoformat(x["update_time"].replace("Z", "+00:00")) for x in rows)
    if earliest > cur:          # the API hands back its first page once past the start: stop
        break
    cur = earliest - timedelta(days=1)
    time.sleep(6)
s = [out[k] for k in sorted(out)]
json.dump(s, open(f"{name}_daily.json", "w"))
print(name, len(s), s[0]["date"], s[-1]["date"])
