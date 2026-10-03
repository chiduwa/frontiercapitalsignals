"""How much does replaying on bars understate a grid? Two checks.

1. Synthetic martingale prices, where the true fee-free excess is zero.
2. BTC May-Sep 2026: the same grids on hourly bars and on daily bars.
"""
import datetime as dt, json
import numpy as np
from gridsim import HOURLY, bar_path, run_grid, geometric_range, grid_count

rng = np.random.default_rng(7)
SIG, PER, DAYS = 0.03, 96, 30
print("1. Martingale prices, daily vol 3%, 30-day grids at +-1.5 sd, 400 paths, fee-free")
res = {"15-minute path": [], "daily bars": []}
for _ in range(400):
    lp = np.cumsum(rng.standard_normal(DAYS * PER) * SIG / np.sqrt(PER) - 0.5 * SIG**2 / PER)
    P = 100 * np.exp(np.concatenate([[0], lp]))
    fday = np.concatenate([[0], np.repeat(np.arange(DAYS), PER)])
    dp, dd = [], []
    for d in range(DAYS):
        seg = P[d * PER:(d + 1) * PER + 1]
        for p in bar_path(seg[0], seg.max(), seg.min(), seg[-1]):
            dp.append(p); dd.append(d)
    lo, hi = geometric_range(100, SIG, DAYS, 1.5)
    for step in (0.006, 0.015, 0.03):
        n = grid_count(lo, hi, step)
        res["15-minute path"].append((step, run_grid(P, fday, lo, hi, n)))
        res["daily bars"].append((step, run_grid(np.array(dp), np.array(dd), lo, hi, n)))
for kind, rows in res.items():
    for step in (0.006, 0.015, 0.03):
        e = np.array([r["excess"] for s, r in rows if s == step])
        t = np.mean([r["trips"] for s, r in rows if s == step])
        print(f"  {kind:15s} step {step*100:.1f}%: excess {e.mean()*100:+.2f}% (se {e.std()/np.sqrt(len(e))*100:.2f}), {t:.0f} round trips")

print("\n2. BTC, 2026-05-08 to 2026-09-11, 30-day grids started every 3 days, 0.1% fee")
d = json.load(open(HOURLY))
s = [x for x in d["series"] if x["symbol"] == "BTC/USD"][0]["bars"]
O, H, L, C = (np.array([b[k] for b in s]) for k in ("open", "high", "low", "close"))
day = np.array([dt.datetime.fromtimestamp(b["at"] / 1000, dt.timezone.utc).date().toordinal() for b in s])
day -= day[0]
hp, hd = [], []
for i in range(len(s)):
    for p in bar_path(O[i], H[i], L[i], C[i]):
        hp.append(p); hd.append(day[i])
hp, hd = np.array(hp), np.array(hd)
days = np.unique(day)
dO = [O[day == u][0] for u in days]; dH = [H[day == u].max() for u in days]
dL = [L[day == u].min() for u in days]; dC = [C[day == u][-1] for u in days]
dp, dd = [], []
for i, u in enumerate(days):
    for p in bar_path(dO[i], dH[i], dL[i], dC[i]):
        dp.append(p); dd.append(u)
dp, dd = np.array(dp), np.array(dd)
sig = np.diff(np.log(dC)).std()
for k in (1.5, 2.0):
    for step in (0.004, 0.006, 0.01, 0.015, 0.02, 0.03):
        rows = []
        for st in range(0, len(days) - 30, 3):
            lo, hi = geometric_range(dO[st], sig, 30, k); n = grid_count(lo, hi, step)
            mh = (hd >= st) & (hd < st + 30); md = (dd >= st) & (dd < st + 30)
            rh = run_grid(hp[mh], hd[mh], lo, hi, n); rd = run_grid(dp[md], dd[md], lo, hi, n)
            rows.append((rh["trips"], rd["trips"], rh["excess"] - 0.001 * rh["notional"], rd["excess"] - 0.001 * rd["notional"]))
        r = np.array(rows).mean(axis=0)
        print(f"  +-{k} sd, step {step*100:.1f}%: round trips hourly {r[0]:.0f} / daily {r[1]:.0f} ({r[0]/r[1]:.2f}x); excess after fees hourly {r[2]*100:+.2f}% / daily {r[3]*100:+.2f}%")
