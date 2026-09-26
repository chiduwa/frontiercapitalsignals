"""The adopted screen (scripts/profit-growth.mjs), evaluated on the panel built
by backtest.py, plus the variants it was chosen from and the survivorship
measurement that decides which period to quote.

Screen: net profit > 0 over 4 quarters, revenue growth in (0, 300%], and either
(profitable 4/4 quarters with profit up year on year in >= 3 of 4) or
(operating profit positive both years and up >= 20%). Top 25 per bucket:
small caps by revenue growth, mid caps by operating-profit growth.
"""
import glob, json, os
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
R = pd.read_pickle(os.path.join(HERE, "panel.pkl"))
R = R[R.bucket.notna()].copy()
for h in (13, 26, 52): R[f"r{h}"] = R[f"r{h}"].clip(-1, 3)
union = lambda d: ((d.prof_q == 4) & (d.yoy_pos >= 3) & (d.grev > 0)) | ((d.ottm > 0) & (d.oprev > 0) & (d.goi >= 0.20) & (d.grev > 0))
VARIANTS = {
    "tested first (union, no profit requirement)": lambda d: union(d),
    "+ net profit > 0": lambda d: union(d) & (d.ttm > 0),
    "ADOPTED: + net profit > 0, revenue growth <= 300%": lambda d: union(d) & (d.ttm > 0) & (d.grev <= 3),
}
RANK = {"small": "grev", "mid": "goi"}

def evaluate(bucket, mask, h=13, since=None):
    d = R[R.bucket == bucket]; xs = []
    for form, g in d.groupby("form"):
        if since and form < since: continue
        base = g[f"r{h}"].dropna()
        sel = g[mask(g)].dropna(subset=[f"r{h}"]).sort_values([RANK[bucket], "g"], ascending=False).head(25)
        if len(base) >= 20 and len(sel) >= 5: xs.append(sel[f"r{h}"].mean() - base.mean())
    x = np.array(xs); half = len(x) // 2
    if h != 13:
        # Overlapping windows: a t-stat would count the same months several
        # times, so only the mean and the share of positive windows are shown.
        return f"{x.mean()*100:+5.2f}% over {h} weeks, positive in {(x>0).mean()*100:3.0f}% of {len(x)} overlapping windows"
    return (f"{x.mean()*100:+5.2f}%/q  t {x.mean()/(x.std(ddof=1)/np.sqrt(len(x))):+5.2f}  wins {(x>0).mean()*100:3.0f}%  "
            f"halves {x[:half].mean()*100:+5.2f}/{x[half:].mean()*100:+5.2f}  ({len(x)} quarters)")

for bucket in ("small", "mid"):
    print(f"=== {bucket} caps, top 25 by {RANK[bucket]}, 13-week excess over the whole bucket ===")
    for name, mask in VARIANTS.items():
        print(f"  {name:52s} all: {evaluate(bucket, mask)}")
        print(f"  {'':52s} since 2021-07: {evaluate(bucket, mask, since='2021-07-01')}")
    for h in (26, 52):
        print(f"  ADOPTED held {h}w (overlapping windows): {evaluate(bucket, VARIANTS['ADOPTED: + net profit > 0, revenue growth <= 300%'], h=h)}")
    print()
