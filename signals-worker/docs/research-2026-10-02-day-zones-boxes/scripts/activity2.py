"""Activity, cleaner specifications (activity.py's perp block mixed oi24,
ret24 and oidiv = oi24 - ret, which are nearly collinear):
  size ~ each magnitude feature on its own (+ coin intercepts): vol24, |ret24|, |oi24|, oi24
  skew ~ each signed feature on its own: ret24, oi24, oidiv, taker
then the out-of-sample test of baking volume into the size forecast:
  U^' = U^ x (24h volume ratio)^g, D^' likewise, g fitted on 2018-22 by the
  forecast's own loss, judged on 2023-26."""
import numpy as np, pandas as pd
from activity import reg, HERE, SPLIT_SPOT, SPLIT_PERP

A = pd.read_pickle(f"{HERE}/activity_days.pkl")
A["absret24"] = A.ret24.abs(); A["absoi24"] = A.oi24.abs()
print("## 1b. One feature at a time (within-coin sd units, coin intercepts, date-clustered t)")
for y, feats in (("size", ["vol24", "absret24", "absoi24", "oi24"]), ("skew", ["ret24", "oi24", "oidiv", "taker", "vol24"])):
    for x in feats:
        perp = x in ("absoi24", "oi24", "oidiv", "taker")
        sub = A[A.has_perp] if perp else A
        split = SPLIT_PERP if perp else SPLIT_SPOT
        cells = []
        for per, m in (("first", sub.date < split), ("second", sub.date >= split)):
            r, n = reg(sub[m], y, [x])
            cells.append(f"{per} {r[x][0]:+.3f} (t {r[x][1]:+.1f}, n {n})")
        print(f"   {y:4s} ~ {x:9s} " + " | ".join(cells))

print("\n## 2. Baking volume into the size forecast: U^' = U^ x ratio^g (ratio = last-24h volume / its 30-day median)")
B = A.replace([np.inf, -np.inf], np.nan).dropna(subset=["vol24", "Uh", "Dh"])
def loss(df, g):
    s = np.exp(g * df.vol24)
    return (np.abs(df.U - df.Uh * s) + np.abs(df.D - df.Dh * s)).mean()
a, b = B[B.date < SPLIT_SPOT], B[B.date >= SPLIT_SPOT]
grid = np.round(np.arange(-0.1, 0.41, 0.02), 2)
la = {g: loss(a, g) for g in grid}
g_star = min(la, key=la.get)
print(f"   fitted on 2018-22: g = {g_star} (loss {la[g_star] / la[0.0]:.4f} of g=0)")
lb0, lbs = loss(b, 0.0), loss(b, g_star)
print(f"   2023-26 with g = {g_star}: loss {lbs / lb0:.4f} of the forecast without volume")
# paired by coin-day, date-clustered
s = np.exp(g_star * b.vol24)
d = (np.abs(b.U - b.Uh * s) + np.abs(b.D - b.Dh * s)) - (np.abs(b.U - b.Uh) + np.abs(b.D - b.Dh))
g = pd.Series(d.values - d.mean()).groupby(b.date.values).sum()
print(f"   paired difference {d.mean():+.5f} (t {d.mean() / (np.sqrt((g ** 2).sum()) / len(d)):+.2f}), {len(d)} coin-days")

def scale(df, g, h):
    return np.exp(g * df.vol24 + h * df.absret24)
def loss2(df, g, h):
    sc = scale(df, g, h)
    return (np.abs(df.U - df.Uh * sc) + np.abs(df.D - df.Dh * sc)).mean()
C = B.dropna(subset=["absret24"])
ca, cb = C[C.date < SPLIT_SPOT], C[C.date >= SPLIT_SPOT]
best = min(((loss2(ca, g, h), g, h) for g in np.round(np.arange(-0.04, 0.21, 0.02), 2) for h in np.round(np.arange(-0.05, 0.31, 0.025), 3)))
_, G, H = best
print(f"\n## 3. Volume and yesterday's move size together: U^' = U^ x ratio^g x exp(h x |yesterday's move| in typical moves)")
print(f"   fitted on 2018-22: g = {G}, h = {H} (loss {best[0] / loss2(ca, 0, 0):.4f} of none)")
sc = scale(cb, G, H)
d = (np.abs(cb.U - cb.Uh * sc) + np.abs(cb.D - cb.Dh * sc)) - (np.abs(cb.U - cb.Uh) + np.abs(cb.D - cb.Dh))
gg = pd.Series(d.values - d.mean()).groupby(cb.date.values).sum()
print(f"   2023-26: loss {loss2(cb, G, H) / loss2(cb, 0, 0):.4f} of none; paired {d.mean():+.5f} (t {d.mean() / (np.sqrt((gg ** 2).sum()) / len(d)):+.2f}, {len(d)} coin-days)")
print(f"   calibration 2023-26 (days inside each side, ~50% is right): with {(cb.U <= cb.Uh * sc).mean():.3f}/{(cb.D <= cb.Dh * sc).mean():.3f}, without {(cb.U <= cb.Uh).mean():.3f}/{(cb.D <= cb.Dh).mean():.3f}")
act = G * cb.vol24 + H * cb.absret24
for lo, hi, lab in ((0.9, 1.01, "busiest 10% of days (by volume and yesterday's move)"), (0.75, 0.9, "next 15%"), (0.0, 0.25, "quietest 25%")):
    m = (act >= act.quantile(lo)) & (act <= act.quantile(min(hi, 1)))
    print(f"   {lab}: multiplier ~{np.exp(act[m].median()):.2f}x; days exceeding the plain forecast top {(cb.U[m] > cb.Uh[m]).mean():.0%} / bottom {(cb.D[m] > cb.Dh[m]).mean():.0%}; "
          f"with the multiplier {(cb.U[m] > (cb.Uh * sc)[m]).mean():.0%} / {(cb.D[m] > (cb.Dh * sc)[m]).mean():.0%}")
pd.Series({"g": G, "h": H}).to_json(f"{HERE}/activity_g.json")
