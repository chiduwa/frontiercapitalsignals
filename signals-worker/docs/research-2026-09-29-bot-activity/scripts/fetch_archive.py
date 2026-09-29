"""Download Binance public-archive monthly 1h klines (spot + USDS-M perps) and
perp funding rates for every coin that has both a spot USDT pair and a USDT
perpetual, delisted ones included. Saves one compact npz per coin.

usage: python3 fetch_archive.py <first YYYY-MM> <last YYYY-MM> <outdir>
"""
import io, json, os, re, sys, time, zipfile, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
import numpy as np

BASE = "https://data.binance.vision/data"
first, last, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(outdir, exist_ok=True)
uni = json.load(open("universe.json"))
spot = set(uni["spot"])
STABLE = {"USDC", "FDUSD", "TUSD", "BUSD", "USDP", "DAI", "EUR", "GBP", "AEUR", "EURI", "USDE", "XUSD", "BFUSD",
          "RLUSD", "USD1", "PAXG", "WBTC", "WBETH", "BNSOL", "USDS", "PYUSD", "UST", "USTC", "XAUT", "BETH", "STETH"}
pairs = []   # (coin, spot_symbol, perp_symbol, multiplier)
for p in sorted(s for s in uni["um"] if s.endswith("USDT")):
    if re.search(r"_\d{6}$", p): continue            # quarterly contracts
    if p in spot:
        base = p[:-4]; pairs.append((base, p, p, 1.0)); continue
    m = re.match(r"^(1000000|1000|1M)(.+)USDT$", p)
    if m and (m.group(2) + "USDT") in spot:
        mult = {"1000000": 1e6, "1000": 1e3, "1M": 1e6}[m.group(1)]
        pairs.append((m.group(2), m.group(2) + "USDT", p, mult))
pairs = [x for x in pairs if x[0] not in STABLE and x[2].isascii() and x[1].isascii()]
if os.environ.get("REVERSE"): pairs = pairs[::-1]   # a second process can work the list from the other end
print(f"{len(pairs)} coins with a spot USDT pair and a USDT perpetual", flush=True)

def months(a, b):
    y, m = map(int, a.split("-")); yb, mb = map(int, b.split("-"))
    while (y, m) <= (yb, mb):
        yield f"{y:04d}-{m:02d}"
        m += 1
        if m == 13: y, m = y + 1, 1
MONTHS = list(months(first, last))

def get(url, tries=5):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "fcs-research"}), timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            time.sleep(1.5 * (i + 1))
        except Exception:
            time.sleep(1.5 * (i + 1))
    raise RuntimeError("gave up: " + url)

def rows(blob):
    if blob is None: return []
    z = zipfile.ZipFile(io.BytesIO(blob))
    txt = z.read(z.namelist()[0]).decode()
    out = []
    for line in txt.splitlines():
        f = line.split(",")
        if not f[0] or not f[0][0].isdigit(): continue      # header
        out.append(f)
    return out

def kl(market, sym, month):
    path = "spot/monthly/klines" if market == "spot" else "futures/um/monthly/klines"
    r = rows(get(f"{BASE}/{path}/{sym}/1h/{sym}-1h-{month}.zip"))
    a = []
    for f in r:
        t = int(f[0])
        if t > 10**14: t //= 1000                            # spot switched to microseconds in 2025
        a.append((t, float(f[1]), float(f[2]), float(f[3]), float(f[4]), float(f[7]), float(f[8]), float(f[10])))
    return a

def fund(sym, month):
    r = rows(get(f"{BASE}/futures/um/monthly/fundingRate/{sym}/{sym}-fundingRate-{month}.zip"))
    return [(int(f[0]) // 1 if int(f[0]) < 10**14 else int(f[0]) // 1000, float(f[2])) for f in r]

def one(pair):
    try:
        return one_(pair)
    except Exception as e:
        return pair[0], f"failed: {e}"

def one_(pair):
    coin, s_sym, p_sym, mult = pair
    fn = os.path.join(outdir, f"{coin}.npz")
    if os.path.exists(fn): return coin, "cached"
    S, P, F = [], [], []
    for mo in MONTHS:
        S += kl("spot", s_sym, mo); P += kl("perp", p_sym, mo); F += fund(p_sym, mo)
    if not S or not P: 
        np.savez_compressed(fn, empty=np.array([1])); return coin, "empty"
    S = np.array(sorted(set(S)), dtype=np.float64); P = np.array(sorted(set(P)), dtype=np.float64)
    F = np.array(sorted(set(F)), dtype=np.float64) if F else np.zeros((0, 2))
    np.savez_compressed(fn, s_t=S[:, 0].astype(np.int64), s=S[:, 1:].astype(np.float32),
                        p_t=P[:, 0].astype(np.int64), p=P[:, 1:5].astype(np.float32), p_qv=P[:, 5].astype(np.float32),
                        f_t=F[:, 0].astype(np.int64), f=F[:, 1].astype(np.float32) if len(F) else np.zeros(0, np.float32),
                        mult=np.array([mult]), spot=np.array([s_sym]), perp=np.array([p_sym]))
    return coin, f"{len(S)} spot / {len(P)} perp / {len(F)} funding"

t0 = time.time()
done = 0
with ThreadPoolExecutor(max_workers=48) as ex:
    for coin, msg in ex.map(one, pairs):
        done += 1
        if done % 25 == 0 or done == len(pairs):
            print(f"  {done}/{len(pairs)} ({time.time() - t0:.0f}s) last: {coin} {msg}", flush=True)
print("done")
