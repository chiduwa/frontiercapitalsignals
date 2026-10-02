"""Does unusual activity skew today's forecast range? (asked 2026-10-02:
"look out for unusual activity (volume, open interest, etc). if any of those
has been seen to affect movement, bake that into the forecast or the
notification ... in what direction and/or by what magnitude")

Day = the UTC day; forecast U^/D^ as live (60-day median x vol^0.5).
Activity known at 00:00 UTC, from the 24 hours before:
  vol24   log(spot quote volume, last 24h / median 24h volume over the 30 days before)
  ret24   last 24h return, in units of the coin's typical daily move
  oi24    log change in perp open interest (contracts) over the last 24h
  oidiv   oi24 - log return (new contracts vs price: the flush study's split)
  taker   perp taker-buy share of volume over the last 24h, minus 0.5
Targets:
  size  log((U + D) / (U^ + D^))     the day's range against the forecast
  skew  (U - D) / (U + D)            +1 = all of it up, -1 = all down
Periods: spot volume and returns 2018-22 / 2023-26; open interest and taker
flow only exist 2024-09..2026-09, halves split at 2025-09-01.

Then section 3: at a late-day alert (rule as live), does activity since the
open change the odds?
"""
import numpy as np, pandas as pd
from daytop import hourly, forecast, TRACKED, NEAR
from daytop_split import clustered

import os
from daytop import DATA
# Binance USD-M perpetual klines + 5-minute metrics, from the decoupling study's
# fetch_um.py (docs/research-2026-09-28-decoupling/scripts), 2024-09-01 on
UM = os.environ.get("DZ_PERP", os.path.join(DATA, "um"))
FC = dict(N=60, beta=0.5, weekday=False)
SPLIT_SPOT = pd.Timestamp("2023-01-01")
SPLIT_PERP = pd.Timestamp("2025-09-01")
HERE = DATA            # inputs (h1/) and intermediate files


def spot(sym):
    z = np.load(f"{HERE}/h1/{sym}.npz")
    df = pd.DataFrame(z["s"][:, :5], index=pd.to_datetime(z["t"], unit="ms"), columns=["o", "h", "l", "c", "qv"])
    df = df[~df.index.duplicated()].sort_index()
    if sym != "HYPE": df = df[df.index >= "2018-01-01"]
    return df.reindex(pd.date_range(df.index[0], df.index[-1], freq="h"))


def perp(sym):
    z = np.load(f"{UM}/{sym}.npz")
    k = z["klines"]; m = z["metrics"]
    kl = pd.DataFrame(k[:, 1:], index=pd.to_datetime(k[:, 0].astype(np.int64), unit="ms"),
                      columns=["o", "h", "l", "c", "v", "qv", "trades", "tbv", "tbqv"])
    kl = kl[~kl.index.duplicated()].sort_index()
    met = pd.DataFrame(m[:, 1:], index=pd.to_datetime(m[:, 0].astype(np.int64), unit="ms") + pd.Timedelta(minutes=5),
                       columns=["oi", "oiusd", "topacc", "toppos", "allacc", "taker"])
    met = met[~met.index.duplicated()].sort_index()
    return kl, met


