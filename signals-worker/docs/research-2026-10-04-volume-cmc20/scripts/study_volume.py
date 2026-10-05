"""Does low total crypto volume (CMC adjusted 24h) predict what the market does next?

Daily, 2022-01-10 onward (CMC's adjusted-volume method changed the week of
2022-01-09; earlier values are a different series). The value stamped D 00:00
covers day D-1, so it is known before day D starts: no look-ahead.

Outcomes, for the whole market (CMC total market cap) and BTC/ETH/SOL:
  size      log(|r_D| / rv30)            next-day move vs its own usual size
  big       |r_D| > 2 * rv30             a sudden swing
  swing_h   max |cum return| over D..D+h-1, / (rv30 * sqrt(h))
  dir_h     cumulative return over D..D+h-1
Controls: log(rv7/rv30), log(|r_D-1|/rv30), weekday dummies, and (OOS) the
GARCH(1,1)+weekday forecast that production already uses for size.
Inference: Newey-West (HAC) with lags = h + 5.
"""
import json, sys
import numpy as np, pandas as pd
import statsmodels.api as sm

START = '2022-01-10'
pd.set_option('display.width', 200)


def load_global():
    g = pd.DataFrame(json.load(open('cmc_global_daily.json')))
    g['ts'] = pd.to_datetime(g.ts).dt.tz_localize(None)
    g = g.set_index('ts').sort_index()
    g = g[~g.index.duplicated()]
    # Single-day glitches (Terra and FTX weeks): adjusted volume far off its own fortnight.
    med = g.vol.rolling(15, center=True, min_periods=5).median()
    bad = (g.vol / med > 3) | (g.vol / med < 1 / 3)
    g.loc[bad, 'vol'] = np.nan
    return g, int(bad[g.index >= START].sum())


def load_binance(sym):
    k = json.load(open(f'bn_{sym}USDT_1d.json'))
    d = pd.DataFrame(k, columns=['t', 'o', 'h', 'l', 'c', 'qv'])
    d['ts'] = pd.to_datetime(d.t, unit='ms')
    return d.set_index('ts').sort_index()


def hac(y, X, lags):
    m = sm.OLS(y, sm.add_constant(X), missing='drop').fit(cov_type='HAC', cov_kwds={'maxlags': lags})
    return m


def build(g, ret, name):
    """ret: daily log return of day D indexed by D (00:00)."""
    df = pd.DataFrame(index=g.index)
    df['vol'] = g.vol
    df['lv'] = np.log(g.vol)
    df['r'] = ret.reindex(df.index)
    df = df[df.index >= '2021-11-01']
    r = df.r
    df['rv30'] = np.sqrt((r.shift(1) ** 2).rolling(30, min_periods=25).mean())
    df['rv7'] = np.sqrt((r.shift(1) ** 2).rolling(7, min_periods=6).mean())
    df['x_rv'] = np.log(df.rv7 / df.rv30)
    df['x_last'] = np.log(np.abs(r.shift(1)) / df.rv30 + 1e-3)
    # Volume relative to its own trailing month (snapshots D-30..D-1 exclude today's).
    df['rel'] = df.lv - df.lv.shift(1).rolling(30, min_periods=25).median()
    df['low60'] = (df.vol < 60e9).astype(float)
    # Bottom quintile of rel, cut on TRAILING data only (expanding, from 120 obs).
    q = df.rel.expanding(120).quantile(0.2).shift(1)
    df['lowq'] = (df.rel <= q).astype(float).where(q.notna())
    df['dow'] = df.index.dayofweek
    for d in range(1, 7):
        df[f'd{d}'] = (df.dow == d).astype(float)
    df['size'] = np.log(np.abs(r) / df.rv30 + 1e-3)
    df['big'] = (np.abs(r) > 2 * df.rv30).astype(float)
    cum = r.fillna(0).cumsum()
    for h in (1, 3, 7):
        fwd = pd.concat([cum.shift(-k) - cum.shift(1) for k in range(h)], axis=1)
        df[f'swing{h}'] = np.log(fwd.abs().max(axis=1) / (df.rv30 * np.sqrt(h)) + 1e-3)
        df[f'dir{h}'] = (cum.shift(-(h - 1)) - cum.shift(1)) * 100
    df = df[df.index >= START]
    df['name'] = name
    return df


WD = [f'd{d}' for d in range(1, 7)]


def report(df):
    out = []
    for pred in ('rel', 'lowq', 'low60'):
        for y, h in (('size', 1), ('big', 1), ('swing3', 3), ('swing7', 7), ('dir1', 1), ('dir3', 3), ('dir7', 7)):
            ctrl = ['x_rv', 'x_last'] + WD if not y.startswith('dir') else WD
            d = df[[y, pred] + ctrl].dropna()
            m = hac(d[y], d[[pred] + ctrl], lags=h + 5)
            out.append({'asset': df.name.iloc[0], 'pred': pred, 'y': y, 'n': len(d),
                        'beta': m.params[pred], 't': m.tvalues[pred]})
    return pd.DataFrame(out)


def raw_table(df):
    rows = []
    for flag in ('low60', 'lowq'):
        d = df.dropna(subset=[flag, 'r', 'rv30'])
        for v, part in d.groupby(flag):
            rows.append({'asset': df.name.iloc[0], 'flag': flag, 'value': int(v), 'days': len(part),
                         'mean_abs_move_pct': 100 * part.r.abs().mean(),
                         'move_vs_usual': np.exp(part['size']).median(),
                         'big_move_rate': part.big.mean(),
                         'next1_mean_pct': part.dir1.mean(), 'next7_mean_pct': part.dir7.mean(),
                         'next7_up_share': (part.dir7 > 0).mean()})
    return pd.DataFrame(rows)


if __name__ == '__main__':
    g, glitches = load_global()
    print(f'glitch days blanked since {START}: {glitches}')
    mret = np.log(g.mcap.shift(-1) / g.mcap)  # D 00:00 -> D+1 00:00
    sets = {'MARKET': mret}
    for s in ('BTC', 'ETH', 'SOL'):
        b = load_binance(s)
        sets[s] = np.log(b.c / b.o)
    frames = {k: build(g, v, k) for k, v in sets.items()}
    res = pd.concat([report(f) for f in frames.values()])
    raw = pd.concat([raw_table(f) for f in frames.values()])
    pd.to_pickle(frames, 'frames.pkl')
    print('\n=== raw: low-volume days vs the rest ===')
    print(raw.round(3).to_string(index=False))
    print('\n=== HAC regressions (controls: recent vol, last move, weekday) ===')
    print(res.pivot_table(index=['pred', 'y'], columns='asset', values='t').round(2).to_string())
    print('\nbetas:')
    print(res.pivot_table(index=['pred', 'y'], columns='asset', values='beta').round(4).to_string())
    res.to_csv('volume_regressions.csv', index=False); raw.to_csv('volume_raw.csv', index=False)
