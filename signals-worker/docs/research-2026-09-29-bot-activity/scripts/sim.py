"""Exhaustion shorts as trades on Binance USDS-M perpetuals.

The signal is the live rule's, computed on SPOT 1h bars exactly as the
2026-09-26 study (build_events.py) and the live scan compute it:
  per-coin rule   rising bar, volZ >= 3, barZ >= 3, run24Z >= 1.5
  20x rule        quote volume >= 20x its 48h median, trades >= 2x, bar >= +5%
Majors (30-day median hourly spot quote volume >= $400K) are excluded, as live.
Tier: thin < $33K/h, mid otherwise.

The trade is on the PERPETUAL: entry, stops and exits on perp 1h bars, with
maker/taker fees, slippage by tier and the real funding payments.

usage: python3 sim.py [datadir]   -> trades.pkl (one row per signal x variant)
"""
import glob, os, sys, itertools
import numpy as np, pandas as pd

DATA = sys.argv[1] if len(sys.argv) > 1 else "data"
STEP = 3_600_000
MAJOR_LIQ, THIN_LIQ = 400_000.0, 33_000.0
FEE_MAKER, FEE_TAKER = 0.0002, 0.0005
SLIP = {"thin": 0.0010, "mid": 0.0005}          # per taker fill; stops pay double
LIMIT_WINDOW = 12                               # hours a limit entry rests

ENTRIES = [("mkt", 0.0), ("lmt3", 0.03), ("lmt5", 0.05)]
STOPS = [None, 0.15, 0.25]
HOLDS = [24, 72]

def features(t, o, h, l, c, qv, n):
    s_qv, s_n, s_c = pd.Series(qv), pd.Series(n), pd.Series(c)
    lr = np.log(s_c / s_c.shift(1))
    sig = lr.shift(1).rolling(720, min_periods=360).std().to_numpy()
    med_qv48 = s_qv.shift(1).rolling(48, min_periods=24).median().to_numpy()
    med_n48 = s_n.shift(1).rolling(48, min_periods=24).median().to_numpy()
    lqv = np.log(s_qv.where(s_qv > 0))
    mu = lqv.shift(1).rolling(720, min_periods=360).mean().to_numpy()
    sd = lqv.shift(1).rolling(720, min_periods=360).std().to_numpy()
    liq30 = s_qv.shift(1).rolling(720, min_periods=360).median().to_numpy()
    run24 = (s_c / s_c.shift(24) - 1).to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        bar = c / o - 1
        barZ = np.log(c / o) / sig
        run24Z = np.log1p(run24) / (sig * np.sqrt(24))
        volZ = (np.log(qv) - mu) / sd
        ratio48 = qv / med_qv48
        tradeRatio = n / med_n48
    age = np.arange(len(c))
    valid = np.isfinite(c) & np.isfinite(o) & (age >= 720) & np.isfinite(sig) & np.isfinite(med_qv48) & np.isfinite(liq30)
    pc_rule = valid & (c > o) & (volZ >= 3) & (barZ >= 3) & (run24Z >= 1.5)
    x20 = valid & (ratio48 >= 20) & (tradeRatio >= 2) & (bar >= 0.05)
    return pc_rule, x20, liq30, bar, volZ

