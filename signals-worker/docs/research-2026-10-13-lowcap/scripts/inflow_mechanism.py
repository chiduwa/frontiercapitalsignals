"""Mechanism check for 'small inflows move low caps a lot':
1) contemporaneous: 30d return vs 30d net taker flow / mcap, slope by size tercile (all Binance pairs);
2) predictability of the SIGN of next-30d net flow (direction of inflow) from today's features."""
import os
import numpy as np, pandas as pd
from analyze import nw_t
from common import RAW, OUT

F = pd.read_parquet(os.path.join(RAW, 'daily_features.parquet'))
F['date'] = pd.to_datetime(F.date)
anchors = pd.date_range('2019-01-01', F.date.max(), freq='14D')
P = F[F.date.isin(anchors) & (F.age >= 120) & F.mcap.notna() & (F.dead_days_30 < 10)].copy()
P['mcap_pct'] = P.groupby('date').mcap.rank(pct=True)
P['size'] = pd.cut(P.mcap_pct, [0, 0.4, 0.7, 1.0], labels=['low40', 'mid30', 'top30'])
P['fret30'] = P.groupby('asset').close.shift(-1)  # placeholder, replaced below
c = F.set_index(['asset', 'date']).close
P['fret30'] = [c.get((a, d + pd.Timedelta(days=30)), np.nan) / x - 1 for a, d, x in zip(P.asset, P.date, P.close)]
P = P[np.isfinite(P.fret30) & np.isfinite(P.fwd_net_flow_30)]
print('1) Same-window link: 30d log return on 30d net taker flow (% of mcap), per-date slope, by size')
for s, g in P.groupby('size', observed=True):
    sl = []
    for d, h in g.groupby('date'):
        x, y = h.fwd_net_flow_30.clip(-0.5, 0.5) * 100, np.log1p(h.fret30.clip(-0.95, 10))
        if len(h) > 15 and x.std() > 0:
            sl.append(np.cov(x, y)[0, 1] / x.var())
    t, n = nw_t(sl, 2)
    print(f'   {s}: +1% of mcap net buying -> {np.mean(sl)*100:+.2f}% price (log), t={t:.1f}, dates={n}; median |net flow| {g.fwd_net_flow_30.abs().median()*100:.2f}% of mcap')
L = P[P['size'] == 'low40'].copy()
L['flow_up'] = (L.fwd_net_flow_30 > 0).astype(float)
print('\n2) Low caps: does today predict the SIGN of next-30d net buying? (top-minus-bottom quintile of P(flow>0), NW t)')
from analyze import quintile_spread
for f in ['net_flow_7', 'net_flow_30', 'taker_buy_7', 'taker_buy_chg', 'mom_7', 'mom_30', 'vol_surge_7_90', 'amihud_30', 'log_mcap', 'dd_365', 'vol_30']:
    q = quintile_spread(L, f, 'flow_up')
    t, n = nw_t(q.spread, 2)
    print(f'   {f:16s} top {q.top.mean():.3f} bottom {q.bot.mean():.3f} base {q.base.mean():.3f} spread {q.spread.mean():+.3f} t={t:+.2f}')
