"""Where the study's spot edge goes: the same prints measured the study's way
(spot, from the print's close, minus the equal-weight market) and as a perp
short (next open to 24h, fees, slippage, funding); then one filter chosen
before looking, on economic grounds: skip prints where shorts already pay
funding (the last rate before the print is negative)."""
import pandas as pd, numpy as np
PR = pd.read_pickle("prints.pkl"); T = pd.read_pickle("trades.pkl")
SPLIT = int(pd.Timestamp("2025-05-29").value // 10**6); DAY = 86_400_000
PR["half"] = np.where(PR.t < SPLIT, 1, 2)
PR = PR.sort_values(["coin", "t"]); keep, last = [], {}
for c, t in PR[["coin", "t"]].itertuples(index=False):
    f = c not in last or t - last[c] >= DAY; keep.append(f)
    if f: last[c] = t
PR["fresh"] = keep
def show(df, name):
    g = df.dropna(subset=["exc24"])
    print(f"  {name:38s} n={len(g):6d}  spot fwd24 {g.fwd24.mean()*100:+6.2f}%  market {g.mkt24.mean()*100:+6.2f}%  excess {g.exc24.mean()*100:+6.2f}%  "
          f"H1 {g[g.half==1].exc24.mean()*100:+6.2f}%  H2 {g[g.half==2].exc24.mean()*100:+6.2f}%   median fwd24 {g.fwd24.median()*100:+.2f}%")
print("The study's measure on the perp-listed coins (spot, from the print's close, 24h):")
show(PR, "all prints (the study's unit)")
for tr in ("thin", "mid"): show(PR[PR.tier == tr], f"all prints, {tr}")
show(PR[PR.fresh], "first print per coin per 24h")
show(PR[~PR.fresh], "follow-on prints (same pump)")
m = T[(T.entry == "mkt") & (T.stop == 0) & (T.hold == 24) & (~T.late) & T.filled]
X = m.merge(PR[["coin", "t", "fresh", "fwd24"]], on=["coin", "t"])
print("\nThe same prints as a perp short (next open to 24h, no stop):")
for fr in (True, False):
    g = X[X.fresh == fr]
    print(f"  {'first print' if fr else 'follow-on  '}: perp gross {g.gross.mean()*100:+.2f}%  fees+slippage -{g.cost.mean()*100:.2f}%  funding {g.funding.mean()*100:+.2f}%  "
          f"net {g.net.mean()*100:+.2f}%   (a short at the spot close would have made {-g.fwd24.mean()*100:+.2f}% gross)")

X = T[T.filled].merge(PR[["coin", "t", "fresh", "last_funding"]], on=["coin", "t"])
X = X[X.fresh]; X["half"] = np.where(X.t < SPLIT, 1, 2); X["day"] = X.t // DAY
def ct(g):
    s = g.groupby("day").net.sum(); d = len(s); n = len(g)
    return g.net.mean() / (np.sqrt(((s - s.mean())**2).sum() * d / (d - 1)) / n) if d > 5 else np.nan
print("\nFunding filter: last funding rate at the print, net per trade, day-clustered t")
for (e, st, h, late), g in X.groupby(["entry", "stop", "hold", "late"]):
    if e != "mkt": continue
    out = []
    for lab, msk in (("funding >= 0", g.last_funding >= 0), ("funding < 0", g.last_funding < 0)):
        for hf in (1, 2):
            gg = g[msk & (g.half == hf)]
            out.append(f"{lab} H{hf} n={len(gg)} {gg.net.mean()*100:+.2f}% t {ct(gg):+.1f}")
    print(f"  {e} {'stop %2d%%' % round(st*100) if st else 'no stop'} {h}h {'late   ' if late else 'on time'}:  " + " | ".join(out))
