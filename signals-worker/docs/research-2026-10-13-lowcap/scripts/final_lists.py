"""Turn ranking_<date>.csv into the published lists (markdown) - ranks, not probabilities, because
the walk-forward showed the probability LEVELS are miscalibrated (regime-driven) while the within-day
ORDER carries a modest, consistent edge."""
import os, sys, glob
import numpy as np, pandas as pd
from common import OUT

path = sorted(glob.glob(os.path.join(OUT, 'ranking_*.csv')))[-1]
asof = os.path.basename(path)[8:18]
R = pd.read_csv(path, index_col=0)
R['spike_rank'] = R.p_double_90d.rank(ascending=False, method='first').astype(int)
R['inflow_rank'] = R.p_inflow_30d.rank(ascending=False, method='first').astype(int)
R['already_running'] = (R.mom_30 >= 0.5) | ((R.mom_90 >= 1.0))
R['qv'] = np.expm1(R.log_qv30)


def fmt_m(x):
    return f'${x/1e6:.1f}M' if pd.notna(x) else ''


def fmt_k(x):
    return f'${x/1e3:.0f}k' if pd.notna(x) else ''


def korea(r):
    if r.upbit_krw_now:
        return 'Upbit KRW already'
    if isinstance(r.upbit_markets, str) and r.upbit_markets:
        return 'Upbit ' + r.upbit_markets.replace(',', '/') + ' only - KRW candidate'
    return 'Bithumb only' if r.bithumb_krw else 'not in Korea'


def table(df, cols):
    lines = ['| ' + ' | '.join(h for h, _ in cols) + ' |', '|' + '|'.join('---' for _ in cols) + '|']
    for _, r in df.iterrows():
        lines.append('| ' + ' | '.join(str(f(r)) for _, f in cols) + ' |')
    return '\n'.join(lines)


base_cols = [
    ('Rank', lambda r: r.spike_rank), ('Coin', lambda r: f"{r.sym.replace('USDT','')} ({r['name']})"),
    ('Category', lambda r: r['cat']), ('Mcap', lambda r: fmt_m(r.mcap)), ('30d', lambda r: f'{r.mom_30:+.0%}'),
    ('From ATH', lambda r: f'{r.dd_ath:.0%}'), ('$ to lift +20%', lambda r: fmt_k(r.usd_to_lift_20pct)),
    ('Binance $/day', lambda r: fmt_k(r.qv)), ('Inflow rank', lambda r: r.inflow_rank), ('Korea', korea),
    ('Backers', lambda r: ', '.join(b for b, k in (('DWF', 'dwf'), ('top VC', 'top_vc')) if r.get(k) == 1)),
    ('Flags', lambda r: r.red_flags if isinstance(r.red_flags, str) else ''),
]
E = R[R.eligible]
out = [f'Universe: {len(R)} Binance USDT low caps (bottom 40% by CMC market cap) as of {asof}; {int(R.eligible.sum())} eligible.']
out.append('\n### A. Spike watch - eligible, not already running (model order)\n')
out.append(table(E[~E.already_running].head(20), base_cols))
out.append('\n### B. Already running - high spike rank but late (30d >= +50% or 90d >= +100%)\n')
out.append(table(E[E.already_running].head(10), base_cols))
out.append('\n### C. Inflow watch - most likely 30d volume to triple (direction NOT forecast)\n')
out.append(table(E.sort_values('inflow_rank').head(12), base_cols))
out.append('\n### D. Upbit KRW candidates - already on Upbit BTC/USDT markets, no KRW pair yet\n')
out.append(table(E[(~E.upbit_krw_now) & E.upbit_markets.fillna('').str.len().gt(0)].head(15), base_cols))
out.append('\n### E. Avoid - Binance monitoring tag, Upbit warning/caution, fan tokens\n')
X = R[~R.eligible]
out.append(', '.join(f"{s.replace('USDT','')} ({(f.split(';')[0] if isinstance(f, str) and f else 'excluded')})" for s, f in zip(X.sym, X.red_flags)))
md = '\n'.join(out)
open(os.path.join(OUT, f'lists_{asof}.md'), 'w').write(md)
print(md)
