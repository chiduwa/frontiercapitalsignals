"""Catalogue every low-cap explosion: a close >= 3x the lowest close of the prior 60 days, where the
coin was in the bottom 40% of Binance market caps on that low. One episode per coin per 90 days
(largest multiple kept). For each: catalysts in [trough-14d, peak], regime at the trough, the coin's
feature percentiles at the trough vs same-day low-cap peers, and what happened 90 days after the peak.
Output: results/episodes.csv + printed summary."""
import os, json
import numpy as np, pandas as pd
from common import RAW, OUT

F = pd.read_parquet(os.path.join(RAW, 'daily_features.parquet'))
F['date'] = pd.to_datetime(F.date)
F['mcap_pct'] = F.groupby('date').mcap.rank(pct=True)
E = pd.read_parquet(os.path.join(RAW, 'events.parquet'))
cats = json.load(open(os.path.join(RAW, 'cmc_tags.json')))
flags = json.load(open(os.path.join(RAW, 'cmc_flags.json')))
breadth = F[F.age >= 120].groupby('date').mom_30.apply(lambda s: (s > 0).mean())

eps = []
for a, s in F.groupby('asset'):
    s = s.set_index('date').sort_index()
    c = s.close
    lo = c.rolling(60, min_periods=20).min()
    mult = c / lo
    cand = mult[mult >= 3]
    if cand.empty:
        continue
    used = []
    for pdate in cand.sort_values(ascending=False).index:
        if any(abs((pdate - u).days) < 90 for u in used):
            continue
        win = c.loc[pdate - pd.Timedelta(days=60):pdate]
        tdate = win.idxmin()
        if not (s.mcap_pct.get(tdate, np.nan) <= 0.4):
            continue
        used.append(pdate)
        after = c.loc[pdate:pdate + pd.Timedelta(days=90)]
        ev = E[(E.sym == s.sym.iloc[0]) & (E.date >= tdate - pd.Timedelta(days=14)) & (E.date <= pdate)]
        eps.append(dict(asset=a, sym=s.sym.iloc[0], trough=tdate, peak=pdate, days=(pdate - tdate).days,
                        mult=c[pdate] / c[tdate], mcap_trough=s.mcap.get(tdate), cat=cats.get(s.sym.iloc[0], 'other'),
                        dwf=(flags.get(s.sym.iloc[0]) or {}).get('dwf'),
                        after90=after.iloc[-1] / c[pdate] - 1 if len(after) > 30 else np.nan,
                        breadth=breadth.get(tdate), events=';'.join(sorted(set(ev.kind))),
                        event_titles=' | '.join(ev[ev.kind != 'bn_support'].title.head(3))))
P = pd.DataFrame(eps).sort_values('peak')
P.to_csv(os.path.join(OUT, 'episodes.csv'), index=False)
pd.set_option('display.width', 250)
pd.set_option('display.max_colwidth', 80)
print('episodes', len(P), 'coins', P.sym.nunique())
print('by year:', P.peak.dt.year.value_counts().sort_index().to_dict())
print('median multiple', round(P.mult.median(), 2), '; median days trough->peak', P.days.median(),
      '; median return 90d after peak', round(P.after90.median(), 3), '; share recovering >=0 after peak', round((P.after90 >= 0).mean(), 3))
print('category share of episodes vs share of low-cap coin-days:')
F['cat'] = F.sym.map(lambda s: cats.get(s, 'other'))
base = F[F.mcap_pct <= 0.4].cat.value_counts(normalize=True)
print(pd.DataFrame({'episodes': P.cat.value_counts(normalize=True), 'lowcap_days': base}).round(3).sort_values('episodes', ascending=False).to_string())
for k in ('upbit_krw', 'bn_perp', 'bn_perp_ann', 'bn_monitoring', 'bn_delist', 'bn_support', 'upbit_caution'):
    print(f'episodes with {k} between trough-14d and peak: {P.events.str.contains(k).mean():.3f}')
print('episodes with no catalogued event:', round((P.events == '').mean(), 3))
print('breadth at trough: episodes median', round(P.breadth.median(), 3), 'vs all days median', round(breadth.median(), 3))
print('\nRecent episodes (2024+):')
print(P[P.peak >= '2024-01-01'][['sym', 'trough', 'peak', 'days', 'mult', 'mcap_trough', 'cat', 'after90', 'events', 'event_titles']]
      .assign(mcap_trough=lambda x: (x.mcap_trough / 1e6).round(1), mult=lambda x: x.mult.round(1), after90=lambda x: x.after90.round(2))
      .to_string(index=False))
