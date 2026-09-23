#!/usr/bin/env python3
"""Sequence-, time- and momentum-aware model families for the always-tracked assets.

Companion to tracked-research.py (tracked-specialists-v1), on the SAME rows,
folds, transforms and bootstrap, so every number here is comparable to that
lane's: chronological training -> purged validation -> later untouched test,
refit every 28 days on at most 730 disjoint earlier labels. Research only;
nothing here trades or is promoted.

Families asked about on 2026-09-23 -- LSTM, ARIMA/SARIMAX, XGBoost/LightGBM,
support vector regression and logistic regression -- scored on the three
separate questions this project keeps apart:
  direction  P(up) against the asset's own trailing base rate (Brier)
  magnitude  |move| against the median |move| AND GARCH(1,1) with a weekday
             factor, the magnitude model that already beats production
  signed     the return itself, R^2 against forecasting zero
Inputs deliberately cover sequences (a 30-day window of daily returns, |return|
and volume; ten return lags), time (weekday, month) and momentum (the
volatility-normalized 1/5/20/60-day returns, trend gap and acceleration).
"""
import argparse, hashlib, importlib.util, json, math, sys, time, warnings
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('tracked_research', HERE / 'tracked-research.py')
tr = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(tr)

VERSION = 'tracked-sequence-v1'
LAGS = [f'returnLag{k}' for k in range(10)]
TAB = tr.PV + tr.OI + tr.FUNDING + tr.LIQ + LAGS + ['momentumAcceleration']
COST = 0.20  # flat round trip, percent


def calendar(rows):
    """Weekday one-hot and month on the unit circle: time as the model sees it."""
    out = []
    for r in rows:
        wd = int(r['values'].get('weekday') or 0); m = int(r['values'].get('month') or 1)
        out.append([1.0 if wd == k else 0.0 for k in range(7)] + [math.sin(2 * math.pi * m / 12), math.cos(2 * math.pi * m / 12)])
    return np.array(out, dtype=float)


def tabular(train, test):
    x, xt = tr.transform(tr.matrix(train, TAB), tr.matrix(test, TAB))
    return np.c_[x[:, 1:], calendar(train)], np.c_[xt[:, 1:], calendar(test)]


def sequences(rows):
    """[n, 30, 3]: return, |return|, volume vs its 20-day mean; missing -> NaN."""
    seq = np.array([[[s[0] if s[0] is not None else np.nan, abs(s[0]) if s[0] is not None else np.nan,
                      s[1] if s[1] is not None else np.nan] for s in r['sequence']] for r in rows], dtype=float)
    return seq


def fit_gbm(kind, task, x, y, xv, yv, xt):
    """Early-stop on the validation fold, then refit on train+validation at that size."""
    warnings.filterwarnings('ignore')
    common = dict(learning_rate=0.03, subsample=0.8, colsample_bytree=0.8, reg_lambda=1.0, random_state=7)
    if kind == 'lightgbm':
        import lightgbm as lgb
        cls = lgb.LGBMClassifier if task == 'direction' else lgb.LGBMRegressor
        make = lambda n: cls(n_estimators=n, num_leaves=7, min_child_samples=30, subsample_freq=1, verbose=-1, n_jobs=1, **common)
        m = make(400); m.fit(x, y, eval_set=[(xv, yv)], callbacks=[lgb.early_stopping(40, verbose=False)])
        best = max(10, int(m.best_iteration_ or 400))
    else:
        import xgboost as xgb
        cls = xgb.XGBClassifier if task == 'direction' else xgb.XGBRegressor
        extra = dict(eval_metric='logloss') if task == 'direction' else {}
        m = cls(n_estimators=400, max_depth=3, min_child_weight=5, early_stopping_rounds=40, n_jobs=1, verbosity=0, **common, **extra)
        m.fit(x, y, eval_set=[(xv, yv)], verbose=False)
        best = max(10, int((m.best_iteration or 399) + 1))
        make = lambda n: cls(n_estimators=n, max_depth=3, min_child_weight=5, n_jobs=1, verbosity=0, **common, **extra)
    full = make(best); full.fit(np.r_[x, xv], np.r_[y, yv])
    return full.predict_proba(xt)[:, 1] if task == 'direction' else full.predict(xt)


