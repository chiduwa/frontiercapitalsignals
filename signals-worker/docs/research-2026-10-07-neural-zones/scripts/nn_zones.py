"""Neural networks for the day-zone forecast (asked 2026-10-07: "how about
neural network for predicting").

Daily close-to-close direction and size were already tested with an LSTM on
479 assets (docs/SEQUENCE_MODELS.md, 2026-09-23/24): direction never beat the
base rate, size beat GARCH + weekday only for two stocks. Not repeated here.
What had not been tried is a network on the day-zone target: how far the
UTC day's high and low go from the 00:00 open (U, D), from hourly data, where
a linear median regression just replaced the 60-day median (day-zones-v3,
docs/DAY_ZONE_METHODS_AND_CONFUSION.md).

Every model forecasts the 10/25/50/75/90th percentiles of log(U / 60-day
median) and log(D / 60-day median), all coins pooled, refit every 91 days on
every coin-day before the refit (the last 15% of those dates held out for
early stopping), the same schedule and target as the linear model:
  linear   day-zones-v3's median regression (statsmodels, per side and
           percentile), the incumbent, walk-forward here so it gets no
           in-sample advantage
  lgbm     gradient-boosted trees, quantile loss (a nonlinear control that is
           not a neural network)
  mlp      a 2 x 64 feed-forward network on the same inputs, both sides at once,
           pinball loss, monotone quantiles, 3 seeds averaged
  lstm     an LSTM reading the last 14 days of 4-hour bars (return, high and
           low excursion in typical moves, volume vs its 30-day median) plus
           the same inputs, 3 seeds averaged
Scored as in score.py: MAE of the median level, CRPS over the five
percentiles, calibration, 2019-22 and 2023-26, paired against the linear
model with days pooled across coins (Newey-West t), per coin. Then whether
any of them can tilt the day up or down (the up/down skew), which no input
could on 2026-10-02.
"""
import os, sys, time, json, warnings
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "research-2026-10-06-mean-median-sim", "scripts"))
from zone_methods import OUT as MM_OUT, TAUS, SPLIT, TRACKED, load      # noqa: E402
from stats_util import nw_mean                                           # noqa: E402

warnings.filterwarnings("ignore")
OUT = os.environ.get("NN_OUT", os.path.join(os.path.dirname(MM_OUT), "neural-zones"))
os.makedirs(OUT, exist_ok=True)
REFIT_DAYS, MIN_DATES, VAL_SHARE = 91, 365, 0.15
CAP = 4.0
STEPS, BAR_H = 84, 4                     # 14 days of 4-hour bars
SEEDS = (11, 22, 33)
STATIC = ["x_vol", "x_q", "x_move", "x_u1", "x_d1", "x_u7", "x_d7", "x_gapU", "x_gapD"] + [f"dow{k}" for k in range(6)]
LINEAR = {"U": ["x_vol", "x_q", "x_move", "x_u7", "x_gapU"] + [f"dow{k}" for k in range(6)],
          "D": ["x_vol", "x_q", "x_move", "x_d7", "x_gapD"] + [f"dow{k}" for k in range(6)]}


# ------------------------------------------------------------------ data

def sequences(A):
    """(n, 84, 4): the 84 four-hour bars that END at each row's 00:00 open.
    Channels: log return, high excursion, low excursion (each in the row's
    typical daily move), log(volume / median of the 180 bars before the day).
    Nothing at or after the open."""
    out = np.zeros((len(A), STEPS, 4), np.float32)
    for sym in TRACKED:
        idx = np.where(A.sym.values == sym)[0]
        if not len(idx): continue
        h = load(sym)
        b = pd.DataFrame({"o": h.o.resample("4h").first(), "h": h.h.resample("4h").max(), "l": h.l.resample("4h").min(),
                          "c": h.c.resample("4h").last(), "qv": h.qv.resample("4h").sum(min_count=1)})
        full = h.c.resample("4h").count() == BAR_H
        b.loc[~full] = np.nan
        pos = {t: i for i, t in enumerate(b.index)}
        o, hi, lo, c, qv = (b[k].values for k in ("o", "h", "l", "c", "qv"))
        prev_c = np.r_[np.nan, c[:-1]]
        ch = np.stack([np.log(c / prev_c), np.log(hi / o), np.log(o / lo)], 1)
        for i in idx:
            t = A.date.values[i]
            p = pos.get(pd.Timestamp(t))
            if p is None or p < STEPS + 180: continue
            typ = (A.medU.values[i] + A.medD.values[i]) / 2
            w = slice(p - STEPS, p)                                     # bars before the open
            x = ch[w] / typ
            vnorm = np.nanmedian(qv[p - STEPS - 180:p - STEPS])
            v = np.log(qv[w] / vnorm) if vnorm > 0 else np.zeros(STEPS)
            seq = np.c_[x, v]
            out[i] = np.clip(np.nan_to_num(seq, nan=0.0, posinf=0.0, neginf=0.0), -10, 10)
    return out


