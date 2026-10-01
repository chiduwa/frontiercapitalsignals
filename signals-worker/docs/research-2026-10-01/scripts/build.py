"""Every historical exhaustion print (live rule, non-major coins) with the context
features that might separate prints that faded from prints that kept running.

Features are the live rule's own (sim.py / worker.js calibratedSurge), computed
from bars at or before the print bar. Outcomes run from the print bar's close.
Output: events.pkl
"""
import glob, json, os
import numpy as np, pandas as pd

ARCH = "/private/tmp/claude-501/-Users-owner/b677f588-0ff8-4f26-8c37-a5e343026c67/scratchpad/exh/data"
SEP, CG = "sep", "cg"
STEP = 3_600_000
MAJOR_LIQ, THIN_LIQ = 400_000.0, 33_000.0
T0 = int(pd.Timestamp("2024-01-01").value // 10**6)
TEND = int(pd.Timestamp("2026-10-01 01:00").value // 10**6)
G = (TEND - T0) // STEP + 1

def load(coin):
    d = np.load(os.path.join(ARCH, coin + ".npz"))
    if "empty" in d.files: return None
    A = np.full((G, 7), np.nan)
    gi = (d["s_t"] - T0) // STEP; ok = (gi >= 0) & (gi < G); A[gi[ok]] = d["s"][ok]
    sp = os.path.join(SEP, coin + ".npz")
    if os.path.exists(sp):
        e = np.load(sp); gi = (e["t"] - T0) // STEP; ok = (gi >= 0) & (gi < G); A[gi[ok]] = e["s"][ok]
    PQ = np.full(G, np.nan)
    gi = (d["p_t"] - T0) // STEP; ok = (gi >= 0) & (gi < G); PQ[gi[ok]] = d["p_qv"][ok]
    return A, PQ, d["f_t"], d["f"].astype(float)

coins = sorted(os.path.basename(f)[:-4] for f in glob.glob(ARCH + "/*.npz"))
data = {}
for c in coins:
    try:
        x = load(c)
    except Exception:
        continue
    if x is not None and np.isfinite(x[0][:, 3]).sum() >= 1000: data[c] = x
print(len(data), "coins")

# equal-weight market, as sim.py
ret_sum = np.zeros(G); ret_cnt = np.zeros(G)
for c, (A, *_ ) in data.items():
    cl = A[:, 3]; r = np.concatenate([[np.nan], cl[1:] / cl[:-1] - 1])
    first = np.argmax(np.isfinite(cl)); r[: first + 720] = np.nan
    ok = np.isfinite(r); np.add.at(ret_sum, np.where(ok)[0], np.clip(r[ok], -0.5, 0.5)); np.add.at(ret_cnt, np.where(ok)[0], 1)
mkt_r = np.where(ret_cnt >= 30, ret_sum / np.maximum(ret_cnt, 1), 0.0)
mkt_log = np.concatenate([[0.0], np.cumsum(np.log1p(mkt_r[1:]))])
last_full = int(np.where(ret_cnt >= 100)[0].max())
print("last market hour", pd.to_datetime(T0 + last_full * STEP, unit="ms"))
def mkt(i, H):
    return np.exp(mkt_log[i + H] - mkt_log[i]) - 1 if i + H <= last_full else np.nan

# market cap: CoinGecko daily history; value from the day BEFORE the print (no lookahead)
mcap = {}
for c in data:
    p = os.path.join(CG, c + ".json")
    if os.path.exists(p):
        j = json.load(open(p))
        if j.get("market_caps"):
            a = np.array(j["market_caps"], dtype=float); a = a[a[:, 1] > 0]
            if len(a): mcap[c] = a
mk = {m["symbol"].upper(): m for m in json.load(open(os.path.join(CG, "markets.json")))}
cgmap = json.load(open(os.path.join(CG, "map.json")))
supply_now = {}
for c, cid in cgmap.items():
    for m in mk.values():
        if m["id"] == cid and m.get("circulating_supply"): supply_now[c] = m["circulating_supply"]
print(len(mcap), "coins with mcap history;", len(supply_now), "with current supply")

rows = []
for c, (A, PQ, F_t, F_r) in data.items():
    o, h, l, cl, qv, n, tbq = A.T
    s_qv, s_n, s_c = pd.Series(qv), pd.Series(n), pd.Series(cl)
    lr = np.log(s_c / s_c.shift(1))
    sig = lr.shift(1).rolling(720, min_periods=360).std().to_numpy()
    med_qv48 = s_qv.shift(1).rolling(48, min_periods=24).median().to_numpy()
    med_n48 = s_n.shift(1).rolling(48, min_periods=24).median().to_numpy()
    lqv = np.log(s_qv.where(s_qv > 0))
    mu = lqv.shift(1).rolling(720, min_periods=360).mean().to_numpy()
    sd = lqv.shift(1).rolling(720, min_periods=360).std().to_numpy()
    liq30 = s_qv.shift(1).rolling(720, min_periods=360).median().to_numpy()
    qv24 = s_qv.rolling(24, min_periods=20).sum().to_numpy()            # includes the print bar
    pq24 = pd.Series(PQ).rolling(24, min_periods=20).sum().to_numpy()
    hi90 = s_c.shift(1).rolling(90 * 24, min_periods=30 * 24).max().to_numpy()
    hi365 = s_c.shift(1).rolling(365 * 24, min_periods=90 * 24).max().to_numpy()
    lo90 = s_c.shift(1).rolling(90 * 24, min_periods=30 * 24).min().to_numpy()
    c30 = s_c.shift(30 * 24).to_numpy(); c7 = s_c.shift(7 * 24).to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        bar = cl / o - 1
        barZ = np.log(cl / o) / sig
        run24Z = np.log(cl / s_c.shift(24).to_numpy()) / (sig * np.sqrt(24))
        volZ = (np.log(qv) - mu) / sd
        ratio48 = qv / med_qv48; tradeRatio = n / med_n48
    first = np.argmax(np.isfinite(cl)); age = np.arange(G) - first
    valid = np.isfinite(cl) & np.isfinite(o) & (age >= 720) & np.isfinite(sig) & np.isfinite(med_qv48) & np.isfinite(liq30)
    pc = valid & (cl > o) & (volZ >= 3) & (barZ >= 3) & (run24Z >= 1.5)
    x20 = valid & (ratio48 >= 20) & (tradeRatio >= 2) & (bar >= 0.05)
    idx = np.where((pc | x20) & (liq30 < MAJOR_LIQ))[0]
    prev = []
    for i in idx:
        t = T0 + i * STEP
        def fwd(H):
            j = i + H
            return cl[j] / cl[i] - 1 if j < G and np.isfinite(cl[j]) else np.nan
        def peak(H):
            seg = h[i + 1: i + 1 + H]
            return np.nanmax(seg) / cl[i] - 1 if i + H < G and np.isfinite(seg).any() else np.nan
        mc = np.nan
        if c in mcap:
            a = mcap[c]; k = np.searchsorted(a[:, 0], t - 86_400_000, side="right") - 1
            if k >= 0 and t - a[k, 0] < 4 * 86_400_000: mc = a[k, 1]
        mc_proxy = cl[i] * supply_now[c] if c in supply_now else np.nan
        fr = F_r[F_t <= t + STEP]
        rows.append(dict(
            coin=c, t=t, i=i, tier="thin" if liq30[i] < THIN_LIQ else "mid",
            case="both" if (pc[i] and x20[i]) else ("percoin" if pc[i] else "x20"),
            volZ=volZ[i], barZ=barZ[i], run24Z=run24Z[i], bar=bar[i], ratio48=ratio48[i], liq30=liq30[i],
            # how many prints this coin had in the 72h before this one
            streak72=sum(1 for p in prev if i - p <= 72), hrs_since_prev=(i - prev[-1]) if prev else np.nan,
            vol24_x=qv24[i] / (24 * liq30[i]),                     # last day's volume vs the 30-day hourly median
            dd365=cl[i] / hi365[i] - 1, brk90=cl[i] / hi90[i] - 1, up90=cl[i] / lo90[i] - 1,
            ret30d=cl[i] / c30[i] - 1, ret7d=cl[i] / c7[i] - 1,
            taker=tbq[i] / qv[i] if qv[i] > 0 else np.nan,
            perp_x=pq24[i] / qv24[i] if np.isfinite(pq24[i]) else np.nan,
            funding=float(fr[-1]) if len(fr) and t - F_t[F_t <= t + STEP][-1] < 2 * 86_400_000 else np.nan,
            mcap=mc, mcap_proxy=mc_proxy, qv24=qv24[i], pq24=pq24[i],
            mkt72_before=np.exp(mkt_log[i] - mkt_log[max(i - 72, 0)]) - 1,
            fwd4=fwd(4), fwd24=fwd(24), fwd72=fwd(72),
            exc4=fwd(4) - mkt(i, 4), exc24=fwd(24) - mkt(i, 24), exc72=fwd(72) - mkt(i, 72),
            peak24=peak(24),
        ))
        prev.append(i)
E = pd.DataFrame(rows)
E["turn"] = E.qv24 / E.mcap
E["turn_proxy"] = E.qv24 / E.mcap_proxy
E.to_pickle("events.pkl")
print(len(E), "prints;", E.exc24.notna().sum(), "with 24h outcome")
