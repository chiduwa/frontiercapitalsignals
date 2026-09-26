"""Daily-bar exhaustion: crypto majors on a slower clock, and US stocks.

usage: python3 daily_analysis.py crypto <k1d dir>
       python3 daily_analysis.py stock  <pxd dir> <universe.json>

Same method as the hourly study: every feature from bars at or before day t,
outcomes from day t's close; excess over the equal-weight market of the same
universe over the same days; day-clustered t; variants ranked on the first
half of the dates only and judged on the second.
"""
import glob, json, os, sys
import numpy as np
import pandas as pd

kind, src = sys.argv[1], sys.argv[2]
HERE = os.path.dirname(os.path.abspath(__file__))
H_LIST = (1, 3, 5, 10, 20)
LOOK = 90

def load_series():
    out = {}
    if kind == "crypto":
        for f in glob.glob(os.path.join(src, "*.npz")):
            d = np.load(f)
            if len(d["t"]) < LOOK + 60: continue
            dates = pd.to_datetime(d["t"], unit="ms").normalize()
            out[os.path.basename(f)[:-4]] = pd.DataFrame({"o": d["o"], "h": d["h"], "l": d["l"], "c": d["c"], "dv": d["qv"]}, index=dates)
    else:
        for f in glob.glob(os.path.join(src, "*.json")):
            d = json.load(open(f))
            if len(d["d"]) < LOOK + 60: continue
            df = pd.DataFrame({k: d[k] for k in ("o", "h", "l", "c", "v")}, index=pd.to_datetime(d["d"]))
            df = df[~df.index.duplicated()].sort_index().astype(float)
            df["dv"] = df.c * df.v
            out[os.path.basename(f)[:-5]] = df[["o", "h", "l", "c", "dv"]]
    return out

S = load_series()
print(f"{len(S)} {kind} series")
# equal-weight market on the union calendar
rets = pd.DataFrame({s: df.c.pct_change().clip(-0.5, 0.5) for s, df in S.items()})
cnt = rets.notna().sum(axis=1)
mkt = rets.mean(axis=1).where(cnt >= 30, 0.0).fillna(0.0)
mlog = np.log1p(mkt).cumsum()

tier = {}
if kind == "crypto":
    liq = pd.Series({s: df.dv.tail(365).median() for s, df in S.items()})
    hi, lo = liq.quantile(0.9), liq.quantile(0.4)
    tier = {s: ("major" if v >= hi else "thin" if v < lo else "mid") for s, v in liq.items()}
else:
    U = {r["symbol"]: r["mcap"] for r in json.load(open(sys.argv[3]))}
    def b(m): return "micro" if m < 3e8 else "small" if m < 2e9 else "mid" if m < 1e10 else "large"
    tier = {s: b(U.get(s, 0)) for s in S}

parts = []
for s, df in S.items():
    c, o, h, l, dv = (df[x].to_numpy(float) for x in ("c", "o", "h", "l", "dv"))
    lr = np.log(df.c / df.c.shift(1))
    sig = lr.shift(1).rolling(LOOK, min_periods=60).std().to_numpy()
    ldv = np.log(df.dv.where(df.dv > 0))
    mu = ldv.shift(1).rolling(LOOK, min_periods=60).mean().to_numpy()
    sd = ldv.shift(1).rolling(LOOK, min_periods=60).std().to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        volZ = (np.log(dv) - mu) / sd
        barZ = lr.to_numpy() / sig          # close-to-close, the daily move
        run5Z = np.log(df.c / df.c.shift(5)).to_numpy() / (sig * np.sqrt(5))
        run20Z = np.log(df.c / df.c.shift(20)).to_numpy() / (sig * np.sqrt(20))
        hi20 = df.h.shift(1).rolling(20, min_periods=15).max().to_numpy()
        vs20 = c / hi20 - 1
        wick = (h - np.maximum(o, c)) / (h - l)
    mi = mlog.reindex(df.index).to_numpy()
    rec = {"t": df.index.to_numpy(), "sym": s, "volZ": volZ, "barZ": barZ, "run5Z": run5Z, "run20Z": run20Z,
           "vs20": vs20, "wick": wick, "liq": pd.Series(dv).shift(1).rolling(20, min_periods=10).median().to_numpy()}
    for H in H_LIST:
        fut = df.c.shift(-H).to_numpy()
        rec[f"fwd{H}"] = fut / c - 1
        mf = pd.Series(mi).shift(-H).to_numpy()
        rec[f"mkt{H}"] = np.expm1(mf - mi)
        fh = pd.Series(h[::-1]).rolling(H, min_periods=H).max().to_numpy()[::-1]
        fh = np.concatenate([fh[1:], [np.nan]])
        rec[f"top{H}"] = np.where(np.isfinite(fh), (fh <= h).astype(float), np.nan)
    d = pd.DataFrame(rec)
    ok = np.isfinite(sig) & np.isfinite(mu) & (np.arange(len(d)) >= LOOK)
    if kind == "stock":
        ok &= (c >= 2) & (d.liq.to_numpy() >= 1e6)     # tradable names only
    keep = ok & (((d.volZ >= 1.5) & (d.barZ >= 1)) | (np.random.default_rng(1).random(len(d)) < 0.02))
    part = d[keep].copy()
    part["sample"] = (~(((d.volZ >= 1.5) & (d.barZ >= 1))[keep])).astype(np.int8)
    parts.append(part)