def build():
    A = pd.read_pickle(f"{MM_OUT}/zone_scored.pkl")
    A = A[A[["x_vol", "x_q", "x_move", "medU", "medD", "x_u1", "x_d1", "x_u7", "x_gapU", "x_d7", "x_gapD", "median|U|0.5"]].notna().all(1)]
    A = A.sort_values(["date", "sym"]).reset_index(drop=True)
    for k in range(6): A[f"dow{k}"] = (A.dow == k).astype(float)
    A["yU"] = np.log(np.maximum(A.U, 0.02 * A.medU) / A.medU)
    A["yD"] = np.log(np.maximum(A.D, 0.02 * A.medD) / A.medD)
    t0 = time.time()
    S = sequences(A)
    print(f"   {len(A):,} coin-days, sequences in {time.time() - t0:.0f}s", flush=True)
    np.savez_compressed(f"{OUT}/inputs.npz", seq=S, X=A[STATIC].values.astype(np.float32), y=A[["yU", "yD"]].values.astype(np.float32),
                        XU=A[LINEAR["U"]].values, XD=A[LINEAR["D"]].values, days=(A.date.values.astype("datetime64[D]").astype(np.int64)))
    A.drop(columns=[c for c in A.columns if "|" in c and not c.startswith("median|")]).to_pickle(f"{OUT}/rows.pkl")
    return A


# ------------------------------------------------------------------ models

_D = None
def data():
    global _D
    if _D is None: _D = dict(np.load(f"{OUT}/inputs.npz"))
    return _D


def split(r0, r1):
    d = data()["days"]
    tr = np.where(d < r0)[0]; te = np.where((d >= r0) & (d < r1))[0]
    if len(te) == 0 or len(np.unique(d[tr])) < MIN_DATES: return None
    cut = np.quantile(np.unique(d[tr]), 1 - VAL_SHARE)
    return tr[d[tr] < cut], tr[d[tr] >= cut], tr, te


def fit_linear(job):
    import statsmodels.api as sm
    r0, r1 = job["r0"], job["r1"]
    s = split(r0, r1)
    if s is None: return job, None
    _, _, tr, te = s
    D = data(); out = np.zeros((len(te), 2, 5))
    for k, X in enumerate((D["XU"], D["XD"])):
        Xa = np.c_[np.ones(len(X)), X]
        for i, t in enumerate(TAUS):
            b = sm.QuantReg(D["y"][tr, k], Xa[tr]).fit(q=t, max_iter=5000, p_tol=1e-8).params
            out[:, k, i] = Xa[te] @ b
    return job, (te, np.sort(out, axis=2))


def fit_lgbm(job):
    import lightgbm as lgb
    s = split(job["r0"], job["r1"])
    if s is None: return job, None
    fit_i, val_i, _, te = s
    D = data(); X = D["X"]; out = np.zeros((len(te), 2, 5))
    for k in range(2):
        for i, t in enumerate(TAUS):
            m = lgb.LGBMRegressor(objective="quantile", alpha=float(t), n_estimators=600, learning_rate=0.03, num_leaves=15,
                                  min_child_samples=50, subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=1.0,
                                  random_state=7, n_jobs=1, verbose=-1)
            m.fit(X[fit_i], D["y"][fit_i, k], eval_set=[(X[val_i], D["y"][val_i, k])],
                  callbacks=[lgb.early_stopping(50, verbose=False)])
            out[:, k, i] = m.predict(X[te])
    return job, (te, np.sort(out, axis=2))


