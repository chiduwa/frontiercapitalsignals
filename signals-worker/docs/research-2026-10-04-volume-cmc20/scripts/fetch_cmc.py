"""Pull CMC global metrics (daily + hourly) and BTC/ETH/SOL Binance klines for the
low-volume study. Keyless: CMC website data-api + Binance public data mirror."""
import json, time, urllib.request, os, sys
from datetime import datetime, timezone

OUT = os.path.dirname(os.path.abspath(__file__))
UA = {"User-Agent": "Mozilla/5.0"}


def get(url, tries=5):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                return json.loads(r.read())
        except Exception as e:
            print("retry", i, url[:120], e, file=sys.stderr)
            time.sleep(5 * (i + 1))
    raise RuntimeError(url)


def cmc_global(interval, start, end, step_days):
    base = "https://api.coinmarketcap.com/data-api/v3/global-metrics/quotes/historical"
    rows = {}
    t = start
    while t < end:
        t2 = min(end, t + step_days * 86400)
        j = get(f"{base}?format=chart_crypto_details&interval={interval}&timeStart={t}&timeEnd={t2}")
        for q in (j.get("data") or {}).get("quotes", []):
            u = q["quote"][0]
            rows[q["timestamp"]] = {
                "ts": q["timestamp"],
                "vol": u.get("totalVolume24H"),
                "vol_rep": u.get("totalVolume24HReported"),
                "alt_vol": u.get("altcoinVolume24H"),
                "mcap": u.get("totalMarketCap"),
                "alt_mcap": u.get("altcoinMarketCap"),
                "btc_dom": q.get("btcDominance"),
            }
        t = t2
        time.sleep(1.2)
    return [rows[k] for k in sorted(rows)]


def binance(symbol, interval, start_ms):
    out = []
    t = start_ms
    while True:
        j = get(f"https://data-api.binance.vision/api/v3/klines?symbol={symbol}&interval={interval}&startTime={t}&limit=1000")
        if not j:
            break
        out += [[k[0], float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[7])] for k in j]
        if len(j) < 1000:
            break
        t = j[-1][0] + 1
        time.sleep(0.25)
    return out


if __name__ == "__main__":
    now = int(time.time())
    what = sys.argv[1]
    if what == "daily":
        d = cmc_global("1d", 1367193600, now, 360)
        json.dump(d, open(f"{OUT}/cmc_global_daily.json", "w"))
        print("daily", len(d), d[0]["ts"], d[-1]["ts"])
    elif what == "hourly":
        d = cmc_global("1h", int(datetime(2019, 1, 1, tzinfo=timezone.utc).timestamp()), now, 30)
        json.dump(d, open(f"{OUT}/cmc_global_hourly.json", "w"))
        print("hourly", len(d), d[0]["ts"], d[-1]["ts"])
    elif what == "binance":
        for s in ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT"]:
            for iv in ["1d", "1h"]:
                k = binance(s, iv, int(datetime(2017, 8, 1, tzinfo=timezone.utc).timestamp() * 1000))
                json.dump(k, open(f"{OUT}/bn_{s}_{iv}.json", "w"))
                print(s, iv, len(k))
