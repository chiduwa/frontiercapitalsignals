"""Long-history cycle/seasonality ablation, strictly offline.

Quarterly expanding fits; labels must mature before fitting. Price features use
completed daily observations; reference-market features have another day's lag.
Targets enter at the next observation's close (a research price proxy), then
hold 1/7/30/90 days or stock sessions. No live forecast/order authority.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import numpy as np
import pandas as pd
from scipy.stats import t as student_t
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

sp = importlib.util.spec_from_file_location('scenario', Path(__file__).with_name('scenario-research.py'))
scenario = importlib.util.module_from_spec(sp); sp.loader.exec_module(scenario)
HALVINGS = pd.DatetimeIndex(['2009-01-03', '2012-11-28', '2016-07-09', '2020-05-11', '2024-04-20'])
END = pd.Timestamp('2026-10-08')
HORIZONS = (1, 7, 30, 90)
MIN_TRAIN = 730
MODELS = ('base', 'recent_base', 'state', 'season', 'cycle', 'combined', 'interaction')


def cycle_features(index):
    # Only the most recent already-observed halving can affect a row. Never
    # normalize by the realized date of the NEXT halving or future price peaks.
    k = HALVINGS.searchsorted(index, side='right') - 1
    known = k >= 0
    age = (index - HALVINGS[np.maximum(k, 0)]).days.to_numpy().astype(float)
    age[~known] = np.nan
    phase = 2 * np.pi * age / 1461.0
    return pd.DataFrame({'cycleSin': np.sin(phase), 'cycleCos': np.cos(phase),
                         'cycleSin2': np.sin(2 * phase), 'cycleCos2': np.cos(2 * phase),
                         'cycleAge': age, 'cycleId': np.where(known, HALVINGS[np.maximum(k, 0)].year, 0)}, index=index)


def read_prices(root):
    raw = root / 'cycles' / 'raw'; prices, meta = {}, {}
    for path in sorted(raw.glob('coinmetrics-*.csv')):
        x = pd.read_csv(path)
        if 'PriceUSD' not in x: continue
        s = pd.Series(pd.to_numeric(x.PriceUSD).to_numpy(), index=pd.to_datetime(x.time)).dropna()
        s = s[(s > 0) & (s.index < END)]
        if len(s) < 730: continue
        name = 'CM_' + path.stem.split('-')[-1].upper()
        prices[name] = s.reindex(pd.date_range(s.index.min(), s.index.max(), freq='D'))
        meta[name] = {'assetClass': 'crypto', 'source': 'Coin Metrics community PriceUSD', 'researchOnlyLicense': True}
    parts = []
    for path in sorted(raw.glob('bitstamp-BTC-*.json')):
        x = pd.DataFrame(json.loads(path.read_text())['data']['ohlc'])
        if x.empty: continue
        parts.append(pd.Series(pd.to_numeric(x.close).to_numpy(), index=pd.to_datetime(pd.to_numeric(x.timestamp), unit='s')))
    if parts:
        s = pd.concat(parts).sort_index(); s = s[~s.index.duplicated() & (s.index < END)]
        prices['BITSTAMP_BTC'] = s.reindex(pd.date_range(s.index.min(), s.index.max(), freq='D'))
        meta['BITSTAMP_BTC'] = {'assetClass': 'crypto', 'source': 'Bitstamp BTC/USD daily closes'}
    for folder in sorted((root / 'raw' / 'klines').iterdir()):
        bars = scenario.load_bars(root, folder.name)
        if bars.empty: continue
        daily = bars.close.resample('1D').last().where(bars.close.resample('1D').count() == 96)
        daily.index = daily.index.tz_localize(None)
        name = 'BINANCE_' + folder.name.removesuffix('USDT')
        prices[name] = daily[daily.index < END]
        meta[name] = {'assetClass': 'crypto', 'source': 'Binance Global USD-M futures; all 96 candles required per day'}
    for path in sorted(raw.glob('yahoo-*.json')):
        x = json.loads(path.read_text())['chart']['result'][0]
        index = pd.to_datetime(x['timestamp'], unit='s', utc=True).tz_convert('America/New_York').tz_localize(None).normalize()
        s = pd.Series(x['indicators']['adjclose'][0]['adjclose'], index=index)
        s = s[~s.index.duplicated() & (s.index < END) & (s > 0)]
        name = path.stem.removeprefix('yahoo-')
        prices[name] = s
        meta[name] = {'assetClass': 'stock', 'source': 'Yahoo adjusted daily reference closes; not Robinhood fills'}
    return prices, meta


def feature_frame(price, prices):
    f = pd.DataFrame(index=price.index)
    lr = np.log(price).diff()
    vol = lr.rolling(30).std()
    for h in [7, 30, 90, 200]:
        f[f'momentum{h}'] = np.log(price / price.shift(h)) / (vol * np.sqrt(h))
    f['volRatio'] = np.log(vol / lr.rolling(180).std())
    f['drawdown'] = np.log(price / price.rolling(365).max())
    f['trend'] = np.log(price / price.rolling(200).mean()) / (vol * np.sqrt(200))
    state = list(f.columns)
    # BTC and liquid stock/bond/gold/dollar proxies describe market conditions.
    # A full additional calendar day prevents same-day cross-market leakage.
    for name in ['BITSTAMP_BTC', 'SPY', 'QQQ', 'TLT', 'GLD', 'UUP']:
        if name not in prices: continue
        p = prices[name]
        r = np.log(p / p.shift(30))
        r.index = r.index + pd.Timedelta(days=1)
        f['market_' + name] = r.reindex(price.index, method='ffill', tolerance=pd.Timedelta(days=5))
    state += [c for c in f if c.startswith('market_')]
    # Missing early macro sources remain explicitly missing; train-only mean
    # imputation plus missing indicators avoids dropping the oldest cycles.
    cycle = cycle_features(price.index)
    for c in ['cycleSin', 'cycleCos', 'cycleSin2', 'cycleCos2']: f[c] = cycle[c]
    phase = 2 * np.pi * ((price.index.dayofyear - 1) / np.where(price.index.is_leap_year, 366, 365))
    for n in [1, 2]:
        f[f'annualSin{n}'], f[f'annualCos{n}'] = np.sin(n * phase), np.cos(n * phase)
    week = 2 * np.pi * price.index.dayofweek / 7
    f['weekSin'], f['weekCos'] = np.sin(week), np.cos(week)
    cyc = [c for c in f if c.startswith('cycle')]
    sea = [c for c in f if c.startswith(('annual', 'week'))]
    interaction = []
    for c in ['cycleSin', 'cycleCos', 'annualSin1', 'annualCos1']:
        for r in ['trend', 'volRatio']:
            key = f'{c}_{r}'; f[key] = f[c] * f[r]; interaction.append(key)
    for c in ['cycleSin', 'cycleCos']:
        for s in ['annualSin1', 'annualCos1']:
            key = f'{c}_{s}'; f[key] = f[c] * f[s]; interaction.append(key)
    groups = {'state': state, 'season': state + sea, 'cycle': state + cyc,
              'combined': state + sea + cyc, 'interaction': state + sea + cyc + interaction}
    f = f.replace([np.inf, -np.inf], np.nan)
    valid = price.notna().rolling(365).sum().eq(365) & f[['momentum200', 'volRatio', 'trend', 'cycleSin']].notna().all(axis=1)
    return f, groups, valid


def targets(price, horizon):
    ret = price.shift(-(horizon + 1)) / price.shift(-1) - 1
    # Unknown daily observations invalidate the entire holding path.
    complete = price.notna().iloc[::-1].rolling(horizon + 2).sum().iloc[::-1].eq(horizon + 2)
    ret = ret.where(complete)
    end = pd.Series(price.index, index=price.index).shift(-(horizon + 1))
    y = ret.gt(0).astype(float).where(ret.notna() & ret.ne(0))
    return y, ret, end


def fit_predict(train, y, test):
    # All transformations are fitted only on the eligible training window.
    means = train.mean().fillna(0)
    a = np.column_stack([train.fillna(means).to_numpy(), train.isna().to_numpy().astype(float)])
    b = np.column_stack([test.fillna(means).to_numpy(), test.isna().to_numpy().astype(float)])
    scaler = StandardScaler(); a = scaler.fit_transform(a); b = scaler.transform(b)
    # Fixed strong shrinkage; no hyperparameter search on a test cycle.
    model = LogisticRegression(C=0.01, max_iter=250, solver='lbfgs')
    model.fit(a, y)
    return model.predict_proba(b)[:, 1]


def walk_forward(price, prices, horizon, min_train=MIN_TRAIN):
    f, groups, valid = feature_frame(price, prices)
    y, ret, maturity = targets(price, horizon)
    rows = []
    for begin in pd.date_range(price.index.min().to_period('Q').start_time, price.index.max(), freq='QS'):
        finish = begin + pd.offsets.QuarterBegin(startingMonth=1)
        train = valid & y.notna() & (maturity < begin)
        test = valid & y.notna() & (f.index >= begin) & (f.index < finish)
        if train.sum() < min_train or not test.any() or y[train].nunique() < 2: continue
        r = pd.DataFrame({'y': y[test], 'return': ret[test], 'maturity': maturity[test]})
        r['base'] = (y[train].sum() + 1) / (train.sum() + 2)
        recent = train & (f.index >= begin - pd.Timedelta(days=730))
        r['recent_base'] = (y[recent].sum() + 1) / (recent.sum() + 2)
        for name, columns in groups.items(): r[name] = fit_predict(f.loc[train, columns], y[train], f.loc[test, columns])
        r['fitBefore'] = begin
        r['latestTrainOutcome'] = maturity[train].max()
        r['trainingRows'] = int(train.sum())
        rows.append(r)
    return pd.concat(rows) if rows else pd.DataFrame()


def difference_stats(diff, horizon):
    clean = diff.dropna()
    if clean.empty: return {'n': 0, 'gain': None, 'lower95': None, 'p': 1.0, 'blocks': 0}
    # At least twice the forecast horizon; crypto correlation is not treated
    # as thousands of independent samples. Whole-cycle splits are additional.
    width = max(90, 2 * horizon)
    blocks = clean.groupby((clean.index - pd.Timestamp('2000-01-01')).days // width).mean()
    mean = float(blocks.mean()); se = float(blocks.std(ddof=1) / np.sqrt(len(blocks))) if len(blocks) > 1 else np.nan
    lower, p = None, 1.0
    if len(blocks) >= 8 and np.isfinite(se) and se > 0:
        lower = float(mean - student_t.ppf(.95, len(blocks) - 1) * se)
        p = float(student_t.sf(mean / se, len(blocks) - 1))
    return {'n': len(clean), 'gain': float(clean.mean()), 'blockMeanGain': mean,
            'lower95': lower, 'p': p, 'blocks': len(blocks), 'blockDays': width}


def summarize(pred, name, horizon):
    loss = (pred[name] - pred.y) ** 2
    result = {'model': name, 'horizon': horizon, 'n': len(pred), 'from': str(pred.index.min().date()),
              'to': str(pred.index.max().date()), 'brier': float(loss.mean()),
              'logLoss': float(-(pred.y * np.log(pred[name].clip(1e-8, 1-1e-8)) +
                                  (1-pred.y) * np.log(1-pred[name].clip(1e-8, 1-1e-8))).mean()),
              'accuracy': float(((pred[name] >= .5) == pred.y).mean()),
              'vsBase': difference_stats((pred.base - pred.y) ** 2 - loss, horizon),
              'vsRecentBase': difference_stats((pred.recent_base - pred.y) ** 2 - loss, horizon),
              'vsState': difference_stats((pred.state - pred.y) ** 2 - loss, horizon)}
    result['p'] = max(result[k]['p'] for k in ['vsBase', 'vsRecentBase', 'vsState'])
    ids = cycle_features(pred.index).cycleId
    result['cycles'] = []
    for cycle_id, p in pred.groupby(ids):
        l = (p[name] - p.y) ** 2
        result['cycles'].append({'halvingYear': int(cycle_id), 'n': len(p), 'from': str(p.index.min().date()),
          'to': str(p.index.max().date()), 'gainVsBase': float(((p.base-p.y)**2-l).mean()),
          'gainVsRecentBase': float(((p.recent_base-p.y)**2-l).mean()),
          'gainVsState': float(((p.state-p.y)**2-l).mean())})
    result['years'] = [{'year': int(year), 'n': len(p),
        'gainVsBase': float(((p.base-p.y)**2-(p[name]-p.y)**2).mean()),
        'gainVsState': float(((p.state-p.y)**2-(p[name]-p.y)**2).mean())}
        for year, p in pred.groupby(pred.index.year)]
    return result


def season_table(price):
    monthly = price.resample('ME').last().pct_change(fill_method=None)
    # Drop incomplete first/last months; this table is descriptive, not a fit.
    monthly = monthly[(monthly.index >= price.index.min()) & (monthly.index <= price.index.max())].dropna()
    out = []
    for month, s in monthly.groupby(monthly.index.month):
        eras = cycle_features(s.index).cycleId
        out.append({'month': int(month), 'observations': len(s), 'meanPct': float(s.mean()*100),
                    'medianPct': float(s.median()*100), 'positiveFraction': float(s.gt(0).mean()),
                    'byCycle': [{'halvingYear': int(c), 'n': len(v), 'meanPct': float(v.mean()*100)} for c,v in s.groupby(eras)]})
    return out


def run(root, only=None):
    prices, metadata = read_prices(root)
    results, coverage, seasonal, frames, context = [], [], {}, [], []
    for asset, price in prices.items():
        if only and asset not in only: continue
        coverage.append({'asset': asset, **metadata[asset], 'rows': int(price.notna().sum()),
                         'gaps': int(price.isna().sum()), 'from': str(price.index.min().date()), 'to': str(price.index.max().date())})
        seasonal[asset] = season_table(price)
        f, _, valid = feature_frame(price, prices)
        known = f[valid]
        if not known.empty:
            d = known.index[-1]; c = cycle_features(pd.DatetimeIndex([d])).iloc[0]
            context.append({'asset': asset, 'asOf': str(d.date()), 'daysSinceKnownHalving': int(c.cycleAge),
                            'trend200Standardized': float(known.iloc[-1].trend),
                            'vol30To180Ratio': float(np.exp(known.iloc[-1].volRatio)), 'actionable': False})
        for horizon in HORIZONS:
            pred = walk_forward(price, prices, horizon)
            if pred.empty: continue
            for name in MODELS: results.append({'asset': asset, 'assetClass': metadata[asset]['assetClass'], **summarize(pred, name, horizon)})
            pred['asset'], pred['horizon'] = asset, horizon; frames.append(pred)
        print(asset, coverage[-1]['from'], coverage[-1]['to'], 'comparisons', len(results), flush=True)
    # Holm family-wise adjustment tolerates dependence among all assets,
    # horizons and source cross-checks. More stringent than picking a winner.
    candidates = [r for r in results if r['model'] not in ('base', 'recent_base', 'state')]
    order = sorted(candidates, key=lambda r: r['p']); adjusted = 0.0
    for i, r in enumerate(order):
        adjusted = max(adjusted, min(1.0, (len(order)-i)*r['p'])); r['holmP'] = adjusted
        robust = [c for c in r['cycles'] if c['n'] >= 180]
        r['historicalCandidate'] = bool(adjusted < .05 and len(robust) >= 2 and
          all(c['gainVsBase'] > 0 and c['gainVsRecentBase'] > 0 and c['gainVsState'] > 0 for c in robust) and
          all(r[k]['lower95'] is not None and r[k]['lower95'] > 0 for k in ['vsBase', 'vsRecentBase', 'vsState']))
        r['actionable'] = False
    output = {'version': 'long-cycle-ablation-v1', 'actionable': False, 'coverage': coverage,
      'protocol': {'quarterlyExpandingFits': True, 'minTrainRows': MIN_TRAIN, 'fixedLogisticC': .01,
                   'horizons': list(HORIZONS), 'labelEntry': 'next observed close',
                   'hypothesesCorrected': len(candidates), 'correction': 'Holm family-wise',
                   'cyclePhaseDays': 1461, 'halvingDates': [str(d.date()) for d in HALVINGS[1:]]},
      'results': results, 'historicalCandidates': [r for r in candidates if r['historicalCandidate']],
      'seasonality': seasonal, 'latestContext': context,
      'limits': ['Only three completed intervals between observed halvings; daily rows are not independent cycles.',
                'Historical walk-forward reconstruction, not immutable forecasts issued at those times.',
                'Current asset selection has survivorship bias; source duplicates are not independent replications.',
                'Community Coin Metrics data ends earlier; sources are never spliced to extend a curve.',
                'Direction scores only: no fees, execution, short borrow, liquidations or funding in these daily models.',
                'Stock horizons count sessions; crypto horizons count calendar days.',
                'Cycle length 1461 days is a hypothesis, not an assumed law or a known next halving date.',
                'Research candidates still require fresh prospective evidence against the actual production model.']}
    folder = root / 'cycles'; folder.mkdir(exist_ok=True)
    (folder / 'cycle-results.json').write_text(json.dumps(output, indent=2, allow_nan=False) + '\n')
    if frames: pd.concat(frames).to_pickle(folder / 'cycle-forecasts.pkl')
    print('Historical candidates:', len(output['historicalCandidates']), 'of', len(candidates), flush=True)
    return output


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--data', default='reports/scenarios'); ap.add_argument('--only')
    a = ap.parse_args(); run(Path(a.data), a.only.split(',') if a.only else None)
