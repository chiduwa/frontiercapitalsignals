"""Size-tier rotation: does money move BTC -> large -> micro -> mid (or any
order) in a way that is visible early enough to use?

Legs: BTC, ETH, and four alt tiers by trailing 30-day traded value on Binance
spot, membership fixed at the previous close (rot_panel.TIERS). Each leg's
daily return is the equal-weight mean of its members' log returns.

Three tests, each judged on two periods:
  1. price lead-lag: leg i over the last k days -> leg j over the next k
     days, controlling for leg j's own last k days (k = 1, 7, 28; absolute
     and relative to BTC)
  2. the specific story: BTC and large caps pump, then cool -> what do mid,
     small and micro do over the next 1-4 weeks?
  3. capital (traded value) rotation: a leg's share of all traded value
     rising -> that leg, or another, over the next 7 / 28 days
Periods: A 2021-01..2023-12 (only coins still listed today), B 2024-01..
2026-09 (delisted coins included: the one to weigh).
"""
import itertools, json, os, sys
import numpy as np, pandas as pd
from rot_panel import load, TIERS, WORK
from panel import MKTS
from stats_util import nw_ols, nw_mean, blocks

A0, B0, END = pd.Timestamp("2021-01-01"), pd.Timestamp("2024-01-01"), pd.Timestamp("2026-10-01")
LEGS = ["BTC", "ETH", "large", "mid", "small", "micro"]
MIN_MEMBERS = 15
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = {}


def legs(d):
    R, tier = d["R"], d["tier"].shift(1)                      # membership from the previous close
    L = {"BTC": R["BTC"], "ETH": R["ETH"]}
    N = {}
    for name, *_ in TIERS:
        m = (tier == name)
        Rm = R[m.columns].where(m)
        L[name] = Rm.mean(axis=1).where(Rm.notna().sum(axis=1) >= MIN_MEMBERS)
        N[name] = Rm.notna().sum(axis=1)
    return pd.DataFrame(L), pd.DataFrame(N)


def periods(s):
    return {"A": s[(s.index >= A0) & (s.index < B0)], "B": s[(s.index >= B0) & (s.index < END)]}


def section0(d):
    """Is traded value a fair stand-in for market cap? Today's ranks against
    CoinGecko's market caps (the category study's snapshot)."""
    mk = json.load(open(MKTS))
    mcap = {}
    for m in mk:
        s = m["symbol"].upper()
        if s not in mcap and m.get("market_cap"): mcap[s] = m["market_cap"]
    dv = d["DV"].loc["2026-09-30"].dropna()
    from panel import denom
    pairs = [(dv[s], mcap.get(denom(s))) for s in dv.index if mcap.get(denom(s))]
    a = pd.DataFrame(pairs, columns=["dv", "mcap"])
    rho = a.rank().corr().iloc[0, 1]
    top = a.sort_values("mcap", ascending=False)
    print(f"\n## 0. Traded value vs market cap (2026-09-30): Spearman {rho:.2f} over {len(a)} coins")
    tier = d["tier"].loc["2026-09-30"]
    t2 = {s: tier.get(s) for s in dv.index}
    rows = []
    for name, *_ in TIERS:
        caps = [mcap.get(denom(s)) for s, t in t2.items() if t == name and mcap.get(denom(s))]
        rows.append((name, len(caps), np.median(caps) / 1e6 if caps else np.nan, np.min(caps) / 1e6 if caps else np.nan))
    print("   tier   coins  median mcap $M  smallest $M")
    for r in rows: print(f"   {r[0]:6s} {r[1]:5d} {r[2]:14.0f} {r[3]:12.0f}")
    OUT["s0"] = {"spearman": rho, "coins": len(a)}


def section1(Lg, N):
    print("\n## 1. Describe the legs (daily log returns, B period)")
    B = Lg[(Lg.index >= B0)]
    desc = pd.DataFrame({"mean bp/day": B.mean() * 1e4, "vol %/day": B.std() * 100,
                         "beta to BTC": [B[c].cov(B["BTC"]) / B["BTC"].var() for c in B],
                         "corr to BTC": B.corr()["BTC"], "members (median)": [np.nan, np.nan] + [N[c][N.index >= B0].median() for c in N]})
    print(desc.round(3).to_string())


