"""Replay spot and neutral futures grids on every coin, 2021-2026.

Grids launch every 7 days (after 90 days of history), run 30 or 90 days, with
a range of +-k times the coin's 90-day daily vol scaled to the horizon.
"""
import numpy as np, pandas as pd
from gridsim import load_panel, build_path, run_grid, geometric_range, grid_count

SPOT_FEE, FUT_FEE = 0.001, 0.0002
KS, STEPS, HS = (1.0, 1.5, 2.0, 3.0), (0.006, 0.01, 0.015, 0.02, 0.03), (30, 90)
A, F = load_panel()
rows = []
for sym, a in A.items():
    path, day = build_path(a)
    fund = np.array([F[sym].get(d, 0.0001) for d in a["date"]])
    lr = np.diff(np.log(a["c"]))
    for H in HS:
        for st in range(90, len(a["c"]) - H, 7):
            sig = lr[st - 90:st].std(); m = (day >= st) & (day < st + H)
            for k in KS:
                lo, hi = geometric_range(a["o"][st], sig, H, k)
                for step in STEPS:
                    r = run_grid(path[m], day[m], lo, hi, grid_count(lo, hi, step), funding=fund)
                    rows.append(dict(sym=sym, H=H, k=k, step=step, start=a["date"][st],
                        spot=r["equity"] - 1 - SPOT_FEE * (r["notional"] + r["launch"]),
                        exc=r["excess"] - SPOT_FEE * r["notional"],
                        fut=r["excess"] - FUT_FEE * r["notional"] - r["fund"],
                        hodl=r["hodl"], hold=r["hold"] - 1, inr=r["in_range"], below=r["below"]))
r = pd.DataFrame(rows)
r["half"] = np.where(r.start < "2024-01-01", "2021-23", "2024-26")
t = lambda x, H: x.mean() / (x.std(ddof=1) / np.sqrt(max(2, len(x) * 7 / H)))
print(f"{len(r)} grid runs, {r.sym.nunique()} coins, launches {r.start.min()} to {r.start.max()}")
print("\n1. Spot grid minus holding its launch inventory, after 0.1% fees, % of capital per run")
print("   (all coins but HYPE, which is close-only; t uses non-overlapping run count)")
m = r[r.sym != "HYPE"]
for (H, k, step), x in m.groupby(["H", "k", "step"]):
    parts = [f"{h} {xx.exc.mean()*100:+.2f}% (t {t(xx.exc, H):+.1f})" for h, xx in x.groupby("half")]
    print(f"  {H}d +-{k} sd step {step*100:.1f}%: " + " | ".join(parts))
print("\n2. Spot grid outcomes, +-3 sd, 1.5% per grid, after fees")
for s in ("BTC", "ETH", "SOL", "XRP", "XLM", "HBAR", "ARB"):
    for H in HS:
        x = r[(r.sym == s) & (r.H == H) & (r.k == 3.0) & (r.step == 0.015)]
        print(f"  {s:4s} {H}d: grid median {x.spot.median()*100:+.1f}% mean {x.spot.mean()*100:+.1f}% worst-10% {x.spot.quantile(.1)*100:+.1f}%"
              f" | holding the coin mean {x.hodl.mean()*100:+.1f}% worst-10% {x.hodl.quantile(.1)*100:+.1f}%"
              f" | grid up in {(x.spot > 0).mean()*100:.0f}% | in range {x.inr.mean()*100:.0f}% of the time")
print("\n3. Neutral futures grid, 1% per grid, 0.02% maker fee and real funding, unlevered % of margin")
for s in ("BTC", "ETH", "SOL", "XRP"):
    for H in HS:
        for k in (2.0, 3.0):
            x = r[(r.sym == s) & (r.H == H) & (r.k == k) & (r.step == 0.01)].fut * 100
            print(f"  {s:4s} {H}d +-{k:.0f} sd: median {x.median():+.2f}% mean {x.mean():+.2f}% worst-5% {x.quantile(.05):+.1f}%"
                  f" worst {x.min():+.1f}% | at 2x {2*x.min():+.0f}%, 3x {3*x.min():+.0f}%, 5x {5*x.min():+.0f}%")
