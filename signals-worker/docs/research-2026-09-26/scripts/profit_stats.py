"""Statistics for the profit-growth panel built by backtest.py.

For each size bucket and each pre-specified group, per formation date:
  excess = mean 13-week return of the group - mean of every stock in the bucket
Then across formation dates (non-overlapping 13-week holds): mean, t, share of
quarters the group won, and the two chronological halves separately. The
groups were fixed before looking at any result; nothing here is tuned.
"""
import json, os
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
R = pd.read_pickle(os.path.join(HERE, "panel.pkl"))
R = R[R.bucket.notna()].copy()
# one absurd print (a reverse split the price series missed) can own a
# small-cap equal-weight mean; clip each stock-quarter at -100%/+300%
for h in (13, 26, 52):
    R[f"r{h}"] = R[f"r{h}"].clip(-1, 3)

GROUPS = {
    "profitable":          lambda d: d.ttm > 0,
    "unprofitable":        lambda d: d.ttm < 0,
    "growing_profits":     lambda d: (d.ttm > 0) & (d.prev > 0) & (d.g >= 0.20) & (d.grev > 0),
    "consistent_growers":  lambda d: (d.prof_q == 4) & (d.yoy_pos >= 3) & (d.grev > 0),
    "growth_reasonable_pe": lambda d: (d.ttm > 0) & (d.prev > 0) & (d.g >= 0.20) & (d.grev > 0) & d.pe.between(5, 30),
    "operating_growers":   lambda d: (d.ottm > 0) & (d.oprev > 0) & (d.goi >= 0.20) & (d.grev > 0),
    "turned_profitable":   lambda d: (d.ttm > 0) & (d.prev <= 0),
    "shrinking_profits":   lambda d: (d.ttm > 0) & (d.g < 0),
}

def series(d, mask, h):
    rows = []
    for form, g in d.groupby("form"):
        base = g[f"r{h}"].dropna()
        sel = g[mask(g)][f"r{h}"].dropna()
        if len(base) < 20 or len(sel) < 5: continue
        rows.append((form, sel.mean() - base.mean(), sel.median() - base.median(), len(sel), len(base)))
    return pd.DataFrame(rows, columns=["form", "exc", "excMed", "n", "nBase"])

def summarize(s, periods_per_year):
    if len(s) < 6: return None
    x = s.exc.to_numpy()
    half = len(x) // 2
    t = x.mean() / (x.std(ddof=1) / np.sqrt(len(x))) if x.std(ddof=1) > 0 else np.nan
    h1, h2 = x[:half], x[half:]
    return {
        "quarters": int(len(x)), "meanExcessPct": float(x.mean() * 100), "t": float(t),
        "annualizedPct": float(((1 + x.mean()) ** periods_per_year - 1) * 100),
        "winShare": float((x > 0).mean()), "medianExcessPct": float(s.excMed.mean() * 100),
        "firstHalfPct": float(h1.mean() * 100), "secondHalfPct": float(h2.mean() * 100),
        "avgNames": float(s.n.mean()), "avgBucket": float(s.nBase.mean()),
        "from": s.form.iloc[0], "to": s.form.iloc[-1],
    }

out = {}
print(f"panel {len(R):,} stock-quarters; formations {R.form.min()} .. {R.form.max()}")
print(R.groupby("bucket").size().to_string())
for bucket in ("small", "mid", "large", "micro"):
    d = R[R.bucket == bucket]
    print(f"\n=== {bucket.upper()} CAPS (avg {d.groupby('form').size().mean():.0f} stocks per quarter) ===")
    print(f"{'group':24s} {'qtrs':>4s} {'excess/q':>9s} {'t':>6s} {'ann.':>7s} {'wins':>5s} {'median':>7s} {'1st half':>9s} {'2nd half':>9s} {'names':>6s}")
    out[bucket] = {}
    for name, mask in GROUPS.items():
        s = summarize(series(d, mask, 13), 4)
        if not s: continue
        out[bucket][name] = s
        print(f"{name:24s} {s['quarters']:4d} {s['meanExcessPct']:+8.2f}% {s['t']:+6.2f} {s['annualizedPct']:+6.1f}% {s['winShare']*100:4.0f}% "
              f"{s['medianExcessPct']:+6.2f}% {s['firstHalfPct']:+8.2f}% {s['secondHalfPct']:+8.2f}% {s['avgNames']:6.0f}")
    # dose-response inside profitable companies: fastest vs slowest growth third
    rows = []
    for form, g in d[(d.ttm > 0) & (d.prev > 0) & d.g.notna()].groupby("form"):
        g = g.dropna(subset=["r13"])
        if len(g) < 30: continue
        lo, hi = g.g.quantile([1/3, 2/3])
        rows.append(g[g.g >= hi].r13.mean() - g[g.g <= lo].r13.mean())
    if len(rows) >= 6:
        x = np.array(rows)
        print(f"{'  fastest-minus-slowest':24s} {len(x):4d} {x.mean()*100:+8.2f}% {x.mean()/(x.std(ddof=1)/np.sqrt(len(x))):+6.2f}   (profitable firms, top vs bottom third of profit growth)")
        out[bucket]["dose_response"] = {"quarters": len(x), "meanSpreadPct": float(x.mean() * 100),
                                        "t": float(x.mean() / (x.std(ddof=1) / np.sqrt(len(x))))}
    # longer holds (overlapping, so mean only)
    for h in (26, 52):
        s = series(d, GROUPS["growing_profits"], h)
        if len(s):
            out[bucket].setdefault("growing_profits_longer", {})[f"{h}w"] = float(s.exc.mean() * 100)
    lg = out[bucket].get("growing_profits_longer", {})
    if lg:
        print(f"  growing_profits held 26w: {lg.get('26w', float('nan')):+.2f}% excess, 52w: {lg.get('52w', float('nan')):+.2f}% excess (overlapping windows, mean only)")

json.dump(out, open(os.path.join(HERE, "profit_report.json"), "w"), indent=1)
