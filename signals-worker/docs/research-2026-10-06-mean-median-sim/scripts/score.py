"""Scores zone_methods.py's forecasts, after adding the two learned models
(quantile regressions, which need every coin's rows at once).

Output sections:
  1. every method vs production (the 60-day median), both periods: MAE, MSE,
     CRPS (pinball at 10/25/50/75/90), calibration of the median level
  2. paired difference vs production, date-clustered (Newey-West) t
  3. per coin: which method wins where, and does the per-coin choice made on
     one period hold on the next?
"""
import os, sys, time, warnings
import numpy as np, pandas as pd
from stats_util import nw_mean
from zone_methods import OUT, TAUS, SPLIT, TRACKED

warnings.filterwarnings("ignore")
QR_EVERY = 91
QR_MIN = 365
FEATS = ["x_vol", "x_q", "x_move", "x1", "x7", "xgap"] + [f"dow{k}" for k in range(6)]


def qr_fit_predict(train, test, side):
    import statsmodels.api as sm
    def X(df):
        return np.c_[np.ones(len(df)), df[FEATS].values]
    med = train[f"med{side}"].values
    y = np.log(np.maximum(train[side].values, 0.02 * med) / med)
    out = np.zeros((len(test), len(TAUS)))
    for i, t in enumerate(TAUS):
        b = sm.QuantReg(y, X(train)).fit(q=t, max_iter=2000).params
        out[:, i] = test[f"med{side}"].values * np.exp(X(test) @ b)
    return np.sort(out, axis=1), b


def add_qr(A):
    """qr_pooled: all coins' rows before each refit date; qr_coin: the coin's own."""
    A = A.sort_values(["date", "sym"]).reset_index(drop=True)
    for k in range(6): A[f"dow{k}"] = (A.dow == k).astype(float)
    side_feats = {"U": ("x_u1", "x_u7", "x_gapU"), "D": ("x_d1", "x_d7", "x_gapD")}
    ok = A[["x_vol", "x_q", "x_move", "medU", "medD"] + [c for v in side_feats.values() for c in v]].notna().all(1)
    refits = pd.date_range("2018-12-31", A.date.max() + pd.Timedelta(days=1), freq=f"{QR_EVERY}D")
    coef = []
    for side, (f1, f7, fg) in side_feats.items():
        B = A.assign(x1=A[f1], x7=A[f7], xgap=A[fg])
        for kind in ("qr_pooled", "qr_coin"):
            for t in TAUS: A[f"{kind}|{side}|{t}"] = np.nan
            groups = [(None, B)] if kind == "qr_pooled" else list(B.groupby("sym"))
            for sym, G in groups:
                gok = ok.loc[G.index]
                for r0, r1 in zip(refits[:-1], refits[1:]):
                    train = G[gok & (G.date < r0)]
                    test = G[gok & (G.date >= r0) & (G.date < r1)]
                    if len(test) == 0 or train.date.nunique() < QR_MIN: continue
                    q, b = qr_fit_predict(train, test, side)
                    for i, t in enumerate(TAUS): A.loc[test.index, f"{kind}|{side}|{t}"] = q[:, i]
                    if kind == "qr_pooled": coef.append({"side": side, "refit": r0.date(), **dict(zip(["const"] + FEATS, np.round(b, 4)))})
            print(f"   {kind} {side} done", flush=True)
    return A, pd.DataFrame(coef)


def methods(A):
    return sorted({c.split("|")[0] for c in A.columns if "|" in c})


def losses(A, m):
    qU = A[[f"{m}|U|{t}" for t in TAUS]].values; qD = A[[f"{m}|D|{t}" for t in TAUS]].values
    U, D = A.U.values[:, None], A.D.values[:, None]
    pin = lambda y, q: np.where(y >= q, TAUS * (y - q), (1 - TAUS) * (q - y))
    return pd.DataFrame({
        "mae": np.abs(A.U - qU[:, 2]) + np.abs(A.D - qD[:, 2]),
        "mse": (A.U - qU[:, 2]) ** 2 + (A.D - qD[:, 2]) ** 2,
        "crps": (pin(U, qU) + pin(D, qD)).mean(1),
        "inU": (A.U <= qU[:, 2]).astype(float), "inD": (A.D <= qD[:, 2]).astype(float),
        "band80": (((A.U <= qU[:, 4]) & (A.U >= qU[:, 0])).astype(float) + ((A.D <= qD[:, 4]) & (A.D >= qD[:, 0])).astype(float)) / 2,
    }, index=A.index)


def paired_t(A, L, Lref, col):
    d = (L[col] - Lref[col]).groupby(A.date).sum()
    m, t, n = nw_mean(d.values)
    return t


