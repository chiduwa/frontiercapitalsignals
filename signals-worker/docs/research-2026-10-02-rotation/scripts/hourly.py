"""How fast does a category's move reach its other coins, if at all?

Hourly Binance spot, 2024-01..2026-08, listed and delisted coins (the
2026-09-29 hourly archive), so this window is close to survivorship-free.
Everything is in excess of the equal-weight market, so a market-wide hour is
not counted as a category one.

At each hourly close t, for each coin, leave-one-out over its category:
  catX      peers' mean excess move this hour (signed)
  catAbs    peers' mean |excess move| this hour
  catVolS   peers' mean log volume surge (this hour vs the coin's median hour over the last week)
Controls: the coin's own excess move, |move|, 24h volatility and volume surge.

Outcomes over three windows after t: hour +1, hours +2..+4, hours +5..+24
  size:      within-hour rank of |excess move|
  direction: excess move in bp
Per-hour cross-sectional regressions on within-hour ranks, averaged by day,
Newey-West t over days, by half of the window.
"""
import glob, os
import numpy as np, pandas as pd
from panel import ARCH, EXCLUDE, tokenized_stocks
from rot_panel import load

T0 = pd.Timestamp("2024-01-01"); TEND = pd.Timestamp("2026-09-01")
SPLIT = pd.Timestamp("2025-05-01")
MIN_PEERS = 4


def load_hourly(keep):
    idx = pd.date_range(T0, TEND, freq="h", inclusive="left")
    C, Q = {}, {}
    for f in glob.glob(os.path.join(ARCH, "*.npz")):
        s = os.path.basename(f)[:-4]
        if s not in keep: continue
        z = np.load(f)
        if "empty" in z.files: continue
        t = pd.to_datetime(z["s_t"], unit="ms")
        C[s] = pd.Series(z["s"][:, 3].astype(float), t); Q[s] = pd.Series(z["s"][:, 4].astype(float), t)
    C = pd.DataFrame(C).reindex(idx); Q = pd.DataFrame(Q).reindex(idx)
    return C, Q


def loo_mean(V, groups, cols):
    """Leave-one-out mean of V within each group, per row. NaN with < MIN_PEERS peers."""
    out = pd.DataFrame(np.nan, index=V.index, columns=cols)
    for g, mem in groups.items():
        mem = [m for m in mem if m in V.columns]
        if len(mem) < MIN_PEERS + 1: continue
        sub = V[mem]
        s, n = sub.sum(axis=1, min_count=1), sub.notna().sum(axis=1)
        for m in mem:
            nn = n - sub[m].notna()
            out[m] = ((s - sub[m].fillna(0)) / nn).where(nn >= MIN_PEERS)
    return out


def cs_ranks(df):
    return df.rank(axis=1, pct=True)


def per_hour_ols(Y, Xs):
    """Y and each X: (hours x coins). Returns hours x (1+k) coefficients."""
    H = Y.shape[0]
    B = np.full((H, len(Xs) + 1), np.nan)
    y = Y.values
    xs = [x.values for x in Xs]
    for h in range(H):
        yy = y[h]
        X = np.column_stack([np.ones_like(yy)] + [x[h] for x in xs])
        ok = np.isfinite(yy) & np.isfinite(X).all(1)
        if ok.sum() < 40: continue
        B[h] = np.linalg.lstsq(X[ok], yy[ok], rcond=None)[0]
    return pd.DataFrame(B, index=Y.index)


def nw_t_daily(b):
    from stats_util import nw_mean
    dly = b.groupby(b.index.floor("D")).mean().dropna()
    m, t, n = nw_mean(dly.values, lags=5)
    return m, t, n


def main():
    d = load()
    prim = d["prim"]
    keep = set(d["P"].columns)
    C, Q = load_hourly(keep)
    r = np.log(C / C.shift(1))
    r = r.where(r.abs() < 0.5)
    age = C.notna().cumsum(); r = r.where(age > 720)
    m = r.mean(axis=1).where(r.notna().sum(axis=1) >= 30)
    x = r.sub(m, axis=0)
    cols = list(x.columns)
    groups = {}
    for s in cols:
        c = prim.get(s)
        if c and c != "stablecoin": groups.setdefault(c, []).append(s)
    print(f"hourly panel: {len(cols)} coins, {len(groups)} categories, {x.index.min()}..{x.index.max()}, median coins/hour {int(x.notna().sum(axis=1).median())}")
    lq = np.log(Q.where(Q > 0))
    volS = lq - lq.rolling(168, min_periods=100).median().shift(1)
    vol24 = x.rolling(24, min_periods=18).std()
    catX = loo_mean(x, groups, cols)
    catAbs = loo_mean(x.abs(), groups, cols)
    catVolS = loo_mean(volS, groups, cols)
    # outcomes
    f1 = x.shift(-1)
    f4 = x.shift(-2).rolling(3, min_periods=3).sum().shift(-2)          # hours +2..+4
    f24 = x.rolling(20, min_periods=20).sum().shift(-24)                # hours +5..+24
    has_cat = catX.notna()
    feats = {"ownX": x, "ownAbs": x.abs(), "ownVol24": vol24, "ownVolS": volS, "catX": catX, "catAbs": catAbs, "catVolS": catVolS}
    R = {k: cs_ranks(v.where(has_cat)) for k, v in feats.items()}
    print("\n## 8. Hourly: peers' move this hour -> the coin's next hours (excess of the market)")
    print("   size: slope on the within-hour rank of |move| (rank units, bottom to top of the feature); direction: bp")
    for label, Y, xs, scale, unit in (
            ("size, hour +1", cs_ranks(f1.abs().where(has_cat)), ["ownAbs", "ownVol24", "ownVolS", "catAbs", "catVolS"], 1, ""),
            ("size, hours +2..+4", cs_ranks(f4.abs().where(has_cat)), ["ownAbs", "ownVol24", "ownVolS", "catAbs", "catVolS"], 1, ""),
            ("size, hours +5..+24", cs_ranks(f24.abs().where(has_cat)), ["ownAbs", "ownVol24", "ownVolS", "catAbs", "catVolS"], 1, ""),
            ("direction, hour +1", f1.where(has_cat), ["ownX", "catX"], 1e4, "bp"),
            ("direction, hours +2..+4", f4.where(has_cat), ["ownX", "catX"], 1e4, "bp"),
            ("direction, hours +5..+24", f24.where(has_cat), ["ownX", "catX"], 1e4, "bp")):
        B = per_hour_ols(Y, [R[k] for k in xs])
        for p, lo, hi in (("2024-01..2025-04", T0, SPLIT), ("2025-05..2026-08", SPLIT, TEND)):
            Bp = B[(B.index >= lo) & (B.index < hi)]
            cells = []
            for j, k in enumerate(xs, start=1):
                mu, t, n = nw_t_daily(Bp[j])
                cells.append(f"{k} {mu * scale:+.3f}{unit} t {t:+.1f}")
            print(f"   {label:24s} {p}: " + " | ".join(cells) + f"  ({n} days)")
    # the tradable read of any direction effect: a long/short of coins whose peers moved, held one hour
    print("\n   direction effect, if any, against costs: Binance spot taker ~10bp per side, so a round trip costs ~20bp")


if __name__ == "__main__":
    main()
