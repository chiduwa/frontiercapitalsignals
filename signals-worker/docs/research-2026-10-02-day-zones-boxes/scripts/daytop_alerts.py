"""Section 2-3 of the day top/bottom study: every reference hour R, zone
multipliers k, real coins against random-sign copies of themselves."""
import sys
import numpy as np, pandas as pd
from daytop import DATA, hourly, windows, excursions, forecast, null_copy, TRACKED, SPLIT, NEAR
from stats_util import nw_mean

FC = dict(N=60, beta=0.5, weekday=True)            # the best forecast in section 1, both periods
KS = (0.75, 1.0, 1.25)
COPIES = 5


def touch(b, O, Uh, Dh, k, side, closes_only=False):
    h = b["c"] if closes_only else b["h"]
    l = b["c"] if closes_only else b["l"]
    c = b["c"]
    if side == "top":
        z = O * np.exp(k * Uh)
        hit = h >= z[:, None]
        rev = np.maximum.accumulate(h[:, ::-1], axis=1)[:, ::-1]
    else:
        z = O * np.exp(-k * Dh)
        hit = l <= z[:, None]
        rev = np.minimum.accumulate(l[:, ::-1], axis=1)[:, ::-1]
    ok = np.isfinite(z) & hit.any(1)
    i = np.argmax(hit, 1)
    r = np.arange(len(O))
    unit = Uh if side == "top" else Dh
    if side == "top":
        further = np.log(rev[r, i] / z); fade = np.log(z / c[:, -1])
    else:
        further = np.log(z / rev[r, i]); fade = np.log(c[:, -1] / z)
    return ok, i, further, fade, further <= NEAR * unit, unit


def stats(dates, ok, i, further, fade, near, unit, per):
    m = ok & ((dates < SPLIT) if per == "A" else (dates >= SPLIT))
    elig = np.isfinite(unit) & ((dates < SPLIT) if per == "A" else (dates >= SPLIT))
    if m.sum() < 20: return None
    return dict(rate=m.sum() / max(1, elig.sum()), n=int(m.sum()), further_u=np.median(further[m] / unit[m]),
                near=near[m].mean(), fade=fade[m], date=dates[m], hour=np.median(i[m]))


def run():
    data = {s: hourly(s) for s in TRACKED}
    nulls = {s: [null_copy(df, 100 + c) for c in range(COPIES)] for s, df in data.items()}
    rows = []
    for R in range(24):
        for sym, df in data.items():
            dates, b, pc = windows(df, R)
            U, D, O = excursions(b)
            Uh, Dh = forecast(U, D, pc, dates, **FC)
            Uh[:364] = np.nan; Dh[:364] = np.nan                         # the weekday factor needs a year
            nb = []
            for nd in nulls[sym]:
                nd_dates, nbk, npc = windows(nd, R)
                nU, nD, nO = excursions(nbk)
                nUh, nDh = forecast(nU, nD, npc, nd_dates, **FC)
                nUh[:364] = np.nan; nDh[:364] = np.nan
                nb.append((nd_dates, nbk, nO, nUh, nDh))
            for k in KS:
                for side in ("top", "bottom"):
                    real = touch(b, O, Uh, Dh, k, side)
                    realc = touch(b, O, Uh, Dh, k, side, closes_only=True)
                    for per in ("A", "B"):
                        s = stats(dates, *real, per)
                        sc = stats(dates, *realc, per)
                        if s is None or sc is None: continue
                        nn = [stats(nd_dates, *touch(nbk, nO, nUh, nDh, k, side, closes_only=True), per) for nd_dates, nbk, nO, nUh, nDh in nb]
                        nn = [x for x in nn if x]
                        rows.append(dict(R=R, sym=sym, k=k, side=side, per=per, rate=s["rate"], n=s["n"], further_u=s["further_u"],
                                         near=s["near"], fade_bp=np.mean(s["fade"]) * 1e4, hour=s["hour"],
                                         near_c=sc["near"], fade_c=np.mean(sc["fade"]) * 1e4, rate_c=sc["rate"],
                                         near_null=np.mean([x["near"] for x in nn]), fade_null=np.mean([np.mean(x["fade"]) for x in nn]) * 1e4,
                                         rate_null=np.mean([x["rate"] for x in nn]),
                                         _fade=pd.Series(s["fade"], index=s["date"])))
        print("R", R, "done", flush=True)
    return pd.DataFrame(rows)


if __name__ == "__main__":
    T = run()
    T.drop(columns=["_fade"]).to_csv(f"{DATA}/daytop_alerts.csv", index=False)
    pd.to_pickle(T, f"{DATA}/daytop_alerts.pkl")