def fit_lstm(train_seq, yu, ya, val_seq, vu, va, test_seq, seed=7):
    """One small LSTM, two heads (P(up) and |move|), early-stopped on validation."""
    import torch
    torch.manual_seed(seed); torch.set_num_threads(1)
    mu = np.nanmean(train_seq, axis=(0, 1)); sd = np.nanstd(train_seq, axis=(0, 1)); sd = np.where(sd > 1e-9, sd, 1)
    prep = lambda s: torch.tensor(np.nan_to_num((s - mu) / sd, nan=0.0), dtype=torch.float32)
    am, asd = float(np.mean(ya)), float(np.std(ya) or 1)
    X, Xv, Xt = prep(train_seq), prep(val_seq), prep(test_seq)
    U, A = torch.tensor(yu, dtype=torch.float32), torch.tensor((ya - am) / asd, dtype=torch.float32)
    Uv, Av = torch.tensor(vu, dtype=torch.float32), torch.tensor((va - am) / asd, dtype=torch.float32)

    class Net(torch.nn.Module):
        def __init__(self):
            super().__init__(); self.lstm = torch.nn.LSTM(3, 16, batch_first=True); self.head = torch.nn.Linear(16, 2)
        def forward(self, s):
            h, _ = self.lstm(s); return self.head(h[:, -1, :])
    net = Net(); opt = torch.optim.Adam(net.parameters(), lr=3e-3, weight_decay=1e-4)
    bce, hub = torch.nn.BCEWithLogitsLoss(), torch.nn.SmoothL1Loss()
    loss_of = lambda out, u, a: bce(out[:, 0], u) + 0.5 * hub(out[:, 1], a)
    best, best_state, patience = float('inf'), None, 0
    g = torch.Generator().manual_seed(seed)
    for epoch in range(80):
        net.train()
        for idx in torch.randperm(len(X), generator=g).split(64):
            opt.zero_grad(); loss_of(net(X[idx]), U[idx], A[idx]).backward(); opt.step()
        net.eval()
        with torch.no_grad(): v = float(loss_of(net(Xv), Uv, Av))
        if v < best - 1e-4: best, best_state, patience = v, {k: t.clone() for k, t in net.state_dict().items()}, 0
        else:
            patience += 1
            if patience >= 10: break
    net.load_state_dict(best_state)
    with torch.no_grad(): out = net(Xt).numpy()
    return 1 / (1 + np.exp(-out[:, 0])), np.maximum(0, out[:, 1] * asd + am)


def sarima_forecasts(daily, decision_idx, horizon, fit_end, exog=None):
    """SARIMA(1,0,1)(1,0,1,7) on daily % returns, parameters fitted through
    fit_end and then held fixed while the filter walks forward. Returns the
    h-step cumulative forecast and its standard deviation for each decision."""
    from statsmodels.tsa.statespace.sarimax import SARIMAX
    warnings.filterwarnings('ignore')
    y = np.asarray(daily, dtype=float)
    ex = None if exog is None else np.asarray(exog, dtype=float)
    lo = max(0, fit_end + 1 - 730)
    model = SARIMAX(y[lo:fit_end + 1], exog=None if ex is None else ex[lo:fit_end + 1], order=(1, 0, 1),
                    seasonal_order=(1, 0, 1, 7), trend='c', enforce_stationarity=True, enforce_invertibility=True)
    res = model.fit(disp=False, maxiter=80)
    out = []
    for t in decision_idx:
        exog_hist = None if ex is None else ex[lo:t + 1]
        applied = res.apply(y[lo:t + 1], exog=exog_hist)
        exog_future = None if ex is None else np.repeat(ex[t:t + 1], horizon, axis=0)
        fc = applied.get_forecast(horizon, exog=exog_future)
        mean = float(np.sum(fc.predicted_mean))
        # Cumulative sd, ignoring cross-step covariance (small at these orders).
        sd = float(np.sqrt(np.sum(fc.var_pred_mean)))
        out.append((mean, sd))
    return out


