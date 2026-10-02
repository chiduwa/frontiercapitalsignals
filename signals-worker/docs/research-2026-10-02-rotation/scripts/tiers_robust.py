"""Robustness for the only two tier results that kept their sign in both
periods at 28 days (tiers.py sections 2 and 4). With 22-40 non-overlapping
periods a t of 2 can come from where the 28-day blocks happen to start, so:
  * the same test from each of four start offsets (0, 7, 14, 21 days)
  * every day as an anchor, Newey-West with 2k lags (overlap-aware)
  * with and without the 2022 crash and the 2024-25 BTC-led run
"""
import numpy as np, pandas as pd
from rot_panel import load, TIERS
from stats_util import nw_ols
from tiers import legs, A0, B0, END, MIN_MEMBERS

d = load()
Lg, N = legs(d)
REL = Lg.sub(Lg["BTC"], axis=0)
ALT = Lg[["large", "mid", "small", "micro"]].mean(axis=1) - Lg["BTC"]

V7 = d["V"].rolling(7, min_periods=6).sum()
share = {"BTC": V7["BTC"], "ETH": V7["ETH"]}
for name, *_ in TIERS:
    m = d["tier"] == name
    share[name] = V7[m.columns].where(m).sum(axis=1, min_count=MIN_MEMBERS)
S = pd.DataFrame(share); S = S.div(S.sum(axis=1, min_count=6), axis=0)
dS28 = np.log(S.rolling(7).mean() / S.shift(28).rolling(63, min_periods=40).mean())


def fwd(x, k): return x.rolling(k, min_periods=k).sum().shift(-k)
def back(x, k): return x.rolling(k, min_periods=k).sum()


def run(name, sig, y, own_series, k=28):
    print(f"\n### {name}")
    Y, X, O = fwd(y, k), sig, back(own_series, k)
    for p, lo, hi in (("A", A0, B0), ("B", B0, END)):
        cells = []
        for off in (0, 7, 14, 21):
            idx = Y.index[(Y.index >= lo + pd.Timedelta(days=off)) & (Y.index < hi)][::k]
            df = pd.DataFrame({"y": Y, "x": X, "o": O}).loc[idx].dropna()
            b, t, n = nw_ols(df.y, df[["x", "o"]].values)
            cells.append(f"off {off:2d}: t {t[1]:+.2f} (n {n})")
        df = pd.DataFrame({"y": Y, "x": X, "o": O})
        df = df[(df.index >= lo) & (df.index < hi)].dropna()
        b, t, n = nw_ols(df.y, df[["x", "o"]].values, lags=2 * k)
        print(f"  {p}: " + " | ".join(cells) + f" || every day, NW {2 * k} lags: slope {b[1]:+.3f} t {t[1]:+.2f} (n {n} days)")
    # leave out the stretches that dominate each period
    for drop, lo, hi in (("without 2022-05..2022-12", "2022-05-01", "2023-01-01"), ("without 2024-10..2025-03", "2024-10-01", "2025-04-01")):
        df = pd.DataFrame({"y": Y, "x": X, "o": O}).dropna()
        df = df[(df.index >= A0) & ~((df.index >= lo) & (df.index < hi))]
        b, t, n = nw_ols(df.y, df[["x", "o"]].values, lags=2 * k)
        print(f"  whole window {drop}: slope {b[1]:+.3f} t {t[1]:+.2f} (n {n} days)")


run("large caps beat BTC over 4 weeks -> micro beats BTC over the next 4 (price, relative)", back(REL["large"], 28), REL["micro"], REL["micro"])
run("large-cap share of traded value up over 4 weeks -> alts vs BTC next 4 weeks", dS28["large"], ALT, ALT)
run("large-cap share up -> large caps vs BTC next 4 weeks", dS28["large"], REL["large"], REL["large"])
run("all-alt share up (1 - BTC - ETH) -> alts vs BTC next 4 weeks", np.log((1 - S["BTC"] - S["ETH"]).rolling(7).mean() / (1 - S["BTC"] - S["ETH"]).shift(28).rolling(63, min_periods=40).mean()), ALT, ALT)
run("micro share up -> micro vs BTC next 4 weeks", dS28["micro"], REL["micro"], REL["micro"])