def fit_nn(job):
    import torch, torch.nn as nn, torch.nn.functional as F
    torch.set_num_threads(1)
    s = split(job["r0"], job["r1"])
    if s is None: return job, None
    fit_i, val_i, _, te = s
    D = data(); kind, seed = job["kind"], job["seed"]
    torch.manual_seed(seed); rng = np.random.default_rng(seed)
    mu, sd = D["X"][fit_i].mean(0), D["X"][fit_i].std(0) + 1e-6
    X = torch.tensor((D["X"] - mu) / sd, dtype=torch.float32)
    Q = torch.tensor(D["seq"]); Y = torch.tensor(D["y"]); T = torch.tensor(TAUS, dtype=torch.float32)

    class Net(nn.Module):
        def __init__(self):
            super().__init__()
            self.rnn = nn.LSTM(4, 32, batch_first=True) if kind == "lstm" else None
            d = X.shape[1] + (32 if self.rnn else 0)
            self.mlp = nn.Sequential(nn.Linear(d, 64), nn.ReLU(), nn.Dropout(0.1), nn.Linear(64, 64), nn.ReLU(), nn.Dropout(0.1), nn.Linear(64, 10))
        def forward(self, x, q):
            if self.rnn is not None:
                _, (h, _) = self.rnn(q); x = torch.cat([x, h[-1]], 1)
            o = self.mlp(x).view(-1, 2, 5)
            inc = F.softplus(o[:, :, [0, 1, 3, 4]])                       # monotone percentiles around the median
            m = o[:, :, 2]
            q25 = m - inc[:, :, 1]; q75 = m + inc[:, :, 2]
            return torch.stack([q25 - inc[:, :, 0], q25, m, q75, q75 + inc[:, :, 3]], -1)

    def pinball(q, y):
        e = y.unsqueeze(-1) - q
        return torch.maximum(T * e, (T - 1) * e).mean()

    net = Net(); opt = torch.optim.Adam(net.parameters(), lr=1e-3, weight_decay=1e-4)
    fi, vi = torch.tensor(fit_i), torch.tensor(val_i)
    best, state, bad = np.inf, None, 0
    for epoch in range(150):
        net.train()
        perm = fi[torch.tensor(rng.permutation(len(fi)))]
        for b in range(0, len(perm), 256):
            i = perm[b:b + 256]
            opt.zero_grad(); loss = pinball(net(X[i], Q[i] if kind == 'lstm' else None), Y[i]); loss.backward(); opt.step()
        net.eval()
        with torch.no_grad(): v = float(pinball(net(X[vi], Q[vi] if kind == 'lstm' else None), Y[vi]))
        if v < best - 1e-5: best, state, bad = v, {k: t.clone() for k, t in net.state_dict().items()}, 0
        else:
            bad += 1
            if bad >= 12: break
    net.load_state_dict(state); net.eval()
    ti = torch.tensor(te)
    with torch.no_grad(): out = net(X[ti], Q[ti] if kind == 'lstm' else None).numpy()
    return job, (te, out)


def run_job(job):
    t0 = time.time()
    f = {"linear": fit_linear, "lgbm": fit_lgbm, "mlp": fit_nn, "lstm": fit_nn}[job["kind"]]
    job, res = f(job)
    if res is not None: print(f"   {job['kind']:6s} seed {job.get('seed', '-')} refit {job['r0']}: {time.time() - t0:.0f}s", flush=True)
    return job, res


# ------------------------------------------------------------------ scoring

def losses(A, q):
    """q: (n, 2, 5) log-ratio percentiles -> MAE (median level capped at 4x, as
    live), CRPS over the five percentiles, inside-rates."""
    lev = np.exp(q) * np.c_[A.medU.values, A.medD.values][:, :, None]
    med = np.minimum(lev[:, :, 2], CAP * np.c_[A.medU.values, A.medD.values])
    y = np.c_[A.U.values, A.D.values]
    e = y[:, :, None] - lev
    pin = np.maximum(TAUS * e, (TAUS - 1) * e).mean(2).sum(1) / 2
    return pd.DataFrame({"mae": np.abs(y - med).sum(1), "crps": pin, "inU": (y[:, 0] <= med[:, 0]).astype(float),
                         "inD": (y[:, 1] <= med[:, 1]).astype(float),
                         "band80": (((y >= lev[:, :, 0]) & (y <= lev[:, :, 4])).mean(1))}, index=A.index)


if __name__ == "__main__":
    from multiprocessing import Pool
    A = build()
    days = data()["days"]
    refits = np.arange(np.datetime64("2018-12-31").astype(np.int64), days.max() + 1, REFIT_DAYS)
    windows = list(zip(refits, np.r_[refits[1:], days.max() + 1]))
    jobs = [{"kind": "linear", "r0": int(a), "r1": int(b)} for a, b in windows] + \
           [{"kind": "lgbm", "r0": int(a), "r1": int(b)} for a, b in windows] + \
           [{"kind": k, "seed": s, "r0": int(a), "r1": int(b)} for k in ("lstm", "mlp") for s in SEEDS for a, b in windows]
    t0 = time.time()
    with Pool(int(os.environ.get("WORKERS", "7"))) as p:
        results = p.map(run_job, jobs, chunksize=1)
    print(f"all fits {time.time() - t0:.0f}s")
    P = {k: np.full((len(A), 2, 5), np.nan) for k in ("linear", "lgbm", "mlp", "lstm")}
    n_seed = {k: np.zeros(len(A)) for k in P}
    for job, res in results:
        if res is None: continue
        te, q = res
        k = job["kind"]
        P[k][te] = np.where(np.isnan(P[k][te]), 0, P[k][te]) + q
        n_seed[k][te] += 1
    for k in P: P[k] = P[k] / np.maximum(n_seed[k], 1)[:, None, None]
    np.savez_compressed(f"{OUT}/predictions.npz", **P)
    print("saved", f"{OUT}/predictions.npz")