def simulate(k, P, F_t, F_r, entry, off, stop, hold, late, slip):
    """One short on the perp. k = index of the print hour's perp bar.
    Returns (entry_i, exit_i, entry_px, exit_px, reason, cost, funding, mae) or None."""
    po, ph, pl, pc, pt = P
    N = len(pc)
    if k + 2 >= N: return None
    if entry == "mkt":
        if late: ei, ex_px, first_chk = k + 1, pc[k + 1], k + 2       # an hour late: the close of the next bar
        else:    ei, ex_px, first_chk = k + 1, po[k + 1], k + 1
        cost = FEE_TAKER + slip
        entry_px = ex_px
    else:
        lim = pc[k] * (1 + off)
        start = k + 2 if late else k + 1
        ei = None
        for j in range(start, min(k + 1 + LIMIT_WINDOW, N)):
            if ph[j] >= lim: ei = j; break
        if ei is None: return ("nofill",)
        entry_px, first_chk, cost = lim, ei, FEE_MAKER
    if not np.isfinite(entry_px) or entry_px <= 0: return None
    last = min(ei + hold - (0 if (entry == "mkt" and late) or entry != "mkt" else 1), N - 1)
    if entry == "mkt" and not late: last = min(ei + hold - 1, N - 1)
    stop_px = entry_px * (1 + stop) if stop else None
    mae, exit_px, reason, xi = 0.0, None, "time", last
    for j in range(first_chk, last + 1):
        hi = ph[j]
        if not np.isfinite(hi): continue
        if stop_px is not None:
            if j > ei and po[j] >= stop_px:
                exit_px, reason, xi = po[j], "stop", j
                mae = max(mae, po[j] / entry_px - 1); break
            if hi >= stop_px:
                exit_px, reason, xi = stop_px, "stop", j
                mae = max(mae, stop / 1.0); break
        mae = max(mae, hi / entry_px - 1)
    if exit_px is None:
        exit_px = pc[last]
        if not np.isfinite(exit_px):
            fin = np.where(np.isfinite(pc[ei:last + 1]))[0]
            if not len(fin): return None
            xi = ei + fin[-1]; exit_px = pc[xi]
    cost += FEE_TAKER + (2 * slip if reason == "stop" else slip)
    t_in, t_out = pt[ei], pt[xi] + STEP
    m = (F_t > t_in) & (F_t <= t_out)
    funding = float(F_r[m].sum()) if len(F_t) else 0.0          # shorts receive a positive rate
    return (ei, xi, entry_px, exit_px, reason, cost, funding, mae)

