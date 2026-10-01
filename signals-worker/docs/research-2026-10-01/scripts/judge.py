"""How often would the live judge have wrongly demoted a rule that truly works?
Replays every rolling window of W cast-days of history through the judge's own
statistic (day-clustered mean of dir*(coin - market)), with variants."""
import numpy as np, pandas as pd
E = pd.read_pickle("events_bt.pkl")
E["signed"] = -E.exc24 * 100            # dir = -1: positive = warning was right
cfgs = {"exhaustion_calibrated": E[E.case.isin(["both", "percoin"]) & ~(E.mcap_proxy > 5e8)],
        "exhaustion20": E[E.case.isin(["both", "x20"])]}
def t_of(v):
    s = v.groupby(level=0).mean()
    return s.mean() / (s.std(ddof=1) / np.sqrt(len(s))) if len(s) > 2 and s.std() > 0 else np.nan
variants = {
  "current (raw mean)": lambda g: g.signed,
  "winsorize +/-30%": lambda g: g.signed.clip(-30, 30),
  "winsorize +/-20%": lambda g: g.signed.clip(-20, 20),
  "winsorize +/-10%": lambda g: g.signed.clip(-10, 10),
  "sign only (+1/-1)": lambda g: np.sign(g.signed),
}
for name, X in cfgs.items():
    days = np.array(sorted(X.day.unique()))
    print(f"\n## {name}: {len(X)} casts over {len(days)} cast-days; P(judge t <= -2) over rolling windows")
    for W in (10, 20, 30):
        res = {}
        for vn, f in variants.items():
            v = pd.Series(f(X).values, index=X.day.values)
            ts = [t_of(v[(v.index >= days[k]) & (v.index <= days[k + W - 1])]) for k in range(0, len(days) - W + 1, 2)]
            ts = np.array([t for t in ts if np.isfinite(t)])
            res[vn] = f"{100*(ts <= -2).mean():5.1f}% demote / {100*(ts >= 2).mean():5.1f}% confirm"
        print(f"  {W:2d} days: " + " | ".join(f"{k}: {v}" for k, v in res.items()))
