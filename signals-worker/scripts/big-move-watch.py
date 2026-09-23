#!/usr/bin/env python3
"""Big-move watch (big-move-watch-v1): which coins are likely to move >= 12%
over the next two days. Direction unknown, and said so.

Asked 2026-09-24: study what the model missed, "ensure the signals are known
so I can be notified / reach the board on time". The retrospective had logged
364 missed moves of >= 12% in 48 h; 49% were coins outside the engine's
top-100 universe, 34% were in it but never ranked onto a board.

Studied properly, with controls -- every coin-day, not only the movers --
on 330,100 coin-days (286 coins, 2021-03..2026-09): the base rate of a
>= 12% two-day move is 10.3%. The within-day top decile of recent volatility,
recent range, today's move size, momentum in either direction, a volume
surge, a young coin or a thin book each carries 1.4-2.6x that rate, in both
halves of history. Combined in one model and walked forward over nine
half-years, the daily top 10 moved >= 12% within two days 30% of the time
against an 8.6% base rate (every half: 20-47% vs 6-11%). WHICH WAY is not
forecastable: 52% of the flagged movers went up, and a direction model's AUC
wandered 0.41-0.68. See docs/MISSED_MOVES.md.

Daily: fit on every matured label (outcome known at the close), rank every
coin's newest close, log the top N before the outcome exists (big_move_watch),
and score earlier days against what EVERY coin did the same two days.
Notifications: proven at discovery (every walk-forward half cleared the
base), so it may notify from day one; demoted if its live record trails the
same-day base rate (day-clustered t <= -2 over >= 30 days).
"""
import argparse, hashlib, json, math, sys, time
from pathlib import Path
import numpy as np, pandas as pd

VERSION = 'big-move-watch-v1'
BIG = 0.12
HORIZON_DAYS = 2
TOP_N = 10
FEATS = ['absR1', 'r1', 'r5', 'r20', 'vol5', 'vol20', 'vol60', 'volExpansion', 'volPct365', 'bigDays20', 'range10',
         'rangeCompression', 'pos60', 'dd365', 'volumeRatio', 'volumeTrend', 'logDollarVolume', 'ageDays',
         'btcR5', 'btcVol20', 'breadth5', 'marketTurbulence']
MIN_COINS_PER_DAY = 30
DEMOTE_T = -2.0
MIN_LIVE_DAYS = 30


def coin_features(sym, rows):
    """Features at each close from that close and earlier only."""
    df = pd.DataFrame(rows, columns=['date', 'close', 'high', 'low', 'volume'])
    df['date'] = pd.to_datetime(df['date'])
    df = df.sort_values('date').drop_duplicates('date').reset_index(drop=True)
    c = df['close'].astype(float)
    hi = df['high'].astype(float).fillna(c); lo = df['low'].astype(float).fillna(c)
    v = df['volume'].astype(float)
    gap = df['date'].diff().dt.days.fillna(1)
    contiguous = gap.rolling(60).max() <= 1  # a window touching a missing day is not measured
    lr = np.log(c).diff()
    f = pd.DataFrame({'symbol': sym, 'date': df['date'], 'close': c})
    f['r1'] = lr; f['absR1'] = lr.abs()
    f['r5'] = np.log(c / c.shift(5)); f['r20'] = np.log(c / c.shift(20))
    f['vol5'] = lr.rolling(5).std(); f['vol20'] = lr.rolling(20).std(); f['vol60'] = lr.rolling(60).std()
    f['volExpansion'] = f['vol5'] / f['vol60']
    f['volPct365'] = f['vol20'].rolling(365, min_periods=120).rank(pct=True)
    f['bigDays20'] = (lr.abs() >= math.log(1.08)).astype(float).rolling(20).sum()
    r10 = (hi.rolling(10).max() - lo.rolling(10).min()) / c
    r60 = (hi.rolling(60).max() - lo.rolling(60).min()) / c
    f['range10'] = r10; f['rangeCompression'] = r10 / r60
    f['pos60'] = (c - lo.rolling(60).min()) / (hi.rolling(60).max() - lo.rolling(60).min())
    f['dd365'] = c / c.rolling(365, min_periods=60).max() - 1
    f['volumeRatio'] = v / v.rolling(20).median()
    f['volumeTrend'] = v.rolling(5).mean() / v.rolling(20).mean()
    f['logDollarVolume'] = np.log(v.rolling(30).median().clip(lower=1))
    f['ageDays'] = np.arange(len(df))
    fwd = c.shift(-HORIZON_DAYS) / c - 1
    contiguous_fwd = (df['date'].shift(-HORIZON_DAYS) - df['date']).dt.days == HORIZON_DAYS
    f['fwd2'] = np.where(contiguous_fwd, fwd, np.nan)
    return f[contiguous & (f['ageDays'] >= 60)]


