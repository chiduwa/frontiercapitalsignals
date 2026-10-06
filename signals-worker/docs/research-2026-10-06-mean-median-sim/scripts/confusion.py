"""Precision, recall/sensitivity, specificity and negative predictive value
for the tournament's direction models (direction_walkforward.py output), and
whether learning from them would pick better models per asset.

A direction model says P(up). To get a confusion matrix it must be turned
into a call, so every metric depends on the threshold:
  at 0.5   "up" when P(up) > 0.5 -- how a trader would read it
  at base  "up" when P(up) > the asset's training up-rate -- what the model
           knows beyond the drift (a no-skill model calls nothing either way)
From the four counts:
  precision (PPV)   when it said up, how often up      -> lift = PPV - P(up)
  NPV               when it said down, how often down  -> lift = NPV - P(down)
  sensitivity (TPR) share of up days it called up
  specificity (TNR) share of down days it called down
  informedness J = TPR + TNR - 1 and markedness = PPV + NPV - 1: both 0 for
  ANY no-skill model at ANY threshold, which is why they are the honest
  summaries; MCC = their signed geometric mean.
Plus the Brier skill the tournament already uses, and money: the mean
signed return of trading every call long or short (gross, %).

Tests, each split at 2025-04-01 into an earlier and a later half:
  1. Is there skill? (mean J, markedness, Brier skill, money; vs zero)
  2. Do the metrics PERSIST from the earlier half to the later one, per
     asset and model? Sensitivity and specificity can persist simply because
     a model keeps calling "up" a lot -- that is the threshold, not skill.
  3. Selection: per asset, pick the model that was best in the earlier half
     by each metric, and score that pick in the later half.
  4. One-sided skill: does a model that was good only at "up" calls (or only
     at "down" calls) stay that way?
"""
import os, sys
import numpy as np, pandas as pd
from scipy.stats import spearmanr
from stats_util import nw_mean

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
OUT = os.environ.get("TOUR_OUT", os.path.join(ROOT, "reports", "confusion"))
SPLIT = "2025-04-01"
BASE = "direction:baseRate:7df30028"


def cm(df, thr):
    """Confusion metrics for one cell. thr: 'half' or 'base'."""
    up = (df.ret > 0).values
    call = (df.pUp > (0.5 if thr == "half" else df.base)).values
    tp, fp = int((call & up).sum()), int((call & ~up).sum())
    tn, fn = int((~call & ~up).sum()), int((~call & up).sum())
    n = len(df); pi = up.mean() if n else np.nan
    div = lambda a, b: a / b if b else np.nan
    ppv, npv, tpr, tnr = div(tp, tp + fp), div(tn, tn + fn), div(tp, tp + fn), div(tn, tn + fp)
    mcc_den = np.sqrt(float((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn)))
    sign = np.where(call, 1.0, -1.0)
    return dict(n=n, pi=pi, callUp=call.mean(), nUp=tp + fp, nDown=tn + fn, ppv=ppv, npv=npv, tpr=tpr, tnr=tnr,
                ppvLift=ppv - pi if np.isfinite(ppv) else np.nan, npvLift=npv - (1 - pi) if np.isfinite(npv) else np.nan,
                J=tpr + tnr - 1 if np.isfinite(tpr) and np.isfinite(tnr) else np.nan,
                mark=ppv + npv - 1 if np.isfinite(ppv) and np.isfinite(npv) else np.nan,
                mcc=(tp * tn - fp * fn) / mcc_den if mcc_den else np.nan,
                acc=(tp + tn) / n if n else np.nan,
                f1=div(2 * tp, 2 * tp + fp + fn),
                brier=float(np.mean((df.pUp.values - up) ** 2)),
                ls=float(np.mean(sign * df.ret.values)))


def cells(F, thr):
    rows = []
    for (sym, cls, h, model, half), g in F.groupby(["sym", "cls", "h", "model", "half"]):
        rows.append(dict(sym=sym, cls=cls, h=h, model=model, half=half, **cm(g, thr)))
    C = pd.DataFrame(rows)
    b = C[C.model == BASE].set_index(["sym", "h", "half"]).brier
    C["bss"] = 1 - C.brier / C.set_index(["sym", "h", "half"]).index.map(b).values
    return C


