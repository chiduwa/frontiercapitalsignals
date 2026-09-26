"""Exhaustion research, step 1: per-bar features and forward outcomes.

Reads the per-symbol hourly klines fetched by fetch_klines.py and writes:
  market.npz    equal-weight market index (hourly) + aggregate quote volume
  cand.pkl      candidate bars (rising bar with some volume lift) with every
                feature and forward outcome, plus a 1% random sample of all bars
                (flagged sample=1) as the unconditional reference.

Everything is computed from data at or before the bar (features) or strictly
after it (outcomes). Outcomes are measured from the bar's CLOSE, which is the
earliest moment the live scanner can act on a closed bar.
"""
import glob, os, sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, sys.argv[1] if len(sys.argv) > 1 else "k1h")
STEP = 3_600_000
HORIZONS = (4, 12, 24, 72, 168)
MIN_HISTORY_BARS = 720          # a listing's first month is its own regime
RET_CLIP = 0.5                  # per-bar return clip for the market index only

files = sorted(glob.glob(os.path.join(SRC, "*.npz")))
print(f"{len(files)} symbols")

# ---- pass 1: global hourly grid and the equal-weight market ----------------
t_min, t_max = None, None
for f in files:
    t = np.load(f)["t"]
    if len(t) == 0:
        continue
    t_min = t[0] if t_min is None else min(t_min, t[0])
    t_max = t[-1] if t_max is None else max(t_max, t[-1])