def normal_cdf(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def evaluate_asset(rows, horizon, test_start, asof, use_lstm=True, use_sarima=True):
    rows = sorted(rows, key=lambda r: r['date'])
    # Daily return series (percent) indexed by date, for SARIMA.
    daily_rows = sorted({r['date']: r for r in rows}.values(), key=lambda r: r['date'])
    dates = [r['date'] for r in daily_rows]
    pos = {d: i for i, d in enumerate(dates)}
    daily = [100 * (r['values'].get('returnLag0') or 0.0) for r in daily_rows]
    exog = [[r['values'].get('oiChange1') or 0.0, r['values'].get('volumeRatio') or 0.0] for r in daily_rows]
    records = []
    for train, val, test in tr.folds(rows, test_start, asof):
        y = np.array([r['target'] for r in train]); yv = np.array([r['target'] for r in val])
        yt = np.array([r['target'] for r in test])
        u, uv = (y > 0).astype(float), (yv > 0).astype(float)
        full = train + val; yf = np.array([r['target'] for r in full]); uf = (yf > 0).astype(float)
        x, xt = tabular(train, test); _, xv = tabular(train, val); xf, xft = tabular(full, test)
        prob, mag, signed = {}, {}, {}
        prob['baseRate'] = np.full(len(test), (uf.sum() + 1) / (len(uf) + 2))
        mag['medianAbs'] = np.full(len(test), np.median(abs(yf)))
        signed['zero'] = np.zeros(len(test))
        # GARCH + weekday: the magnitude benchmark, scaled to |move| on training rows only.
        gf = np.array([r['garchWeekdayPct'] if r['garchWeekdayPct'] is not None else np.nan for r in full])
        gt = np.array([r['garchWeekdayPct'] if r['garchWeekdayPct'] is not None else np.nan for r in test])
        ok = np.isfinite(gf) & (gf > 0)
        scale = np.median(abs(yf[ok]) / gf[ok]) if ok.sum() >= 30 else np.nan
        mag['garchWeekday'] = np.where(np.isfinite(gt) & np.isfinite(scale), gt * scale, mag['medianAbs'])
        from sklearn.linear_model import LogisticRegression
        from sklearn.svm import SVR
        prob['logistic'] = LogisticRegression(C=0.1, max_iter=1000).fit(xf, uf).predict_proba(xft)[:, 1]
        for kind in ('lightgbm', 'xgboost'):
            prob[kind] = fit_gbm(kind, 'direction', x, u, xv, uv, xt)
            mag[kind] = np.maximum(0, fit_gbm(kind, 'magnitude', x, abs(y), xv, abs(yv), xt))
            signed[kind] = fit_gbm(kind, 'signed', x, y, xv, yv, xt)
        ysd = float(np.std(yf) or 1)
        svr_signed = SVR(C=1.0, epsilon=0.1, gamma='scale').fit(xf, yf / ysd).predict(xft) * ysd
        signed['svr'] = svr_signed
        prob['svr'] = 1 / (1 + np.exp(-np.clip(1.6 * svr_signed / ysd, -25, 25)))
        asd = float(np.std(abs(yf)) or 1)
        mag['svr'] = np.maximum(0, SVR(C=1.0, epsilon=0.1, gamma='scale').fit(xf, abs(yf) / asd).predict(xft) * asd)
        if use_sarima:
            idx = [pos[r['date']] for r in test]
            fit_end = pos[full[-1]['date']]
            for name, ex in (('sarima', None), ('sarimax', exog if horizon == 1 else None)):
                if name == 'sarimax' and ex is None: continue
                try:
                    fc = sarima_forecasts(daily, idx, horizon, fit_end, exog=ex)
                    signed[name] = np.array([m for m, _ in fc])
                    prob[name] = np.array([normal_cdf(m / s) if s > 0 else 0.5 for m, s in fc])
                except Exception as e:  # a failed fit is recorded as coin-flip, not dropped
                    print(f'  {name} fit failed: {e}', file=sys.stderr, flush=True)
                    signed[name] = np.zeros(len(test)); prob[name] = np.full(len(test), 0.5)
        if use_lstm:
            p, m = fit_lstm(sequences(train), u, abs(y), sequences(val), uv, abs(yv), sequences(test))
            prob['lstm'], mag['lstm'] = p, m
        for i, r in enumerate(test):
            records.append({'date': r['date'], 'targetDate': r['targetDate'], 'target': r['target'],
                'prob': {k: float(v[i]) for k, v in prob.items()}, 'mag': {k: float(v[i]) for k, v in mag.items()},
                'signed': {k: float(v[i]) for k, v in signed.items()}})
    return records


def score(records, horizon):
    if not records: return {'observations': 0, 'status': 'insufficient-history'}
    y = np.array([r['target'] for r in records]); u = (y > 0).astype(float); block = 7 if horizon == 1 else 2
    out = {'observations': len(y), 'first': records[0]['date'], 'last': records[-1]['date'],
           'upRate': float(u.mean()), 'direction': {}, 'magnitude': {}, 'signed': {}}
    base = np.array([r['prob']['baseRate'] for r in records]); base_loss = (base - u) ** 2
    for model in records[0]['prob']:
        p = np.clip([r['prob'][model] for r in records], 1e-6, 1 - 1e-6)
        d = np.where(p > .5, 1, np.where(p < .5, -1, 0)); active = d != 0
        loss = (p - u) ** 2; net = np.where(active, d * y - COST, 0)
        out['direction'][model] = {'brier': float(loss.mean()), 'logLoss': float(np.mean(-u * np.log(p) - (1 - u) * np.log(1 - p))),
            'accuracy': float(np.mean(d[active] == np.sign(y[active]))) if active.any() else None,
            'active': int(active.sum()), 'netPct': float(net.mean()),
            'brierImprovement': tr.block_interval(base_loss - loss, block), 'netInterval': tr.block_interval(net, block)}
    med = np.array([r['mag']['medianAbs'] for r in records]); garch = np.array([r['mag']['garchWeekday'] for r in records])
    for model in records[0]['mag']:
        m = np.array([r['mag'][model] for r in records]); loss = abs(m - abs(y))
        out['magnitude'][model] = {'maePct': float(loss.mean()), 'spearman': tr.correlation(m, abs(y)),
            'vsMedian': tr.block_interval(abs(med - abs(y)) - loss, block),
            'vsGarchWeekday': tr.block_interval(abs(garch - abs(y)) - loss, block)}
    for model in records[0]['signed']:
        s = np.array([r['signed'][model] for r in records])
        out['signed'][model] = {'maePct': float(np.mean(abs(s - y))),
            'oosR2': float(1 - np.sum((y - s) ** 2) / np.sum(y * y)) if np.sum(y * y) > 0 else None}
    return out


def correct_family(results):
    """Holm across every asset x horizon x model x question in this run."""
    tests = []
    for asset in results.values():
        for r in asset.values():
            for name, m in r.get('direction', {}).items():
                if name != 'baseRate': tests.append(m['brierImprovement'])
            for name, m in r.get('magnitude', {}).items():
                if name != 'medianAbs': tests.append(m['vsMedian'])
                if name not in ('medianAbs', 'garchWeekday'): tests.append(m['vsGarchWeekday'])
    ordered = sorted(tests, key=lambda t: t['p']); prev = 0
    for i, t in enumerate(ordered):
        prev = max(prev, min(1., t['p'] * (len(ordered) - i))); t['holmP'] = prev
    return len(ordered)


def verdicts(results):
    """Which model, if any, beats its benchmark for which asset, after Holm."""
    out = {}
    for sym, asset in results.items():
        for h, r in asset.items():
            if not r.get('observations'): continue
            key = f'{sym}|{h}'
            out[key] = {
                'direction': [m for m, v in r['direction'].items() if m != 'baseRate'
                              and v['brierImprovement'].get('holmP', 1) < 0.05 and v['brierImprovement']['mean'] > 0],
                'magnitudeVsMedian': [m for m, v in r['magnitude'].items() if m != 'medianAbs'
                                      and v['vsMedian'].get('holmP', 1) < 0.05 and v['vsMedian']['mean'] > 0],
                'magnitudeVsGarchWeekday': [m for m, v in r['magnitude'].items() if m not in ('medianAbs', 'garchWeekday')
                                            and v['vsGarchWeekday'].get('holmP', 1) < 0.05 and v['vsGarchWeekday']['mean'] > 0],
                'positiveSignedR2': [m for m, v in r['signed'].items() if m != 'zero' and (v['oosR2'] or -1) > 0]}
    return out


def run(data, test_days=360, symbols=None, use_lstm=True, use_sarima=True):
    asof = data['asOf']; test_start = str(np.datetime64(asof) - np.timedelta64(test_days, 'D'))
    report = {'version': VERSION, 'asOf': asof, 'testStart': test_start, 'testDays': test_days, 'actionable': False,
              'features': {'tabular': TAB, 'calendar': ['weekday one-hot', 'month sin/cos'], 'sequenceDays': 30,
                           'sequenceChannels': ['daily log return', '|daily log return|', 'log volume vs 20-day mean']},
              'assets': {}}
    predictions = {}
    for symbol in symbols or data['symbols']:
        report['assets'][symbol] = {}
        for h in (1, 7):
            rows = [r for r in data['rows'] if r['symbol'] == symbol and r['horizon'] == h]
            t0 = time.time()
            recs = evaluate_asset(rows, h, test_start, asof, use_lstm=use_lstm, use_sarima=use_sarima) if rows else []
            report['assets'][symbol][str(h)] = score(recs, h)
            predictions[f'{symbol}|{h}'] = recs
            print(f'{symbol} {h}d: {len(recs)} test outcomes in {time.time() - t0:.0f}s', flush=True)
    report['familySize'] = correct_family(report['assets'])
    report['verdicts'] = verdicts(report['assets'])
    return report, predictions


def markdown(r):
    f = lambda x, d=4: '—' if x is None or (isinstance(x, float) and not math.isfinite(x)) else f'{x:.{d}f}'
    lines = ['# Sequence, time and momentum models for the always-tracked assets', '',
             f"As of {r['asOf']}; untouched test from {r['testStart']} ({r['testDays']} days). `{VERSION}`. Research only.",
             f"Holm-corrected across {r['familySize']} comparisons.", '',
             '## Direction: Brier improvement over the base rate (positive = better)', '',
             '| Asset / h | n | ' + ' | '.join(['logistic', 'lightgbm', 'xgboost', 'svr', 'sarima', 'sarimax', 'lstm']) + ' |',
             '|---|---:|' + '---:|' * 7]
    for s, hs in r['assets'].items():
        for h, v in hs.items():
            if not v.get('observations'): lines.append(f'| {s} {h}d | 0 |' + ' — |' * 7); continue
            cells = []
            for m in ['logistic', 'lightgbm', 'xgboost', 'svr', 'sarima', 'sarimax', 'lstm']:
                d = v['direction'].get(m)
                cells.append('—' if not d else f"{d['brierImprovement']['mean'] * 1e3:+.2f}e-3 (p {f(d['brierImprovement'].get('holmP'), 2)})")
            lines.append(f"| {s} {h}d | {v['observations']} | " + ' | '.join(cells) + ' |')
    lines += ['', '## Magnitude: MAE improvement over GARCH + weekday (positive = better)', '',
              '| Asset / h | GARCH+weekday MAE % | vs median | ' + ' | '.join(['lightgbm', 'xgboost', 'svr', 'lstm']) + ' |', '|---|---:|---:|' + '---:|' * 4]
    for s, hs in r['assets'].items():
        for h, v in hs.items():
            if not v.get('observations'): continue
            g = v['magnitude']['garchWeekday']
            cells = [f"{v['magnitude'][m]['vsGarchWeekday']['mean']:+.3f} (p {f(v['magnitude'][m]['vsGarchWeekday'].get('holmP'), 2)})" if m in v['magnitude'] else '—'
                     for m in ['lightgbm', 'xgboost', 'svr', 'lstm']]
            lines.append(f"| {s} {h}d | {g['maePct']:.3f} | {g['vsMedian']['mean']:+.3f} (p {f(g['vsMedian'].get('holmP'), 2)}) | " + ' | '.join(cells) + ' |')
    lines += ['', '## Verdicts after correction', '']
    for k, v in r['verdicts'].items():
        lines.append(f"- **{k}**: direction {v['direction'] or 'none'}; magnitude vs median {v['magnitudeVsMedian'] or 'none'}; "
                     f"vs GARCH+weekday {v['magnitudeVsGarchWeekday'] or 'none'}; positive signed R² {v['positiveSignedR2'] or 'none'}")
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True); ap.add_argument('--output', required=True)
    ap.add_argument('--test-days', type=int, default=360); ap.add_argument('--symbols', default='')
    ap.add_argument('--no-lstm', action='store_true'); ap.add_argument('--no-sarima', action='store_true')
    a = ap.parse_args(); raw = Path(a.input).read_bytes(); data = json.loads(raw)
    rep, preds = run(data, a.test_days, [s for s in a.symbols.split(',') if s] or None, not a.no_lstm, not a.no_sarima)
    rep['inputHash'] = hashlib.sha256(raw).hexdigest(); rep['codeHash'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    import sklearn, lightgbm, xgboost, statsmodels
    rep['libraries'] = {'numpy': np.__version__, 'sklearn': sklearn.__version__, 'lightgbm': lightgbm.__version__,
                        'xgboost': xgboost.__version__, 'statsmodels': statsmodels.__version__}
    try:
        import torch; rep['libraries']['torch'] = torch.__version__
    except ImportError: pass
    dest = Path(a.output); dest.mkdir(parents=True, exist_ok=True)
    (dest / 'report.json').write_text(json.dumps(rep, indent=1, allow_nan=False))
    (dest / 'predictions.json').write_text(json.dumps(preds, allow_nan=False))
    (dest / 'report.md').write_text(markdown(rep))