D = pd.concat(parts, ignore_index=True)
D["tier"] = D.sym.map(tier)
D["day"] = pd.to_datetime(D.t).dt.floor("D")
for H in H_LIST:
    D[f"exc{H}"] = D[f"fwd{H}"] - D[f"mkt{H}"]
days = np.sort(D.day.unique()); split = days[len(days) // 2]
D["half"] = np.where(D.day < split, 1, 2)
print(f"{len(D):,} rows; split {pd.Timestamp(split).date()}")

def cl(ev, col):
    x = ev[[col, "day"]].dropna()
    if len(x) < 10: return np.nan, np.nan, 0
    g = x.groupby("day")[col].mean()
    n = len(g)
    return g.mean(), (g.mean() / (g.std(ddof=1) / np.sqrt(n)) if n > 2 and g.std(ddof=1) > 0 else np.nan), n

def line(name, ev, H):
    m, t, n = cl(ev, f"exc{H}")
    m1, t1, _ = cl(ev[ev.half == 1], f"exc{H}")
    m2, t2, _ = cl(ev[ev.half == 2], f"exc{H}")
    top = ev[f"top{H}"].mean()
    f = lambda v: f"{v*100:+6.2f}%" if np.isfinite(v) else "   n/a"
    g = lambda v: f"{v:+5.1f}" if np.isfinite(v) else "  n/a"
    return (f"{name:40s} n={len(ev):6d} d={n:4d} {H:2d}d exc {f(m)} t {g(t)} | H1 {f(m1)} (t {g(t1)}) H2 {f(m2)} (t {g(t2)}) | top {top*100 if np.isfinite(top) else float('nan'):3.0f}%"), (m, t, m1, t1, m2, t2)

samp = D[D["sample"] == 1]
print(line("reference: all days (2% sample)", samp, 5)[0])
res = []
for vz in (2, 2.5, 3, 4):
    for bz in (1.5, 2, 3):
        for rz in (None, 1.5, 2.5):
            for hi in (False, True):
                mask = (D["sample"] == 0) & (D.volZ >= vz) & (D.barZ >= bz)
                if rz: mask &= D.run5Z >= rz
                if hi: mask &= D.vs20 >= 0
                name = f"volZ>={vz} barZ>={bz}" + (f" run5Z>={rz}" if rz else "") + (" new20dHigh" if hi else "")
                ev = D[mask]
                if len(ev) < 40: continue
                for H in (3, 5, 10):
                    txt, st = line(name, ev, H)
                    res.append((name, H, st, txt, ev))
disc = sorted([r for r in res if np.isfinite(r[2][3])], key=lambda r: r[2][3])
print("\n== top 12 by DISCOVERY-half t ==")
for r in disc[:12]: print(r[3])
passing = [r for r in disc if r[2][3] <= -3 and np.isfinite(r[2][5]) and r[2][5] <= -2]
print(f"\n{len(passing)} (variant, horizon) pairs pass discovery t<=-3 AND validation t<=-2")
for r in passing[:10]: print(r[3])
if passing:
    best = passing[0]
    print(f"\n== best: {best[0]} @ {best[1]}d, by tier ==")
    for tr in sorted(D.tier.dropna().unique()):
        for H in (1, 3, 5, 10, 20):
            print(line(f"  {tr}", best[4][best[4].tier == tr], H)[0])
json.dump([{"name": r[0], "h": r[1], "mean": r[2][0], "t": r[2][1], "h1": r[2][2], "t1": r[2][3], "h2": r[2][4], "t2": r[2][5], "n": int(len(r[4]))}
           for r in res], open(os.path.join(HERE, f"daily_{kind}_report.json"), "w"), default=float)
