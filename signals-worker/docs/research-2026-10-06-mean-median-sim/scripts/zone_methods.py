"""Median vs mean vs simulation for today's forecast top and bottom (asked
2026-10-06: "for the part that we use the median to try estimating daily
movements, try using the mean, flaw of averages, simulation models, etc and
see if that predicts better so we use that (or maybe for specific assets)").

The quantity forecast is the same as the live day zones (scripts/day-zones.mjs):
for each always-tracked coin and UTC day, U = log(day high / 00:00 open) and
D = log(00:00 open / day low). Every method below forecasts U and D at the
open from data before it, and then gets the same two production adjustments
(the vol scale (last-24h vol / usual)^0.5 and the activity multiplier) unless
it models them itself, so the CENTRE estimate is what is being compared.

Methods (centre = what sits where production's 60-day median sits):
  median       production: median of the last 60 days
  mean         plain mean of the last 60 days
  trim10       10% trimmed mean
  geo          geometric mean (mean of logs)
  mean_cal     mean x k, k = the walk-forward MAE-optimal ratio (per coin, all
               earlier days): the mean's efficiency, the median's target
  median_cal   median x k, the same recalibration, so mean_cal is matched
  ewmed        recency-weighted median (half-life 20 days)
  bm_ewma24 / bm_ewma168 / bm_garch
               reflection principle: the max of a driftless Brownian motion
               over a day with volatility s has P(max > m) = 2 P(Z > m/s), so
               its median is 0.674 s. s from an EWMA of hourly returns
               (half-life 24h / 168h) or an hourly GARCH(1,1)-t; then
               calibrated by the same walk-forward k (raw also reported)
  mc_hour      Monte Carlo: 1,000 days built hour by hour, each hour drawn
               from that hour of a random day in the last 60 (keeps the
               time-of-day rhythm, assumes hours independent)
  mc_block6    the same in 6-hour blocks (keeps some within-day persistence)
  qr_pooled    learned: median (quantile) regression of log(U / 60-day median)
               on the vol ratio, 24h volume ratio, |yesterday's move|,
               yesterday's and last week's excursion, the mean/median gap
               (tail weight) and weekday; pooled over coins, refit every 91
               days on everything before
  qr_coin      the same regression fitted on the coin's own history only

Scores, judged separately in 2018-22 (A) and 2023-26 (B):
  MAE   |U - U^| + |D - D^| -- the loss the median is optimal for, and the
        one the 2026-10-02 study chose production by
  MSE   squared error -- the loss the MEAN is optimal for, so the mean gets a
        fair hearing
  CRPS  the whole forecast distribution scored at the 10/25/50/75/90th
        percentiles (average pinball loss): "the flaw of averages" -- is a
        distribution better than a single number?
  calib share of days the move stayed inside the level (50% is right for
        a median level)
Paired differences vs production are summed per date over coins, Newey-West t.
"""
import os, sys, time, json, warnings
import numpy as np, pandas as pd
from scipy.stats import norm
from stats_util import nw_mean

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))          # signals-worker
DATA = os.environ.get("DZ_DATA", os.path.join(ROOT, "reports", "day-zones"))
OUT = os.environ.get("MM_OUT", os.path.join(ROOT, "reports", "mean-median"))
os.makedirs(OUT, exist_ok=True)
TRACKED = ["BTC", "ETH", "SOL", "XLM", "XRP", "HYPE", "HBAR", "ARB"]
N = 60
VOLW, MOVEW = 0.04, 0.025          # day-zones-v2 activity weights (DAY_ZONE in day-zones.mjs)
SPLIT = pd.Timestamp("2023-01-01")
TAUS = np.array([0.1, 0.25, 0.5, 0.75, 0.9])
SIMS = 1000
CAL_MIN = 365                      # past days a walk-forward calibration needs
QR_EVERY = 91


def load(sym):
    z = np.load(f"{DATA}/h1/{sym}.npz")
    df = pd.DataFrame(z["s"][:, :5], index=pd.to_datetime(z["t"], unit="ms"), columns=["o", "h", "l", "c", "qv"])
    df = df[~df.index.duplicated()].sort_index()
    if sym != "HYPE": df = df[df.index >= "2018-01-01"]
    return df.reindex(pd.date_range(df.index[0], df.index[-1], freq="h"))


def wmedian(x, w):
    o = np.argsort(x); x, w = x[o], w[o]
    c = np.cumsum(w)
    return x[np.searchsorted(c, 0.5 * c[-1])]


def ewma_var(r, hl):
    """EWMA of squared hourly returns; value at t uses returns before t."""
    lam = 0.5 ** (1 / hl)
    r2 = np.where(np.isfinite(r), r * r, np.nan)
    out = np.full(len(r), np.nan)
    v, seen = np.nan, 0
    for t in range(len(r)):
        out[t] = v if seen > 3 * hl else np.nan
        x = r2[t]
        if np.isfinite(x):
            v = x if not np.isfinite(v) else lam * v + (1 - lam) * x
            seen += 1
    return out


