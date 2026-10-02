"""The decisive test: the big-move watch's own LightGBM, walked forward, with
and without the category features. Same hyperparameters, same median fill,
same label (>= 12% within two days), same training rule (labels matured by
the forecast close). Refit every 30 days (production refits daily; the
comparison is like for like). Scored as production scores itself: the day's
top 10 against what every coin did over the same two days.
"""
import os, sys, json
import numpy as np, pandas as pd
import lightgbm as lgb
from contagion import bmw, OUT, NEW
from rot_panel import WORK
from stats_util import nw_mean

HERE = os.path.dirname(os.path.abspath(__file__))
VARIANTS = {
    "watch": list(bmw.FEATS),
    "watch+category": list(bmw.FEATS) + ["catVolRatio", "catAbsR1", "catBig1", "catR5", "relCatR5", "catVolExp", "catBurst"],
    "watch+catVolume": list(bmw.FEATS) + ["catVolRatio", "catAbsR1"],
}
REFIT_DAYS = 30
TOP = 10


def model():
    return lgb.LGBMClassifier(n_estimators=300, num_leaves=15, learning_rate=0.03, min_child_samples=200, subsample=0.8,
                              subsample_freq=1, colsample_bytree=0.8, verbose=-1, n_jobs=-1, random_state=7)


def main():
    D = pd.read_pickle(OUT)
    D = D[D.date >= "2021-03-01"].reset_index(drop=True)
    days = sorted(D.date.unique())
    start = pd.Timestamp("2022-01-01")
    refits = [t for t in days if t >= start][::REFIT_DAYS]
    hits = {v: {} for v in VARIANTS}
    base = {}
    aucs = {v: [] for v in VARIANTS}
    for i, t0 in enumerate(refits):
        t1 = refits[i + 1] if i + 1 < len(refits) else pd.Timestamp("2026-10-02")
        train = (D.date <= t0 - pd.Timedelta(days=bmw.HORIZON_DAYS)) & np.isfinite(D.fwd2)
        test = (D.date >= t0) & (D.date < t1) & np.isfinite(D.fwd2)
        y = (D.loc[train, "fwd2"].abs() >= bmw.BIG).astype(int)
        T = D.loc[test, ["date", "symbol", "fwd2"]].copy()
        T["big"] = (T.fwd2.abs() >= bmw.BIG).astype(int)
        for v, feats in VARIANTS.items():
            X = D[feats].replace([np.inf, -np.inf], np.nan)
            med = X[train].median()
            m = model().fit(X[train].fillna(med), y)
            T[v] = m.predict_proba(X[test].fillna(med))[:, 1]
        for day, g in T.groupby("date"):
            if len(g) < bmw.MIN_COINS_PER_DAY: continue
            base[day] = g.big.mean()
            for v in VARIANTS:
                hits[v][day] = g.nlargest(TOP, v).big.mean()
        print(f"refit {t0.date()} train {int(train.sum()):,} test days {T.date.nunique()} "
              + " ".join(f"{v}={np.mean([hits[v][d] for d in T.date.unique() if d in hits[v]]):.3f}" for v in VARIANTS), flush=True)
    H = pd.DataFrame(hits); H["base"] = pd.Series(base)
    H.index = pd.to_datetime(H.index)
    H.to_csv(os.path.join(WORK, "contagion_wf_daily.csv"))
    print("\n## 7. Walk-forward, the watch's own model: share of the day's top 10 that moved >= 12% within two days")
    print(f"   {len(H)} days, {H.index.min().date()}..{H.index.max().date()}; base = every coin, same days")
    for v in VARIANTS: print(f"   {v:18s} {H[v].mean():.1%}  (lift {H[v].mean() / H.base.mean():.2f}x)")
    print(f"   base               {H.base.mean():.1%}")
    for v in [x for x in VARIANTS if x != "watch"]:
        dlt = H[v] - H["watch"]
        b, t, n = nw_mean(dlt.values, lags=5)
        print(f"   {v} minus watch: {b * 100:+.2f} pp/day, t {t:+.2f} (n {n} days; overlapping two-day labels, 5 NW lags)")
        hy = dlt.groupby([dlt.index.year, (dlt.index.month > 6)]).mean() * 100
        print("     by half-year (pp): " + " ".join(f"{y}{'H2' if h else 'H1'} {x:+.1f}" for (y, h), x in hy.items()))
        print(f"     half-years better / worse: {(hy > 0).sum()} / {(hy < 0).sum()}")


if __name__ == "__main__":
    main()