def days(sym):
    """One row per complete UTC day: realized U/D, forecast, activity at 00:00, and the hourly path."""
    df = spot(sym)
    starts = np.where(df.index.hour == 0)[0]
    starts = starts[(starts >= 25) & (starts + 24 <= len(df))]
    idx = starts[:, None] + np.arange(24)
    b = {k: df[k].values[idx] for k in ("o", "h", "l", "c", "qv")}
    ok = np.isfinite(b["c"]).all(1) & np.isfinite(b["h"]).all(1)
    starts = starts[ok]; b = {k: v[ok] for k, v in b.items()}
    dates = df.index[starts]
    O = b["o"][:, 0]
    U, D = np.log(b["h"].max(1) / O), np.log(O / b["l"].min(1))
    pidx = starts[:, None] - 25 + np.arange(25)
    pc = df["c"].values[pidx]
    Uh, Dh = forecast(U, D, pc, dates, **FC)
    q24 = df["qv"].rolling(24, min_periods=20).sum()
    prev_q = q24.values[starts - 1]                                  # the 24h ending at the open
    med_q = pd.Series(prev_q, index=dates).rolling(30, min_periods=20).median().shift(1).values
    typ = pd.Series((U + D) / 2, index=dates).rolling(60, min_periods=40).median().shift(1).values
    ret24 = np.log(O / df["c"].values[starts - 25])
    out = pd.DataFrame({"sym": sym, "date": dates, "U": U, "D": D, "Uh": Uh, "Dh": Dh, "O": O,
                        "vol24": np.log(prev_q / med_q), "ret24": ret24 / typ, "ret24raw": ret24})
    out["size"] = np.log((U + D) / (Uh + Dh))
    out["skew"] = (U - D) / (U + D)
    # perp activity, where it exists
    try:
        kl, met = perp(sym)
        oi = met["oi"]
        at = lambda t: oi.asof(t) if t >= oi.index[0] else np.nan
        o0 = np.array([at(t) for t in dates]); o1 = np.array([at(t - pd.Timedelta(hours=24)) for t in dates])
        out["oi24"] = np.log(o0 / o1)
        out["oidiv"] = out["oi24"] - out["ret24raw"]
        tb = kl["tbqv"].rolling(24, min_periods=20).sum() / kl["qv"].rolling(24, min_periods=20).sum()
        out["taker"] = tb.reindex(dates - pd.Timedelta(hours=1)).values - 0.5
        out["has_perp"] = np.isfinite(out["oi24"]) & np.isfinite(out["taker"])
    except FileNotFoundError:
        out["oi24"] = out["oidiv"] = out["taker"] = np.nan; out["has_perp"] = False
    out["_b"] = list(np.stack([b["o"], b["h"], b["l"], b["c"], b["qv"]], axis=1))
    return out[np.isfinite(out.Uh)]


def zs(s, by):
    return s.groupby(by).transform(lambda x: (x - x.mean()) / x.std())


def reg(df, y, xs):
    """Pooled OLS on within-coin z-scored features, coin intercepts, date-clustered t."""
    d = df[[y, "date", "sym"] + xs].replace([np.inf, -np.inf], np.nan).dropna()
    if len(d) < 200: return {x: (np.nan, np.nan) for x in xs}, len(d)
    X = np.column_stack([zs(d[x], d.sym).values for x in xs] + [pd.get_dummies(d.sym).values.astype(float)])
    yv = d[y].values
    beta, *_ = np.linalg.lstsq(X, yv, rcond=None)
    e = yv - X @ beta
    XtX = np.linalg.pinv(X.T @ X)
    g = pd.DataFrame(X * e[:, None]).groupby(d.date.values).sum().values
    V = XtX @ (g.T @ g) @ XtX
    return {x: (beta[i], beta[i] / np.sqrt(V[i, i])) for i, x in enumerate(xs)}, len(d)


if __name__ == "__main__":
    A = pd.concat([days(s) for s in TRACKED], ignore_index=True)
    print(f"{len(A):,} coin-days; with perp activity {int(A.has_perp.sum()):,}")
    print("\n## 1. Does activity at the open change the size of the day's move (vs the forecast) or tilt it up/down?")
    print("   slope per 1 sd of the feature (within coin); size in log points of range, skew in units of (U-D)/(U+D); date-clustered t")
    for label, xs, per_split, sub in (
            ("spot volume and the last day's move", ["vol24", "ret24"], SPLIT_SPOT, A),
            ("+ open interest and taker flow (perps)", ["vol24", "ret24", "oi24", "oidiv", "taker"], SPLIT_PERP, A[A.has_perp])):
        for y in ("size", "skew"):
            cells = []
            for per, m in (("first", sub.date < per_split), ("second", sub.date >= per_split)):
                r, n = reg(sub[m], y, xs)
                cells.append(f"{per} (n {n}): " + ", ".join(f"{x} {r[x][0]:+.3f} (t {r[x][1]:+.1f})" for x in xs))
            print(f"   {y:4s} | {label}\n        " + "\n        ".join(cells))
    A.drop(columns=["_b"]).to_pickle(f"{HERE}/activity_days.pkl")
    pd.to_pickle(A[["sym", "date", "_b", "O", "Uh", "Dh"]], f"{HERE}/activity_paths.pkl")
