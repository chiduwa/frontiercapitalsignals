"""Does growing profit predict returns, and is it strongest in small/mid caps?

Point-in-time quarterly test, 2016-2026.
  * Formation date F = calendar quarter end + 105 days, so every filer's
    10-Q (45d) and even a late non-accelerated 10-K (90d) is public by F.
    Only quarters that ended by then are used.
  * Buckets by market cap at F: micro <$300M, small $300M-$2B, mid $2B-$10B,
    large >=$10B. Cap at F = today's share count x the split-adjusted price
    at F (the price series has no split events); share issuance since F makes
    this approximate, symmetrically for every group.
  * Filters at F, identical for every group: price >= $2 and median weekly
    dollar volume over the prior 13 weeks >= $2.5M (~$500K/day).
  * Outcome: price return F -> F+13w (next formation, non-overlapping), plus
    26w and 52w. Excess = group mean minus the mean of EVERY stock in the same
    bucket that passed the same filters (equal-weight).
  * Known biases, both against the finding: (1) only companies still listed
    today are in the data, and the delisted ones are disproportionately the
    unprofitable, so the benchmark is flattered; (2) prices exclude dividends,
    which profitable companies pay and unprofitable ones do not.
"""
import glob, json, os, sys
from datetime import date, timedelta
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
F = pd.read_pickle(os.path.join(HERE, "fundamentals.pkl"))
U = pd.DataFrame(json.load(open(os.path.join(HERE, "universe.json"))))
U["price_now"] = U.price.map(lambda s: float(str(s).replace("$", "").replace(",", "") or "nan") if s else np.nan)
U["shares_now"] = U.mcap / U.price_now
cik_to_sym = {}
for r in U.itertuples():
    cik_to_sym.setdefault(r.cik, r.symbol)   # first listed class per company

# weekly prices
px = {}
for path in glob.glob(os.path.join(HERE, "pxn", "*.json")):
    d = json.load(open(path))
    if len(d["d"]) < 30: continue
    s = os.path.basename(path)[:-5]
    px[s] = (np.array(d["d"], dtype="datetime64[D]"), np.array(d["c"], float), np.array(d["dv"], float))
print(f"price series: {len(px):,}; companies with fundamentals & ticker: {sum(1 for c in F.cik.unique() if cik_to_sym.get(c) in px):,}")

def price_at(sym, when):
    if sym not in px: return np.nan
    d, c, _ = px[sym]
    i = np.searchsorted(d, np.datetime64(when), side="right") - 1
    if i < 0: return np.nan
    # stale guard: the price must be from within 10 days of the date asked
    if (np.datetime64(when) - d[i]).astype(int) > 10: return np.nan
    return c[i]

def liquidity_at(sym, when):
    d, c, dv = px[sym]
    i = np.searchsorted(d, np.datetime64(when), side="right")
    w = dv[max(0, i - 13):i]
    return np.median(w) if len(w) >= 8 else np.nan

def q_end(k):
    y, q = divmod(k, 4)
    m = 3 * (q + 1)
    nxt = date(y + (m == 12), (m % 12) + 1, 1)
    return nxt - timedelta(days=1)

BUCKETS = [("micro", 0, 3e8), ("small", 3e8, 2e9), ("mid", 2e9, 1e10), ("large", 1e10, 1e15)]
def bucket(mcap):
    for name, lo, hi in BUCKETS:
        if lo <= mcap < hi: return name
    return None

by_cik = {}
for cik, g in F.groupby("cik"):
    if cik_to_sym.get(cik) not in px: continue
    by_cik[cik] = {int(q): (a, b, c) for q, a, b, c in zip(g.cq, g.ni, g.rev, g.oi)}
shares_now = dict(zip(U.symbol, U.shares_now))
latest_px = max(d[-1] for d, _, _ in px.values())
k_first = 2016 * 4 + 3        # Q4 2016 -> formed mid-April 2017 (needs 8 quarters inside the price window)
k_last = int(F.cq.max())
records = []
for k in range(k_first, k_last + 1):
    form = q_end(k) + timedelta(days=105)
    if np.datetime64(form) > latest_px: break
    fwd = {h: form + timedelta(weeks=h) for h in (13, 26, 52)}
    for cik, g in by_cik.items():
        sym = cik_to_sym.get(cik)
        if sym not in px: continue
        last = k if k in g else (k - 1 if (k - 1) in g else None)
        if last is None: continue                     # filer has gone quiet
        want = range(last, last - 8, -1)              # newest first
        if not all(q in g for q in want): continue
        ni = np.array([g[q][0] for q in want], float)
        rev = np.array([np.nan if g[q][1] is None else g[q][1] for q in want], float)
        oi = np.array([np.nan if g[q][2] is None else g[q][2] for q in want], float)
        p0 = price_at(sym, form)
        if not (p0 >= 2): continue
        liq = liquidity_at(sym, form)
        if not (liq >= 2.5e6): continue
        sh = shares_now.get(sym)
        if not (sh and np.isfinite(sh)): continue
        mcap = sh * p0
        b = bucket(mcap)
        ttm, prev = ni[:4].sum(), ni[4:8].sum()
        rttm = np.nansum(rev[:4]) if np.isfinite(rev[:4]).all() else np.nan
        rprev = np.nansum(rev[4:8]) if np.isfinite(rev[4:8]).all() else np.nan
        ottm = oi[:4].sum() if np.isfinite(oi[:4]).all() else np.nan
        oprev = oi[4:8].sum() if np.isfinite(oi[4:8]).all() else np.nan
        rec = {
            "k": k, "form": form.isoformat(), "sym": sym, "bucket": b, "mcap": mcap,
            "ttm": ttm, "prev": prev,
            "g": (ttm - prev) / abs(prev) if prev != 0 else np.nan,
            "yoy_pos": int(sum(ni[i] > ni[i + 4] for i in range(4))),
            "prof_q": int((ni[:4] > 0).sum()),
            "grev": rttm / rprev - 1 if (rprev and rprev > 0 and np.isfinite(rttm)) else np.nan,
            "goi": (ottm - oprev) / abs(oprev) if (np.isfinite(ottm) and np.isfinite(oprev) and oprev != 0) else np.nan,
            "ottm": ottm, "oprev": oprev,
            "pe": mcap / ttm if ttm > 0 else np.nan,
        }
        for h, t in fwd.items():
            p1 = price_at(sym, t) if np.datetime64(t) <= latest_px else np.nan
            rec[f"r{h}"] = p1 / p0 - 1 if p1 > 0 else np.nan
        records.append(rec)
    print(f"  formed {form} (Q{k % 4 + 1} {k // 4}): {sum(1 for r in records if r['k'] == k):,} stocks", flush=True)

R = pd.DataFrame(records)
R.to_pickle(os.path.join(HERE, "panel.pkl"))
print(f"panel: {len(R):,} stock-quarters, {R.form.nunique()} formation dates")
