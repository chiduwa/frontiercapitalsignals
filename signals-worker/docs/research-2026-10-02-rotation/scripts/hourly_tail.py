"""Hourly sympathy at the extremes: when a coin's category peers have one of
their biggest hours (vs the market) and the coin itself has not moved, what
does the coin do over the next 1 / 4 / 24 hours, in excess of the market?
Judged against ~20bp round trip. Day-clustered t."""
import numpy as np, pandas as pd
from hourly import load_hourly, loo_mean, T0, TEND, SPLIT
from rot_panel import load
from stats_util import nw_mean

d = load(); prim = d["prim"]
C, Q = load_hourly(set(d["P"].columns))
r = np.log(C / C.shift(1)); r = r.where(r.abs() < 0.5); r = r.where(C.notna().cumsum() > 720)
m = r.mean(axis=1).where(r.notna().sum(axis=1) >= 30); x = r.sub(m, axis=0)
groups = {}
for s in x.columns:
    c = prim.get(s)
    if c and c != "stablecoin": groups.setdefault(c, []).append(s)
catX = loo_mean(x, groups, list(x.columns))
vol24 = x.rolling(24, min_periods=18).std()
z = catX / catX.stack().std()                          # peers' hour in units of a typical peer-hour
own_quiet = x.abs() < 0.5 * vol24                       # the coin has not moved yet
fut = {"+1h": x.shift(-1), "+1..4h": x.rolling(4).sum().shift(-4), "+1..24h": x.rolling(24).sum().shift(-24)}
q = catX.stack().quantile([0.01, 0.02, 0.98, 0.99])
print("peer-hour quantiles (excess, %):", (q * 100).round(2).to_dict())
for side, cond in (("peers' top 1% hour, coin quiet", (catX >= q[0.99]) & own_quiet), ("peers' bottom 1% hour, coin quiet", (catX <= q[0.01]) & own_quiet),
                   ("peers' top 2% hour, coin quiet", (catX >= q[0.98]) & own_quiet), ("peers' bottom 2% hour, coin quiet", (catX <= q[0.02]) & own_quiet)):
    out = []
    for p, lo, hi in (("2024-01..2025-04", T0, SPLIT), ("2025-05..2026-08", SPLIT, TEND)):
        cells = []
        for k, F in fut.items():
            v = F.where(cond).stack()
            v = v[(v.index.get_level_values(0) >= lo) & (v.index.get_level_values(0) < hi)]
            dly = v.groupby(v.index.get_level_values(0).floor("D")).mean()
            mu, t, n = nw_mean(dly.values, lags=3)
            cells.append(f"{k} {mu * 1e4:+.0f}bp t {t:+.1f}")
        out.append(f"{p} n={int(cond.loc[lo:hi].values.sum())}: " + " | ".join(cells))
    print(f"{side}\n   " + "\n   ".join(out))