def panel(series):
    D = pd.concat([coin_features(s, rows) for s, rows in series.items() if len(rows) >= 120], ignore_index=True)
    if 'BTC' in series:
        btc = D[D.symbol == 'BTC'].set_index('date')
        D['btcR5'] = D['date'].map(btc['r5']); D['btcVol20'] = D['date'].map(btc['vol20'])
    else:
        D['btcR5'] = np.nan; D['btcVol20'] = np.nan
    D['breadth5'] = D.groupby('date')['r5'].transform(lambda x: (x > 0).mean())
    D['marketTurbulence'] = D.groupby('date')['absR1'].transform('median')
    D['coins'] = D.groupby('date')['symbol'].transform('count')
    return D[D['coins'] >= MIN_COINS_PER_DAY].copy()


def fit_and_rank(D, asof, top_n=TOP_N):
    """Train on labels matured by the close of `asof` (their two days are
    over), then rank every coin's close on `asof`."""
    import lightgbm as lgb
    X = D[FEATS].replace([np.inf, -np.inf], np.nan)
    matured = (D['date'] <= asof - pd.Timedelta(days=HORIZON_DAYS)) & np.isfinite(D['fwd2'])
    today = D['date'] == asof
    if matured.sum() < 20000 or today.sum() < MIN_COINS_PER_DAY:
        return None, None
    med = X[matured].median()
    y = (D.loc[matured, 'fwd2'].abs() >= BIG).astype(int)
    m = lgb.LGBMClassifier(n_estimators=300, num_leaves=15, learning_rate=0.03, min_child_samples=200, subsample=0.8,
                           subsample_freq=1, colsample_bytree=0.8, verbose=-1, n_jobs=1, random_state=7)
    m.fit(X[matured].fillna(med), y)
    T = D.loc[today, ['symbol', 'date', 'close', 'vol20', 'r1', 'r5', 'volumeRatio', 'range10']].copy()
    T['p'] = m.predict_proba(X[today].fillna(med))[:, 1]
    T = T.sort_values('p', ascending=False).reset_index(drop=True)
    T['rank'] = np.arange(1, len(T) + 1)
    gain = dict(zip(FEATS, m.booster_.feature_importance(importance_type='gain')))
    total = sum(gain.values()) or 1
    return T.head(top_n), {'trainRows': int(matured.sum()), 'baseRate': float(y.mean()), 'coins': int(today.sum()),
                           'gainShare': {k: round(v / total, 4) for k, v in sorted(gain.items(), key=lambda t: -t[1])[:8]}}


def realized(D):
    """(date, symbol) -> two-day return, for every coin, from the archive."""
    ok = np.isfinite(D['fwd2'])
    return {(d.strftime('%Y-%m-%d'), s): float(r) for d, s, r in zip(D.loc[ok, 'date'], D.loc[ok, 'symbol'], D.loc[ok, 'fwd2'])}


def day_base_rates(D):
    ok = np.isfinite(D['fwd2'])
    g = (D.loc[ok, 'fwd2'].abs() >= BIG).groupby(D.loc[ok, 'date']).mean()
    return {d.strftime('%Y-%m-%d'): float(v) for d, v in g.items()}


def score(open_rows, outcome, base):
    """Fill every watched row whose two days are over. The bar is the same
    day's share of ALL coins that moved >= 12%, not a constant."""
    out = []
    for r in open_rows:
        key = (r['as_of'], r['symbol'])
        if key not in outcome or r['as_of'] not in base: continue
        f = outcome[key]
        out.append({'as_of': r['as_of'], 'symbol': r['symbol'], 'move_pct': f * 100, 'big': int(abs(f) >= BIG),
                    'day_base_rate': base[r['as_of']]})
    return out


