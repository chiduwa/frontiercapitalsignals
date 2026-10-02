"""The alert as it would run live: midnight-UTC day, forecast top/bottom at
k = 1 (median excursion x the volatility scale), checked on a sampled price
(the hourly close stands in for the Worker's 5-minute tick). A push goes out
the first time price is at or beyond the zone with at most LATE hours of the
UTC day left; one per coin per side per day. Odds measured from that price.
Compared with: the same rule on every touch at any hour, and the rule on the
random-sign copies (closes only, both sides)."""
import numpy as np, pandas as pd
from daytop import hourly, windows, excursions, forecast, null_copy, TRACKED, SPLIT, NEAR
from daytop_split import clustered

FC = dict(N=60, beta=0.5, weekday=False)            # the live forecast: no weekday factor (it needs a year of hourly bars)
data = {s: hourly(s) for s in TRACKED}


def rule(df, late, R=0):
    dates, b, pc = windows(df, R)
    U, D, O = excursions(b)
    Uh, Dh = forecast(U, D, pc, dates, **FC)
    Uh[:60] = np.nan
    first = 24 - late - 1                            # first bar whose close is at most `late` hours before the end
    rows = []
    for side in ("top", "bottom"):
        z = O * np.exp(Uh) if side == "top" else O * np.exp(-Dh)
        c = b["c"]
        at = (c >= z[:, None]) if side == "top" else (c <= z[:, None])
        at[:, :first] = False
        for j in np.where(np.isfinite(z) & at.any(1))[0]:
            i = int(np.argmax(at[j]))
            p = c[j, i]
            if i < 23:
                ext = b["h"][j, i + 1:].max() if side == "top" else b["l"][j, i + 1:].min()
                further = max(0.0, np.log(ext / p)) if side == "top" else max(0.0, np.log(p / ext))
            else:
                further = 0.0
            unit = Uh[j] if side == "top" else Dh[j]
            back = (c[j, -1] < z[j]) if side == "top" else (c[j, -1] > z[j])
            fade = np.log(p / c[j, -1]) if side == "top" else np.log(c[j, -1] / p)
            rows.append(dict(side=side, date=dates[j], hour=i, left=23 - i, further_u=further / unit, further_pct=np.expm1(further) * 100,
                             near=further <= NEAR * unit, back=back, fade=fade, per="A" if dates[j] < SPLIT else "B"))
    elig = pd.Series(np.isfinite(Uh), index=dates)
    return pd.DataFrame(rows), elig


def summary(rows, elig, label):
    for side in ("top", "bottom"):
        cells = []
        for per in ("A", "B"):
            s = rows[(rows.side == side) & (rows.per == per)]
            e = elig[(elig.index < SPLIT) if per == "A" else (elig.index >= SPLIT)]
            if len(s) < 30: cells.append(f"{per}: n {len(s)}"); continue
            m, t, n = clustered(s.fade, s.date)
            cells.append(f"{per}: {n / e.sum():.0%} of coin-days, near {s.near.mean():.0%}, further median {s.further_u.median():.2f} ({s.further_pct.median():.2f}%) p75 {s.further_u.quantile(.75):.2f}, "
                         f"back inside {s.back.mean():.0%}, from alert to close {m * 1e4:+.0f}bp (t {t:+.1f})")
        print(f"   {label:34s} {side:6s} " + " || ".join(cells))


for late in (8, 6, 4):
    print(f"\n## push when at/beyond the forecast zone with <= {late}h of the UTC day left")
    R_, E_, N_, NE_ = [], [], [], []
    for sym, df in data.items():
        r, e = rule(df, late); R_.append(r.assign(sym=sym)); E_.append(e)
        for c in range(3):
            nr, ne = rule(null_copy(df, 300 + c), late); N_.append(nr.assign(sym=sym)); NE_.append(ne)
    summary(pd.concat(R_), pd.concat(E_), "real coins")
    summary(pd.concat(N_), pd.concat(NE_), "random-sign copies (closes)")
print("\n## for scale: every first touch, any hour")
R_, E_ = [], []
for sym, df in data.items():
    r, e = rule(df, 23); R_.append(r.assign(sym=sym)); E_.append(e)
summary(pd.concat(R_), pd.concat(E_), "real coins, any hour")
