"""Do utility categories move together, lead each other, or rotate predictably?

Discipline (as every FCS study): returns in excess of the equal-weight market;
anything chosen (a leader, a pair, a lag) is chosen on half A and judged on
half B; multi-day horizons use non-overlapping periods; Newey-West t for
time series.
"""
import itertools, sys
import numpy as np, pandas as pd
from panel import load_prices, tags_by_symbol, denom, primary, excess_returns, LABELS

SPLIT = pd.Timestamp("2023-01-01")
START = pd.Timestamp("2019-07-01")
MIN_MEMBERS = 5

def nw_t(y, x=None, lags=None):
    """OLS slope (or mean if x is None) with a Newey-West t."""
    y = np.asarray(y, float)
    X = np.ones((len(y), 1)) if x is None else np.c_[np.ones(len(y)), np.asarray(x, float)]
    ok = np.isfinite(y) & np.isfinite(X).all(1); y, X = y[ok], X[ok]
    n = len(y)
    if n < 20: return np.nan, np.nan, n
    b = np.linalg.lstsq(X, y, rcond=None)[0]; e = y - X @ b
    L = lags if lags is not None else int(4 * (n / 100) ** (2 / 9))
    XtX = np.linalg.inv(X.T @ X); S = (X * e[:, None]).T @ (X * e[:, None])
    for l in range(1, L + 1):
        w = 1 - l / (L + 1); G = (X[l:] * e[l:, None]).T @ (X[:-l] * e[:-l, None]); S += w * (G + G.T)
    V = XtX @ S @ XtX; k = X.shape[1] - 1
    return b[k], b[k] / np.sqrt(V[k, k]), n

def halves(s):
    return s[(s.index >= START) & (s.index < SPLIT)], s[s.index >= SPLIT]