def live_record(scored_rows):
    """Day-clustered: each watch day's hit rate minus that day's base rate."""
    by = {}
    for r in scored_rows:
        by.setdefault(r['as_of'], []).append(r)
    diffs = [np.mean([x['big'] for x in v]) - v[0]['day_base_rate'] for v in by.values()]
    n = len(diffs)
    hit = float(np.mean([x['big'] for x in scored_rows])) if scored_rows else None
    base = float(np.mean([v[0]['day_base_rate'] for v in by.values()])) if by else None
    t = float(np.mean(diffs) / (np.std(diffs, ddof=1) / math.sqrt(n))) if n > 2 and np.std(diffs, ddof=1) > 0 else None
    return {'days': n, 'rows': len(scored_rows), 'hitRate': hit, 'baseRate': base,
            'excess': float(np.mean(diffs)) if n else None, 't': t}


def notify_gate(record):
    if record['days'] >= MIN_LIVE_DAYS and record['t'] is not None and record['t'] <= DEMOTE_T:
        return False, (f"demoted: live, the watch hit {record['hitRate']:.0%} vs a {record['baseRate']:.0%} same-day base "
                       f"(t={record['t']:.2f}, {record['days']} days)")
    if record['days'] >= MIN_LIVE_DAYS and record['t'] is not None:
        return True, (f"live: {record['hitRate']:.0%} of watched coins moved >= 12% in 2 days vs {record['baseRate']:.0%} "
                      f"of all coins the same days (t={record['t']:.2f}, {record['days']} days)")
    return True, (f"proven at discovery: walk-forward over 9 half-years, the daily top 10 moved >= 12% in 2 days 30% of the "
                  f"time vs an 8.6% base; live record accumulating ({record['days']}/{MIN_LIVE_DAYS} days)")


def num(x, scale=1.0, transform=None):
    """A finite float or None: a missing input is reported as missing."""
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(x): return None
    return (transform(x) if transform else x) * scale


def run(series, state, run_at=None):
    D = panel(series)
    asof = D['date'].max()
    top, meta = fit_and_rank(D, asof)
    outcome, base = realized(D), day_base_rates(D)
    scored_now = score(state.get('open', []), outcome, base)
    record = live_record(state.get('scored', []) + scored_now)
    allowed, why = notify_gate(record)
    asof_s = asof.strftime('%Y-%m-%d')
    watch = []
    if top is not None:
        for _, r in top.iterrows():
            watch.append({'as_of': asof_s, 'symbol': r['symbol'], 'rank': int(r['rank']), 'p': float(r['p']),
                          'close': num(r['close']), 'vol20_pct': num(r['vol20'], 100),
                          'move_today_pct': num(r['r1'], 100, math.expm1),
                          'r5_pct': num(r['r5'], 100, math.expm1), 'volume_ratio': num(r['volumeRatio'])})
    # Recall: of the coins that DID move >= 12% on scored days, how many were watched the day before the window?
    watched = {(r['as_of'], r['symbol']) for r in state.get('scored', []) + scored_now}
    days = {r['as_of'] for r in state.get('scored', []) + scored_now}
    movers = [(d, s) for (d, s), f in outcome.items() if d in days and abs(f) >= BIG]
    recall = (sum(1 for k in movers if k in watched) / len(movers)) if movers else None
    summary = {'version': VERSION, 'asOf': asof_s, 'generatedAt': run_at, 'horizonDays': HORIZON_DAYS,
               'threshold': BIG, 'watch': watch, 'model': meta, 'live': record, 'recall': recall,
               'movers': len(movers), 'notifying': allowed, 'statusNote': why,
               'direction': 'unknown: 52% of flagged movers rose in the walk-forward; no direction model held up'}
    return {'version': VERSION, 'asOf': asof_s, 'runAt': run_at, 'watch': watch, 'scores': scored_now, 'summary': summary}


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--series', required=True); ap.add_argument('--state', required=True); ap.add_argument('--output', required=True)
    a = ap.parse_args()
    raw = Path(a.series).read_bytes()
    t0 = time.time()
    out = run(json.loads(raw), json.loads(Path(a.state).read_text()), time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
    out['inputHash'] = hashlib.sha256(raw).hexdigest()
    Path(a.output).write_text(json.dumps(out, allow_nan=False))
    s = out['summary']
    print(f"{VERSION} as of {s['asOf']}: watching {len(s['watch'])} of {s['model']['coins'] if s['model'] else 0} coins, "
          f"{len(out['scores'])} scored, live {s['live']}, notifying={s['notifying']} in {time.time() - t0:.0f}s", flush=True)
