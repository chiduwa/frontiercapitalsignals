"""Big moves by weekday, and Mondays after a quiet vs a busy Sunday. Reads
frames.pkl written by study_volume.py."""
import numpy as np, pandas as pd
frames = pd.read_pickle('frames.pkl')
for name in ('MARKET', 'BTC'):
    d = frames[name].dropna(subset=['big', 'r', 'rv30']).copy()
    d['move_day'] = d.index.day_name()   # day D, whose move is measured; volume read covers D-1
    t = d.groupby('move_day').agg(days=('big', 'size'), big_rate=('big', 'mean'),
                                  move_vs_usual=('size', lambda s: np.exp(s).median()), share_below_60B=('low60', 'mean'))
    t = t.reindex(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'])
    print(name, '(volume read at the start of each day = the previous day)'); print(t.round(3).to_string())
    y26 = d.loc['2026']
    print(f'  2026: days that start with total volume < $60B: {int(y26.low60.sum())}, of which Sat/Sun/Mon starts: '
          f'{int(y26[y26.index.dayofweek.isin([5, 6, 0])].low60.sum())}')
    mon = d[d.index.dayofweek == 0]
    wk = mon.rel <= mon.rel.median()
    print(f'  Mondays after the quieter half of Sundays: big {mon[wk].big.mean():.3f} (n={wk.sum()}) '
          f'vs busier half {mon[~wk].big.mean():.3f} (n={(~wk).sum()})')