if __name__ == "__main__":
    A = pd.read_pickle(f"{OUT}/zone_methods.pkl")
    t0 = time.time()
    A, coef = add_qr(A)
    print(f"quantile regressions {time.time() - t0:.0f}s")
    A.to_pickle(f"{OUT}/zone_scored.pkl")
    coef.to_csv(f"{OUT}/qr_coefficients.csv", index=False)
    M = methods(A)
    allok = np.ones(len(A), bool)
    for m in M: allok &= A[[c for c in A.columns if c.startswith(m + "|")]].notna().all(1).values
    S = A[allok].copy()
    S["period"] = np.where(S.date < SPLIT, "A 2019-22", "B 2023-26")
    print(f"\ncommon evaluation set: {len(S):,} coin-days ({S.date.min().date()} .. {S.date.max().date()}); "
          + ", ".join(f"{s} {int((S.sym == s).sum())}" for s in TRACKED))
    L = {m: losses(S, m) for m in M}
    ref = L["median"]
    print("\n## 1-2. Each method relative to production (60-day median x vol scale x activity). <1 = better.")
    print("   ratios are the mean over coins of (method loss / production loss); t = paired difference, date-clustered NW (negative = better)")
    hdr = f"   {'method':12s} " + " ".join(f"| {p:9s} MAE   t     MSE   t     CRPS  t    in-U/in-D band80 " for p in ("A 2019-22", "B 2023-26"))
    print(hdr)
    summary = []
    for m in M:
        cells = []
        for p in ("A 2019-22", "B 2023-26"):
            sel = (S.period == p).values
            Sp = S[sel]
            r = {}
            for col in ("mae", "mse", "crps"):
                per = [(L[m][col][sel][Sp.sym == s].mean() / ref[col][sel][Sp.sym == s].mean()) for s in Sp.sym.unique()]
                r[col] = (np.mean(per), paired_t(Sp, L[m][sel], ref[sel], col))
            cal = (L[m]["inU"][sel].mean(), L[m]["inD"][sel].mean(), L[m]["band80"][sel].mean())
            cells.append(f"| {r['mae'][0]:.3f} {r['mae'][1]:+5.1f} {r['mse'][0]:.3f} {r['mse'][1]:+5.1f} {r['crps'][0]:.3f} {r['crps'][1]:+5.1f}  {cal[0]:.2f}/{cal[1]:.2f}  {cal[2]:.2f}  ")
            summary.append({"method": m, "period": p, **{f"{k}_ratio": v[0] for k, v in r.items()}, **{f"{k}_t": v[1] for k, v in r.items()},
                            "inU": cal[0], "inD": cal[1], "band80": cal[2]})
        print(f"   {m:12s} " + " ".join(cells))
    pd.DataFrame(summary).to_csv(f"{OUT}/summary.csv", index=False)

    print("\n## 3. Per coin, MAE ratio vs production (A = 2019-22, B = 2023-26; B1 = 2023-24, B2 = 2025-26)")
    S["half"] = np.where(S.date < SPLIT, "A", np.where(S.date < pd.Timestamp("2025-01-01"), "B1", "B2"))
    S["halfB"] = np.where(S.date < SPLIT, "A", "B")
    tab = {}
    for m in M:
        for s in TRACKED:
            for h in ("A", "B1", "B2"):
                sel = ((S.sym == s) & (S.half == h)).values
                if sel.sum() < 100: continue
                tab[(m, s, h)] = L[m]["mae"][sel].mean() / ref["mae"][sel].mean()
    T = pd.Series(tab).unstack([1, 2])
    with pd.option_context("display.width", 250, "display.max_columns", 40, "display.float_format", "{:.3f}".format):
        print(T)
    T.to_csv(f"{OUT}/per_coin_mae.csv")
    print("\n   per-coin choice: pick each coin's best method on the earlier period, score it on the later one")
    for early, late in (("A", "B1"), ("A", "B2"), ("B1", "B2")):
        rows = []
        for s in TRACKED:
            if (s, early) not in T.columns or (s, late) not in T.columns: continue
            col_e, col_l = T[(s, early)].dropna(), T[(s, late)].dropna()
            best = col_e.idxmin()
            rows.append((s, best, col_e[best], col_l.get(best, np.nan)))
        if not rows: continue
        late_mean = np.nanmean([r[3] for r in rows])
        print(f"   {early} -> {late}: " + ", ".join(f"{s} {b} ({e:.3f} -> {l:.3f})" for s, b, e, l in rows) + f"  | mean on {late}: {late_mean:.3f}")
