"""Summarise sim.py's trades: per variant, per half, per tier and case; then
leverage and a portfolio simulation for the variant chosen on the first half."""
import sys, numpy as np, pandas as pd
T = pd.read_pickle("trades.pkl")
SPLIT = int(pd.Timestamp("2025-05-29").value // 10**6)
DAY = 86_400_000

# one trade per coin at a time: keep a print only if the coin's previous kept
# print was 24h or more earlier (what a per-coin position lock does, roughly)
P = T[["coin", "t"]].drop_duplicates().sort_values(["coin", "t"])
keep, last = [], {}
for c, t in P.itertuples(index=False):
    if c not in last or t - last[c] >= DAY: keep.append((c, t)); last[c] = t
K = pd.DataFrame(keep, columns=["coin", "t"]); K["fresh"] = True
T = T.merge(K, on=["coin", "t"], how="left"); T["fresh"] = T.fresh.fillna(False).astype(bool)
T["half"] = np.where(T.t < SPLIT, 1, 2)
T["day"] = T.t // DAY
T["hedged"] = T.net + T.btc - 2 * 0.0005

def clustered_t(df, col="net"):
    g = df.groupby("day")[col].sum()
    days = df.day.nunique()
    if days < 5: return np.nan
    # mean per trade, t from day sums (prints on one day share one market move)
    n = len(df); m = df[col].mean()
    s = np.sqrt(((g - g.mean()) ** 2).sum() * days / (days - 1)) / n if days > 1 else np.nan
    return m / s if s else np.nan

def stats(df, col="net"):
    f = df[df.filled]
    if len(f) == 0: return dict(n=0)
    return dict(signals=len(df), n=len(f), fill=len(f) / len(df), mean=f[col].mean(), med=f[col].median(),
                win=(f[col] > 0).mean(), t=clustered_t(f, col), stop=(f.reason == "stop").mean(),
                fund=f.funding.mean(), cost=f.cost.mean())

def line(name, s):
    if not s.get("n"): return f"  {name:44s} n=0"
    return (f"  {name:44s} n={s['n']:5d} fill {s['fill']*100:3.0f}%  mean {s['mean']*100:+6.2f}%  med {s['med']*100:+6.2f}%  "
            f"win {s['win']*100:3.0f}%  t {s['t']:+5.1f}  stops {s['stop']*100:3.0f}%  funding {s['fund']*100:+.2f}%  cost {s['cost']*100:.2f}%")

F = T[T.fresh]
print(f"fresh prints: {F[['coin','t']].drop_duplicates().shape[0]:,} on {F.coin.nunique()} coins; "
      f"{F.t.min() and pd.to_datetime(F.t.min(), unit='ms').date()} to {pd.to_datetime(F.t.max(), unit='ms').date()}")
pr = F[["coin", "t", "tier", "case"]].drop_duplicates()
months = (pr.t.max() - pr.t.min()) / DAY / 30.44
print(f"per month: {len(pr) / months:.0f} fresh prints ({(pr.tier=='thin').sum()/months:.0f} thin, {(pr.tier=='mid').sum()/months:.0f} mid)")
print("by case:", pr.case.value_counts().to_dict(), " by tier:", pr.tier.value_counts().to_dict())

variants = F.groupby(["entry", "stop", "hold", "late"])
res = []
for key, g in variants:
    s1, s2, sa = stats(g[g.half == 1]), stats(g[g.half == 2]), stats(g)
    res.append((key, s1, s2, sa))
print("\n== every variant, net of fees, slippage and funding, per trade (price move, 1x) ==")
print("   entry  stop  hold late | half 1 (to 2025-05-28) | half 2 (from 2025-05-29)")
for key, s1, s2, sa in sorted(res, key=lambda r: -(r[1].get("t") or -99)):
    e, st, h, late = key
    nm = f"{e:5s} {('stop %d%%' % round(st*100)) if st else 'no stop':8s} {h:3d}h {'late' if late else 'on-time'}"
    print(f"{nm:34s} H1 n={s1.get('n',0):4d} {s1.get('mean',0)*100:+6.2f}% t {s1.get('t',0):+5.1f} | "
          f"H2 n={s2.get('n',0):4d} {s2.get('mean',0)*100:+6.2f}% t {s2.get('t',0):+5.1f} win {s2.get('win',0)*100:3.0f}%")

# choose on half 1 among the conservative ('late') executions
cons = [r for r in res if r[0][3]]
best = max(cons, key=lambda r: r[1].get("t") or -99)
bk = best[0]
print(f"\n== chosen on half 1 (late execution): entry {bk[0]}, stop {bk[1]}, hold {bk[2]}h ==")
B = F[(F.entry == bk[0]) & (F.stop == bk[1]) & (F.hold == bk[2]) & (F.late == bk[3])]
for h in (1, 2):
    print(line(f"half {h}", stats(B[B.half == h])))
    for tr in ("thin", "mid"):
        print(line(f"   half {h} {tr}", stats(B[(B.half == h) & (B.tier == tr)])))
    for cs in ("both", "percoin", "x20"):
        print(line(f"   half {h} {cs}", stats(B[(B.half == h) & (B.case == cs)])))
    print(line(f"   half {h} hedged with a BTC long", stats(B[B.half == h], "hedged")))
Bff = B[B.filled]
for h in (1, 2):
    g = Bff[Bff.half == h]
    print(f"  half {h} decomposition: price move {g.gross.mean()*100:+.2f}%, fees+slippage -{g.cost.mean()*100:.2f}%, funding {g.funding.mean()*100:+.2f}%; "
          f"worst 5% of trades average {g.net.nsmallest(max(1, len(g)//20)).mean()*100:+.1f}%, best 5% {g.net.nlargest(max(1, len(g)//20)).mean()*100:+.1f}%")
# same variant, on-time execution, for the timing gap
Bo = F[(F.entry == bk[0]) & (F.stop == bk[1]) & (F.hold == bk[2]) & (~F.late)]
for h in (1, 2): print(line(f"half {h}, on time (optimistic)", stats(Bo[Bo.half == h])))

# per year
Bf = B[B.filled].copy(); Bf["year"] = pd.to_datetime(Bf.t, unit="ms").dt.year
print("\nper year:", {y: f"n={len(g)} mean {g.net.mean()*100:+.2f}% win {(g.net>0).mean()*100:.0f}%" for y, g in Bf.groupby("year")})

# leverage: price move x L, liquidated (whole margin) if the adverse move reached 1/L less 1% maintenance
print("\n== return on margin per trade by leverage (chosen variant) ==")
for L in (1, 2, 3, 5, 10):
    liq = Bf.mae >= (1.0 / L - 0.01)
    roi = np.where(liq, -1.0 - 0.0005 * L, np.maximum(Bf.net * L, -1.0 - 0.0005 * L))
    for h in (1, 2):
        m = Bf.half.to_numpy() == h
        print(f"  {L:2d}x half {h}: mean {roi[m].mean()*100:+7.2f}% of margin, median {np.median(roi[m])*100:+7.2f}%, "
              f"liquidated {liq.to_numpy()[m].mean()*100:4.1f}%, worst {roi[m].min()*100:+.0f}%")

# portfolio: 5% of equity as margin per trade, one position per coin, at most
# 10 open, aggregate margin under 50% of equity; realized equity only
def portfolio(df, L, frac=0.05, maxpos=10, ceiling=0.5):
    ev = df.sort_values("t_in")
    eq, open_, curve, taken = 1.0, [], [], 0
    for r in ev.itertuples(index=False):
        still = []
        for (t_out, margin, roi, coin) in sorted(open_):
            if t_out <= r.t_in: eq += margin * roi; curve.append((t_out, eq))
            else: still.append((t_out, margin, roi, coin))
        open_ = still
        if len(open_) >= maxpos or any(o[3] == r.coin for o in open_): continue
        margin = frac * eq
        if sum(o[1] for o in open_) + margin > ceiling * eq: continue
        roi = -1.0 - 0.0005 * L if r.mae >= (1.0 / L - 0.01) else max(r.net * L, -1.0 - 0.0005 * L)
        open_.append((r.t_out, margin, roi, r.coin)); taken += 1
    for (t_out, margin, roi, coin) in sorted(open_): eq += margin * roi; curve.append((t_out, eq))
    c = pd.DataFrame(curve, columns=["t", "eq"])
    peak = c["eq"].cummax(); dd = (c["eq"] / peak - 1).min()
    yrs = (c.t.max() - ev.t_in.min()) / DAY / 365.25
    return eq, eq ** (1 / yrs) - 1, dd, taken, taken / (yrs * 12)
print("\n== portfolio: 5% of equity as margin a trade, <=10 open, <=50% margin in use ==")
for L in (2, 3, 5):
    for h in (1, 2):
        eq, cagr, dd, n, pm = portfolio(Bf[Bf.half == h], L)
        print(f"  {L}x half {h}: equity x{eq:.2f}, {cagr*100:+.0f}%/yr, worst drawdown {dd*100:.0f}% (realized), {n} trades ({pm:.0f}/month)")
