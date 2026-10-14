"""The owner's hypothesis, stated as rules a person could check at a checkpoint.

"If volume keeps rising or stays high after the exhaustion alert, the coin keeps going up."
At checkpoint k (hours after the alert close), using only what is visible then:
  HOT     volume over the last 3 hours still >= 10x the pre-alert 48h baseline
  RISING  volume in the second half of the window >= the first half
  HOLD    price at or above the alert close
  HOT+HOLD, RISING+HOLD   the hypothesis as stated
  BREAKOUT  traded above the alert bar's high and closes within 5% of the post-alert high
Each rule vs every other episode-first alert at the same checkpoint, both periods.
Forward from the checkpoint close: up-first (+20% before -20%), further peak and hours to
it, median returns 1/3/7 days, share below the checkpoint price, 3d log vs market (t).
"""
import numpy as np, pandas as pd
from common import load, cmean, cdiff, pct

D = load(with_perp=False)
D = D[D['first']].copy()
D['up20'] = (D.fp20 == 'up').astype(float).where(D.fp20.notna())
RULES = {
    'HOT': lambda X: X.v_last3_k >= 10,
    'RISING': lambda X: X.v_trend_k >= 1,
    'HOLD': lambda X: X.p_k >= 0,
    'HOT+HOLD': lambda X: (X.v_last3_k >= 10) & (X.p_k >= 0),
    'RISING+HOLD': lambda X: (X.v_trend_k >= 1) & (X.p_k >= 0),
    'HOT+RISING+HOLD': lambda X: (X.v_last3_k >= 10) & (X.v_trend_k >= 1) & (X.p_k >= 0),
    'BREAKOUT': lambda X: X.new_high_k & (X.dd_k >= -0.05),
    'QUIET': lambda X: X.v_last3_k < 3,
}


def desc(Z):
    m, t, n = cmean(Z.x72, Z.day)
    return (f'n {len(Z):5}  up-first {Z.up20.mean():.0%}  peak {pct(Z.fpeak.median())} @{Z.fpeak_h.median():4.0f}h  '
            f'1d {pct(Z.f24.median())} 3d {pct(Z.f72.median())} 7d {pct(Z.f168.median())}  below@7d {np.mean(Z.f168.dropna() < 0):.0%}  '
            f'peak>=+50% {np.mean(Z.fpeak.dropna() >= .5):.0%}  3d vs mkt {m:+.3f} (t {t:+.1f})')


out = []
for k in (2, 4, 8, 12, 24, 48):
    X = D[D.k == k]
    out.append(f'\n######## +{k}h after the alert close')
    for per in ('disc', 'val'):
        out.append(f'  [{per}] all      {desc(X[X.period == per])}')
    for name, f in RULES.items():
        for per in ('disc', 'val'):
            Y = X[X.period == per]
            msk = f(Y).fillna(False).astype(bool)
            if msk.sum() < 20:
                out.append(f'  [{per}] {name:15} n {int(msk.sum())} (too few)')
                continue
            dx, tx = cdiff(Y.x72, msk.astype(float), Y.day)
            du, tu = cdiff(Y.up20, msk.astype(float), Y.day)
            out.append(f'  [{per}] {name:15} share {msk.mean():4.0%}  {desc(Y[msk])}')
            out.append(f'  [{per}] {"   vs rest":15}            3d vs mkt {dx:+.3f} (t {tx:+.1f}), up-first {du:+.2f} (t {tu:+.1f})')
print('\n'.join(out))
