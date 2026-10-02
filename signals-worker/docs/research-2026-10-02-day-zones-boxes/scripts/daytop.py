"""Day tops and bottoms for the always-tracked coins: a 24-hour window opens at
a reference hour R (UTC). At R, the forecast top is open x exp(k * U^) and
the forecast bottom open x exp(-k * D^), where U^ and D^ are the typical
up- and down-excursions of a window (median of past windows at the same R),
optionally scaled by a volatility forecast for the day. An alert fires when
price reaches a zone.

Questions:
  1. which forecast of the day's excursion is most accurate (median window,
     volatility scaling, weekday), judged by the median's own loss |U - U^|
  2. for each R, when an alert fires: how much further does price go, how
     often was it within a quarter of a typical excursion of the actual
     extreme, and where does the window close (the fade)
  3. is any of that more than a random walk gives? Each coin's hourly moves
     with their signs randomized (sizes, clustering and the time-of-day
     rhythm kept) go through the same rule.
Periods: A to 2022-12 (BTC ETH SOL XLM XRP HBAR), B 2023-01 on (all eight).
"""
import os, sys, json
import numpy as np, pandas as pd
from stats_util import nw_mean

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("DZ_DATA", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "reports", "day-zones"))   # fetch.py writes h1/ and d1s/ here (gitignored)
TRACKED = ["BTC", "ETH", "SOL", "XLM", "XRP", "HYPE", "HBAR", "ARB"]
SPLIT = pd.Timestamp("2023-01-01")
NEAR = 0.25            # "near the top": within a quarter of a typical excursion of the actual extreme


def hourly(sym):
    z = np.load(f"{DATA}/h1/{sym}.npz")
    df = pd.DataFrame(z["s"][:, :4], index=pd.to_datetime(z["t"], unit="ms"), columns=["o", "h", "l", "c"])
    df = df[~df.index.duplicated()].sort_index()
    if sym != "HYPE": df = df[df.index >= "2018-01-01"]
    return df.reindex(pd.date_range(df.index[0], df.index[-1], freq="h"))


def windows(df, R):
    """(n, 24) blocks of o/h/l/c for every complete window starting at hour R."""
    starts = np.where(df.index.hour == R)[0]
    starts = starts[starts + 24 <= len(df)]
    idx = starts[:, None] + np.arange(24)
    blk = {k: df[k].values[idx] for k in "ohlc"}
    ok = np.isfinite(blk["c"]).all(1) & np.isfinite(blk["h"]).all(1) & np.isfinite(blk["l"]).all(1)
    # the 24 hours before each start, for the volatility forecast: the closes of
    # the 25 bars that END at or before the window opens (the last is the open)
    pidx = starts[:, None] - 25 + np.arange(25)
    pidx = np.clip(pidx, 0, len(df) - 1)
    prev_c = df["c"].values[pidx]
    return df.index[starts][ok], {k: v[ok] for k, v in blk.items()}, prev_c[ok]


def excursions(b):
    O = b["o"][:, 0]
    return np.log(b["h"].max(1) / O), np.log(O / b["l"].min(1)), O


def forecast(U, D, prev_c, dates, N=60, beta=0.0, weekday=False):
    """U^, D^ for window j from windows before j only."""
    n = len(U)
    Uh, Dh = np.full(n, np.nan), np.full(n, np.nan)
    r_prev = np.diff(np.log(prev_c), axis=1)
    sig = np.nanstd(r_prev, axis=1)                      # last 24 hours' hourly volatility
    dow = dates.dayofweek.values
    for j in range(N, n):
        u, d = np.median(U[j - N:j]), np.median(D[j - N:j])
        s = 1.0
        if beta:
            typ = np.nanmedian(sig[j - N:j])
            if typ > 0 and np.isfinite(sig[j]): s *= (sig[j] / typ) ** beta
        if weekday and j >= 364:
            rng_ = U[j - 364:j] + D[j - 364:j]
            same = rng_[dow[j - 364:j] == dow[j]]
            s *= np.median(same) / np.median(rng_)
        Uh[j], Dh[j] = u * s, d * s
    return Uh, Dh


