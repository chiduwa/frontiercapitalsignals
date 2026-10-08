"""Is the grid's shortfall the market's structure, or the replay?

Each coin gets 16 copies whose days are mirrored at random: the same bar
ranges and volatility, no trend or mean reversion. Both run through the same
replay, so real minus copies isolates what direction did to the grid, fee-free.
"""
import zlib
import numpy as np, pandas as pd
from multiprocessing import Pool
from gridsim import load_panel, build_path, run_grid, geometric_range, grid_count

KS, STEPS, HS, COPIES = (1.5, 2.0, 3.0), (0.006, 0.015, 0.03), (30, 90), 16
A, _ = load_panel()

def flip(a, rng):
    o, h, l, c = a["o"], a["h"], a["l"], a["c"]
    rh, rl, rc = np.log(h / o), np.log(l / o), np.log(c / o)
    gap = np.concatenate([[0.0], np.log(o[1:] / c[:-1])])
    s = rng.choice([-1.0, 1.0], size=len(c))
    nh, nl = np.where(s > 0, rh, -rl), np.where(s > 0, rl, -rh)
    lo_, lc = np.empty(len(c)), np.empty(len(c))
    for i in range(len(c)):
        lo_[i] = np.log(o[0]) if i == 0 else lc[i - 1] + s[i] * gap[i]
        lc[i] = lo_[i] + s[i] * rc[i]
    return dict(o=np.exp(lo_), h=np.exp(lo_ + nh), l=np.exp(lo_ + nl), c=np.exp(lc), date=a["date"])

def runs(a):
    path, day = build_path(a); lr = np.diff(np.log(a["c"])); out = {}
    for H in HS:
        for st in range(90, len(a["c"]) - H, 7):
            sig = lr[st - 90:st].std(); m = (day >= st) & (day < st + H)
            for k in KS:
                lo, hi = geometric_range(a["o"][st], sig, H, k)
                for step in STEPS:
                    out[(H, st, k, step)] = run_grid(path[m], day[m], lo, hi, grid_count(lo, hi, step))["excess"]
    return out

def job(sym):
    a = A[sym]; real = runs(a); rng = np.random.default_rng(zlib.crc32(sym.encode()))
    copies = [runs(flip(a, rng)) for _ in range(COPIES)]
    return [dict(sym=sym, H=key[0], start=a["date"][key[1]], k=key[2], step=key[3],
                 diff=v - np.mean([c[key] for c in copies])) for key, v in real.items()]

if __name__ == "__main__":
    with Pool() as p:
        r = pd.DataFrame([x for rows in p.map(job, [s for s in A if s != "HYPE"]) for x in rows])
    r["half"] = np.where(r.start < "2024-01-01", "2021-23", "2024-26")
    t = lambda x, H: x.mean() / (x.std(ddof=1) / np.sqrt(max(2, len(x) * 7 / H)))
    print(f"Real minus {COPIES} direction-randomized copies, fee-free, % of capital per run, {r.sym.nunique()} coins")
    for (H, k, step), x in r.groupby(["H", "k", "step"]):
        parts = [f"{h} {xx['diff'].mean()*100:+.2f}% (t {t(xx['diff'], H):+.1f})" for h, xx in x.groupby("half")]
        print(f"  {H}d +-{k} sd step {step*100:.1f}%: " + " | ".join(parts) + f" | all {x['diff'].mean()*100:+.2f}% (t {t(x['diff'], H):+.1f})")
    print("\nPer coin, 30-day grids, +-2 sd, 1.5% per grid")
    x = r[(r.H == 30) & (r.k == 2.0) & (r.step == 0.015)]
    for s, xx in x.groupby("sym"):
        print(f"  {s:4s} " + " | ".join(f"{h} {y['diff'].mean()*100:+.2f}% (t {t(y['diff'], 30):+.1f})" for h, y in xx.groupby("half")))
