"""The two bots whose return does not come from the price path.

Arbitrage bot: long spot, short perp, collecting Binance funding. Capital at
2x puts two thirds of it to work as notional; 0.3% of notional per round trip
(spot 0.1% in and out, perp 0.05% in and out).
Rebalancing bot: equal-weight BTC ETH SOL XRP against buy-and-hold, 0.1% fee.
"""
import numpy as np, pandas as pd
from gridsim import load_panel

A, F = load_panel()
EFF, COST = 2 / 3, 0.003
print("1. Arbitrage bot, 90-day holds started weekly: mean net APR on capital at 2x")
rows = []
for s, fr in F.items():
    daily = pd.Series(fr).sort_index() * 3
    daily.index = pd.to_datetime(daily.index)
    net = ((daily.rolling(90).sum() - COST) * EFF * 365 / 90 * 100).dropna()[::7]
    for yr, v in net.groupby(net.index.year):
        rows.append(dict(sym=s, year=yr, apr=v.mean(), pos=(v > 0).mean() * 100))
d = pd.DataFrame(rows)
print(d.pivot(index="sym", columns="year", values="apr").round(1).to_string())
print("\n   share of those holds that made money (%)")
print(d.pivot(index="sym", columns="year", values="pos").round(0).to_string())
print("\n   funding to 2026-09-22, gross APR on notional")
for s, fr in F.items():
    v = pd.Series(fr).sort_index()
    print(f"  {s:4s} last 7d {v[-7:].mean()*1095*100:4.1f}%  30d {v[-30:].mean()*1095*100:4.1f}%  90d {v[-90:].mean()*1095*100:4.1f}%"
          f"  365d {v[-365:].mean()*1095*100:5.1f}%  negative days in last 90: {(v[-90:] < 0).sum()}")

print("\n2. Rebalancing bot, equal-weight BTC ETH SOL XRP")
C = pd.DataFrame({s: pd.Series(A[s]["c"], index=pd.to_datetime(A[s]["date"])) for s in ("BTC", "ETH", "SOL", "XRP")}).dropna()
def rebalance(px, thr=None, every=None, fee=0.001):
    w = np.full(px.shape[1], 1 / px.shape[1]); hold = w / px.iloc[0].values; v = 1.0; n = 0
    for i in range(1, len(px)):
        p = px.iloc[i].values; v = (hold * p).sum(); cw = hold * p / v
        if (thr and np.max(np.abs(cw - w) / w) > thr) or (every and i % every == 0):
            v -= np.abs(cw - w).sum() * v * fee; hold = w * v / p; n += 1
    return v - 1, n
for a, b in (("2021-01-01", "2023-12-31"), ("2024-01-01", "2026-09-22"), ("2025-09-22", "2026-09-22")):
    px = C.loc[a:b]; out = [f"buy-and-hold {((px.iloc[-1] / px.iloc[0]).mean() - 1)*100:+.0f}%"]
    for lab, kw in (("5% band", dict(thr=.05)), ("10% band", dict(thr=.10)), ("20% band", dict(thr=.20)), ("weekly", dict(every=7))):
        ret, n = rebalance(px, **kw); out.append(f"{lab} {ret*100:+.0f}% ({n} rebalances)")
    print(f"  {a} to {b}: " + " | ".join(out))