def garch_day_var(r, starts, refit_days=30, window_h=180 * 24):
    """24-hour variance forecast at each start from an hourly GARCH(1,1)-t,
    parameters refit every 30 days on the 180 days before, filtered hour by
    hour in between (only returns before the start are used)."""
    from arch import arch_model
    out = np.full(len(starts), np.nan)
    rr = np.nan_to_num(r) * 100                      # rr[t] = log(c[t] / c[t-1]) x 100: bar t's return
    params, last_fit, v, pos = None, -10 ** 9, None, None
    for i, s in enumerate(starts):
        if s < window_h: continue
        if params is None or s - last_fit >= refit_days * 24:
            try:
                res = arch_model(rr[s - window_h:s], mean="Zero", vol="GARCH", p=1, q=1, dist="t", rescale=False).fit(disp="off", show_warning=False)
            except Exception:
                continue
            params = res.params[["omega", "alpha[1]", "beta[1]"]].values
            om, al, be = params
            v = om + al * rr[s - 1] ** 2 + be * float(res.conditional_volatility[-1]) ** 2   # variance of hour s
            pos, last_fit = s, s
        else:
            om, al, be = params
            while pos < s:                           # advance v from hour pos to hour s, one return at a time
                v = om + al * rr[pos] ** 2 + be * v
                pos += 1
        p = al + be
        vbar = om / (1 - p) if p < 0.999 else v
        out[i] = sum(vbar + p ** k * (v - vbar) for k in range(24)) / 1e4
    return out


def days(sym):
    df = load(sym)
    o, h, l, c, qv = (df[k].values for k in ("o", "h", "l", "c", "qv"))
    r = np.log(c / np.r_[np.nan, c[:-1]])              # hourly close-to-close
    starts = np.where(df.index.hour == 0)[0]
    starts = starts[(starts >= 25) & (starts + 24 <= len(df))]
    idx = starts[:, None] + np.arange(24)
    ok = np.isfinite(c[idx]).all(1) & np.isfinite(h[idx]).all(1) & np.isfinite(l[idx]).all(1) & np.isfinite(o[idx]).all(1)
    starts, idx = starts[ok], idx[ok]
    O = o[starts]
    U, D = np.log(h[idx].max(1) / O), np.log(O / l[idx].min(1))
    pidx = starts[:, None] - 25 + np.arange(25)
    sig = np.nanstd(np.diff(np.log(c[pidx]), axis=1), axis=1)
    q24 = pd.Series(qv).rolling(24, min_periods=20).sum().values[starts - 1]
    ret24 = np.log(O / c[starts - 25])
    # per-bar pieces for the bootstraps, relative to each bar's open
    br = np.log(c[idx] / o[idx]); bhx = np.log(h[idx] / o[idx]); blx = np.log(o[idx] / l[idx])
    dates = df.index[starts]
    e24, e168 = ewma_var(r, 24), ewma_var(r, 168)
    t0 = time.time()
    g = garch_day_var(r, starts)
    print(f"   {sym}: {len(starts)} days, GARCH {time.time() - t0:.0f}s", flush=True)
    return dict(sym=sym, dates=dates, U=U, D=D, O=O, sig=sig, q24=q24, ret24=ret24, br=br, bhx=bhx, blx=blx,
                s_e24=np.sqrt(24 * e24[starts]), s_e168=np.sqrt(24 * e168[starts]), s_g=np.sqrt(g))


def boot(br, bhx, blx, rng, block):
    """(SIMS,) simulated U and D from the 60 past days' bars."""
    nb = 24 // block
    pick = rng.integers(0, br.shape[0], size=(SIMS, nb))
    rows = np.repeat(pick, block, axis=1)
    cols = np.broadcast_to(np.arange(24), rows.shape)
    r, hx, lx = br[rows, cols], bhx[rows, cols], blx[rows, cols]
    P = np.c_[np.zeros(SIMS), np.cumsum(r, axis=1)[:, :-1]]
    return np.maximum(0, (P + hx).max(1)), np.maximum(0, (lx - P).max(1))


