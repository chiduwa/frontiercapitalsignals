"""Which context separates exhaustion prints that faded from ones that kept running.

Same standard as EXHAUSTION.md: excess vs the equal-weight market, day-clustered
t, and the date split 2025-05-29 (discovery / validation halves).
"""
import sys
import numpy as np, pandas as pd

E = pd.read_pickle("events.pkl")
E["day"] = pd.to_datetime(E.t, unit="ms").dt.floor("D")
SPLIT = pd.Timestamp("2025-05-29")
E["half"] = np.where(E.day < SPLIT, "A", "B")
E["logturn"] = np.log10(E.turn)
E["logturn_px"] = np.log10(E.turn_proxy)
E["logmcap"] = np.log10(E.mcap_proxy)

# a coin's own record: mean 24h excess of its EARLIER prints whose outcome was known by now
E = E.sort_values(["coin", "t"]).reset_index(drop=True)
rec, nrec = [], []
for c, g in E.groupby("coin", sort=False):
    for k, r in g.iterrows():
        past = g[(g.t + 25 * 3_600_000 <= r.t) & g.exc24.notna()]
        rec.append(past.exc24.mean() if len(past) >= 3 else np.nan); nrec.append(len(past))
E["coin_rec"] = rec; E["coin_nrec"] = nrec

def ct(x, d):
    s = pd.Series(x.values, index=d.values).groupby(level=0).mean()
    return s.mean(), (s.mean() / (s.std(ddof=1) / np.sqrt(len(s))) if len(s) > 2 else np.nan), len(s)

def row(g, label, col="exc24"):
    g = g[g[col].notna()]
    if len(g) < 30: return None
    m, t, nd = ct(g[col], g.day)
    a = g[g.half == "A"]; b = g[g.half == "B"]
    return dict(bucket=label, n=len(g), days=nd, mean=100 * m, t=t,
                A=100 * a[col].mean() if len(a) else np.nan, B=100 * b[col].mean() if len(b) else np.nan,
                fell=100 * (g.fwd24 < 0).mean(), rip20=100 * (g[col] > 0.20).mean(),
                exc72=100 * g.exc72.mean(), med=100 * g[col].median())

def table(feat, edges, labels=None, data=E):
    out = []
    for k in range(len(edges) - 1):
        lo, hi = edges[k], edges[k + 1]
        g = data[(data[feat] >= lo) & (data[feat] < hi)]
        r = row(g, labels[k] if labels else f"[{lo:g}, {hi:g})")
        if r: out.append(r)
    return pd.DataFrame(out)

def show(title, df):
    print(f"\n## {title}")
    print(df.to_string(index=False, float_format=lambda v: f"{v:.2f}"))

if __name__ == "__main__":
    inf = np.inf
    print(f"{len(E):,} prints, {E.exc24.notna().sum():,} scored, {E.coin.nunique()} coins, "
          f"{E.day.min().date()} to {E.day.max().date()}")
    show("All", pd.DataFrame([row(E, "all"), row(E[E.tier == "thin"], "thin"), row(E[E.tier == "mid"], "mid")]))
    show("run24Z (how far the last 24h ran, own-vol units)", table("run24Z", [-inf, 2.5, 3.5, 4.5, 6, 8, inf]))
    show("barZ", table("barZ", [-inf, 3, 4, 6, 8, inf]))
    show("volZ", table("volZ", [-inf, 3, 3.5, 4, 4.5, 5, inf]))
    show("streak: prints by this coin in the prior 72h", table("streak72", [0, 1, 2, 4, 8, inf], ["first", "1", "2-3", "4-7", "8+"]))
    show("vol24_x: last 24h volume / (24 x 30d median hour)", table("vol24_x", [0, 3, 6, 12, 25, 50, inf]))
    show("dd365: price vs 1y high", table("dd365", [-inf, -0.9, -0.75, -0.5, -0.25, inf]))
    show("brk90: price vs prior 90d high (>0 = new 90d high)", table("brk90", [-inf, -0.5, -0.25, 0, 0.25, inf]))
    show("ret30d", table("ret30d", [-inf, -0.2, 0, 0.25, 0.5, 1, inf]))
    show("taker-buy share of the print bar", table("taker", [0, 0.45, 0.55, 0.65, 1.01]))
    show("perp_x: 24h perp volume / spot volume", table("perp_x", [0, 1, 3, 10, 30, inf]))
    show("funding at print (8h rate)", table("funding", [-inf, -0.0005, -0.0001, 0.0001, 0.0005, inf]))
    show("market 72h before", table("mkt72_before", [-inf, -0.05, 0, 0.05, inf]))
    show("mcap proxy (current supply x price), log10 $", table("logmcap", [0, 7.5, 8, 8.5, 9, inf], ["<$32M", "$32-100M", "$100-316M", "$316M-1B", ">$1B"]))
    show("turnover proxy: 24h Binance spot vol / mcap proxy", table("turn_proxy", [0, 0.05, 0.15, 0.5, 1.5, inf]))
    show("turnover (real CoinGecko mcap, last 365d only)", table("turn", [0, 0.05, 0.15, 0.5, 1.5, inf]))
    show("coin's own record (mean 24h excess of >=3 earlier prints)", table("coin_rec", [-inf, -0.05, 0, 0.05, inf]))
    E.to_pickle("events_x.pkl")
