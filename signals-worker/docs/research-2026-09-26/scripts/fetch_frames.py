"""Download SEC XBRL 'frames' (one fact, every filer, one period) for the
profit-growth research. Each call returns thousands of companies, so the
whole history is a few hundred requests. SEC fair-access limit is 10 req/s;
this stays well under it."""
import gzip, json, os, sys, time, urllib.request, urllib.error

UA = "FrontierCapitalSignals/1.0 (+https://frontiercapitalsignals.com/signals/)"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frames")
os.makedirs(OUT, exist_ok=True)

DURATION_TAGS = [
    ("us-gaap", "NetIncomeLoss", "USD"),
    ("us-gaap", "Revenues", "USD"),
    ("us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax", "USD"),
    ("us-gaap", "SalesRevenueNet", "USD"),
    ("us-gaap", "OperatingIncomeLoss", "USD"),
    ("us-gaap", "EarningsPerShareDiluted", "USD-per-shares"),
]
INSTANT_TAGS = [("dei", "EntityCommonStockSharesOutstanding", "shares")]

def get(url, tries=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip, deflate"})
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return raw
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(2 ** i)
        except Exception:
            time.sleep(2 ** i)
    return None

periods = []
years = range(int(sys.argv[1]) if len(sys.argv) > 1 else 2009, 2027)
for y in years:
    for q in range(1, 5):
        periods.append(f"CY{y}Q{q}")
    periods.append(f"CY{y}")

jobs = []
for tax, tag, unit in DURATION_TAGS:
    for p in periods:
        jobs.append((tax, tag, unit, p))
for tax, tag, unit in INSTANT_TAGS:
    for y in years:
        for q in range(1, 5):
            jobs.append((tax, tag, unit, f"CY{y}Q{q}I"))

done = 0
for tax, tag, unit, p in jobs:
    path = os.path.join(OUT, f"{tag}__{p}.json.gz")
    if os.path.exists(path):
        continue
    raw = get(f"https://data.sec.gov/api/xbrl/frames/{tax}/{tag}/{unit}/{p}.json")
    if raw is not None:
        with gzip.open(path, "wb") as f:
            f.write(raw)
    else:
        open(path + ".missing", "w").close()
    done += 1
    if done % 50 == 0:
        print(f"{done}/{len(jobs)}", flush=True)
    time.sleep(0.25)
print("frames done", flush=True)