def forecasts(d, seed=7):
    """Quantile forecasts {method: (n, 5) for U, (n, 5) for D} at TAUS, plus
    features for the regressions. Row j uses days < j only."""
    U, D, n = d["U"], d["D"], len(d["U"])
    rng = np.random.default_rng(seed)
    meth = ["median", "mean", "trim10", "geo", "ewmed", "mc_hour", "mc_block6", "bm_ewma24", "bm_ewma168", "bm_garch"]
    QU = {m: np.full((n, 5), np.nan) for m in meth}; QD = {m: np.full((n, 5), np.nan) for m in meth}
    scale = np.full(n, np.nan); mult = np.full(n, np.nan)
    feat = {k: np.full(n, np.nan) for k in ("medU", "medD", "x_vol", "x_q", "x_move", "x_u1", "x_d1", "x_u7", "x_d7", "x_gapU", "x_gapD")}
    z = norm.ppf((1 + TAUS) / 2)                       # reflection-principle quantiles of the max, per unit s
    w_ew = 0.5 ** (np.arange(N)[::-1] / 20)            # newest last
    for j in range(N, n):
        u, dd = U[j - N:j], D[j - N:j]
        typ_sig = np.nanmedian(d["sig"][j - N:j])
        s = (d["sig"][j] / typ_sig) ** 0.5 if typ_sig > 0 and np.isfinite(d["sig"][j]) else 1.0
        qn = d["q24"][max(0, j - 30):j]; qn = qn[np.isfinite(qn)]
        vq = np.log(d["q24"][j] / np.median(qn)) if len(qn) >= 20 and np.isfinite(d["q24"][j]) and np.median(qn) > 0 else 0.0
        typ = np.median((u + dd) / 2)
        mv = abs(d["ret24"][j]) / typ if typ > 0 and np.isfinite(d["ret24"][j]) else 0.0
        a = np.exp(VOLW * vq + MOVEW * mv)
        scale[j], mult[j] = s, a
        k = s * a
        for side, x, Q in (("U", u, QU), ("D", dd, QD)):
            q_emp = np.quantile(x, TAUS)
            Q["median"][j] = q_emp * k                  # production: empirical distribution of the last 60 days
            # single-number centres: same distribution SHAPE as production, recentred
            for m, centre in (("mean", x.mean()), ("trim10", np.mean(np.sort(x)[6:-6])),
                              ("geo", np.exp(np.mean(np.log(np.maximum(x, 1e-5))))),
                              ("ewmed", wmedian(x, w_ew))):
                Q[m][j] = q_emp * (centre / np.median(x)) * k
        bU, bD = boot(d["br"][j - N:j], d["bhx"][j - N:j], d["blx"][j - N:j], rng, 1)
        QU["mc_hour"][j], QD["mc_hour"][j] = np.quantile(bU, TAUS) * k, np.quantile(bD, TAUS) * k
        bU, bD = boot(d["br"][j - N:j], d["bhx"][j - N:j], d["blx"][j - N:j], rng, 6)
        QU["mc_block6"][j], QD["mc_block6"][j] = np.quantile(bU, TAUS) * k, np.quantile(bD, TAUS) * k
        for m, sd in (("bm_ewma24", d["s_e24"][j]), ("bm_ewma168", d["s_e168"][j]), ("bm_garch", d["s_g"][j])):
            if np.isfinite(sd) and sd > 0:
                QU[m][j] = QD[m][j] = z * sd * a        # its own vol model, so no extra vol scale
        mu, md = np.median(u), np.median(dd)
        feat["medU"][j], feat["medD"][j] = mu, md
        feat["x_vol"][j] = np.log(d["sig"][j] / typ_sig) if typ_sig > 0 and d["sig"][j] > 0 else 0.0
        feat["x_q"][j], feat["x_move"][j] = vq, mv
        feat["x_u1"][j], feat["x_d1"][j] = np.log(max(U[j - 1], 0.02 * mu) / mu), np.log(max(D[j - 1], 0.02 * md) / md)
        feat["x_u7"][j], feat["x_d7"][j] = np.log(U[j - 7:j].mean() / mu), np.log(D[j - 7:j].mean() / md)
        feat["x_gapU"][j], feat["x_gapD"][j] = np.log(u.mean() / mu), np.log(dd.mean() / md)
    return QU, QD, scale, mult, feat


def calibrate(Q, Y, dates):
    """Walk-forward MAE-optimal multiplier on the median column, applied to
    every quantile: k_j = weighted median of Y_i / m_i (weights m_i), i < j."""
    out = np.full_like(Q, np.nan)
    m = Q[:, 2]
    ok = np.isfinite(m) & (m > 0) & np.isfinite(Y)
    ratio = np.where(ok, Y / np.where(ok, m, 1), np.nan)
    for j in range(len(m)):
        if not np.isfinite(m[j]): continue
        past = np.where(ok[:j])[0]
        if len(past) < CAL_MIN: continue
        out[j] = Q[j] * wmedian(ratio[past], m[past])
    return out


if __name__ == "__main__":
    t0 = time.time()
    rows = []
    for sym in TRACKED:
        d = days(sym)
        QU, QD, scale, mult, feat = forecasts(d)
        for m in ["mean", "median", "bm_ewma24", "bm_ewma168", "bm_garch"]:
            QU[m + "_cal"], QD[m + "_cal"] = calibrate(QU[m], d["U"], d["dates"]), calibrate(QD[m], d["D"], d["dates"])
        df = pd.DataFrame({"sym": sym, "date": d["dates"], "U": d["U"], "D": d["D"], "O": d["O"], "scale": scale, "mult": mult, **feat})
        df["dow"] = df.date.dt.dayofweek
        for m in QU:
            for i, t in enumerate(TAUS):
                df[f"{m}|U|{t}"] = QU[m][:, i]; df[f"{m}|D|{t}"] = QD[m][:, i]
        rows.append(df)
        print(f"   {sym} done {time.time() - t0:.0f}s", flush=True)
    A = pd.concat(rows, ignore_index=True)
    A.to_pickle(f"{OUT}/zone_methods.pkl")
    print(f"saved {len(A):,} coin-days to {OUT}/zone_methods.pkl in {time.time() - t0:.0f}s")
