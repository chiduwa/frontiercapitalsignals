"""The 40-day coin rotation (scripts/coin-rotation.mjs) replayed on Binance
USDS-M perpetuals with real funding, 2024-02 to 2026-08, delisted coins
included. Universe and cohorts exactly as the live paper log forms them (from
SPOT daily closes at the 23:00 UTC bar and 30-day median daily quote volume),
limited to coins with a perpetual on the formation day, which is all the
futures bot could trade.

Scores per cohort: spot (as the paper log), perp price only, perp + funding.
A coin delisted during the hold exits at its last close (the paper log drops
it instead; both shown)."""
import glob, os, sys
import numpy as np, pandas as pd

K = 40; UNI = 100; HIST = 41; VOLD = 30; PEG = 0.003; COST = 0.002; BREAK = np.log(100); MINS = 20
EXCL = {"PAXG", "XAUT", "WBTC", "WBETH", "BETH", "STETH", "WSTETH", "BNSOL", "CBBTC", "WETH"}
DAY = 86_400_000; STEP = 3_600_000
files = sorted(glob.glob("data/*.npz"))
days = pd.date_range("2024-01-01", "2026-08-31", freq="D")
D = len(days); d0 = int(days[0].value // 10**6)
coins, S_close, S_qv, P_close, FUND = [], [], [], [], []
for fn in files:
    d = np.load(fn)
    if "empty" in d.files: continue
    coin = os.path.basename(fn)[:-4]
    if coin in EXCL: continue
    st = d["s_t"]; S = d["s"].astype(float)
    di = ((st - d0) // DAY).astype(np.int64); hr = ((st - d0) % DAY) // STEP
    ok = (di >= 0) & (di < D)
    qv = np.zeros(D); np.add.at(qv, di[ok], np.nan_to_num(S[ok, 4]))
    sc = np.full(D, np.nan); m = ok & (hr == 23) & (S[:, 3] > 0); sc[di[m]] = S[m, 3]
    qv[~np.isfinite(sc)] = np.nan            # as dailyFromHourly: a day without its 23:00 close does not count
    pt = d["p_t"]; P = d["p"].astype(float)
    pdi = ((pt - d0) // DAY).astype(np.int64); phr = ((pt - d0) % DAY) // STEP
    pm = (pdi >= 0) & (pdi < D) & (phr == 23) & (P[:, 3] > 0)
    pc = np.full(D, np.nan); pc[pdi[pm]] = P[pm, 3]
    # cumulative funding by day end (00:00 UTC of the next day), for sums over (formation close, exit close]
    ft, fr = d["f_t"], d["f"].astype(float)
    fdi = ((ft - d0 - 1) // DAY).astype(np.int64)   # an event at exactly 00:00 belongs to the day that just closed
    fs = np.zeros(D); okf = (fdi >= 0) & (fdi < D); np.add.at(fs, fdi[okf], fr[okf])
    coins.append(coin); S_close.append(sc); S_qv.append(qv); P_close.append(pc); FUND.append(np.cumsum(fs))
S_close, S_qv, P_close, FUND = map(np.array, (S_close, S_qv, P_close, FUND))
C = len(coins); print(f"{C} coins, {D} days")

def last_close(arr, i0, i1):
    """close on day i1, or the last one after i0 if the coin stopped trading"""
    if np.isfinite(arr[i1]): return arr[i1], i1
    seg = arr[i0 + 1:i1 + 1]; f = np.where(np.isfinite(seg))[0]
    return (seg[f[-1]], i0 + 1 + f[-1]) if len(f) else (np.nan, None)

rows = []
for i in range(HIST - 1, D - 1):
    w = S_close[:, i - HIST + 1:i + 1]
    full = np.all(np.isfinite(w) & (w > 0), axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        mv = np.nanmedian(np.abs(np.diff(np.log(w), axis=1)), axis=1)
        vol = np.nanmedian(S_qv[:, i - VOLD + 1:i + 1], axis=1)
    cand = full & (mv >= PEG) & (vol > 0) & np.isfinite(P_close[:, i])
    idx = np.where(cand)[0]
    idx = idx[np.lexsort((np.array(coins)[idx], -vol[idx]))][:UNI]
    if len(idx) < MINS: continue
    j = i + K
    if j >= D: break
    move = np.log(S_close[idx, i] / S_close[idx, i - K])
    n = len(idx); rel = move - (move.sum() - move) / (n - 1)
    order = np.argsort(rel)
    for variant, sel in (("all", None), ("top10", 10)):
        L = [x for x in order if rel[x] < 0]; Sx = [x for x in order[::-1] if rel[x] > 0]
        if sel: L, Sx = L[:sel], Sx[:sel]
        res = {}
        for kind in ("spot_drop", "spot_last", "perp", "perp_fund"):
            legs = []
            for members, sign in ((L, 1), (Sx, -1)):
                r = []
                for x in members:
                    c = idx[x]
                    seg = S_close[c, i:j + 1]; seg = seg[np.isfinite(seg)]
                    if len(seg) > 1 and np.max(np.abs(np.diff(np.log(seg)))) > BREAK: continue
                    if kind == "spot_drop":
                        e, xv = S_close[c, i], S_close[c, j]
                        if not np.isfinite(xv): continue
                        r.append(xv / e - 1)
                    elif kind == "spot_last":
                        xv, _ = last_close(S_close[c], i, j); r.append(xv / S_close[c, i] - 1)
                    else:
                        xv, xi = last_close(P_close[c], i, j)
                        if not np.isfinite(xv): continue
                        ret = xv / P_close[c, i] - 1
                        if kind == "perp_fund": ret -= FUND[c, xi] - FUND[c, i]     # longs pay a positive rate; for shorts sign flips below
                        r.append(ret)
                legs.append(r)
            Lr, Sr = legs
            if len(Lr) + len(Sr) < (MINS if not sel else 2 * sel * 0.8) or not Lr or not Sr: res[kind] = np.nan; continue
            res[kind] = np.mean(Lr) - np.mean(Sr) - COST
            if kind in ("spot_drop", "perp_fund"):
                res[kind + "_lag"] = np.mean(Lr) - 0.002 - np.mean(Lr + Sr)
        rows.append(dict(formed=days[i], variant=variant, n=n, nL=len(L), nS=len(Sx), **res))
R = pd.DataFrame(rows)

def nw_t(x, lag):
    x = np.asarray(x); x = x[np.isfinite(x)]; n = len(x)
    if n < 3: return np.nan
    d = x - x.mean(); v = (d * d).sum() / n
    for l in range(1, min(lag, n - 1) + 1):
        v += 2 * (1 - l / (lag + 1)) * (d[l:] * d[:-l]).sum() / n
    return x.mean() / np.sqrt(v / n)
print(f"cohorts formed {R.formed.min().date()} to {R.formed.max().date()}; universe median {int(R.n.median())} coins")
for variant in ("all", "top10"):
    g0 = R[R.variant == variant]
    print(f"\n== {variant}: {'every laggard vs every leader (the paper log)' if variant == 'all' else 'the 10 biggest laggards vs the 10 biggest leaders'} ==")
    for kind, label in (("spot_drop", "spot, delisted coins dropped (paper log's way)"), ("spot_last", "spot, delisted coins at last close"),
                        ("perp", "perpetual, price only"), ("perp_fund", "perpetual, with funding (what the bot would earn)")):
        parts = []
        for name, g in (("2024-02..2024-12", g0[g0.formed < "2025-01-01"]), ("2025", g0[(g0.formed >= "2025-01-01") & (g0.formed < "2026-01-01")]),
                        ("2026-01..07", g0[g0.formed >= "2026-01-01"]), ("all", g0)):
            x = g[kind].dropna()
            parts.append(f"{name} {x.mean()*100:+6.2f}%/round ({x.mean()*365/K*100:+5.0f}%/yr, t {nw_t(x, K-1):+.1f})")
        print(f"  {label:52s} " + " | ".join(parts))
    for kind in ("spot_drop_lag", "perp_fund_lag"):
        x = g0[kind].dropna()
        print(f"  laggards alone vs universe, {kind.split('_lag')[0]:10s}: {x.mean()*100:+.2f}%/round ({x.mean()*365/K*100:+.0f}%/yr, t {nw_t(x, K-1):+.1f})")
R.to_pickle("rotation_perp.pkl")