def main():
    P = load_prices()
    P = P[P.index >= START - pd.Timedelta(days=120)]
    tags, _ = tags_by_symbol()
    R, M = excess_returns(P)
    X = R.sub(M, axis=0)                               # excess over the market
    sym_tags = {s: tags.get(denom(s), []) for s in P.columns}
    prim = {s: primary(t) for s, t in sym_tags.items()}
    cats = sorted({c for c in prim.values() if c}, key=lambda c: -sum(v == c for v in prim.values()))
    members = {c: [s for s in P.columns if prim[s] == c] for c in cats}
    cats = [c for c in cats if len(members[c]) >= MIN_MEMBERS and c not in ("stablecoin",)]
    print(f"{P.shape[1]} coins, {P.index.min().date()}..{P.index.max().date()}; tagged {sum(1 for s in P.columns if sym_tags[s])}")
    print("categories (primary use, members):", ", ".join(f"{c} {len(members[c])}" for c in cats))

    # category excess index: equal-weight of members' excess returns, >= MIN_MEMBERS that day
    CI = pd.DataFrame({c: X[members[c]].mean(axis=1).where(X[members[c]].notna().sum(axis=1) >= MIN_MEMBERS) for c in cats})
    CI = CI[CI.index >= START]

    # ---- 1. do members move with their own category? ----------------------------
    print("\n## 1. Co-movement: correlation of a coin's daily excess return with its own category (leave-one-out) vs other categories")
    rows = []
    for c in cats:
        for half, lo, hi in (("A", START, SPLIT), ("B", SPLIT, P.index.max() + pd.Timedelta(days=1))):
            own, other = [], []
            Xh = X[(X.index >= lo) & (X.index < hi)]
            for s in members[c]:
                x = Xh[s]
                if x.notna().sum() < 120: continue
                peers = [m for m in members[c] if m != s]
                loo = Xh[peers].mean(axis=1)
                own.append(x.corr(loo))
                oth = [x.corr(Xh[members[d]].mean(axis=1)) for d in cats if d != c]
                other.append(np.nanmean(oth))
            if own: rows.append(dict(category=c, half=half, coins=len(own), own=np.nanmedian(own), other=np.nanmedian(other)))
    T = pd.DataFrame(rows).pivot(index="category", columns="half", values=["own", "other", "coins"])
    T["lift_A"] = T[("own", "A")] - T[("other", "A")]; T["lift_B"] = T[("own", "B")] - T[("other", "B")]
    print(T.round(3).sort_values("lift_B", ascending=False).to_string())

    # ---- 2. does a category's leader lead its followers? ----------------------------
    print("\n## 2. Within-category leaders: leader's excess return on day t vs followers' excess on day t+1")
    print("   leader chosen on half A (best of the 5 largest members by trading history), judged on half B")
    rows = []
    for c in cats:
        cand = sorted(members[c], key=lambda s: -X[s][(X.index >= START) & (X.index < SPLIT)].notna().sum())[:5]
        best = None
        for L in cand:
            fol = [m for m in members[c] if m != L]
            y = X[fol].mean(axis=1).shift(-1); x = X[L]
            a_y, b_y = halves(y); a_x, b_x = halves(x)
            ba, ta, na = nw_t(a_y, a_x)
            if np.isfinite(ta) and (best is None or ta > best[2]): best = (L, ba, ta, na, b_y, b_x)
        if best is None: continue
        L, ba, ta, na, b_y, b_x = best
        bb, tb, nb = nw_t(b_y, b_x)
        # weekly version, non-overlapping
        rows.append(dict(category=c, leader=L, A_slope=ba, A_t=ta, B_slope=bb, B_t=tb, B_days=nb))
    print(pd.DataFrame(rows).round(3).to_string(index=False))

    # the obvious leader, chosen by size not by data: nothing fitted, so both halves are out of sample
    import json as _j
    mcap = {}
    for m in _j.load(open("../cg/markets.json")):
        mcap.setdefault(m["symbol"].upper(), m.get("market_cap") or 0)
    print("\n## 2a. Largest coin by market cap as the leader (nothing chosen from returns): day t vs followers day t+1, and week w vs week w+1")
    rows = []
    for c in cats:
        L = max(members[c], key=lambda s_: mcap.get(denom(s_), 0))
        fol = [m_ for m_ in members[c] if m_ != L]
        out = dict(category=c, leader=L)
        for nm, fr in (("day", None), ("week", "W-SUN")):
            x = X[L]; y = X[fol].mean(axis=1)
            if fr: x = x.resample(fr).sum(min_count=5); y = y.resample(fr).sum(min_count=5)
            ya, yb = halves(y.shift(-1)); xa, xb = halves(x)
            _, ta, _ = nw_t(ya, xa); _, tb, _ = nw_t(yb, xb)
            out[f"{nm}_A_t"] = ta; out[f"{nm}_B_t"] = tb
        rows.append(out)
    print(pd.DataFrame(rows).round(2).to_string(index=False))

    # BTC and ETH as leaders of every category, next day
    print("\n## 2b. BTC / ETH today vs each category's excess tomorrow (BTC and ETH are fixed, nothing chosen)")
    rows = []
    for L in ("BTC", "ETH"):
        x = R[L] - M
        for c in cats:
            ya, yb = halves(CI[c].shift(-1)); xa, xb = halves(x)
            ba, ta, _ = nw_t(ya, xa); bb, tb, nb = nw_t(yb, xb)
            rows.append(dict(leader=L, category=c, A_slope=ba, A_t=ta, B_slope=bb, B_t=tb))
    D = pd.DataFrame(rows); print(D.round(3).to_string(index=False))

    # ---- 2c. does a coin that lagged its own category catch up? ---------------------
    print("\n## 2c. Catch-up: a coin's excess over its own category (leave-one-out) in the past k days vs the next k days")
    print("   pooled over coins, non-overlapping periods, t clustered by period; negative slope = laggards catch up")
    for k in (7, 28):
        recs = []
        for c in cats:
            mem = members[c]
            tot = X[mem].sum(axis=1, min_count=1); cnt = X[mem].notna().sum(axis=1)
            for sname in mem:
                peers = (tot - X[sname].fillna(0)) / (cnt - X[sname].notna().astype(int))
                rel = (X[sname] - peers).where(cnt - X[sname].notna().astype(int) >= MIN_MEMBERS - 1)
                past = rel.rolling(k, min_periods=int(k * .8)).sum()
                nxt = rel[::-1].rolling(k, min_periods=int(k * .8)).sum()[::-1].shift(-1)
                d = pd.DataFrame({"x": past, "y": nxt}).iloc[::k].dropna()
                d = d[d.index >= START]; d["sym"] = sname
                recs.append(d)
        D = pd.concat(recs)
        for h, g in (("A", D[D.index < SPLIT]), ("B", D[D.index >= SPLIT])):
            # Fama-MacBeth: one cross-sectional slope per period, then t over periods
            sl = g.groupby(level=0).apply(lambda q: np.polyfit(q.x, q.y, 1)[0] if len(q) >= 10 and q.x.std() > 0 else np.nan).dropna()
            print(f"   k={k:2d}d half {h}: mean slope {sl.mean():+.3f}, t {sl.mean() / (sl.std() / np.sqrt(len(sl))):+.2f}, periods {len(sl)}, coin-periods {len(g)}")

    # ---- 2d. horse race: is it the CATEGORY, or plain reversal against the market? ----
    print("\n## 2d. Horse race (28d): next-28d excess over the market on past excess vs own category AND past excess vs the market")
    k = 28; recs = []
    for c in cats:
        mem = members[c]
        tot = X[mem].sum(axis=1, min_count=1); cnt = X[mem].notna().sum(axis=1)
        for sname in mem:
            own_n = X[sname].notna().astype(int)
            peers = (tot - X[sname].fillna(0)) / (cnt - own_n)
            ok = (cnt - own_n) >= MIN_MEMBERS - 1
            vs_cat = (X[sname] - peers).where(ok).rolling(k, min_periods=22).sum()
            vs_mkt = X[sname].where(ok).rolling(k, min_periods=22).sum()
            nxt = X[sname][::-1].rolling(k, min_periods=22).sum()[::-1].shift(-1)
            d = pd.DataFrame({"cat": vs_cat, "mkt": vs_mkt, "y": nxt}).iloc[::k].dropna()
            recs.append(d[d.index >= START])
    D = pd.concat(recs)
    for h, g in (("A", D[D.index < SPLIT]), ("B", D[D.index >= SPLIT])):
        def fm(cols):
            b = g.groupby(level=0).apply(lambda q: pd.Series(np.linalg.lstsq(np.c_[np.ones(len(q)), q[cols].values], q.y.values, rcond=None)[0][1:], index=cols) if len(q) >= 15 else pd.Series(np.nan, index=cols)).dropna()
            return " ".join(f"{c} {b[c].mean():+.3f} (t {b[c].mean() / (b[c].std() / np.sqrt(len(b))):+.2f})" for c in cols) + f", periods {len(b)}"
        print(f"   half {h}: market only: {fm(['mkt'])} | category only: {fm(['cat'])} | both: {fm(['cat', 'mkt'])}")

    # ---- 2e. how big is it: laggards vs leaders within each category, after costs ----
    print("\n## 2e. Within each category: the bottom third by past-28d excess over the category vs the top third, next 28d (0.2% round-trip cost per leg pair)")
    D["cat_name"] = None
    recs = []
    for c in cats:
        mem = members[c]
        tot = X[mem].sum(axis=1, min_count=1); cnt = X[mem].notna().sum(axis=1)
        for sname in mem:
            own_n = X[sname].notna().astype(int)
            peers = (tot - X[sname].fillna(0)) / (cnt - own_n)
            ok = (cnt - own_n) >= MIN_MEMBERS - 1
            past = (X[sname] - peers).where(ok).rolling(28, min_periods=22).sum()
            nxt = (np.exp(R[sname][::-1].rolling(28, min_periods=22).sum()[::-1].shift(-1)) - 1)
            d = pd.DataFrame({"x": past, "y": nxt}).iloc[::28].dropna(); d = d[d.index >= START]; d["cat"] = c
            recs.append(d)
    E = pd.concat(recs)
    def spread(g):
        out = []
        for (t, c), q in g.groupby([g.index, "cat"]):
            if len(q) < 6: continue
            n = len(q) // 3; o = q.sort_values("x")
            out.append((t, c, o.y.iloc[:n].mean() - o.y.iloc[-n:].mean() - 0.002))
        return pd.DataFrame(out, columns=["t", "cat", "s"])
    S = spread(E)
    for h, g in (("A", S[S.t < SPLIT]), ("B", S[S.t >= SPLIT])):
        per = g.groupby("t").s.mean()
        print(f"   half {h}: laggards minus leaders {100 * per.mean():+.2f}% per 28d, t {per.mean() / (per.std() / np.sqrt(len(per))):+.2f}, periods {len(per)}, positive {100 * (per > 0).mean():.0f}%")
    print("   by category (half B):")
    gb = S[S.t >= SPLIT].groupby("cat").s
    for c, v in gb:
        if len(v) >= 8: print(f"     {c:16s} {100 * v.mean():+6.2f}% per 28d  t {v.mean() / (v.std() / np.sqrt(len(v))):+.2f}  n {len(v)}")

    # ---- 3. does one category lead another? ----------------------------------------
    for freq, label, H in (("D", "daily", 1), ("W-SUN", "weekly", 1), ("4W-SUN", "4-weekly", 1)):
        C = CI.resample(freq).sum(min_count=1) if freq != "D" else CI
        pairs = []
        for a, b in itertools.permutations(cats, 2):
            ya, yb = halves(C[b].shift(-H)); xa, xb = halves(C[a])
            sa, ta, _ = nw_t(ya, xa)
            pairs.append((a, b, sa, ta))
        # pick on half A: |t| beyond the Bonferroni bar for this many pairs
        k = len(pairs); bar = abs(np.round(__import__("statistics").NormalDist().inv_cdf(1 - 0.05 / (2 * k)), 2))
        picked = [(a, b, sa, ta) for a, b, sa, ta in pairs if np.isfinite(ta) and abs(ta) >= bar]
        print(f"\n## 3. {label}: category A this period vs category B next period. {k} ordered pairs; half-A Bonferroni bar |t| >= {bar}")
        print(f"   pairs past the bar in half A: {len(picked)}; also nominal |t|>=2 in A: {sum(1 for p in pairs if np.isfinite(p[3]) and abs(p[3]) >= 2)} (expected by chance ~{0.0455*k:.0f})")
        out = []
        for a, b, sa, ta in picked:
            ya, yb = halves(C[b].shift(-H)); xa, xb = halves(C[a])
            sb, tb, nb = nw_t(yb, xb)
            out.append(dict(leader=a, follower=b, A_slope=sa, A_t=ta, B_slope=sb, B_t=tb, held=bool(np.sign(sa) == np.sign(sb) and abs(tb) >= 2)))
        if out: print(pd.DataFrame(out).round(3).to_string(index=False))

    # ---- 4. own momentum or reversal at the category level ------------------------
    print("\n## 4. A category's own past excess vs its next-period excess (pooled across categories, non-overlapping periods)")
    for look, fwd in ((7, 7), (28, 28), (28, 7), (90, 28)):
        rows_a, rows_b = [], []
        for c in cats:
            past = CI[c].rolling(look, min_periods=int(look * .8)).sum()
            nxt = CI[c][::-1].rolling(fwd, min_periods=int(fwd * .8)).sum()[::-1].shift(-1)
            s = pd.DataFrame({"x": past, "y": nxt}).iloc[::fwd].dropna()
            a, b = halves(s.x), halves(s.y)
            rows_a.append(pd.DataFrame({"x": a[0], "y": b[0]})); rows_b.append(pd.DataFrame({"x": a[1], "y": b[1]}))
        A_, B_ = pd.concat(rows_a), pd.concat(rows_b)
        sa, ta, na = nw_t(A_.y, A_.x, lags=0); sb, tb, nb = nw_t(B_.y, B_.x, lags=0)
        print(f"   past {look:3d}d -> next {fwd:2d}d: slope A {sa:+.3f} (t {ta:+.2f}, n {na}) | B {sb:+.3f} (t {tb:+.2f}, n {nb})")

    # ---- 4b. category momentum across categories: top third vs bottom third ----------
    print("\n## 4b. Rank categories by past excess; next-period spread of the top third over the bottom third (non-overlapping)")
    for look, fwd in ((7, 7), (28, 28), (90, 28)):
        past = CI.rolling(look, min_periods=int(look * .8)).sum()
        nxt = CI[::-1].rolling(fwd, min_periods=int(fwd * .8)).sum()[::-1].shift(-1)
        spreads = []
        for t in past.index[::fwd]:
            p_, n_ = past.loc[t].dropna(), nxt.loc[t].reindex(past.loc[t].dropna().index).dropna()
            p_ = p_.reindex(n_.index)
            if len(p_) < 6: continue
            q = len(p_) // 3; o = p_.sort_values()
            spreads.append((t, n_[o.index[-q:]].mean() - n_[o.index[:q]].mean()))
        S = pd.Series(dict(spreads))
        for h, g in (("A", S[S.index < SPLIT]), ("B", S[S.index >= SPLIT])):
            print(f"   past {look:2d}d -> next {fwd:2d}d half {h}: winners minus losers {100 * g.mean():+.2f}% per period, t {g.mean() / (g.std() / np.sqrt(len(g))):+.2f}, n {len(g)}")

    # ---- 5. the alt-season sequence ---------------------------------------------------
    print("\n## 5. Rotation sequence: BTC -> ETH -> large caps -> small caps / memes (relative 4-week returns, non-overlapping)")
    caps = P.iloc[-1]  # placeholder for ordering by trading history length below
    hist = R.notna().sum()
    alts = [s for s in P.columns if s not in ("BTC", "ETH")]
    # size proxy that is known at the time: trailing 30d median daily dollar volume would need volume; use price
    # history of the 30 most-established alts as "large", the rest as "small"
    large = list(hist[alts].sort_values(ascending=False).index[:30])
    small = [s for s in alts if s not in large]
    legs = {"BTC": R["BTC"], "ETH": R["ETH"], "large alts": R[large].mean(axis=1), "small alts": R[small].mean(axis=1),
            "memes": X[members.get("meme", [])].mean(axis=1) + M if "meme" in members else None}
    legs = {k: v for k, v in legs.items() if v is not None}
    L4 = pd.DataFrame(legs)[START:].resample("4W-SUN").sum(min_count=15)
    rel = L4.sub(L4.mean(axis=1), axis=0)              # each leg vs the average of the legs
    seq = list(legs)
    for i in range(len(seq) - 1):
        a, b = seq[i], seq[i + 1]
        ya, yb = halves(rel[b].shift(-1)); xa, xb = halves(rel[a])
        sa, ta, na = nw_t(ya, xa, lags=0); sb, tb, nb = nw_t(yb, xb, lags=0)
        print(f"   {a:>10s} leads {b:<10s} next 4w: slope A {sa:+.3f} (t {ta:+.2f}) | B {sb:+.3f} (t {tb:+.2f}, n {nb})")

    print("\n## 5b. Same legs, weekly, does leg a's relative week predict leg b's relative week 1-4 weeks later?")
    W = pd.DataFrame(legs)[START:].resample("W-SUN").sum(min_count=5)
    relw = W.sub(W.mean(axis=1), axis=0)
    for i in range(len(seq) - 1):
        a, b = seq[i], seq[i + 1]
        line = []
        for lag in (1, 2, 3, 4):
            ya, yb = halves(relw[b].shift(-lag)); xa, xb = halves(relw[a])
            _, ta, _ = nw_t(ya, xa); _, tb, nb = nw_t(yb, xb)
            line.append(f"lag {lag}: t {ta:+.2f}/{tb:+.2f}")
        print(f"   {a:>10s} -> {b:<10s} " + " | ".join(line) + "   (half A / half B)")

    # ---- 6. which categories do best in which market phase -------------------------
    print("\n## 6. Category excess by market phase (BTC above / below its 200-day average; phase known the day before)")
    btc = P["BTC"]; phase = (btc > btc.rolling(200).mean()).shift(1)
    rows = []
    for c in cats:
        for ph, nm in ((True, "bull"), (False, "bear")):
            v = CI[c][phase.reindex(CI.index) == ph]
            a, b = halves(v)
            ma, ta, _ = nw_t(a); mb, tb, nb = nw_t(b)
            rows.append(dict(category=c, phase=nm, A_bp_day=1e4 * ma, A_t=ta, B_bp_day=1e4 * mb, B_t=tb, B_days=nb))
    print(pd.DataFrame(rows).round(2).to_string(index=False))

if __name__ == "__main__":
    main()
