"""Day top/bottom alerts, the follow-ups:
  1. per-alert fade with date-clustered errors (the daily-average reading in
     daytop_report weighted a market-wide day once and a lone spike once)
  2. split by what the rest of the tracked coins were doing at the alert hour:
     SOLO (no more than one other coin up/down half a typical excursion from its
     own open) vs WITH THE MARKET
  3. forecast accuracy of the window's high and low by reference hour
  4. what the alert can honestly say: P(the day's extreme goes further than x),
     by how far price has already gone, per coin
"""
import numpy as np, pandas as pd
from daytop import hourly, windows, excursions, forecast, TRACKED, SPLIT, NEAR

FC = dict(N=60, beta=0.5, weekday=True)
data = {s: hourly(s) for s in TRACKED}


def clustered(values, dates):
    v = np.asarray(values, float); d = pd.Index(dates).normalize()
    m = v.mean()
    g = pd.Series(v - m).groupby(np.asarray(d)).sum()
    se = np.sqrt((g ** 2).sum()) / len(v)
    return m, m / se if se > 0 else np.nan, len(v)


def build(R, k):
    """Alert rows for every coin at reference hour R, with the market context."""
    per = {}
    for sym, df in data.items():
        dates, b, pc = windows(df, R)
        U, D, O = excursions(b)
        Uh, Dh = forecast(U, D, pc, dates, **FC)
        Uh[:364] = np.nan; Dh[:364] = np.nan
        # path of each window in units of the coin's own typical excursion, hour by hour
        up_u = np.log(b["h"] / O[:, None]) / Uh[:, None]
        dn_u = np.log(O[:, None] / b["l"]) / Dh[:, None]
        per[sym] = dict(dates=dates, b=b, O=O, Uh=Uh, Dh=Dh, up_u=up_u, dn_u=dn_u, U=U, D=D)
    rows = []
    for sym, x in per.items():
        for side in ("top", "bottom"):
            path = x["up_u"] if side == "top" else x["dn_u"]
            hit = path >= k
            for j in np.where(np.isfinite(x["Uh"]) & hit.any(1))[0]:
                i = int(np.argmax(hit[j]))
                d = x["dates"][j]
                # the other coins at the same hour of the same window
                others = 0
                for s2, y in per.items():
                    if s2 == sym: continue
                    jj = y["dates"].get_indexer([d])[0]
                    if jj < 0 or not np.isfinite(y["Uh"][jj]): continue
                    p2 = y["up_u"] if side == "top" else y["dn_u"]
                    if p2[jj, i] >= 0.5: others += 1
                b = x["b"]
                if side == "top":
                    z = x["O"][j] * np.exp(k * x["Uh"][j]); ext = b["h"][j, i:].max(); further = np.log(ext / z); fade = np.log(z / b["c"][j, -1]); unit = x["Uh"][j]
                else:
                    z = x["O"][j] * np.exp(-k * x["Dh"][j]); ext = b["l"][j, i:].min(); further = np.log(z / ext); fade = np.log(b["c"][j, -1] / z); unit = x["Dh"][j]
                rows.append(dict(sym=sym, side=side, date=d, hour=i, others=others, further_u=further / unit, fade=fade,
                                 near=further <= NEAR * unit, per="A" if d < SPLIT else "B"))
    return pd.DataFrame(rows)


if __name__ == "__main__":
    print("## 1-2. Per-alert outcome (window close vs alert price, bp; + = price came back), date-clustered t")
    for R in (0, 8, 14, 20):
        for k in (1.0, 1.5):
            A = build(R, k)
            for side in ("top", "bottom"):
                cells = []
                for per in ("A", "B"):
                    s = A[(A.side == side) & (A.per == per)]
                    m, t, n = clustered(s.fade, s.date)
                    so = s[s.others <= 1]; mk = s[s.others >= 3]
                    m1, t1, n1 = clustered(so.fade, so.date) if len(so) > 20 else (np.nan, np.nan, len(so))
                    m2, t2, n2 = clustered(mk.fade, mk.date) if len(mk) > 20 else (np.nan, np.nan, len(mk))
                    cells.append(f"{per}: all {m * 1e4:+.0f}bp t{t:+.1f} (n{n}, near {s.near.mean():.0%}, further {s.further_u.median():.2f}) | "
                                 f"solo {m1 * 1e4:+.0f} t{t1:+.1f} (n{n1}, near {so.near.mean():.0%}) | with market {m2 * 1e4:+.0f} t{t2:+.1f} (n{n2}, near {mk.near.mean():.0%})")
                print(f"   R={R:02d} k={k} {side:6s} " + "  ||  ".join(cells))

    print("\n## 3. Forecast accuracy by reference hour: mean |U-U^|/U^ and |D-D^|/D^ (lower is better), pooled over coins")
    acc = []
    for R in range(24):
        for sym, df in data.items():
            dates, b, pc = windows(df, R)
            U, D, O = excursions(b)
            Uh, Dh = forecast(U, D, pc, dates, **FC)
            ok = np.isfinite(Uh) & (np.arange(len(U)) >= 364)
            for per, m in (("A", dates < SPLIT), ("B", dates >= SPLIT)):
                sel = ok & m
                if sel.sum() < 30: continue
                acc.append(dict(R=R, sym=sym, per=per, up=np.mean(np.abs(U[sel] - Uh[sel]) / Uh[sel]), dn=np.mean(np.abs(D[sel] - Dh[sel]) / Dh[sel]),
                                cover_up=np.mean(U[sel] <= Uh[sel]), cover_dn=np.mean(D[sel] <= Dh[sel])))
    A = pd.DataFrame(acc)
    t = A.groupby(["R", "per"])[["up", "dn", "cover_up", "cover_dn"]].mean().unstack("per").round(3)
    print(t.to_string())
    print("   (cover = share of days whose excursion stayed inside the forecast: 50% is a well-calibrated median)")
