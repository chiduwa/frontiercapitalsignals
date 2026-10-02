"""The 4-hour box result, stress-tested (box.py found the breakout entry beat
random entries with the same exits in both periods). Three questions:
  1. per coin, and leaving each coin out: is it one coin?
  2. is the box doing anything a plain new high would not? Control: random
     entries drawn only from bars that closed at a new 20-bar closing high
     (momentum-matched), same stop distances, same stop-raising schedule
  3. what a trader would have lived through: trades per month, win rate,
     median, the share of the total made by the best 10% of trades
"""
import numpy as np, pandas as pd
from box import from_hourly, boxes, trade, TRACKED, COST
from stats_util import nw_mean

SPLIT = pd.Timestamp("2023-01-01")
rng = np.random.default_rng(5)


def per_asset(lb):
    out = {}
    for sym in TRACKED:
        df = from_hourly(sym, "4h")
        sig = boxes(df, lb)
        later = {i: b for i, k, t, b in sig}
        bo = [(i, b) for i, k, t, b in sig if k == "breakout"]
        if not bo: continue
        tr = pd.DataFrame(trade(df, bo, later, COST["crypto"]), columns=["ret", "held", "date"])
        gaps = np.array([np.log(df.c.values[i] / b) for i, b in bo])
        c = df.c.values
        newhigh = np.where(c >= pd.Series(c).rolling(21).max().values)[0]
        newhigh = newhigh[(newhigh > lb) & (newhigh < len(df) - 2)]
        bo_idx = {i for i, _ in bo}
        newhigh = np.array([i for i in newhigh if i not in bo_idx])
        rnd, mom = [], []
        for rep in range(30):
            idx = rng.choice(np.arange(lb, len(df) - 2), size=len(bo), replace=False)
            rnd += trade(df, [(i, c[i] * np.exp(-g)) for i, g in zip(idx, rng.permutation(gaps))], later, COST["crypto"])
            if len(newhigh) >= len(bo):
                idx = rng.choice(newhigh, size=len(bo), replace=False)
                mom += trade(df, [(i, c[i] * np.exp(-g)) for i, g in zip(idx, rng.permutation(gaps))], later, COST["crypto"])
        out[sym] = (tr, pd.DataFrame(rnd, columns=["ret", "held", "date"]), pd.DataFrame(mom, columns=["ret", "held", "date"]), df)
    return out


def edge(a, b):
    d = a.ret.mean() - b.ret.mean()
    se = np.sqrt(a.ret.var() / max(1, len(a)) + b.ret.var() / max(1, len(b)))
    return d, d / se if se > 0 else np.nan


for name, lb in (("20-bar boxes", 20), ("new 90-day-high boxes", 540)):
    res = per_asset(lb)
    print(f"\n### 4-hour {name}: per coin (net of 0.2% round trip)")
    print("   coin  period trades  mean    median  win   | vs random entries  | vs momentum-matched entries")
    for sym, (tr, rnd, mom, df) in res.items():
        for per in ("A", "B"):
            f = (lambda x: x[x.date < SPLIT]) if per == "A" else (lambda x: x[x.date >= SPLIT])
            t, r, m = f(tr), f(rnd), f(mom)
            if len(t) < 5: continue
            e1, t1 = edge(t, r); e2, t2 = edge(t, m) if len(m) else (np.nan, np.nan)
            print(f"   {sym:5s} {per}      {len(t):4d}  {t.ret.mean() * 100:+6.2f}% {t.ret.median() * 100:+6.2f}% {(t.ret > 0).mean():4.0%} | {e1 * 100:+6.2f}% t{t1:+.1f}       | {e2 * 100:+6.2f}% t{t2:+.1f}")
    print("   pooled, and leaving each coin out (period B):")
    allT = pd.concat([v[0].assign(sym=k) for k, v in res.items()]); allR = pd.concat([v[1].assign(sym=k) for k, v in res.items()]); allM = pd.concat([v[2].assign(sym=k) for k, v in res.items()])
    for per in ("A", "B"):
        f = (lambda x: x[x.date < SPLIT]) if per == "A" else (lambda x: x[x.date >= SPLIT])
        t, r, m = f(allT), f(allR), f(allM)
        e1, t1 = edge(t, r); e2, t2 = edge(t, m)
        top = t.ret.sort_values(ascending=False)
        share = top.head(max(1, len(top) // 10)).sum() / top.sum() if top.sum() > 0 else np.nan
        months = (t.date.max() - t.date.min()).days / 30.4
        print(f"   ALL  {per}: {len(t)} trades ({len(t) / months:.1f}/month), mean {t.ret.mean() * 100:+.2f}%, median {t.ret.median() * 100:+.2f}%, win {(t.ret > 0).mean():.0%}, "
              f"best 10% of trades = {share:.0%} of the total | vs random {e1 * 100:+.2f}% t{t1:+.2f} | vs momentum-matched {e2 * 100:+.2f}% t{t2:+.2f}")
    tB, rB, mB = allT[allT.date >= SPLIT], allR[allR.date >= SPLIT], allM[allM.date >= SPLIT]
    print("   leave one out (B): " + " | ".join(f"-{s}: {edge(tB[tB.sym != s], rB[rB.sym != s])[1]:+.1f}/{edge(tB[tB.sym != s], mB[mB.sym != s])[1]:+.1f}" for s in res))
    print("   (t vs random / t vs momentum-matched)")
