"""Section 3: at the late-day alert (price at/beyond the forecast level with
<= 6h of the UTC day left, hourly closes as the live tick), does what happened
since the open change the odds?
  volume so far   spot quote volume since 00:00 / the median for the same hours over the 30 days before
  OI since open   log change in perp open interest (contracts) from 00:00 to the alert hour
  taker since     perp taker-buy share of volume since 00:00, minus 0.5
For tops, the flush study's rule says OI FALLING into a spike = shorts closing
(mechanical, reverses) and OI RISING = new longs (continues). Tested here on
whole-day zone touches. Outcomes as before: near (the day's extreme within a
quarter of a typical move), back inside by the close, close vs alert (bp)."""
import numpy as np, pandas as pd
from activity import HERE, perp, SPLIT_SPOT, SPLIT_PERP, TRACKED
from daytop import NEAR
from daytop_split import clustered

P = pd.read_pickle(f"{HERE}/activity_paths.pkl")
rows = []
for sym in TRACKED:
    d = P[P.sym == sym].reset_index(drop=True)
    if d.empty: continue
    blk = np.stack(d._b.values)                         # (n, 5, 24): o h l c qv
    c, h, l, qv = blk[:, 3], blk[:, 1], blk[:, 2], blk[:, 4]
    cumq = np.cumsum(qv, axis=1)
    medq = pd.DataFrame(cumq).rolling(30, min_periods=20).median().shift(1).values   # same hours, the 30 days before
    try:
        kl, met = perp(sym)
        oi = met["oi"]
        tb = kl["tbqv"]; tq = kl["qv"]
    except FileNotFoundError:
        oi = None
    for side in ("top", "bottom"):
        z = d.O.values * (np.exp(d.Uh.values) if side == "top" else np.exp(-d.Dh.values))
        at = (c >= z[:, None]) if side == "top" else (c <= z[:, None])
        at[:, :17] = False
        for j in np.where(np.isfinite(z) & at.any(1))[0]:
            i = int(np.argmax(at[j])); p = c[j, i]
            unit = d.Uh.values[j] if side == "top" else d.Dh.values[j]
            if i < 23:
                ext = h[j, i + 1:].max() if side == "top" else l[j, i + 1:].min()
                further = max(0.0, np.log(ext / p)) if side == "top" else max(0.0, np.log(p / ext))
            else:
                further = 0.0
            date = d.date.values[j]
            t_open = pd.Timestamp(date); t_alert = t_open + pd.Timedelta(hours=i + 1)    # the close of bar i
            r = dict(sym=sym, side=side, date=t_open, near=further <= NEAR * unit, further_u=further / unit,
                     back=(c[j, -1] < z[j]) if side == "top" else (c[j, -1] > z[j]),
                     fade=np.log(p / c[j, -1]) if side == "top" else np.log(c[j, -1] / p),
                     volsofar=np.log(cumq[j, i] / medq[j, i]) if np.isfinite(medq[j, i]) and medq[j, i] > 0 else np.nan,
                     oichg=np.nan, taker=np.nan)
            if oi is not None and t_open >= oi.index[0]:
                o0, o1 = oi.asof(t_open), oi.asof(t_alert)
                r["oichg"] = np.log(o1 / o0) if o0 and o1 else np.nan
                sl = slice(t_open, t_alert - pd.Timedelta(hours=1))
                q = tq.loc[sl].sum()
                r["taker"] = tb.loc[sl].sum() / q - 0.5 if q > 0 else np.nan
            rows.append(r)
R = pd.DataFrame(rows)
R.to_pickle(f"{HERE}/activity_alerts.pkl")


def show(sub, label):
    if len(sub) < 25: return f"{label}: n {len(sub)}"
    m, t, n = clustered(sub.fade, sub.date)
    return f"{label}: n {n}, near {sub.near.mean():.0%}, back inside {sub.back.mean():.0%}, further {sub.further_u.median():.2f}, close vs alert {m * 1e4:+.0f}bp (t {t:+.1f})"


print("## 3. Late-day alerts by what happened since the open")
for feat, split, groups in (
        ("volsofar", SPLIT_SPOT, (("volume so far below normal", lambda s: s.volsofar < 0), ("1-2x normal", lambda s: (s.volsofar >= 0) & (s.volsofar < np.log(2))), ("over 2x normal", lambda s: s.volsofar >= np.log(2)))),
        ("oichg", SPLIT_PERP, (("open interest FELL since the open", lambda s: s.oichg < -0.01), ("roughly flat (+-1%)", lambda s: s.oichg.abs() <= 0.01), ("open interest ROSE", lambda s: s.oichg > 0.01))),
        ("taker", SPLIT_PERP, (("sellers dominated (taker buy < 49%)", lambda s: s.taker < -0.01), ("balanced", lambda s: s.taker.abs() <= 0.01), ("buyers dominated (> 51%)", lambda s: s.taker > 0.01)))):
    for side in ("top", "bottom"):
        base = R[(R.side == side) & R[feat].notna()]
        print(f"\n   {side}, by {feat}:")
        for lab, f in groups:
            cells = [show(base[(base.date < split)][f(base[base.date < split])], "first"), show(base[(base.date >= split)][f(base[base.date >= split])], "second")]
            print(f"     {lab:38s} " + " || ".join(cells))
