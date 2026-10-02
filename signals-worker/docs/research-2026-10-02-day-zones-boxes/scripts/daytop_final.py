"""The pre-specified check. The reference hour is chosen on forecast accuracy
alone (section 3 of daytop_split: 16-20 UTC best in both periods, 17 best
overall); is it reliably better than midnight UTC (paired by coin and date,
date-clustered)? Then, at that hour and the plain forecast (k = 1), the
numbers an alert would quote, by side and by whether the move is the coin's
own (SOLO) or the market's."""
import numpy as np, pandas as pd
from daytop import DATA, hourly, windows, excursions, forecast, TRACKED, SPLIT, NEAR
from daytop_split import build, clustered, data, FC

print("## Reference hour vs midnight UTC: paired error |U-U^|/U^ + |D-D^|/D^ per coin-day (negative = better than 00 UTC)")
errs = {}
for R in range(24):
    for sym, df in data.items():
        dates, b, pc = windows(df, R)
        U, D, O = excursions(b)
        Uh, Dh = forecast(U, D, pc, dates, **FC)
        ok = np.isfinite(Uh) & (np.arange(len(U)) >= 364)
        e = np.abs(U - Uh) / Uh + np.abs(D - Dh) / Dh
        errs[(R, sym)] = pd.Series(e[ok], index=dates[ok].normalize())
for R in (16, 17, 18, 19, 20, 8, 14):
    cells = []
    for per in ("A", "B"):
        d, dd = [], []
        for sym in TRACKED:
            a, b0 = errs.get((R, sym)), errs.get((0, sym))
            if a is None or b0 is None: continue
            j = a.index.intersection(b0.index)
            j = j[(j < SPLIT) if per == "A" else (j >= SPLIT)]
            d += list(a[j].values - b0[j].values); dd += list(j)
        m, t, n = clustered(d, dd)
        cells.append(f"{per}: {m:+.4f} (t {t:+.2f}, {n} coin-days)")
    print(f"   {R:02d} UTC vs 00 UTC  " + " | ".join(cells))

print("\n## At 17 UTC, k = 1 (the plain forecast): what happened after an alert, by side and market context")
A = build(17, 1.0)
for side in ("top", "bottom"):
    for ctx, f in (("solo (<= 1 other coin moving the same way)", lambda s: s.others <= 1), ("with the market (>= 3 others)", lambda s: s.others >= 3), ("all", lambda s: s.others >= 0)):
        cells = []
        for per in ("A", "B"):
            s = A[(A.side == side) & (A.per == per)]
            s = s[f(s)]
            if len(s) < 20: cells.append(f"{per}: n {len(s)}"); continue
            m, t, n = clustered(s.fade, s.date)
            kept = (s.fade < 0).mean()                       # closed beyond the alert price (continued)
            cells.append(f"{per}: n {n}, closed back inside {1 - kept:.0%}, mean {m * 1e4:+.0f}bp (t {t:+.1f}), "
                         f"near the extreme {s.near.mean():.0%}, further median {s.further_u.median():.2f} / p75 {s.further_u.quantile(0.75):.2f} typical moves")
        print(f"   {side:6s} {ctx:44s} " + " || ".join(cells))
A.to_pickle(f"{DATA}/daytop_R17.pkl")
print("\n## Typical excursion at 17 UTC, last 60 days, per coin (U^ / D^ in %)")
for sym, df in data.items():
    dates, b, pc = windows(df, 17)
    U, D, O = excursions(b)
    Uh, Dh = forecast(U, D, pc, dates, **FC)
    print(f"   {sym:5s} up {np.expm1(Uh[-1]) * 100:.2f}%  down {(1 - np.exp(-Dh[-1])) * 100:.2f}%   (median of last 60: up {np.expm1(np.median(U[-60:])) * 100:.2f}%, down {(1 - np.exp(-np.median(D[-60:]))) * 100:.2f}%)")