files = sorted(glob.glob(os.path.join(DATA, "*.npz")))
def spot_grid(d):
    st = d["s_t"]; S = d["s"].astype(float)
    full = np.arange(st[0], st[-1] + STEP, STEP)
    A = np.full((len(full), 7), np.nan); A[((st - st[0]) // STEP).astype(np.int64)] = S
    return full, A
T0 = int(pd.Timestamp("2024-01-01").value // 10**6); G = int((pd.Timestamp("2026-09-01").value // 10**6 - T0) // STEP) + 1
ret_sum = np.zeros(G); ret_cnt = np.zeros(G)
for fn in files:
    try:
        d = np.load(fn)
        if "empty" in d.files or len(d["s_t"]) < 1000: continue
        full, A = spot_grid(d)
    except Exception:
        continue
    c = A[:, 3]; r = c[1:] / c[:-1] - 1; r = np.concatenate([[np.nan], r]); r[:720] = np.nan
    gi = ((full - T0) // STEP).astype(np.int64); ok = np.isfinite(r) & (gi >= 0) & (gi < G)
    np.add.at(ret_sum, gi[ok], np.clip(r[ok], -0.5, 0.5)); np.add.at(ret_cnt, gi[ok], 1)
mkt_r = np.where(ret_cnt >= 30, ret_sum / np.maximum(ret_cnt, 1), 0.0)
mkt_log = np.concatenate([[0.0], np.cumsum(np.log1p(mkt_r[1:]))])
def mkt_fwd(t, H):
    g = int((t - T0) // STEP); j = g + H
    return np.exp(mkt_log[j] - mkt_log[g]) - 1 if 0 <= g and j < G else np.nan
print(f"market: median {np.median(ret_cnt[ret_cnt > 0]):.0f} coins an hour", flush=True)
btc = np.load(os.path.join(DATA, "BTC.npz"))
btc_map = dict(zip(btc["p_t"].tolist(), range(len(btc["p_t"]))))
btc_o, btc_c = btc["p"][:, 0].astype(float), btc["p"][:, 3].astype(float)
rows, prints = [], []
for fi, fn in enumerate(files):
    coin = os.path.basename(fn)[:-4]
    try:
        d = np.load(fn)
    except Exception:
        print("unreadable", fn); continue
    if "empty" in d.files or coin in ("BTC", "ETH"): continue
    if len(d["s_t"]) < 1000: continue
    full, A = spot_grid(d)
    o, h, l, c, qv, n, tbq = A.T
    pc_rule, x20, liq30, bar, volZ = features(full, o, h, l, c, qv, n)
    sig_idx = np.where((pc_rule | x20) & (liq30 < MAJOR_LIQ))[0]
    if not len(sig_idx): continue
    ptimes = d["p_t"]; Pp = d["p"].astype(float)
    pfull = np.arange(ptimes[0], ptimes[-1] + STEP, STEP)
    ppos = ((ptimes - ptimes[0]) // STEP).astype(np.int64)
    PA = np.full((len(pfull), 4), np.nan); PA[ppos] = Pp
    P = (PA[:, 0], PA[:, 1], PA[:, 2], PA[:, 3], pfull)
    F_t, F_r = d["f_t"], d["f"].astype(float)
    for i in sig_idx:
        t = full[i]
        k = (t - pfull[0]) // STEP
        if k < 0 or k + 2 >= len(pfull) or not np.isfinite(PA[k, 3]) or not np.isfinite(PA[k + 1, 0]): continue
        tier = "thin" if liq30[i] < THIN_LIQ else "mid"
        case = "both" if (pc_rule[i] and x20[i]) else ("percoin" if pc_rule[i] else "x20")
        # the study's own measure: spot return from the print's close, minus the market's
        j24 = i + 24
        fwd24 = c[j24] / c[i] - 1 if j24 < len(c) and np.isfinite(c[j24]) else np.nan
        m24 = mkt_fwd(t, 24)          # the market from the same close (the print bar closes at t + 1h)
        fr = F_r[F_t <= t + STEP]; last_fr = float(fr[-1]) if len(fr) else np.nan
        prints.append((coin, t, tier, case, fwd24, m24, fwd24 - m24, last_fr))
        for (entry, off), stop, hold, late in itertools.product(ENTRIES, STOPS, HOLDS, (False, True)):
            r = simulate(k, P, F_t, F_r, entry, off, stop, hold, late, SLIP[tier])
            if r is None: continue
            key = dict(coin=coin, t=t, tier=tier, case=case, entry=entry, stop=stop or 0.0, hold=hold, late=late)
            if r[0] == "nofill":
                rows.append({**key, "filled": False}); continue
            ei, xi, e_px, x_px, reason, cost, funding, mae = r
            gross = (e_px - x_px) / e_px
            tb_in, tb_out = btc_map.get(int(pfull[ei])), btc_map.get(int(pfull[xi]))
            btc_ret = (btc_c[tb_out] / btc_o[tb_in] - 1) if (tb_in is not None and tb_out is not None) else np.nan
            rows.append({**key, "filled": True, "t_in": int(pfull[ei]), "t_out": int(pfull[xi]) + STEP, "entry_px": e_px, "exit_px": x_px,
                         "reason": reason, "gross": gross, "cost": cost, "funding": funding, "net": gross - cost + funding,
                         "mae": mae, "btc": btc_ret})
    if (fi + 1) % 50 == 0: print(f"  {fi + 1}/{len(files)} coins, {len(prints):,} prints", flush=True)

T = pd.DataFrame(rows); PR = pd.DataFrame(prints, columns=["coin", "t", "tier", "case", "fwd24", "mkt24", "exc24", "last_funding"])
T.to_pickle("trades.pkl"); PR.to_pickle("prints.pkl")
print(f"{len(PR):,} prints on {PR.coin.nunique()} coins; {len(T):,} simulated rows")
