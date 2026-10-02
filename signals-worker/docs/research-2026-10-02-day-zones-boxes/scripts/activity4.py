"""The alert odds with activity baked in, exactly as it will run:
  band  = 60-day median x vol^0.5 x exp(g x log(24h volume ratio) + h x |yesterday's move in typical moves|)
          (g, h fitted on 2018-22 in activity2.py)
  alert = price at/beyond the band with <= 6h of the UTC day left (hourly closes)
  odds by today's volume so far (vs the same hours' median over the 30 days before):
          light (< 1x), normal (1-2x), heavy (>= 2x)
Also writes the fixture values for test-day-zones.mjs."""
import json
import numpy as np, pandas as pd
from activity import HERE, SPLIT_SPOT, TRACKED
from daytop import NEAR
from daytop_split import clustered

G = json.load(open(f"{HERE}/activity_g.json"))
g, h = G["g"], G["h"]
A = pd.read_pickle(f"{HERE}/activity_days.pkl")
P = pd.read_pickle(f"{HERE}/activity_paths.pkl")
A = A.merge(P[["sym", "date", "_b"]], on=["sym", "date"])
A["mult"] = np.exp(g * A.vol24.fillna(0) + h * A.ret24.abs().fillna(0))
print(f"g = {g}, h = {h}; multiplier median {A.mult.median():.3f}, p90 {A.mult.quantile(.9):.3f}, max {A.mult.max():.2f}")
rows = []
for sym in TRACKED:
    d = A[A.sym == sym].reset_index(drop=True)
    blk = np.stack(d._b.values); c, hi, lo, qv = blk[:, 3], blk[:, 1], blk[:, 2], blk[:, 4]
    cumq = np.cumsum(qv, axis=1)
    medq = pd.DataFrame(cumq).rolling(30, min_periods=20).median().shift(1).values
    for side in ("top", "bottom"):
        unit = (d.Uh * d.mult).values if side == "top" else (d.Dh * d.mult).values
        z = d.O.values * (np.exp(unit) if side == "top" else np.exp(-unit))
        at = (c >= z[:, None]) if side == "top" else (c <= z[:, None])
        at[:, :17] = False
        for j in np.where(np.isfinite(z) & at.any(1))[0]:
            i = int(np.argmax(at[j])); p = c[j, i]
            ext = (hi[j, i + 1:].max() if side == "top" else lo[j, i + 1:].min()) if i < 23 else p
            further = max(0.0, np.log(ext / p) if side == "top" else np.log(p / ext))
            vr = cumq[j, i] / medq[j, i] if np.isfinite(medq[j, i]) and medq[j, i] > 0 else np.nan
            rows.append(dict(sym=sym, side=side, date=d.date.values[j], near=further <= NEAR * unit[j], further_u=further / unit[j],
                             back=(c[j, -1] < z[j]) if side == "top" else (c[j, -1] > z[j]),
                             fade=np.log(p / c[j, -1]) if side == "top" else np.log(c[j, -1] / p), vr=vr))
R = pd.DataFrame(rows)
groups = (("all", lambda s: s.vr.notna() | s.vr.isna()), ("light", lambda s: s.vr < 1), ("normal", lambda s: (s.vr >= 1) & (s.vr < 2)), ("heavy", lambda s: s.vr >= 2))
ev = {}
for side in ("top", "bottom"):
    ev[side] = {}
    for lab, f in groups:
        cells = []
        for per, m in (("2018-22", R.date < SPLIT_SPOT), ("2023-26", R.date >= SPLIT_SPOT)):
            s = R[m & (R.side == side)]; s = s[f(s)]
            mm, t, n = clustered(s.fade, s.date)
            cells.append(f"{per}: n {n}, near {s.near.mean():.0%}, back inside {s.back.mean():.0%}, further median {s.further_u.median():.2f} p75 {s.further_u.quantile(.75):.2f}, close vs alert {mm * 1e4:+.0f}bp (t {t:+.1f})")
            if per == "2023-26":
                ev[side][lab] = dict(n=int(n), near=round(float(s.near.mean()), 2), backInside=round(float(s.back.mean()), 2),
                                     furtherMedian=round(float(s.further_u.median()), 2), furtherP75=round(float(s.further_u.quantile(.75)), 2),
                                     driftBp=int(round(-mm * 1e4)) if side == "top" else int(round(mm * 1e4)), driftT=round(float(t), 1))
        print(f"   {side:6s} {lab:7s} " + " || ".join(cells))
json.dump(ev, open(f"{HERE}/activity_evidence.json", "w"), indent=1)
print(json.dumps(ev))
share = R[R.date >= SPLIT_SPOT].groupby("side").vr.apply(lambda v: ((v < 1).mean(), ((v >= 1) & (v < 2)).mean(), (v >= 2).mean()))
print("share of alerts light/normal/heavy (2023-26):", share.to_dict())
