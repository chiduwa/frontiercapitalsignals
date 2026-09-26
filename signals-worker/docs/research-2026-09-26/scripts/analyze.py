"""Exhaustion research, step 2: which sell warnings actually work, for whom.

Methodology (the project's, not a new one):
  * Outcome = coin return minus the equal-weight market over the SAME hours
    (excess). A warning is only useful if the coin does worse than everything
    else did; a falling market makes every down-call look good.
  * Day-clustered: casts on one day share one market move, so the t-stat is
    over days, never over casts.
  * Discovery / validation split by date. Variants are ranked on the first
    half ONLY; the numbers that count are the second half's, which played no
    part in the choice.
"""
import json, os, sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
df = pd.read_pickle(os.path.join(HERE, "cand.pkl"))
df["day"] = (df.t // 86_400_000).astype(np.int64)
for H in (4, 12, 24, 72, 168):
    df[f"exc{H}"] = df[f"fwd{H}"] - df[f"mkt{H}"]
split_day = int(np.median(np.unique(df.day)))
df["half"] = np.where(df.day < split_day, 1, 2)
print(f"rows {len(df):,}; candidates {int(df.cand.sum()):,}; sample {int(df['sample'].sum()):,}; "
      f"split at {pd.to_datetime(split_day * 86_400_000, unit='ms').date()}")

# liquidity tiers from each symbol's own median hourly quote volume
liq = df[df["sample"] == 1].groupby("sym").liq.median()
tier_cut_major = liq.quantile(0.90)
tier_cut_thin = liq.quantile(0.40)
def tier_of(sym):
    v = liq.get(sym, np.nan)
    if not np.isfinite(v): return "unknown"
    return "major" if v >= tier_cut_major else ("thin" if v < tier_cut_thin else "mid")
tiers = {s: tier_of(s) for s in df.sym.unique()}
df["tier"] = df.sym.map(tiers)
majors = sorted([s for s, t in tiers.items() if t == "major"], key=lambda s: -liq.get(s, 0))
print(f"tiers: {sum(1 for v in tiers.values() if v=='major')} major (>= ${tier_cut_major:,.0f}/h), "
      f"{sum(1 for v in tiers.values() if v=='mid')} mid, {sum(1 for v in tiers.values() if v=='thin')} thin (< ${tier_cut_thin:,.0f}/h)")
print("majors:", ", ".join(majors[:40]))

def clustered(ev, col):
    x = ev[[col, "day"]].dropna()
    if len(x) == 0: return (np.nan, np.nan, 0)
    per_day = x.groupby("day")[col].mean()
    n = len(per_day)
    m = per_day.mean()
    sd = per_day.std(ddof=1) if n > 1 else np.nan
    t = m / (sd / np.sqrt(n)) if n > 1 and sd > 0 else np.nan
    return (m, t, n)

def stats(ev, H=24):
    col = f"exc{H}"
    m, t, nd = clustered(ev, col)
    m1, t1, n1 = clustered(ev[ev.half == 1], col)
    m2, t2, n2 = clustered(ev[ev.half == 2], col)
    x = ev[col].dropna()
    per_sym = ev.groupby("sym")[col].mean().dropna()
    return {
        "n": int(len(ev)), "days": int(nd), "syms": int(ev.sym.nunique()),
        "mean": float(m * 100) if np.isfinite(m) else None, "t": float(t) if np.isfinite(t) else None,
        "median": float(x.median() * 100) if len(x) else None,
        "negShare": float((x < 0).mean()) if len(x) else None,
        "symNegShare": float((per_sym < 0).mean()) if len(per_sym) else None,
        "h1": float(m1 * 100) if np.isfinite(m1) else None, "t1": float(t1) if np.isfinite(t1) else None, "d1": int(n1),
        "h2": float(m2 * 100) if np.isfinite(m2) else None, "t2": float(t2) if np.isfinite(t2) else None, "d2": int(n2),
        "top": float(ev[f"top{H}"].mean()) if f"top{H}" in ev else None,
        "upMed": float(ev[f"up{H}"].median() * 100) if f"up{H}" in ev else None,
        "ddMed": float(ev[f"dd{H}"].median() * 100) if f"dd{H}" in ev else None,
        "perDay": float(len(ev) / max(1, df.day.nunique())),
    }

def fmt(name, s):
    f = lambda v, d=2: "  n/a" if v is None else f"{v:+.{d}f}"
    return (f"{name:44s} n={s['n']:6d} d={s['days']:4d} sym={s['syms']:3d} "
            f"exc={f(s['mean'])}% t={f(s['t'],1)} | H1 {f(s['h1'])} (t {f(s['t1'],1)}) H2 {f(s['h2'])} (t {f(s['t2'],1)}) "
            f"| neg {s['negShare']*100 if s['negShare'] is not None else float('nan'):4.0f}% top {s['top']*100 if s['top'] is not None else float('nan'):4.0f}% "
            f"up {f(s['upMed'],1)}% dd {f(s['ddMed'],1)}% {s['perDay']:.1f}/d")

C = df[df.cand == 1]
S = df[df["sample"] == 1]
report = {"split": str(pd.to_datetime(split_day * 86_400_000, unit='ms').date()), "variants": {}, "tiers": {}}

print("\n== reference ==")
for H in (24, 72):
    print(fmt(f"all bars (1% sample), {H}h", stats(S, H)))
    print(fmt(f"rising bars (sample), {H}h", stats(S[S.bar > 0], H)))

print("\n== the live rule (exhaustion20), by tier ==")
E0 = C[(C.ratio48 >= 20) & (C.tradeRatio >= 2) & (C.bar >= 0.05)]
for H in (24, 72):
    print(fmt(f"exhaustion20 all, {H}h", stats(E0, H)))
for tr in ("major", "mid", "thin"):
    print(fmt(f"exhaustion20 {tr}, 24h", stats(E0[E0.tier == tr], 24)))
report["variants"]["exhaustion20"] = {H: stats(E0, H) for H in (24, 72)}

# --- calibrated variants: extreme FOR THIS COIN, on its own history ----------
grid = []
for vz in (2.5, 3, 3.5, 4, 5):
    for bz in (1.5, 2, 3, 4):
        for rz in (None, 1.5, 3):
            for hi in (False, True):
                m = (C.volZ >= vz) & (C.barZ >= bz)
                if rz is not None: m &= (C.run24Z >= rz)
                if hi: m &= (C.vs7dHigh >= 0)
                name = f"volZ>={vz} barZ>={bz}" + (f" run24Z>={rz}" if rz else "") + (" newHigh7d" if hi else "")
                grid.append((name, m))
# --- fading participation into a high ---------------------------------------
for rz in (1.5, 2.5, 3.5):
    for fz in (0.5, 0.7, 0.9):
        m = (C.vs7dHigh >= -0.01) & (C.run72Z >= rz) & (C.fade <= fz)
        grid.append((f"FADE run72Z>={rz} vol24/vol30d<={fz} at 7d high", m))
rows = []
for name, m in grid:
    ev = C[m]
    if len(ev) < 50: continue
    s24 = stats(ev, 24)
    rows.append((name, s24, ev))
# rank on DISCOVERY half only
disc = sorted([r for r in rows if r[1]["t1"] is not None and r[1]["d1"] >= 40], key=lambda r: r[1]["t1"])
print(f"\n== calibrated variants: {len(rows)} tested; top 15 by discovery-half t (24h) ==")
for name, s, ev in disc[:15]:
    print(fmt(name, s))
passing = [(n, s, ev) for n, s, ev in disc if s["t1"] <= -3 and s["t2"] is not None and s["t2"] <= -2 and s["h2"] < 0]
print(f"\n{len(passing)} variant(s) with discovery t <= -3 AND validation t <= -2 (24h)")
for n, s, ev in passing[:20]:
    print(fmt(n, s))
report["grid"] = [{"name": n, **s} for n, s, _ in rows]

# --- does VOLUME add anything beyond a big green bar? ------------------------
print("\n== volume vs price alone (24h) ==")
big = C  # candidates are already volume-lifted; use the sample for quiet volume
for bz in (2, 3, 4):
    quiet = S[(S.barZ >= bz) & (S.volZ < 1)]
    loud = C[(C.barZ >= bz) & (C.volZ >= 3)]
    print(fmt(f"barZ>={bz} on QUIET volume (sample)", stats(quiet, 24)))
    print(fmt(f"barZ>={bz} on LOUD volume  (volZ>=3)", stats(loud, 24)))

# --- tier breakdown for the best validated variant --------------------------
if passing:
    best_name, best_s, best_ev = passing[0]
    print(f"\n== best validated: {best_name} ==")
    for H in (4, 12, 24, 72, 168):
        print(fmt(f"  all {H}h", stats(best_ev, H)))
    for tr in ("major", "mid", "thin"):
        for H in (24, 72):
            s = stats(best_ev[best_ev.tier == tr], H)
            report["tiers"][f"{tr}|{H}"] = s
            print(fmt(f"  {tr} {H}h", s))
    for sym in majors[:12]:
        e = best_ev[best_ev.sym == sym]
        if len(e):
            s = stats(e, 24)
            print(f"    {sym:6s} n={s['n']:3d} exc24 {s['mean']:+.2f}%  top24 {s['top']*100:.0f}%  up24 {s['upMed']:+.1f}%")

json.dump(report, open(os.path.join(HERE, "report.json"), "w"), indent=1, default=float)

# --- majors on their own: is there ANY hourly climax that works for them? ----
print("\n== majors only: sweep, ranked on discovery half (24h and 72h) ==")
Cm = C[C.tier == "major"]
mrows = []
for vz in (2.5, 3, 4, 5, 6):
    for bz in (1.5, 2, 3, 4):
        for rz in (None, 2, 3):
            m = (Cm.volZ >= vz) & (Cm.barZ >= bz)
            if rz is not None: m &= (Cm.run24Z >= rz)
            ev = Cm[m]
            if len(ev) < 40: continue
            for H in (24, 72):
                s = stats(ev, H)
                if s["t1"] is None: continue
                mrows.append((f"volZ>={vz} barZ>={bz}" + (f" run24Z>={rz}" if rz else "") + f" @{H}h", s))
mrows.sort(key=lambda r: r[1]["t1"])
for n, s in mrows[:10]:
    print(fmt(n, s))
ok_major = [r for r in mrows if r[1]["t1"] <= -3 and r[1]["t2"] is not None and r[1]["t2"] <= -2]
print(f"{len(ok_major)} majors-only variant(s) pass discovery t<=-3 AND validation t<=-2")
report["majors_sweep"] = [{"name": n, **s} for n, s in mrows[:30]]

# --- the user's favorites and holdings --------------------------------------
if passing:
    print(f"\n== favorites/holdings under the best validated rule ({passing[0][0]}) ==")
    for sym in ("BTC", "ETH", "SOL", "XRP", "XLM", "HBAR", "ARB", "WLFI", "HYPE"):
        e = passing[0][2][passing[0][2].sym == sym]
        t = tiers.get(sym, "not on Binance spot")
        if len(e) >= 3:
            s = stats(e, 24)
            print(f"  {sym:5s} tier={t:6s} n={s['n']:3d} exc24 {s['mean']:+.2f}%  exc72 {stats(e,72)['mean']:+.2f}%  top24 {s['top']*100:.0f}%  up24 median {s['upMed']:+.1f}%")
        else:
            print(f"  {sym:5s} tier={t:6s} n={len(e)} (too few prints)")
json.dump(report, open(os.path.join(HERE, "report.json"), "w"), indent=1, default=float)
