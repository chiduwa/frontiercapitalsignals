"""D. Anatomy of the runners: episode-first alerts whose price went >= +50% above the alert
close within 30 days, against those that went +20-50% and those that did not.

For each: size and timing of the 30-day peak; after the peak, how much is given back and how
long until a close below the alert close; volume at the peak; whether a later pushed
exhaustion print sits within 6 hours of the peak (does a second print mark the top?), and,
for every later print in a run, how close it was to that run's eventual peak.
"""
import os
import numpy as np, pandas as pd
from common import load, pct, RAW
from paths import grid, G0, H

D = load(with_perp=False)
A = D[(D.k == 0) & D['first'] & D.period.isin(['disc', 'val']) & D.peak30.notna()].copy()
P = pd.read_parquet(os.path.join(RAW, 'prints.parquet'))
P = P[P.pushed]
rows = []
for sym, g in A.groupby('symbol'):
    G = grid(pd.read_parquet(os.path.join(RAW, f'spot1h/{sym}.parquet')))
    c, hi, qv = G['close'], G['high'], G['quote_volume']
    last = int(np.flatnonzero(~np.isnan(c))[-1])
    pidx = np.sort(((P[P.symbol == sym].open_time.values - G0) // H).astype(int))
    for r in g.itertuples():
        a = int((r.ts.value // 10**6 - G0) // H)
        C0 = c[a]
        e = min(a + 720, last)
        j = a + int(np.nanargmax(hi[a + 1:e + 1])) + 1          # peak hour
        rec = {'symbol': sym, 'ts': r.ts, 'period': r.period, 'peak30': r.peak30, 'peak_h': j - a}
        post = c[j + 1:min(j + 721, last) + 1]
        lo_post = np.nanmin(G['low'][j + 1:min(j + 721, last) + 1]) if len(post) else np.nan
        rec['giveback'] = lo_post / hi[j] - 1 if len(post) else np.nan               # from the peak high
        below = np.flatnonzero(post < C0)
        rec['h_peak_to_below'] = int(below[0]) + 1 if len(below) else np.nan
        rec['below_after_peak'] = bool(len(below)) if len(post) >= 720 or not r.listed_now else np.nan
        rec['r_peak_plus7d'] = c[min(j + 168, last)] / C0 - 1
        rec['vol_at_peak'] = np.nanmax(qv[max(a + 1, j - 3):j + 4]) / r.base48
        later = pidx[(pidx > a) & (pidx <= e)]
        rec['n_later'] = len(later)
        rec['print_near_peak'] = bool(np.any(np.abs(later - j) <= 6))
        # for each later print: hours before the peak (negative = after the peak) and price vs alert close
        rec['later_gap'] = list(j - later)
        rows.append(rec)
R = pd.DataFrame(rows)
R['cls'] = np.where(R.peak30 >= .5, 'runner50', np.where(R.peak30 >= .2, 'run20-50', 'fade'))
out = []
for per in ('disc', 'val'):
    X = R[R.period == per]
    out.append(f'\n=== {per}: {len(X)} episode-first alerts')
    for cl in ('runner50', 'run20-50', 'fade'):
        Y = X[X.cls == cl]
        ph = Y.peak_h / 24
        out.append(f'  {cl:9} {len(Y) / len(X):4.0%} (n {len(Y)}): peak median {pct(Y.peak30.median())} (p75 {pct(Y.peak30.quantile(.75))}), '
                   f'days to peak median {ph.median():.1f} (p25 {ph.quantile(.25):.1f}, p75 {ph.quantile(.75):.1f})')
        out.append(f'            after the peak: gives back median {pct(Y.giveback.median())} from the high; back below the alert close within 30d of the peak '
                   f'{Y.below_after_peak.dropna().mean():.0%}, median {Y.h_peak_to_below.median() / 24:.1f} days after the peak; 7d after the peak {pct(Y.r_peak_plus7d.median())} vs alert close')
        out.append(f'            volume around the peak (max hour, x pre-alert baseline): median {Y.vol_at_peak.median():.1f}x; '
                   f'later pushed prints: {Y.n_later.mean():.1f} per alert; a later print within 6h of the peak {Y.print_near_peak.mean():.0%}')
    # later prints in a run: where do they sit relative to the eventual 30d peak?
    gaps = np.concatenate([np.array(x, float) for x in X.later_gap if len(x)])
    out.append(f'  every later print in the 30d window (n {len(gaps)}): within 6h of the eventual peak {np.mean(np.abs(gaps) <= 6):.0%}, '
               f'before the peak by >6h {np.mean(gaps > 6):.0%}, after the peak by >6h {np.mean(gaps < -6):.0%}')
    rn = X[X.cls == 'runner50']
    g2 = np.concatenate([np.array(x, float) for x in rn.later_gap if len(x)])
    out.append(f'  ... on runners only (n {len(g2)}): within 6h of the peak {np.mean(np.abs(g2) <= 6):.0%}, before >6h {np.mean(g2 > 6):.0%}, after >6h {np.mean(g2 < -6):.0%}')
R.drop(columns=['later_gap']).to_parquet(os.path.join(RAW, 'anatomy.parquet'), index=False)
print('\n'.join(out))
