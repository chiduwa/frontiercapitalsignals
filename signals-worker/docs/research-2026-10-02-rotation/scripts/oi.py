"""Open-interest rotation: does new perpetual money (contracts opened, not the
dollar value of old contracts re-priced) moving into a tier or a category
come before that tier or category doing better?

Input: production D1 derivatives_daily (Binance USDT perps, 2023-01 on),
read-only. Flow = change in log CONTRACTS (oi_qty_close), so a price move
cannot masquerade as new money (OI_MEASUREMENT_EVIDENCE: notional OI tracks
price at r=0.998). A group's flow weights members by their dollar OI at the
start of the window.

Periods: A 2023-01..2024-11-14, B 2024-11-15..2026-09 (halves of the OI
history).
"""
import itertools, json, os
import numpy as np, pandas as pd
from rot_panel import load, TIERS, WORK
from stats_util import nw_ols, fama_macbeth, rank_cs, nw_mean

A0, B0, END = pd.Timestamp("2023-01-15"), pd.Timestamp("2024-11-15"), pd.Timestamp("2026-10-01")
MIN_MEMBERS = 8


def load_oi(index, cols):
    rows = json.load(open(os.path.join(WORK, "derivatives_daily.json")))      # fetch_oi.py
    df = pd.DataFrame(rows)
    df = df[df.samples >= 200]
    df["date"] = pd.to_datetime(df.date)
    Q = df.pivot(index="date", columns="symbol", values="oi_qty_close").reindex(index)
    U = df.pivot(index="date", columns="symbol", values="oi_usd_close").reindex(index)
    keep = [c for c in Q.columns if c in cols]
    Q, U = Q[keep], U[keep]
    dq = np.log(Q / Q.shift(1))
    dq = dq.where(dq.abs() < 0.7)               # contract re-scalings and relistings are not flows
    return dq, U


def group_flow(dq, U, members_mask, k):
    """OI-dollar-weighted mean of members' k-day change in log contracts."""
    f = dq.rolling(k, min_periods=k).sum()
    w = U.shift(k).where(members_mask & f.notna())
    num = (f * w).sum(axis=1, min_count=MIN_MEMBERS)
    return num / w.sum(axis=1, min_count=MIN_MEMBERS)


def periods():
    return (("A", A0, B0), ("B", B0, END))


