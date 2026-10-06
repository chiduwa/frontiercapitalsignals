"""The alert as it runs live, with the old band (day-zones-v2: 60-day median x
vol^0.5 x activity) and the new one (day-zones-v3: the median regression
ablate.py fitted), 2023-26 and 2018-22. Same rule and outcome definitions as
the 2026-10-02 study's activity4.py, so the v2 row must reproduce the odds in
worker.js DAY_ZONE_EVIDENCE; the v3 row is what replaces them.

  alert   first hourly close at/beyond the level with <= 6h of the UTC day left
  near    the day's extreme ended within a quarter of the band's own move of it
  further how far the extreme went past the alert price, in band units
  back    the day closed back inside the level
  drift   alert price -> close (top: + = kept rising; bottom: + = bounced)
  volume  today's volume so far vs the same hours' median over the 30 days before
"""
import json
import numpy as np, pandas as pd
from stats_util import nw_mean
from zone_methods import OUT, SPLIT, TRACKED, load
from ablate import SETS

NEAR = 0.25
SHIP = "+ last week + tail gap + weekday"
COEF = json.load(open(f"{OUT}/qr_final.json"))[SHIP]
CAP = 4.0              # day-zones.mjs DAY_ZONE.maxVsMedian


def clustered(values, dates):
    v = np.asarray(values, float); d = pd.Index(dates).normalize()
    m = v.mean()
    g = pd.Series(v - m).groupby(np.asarray(d)).sum()
    se = np.sqrt((g ** 2).sum()) / len(v)
    return m, m / se if se > 0 else np.nan, len(v)


def band(S, side, coef, cap=CAP):
    f1, f7, fg, med = {"U": ("x_u1", "x_u7", "x_gapU", "medU"), "D": ("x_d1", "x_d7", "x_gapD", "medD")}[side]
    x = {"x_vol": S.x_vol, "x_q": S.x_q, "x_move": S.x_move, "x7": S[f7], "xgap": S[fg], "x1": S[f1],
         **{f"dow{k}": (S.dow == k).astype(float) for k in range(6)}}
    lin = coef["const"] + sum(coef[c] * x[c] for c in SETS[SHIP])
    return S[med] * np.minimum(np.exp(lin), cap if cap else np.inf)


def blocks(sym):
    df = load(sym)
    o, h, l, c, qv = (df[k].values for k in ("o", "h", "l", "c", "qv"))
    starts = np.where(df.index.hour == 0)[0]
    starts = starts[(starts >= 25) & (starts + 24 <= len(df))]
    idx = starts[:, None] + np.arange(24)
    ok = np.isfinite(c[idx]).all(1) & np.isfinite(h[idx]).all(1) & np.isfinite(l[idx]).all(1) & np.isfinite(o[idx]).all(1)
    starts, idx = starts[ok], idx[ok]
    return pd.DataFrame({"date": df.index[starts], "_c": list(c[idx]), "_h": list(h[idx]), "_l": list(l[idx]), "_q": list(qv[idx])})


def alerts(A, bands):
    rows = []
    for sym in TRACKED:
        d = A[A.sym == sym].sort_values("date").reset_index(drop=True)
        if d.empty: continue
        d = d.merge(blocks(sym), on="date")
        c, hi, lo = np.stack(d._c.values), np.stack(d._h.values), np.stack(d._l.values)
        cumq = np.cumsum(np.stack(d._q.values), axis=1)
        medq = pd.DataFrame(cumq).rolling(30, min_periods=20).median().shift(1).values
        d["k"] = np.arange(len(d))           # rows start at day 60; activity4.py alerted from day 364
        for name, (bu, bd) in bands.items():
            for side in ("top", "bottom"):
                unit = (bu if side == "top" else bd)(d).values
                z = d.O.values * (np.exp(unit) if side == "top" else np.exp(-unit))
                at = (c >= z[:, None]) if side == "top" else (c <= z[:, None])
                at[:, :17] = False
                for j in np.where(np.isfinite(z) & at.any(1) & (d.k.values >= 304))[0]:
                    i = int(np.argmax(at[j])); p = c[j, i]
                    ext = (hi[j, i + 1:].max() if side == "top" else lo[j, i + 1:].min()) if i < 23 else p
                    further = max(0.0, np.log(ext / p) if side == "top" else np.log(p / ext))
                    vr = cumq[j, i] / medq[j, i] if np.isfinite(medq[j, i]) and medq[j, i] > 0 else np.nan
                    rows.append(dict(band=name, sym=sym, side=side, date=d.date.values[j], near=further <= NEAR * unit[j],
                                     further_u=further / unit[j], further_pct=further * 100,
                                     back=(c[j, -1] < z[j]) if side == "top" else (c[j, -1] > z[j]),
                                     drift=np.log(c[j, -1] / p) if side == "top" else np.log(c[j, -1] / p), vr=vr))
    return pd.DataFrame(rows)


