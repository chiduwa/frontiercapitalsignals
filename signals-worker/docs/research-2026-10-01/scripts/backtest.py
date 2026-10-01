"""Push policies for exhaustion warnings, judged as the user receives them.

Pushable print = what live-scan can push today: the 20x rule, or the per-coin
rule at volZ >= 4 (non-watch coins). Each policy decides which of those become
pushes. Every push is scored by the coin's 24h excess over the equal-weight
market (negative = the warning was right), day-clustered, per date half.

Selection discipline: every threshold is chosen on half A (before 2025-05-29);
half B is quoted, not optimised.
"""
import numpy as np, pandas as pd

E = pd.read_pickle("events_final.pkl").sort_values(["coin", "t"]).reset_index(drop=True)
E = E[E.exc24.notna()].copy()
E["day"] = pd.to_datetime(E.t, unit="ms").dt.floor("D")
E["half"] = np.where(E.day < pd.Timestamp("2025-05-29"), "A", "B")
E["pushable"] = (E.case != "percoin") | (E.volZ >= 4)
H = 3_600_000
SPAN_DAYS = (E.day.max() - E.day.min()).days + 1

def dct(x, d):
    s = pd.Series(np.asarray(x), index=np.asarray(d)).groupby(level=0).mean()
    return s.mean(), s.mean() / (s.std(ddof=1) / np.sqrt(len(s))) if len(s) > 2 else np.nan

def score(P, name):
    out = dict(policy=name, pushes=len(P), per_day=len(P) / SPAN_DAYS)
    for h in ("A", "B"):
        g = P[P.half == h]
        m, t = dct(g.exc24, g.day)
        out[f"{h}_mean"] = 100 * m; out[f"{h}_t"] = t
        out[f"{h}_med"] = 100 * g.exc24.median()
        out[f"{h}_hit"] = 100 * (g.exc24 < 0).mean()
        out[f"{h}_rip"] = 100 * (g.exc24 > 0.20).mean()
    return out

def policy(base, mode, arg=None):
    """mode: 'all' | 'cooldown' (hours) | 'escalate' (fraction above last push)"""
    keep = []
    for c, g in base.groupby("coin", sort=False):
        last_t, last_px = None, None
        for i, r in g.iterrows():
            if mode == "all": ok = True
            elif last_t is None or r.t - last_t > 72 * H: ok = True          # new episode
            elif mode == "cooldown": ok = r.t - last_t >= arg * H
            elif mode == "escalate": ok = r.px >= last_px * (1 + arg)
            else: raise ValueError(mode)
            if ok: keep.append(i); last_t, last_px = r.t, r.px
            elif mode == "cooldown": pass
            else: last_t = r.t if mode == "escalate" else last_t           # episode stays open while prints continue
    return base.loc[keep]

if __name__ == "__main__":
    pd.set_option("display.width", 250)
    base = E[E.pushable]

    # 1) market-cap ceiling, chosen on half A
    rows = []
    for cap in (None, 3e9, 2e9, 1e9, 5e8, 3e8, 2e8):
        P = base if cap is None else base[~(base.mcap_proxy > cap)]
        rows.append(score(P, f"mcap ceiling {'none' if cap is None else f'${cap/1e6:,.0f}M'}"))
    for cap in (1e9, 5e8, 3e8):
        X = base[base.mcap_proxy > cap]; rows.append(score(X, f"  (excluded: mcap > ${cap/1e6:,.0f}M)"))
    print("## market-cap ceiling\n" + pd.DataFrame(rows).round(2).to_string(index=False))

    # 2) push cadence within an episode (gaps <= 72h), with no ceiling and with the chosen one
    for label, B in (("no ceiling", base),):
        rows = [score(policy(B, "all"), "every print (one per coin-hour)")]
        for hrs in (6, 12, 24, 72):
            rows.append(score(policy(B, "cooldown", hrs), f"cooldown {hrs}h"))
        for x in (0.10, 0.20, 0.30, 0.50):
            rows.append(score(policy(B, "escalate", x), f"first + re-push at +{x:.0%} above last push"))
        rows.append(score(B[B.k_in_ep == 0], "first print of episode only"))
        print(f"\n## push cadence ({label})\n" + pd.DataFrame(rows).round(2).to_string(index=False))
    E.to_pickle("events_bt.pkl")