if __name__ == "__main__":
    F = pd.read_pickle(f"{OUT}/direction_wf.pkl")
    F = F[F.date >= F.groupby(["sym", "h"]).date.transform("min")]
    F["half"] = np.where(F.date < SPLIT, "early", "late")
    label = F.drop_duplicates("model").set_index("model").label
    print(f"{len(F):,} walk-forward forecasts, {F.sym.nunique()} assets ({(F.drop_duplicates('sym').cls == 'crypto').sum()} crypto), "
          f"{F.model.nunique()} models, {F.date.min()} .. {F.date.max()}; split at {SPLIT}")
    print("   horizons: " + ", ".join(f"{c} {h}: {len(g):,}" for (c, h), g in F.groupby(["cls", "h"])))

    for thr in ("half", "base"):
        C = cells(F, thr)
        C.to_csv(f"{OUT}/cells_{thr}.csv", index=False)
        print(f"\n######## threshold: {'P(up) > 0.5' if thr == 'half' else 'P(up) > training up-rate'} ########")

        print("\n## 1. Skill, mean over asset x model cells (excluding the base rate), earlier | later half")
        for (cls, h), g in C[C.model != BASE].groupby(["cls", "h"]):
            parts = []
            for half in ("early", "late"):
                s = g[g.half == half]
                parts.append(f"P(up) {s.pi.mean():.3f}, calls up {s.callUp.mean():.2f}, PPV {s.ppv.mean():.3f} (lift {s.ppvLift.mean():+.3f}), "
                             f"NPV {s.npv.mean():.3f} (lift {s.npvLift.mean():+.3f}), sens {s.tpr.mean():.2f}, spec {s.tnr.mean():.2f}, "
                             f"J {s.J.mean():+.3f}, mark {s.mark.mean():+.3f}, Brier skill {s.bss.mean():+.4f}, long/short {s.ls.mean():+.3f}%")
            print(f"   {cls} {h}d\n      early: {parts[0]}\n      late:  {parts[1]}")

        print("\n## 2. Persistence earlier -> later, same asset and model (Spearman across cells; 0 = none)")
        W = C[C.model != BASE].pivot_table(index=["sym", "cls", "h", "model"], columns="half",
                                           values=["ppv", "npv", "tpr", "tnr", "ppvLift", "npvLift", "J", "mark", "mcc", "acc", "f1", "bss", "ls", "callUp"])
        for (cls, h), g in W.groupby(level=["cls", "h"]):
            out = []
            for m in ("callUp", "tpr", "tnr", "ppv", "npv", "ppvLift", "npvLift", "J", "mark", "mcc", "acc", "bss", "ls"):
                a, b = g[(m, "early")], g[(m, "late")]
                ok = a.notna() & b.notna()
                r = spearmanr(a[ok], b[ok]).statistic if ok.sum() > 10 else np.nan
                out.append(f"{m} {r:+.2f}")
            print(f"   {cls} {h}d ({len(g)} cells): " + ", ".join(out))
        print("   within asset (each asset's models ranked against each other, then averaged):")
        for (cls, h), g in W.groupby(level=["cls", "h"]):
            out = []
            for m in ("tpr", "tnr", "ppvLift", "npvLift", "J", "mark", "bss", "ls"):
                rs = []
                for sym, gs in g.groupby(level="sym"):
                    a, b = gs[(m, "early")], gs[(m, "late")]
                    ok = a.notna() & b.notna()
                    if ok.sum() >= 8: rs.append(spearmanr(a[ok], b[ok]).statistic)
                rs = np.array([x for x in rs if np.isfinite(x)])
                out.append(f"{m} {rs.mean():+.2f} (t {rs.mean() / (rs.std(ddof=1) / np.sqrt(len(rs))):+.1f})" if len(rs) > 3 else f"{m} n/a")
            print(f"   {cls} {h}d: " + ", ".join(out))

        print("\n## 3. Selection: each asset's best model on the earlier half by a metric, scored on the later half")
        print("   (needs >= 20 calls each way in the earlier half for PPV/NPV-based picks; later-half Brier skill vs the base rate,")
        print("    informedness J, and the long/short return of its calls, % per call; t over assets)")
        for (cls, h), g in C.groupby(["cls", "h"]):
            E, L = g[g.half == "early"].set_index(["sym", "model"]), g[g.half == "late"].set_index(["sym", "model"])
            res = []
            for crit, better in (("bss", max), ("acc", max), ("ppvLift", max), ("npvLift", max), ("tpr", max), ("tnr", max),
                                 ("J", max), ("mark", max), ("mcc", max), ("f1", max), ("ls", max)):
                picks = []
                for sym, es in E.groupby(level="sym"):
                    es = es.droplevel("sym")
                    if crit in ("ppvLift", "npvLift", "J", "mark", "mcc", "f1"):
                        es = es[(es.nUp >= 20) & (es.nDown >= 20)]
                    es = es[es[crit].notna()]
                    if es.empty: continue
                    m = es[crit].idxmax()
                    if (sym, m) in L.index: picks.append(L.loc[(sym, m)])
                P = pd.DataFrame(picks)
                if P.empty: continue
                t = lambda x: x.mean() / (x.std(ddof=1) / np.sqrt(x.notna().sum())) if x.notna().sum() > 2 else np.nan
                res.append(f"      by {crit:8s} ({len(P):2d} assets): Brier skill {P.bss.mean():+.4f} (t {t(P.bss):+.1f}), J {P.J.mean():+.3f} (t {t(P.J):+.1f}), "
                           f"long/short {P.ls.mean():+.3f}% (t {t(P.ls):+.1f})")
            print(f"   {cls} {h}d:\n" + "\n".join(res))

        # PPV - P(up) = (TP.TN - FP.FN) / (n (TP+FP)) and NPV - P(down) = (TP.TN - FP.FN) / (n (TN+FN)):
        # one numerator, so the two lifts ALWAYS share a sign. "Good at up calls, bad at down calls"
        # against the base rate cannot happen; checked on every cell here. What can differ is money:
        # the long side (up calls' return over the asset's average) vs the short side.
        same = (np.sign(C.ppvLift) == np.sign(C.npvLift)) | (C.ppvLift.abs() < 1e-12) | C.ppvLift.isna() | C.npvLift.isna()
        print(f"\n## 4. One-sided skill. PPV lift and NPV lift share a sign in {same.mean():.1%} of {len(C)} cells (an identity), so it is checked in money:")
        print("   long side = mean return on up calls - the asset's mean return; short side = the asset's mean - mean on down calls (%); rank corr earlier -> later")
        sides = []
        for (sym, cls, h, model, half), g in F.groupby(["sym", "cls", "h", "model", "half"]):
            call = g.pUp > (0.5 if thr == "half" else g.base)
            if call.sum() >= 20 and (~call).sum() >= 20:
                sides.append(dict(sym=sym, cls=cls, h=h, model=model, half=half,
                                  long=g.ret[call].mean() - g.ret.mean(), short=g.ret.mean() - g.ret[~call].mean()))
        Sd = pd.DataFrame(sides).pivot_table(index=["sym", "cls", "h", "model"], columns="half", values=["long", "short"])
        for (cls, h), g in Sd.groupby(level=["cls", "h"]):
            ok = g.notna().all(1); g = g[ok]
            a, b = g[("long", "early")] - g[("short", "early")], g[("long", "late")] - g[("short", "late")]
            print(f"   {cls} {h}d ({len(g)} cells): long side {spearmanr(g[('long', 'early')], g[('long', 'late')]).statistic:+.2f}, "
                  f"short side {spearmanr(g[('short', 'early')], g[('short', 'late')]).statistic:+.2f}, "
                  f"long minus short {spearmanr(a, b).statistic:+.2f}")

        print("\n## 3b. The best-looking picks again, with calls on the same day pooled (coins move together) and costs")
        print("   per date: mean signed return of the picked models' calls across assets; Newey-West t over dates; cost 0.1% a side")
        print("   charged whenever a call flips (crypto) -- stocks are shown gross")
        for (cls, h), g in C.groupby(["cls", "h"]):
            E = g[g.half == "early"].set_index(["sym", "model"])
            for crit in ("bss", "J", "mark", "mcc", "npvLift"):
                picks = {}
                for sym, es in E.groupby(level="sym"):
                    es = es.droplevel("sym")
                    if crit != "bss": es = es[(es.nUp >= 20) & (es.nDown >= 20)]
                    es = es[es[crit].notna()]
                    if not es.empty: picks[sym] = es[crit].idxmax()
                Lf = F[(F.cls == cls) & (F.h == h) & (F.half == "late")]
                Lf = Lf.merge(pd.DataFrame(list(picks.items()), columns=["sym", "model"]), on=["sym", "model"]).sort_values(["sym", "date"])
                sign = np.where(Lf.pUp > (0.5 if thr == "half" else Lf.base), 1.0, -1.0)
                flip = pd.Series(sign, index=Lf.index).groupby(Lf.sym).diff().fillna(2).abs() > 0
                gross = sign * Lf.ret.values
                net = gross - (0.2 * flip.values if cls == "crypto" else 0)
                pg = pd.Series(gross, index=Lf.index).groupby(Lf.date).mean()
                pn = pd.Series(net, index=Lf.index).groupby(Lf.date).mean()
                mg, tg, n = nw_mean(pg.values); mn, tn_, _ = nw_mean(pn.values)
                print(f"   {cls} {h}d by {crit:8s}: {n} dates, gross {mg:+.3f}% (t {tg:+.1f}), net {mn:+.3f}% (t {tn_:+.1f}), calls flip {flip.mean():.0%}")