def lead_lag(Lg, rel):
    """Leg i's last k days -> leg j's next k days, with leg j's own last k days
    as a control. rel=True measures every leg relative to BTC."""
    tag = "relative to BTC" if rel else "absolute"
    X = Lg.sub(Lg["BTC"], axis=0) if rel else Lg
    legs_ = [l for l in LEGS if not (rel and l == "BTC")]
    pairs = [(i, j) for i, j in itertools.permutations(legs_, 2)]
    ks = (1, 7, 28)
    bar = 3.26 if not rel else 3.17                            # Bonferroni, two-sided 5%, over this table
    print(f"\n## 2. Price lead-lag between legs ({tag}); next-k on last-k, own last-k controlled; Newey-West t")
    print(f"   {len(pairs) * len(ks)} tests; Bonferroni bar |t| >= {bar}")
    rows = []
    for k in ks:
        Bk = {l: blocks(X[l], k, A0) for l in legs_}
        for i, j in pairs:
            res = {}
            for p, lo, hi in (("A", A0, B0), ("B", B0, END)):
                xi, yj = Bk[i], Bk[j]
                df = pd.DataFrame({"x": xi, "own": yj, "y": yj.shift(-1)})
                df = df[(df.index >= lo) & (df.index < hi)].dropna()
                b, t, n = nw_ols(df["y"], df[["x", "own"]].values)
                res[p] = (b[1], t[1], n)
            rows.append(dict(k=k, lead=i, follow=j, A_b=res["A"][0], A_t=res["A"][1], B_b=res["B"][0], B_t=res["B"][1], B_n=res["B"][2], A_n=res["A"][2]))
    T = pd.DataFrame(rows)
    T["both_nominal"] = (np.sign(T.A_t) == np.sign(T.B_t)) & (T.A_t.abs() >= 2) & (T.B_t.abs() >= 2)
    T["past_bar"] = (T.A_t.abs() >= bar) | (T.B_t.abs() >= bar)
    for k in ks:
        Tk = T[T.k == k]
        print(f"   k={k:2d}d: |t|>=2 in A {int((Tk.A_t.abs() >= 2).sum())}, in B {int((Tk.B_t.abs() >= 2).sum())} "
              f"(chance ~{0.05 * len(Tk):.1f} each); same sign and |t|>=2 in both: {int(Tk.both_nominal.sum())}; past the bar in either: {int(Tk.past_bar.sum())}")
    show = T[T.both_nominal | T.past_bar | (T.A_t.abs() >= 2.5) | (T.B_t.abs() >= 2.5)]
    if len(show): print(show[["k", "lead", "follow", "A_b", "A_t", "A_n", "B_b", "B_t", "B_n"]].round(3).to_string(index=False))
    # the user's sequence, printed whatever it shows
    seq = [("BTC", "large"), ("large", "micro"), ("micro", "mid"), ("large", "mid"), ("mid", "small"), ("small", "micro"), ("BTC", "micro"), ("ETH", "large")]
    print("   the asked-about order (BTC/large -> micro -> mid), every horizon:")
    for i, j in seq:
        r = T[(T.lead == i) & (T.follow == j)]
        if not len(r): continue
        cells = "  ".join(f"k={int(x.k)}: A t {x.A_t:+.2f} / B t {x.B_t:+.2f}" for x in r.itertuples())
        print(f"     {i:>5s} -> {j:<5s} {cells}")
    OUT[f"s2_{'rel' if rel else 'abs'}"] = T.to_dict("records")
    return T


def pump_cool(Lg):
    """BTC + large caps have a big week, then a down week. What do the other
    tiers do over the next four weeks, relative to BTC + large?"""
    print("\n## 3. The story itself: BTC and large caps pump, then cool. Then what?")
    W = {l: blocks(Lg[l], 7, A0) for l in LEGS}
    W = pd.DataFrame(W)
    big = (W["BTC"] + W["large"]) / 2
    mu = big.rolling(52, min_periods=26).mean().shift(1); sd = big.rolling(52, min_periods=26).std().shift(1)
    pump = big > mu + sd
    cool = big < 0
    rel = W[["ETH", "mid", "small", "micro"]].sub(big, axis=0)
    for variant, ev in (("pump week, then a down week", pump.shift(1) & cool), ("pump week (no cooling needed)", pump)):
        ev = ev.fillna(False)
        print(f"   event: {variant}; outcome = the leg's return minus BTC+large's, weeks +1..+4 after the event week (log %)")
        for p, lo, hi in (("A", A0, B0), ("B", B0, END)):
            idx = [i for i, t in enumerate(W.index) if ev.iloc[i] and lo <= t < hi]
            # de-overlap: an event within 4 weeks of the last kept one is dropped
            kept, last = [], -99
            for i in idx:
                if i - last >= 4: kept.append(i); last = i
            line = []
            for leg in ["ETH", "mid", "small", "micro"]:
                fw = pd.Series([rel[leg].iloc[i + 1: i + 5].sum() if i + 4 < len(W) and rel[leg].iloc[i + 1: i + 5].notna().all() else np.nan for i in range(len(W))], index=W.index)
                fwp = fw[(fw.index >= lo) & (fw.index < hi)]
                e = fw.iloc[kept].dropna()
                if len(e) < 3: line.append(f"{leg} n<3"); continue
                diff = e.mean() - fwp.mean()
                se = np.sqrt(e.var(ddof=1) / len(e) + fwp.var(ddof=1) / max(1, len(fwp) / 4))
                line.append(f"{leg} {e.mean() * 100:+.1f} vs {fwp.mean() * 100:+.1f} (t {diff / se:+.2f})")
            print(f"     {p}: {len(kept):2d} events | " + " | ".join(line))


