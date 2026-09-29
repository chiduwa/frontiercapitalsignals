"""A small capped book of exhaustion shorts: only prints where funding was
not already negative, market entry, 15% stop, 24h exit; margin a fixed share
of equity, one position per coin, a cap on open positions."""
import pandas as pd, numpy as np
PR = pd.read_pickle("prints.pkl"); T = pd.read_pickle("trades.pkl")
SPLIT = int(pd.Timestamp("2025-05-29").value // 10**6); DAY = 86_400_000
PR = PR.sort_values(["coin", "t"]); keep, last = [], {}
for c, t in PR[["coin", "t"]].itertuples(index=False):
    f = c not in last or t - last[c] >= DAY; keep.append(f)
    if f: last[c] = t
PR["fresh"] = keep
X = T[T.filled].merge(PR[["coin", "t", "fresh", "last_funding"]], on=["coin", "t"])
X = X[X.fresh & (X.last_funding >= 0) & (X.entry == "mkt") & (X.stop == 0.15) & (X.hold == 24)]
X["half"] = np.where(X.t < SPLIT, 1, 2)
def portfolio(ev, L, frac, maxpos):
    ev = ev.sort_values("t_in"); eq, open_, curve, n = 1.0, [], [(ev.t_in.min(), 1.0)], 0
    for r in ev.itertuples(index=False):
        still = []
        for o in sorted(open_):
            if o[0] <= r.t_in: eq += o[1] * o[2]; curve.append((o[0], eq))
            else: still.append(o)
        open_ = still
        if len(open_) >= maxpos or any(o[3] == r.coin for o in open_): continue
        roi = -1.0 if r.mae >= 1.0 / L - 0.01 else max(r.net * L, -1.0)
        open_.append((r.t_out, frac * eq, roi, r.coin)); n += 1
    for o in sorted(open_): eq += o[1] * o[2]; curve.append((o[0], eq))
    c = np.array([e for _, e in curve]); dd = (c / np.maximum.accumulate(c) - 1).min()
    yrs = (ev.t_out.max() - ev.t_in.min()) / DAY / 365.25
    return eq ** (1 / yrs) - 1, dd, n / (yrs * 12)
print("Capped sleeve: exhaustion shorts, only when funding >= 0 at the print, market entry, 15% stop, 24h exit")
for late in (False, True):
    for (L, frac, mx) in ((2, 0.02, 3), (2, 0.02, 5), (3, 0.02, 5)):
        out = []
        for h in (1, 2):
            cagr, dd, pm = portfolio(X[(X.late == late) & (X.half == h)], L, frac, mx)
            out.append(f"H{h} {cagr*100:+.1f}%/yr of the account, worst drawdown {dd*100:.0f}%, {pm:.0f} trades/month")
        print(f"  {'an hour late' if late else 'on time     '} {L}x, {frac*100:.0f}% margin a trade, <= {mx} open: " + " | ".join(out))
