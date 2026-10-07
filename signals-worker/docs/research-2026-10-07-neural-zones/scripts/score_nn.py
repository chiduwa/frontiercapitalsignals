"""Scores nn_zones.py's walk-forward forecasts against the linear median
regression (day-zones-v3's model, refit on the same schedule) and against v2.
Also a fixed 50/50 blend of the linear model and each network (no weights
fitted), and whether any model can tilt the day up or down."""
import numpy as np, pandas as pd
from nn_zones import OUT, SPLIT, TRACKED, losses
from stats_util import nw_mean

A = pd.read_pickle(f"{OUT}/rows.pkl")
P = dict(np.load(f"{OUT}/predictions.npz"))
med = np.c_[A.medU.values, A.medD.values]
P["v2 (old live)"] = np.log(np.stack([np.stack([A[f"median|U|{t}"].values for t in (0.1, 0.25, 0.5, 0.75, 0.9)], 1),
                                      np.stack([A[f"median|D|{t}"].values for t in (0.1, 0.25, 0.5, 0.75, 0.9)], 1)], 1) / med[:, :, None])
for k in ("mlp", "lstm", "lgbm"):
    P[f"linear + {k}, 50/50"] = (P["linear"] + P[k]) / 2
ok = np.ones(len(A), bool)
for q in P.values(): ok &= np.isfinite(q).all((1, 2))
S = A[ok].copy()
L = {k: losses(S, q[ok]) for k, q in P.items()}
ref = L["linear"]
print(f"common set: {len(S):,} coin-days, {S.date.min().date()} .. {S.date.max().date()}; "
      + ", ".join(f"{s} {int((S.sym == s).sum())}" for s in TRACKED))
order = ["v2 (old live)", "linear", "lgbm", "mlp", "lstm", "linear + lgbm, 50/50", "linear + mlp, 50/50", "linear + lstm, 50/50"]
print("\n## Against the linear median regression (day-zones-v3's model, same walk-forward). <1 = better than it.")
print("   ratio = mean over coins of (method / linear); t = paired difference, coin-days pooled per date, Newey-West (negative = better)")
print(f"   {'model':22s} | {'2019-22: MAE':>14s} {'CRPS':>14s} {'inside U/D':>10s} {'80% band':>8s} | {'2023-26: MAE':>14s} {'CRPS':>14s} {'inside U/D':>10s} {'80% band':>8s}")
rows = []
for k in order:
    cells = []
    for per, m in (("2019-22", (S.date < SPLIT).values), ("2023-26", (S.date >= SPLIT).values)):
        Sp = S[m]
        r = {}
        for col in ("mae", "crps"):
            ratio = np.mean([L[k][col][m][Sp.sym == s].mean() / ref[col][m][Sp.sym == s].mean() for s in Sp.sym.unique()])
            t = nw_mean((L[k][col][m] - ref[col][m]).groupby(Sp.date).sum().values)[1] if k != "linear" else np.nan
            r[col] = (ratio, t)
        cells.append(f"{r['mae'][0]:.3f} (t {r['mae'][1]:+5.1f}) {r['crps'][0]:.3f} (t {r['crps'][1]:+5.1f})  {L[k]['inU'][m].mean():.2f}/{L[k]['inD'][m].mean():.2f}    {L[k]['band80'][m].mean():.2f}")
        rows.append(dict(model=k, period=per, mae=r["mae"][0], mae_t=r["mae"][1], crps=r["crps"][0], crps_t=r["crps"][1]))
    print(f"   {k:22s} | " + " | ".join(cells))
pd.DataFrame(rows).to_csv(f"{OUT}/summary.csv", index=False)

print("\n## Per coin, MAE vs the linear model (2019-22 | 2023-24 | 2025-26)")
S["half"] = np.where(S.date < SPLIT, "A", np.where(S.date < pd.Timestamp("2025-01-01"), "B1", "B2"))
tab = {}
for k in order:
    for s in TRACKED:
        for h in ("A", "B1", "B2"):
            m = ((S.sym == s) & (S.half == h)).values
            if m.sum() >= 60: tab[(k, s, h)] = L[k]["mae"][m].mean() / ref["mae"][m].mean()
T = pd.Series(tab).unstack([1, 2])
with pd.option_context("display.width", 250, "display.max_columns", 40, "display.float_format", "{:.3f}".format):
    print(T)

print("\n## Can any of them tilt the day up or down? Actual skew (U - D)/(U + D) on the forecast's log(U^/D^),")
print("   standardized within coin, coin intercepts, date-clustered t. A real tilt shows up in BOTH periods.")
for k in order:
    cells = []
    for per, m in (("2019-22", (S.date < SPLIT).values), ("2023-26", (S.date >= SPLIT).values)):
        Sp = S[m]
        q = P[k][ok][m]
        x = (q[:, 0, 2] + np.log(Sp.medU.values)) - (q[:, 1, 2] + np.log(Sp.medD.values))
        y = ((Sp.U - Sp.D) / (Sp.U + Sp.D)).values
        d = pd.DataFrame({"x": x, "y": y, "sym": Sp.sym.values, "date": Sp.date.values})
        d["x"] = d.groupby("sym").x.transform(lambda v: (v - v.mean()) / v.std())
        d["y"] = d.y - d.groupby("sym").y.transform("mean")
        b = (d.x * d.y).sum() / (d.x ** 2).sum()
        e = d.y - b * d.x
        g = (d.x * e).groupby(d.date).sum()
        se = np.sqrt((g ** 2).sum()) / (d.x ** 2).sum()
        cells.append(f"{per}: slope {b:+.4f} (t {b / se:+.1f})")
    print(f"   {k:22s} " + " | ".join(cells))