def alerts(b, O, Uh, Dh, k, side, closes_only=False):
    """First touch of the zone in each window; outcomes from the zone price."""
    h = b["c"] if closes_only else b["h"]
    l = b["c"] if closes_only else b["l"]
    c = b["c"]
    n = len(O)
    rows = []
    for j in range(n):
        if not np.isfinite(Uh[j]): continue
        if side == "top":
            z = O[j] * np.exp(k * Uh[j])
            hit = np.where(h[j] >= z)[0]
            if not len(hit): continue
            i = hit[0]
            further = np.log(h[j, i:].max() / z)
            fade = np.log(z / c[j, -1])
            unit = Uh[j]
        else:
            z = O[j] * np.exp(-k * Dh[j])
            hit = np.where(l[j] <= z)[0]
            if not len(hit): continue
            i = hit[0]
            further = np.log(z / l[j, i:].min())
            fade = np.log(c[j, -1] / z)
            unit = Dh[j]
        rows.append((j, i, further, fade, further <= NEAR * unit, unit))
    return pd.DataFrame(rows, columns=["j", "hour", "further", "fade", "near", "unit"])


def null_copy(df, seed):
    """Same hourly move sizes in the same order, random signs; closes only."""
    r = np.log(df.c).diff().values
    rng = np.random.default_rng(seed)
    s = np.where(rng.random(len(r)) < 0.5, -1.0, 1.0)
    rr = np.nan_to_num(r) * s
    c = np.exp(np.cumsum(rr)) * df.c.iloc[0]
    c[~np.isfinite(r)] = np.nan
    out = pd.DataFrame({"o": np.r_[c[0], c[:-1]], "h": c, "l": c, "c": c}, index=df.index)
    return out


if __name__ == "__main__":
    data = {s: hourly(s) for s in TRACKED}
    # ---- 1. which forecast of a window's excursion? (R = 0, every coin; then checked at every R below)
    print("## 1. Forecasting the day's excursion: mean |U - U^| + |D - D^| (lower is better), relative to the 60-window median")
    variants = [("median, 30 windows", dict(N=30)), ("median, 60 windows", dict(N=60)), ("median, 90 windows", dict(N=90)),
                ("60 + vol scaling ^0.5", dict(N=60, beta=0.5)), ("60 + vol scaling ^1", dict(N=60, beta=1.0)),
                ("60 + weekday", dict(N=60, weekday=True)), ("60 + vol ^0.5 + weekday", dict(N=60, beta=0.5, weekday=True))]
    loss = {v: {"A": [], "B": []} for v, _ in variants}
    for sym, df in data.items():
        for R in (0, 8, 14, 20):
            dates, b, pc = windows(df, R)
            U, D, O = excursions(b)
            base = None
            for name, kw in variants:
                Uh, Dh = forecast(U, D, pc, dates, **kw)
                ok = np.isfinite(Uh) & (np.arange(len(U)) >= 364)          # same windows for every variant
                L = np.abs(U - Uh) + np.abs(D - Dh)
                for per, m in (("A", dates < SPLIT), ("B", dates >= SPLIT)):
                    sel = ok & m
                    if sel.sum() > 30: loss[name][per].append((sym, R, np.mean(L[sel])))
    for per in ("A", "B"):
        ref = {(s, R): x for s, R, x in loss["median, 60 windows"][per]}
        print(f"   period {per}: " + " | ".join(f"{name} {np.mean([x / ref[(s, R)] for s, R, x in loss[name][per]]):.3f}" for name, _ in variants))
    json.dump({k: {p: v for p, v in d.items()} for k, d in loss.items()}, open(f"{DATA}/daytop_loss.json", "w"), default=float)
