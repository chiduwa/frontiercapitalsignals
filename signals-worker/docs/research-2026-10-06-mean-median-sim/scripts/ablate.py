"""Which inputs carry the learned model's gain, solved exactly (linear
program, HiGHS) at the median. Walk-forward exactly as score.py: pooled over
coins, refit every 91 days on everything before, judged on the same common
evaluation set and against the same production column.

Then the model that would ship: coefficients fitted once on 2019-22 and
frozen, judged on 2023-26 (how the 2026-10-02 activity weights were
validated), and the final fit on everything, for day-zones.mjs.
"""
import json, time, warnings
import numpy as np, pandas as pd
from sklearn.linear_model import QuantileRegressor
from stats_util import nw_mean
from zone_methods import OUT, SPLIT, TRACKED

warnings.filterwarnings("ignore")
QR_EVERY, QR_MIN = 91, 365
DOW = [f"dow{k}" for k in range(6)]
SETS = {
    "const (recalibrated median)": [],
    "vol": ["x_vol"],
    "vol+volume+move (production's inputs, fitted)": ["x_vol", "x_q", "x_move"],
    "+ last week": ["x_vol", "x_q", "x_move", "x7"],
    "+ last week + tail gap": ["x_vol", "x_q", "x_move", "x7", "xgap"],
    "+ last week + tail gap + yesterday": ["x_vol", "x_q", "x_move", "x7", "xgap", "x1"],
    "+ last week + tail gap + weekday": ["x_vol", "x_q", "x_move", "x7", "xgap"] + DOW,
    "all (score.py's qr_pooled)": ["x_vol", "x_q", "x_move", "x7", "xgap", "x1"] + DOW,
}
SIDE = {"U": ("x_u1", "x_u7", "x_gapU", "medU"), "D": ("x_d1", "x_d7", "x_gapD", "medD")}


def frame(A, side):
    f1, f7, fg, med = SIDE[side]
    B = A.assign(x1=A[f1], x7=A[f7], xgap=A[fg], med=A[med])
    B["y"] = np.log(np.maximum(B[side], 0.02 * B.med) / B.med)
    return B


def fit(B, cols, exact=False):
    """Median regression. statsmodels' IRLS with a tight tolerance: on the
    2019-23 pooled fit of every input it matched the exact linear program
    (HiGHS, exact=True) to 1e-4 in every coefficient, 19x faster."""
    if not cols: return float(np.median(B.y)), np.zeros(0)
    X = B[cols].values
    if exact:
        m = QuantileRegressor(quantile=0.5, alpha=0.0, solver="highs").fit(X, B.y.values)
        return float(m.intercept_), m.coef_
    import statsmodels.api as sm
    b = sm.QuantReg(B.y.values, np.c_[np.ones(len(X)), X]).fit(q=0.5, max_iter=5000, p_tol=1e-8).params
    return float(b[0]), b[1:]


def predict(B, cols, b):
    X = B[cols].values if cols else np.zeros((len(B), 0))
    return B.med.values * np.exp(b[0] + X @ b[1])