G = int((t_max - t_min) // STEP) + 1
ret_sum = np.zeros(G); ret_cnt = np.zeros(G); qv_sum = np.zeros(G)
for f in files:
    d = np.load(f)
    t, c, qv = d["t"], d["c"], d["qv"]
    if len(t) < MIN_HISTORY_BARS + 10:
        continue
    idx = ((t - t_min) // STEP).astype(np.int64)
    r = np.full(len(c), np.nan)
    # only consecutive hours produce a return
    consec = np.diff(idx) == 1
    r[1:][consec] = c[1:][consec] / c[:-1][consec] - 1
    r[:MIN_HISTORY_BARS] = np.nan
    ok = np.isfinite(r)
    np.add.at(ret_sum, idx[ok], np.clip(r[ok], -RET_CLIP, RET_CLIP))
    np.add.at(ret_cnt, idx[ok], 1)
    okq = np.isfinite(qv)
    np.add.at(qv_sum, idx[okq], qv[okq])
mkt_r = np.where(ret_cnt >= 30, ret_sum / np.maximum(ret_cnt, 1), 0.0)
mkt_logidx = np.concatenate([[0.0], np.cumsum(np.log1p(mkt_r[1:]))])
np.savez_compressed(os.path.join(HERE, "market.npz"), t0=t_min, step=STEP, logidx=mkt_logidx,
                    cnt=ret_cnt, qv=qv_sum)
print(f"market grid {G} hours, median symbols/hour {np.median(ret_cnt[ret_cnt>0]):.0f}")

def mkt_fwd(gidx, h):
    j = gidx + h
    out = np.full(len(gidx), np.nan)
    ok = j < G
    out[ok] = np.exp(mkt_logidx[j[ok]] - mkt_logidx[gidx[ok]]) - 1
    return out

# ---- pass 2: per-symbol features and outcomes -------------------------------
rng = np.random.default_rng(7)
parts = []
for k, f in enumerate(files):
    sym = os.path.basename(f)[:-4]
    d = np.load(f)
    if len(d["t"]) < MIN_HISTORY_BARS + 200:
        continue
    df = pd.DataFrame({k2: d[k2] for k2 in ("t", "o", "h", "l", "c", "qv", "n", "tbq")})
    # a complete hourly grid, so shift(h) is h hours
    full = np.arange(df.t.iloc[0], df.t.iloc[-1] + STEP, STEP)
    df = df.set_index("t").reindex(full)
    df.index.name = "t"
    o, h, l, c, qv, n, tbq = (df[x].to_numpy(dtype=float) for x in ("o", "h", "l", "c", "qv", "n", "tbq"))
    s_qv = pd.Series(qv); s_n = pd.Series(n)
    lr = np.log(pd.Series(c) / pd.Series(c).shift(1))
    sig = lr.shift(1).rolling(720, min_periods=360).std().to_numpy()
    med_qv48 = s_qv.shift(1).rolling(48, min_periods=24).median().to_numpy()
    med_n48 = s_n.shift(1).rolling(48, min_periods=24).median().to_numpy()
    lqv = np.log(s_qv.where(s_qv > 0))
    lqv_mu = lqv.shift(1).rolling(720, min_periods=360).mean().to_numpy()
    lqv_sd = lqv.shift(1).rolling(720, min_periods=360).std().to_numpy()
    tbr = tbq / np.where(qv > 0, qv, np.nan)
    tbr_mu = pd.Series(tbr).shift(1).rolling(720, min_periods=360).mean().to_numpy()
    hi168 = pd.Series(h).shift(1).rolling(168, min_periods=120).max().to_numpy()
    hi720 = pd.Series(h).shift(1).rolling(720, min_periods=500).max().to_numpy()
    c_s = pd.Series(c)
    run24 = (c_s / c_s.shift(24) - 1).to_numpy()
    run72 = (c_s / c_s.shift(72) - 1).to_numpy()
    # rally volume build-up: last 6 bars' mean volume against the prior 42
    vol6 = s_qv.rolling(6).mean().to_numpy()
    vol42 = s_qv.shift(6).rolling(42, min_periods=30).mean().to_numpy()
    # participation fading into a high: last 24h mean volume against the
    # prior 30 days' mean (the "buyers running out" form of exhaustion)
    vol24 = s_qv.rolling(24).mean().to_numpy()
    vol720 = s_qv.shift(24).rolling(720, min_periods=360).mean().to_numpy()
    rng_ = h - l
    with np.errstate(divide="ignore", invalid="ignore"):
        bar = c / o - 1
        barZ = np.log(c / o) / sig
        run24Z = np.log1p(run24) / (sig * np.sqrt(24))
        run72Z = np.log1p(run72) / (sig * np.sqrt(72))
        volZ = (np.log(qv) - lqv_mu) / lqv_sd
        ratio48 = qv / med_qv48
        tradeRatio = n / med_n48
        upperWick = (h - np.maximum(o, c)) / rng_
        clv = (c - l) / rng_
        vs7dHigh = c / hi168 - 1
        vs30dHigh = c / hi720 - 1
        build = vol6 / vol42
        fade = vol24 / vol720
    # outcomes from this bar's close
    gidx = ((df.index.to_numpy() - t_min) // STEP).astype(np.int64)
    out = {}
    for H in HORIZONS:
        fut_c = c_s.shift(-H).to_numpy()
        out[f"fwd{H}"] = fut_c / c - 1
        out[f"mkt{H}"] = mkt_fwd(gidx, H)
        fut_hi = pd.Series(h[::-1]).rolling(H, min_periods=H).max().to_numpy()[::-1]
        # max high over bars t+1..t+H
        fut_hi = np.concatenate([fut_hi[1:], [np.nan]])
        out[f"up{H}"] = fut_hi / c - 1
        out[f"top{H}"] = (fut_hi <= h).astype(float)
        out[f"top{H}"][~np.isfinite(fut_hi)] = np.nan
        fut_lo = pd.Series(l[::-1]).rolling(H, min_periods=H).min().to_numpy()[::-1]
        fut_lo = np.concatenate([fut_lo[1:], [np.nan]])
        out[f"dd{H}"] = fut_lo / c - 1
    # the next bar, for confirmation variants
    nxt_bar = np.concatenate([bar[1:], [np.nan]])
    feats = pd.DataFrame({
        "t": df.index.to_numpy(), "sym": sym, "bar": bar, "barZ": barZ, "ratio48": ratio48,
        "tradeRatio": tradeRatio, "volZ": volZ, "run24": run24, "run72": run72,
        "run24Z": run24Z, "run72Z": run72Z, "upperWick": upperWick, "clv": clv,
        "vs7dHigh": vs7dHigh, "vs30dHigh": vs30dHigh, "tbr": tbr, "tbrEx": tbr - tbr_mu,
        "liq": med_qv48, "sig": sig, "build": build, "fade": fade, "nextBar": nxt_bar,
        "age": np.arange(len(df)), **out,
    })
    valid = np.isfinite(c) & np.isfinite(o) & (feats.age >= MIN_HISTORY_BARS) & np.isfinite(sig) & np.isfinite(med_qv48)
    rising = c > o
    climax = rising & ((ratio48 >= 3) | (volZ >= 2.5))
    # near a 7-day high after a real run, whatever the volume: the pool the
    # fading-participation variants are drawn from
    near_high = (vs7dHigh >= -0.01) & (run72Z >= 1.5)
    cand = valid & (climax | near_high)
    samp = valid & (rng.random(len(df)) < 0.01)
    keep = cand | samp
    part = feats[keep].copy()
    part["cand"] = cand[keep].astype(np.int8)
    part["sample"] = samp[keep].astype(np.int8)
    for col in part.columns:
        if part[col].dtype == np.float64:
            part[col] = part[col].astype(np.float32)
    parts.append(part)
    if (k + 1) % 50 == 0:
        print(f"  {k + 1}/{len(files)} symbols, {sum(len(p) for p in parts):,} rows", flush=True)

allrows = pd.concat(parts, ignore_index=True)
allrows.to_pickle(os.path.join(HERE, "cand.pkl"))
print(f"wrote {len(allrows):,} rows ({int(allrows.cand.sum()):,} candidates, {int(allrows['sample'].sum()):,} reference sample)")
