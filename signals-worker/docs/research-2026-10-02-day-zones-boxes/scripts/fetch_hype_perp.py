import io, os, time, urllib.request, zipfile, csv
import numpy as np
OUT = os.environ.get("DZ_DATA", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "reports", "day-zones"))   # fetch.py writes h1/ and d1s/ here (gitignored)
os.makedirs(os.path.join(OUT, 'h1'), exist_ok=True); os.makedirs(os.path.join(OUT, 'd1s'), exist_ok=True)
base = "https://data.binance.vision/data/futures/um"
rows = {}
def grab(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=60) as r: data = r.read()
    except Exception: return 0
    z = zipfile.ZipFile(io.BytesIO(data))
    n = 0
    for name in z.namelist():
        for rec in csv.reader(io.TextIOWrapper(z.open(name))):
            if not rec or not rec[0].isdigit(): continue
            rows[int(rec[0])] = [float(rec[1]), float(rec[2]), float(rec[3]), float(rec[4]), float(rec[7])]; n += 1
    return n
for y in (2024, 2025, 2026):
    for m in range(1, 13):
        if (y, m) > (2026, 9): break
        grab(f"{base}/monthly/klines/HYPEUSDT/1h/HYPEUSDT-1h-{y}-{m:02d}.zip")
import datetime
d = datetime.date(2026, 10, 1)
while d < datetime.date.today():
    grab(f"{base}/daily/klines/HYPEUSDT/1h/HYPEUSDT-1h-{d}.zip"); d += datetime.timedelta(days=1)
t = np.array(sorted(rows), dtype=np.int64)
np.savez_compressed(f"{OUT}/h1/HYPE.npz", t=t, s=np.array([rows[k] for k in t]), source=np.array(["binance-um-perp"]))
print("HYPE perp hours", len(t), datetime.datetime.utcfromtimestamp(t[0]/1000), datetime.datetime.utcfromtimestamp(t[-1]/1000))
