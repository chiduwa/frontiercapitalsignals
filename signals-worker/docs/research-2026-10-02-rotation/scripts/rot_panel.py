"""Daily OHLCV panel for the rotation study, built on the 2026-10-01 category
study's inputs (panel.py): Binance spot USDT pairs listed today (daily klines
from 2019), plus coins delisted 2024-26 from the hourly archive (2024-01 on).

Adds what the category study did not use: quote volume (USD), highs and lows,
point-in-time size tiers by trailing traded value, and a primary use per coin.
"""
import glob, os, pickle, sys
import numpy as np, pandas as pd
# The category study's panel module and its data (README: Data)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "research-2026-10-01-categories", "scripts"))
from panel import HERE, ARCH, EXCLUDE, tokenized_stocks, tags_by_symbol, denom, primary

# Intermediate files (gitignored): signals-worker/reports/rotation unless ROT_WORK says otherwise
WORK = os.environ.get("ROT_WORK", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "reports", "rotation"))
os.makedirs(WORK, exist_ok=True)
OUT = os.path.join(WORK, "rot_panel.pkl")
START = pd.Timestamp("2019-03-01")
END = pd.Timestamp("2026-10-01")
# size tiers among alts (BTC and ETH are their own legs), by 30-day median
# daily quote volume on Binance spot, ranked on each day from data to that day
TIERS = (("large", 1, 20), ("mid", 21, 60), ("small", 61, 150), ("micro", 151, 10**6))


def load_ohlcv():
    C, H, L, V = {}, {}, {}, {}
    for f in glob.glob(os.path.join(HERE, "daily", "*.npz")):
        s = os.path.basename(f)[:-4]
        z = np.load(f)
        idx = pd.to_datetime(z["t"], unit="ms")
        S = z["s"]
        C[s] = pd.Series(S[:, 3], idx); H[s] = pd.Series(S[:, 1], idx)
        L[s] = pd.Series(S[:, 2], idx); V[s] = pd.Series(S[:, 4], idx)
    for f in glob.glob(os.path.join(ARCH, "*.npz")):
        s = os.path.basename(f)[:-4]
        if s in C: continue
        z = np.load(f)
        if "empty" in z.files: continue
        h = pd.DataFrame(z["s"][:, :5].astype(float), index=pd.to_datetime(z["s_t"], unit="ms"), columns=list("ohlcv"))
        g = h.resample("1D")
        n = g["c"].count()
        d = pd.DataFrame({"c": g["c"].last(), "h": g["h"].max(), "l": g["l"].min(), "v": g["v"].sum()})[n >= 20]
        if len(d) < 30: continue
        C[s], H[s], L[s], V[s] = d["c"], d["h"], d["l"], d["v"]
    days = pd.date_range(START, END, freq="D")
    frame = lambda D: pd.DataFrame(D).reindex(days)
    return frame(C), frame(H), frame(L), frame(V)


def build():
    P, Hh, Ll, V = load_ohlcv()
    tags, _ = tags_by_symbol()
    sym_tags = {s: tags.get(denom(s), []) for s in P.columns}
    prim = {s: primary(t) for s, t in sym_tags.items()}
    drop = set(EXCLUDE) | tokenized_stocks() | {s for s, c in prim.items() if c == "stablecoin"}
    r = np.log(P / P.shift(1))
    pegged = {s for s in P.columns if r[s].abs().median() < 0.003}      # pegged, whatever it is called
    keep = [s for s in P.columns if s not in drop and s not in pegged]
    P, Hh, Ll, V = P[keep], Hh[keep], Ll[keep], V[keep]
    # log returns; drop relaunch/redenomination jumps and each listing's first 60 days
    R = np.log(P / P.shift(1))
    R = R.where(R.abs() < np.log(1.5) * 3)
    age = P.notna().cumsum()
    R = R.where(age > 60)
    M = R.mean(axis=1, skipna=True).where(R.notna().sum(axis=1) >= 30)
    DV = V.rolling(30, min_periods=20).median()                        # traded value, USD, to date
    alts = [s for s in keep if s not in ("BTC", "ETH")]
    rank = DV[alts].where(R[alts].notna() | R[alts].shift(1).notna()).rank(axis=1, ascending=False)
    tier = pd.DataFrame(index=P.index, columns=alts, dtype=object)
    for name, lo, hi in TIERS:
        tier = tier.mask((rank >= lo) & (rank <= hi), name)
    out = dict(P=P, H=Hh, L=Ll, V=V, R=R, M=M, DV=DV, tier=tier, prim={s: prim[s] for s in keep},
               tags={s: sym_tags[s] for s in keep})
    pickle.dump(out, open(OUT, "wb"))
    return out


def load():
    return pickle.load(open(OUT, "rb")) if os.path.exists(OUT) else build()


if __name__ == "__main__":
    d = build()
    P, tier = d["P"], d["tier"]
    print(P.shape, P.index.min().date(), P.index.max().date())
    for y in range(2019, 2027):
        day = pd.Timestamp(f"{y}-06-30") if y < 2026 else pd.Timestamp("2026-09-30")
        row = tier.loc[day].value_counts()
        print(y, {k: int(row.get(k, 0)) for k, *_ in TIERS}, "coins with a return", int(d["R"].loc[day].notna().sum()))
    from collections import Counter
    print(Counter(c for c in d["prim"].values() if c).most_common(30))
