"""How much of a big two-day move is over before the big-move watch's digest
arrives? The watch ranks at the 00:00 UTC close; its digest has gone out
between 08:45 and 09:42 UTC (big_move_watch_runs.notified_at, 2026-09-25..
10-02), because it waits for Signals Daily.

On hourly Binance spot (2024-01..2026-08), using the watch's own top 10 per
day (the production model, walked forward with monthly refits), measure what
had already happened by each hour after the close:
  * the share of picks that had already moved >= 12% from the close
  * of the picks that did move >= 12% in two days, the share that got there
    before the digest
  * whether a >= 12% move FROM THE DIGEST PRICE still came within the window
"""
import os
import numpy as np, pandas as pd
import lightgbm as lgb
from contagion import bmw, OUT
from hourly import load_hourly
from rot_panel import load

HOURS = [1, 2, 4, 6, 10, 16, 24]


def picks():
    D = pd.read_pickle(OUT)
    D = D[D.date >= "2021-03-01"].reset_index(drop=True)
    days = sorted(D.date.unique())
    refits = [t for t in days if t >= pd.Timestamp("2024-01-01") and t < pd.Timestamp("2026-08-30")][::30]
    out = []
    for i, t0 in enumerate(refits):
        t1 = refits[i + 1] if i + 1 < len(refits) else pd.Timestamp("2026-08-30")
        train = (D.date <= t0 - pd.Timedelta(days=2)) & np.isfinite(D.fwd2)
        test = (D.date >= t0) & (D.date < t1)
        X = D[bmw.FEATS].replace([np.inf, -np.inf], np.nan); med = X[train].median()
        y = (D.loc[train, "fwd2"].abs() >= bmw.BIG).astype(int)
        m = lgb.LGBMClassifier(n_estimators=300, num_leaves=15, learning_rate=0.03, min_child_samples=200, subsample=0.8,
                               subsample_freq=1, colsample_bytree=0.8, verbose=-1, n_jobs=-1, random_state=7).fit(X[train].fillna(med), y)
        T = D.loc[test, ["date", "symbol", "fwd2"]].copy(); T["p"] = m.predict_proba(X[test].fillna(med))[:, 1]
        out.append(T.sort_values("p", ascending=False).groupby("date").head(10))
    return pd.concat(out)


def main():
    pk = picks()
    d = load()
    C, _ = load_hourly(set(pk.symbol))
    rows = []
    for r in pk.itertuples():
        t0 = r.date + pd.Timedelta(days=1)            # the daily bar dated D closes at D+1 00:00 UTC
        s = r.symbol
        if s not in C: continue
        path = C[s].loc[t0 - pd.Timedelta(hours=1): t0 + pd.Timedelta(hours=47)]   # 49 closes: the 00:00 close, then hours +1..+48
        if len(path) < 49 or not np.isfinite(path.iloc[0]) or path.isna().mean() > 0.1: continue
        c0 = path.iloc[0]
        rel = (path.iloc[1:] / c0 - 1).values           # hours +1..+48 (closes)
        rec = {"date": r.date, "symbol": s, "big2": abs(path.iloc[-1] / c0 - 1) >= 0.12}
        exc = np.nanmax(np.abs(rel[:48]))
        rec["reach48"] = exc >= 0.12
        for h in HOURS:
            rec[f"done{h}"] = np.nanmax(np.abs(rel[:h])) >= 0.12
            ch = path.iloc[h]
            rest = path.iloc[h + 1:] / ch - 1
            rec[f"after{h}"] = np.nanmax(np.abs(rest.values)) >= 0.12 if len(rest) else np.nan
            rec[f"close{h}"] = abs(path.iloc[-1] / ch - 1) >= 0.12
        rows.append(rec)
    T = pd.DataFrame(rows)
    print(f"## 9. Lateness: the watch's daily top 10, 2024-01..2026-08, {len(T):,} picks with a full hourly path")
    print(f"   picks that ended >= 12% from the close after 48h: {T.big2.mean():.1%}; touched +-12% at any hour within 48h: {T.reach48.mean():.1%}")
    big = T[T.reach48]
    print("   hour after the close  | already touched +-12% (all picks) | share of the eventual touches already done | a NEW +-12% from that hour's price within the rest of the 48h | close-to-close >= 12% from that hour")
    for h in HOURS:
        print(f"   +{h:2d}h                 | {T[f'done{h}'].mean():6.1%}                          | {big[f'done{h}'].mean():6.1%}                                    | {T[f'after{h}'].mean():6.1%}                                      | {T[f'close{h}'].mean():6.1%}")
    print("   (the digest has arrived at +9h to +10h)")


if __name__ == "__main__":
    main()
