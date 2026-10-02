"""Summarise daytop_alerts.pkl: per reference hour and zone multiplier, pooled
over the coins, the alert's quality on real bars, and real (closes) against
the random-sign copies (closes)."""
import numpy as np, pandas as pd
from stats_util import nw_mean
from daytop import DATA

T = pd.read_pickle(f"{DATA}/daytop_alerts.pkl")


def pooled_fade_t(sub):
    s = pd.concat(list(sub._fade))
    daily = s.groupby(s.index.normalize()).mean()
    m, t, n = nw_mean(daily.values, lags=1)
    return m * 1e4, t


def table(per, k, side):
    rows = []
    for R in range(24):
        sub = T[(T.R == R) & (T.k == k) & (T.side == side) & (T.per == per)]
        if sub.empty: continue
        w = sub.n / sub.n.sum()
        fade, ft = pooled_fade_t(sub)
        rows.append(dict(R=R, coins=len(sub), alerts_per_day=(sub.rate).mean(), near=(sub.near * w).sum(), further_u=(sub.further_u * w).sum(),
                         fade_bp=fade, fade_t=ft, hour=(sub.hour * w).sum(),
                         near_edge=((sub.near_c - sub.near_null) * w).sum(), fade_edge=((sub.fade_c - sub.fade_null) * w).sum(),
                         rate_edge=(sub.rate_c - sub.rate_null).mean()))
    return pd.DataFrame(rows).set_index("R")


pd.set_option("display.width", 220)
for side in ("top", "bottom"):
    for k in (0.75, 1.0, 1.25):
        for per in ("A", "B"):
            t = table(per, k, side)
            print(f"\n## {side} alerts, zone = open x exp({'+' if side == 'top' else '-'}{k} x typical excursion), period {per}")
            print("   near = share of alerts within a quarter of a typical excursion of the window's actual extreme;")
            print("   further_u = median further move after the alert, in typical excursions; fade = window close vs alert price (bp, + = price came back);")
            print("   *_edge = real minus random-sign copies (closes only)")
            print(t.round(3).to_string())
