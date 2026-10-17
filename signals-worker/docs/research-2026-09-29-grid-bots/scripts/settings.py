"""Grid ranges at the prices of 2026-09-29, from each coin's 90-day daily vol.

Range = price x exp(+-k x vol x sqrt(days)). Recenter on the live price
before launching: the range is only as current as the price it starts from.
"""
import gzip, json
import numpy as np
from gridsim import STABLE, load_panel, geometric_range, grid_count

A, _ = load_panel()
sig = {s: np.diff(np.log(A[s]["c"]))[-90:].std() for s in ("BTC", "ETH", "SOL")}
bnb = np.array([x["price"] for x in json.load(gzip.open(STABLE))["assets"]["BNB"]])
sig["BNB"] = np.diff(np.log(bnb))[-90:].std()
PRICE = {"BTC": 83926, "ETH": 2717.26, "SOL": 120.72, "BNB": 763.40}   # Binance, 2026-09-29
print("90-day daily vol to 2026-09-22: " + ", ".join(f"{s} {v*100:.2f}%" for s, v in sig.items()))
for s, p in PRICE.items():
    for H in (30, 90):
        for k in (2, 3):
            lo, hi = geometric_range(p, sig[s], H, k)
            print(f"  {s} at {p:g}, {H}d +-{k} sd: {lo:,.4g} to {hi:,.4g} (+-{(hi/p-1)*100:.0f}%)"
                  f"  grids at 1.5%: {grid_count(lo, hi, .015)}, at 1%: {grid_count(lo, hi, .01)}")