if __name__ == "__main__":
    A = pd.read_pickle(f"{OUT}/zone_scored.pkl")
    ok_cols = ["x_vol", "x_q", "x_move", "medU", "medD", "x_u1", "x_u7", "x_gapU", "x_d1", "x_d7", "x_gapD"]
    A = A[A[ok_cols].notna().all(1)].copy()
    common = A[[c for c in A.columns if "|" in c]].notna().all(1)
    refits = pd.date_range("2018-12-31", A.date.max() + pd.Timedelta(days=1), freq=f"{QR_EVERY}D")
    t0 = time.time()
    pred = {}
    for name, cols in SETS.items():
        for side in ("U", "D"):
            B = frame(A, side)
            p = pd.Series(np.nan, index=B.index)
            for r0, r1 in zip(refits[:-1], refits[1:]):
                tr = B[B.date < r0]; te = B[(B.date >= r0) & (B.date < r1)]
                if len(te) == 0 or tr.date.nunique() < QR_MIN: continue
                p[te.index] = predict(te, cols, fit(tr, cols))
            pred[(name, side)] = p
        print(f"   {name}: {time.time() - t0:.0f}s", flush=True)

    S = A[common].copy()
    ref = (S.U - S["median|U|0.5"]).abs() + (S.D - S["median|D|0.5"]).abs()
    print(f"\n## Walk-forward (pooled, refit every 91 days), exact median regression. MAE vs production, mean over coins; NW t of the paired difference")
    print(f"   {'inputs':48s} | 2019-22 MAE    t  inside U/D | 2023-26 MAE    t  inside U/D")
    for name in SETS:
        pu, pdn = pred[(name, "U")][S.index], pred[(name, "D")][S.index]
        L = (S.U - pu).abs() + (S.D - pdn).abs()
        cells = []
        for per, m in (("A", S.date < SPLIT), ("B", S.date >= SPLIT)):
            ratio = np.mean([L[m & (S.sym == s)].mean() / ref[m & (S.sym == s)].mean() for s in S[m].sym.unique()])
            d = (L[m] - ref[m]).groupby(S.date[m]).sum()
            cells.append(f"{ratio:.3f} {nw_mean(d.values)[1]:+5.1f}  {(S.U[m] <= pu[m]).mean():.2f}/{(S.D[m] <= pdn[m]).mean():.2f}")
        print(f"   {name:48s} | " + " | ".join(cells))

    # The candidate to ship: frozen coefficients fitted on 2019-22, judged on 2023-26
    print("\n## Frozen: fitted once on every coin-day before 2023, judged on 2023-26 (and on HYPE, which no walk-forward set held)")
    frozen = {}
    for name in ("+ last week + tail gap + weekday", "+ last week + tail gap", "all (score.py's qr_pooled)"):
        cols = SETS[name]
        L = 0
        out = {}
        for side in ("U", "D"):
            B = frame(A, side)
            b = fit(B[B.date < SPLIT], cols)
            out[side] = predict(B, cols, b)
            frozen[(name, side)] = b
        Bm = A.date >= SPLIT
        sub = A[Bm & common]
        Lf = (sub.U - pd.Series(out["U"], index=A.index)[sub.index]).abs() + (sub.D - pd.Series(out["D"], index=A.index)[sub.index]).abs()
        Lr = (sub.U - sub["median|U|0.5"]).abs() + (sub.D - sub["median|D|0.5"]).abs()
        ratio = np.mean([Lf[sub.sym == s].mean() / Lr[sub.sym == s].mean() for s in sub.sym.unique()])
        t = nw_mean((Lf - Lr).groupby(sub.date).sum().values)[1]
        per_coin = {s: round(Lf[sub.sym == s].mean() / Lr[sub.sym == s].mean(), 3) for s in sub.sym.unique()}
        H = A[(A.sym == "HYPE") & A["median|U|0.5"].notna()]
        Lh = (H.U - pd.Series(out["U"], index=A.index)[H.index]).abs() + (H.D - pd.Series(out["D"], index=A.index)[H.index]).abs()
        Lhr = (H.U - H["median|U|0.5"]).abs() + (H.D - H["median|D|0.5"]).abs()
        print(f"   {name}: 2023-26 {ratio:.3f} (t {t:+.1f}); per coin {per_coin}; HYPE {Lh.mean() / Lhr.mean():.3f} over {len(H)} days")

    # Final coefficients on everything, for the live model
    final = {}
    for name in ("+ last week + tail gap + weekday", "+ last week + tail gap"):
        cols = SETS[name]
        final[name] = {}
        for side in ("U", "D"):
            B = frame(A, side)
            b0, b1 = fit(B, cols, exact=True)      # the shipped coefficients: the exact solution
            fa = fit(B[B.date < SPLIT], cols, exact=True)
            final[name][side] = {"const": float(b0), **{c: float(v) for c, v in zip(cols, b1)},
                                 "fitted_2019_22": {"const": float(fa[0]), **{c: float(v) for c, v in zip(cols, fa[1])}},
                                 "rows": int(len(B)), "through": str(B.date.max().date())}
    json.dump(final, open(f"{OUT}/qr_final.json", "w"), indent=1)
    print("\n## Final coefficients (all coin-days), median regression of log(move / 60-day median):")
    for name, sides in final.items():
        for side, c in sides.items():
            print(f"   {name} {side}: " + ", ".join(f"{k} {v:+.4f}" for k, v in c.items() if not isinstance(v, (dict, str)) and k != "rows"))
            print(f"      (2019-22 only: " + ", ".join(f"{k} {v:+.4f}" for k, v in c["fitted_2019_22"].items()) + ")")
