"""Exhaustion prints on spot 1h bars, exactly as production detects them.

features()/detect() are copied unchanged from the 2026-10-12 squeeze study
(reports/scenarios/2026-10-12-near-red/claude/code/prints.py), which replicates
worker.js surgeFeatures / calibratedSurge / surgeConfigMatches for exhaustion20 and
exhaustion_calibrated. pushed = e20, or calibrated with volZ >= 4
(CALIBRATED_BROADCAST_VOLZ in live-scan.mjs). The calibrated rule's $500M
market-cap ceiling is not replicated (no point-in-time market caps).

Output: RAW/prints.parquet, UP prints only, 2023-01-01 .. 2026-10-13, every symbol
in RAW/spot1h (delisted pairs included) with listed_now and first_bar (listing proxy).
"""
import glob, json, os
import numpy as np, pandas as pd

RAW = os.environ.get('RAW', os.path.join(os.path.dirname(__file__), '../../reports/scenarios/2026-10-14-followthrough/raw'))
CAL_H, CAL_MIN = 720, 360


def features(df):
    df = df.reset_index(drop=True).copy()
    qv = df.quote_volume.where(df.quote_volume > 0)
    tr = df['count'].where(df['count'] > 0)
    q48 = qv.shift(1).rolling(48, min_periods=24).quantile(0.5, interpolation='higher')
    t48 = tr.shift(1).rolling(48, min_periods=1).quantile(0.5, interpolation='higher')
    df['ratio'] = df.quote_volume / q48
    df['tradeRatio'] = df['count'] / t48
    df['barPct'] = (df.close / df.open - 1) * 100
    lv = np.log(qv)
    lr = np.log(df.close / df.close.shift(1))
    lvs, lrs = lv.shift(1), lr.shift(1)
    vm = lvs.rolling(CAL_H, min_periods=CAL_MIN).mean()
    vs = lvs.rolling(CAL_H, min_periods=CAL_MIN).std(ddof=1)
    rs = lrs.rolling(CAL_H, min_periods=CAL_MIN).std(ddof=1)
    df['volZ'] = (np.log(df.quote_volume.where(df.quote_volume > 0)) - vm) / vs
    df['barZ'] = np.log(df.close / df.open) / rs
    df['run24Z'] = np.log(df.close / df.close.shift(24)) / (rs * np.sqrt(24))
    df['liq30d'] = qv.shift(1).rolling(CAL_H, min_periods=CAL_MIN).quantile(0.5, interpolation='higher')
    df['hourVol'] = rs
    df['base48'] = q48          # the 48h volume baseline the 20x rule divides by
    return df


def detect(df):
    f = features(df)
    up = f.close > f.open
    e20 = (f.ratio >= 20) & (f.tradeRatio >= 2) & up & (f.barPct >= 5)
    cal = (f.volZ >= 3) & (f.barZ >= 3) & (f.run24Z >= 1.5) & up & (f.liq30d < 400_000)
    m = (e20 | cal).fillna(False)
    sub = f[m].copy()
    sub['e20'] = e20[m].values.astype(bool)
    sub['cal'] = cal[m].values.astype(bool)
    sub['bar_index'] = np.where(m)[0]
    return sub


def main():
    listed = json.load(open(os.path.join(RAW, 'symbols.json')))
    out = []
    for fn in sorted(glob.glob(os.path.join(RAW, 'spot1h/*.parquet'))):
        sym = os.path.basename(fn)[:-8]
        df = pd.read_parquet(fn)
        if len(df) < CAL_MIN + 50:
            continue
        p = detect(df)
        if p.empty:
            continue
        p['symbol'] = sym
        p['listed_now'] = listed.get(sym, False)
        p['first_bar'] = int(df.open_time.iloc[0])
        out.append(p)
    P = pd.concat(out, ignore_index=True)
    P['ts'] = pd.to_datetime(P.open_time, unit='ms', utc=True)
    P = P[(P.ts >= '2023-01-01') & (P.ts < '2026-10-14')]
    P['pushed'] = P.e20 | (P.cal & (P.volZ >= 4))
    P['tier'] = np.where(P.liq30d >= 400_000, 'major', np.where(P.liq30d < 33_000, 'thin', 'mid'))
    P = P.sort_values(['symbol', 'ts']).reset_index(drop=True)
    # pushed prints on the same coin in the prior 72 hours (episode position)
    prior = []
    for s, g in P.groupby('symbol', sort=False):
        t = g.ts.values; pu = g.pushed.values
        for i in range(len(t)):
            w = (t < t[i]) & (t >= t[i] - np.timedelta64(72, 'h')) & pu
            prior.append(int(w.sum()))
    P['prior72'] = prior
    keep = ['symbol', 'ts', 'open_time', 'bar_index', 'open', 'high', 'low', 'close', 'quote_volume', 'base48', 'ratio',
            'tradeRatio', 'barPct', 'volZ', 'barZ', 'run24Z', 'liq30d', 'hourVol', 'e20', 'cal', 'pushed', 'tier',
            'prior72', 'listed_now', 'first_bar']
    P[keep].to_parquet(os.path.join(RAW, 'prints.parquet'), index=False)
    print(len(P), 'up prints;', int(P.pushed.sum()), 'pushed;', P[P.pushed].symbol.nunique(), 'coins')
    print(P[P.pushed].groupby([P.ts.dt.year, 'listed_now']).size())


if __name__ == '__main__':
    main()