def main():
    d = load()
    R, tier, prim = d["R"], d["tier"], d["prim"]
    dq, U = load_oi(R.index, set(R.columns))
    print(f"OI panel: {dq.shape[1]} coins with Binance perps; {dq.index[dq.notna().sum(axis=1) > 0].min().date()}..{dq.index.max().date()}")
    M = d["M"]
    X = R.sub(M, axis=0)                                           # excess over the equal-weight market

    # ---------- 5a. tiers ----------
    print("\n## 5a. Tier OI flow vs BTC's -> tier vs BTC over the next k days (own past return controlled)")
    tmask = {name: (tier == name).reindex(columns=dq.columns, fill_value=False) for name, *_ in TIERS}
    btcm = pd.DataFrame(False, index=dq.index, columns=dq.columns); btcm["BTC"] = True
    rows = []
    for k in (1, 7, 28):
        fb = group_flow(dq, U, btcm, k) if "BTC" in dq else None
        fb = dq["BTC"].rolling(k, min_periods=k).sum()
        for name, *_ in TIERS:
            m = tmask[name].shift(1).fillna(False).astype(bool)
            Rm = R[m.columns].where(m)
            leg = Rm.mean(axis=1).where(Rm.notna().sum(axis=1) >= MIN_MEMBERS) - R["BTC"]
            fl = group_flow(dq, U, m, k) - fb
            y = leg.rolling(k, min_periods=k).sum().shift(-k)
            own = leg.rolling(k, min_periods=k).sum()
            for p, lo, hi in periods():
                idx = y.index[(y.index >= lo) & (y.index < hi)][::k]
                df = pd.DataFrame({"y": y, "x": fl, "o": own}).loc[idx].dropna()
                b, t, n = nw_ols(df.y, df[["x", "o"]].values)
                rows.append(dict(k=k, tier=name, period=p, slope=b[1], t=t[1], n=n))
    T = pd.DataFrame(rows).pivot_table(index=["k", "tier"], columns="period", values=["t", "n"]).round(2)
    print(T.to_string())

    # ---------- 5b. alts vs BTC on the alt-vs-BTC OI flow ----------
    print("\n## 5b. All-alt OI flow minus BTC's -> equal-weight alts vs BTC next k days")
    altm = pd.DataFrame(True, index=dq.index, columns=dq.columns).drop(columns=[c for c in ("BTC", "ETH") if c in dq], errors="ignore")
    altm = altm.reindex(columns=dq.columns, fill_value=False)
    Ralt = R.drop(columns=["BTC", "ETH"]).mean(axis=1) - R["BTC"]
    for k in (1, 7, 28):
        fl = group_flow(dq, U, altm, k) - dq["BTC"].rolling(k, min_periods=k).sum()
        y = Ralt.rolling(k, min_periods=k).sum().shift(-k); own = Ralt.rolling(k, min_periods=k).sum()
        cells = []
        for p, lo, hi in periods():
            idx = y.index[(y.index >= lo) & (y.index < hi)][::k]
            df = pd.DataFrame({"y": y, "x": fl, "o": own}).loc[idx].dropna()
            b, t, n = nw_ols(df.y, df[["x", "o"]].values)
            cells.append(f"{p}: slope {b[1]:+.3f} t {t[1]:+.2f} n {n}")
        print(f"   k={k:2d}: " + " | ".join(cells))

    # ---------- 5c. categories (Fama-MacBeth across categories) ----------
    cats = sorted({c for c in prim.values() if c and c not in ("stablecoin",)})
    members = {c: [s for s in R.columns if prim.get(s) == c] for c in cats}
    cats = [c for c in cats if sum(1 for s in members[c] if s in dq.columns) >= MIN_MEMBERS]
    print(f"\n## 5c. Category OI flow (relative to all coins' flow) -> category excess next k days; Fama-MacBeth over {len(cats)} categories with >= {MIN_MEMBERS} perps")
    allm = pd.DataFrame(True, index=dq.index, columns=dq.columns)
    for k in (1, 7, 28):
        fall = group_flow(dq, U, allm, k)
        recs = []
        for c in cats:
            mm = pd.DataFrame(False, index=dq.index, columns=dq.columns)
            for s in members[c]:
                if s in mm: mm[s] = True
            fl = group_flow(dq, U, mm, k) - fall
            Xc = X[members[c]]
            ci = Xc.mean(axis=1).where(Xc.notna().sum(axis=1) >= MIN_MEMBERS)
            recs.append(pd.DataFrame({"date": ci.index, "cat": c, "flow": fl.values, "past": ci.rolling(k, min_periods=k).sum().values,
                                      "y": ci.rolling(k, min_periods=k).sum().shift(-k).values}))
        Pn = pd.concat(recs).dropna()
        cells = []
        for p, lo, hi in periods():
            anchors = set(pd.date_range(lo, hi, freq=f"{k}D"))
            sub = Pn[Pn.date.isin(anchors)]
            fm = fama_macbeth(sub, "y", ["flow", "past"], min_n=6)
            cells.append(f"{p}: flow t {fm['flow'][1]:+.2f} past t {fm['past'][1]:+.2f} ({fm['flow'][2]} periods)")
        print(f"   k={k:2d}: " + " | ".join(cells))

    # ---------- 5d. coin level: does the category's OI-vs-price divergence add to the coin's own? ----------
    print("\n## 5d. Coin level, next day's excess return: own OI-vs-price divergence (the XS lane's selected feature) and its category's (leave-one-out)")
    px7 = np.log(d["P"] / d["P"].shift(7)).reindex(columns=dq.columns)
    oi7 = dq.rolling(7, min_periods=6).sum()
    div = (oi7 - px7)                                              # oi_px_divergence on contracts
    oi1 = dq
    rows = []
    for c in cats:
        mem = [s for s in members[c] if s in dq.columns]
        if len(mem) < MIN_MEMBERS: continue
        Dc = div[mem]; O1 = oi1[mem]
        sumD, cntD = Dc.sum(axis=1, min_count=1), Dc.notna().sum(axis=1)
        sumO, cntO = O1.sum(axis=1, min_count=1), O1.notna().sum(axis=1)
        sumR, cntR = X[mem].sum(axis=1, min_count=1), X[mem].notna().sum(axis=1)
        for s in mem:
            looD = (sumD - Dc[s].fillna(0)) / (cntD - Dc[s].notna()).where(lambda v: v >= 4)
            looO = (sumO - O1[s].fillna(0)) / (cntO - O1[s].notna()).where(lambda v: v >= 4)
            looR = (sumR - X[s].fillna(0)) / (cntR - X[s].notna()).where(lambda v: v >= 4)
            rows.append(pd.DataFrame({"date": R.index, "sym": s, "y": X[s].shift(-1).values, "ownDiv": Dc[s].values, "catDiv": looD.values,
                                      "ownOi1": O1[s].values, "catOi1": looO.values, "ownR1": X[s].values, "catR1": looR.values}))
    Pn = pd.concat(rows).replace([np.inf, -np.inf], np.nan).dropna()
    Pn = Pn[(Pn.date >= A0) & (Pn.date < END)]
    feats = ["ownDiv", "catDiv", "ownOi1", "catOi1", "ownR1", "catR1"]
    Pr = rank_cs(Pn, feats)
    for p, lo, hi in periods():
        sub = Pr[(Pr.date >= lo) & (Pr.date < hi)]
        fm = fama_macbeth(sub, "y", feats, min_n=30)
        print(f"   {p}: " + " | ".join(f"{f} {fm[f][0] * 1e4:+.1f}bp t {fm[f][1]:+.2f}" for f in feats) + f"  ({fm['ownDiv'][2]} days, ~{len(sub) / max(1, fm['ownDiv'][2]):.0f} coins/day)")
    print("   (slope = next-day excess return, bp, from the bottom to the top of each feature's daily rank)")


if __name__ == "__main__":
    main()
