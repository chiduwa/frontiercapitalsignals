"""Market-wide exhaustion: does a CROWD of exhaustion prints mark a market top?

Two market-level reads, both built from data at or before hour t:
  breadth   share of scanned coins that printed a calibrated exhaustion bar in
            the trailing 24h
  climax    aggregate quote volume across every coin, z-scored against its own
            trailing 30 days, while the equal-weight market has run up

Outcome: forward return of the equal-weight market and of BTC over 24h / 72h /
168h. Observations are taken once per day (00:00 UTC) so the 24h windows do
not overlap; the longer windows do, so their t-stats use a Newey-West
correction with lag = horizon in days. Discovery / validation split by date.
"""
import os, sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else "k1h"
m = np.load(os.path.join(HERE, "market.npz"))
t0, step, logidx, cnt, qv = int(m["t0"]), int(m["step"]), m["logidx"], m["cnt"], m["qv"]
G = len(logidx)
C = pd.read_pickle(os.path.join(HERE, "cand.pkl"))
C = C[C.cand == 1]
ev = C[(C.volZ >= 3) & (C.barZ >= 3) & (C.run24Z >= 1.5)]
gi = ((ev.t.to_numpy() - t0) // step).astype(np.int64)
hits = np.zeros(G); np.add.at(hits, gi, 1)
hits24 = pd.Series(hits).rolling(24, min_periods=24).sum().to_numpy()
active = pd.Series(cnt).rolling(24, min_periods=24).mean().to_numpy()
breadth = hits24 / np.where(active > 0, active, np.nan)

lqv = np.log(np.where(qv > 0, qv, np.nan))
lqv24 = pd.Series(lqv).rolling(24, min_periods=24).mean()
mu = lqv24.shift(24).rolling(720, min_periods=360).mean().to_numpy()
sd = lqv24.shift(24).rolling(720, min_periods=360).std().to_numpy()
volz = (lqv24.to_numpy() - mu) / sd
mret = np.diff(logidx, prepend=logidx[0])
msig = pd.Series(mret).shift(1).rolling(720, min_periods=360).std().to_numpy()
run72 = (logidx - np.roll(logidx, 72)) / (msig * np.sqrt(72)); run72[:72] = np.nan

# BTC hourly closes on the same grid
b = np.load(os.path.join(HERE, SRC, "BTC.npz"))
bidx = ((b["t"] - t0) // step).astype(np.int64)
btc = np.full(G, np.nan); ok = (bidx >= 0) & (bidx < G); btc[bidx[ok]] = np.log(b["c"][ok])

def fwd(series, h):
    out = np.full(G, np.nan); out[:-h] = series[h:] - series[:-h]
    return np.expm1(out)

hours = np.arange(G)
daily = hours[(hours % 24 == 0) & np.isfinite(breadth) & np.isfinite(volz)]
day_ts = pd.to_datetime(t0 + daily * step, unit="ms")
split = daily[len(daily) // 2]

def nw_t(x, lag):
    x = x[np.isfinite(x)]
    n = len(x)
    if n < 20: return np.nan
    e = x - x.mean()
    s = (e @ e) / n
    for L in range(1, lag + 1):
        w = 1 - L / (lag + 1)
        s += 2 * w * (e[L:] @ e[:-L]) / n
    return x.mean() / np.sqrt(s / n) if s > 0 else np.nan

def row(name, mask, h):
    lag = max(0, h // 24 - 1)
    out = []
    for label, series in (("market", logidx), ("BTC", btc)):
        f = fwd(series, h)[daily]
        allf = f[np.isfinite(f)]
        sel = f[mask & np.isfinite(f)]
        d1 = f[mask & np.isfinite(f) & (daily < split)]
        d2 = f[mask & np.isfinite(f) & (daily >= split)]
        diff = sel.mean() - allf.mean() if len(sel) else np.nan
        out.append(f"{label} {sel.mean()*100 if len(sel) else float('nan'):+6.2f}% vs {allf.mean()*100:+5.2f}% "
                   f"(diff {diff*100:+6.2f}, t {nw_t(sel - allf.mean(), lag):+5.1f}; H1 {d1.mean()*100 if len(d1) else float('nan'):+6.2f} H2 {d2.mean()*100 if len(d2) else float('nan'):+6.2f})")
    print(f"{name:34s} n={int(mask.sum()):4d} {h:3d}h | " + " | ".join(out))

B = breadth[daily]; V = volz[daily]; R = run72[daily]
print(f"{len(daily)} daily observations {day_ts[0].date()} .. {day_ts[-1].date()}; split {pd.to_datetime(t0 + split*step, unit='ms').date()}")
print(f"breadth: median {np.nanmedian(B)*100:.1f}% of coins, p90 {np.nanpercentile(B,90)*100:.1f}%, p97 {np.nanpercentile(B,97)*100:.1f}%, max {np.nanmax(B)*100:.1f}%")
for h in (24, 72, 168):
    for q in (0.80, 0.90, 0.95):
        thr = np.nanquantile(B, q)
        row(f"breadth >= p{int(q*100)} ({thr*100:.1f}%)", B >= thr, h)
    row("breadth <= p20 (quiet)", B <= np.nanquantile(B, 0.2), h)
    for vz, rz in ((1.5, 1.5), (2.0, 2.0), (2.5, 2.0)):
        row(f"agg volume z>={vz} & market run72 z>={rz}", (V >= vz) & (R >= rz), h)
    print()