def capital(d, Lg):
    """Traded-value share: a leg's slice of all traded value, last 7 days
    against the 28 before. Does money arriving in a leg come before that leg
    (or another) doing better?"""
    V7 = d["V"].rolling(7, min_periods=6).sum()
    tier = d["tier"]
    share = {"BTC": V7["BTC"], "ETH": V7["ETH"]}
    for name, *_ in TIERS:
        m = (tier == name)
        share[name] = V7[m.columns].where(m).sum(axis=1, min_count=MIN_MEMBERS)
    S = pd.DataFrame(share)
    S = S.div(S.sum(axis=1, min_count=6), axis=0)
    # 7-day share now vs its mean over the 28 days before that week
    dS7 = np.log(S / S.shift(7).rolling(28, min_periods=20).mean())
    dS28 = np.log(S.rolling(7).mean() / S.shift(28).rolling(63, min_periods=40).mean())
    X = Lg.sub(Lg["BTC"], axis=0); X["BTC"] = Lg["BTC"] - Lg[["large", "mid", "small", "micro"]].mean(axis=1)
    print("\n## 4. Capital rotation by traded value: share of all Binance spot traded value, rising vs its recent norm")
    print("   (B period, mean share of traded value: " + ", ".join(f"{c} {S[c][S.index >= B0].mean() * 100:.1f}%" for c in S) + ")")
    print("   outcome = leg relative to BTC (BTC: relative to the mean alt tier); own past return controlled; Newey-West t")
    rows = []
    for k, dS in ((7, dS7), (28, dS28)):
        anchors = X.index[(X.index >= A0)][::k]
        for i, j in itertools.product(LEGS, LEGS):
            fut = pd.Series({t: X[j].loc[t + pd.Timedelta(days=1): t + pd.Timedelta(days=k)].sum() if X[j].loc[t + pd.Timedelta(days=1): t + pd.Timedelta(days=k)].notna().sum() == k else np.nan for t in anchors})
            past = pd.Series({t: X[j].loc[t - pd.Timedelta(days=k - 1): t].sum() for t in anchors})
            pastI = pd.Series({t: X[i].loc[t - pd.Timedelta(days=k - 1): t].sum() for t in anchors})
            sig = dS[i].reindex(anchors)
            res = {}
            for p, lo, hi in (("A", A0, B0), ("B", B0, END)):
                df = pd.DataFrame({"y": fut, "x": sig, "own": past, "ownI": pastI})
                df = df[(df.index >= lo) & (df.index < hi)].dropna()
                ctrl = ["x", "own"] + (["ownI"] if i != j else [])
                b, t, n = nw_ols(df["y"], df[ctrl].values)
                res[p] = (b[1], t[1], n)
            rows.append(dict(k=k, share_of=i, outcome=j, A_b=res["A"][0], A_t=res["A"][1], A_n=res["A"][2], B_b=res["B"][0], B_t=res["B"][1], B_n=res["B"][2]))
    T = pd.DataFrame(rows)
    bar = 3.39   # Bonferroni over 72 tests
    for k in (7, 28):
        Tk = T[T.k == k]
        both = Tk[(np.sign(Tk.A_t) == np.sign(Tk.B_t)) & (Tk.A_t.abs() >= 2) & (Tk.B_t.abs() >= 2)]
        print(f"   k={k}d: |t|>=2 in A {int((Tk.A_t.abs() >= 2).sum())}, in B {int((Tk.B_t.abs() >= 2).sum())} of {len(Tk)} (chance ~{0.05 * len(Tk):.1f}); "
              f"same sign |t|>=2 both: {len(both)}; past the bar |t|>={bar} in either: {int(((Tk.A_t.abs() >= bar) | (Tk.B_t.abs() >= bar)).sum())}")
        own = Tk[Tk.share_of == Tk.outcome]
        print("     own share -> own next: " + "; ".join(f"{r.share_of} A {r.A_t:+.2f} B {r.B_t:+.2f}" for r in own.itertuples()))
        show = Tk[(Tk.A_t.abs() >= 2.5) | (Tk.B_t.abs() >= 2.5)]
        if len(show): print(show[["share_of", "outcome", "A_b", "A_t", "B_b", "B_t", "B_n"]].round(3).to_string(index=False))
    OUT["s4"] = T.to_dict("records")


def main():
    d = load()
    Lg, N = legs(d)
    section0(d)
    section1(Lg, N)
    lead_lag(Lg, rel=False)
    lead_lag(Lg, rel=True)
    pump_cool(Lg)
    capital(d, Lg)
    json.dump(OUT, open(os.path.join(WORK, "tiers_out.json"), "w"), default=float)


if __name__ == "__main__":
    main()