if __name__ == "__main__":
    A = pd.read_pickle(f"{OUT}/zone_scored.pkl")
    A = A[A[["x_vol", "x_q", "x_move", "medU", "medD", "x_u7", "x_gapU", "x_d7", "x_gapD"]].notna().all(1)]
    frozenA = {s: COEF[s]["fitted_2019_22"] for s in ("U", "D")}
    bands = {"v2 (live)": (lambda d: d["median|U|0.5"], lambda d: d["median|D|0.5"]),
             "v3 (median regression)": (lambda d: band(d, "U", COEF["U"]), lambda d: band(d, "D", COEF["D"])),
             "v3 fitted on 2019-22 only": (lambda d: band(d, "U", frozenA["U"]), lambda d: band(d, "D", frozenA["D"]))}
    R = alerts(A, bands)
    days_ = A.groupby(np.where(A.date < SPLIT, "2018-22", "2023-26")).apply(lambda g: g.groupby("sym").size().sum())
    groups = (("all", lambda s: s.vr.notna() | s.vr.isna()), ("light", lambda s: s.vr < 1),
              ("normal", lambda s: (s.vr >= 1) & (s.vr < 2)), ("heavy", lambda s: s.vr >= 2))
    ev = {}
    for name in bands:
        print(f"\n## {name}")
        ev[name] = {}
        for side in ("top", "bottom"):
            ev[name][side] = {}
            for lab, f in groups:
                cells = []
                for per, m in (("2018-22", R.date < SPLIT), ("2023-26", R.date >= SPLIT)):
                    s = R[m & (R.band == name) & (R.side == side)]; s = s[f(s)]
                    mm, t, n = clustered(s.drift, s.date)
                    sign = 1 if side == "top" else 1
                    cells.append(f"{per}: n {n}, near {s.near.mean():.0%}, back {s.back.mean():.0%}, further {s.further_u.median():.2f}/{s.further_u.quantile(.75):.2f} "
                                 f"({s.further_pct.median():.2f}%), drift {sign * mm * 1e4:+.0f}bp (t {t:+.1f})")
                    if per == "2023-26":
                        ev[name][side][lab] = dict(n=int(n), near=round(float(s.near.mean()), 2), backInside=round(float(s.back.mean()), 2),
                                                   furtherMedian=round(float(s.further_u.median()), 2), furtherP75=round(float(s.further_u.quantile(.75)), 2),
                                                   driftBp=int(round(mm * 1e4)), driftT=round(float(t), 1))
                print(f"   {side:6s} {lab:7s} " + " || ".join(cells))
        for per, m in (("2018-22", R.date < SPLIT), ("2023-26", R.date >= SPLIT)):
            s = R[m & (R.band == name)]
            perday = s.groupby(pd.Index(s.date).normalize()).size()
            print(f"   {per}: {len(s)} alerts, {perday.sum() / perday.index.nunique():.2f} per alert day; "
                  f"share light/normal/heavy {(s.vr < 1).mean():.0%}/{((s.vr >= 1) & (s.vr < 2)).mean():.0%}/{(s.vr >= 2).mean():.0%}")
    json.dump(ev, open(f"{OUT}/evidence.json", "w"), indent=1)
    print("\nv3 DAY_ZONE_EVIDENCE:", json.dumps(ev["v3 (median regression)"]))
