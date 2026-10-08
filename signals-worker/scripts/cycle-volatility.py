"""Companion offline volatility ablation using the same causal cycle inputs."""
import argparse
import importlib.util
import json
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler

sp = importlib.util.spec_from_file_location('cycles', Path(__file__).with_name('cycle-research.py'))
c = importlib.util.module_from_spec(sp); sp.loader.exec_module(c)


def realized_variance(price, horizon):
    squared = np.log(price).diff() ** 2
    # Entry at t+1 close; returns t+2 ... t+1+h, matching direction labels.
    return squared.rolling(horizon).sum().shift(-(horizon + 1))


def fit_variance(train, y, test):
    means = train.mean().fillna(0)
    a = np.column_stack([train.fillna(means), train.isna().astype(float)])
    b = np.column_stack([test.fillna(means), test.isna().astype(float)])
    scaler = StandardScaler(); a = scaler.fit_transform(a); b = scaler.transform(b)
    model = Ridge(alpha=100.0).fit(a, np.log(y))
    # Training-only smearing corrects log-to-level retransformation bias.
    smear = np.mean(np.exp(np.log(y) - model.predict(a)))
    return np.maximum(np.exp(model.predict(b)) * smear, 1e-12)


def forecasts(price, prices, horizon, min_train=c.MIN_TRAIN):
    f, groups, valid = c.feature_frame(price, prices)
    y = realized_variance(price, horizon)
    _, _, maturity = c.targets(price, horizon)
    past = np.log(price).diff() ** 2
    base = past.rolling(30).mean() * horizon
    ewma = past.ewm(halflife=30, adjust=False, min_periods=180).mean() * horizon
    rows = []
    for begin in pd.date_range(price.index.min().to_period('Q').start_time, price.index.max(), freq='QS'):
        finish = begin + pd.offsets.QuarterBegin(startingMonth=1)
        train = valid & y.gt(0) & (maturity < begin)
        test = valid & y.gt(0) & (f.index >= begin) & (f.index < finish) & base.gt(0) & ewma.gt(0)
        if train.sum() < min_train or not test.any(): continue
        r = pd.DataFrame({'y': y[test], 'base': base[test], 'ewma': ewma[test], 'maturity': maturity[test]})
        for name, columns in groups.items(): r[name] = fit_variance(f.loc[train, columns], y[train], f.loc[test, columns])
        r['fitBefore'], r['latestTrainOutcome'] = begin, maturity[train].max()
        rows.append(r)
    return pd.concat(rows) if rows else pd.DataFrame()


def qlike(actual, forecast):
    ratio = actual / forecast
    return ratio - np.log(ratio) - 1


def run(root):
    prices, metadata = c.read_prices(root)
    results, frames = [], []
    for asset, price in prices.items():
        for horizon in c.HORIZONS:
            pred = forecasts(price, prices, horizon)
            if pred.empty: continue
            losses = {name: qlike(pred.y, pred[name]) for name in ['base', 'ewma', 'state', 'season', 'cycle', 'combined', 'interaction']}
            for name, loss in losses.items():
                r = {'asset': asset, 'assetClass': metadata[asset]['assetClass'], 'model': name,
                     'horizon': horizon, 'n': len(pred), 'qlike': float(loss.mean()),
                     'from': str(pred.index.min().date()), 'to': str(pred.index.max().date())}
                for base in ['base', 'ewma', 'state']: r['vs_' + base] = c.difference_stats(losses[base] - loss, horizon)
                r['p'] = max(r['vs_' + b]['p'] for b in ['base', 'ewma', 'state'])
                r['cycles'] = []
                for cycle_id, rows in pred.groupby(c.cycle_features(pred.index).cycleId):
                    row = {'halvingYear': int(cycle_id), 'n': len(rows)}
                    for base in ['base', 'ewma', 'state']: row['gainVs_' + base] = float((losses[base]-loss).loc[rows.index].mean())
                    r['cycles'].append(row)
                results.append(r)
            pred['asset'], pred['horizon'] = asset, horizon; frames.append(pred)
        print(asset, 'volatility comparisons', len(results), flush=True)
    result = {'version': 'long-cycle-volatility-v1', 'actionable': False, 'results': results,
      'protocol': {'target': 'future realized sum of squared log returns', 'loss': 'uncapped QLIKE',
                   'ridgeAlpha': 100, 'transform': 'log target; training-only smearing',
                   'familyCorrection': 'combined with direction comparisons by cycle-report.py'},
      'limits': ['No production promotion or automated unbounded-loss test is authorized by this offline study.',
                'Paired block t diagnostics are approximate under serial dependence and heavy tails.',
                'Variance prediction does not predict whether the price will rise or fall.']}
    folder = root / 'cycles'
    (folder / 'volatility-results.json').write_text(json.dumps(result, indent=2, allow_nan=False)+'\n')
    if frames: pd.concat(frames).to_pickle(folder / 'volatility-forecasts.pkl')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--data', default='reports/scenarios')
    args = ap.parse_args(); run(Path(args.data))
