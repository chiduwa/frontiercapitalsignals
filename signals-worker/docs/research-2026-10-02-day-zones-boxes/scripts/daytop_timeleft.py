"""At the midnight-UTC reference, k = 1: the alert's odds by how many hours of
the UTC day are left when the forecast top/bottom is reached, pooled over the
eight coins, both periods. 'near' = the day's actual extreme ends within a
quarter of a typical move of the alert price."""
import numpy as np, pandas as pd
from daytop_split import build, clustered
from daytop import DATA
A = build(0, 1.0)
A["left"] = 24 - A["hour"] - 1               # whole hours left after the hour of the touch
bins = [(-1, 3, "under 4h left"), (3, 7, "4-7h left"), (7, 11, "8-11h left"), (11, 15, "12-15h left"), (15, 24, "16h+ left")]
for side in ("top", "bottom"):
    print(f"\n## {side}: the day's {'high' if side == 'top' else 'low'} after the forecast {side} is reached, by hours left (00 UTC day)")
    for lo, hi, lab in bins:
        cells = []
        for per in ("A", "B"):
            s = A[(A.side == side) & (A.per == per) & (A.left > lo) & (A.left <= hi)]
            if len(s) < 30: cells.append(f"{per}: n {len(s)}"); continue
            m, t, n = clustered(s.fade, s.date)
            cells.append(f"{per}: n {n:4d}, near {s.near.mean():.0%}, further median {s.further_u.median():.2f} p75 {s.further_u.quantile(.75):.2f}, back inside by the close {(s.fade > 0).mean():.0%}, mean {m * 1e4:+.0f}bp (t {t:+.1f})")
        print(f"   {lab:13s} " + " || ".join(cells))
    s = A[A.side == side]
    print(f"   share of all {side} alerts by hours left (B): " + ", ".join(f"{lab} {((s[s.per == 'B'].left > lo) & (s[s.per == 'B'].left <= hi)).mean():.0%}" for lo, hi, lab in bins))
A.to_pickle(f"{DATA}/daytop_R00.pkl")
