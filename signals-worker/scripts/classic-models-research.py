#!/usr/bin/env python3
"""Classic forecasting and learning families, per asset and market-wide.

Asked on 2026-09-28: would Holt-Winters, naive Bayes, decision stumps and
their bagged and boosted ensembles, random forests, exponential smoothing
(simple, Holt's trend-corrected, multiplicative Holt-Winters), automated ETS,
Monte Carlo prediction intervals, feature engineering and class balancing make
this project's forecasts better, for single assets or the market as a whole?

Same rows, folds, transforms and bootstrap as tracked-research.py and
tracked-sequence-research.py, so every number compares with
docs/SEQUENCE_MODELS.md: chronological training, purged validation, a later
untouched test, refit every 28 days on at most 730 earlier labels. Research
only (`actionable: false`); nothing here trades or is promoted.

Questions, each scored the way the project scores it:
  direction   P(up) against the asset's own trailing base rate (Brier), plus
              log loss, AUC, balanced accuracy, MCC and calibration slope
  magnitude   |move| against the median |move| and GARCH(1,1) + weekday (MAE,
              the sequence study's score) and the same comparison in QLIKE,
              the tournament's score
  signed      the return itself, R^2 against forecasting zero
  intervals   68% and 95% ranges: coverage, width and the interval score
Exponential smoothing runs on the daily squared return (a variance proxy) for
size, and on log price for direction. Each ETS fit is statsmodels' own; the
forecasts then come from a causal filter (hw_filter) that reproduces
statsmodels' recursions exactly, run forward with the fitted parameters held
fixed, so a forecast made at t uses nothing after t.
"""
import argparse, hashlib, importlib.util, json, math, sys, time, warnings
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('tracked_research', HERE / 'tracked-research.py')
tr = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(tr)
_spec = importlib.util.spec_from_file_location('tracked_sequence_research', HERE / 'tracked-sequence-research.py')
seq = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(seq)

VERSION = 'classic-models-v1'
COST = seq.COST
COMPACT = ['return1', 'return5', 'return20', 'return60', 'trendGap', 'momentumAcceleration', 'drawdownFromHigh',
           'rangePosition', 'volRatio', 'volOfVol', 'downsideShare', 'dailyVol', 'intradayRange', 'dwellShare']
# ETS forms on the daily variance proxy: (error, trend, damped, seasonal)
VAR_FORMS = {'ses': ('add', None, False, None), 'holt': ('add', 'add', True, None),
             'holtWintersAdd': ('add', None, False, 'add'), 'holtWintersMul': ('mul', None, False, 'mul'),
             'holtWintersTriple': ('mul', 'add', True, 'mul')}
PRICE_FORMS = {'holtPrice': ('add', 'add', True, None), 'holtWintersPrice': ('add', 'add', True, 'add')}
DIRECTION_NEW = ['naiveBayes', 'naiveBayesCompact', 'stump', 'baggedStumps', 'adaBoostStumps', 'gradientBoostedStumps',
                 'randomForest', 'randomForestBalanced', 'logisticBalanced', 'holtPrice', 'holtWintersPrice']
MAGNITUDE_NEW = list(VAR_FORMS) + ['autoEts', 'garchEtsCombo']
Z68, Z95 = 0.994458, 1.959964


# ------------------------------------------------------------ exponential smoothing

def hw_filter(y, trend, seasonal, m, alpha, beta, gamma, phi, l0, b0, s0):
    """statsmodels' Holt-Winters component form (_ets_smooth.pyx), which it
    uses for every error type: the error type changes the likelihood, never
    the recursion. Returns one-step forecasts and the states after each
    observation; buf[t % m] holds the newest season for that phase."""
    n = len(y)
    bs = beta / alpha if trend and alpha > 0 else 0.0
    gs = gamma / (1 - alpha) if seasonal and alpha < 1 else 0.0
    phi = phi if trend else 1.0
    lv, b = float(l0), (float(b0) if trend else 0.0)
    buf = np.array(s0, dtype=float).copy() if seasonal else None
    mul = seasonal == 'mul'
    yhat = np.empty(n); L = np.empty(n); B = np.empty(n); S = np.empty((n, m)) if seasonal else None
    for t in range(n):
        base = lv + phi * b if trend else lv
        s = buf[t % m] if seasonal else (1.0 if mul else 0.0)
        yhat[t] = base * s if mul else base + s
        ln = alpha * (y[t] / s if mul else y[t] - s) + (1 - alpha) * base
        if trend: b = bs * (ln - lv) + (1 - bs) * phi * b
        if seasonal: buf[t % m] = gs * (y[t] / ln if mul else y[t] - ln) + (1 - gs) * s
        lv = ln; L[t] = lv; B[t] = b
        if seasonal: S[t] = buf
    return yhat, L, B, S


def hw_forecast(L, B, S, t, k, trend, seasonal, m, phi):
    """k-step forecast from the state after observation t (k <= m if seasonal)."""
    damp = sum(phi ** j for j in range(1, k + 1)) if trend else 0.0
    base = L[t] + damp * B[t]
    if not seasonal: return base
    s = S[t][(t + k) % m]
    return base * s if seasonal == 'mul' else base + s


def fit_ets(y, form, m):
    """statsmodels ETSModel with heuristic initialization (the initial states
    depend only on the first observations, so extending the series forward
    from the same start reproduces them). None if the fit fails."""
    from statsmodels.tsa.exponential_smoothing.ets import ETSModel
    error, trend, damped, seasonal = form
    kw = dict(error=error, trend=trend, damped_trend=damped, seasonal=seasonal, initialization_method='heuristic')
    if seasonal: kw['seasonal_periods'] = m
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            res = ETSModel(np.asarray(y, dtype=float), **kw).fit(disp=False, maxiter=400)
    except Exception:
        return None
    g = lambda a, d: (getattr(res, a, None) if getattr(res, a, None) is not None else d)
    out = {'alpha': float(res.smoothing_level), 'beta': float(g('smoothing_trend', 0.0)), 'gamma': float(g('smoothing_seasonal', 0.0)),
           'phi': float(g('damping_trend', 1.0)), 'l0': float(res.initial_level), 'b0': float(g('initial_trend', 0.0)),
           's0': np.asarray(res.initial_seasonal, dtype=float) if seasonal else None, 'aicc': float(res.aicc),
           'sigma': float(np.std(np.asarray(res.resid)))}
    if not all(math.isfinite(out[k]) for k in ('alpha', 'l0', 'aicc')): return None
    return out


def ets_states(y, form, m, fit):
    _, trend, _, seasonal = form
    return hw_filter(np.asarray(y, dtype=float), trend, seasonal, m, fit['alpha'], fit['beta'], fit['gamma'], fit['phi'],
                     fit['l0'], fit['b0'], fit['s0'])


# ------------------------------------------------------------ the asset's daily series

def daily_series(rows):
    """One observation per date, known at that close: the day's simple return
    in percent and the log price (cumulative log return, in percent)."""
    by = {}
    for r in rows:
        v = r['values'].get('returnLag0')
        if v is not None and math.isfinite(v): by[r['date']] = v
    dates = sorted(by)
    logret = np.array([by[d] for d in dates], dtype=float)
    return dates, np.expm1(logret) * 100, np.cumsum(logret) * 100


def window(dates, end_date, n=730):
    """Index range [lo, hi] of the last n observations dated <= end_date."""
    hi = int(np.searchsorted(np.array(dates), end_date, side='right')) - 1
    return max(0, hi - n + 1), hi


# ------------------------------------------------------------ direction families

def staged_best(model, x, u, xv, uv):
    """Stage count with the lowest validation log loss (at least 10)."""
    best, best_n = float('inf'), 10
    for i, p in enumerate(model.staged_predict_proba(xv)):
        q = np.clip(p[:, 1], 1e-6, 1 - 1e-6)
        ll = float(np.mean(-uv * np.log(q) - (1 - uv) * np.log(1 - q)))
        if ll < best - 1e-9: best, best_n = ll, i + 1
    return max(10, best_n)


def direction_models(train, val, test, light=False):
    """`light` (tests only) shrinks every ensemble; nothing else changes."""
    from sklearn.naive_bayes import GaussianNB
    from sklearn.tree import DecisionTreeClassifier
    from sklearn.ensemble import (AdaBoostClassifier, BaggingClassifier, GradientBoostingClassifier,
                                  RandomForestClassifier)
    from sklearn.linear_model import LogisticRegression
    warnings.filterwarnings('ignore')
    full = train + val
    u = np.array([r['target'] > 0 for r in train], dtype=float)
    uv = np.array([r['target'] > 0 for r in val], dtype=float)
    uf = np.array([r['target'] > 0 for r in full], dtype=float)
    x, xt0 = seq.tabular(train, test); _, xv = seq.tabular(train, val); xf, xft = seq.tabular(full, test)
    n = len(full); leaf = max(30, int(0.05 * n))
    out = {'logistic': LogisticRegression(C=0.1, max_iter=1000).fit(xf, uf).predict_proba(xft)[:, 1],
           'logisticBalanced': LogisticRegression(C=0.1, max_iter=1000, class_weight='balanced').fit(xf, uf).predict_proba(xft)[:, 1],
           'naiveBayes': GaussianNB().fit(xf, uf).predict_proba(xft)[:, 1]}
    ca, cb = tr.transform(tr.matrix(full, COMPACT), tr.matrix(test, COMPACT))
    out['naiveBayesCompact'] = GaussianNB().fit(ca[:, 1:], uf).predict_proba(cb[:, 1:])[:, 1]
    stump = lambda: DecisionTreeClassifier(max_depth=1, min_samples_leaf=leaf, random_state=7)
    out['stump'] = stump().fit(xf, uf).predict_proba(xft)[:, 1]
    nb, nr, ns = (20, 30, 40) if light else (200, 300, 400)
    out['baggedStumps'] = BaggingClassifier(estimator=stump(), n_estimators=nb, max_samples=0.8, random_state=7,
                                            n_jobs=1).fit(xf, uf).predict_proba(xft)[:, 1]
    if u.min() != u.max() and uv.min() != uv.max():
        ada = AdaBoostClassifier(estimator=DecisionTreeClassifier(max_depth=1), n_estimators=ns * 3 // 4, learning_rate=0.1,
                                 random_state=7).fit(x, u)
        n_ada = staged_best(ada, x, u, xv, uv)
        gb = GradientBoostingClassifier(max_depth=1, learning_rate=0.05, n_estimators=ns, subsample=0.8,
                                        min_samples_leaf=30, random_state=7).fit(x, u)
        n_gb = staged_best(gb, x, u, xv, uv)
    else:
        n_ada, n_gb = 50, 50
    out['adaBoostStumps'] = AdaBoostClassifier(estimator=DecisionTreeClassifier(max_depth=1), n_estimators=n_ada,
                                               learning_rate=0.1, random_state=7).fit(xf, uf).predict_proba(xft)[:, 1]
    out['gradientBoostedStumps'] = GradientBoostingClassifier(max_depth=1, learning_rate=0.05, n_estimators=n_gb, subsample=0.8,
                                                              min_samples_leaf=30, random_state=7).fit(xf, uf).predict_proba(xft)[:, 1]
    rf = dict(n_estimators=nr, min_samples_leaf=25, max_features='sqrt', random_state=7, n_jobs=1)
    out['randomForest'] = RandomForestClassifier(**rf).fit(xf, uf).predict_proba(xft)[:, 1]
    out['randomForestBalanced'] = RandomForestClassifier(class_weight='balanced_subsample', **rf).fit(xf, uf).predict_proba(xft)[:, 1]
    return out


# ------------------------------------------------------------ the fold loop

def evaluate_asset(rows, horizon, test_start, asof, season=7, stats=None, daily_rows=None, light=False):
    """`rows` are this horizon's labelled rows; `daily_rows` (default: the
    same) supply the daily series, so a 7-day label missing at the far end of
    a data hole never punches a hole in the 1-day series the smoothing reads."""
    rows = sorted([r for r in rows if r['target'] is not None], key=lambda r: r['date'])
    dates, dret, logp = daily_series(daily_rows if daily_rows is not None else rows)
    pos = {d: i for i, d in enumerate(dates)}
    records = []
    for train, val, test in tr.folds(rows, test_start, asof):
        full = train + val
        y = np.array([r['target'] for r in full]); yt = np.array([r['target'] for r in test])
        uf = (y > 0).astype(float)
        prob, mag, var, signed = {}, {}, {}, {}
        prob['baseRate'] = np.full(len(test), (uf.sum() + 1) / (len(uf) + 2))
        signed['zero'] = np.zeros(len(test))
        med = float(np.median(abs(y)))
        mag['medianAbs'] = np.full(len(test), med); var['medianAbs'] = np.full(len(test), float(np.mean(y * y)))

        def add_size(name, f_full, f_test):
            ok = np.isfinite(f_full) & (f_full > 0)
            good_t = np.isfinite(f_test) & (f_test > 0)
            if ok.sum() < 30 or not good_t.all():
                if stats is not None: stats['sizeFallback'] = stats.get('sizeFallback', 0) + 1
                mag[name] = mag['medianAbs'].copy(); var[name] = var['medianAbs'].copy(); return
            mag[name] = f_test * float(np.median(abs(y[ok]) / f_full[ok]))
            var[name] = f_test ** 2 * float(np.mean(y[ok] ** 2 / f_full[ok] ** 2))

        g_full = np.array([r['garchWeekdayPct'] if r['garchWeekdayPct'] is not None else np.nan for r in full])
        g_test = np.array([r['garchWeekdayPct'] if r['garchWeekdayPct'] is not None else np.nan for r in test])
        add_size('garchWeekday', g_full, np.where(np.isfinite(g_test), g_test, np.nan))
        if not np.isfinite(g_test).all():  # the sequence study's benchmark fallback
            mag['garchWeekday'] = np.where(np.isfinite(g_test), mag['garchWeekday'], mag['medianAbs'])

        # ---- exponential smoothing on the daily variance proxy
        lo, hi = window(dates, full[-1]['date'])
        last_needed = max(pos.get(r['date'], -1) for r in test)
        # A tiny floor keeps the squared returns positive for the multiplicative
        # forms; a forecast is floored at a tenth of the typical day's variance,
        # as any practitioner would, so an additive form that forecasts ~0 is
        # judged on its level, not on QLIKE's blow-up at zero. Both come from
        # the fit window only (test-classic-models-research.py caught the
        # whole-series version).
        typical_day = float(np.median(dret[lo:hi + 1] ** 2)) if hi >= lo else 0.0
        x2 = dret ** 2 + 1e-4 * typical_day + 1e-12
        floor = 0.1 * typical_day + 1e-12
        fits = {}
        if hi - lo >= 120 and last_needed > hi:
            idx_full = [pos.get(r['date']) for r in full]; idx_test = [pos.get(r['date']) for r in test]
            for name, form in VAR_FORMS.items():
                fit = fit_ets(x2[lo:hi + 1], form, season)
                if fit is None:
                    if stats is not None: stats['etsFail'] = stats.get('etsFail', 0) + 1
                    continue
                _, L, B, S = ets_states(x2[lo:last_needed + 1], form, season, fit)
                def sig(i, form=form, fit=fit, L=L, B=B, S=S):
                    if i is None or i < lo: return np.nan
                    t = i - lo
                    v = sum(max(hw_forecast(L, B, S, t, k, form[1], form[3], season, fit['phi']), floor) for k in range(1, horizon + 1))
                    return math.sqrt(v)
                fits[name] = (fit['aicc'], np.array([sig(i) for i in idx_full]), np.array([sig(i) for i in idx_test]))
                add_size(name, fits[name][1], fits[name][2])
        for name in VAR_FORMS:
            if name not in mag: mag[name] = mag['medianAbs'].copy(); var[name] = var['medianAbs'].copy()
        if fits:
            best = min(fits, key=lambda k: fits[k][0])
            add_size('autoEts', fits[best][1], fits[best][2])
            if stats is not None: stats.setdefault('autoEtsPick', {}); stats['autoEtsPick'][best] = stats['autoEtsPick'].get(best, 0) + 1
            gf, gt = g_full, g_test
            cf, ct = np.sqrt(gf * fits[best][1]), np.sqrt(gt * fits[best][2])
            add_size('garchEtsCombo', cf, ct)
        else:
            mag['autoEts'] = mag['medianAbs'].copy(); var['autoEts'] = var['medianAbs'].copy()
            mag['garchEtsCombo'] = mag['garchWeekday'].copy(); var['garchEtsCombo'] = var['garchWeekday'].copy()

        # ---- exponential smoothing on log price: direction and the signed move
        for name, form in PRICE_FORMS.items():
            fit = fit_ets(logp[lo:hi + 1], form, season) if hi - lo >= 120 and last_needed > hi else None
            if fit is None:
                prob[name] = prob['baseRate'].copy(); signed[name] = np.zeros(len(test)); continue
            _, L, B, S = ets_states(logp[lo:last_needed + 1], form, season, fit)
            p_out, s_out = [], []
            for r in test:
                t = pos[r['date']] - lo
                delta = hw_forecast(L, B, S, t, horizon, form[1], form[3], season, fit['phi']) - logp[pos[r['date']]]
                sd = fit['sigma'] * math.sqrt(horizon)
                p_out.append(seq.normal_cdf(delta / sd) if sd > 0 else 0.5); s_out.append(math.expm1(delta / 100) * 100)
            prob[name] = np.array(p_out); signed[name] = np.array(s_out)

        # ---- classifiers
        prob.update(direction_models(train, val, test, light=light))

        for i, r in enumerate(test):
            records.append({'date': r['date'], 'targetDate': r['targetDate'], 'target': r['target'],
                            'prob': {k: float(v[i]) for k, v in prob.items()}, 'mag': {k: float(v[i]) for k, v in mag.items()},
                            'var': {k: float(v[i]) for k, v in var.items()}, 'signed': {k: float(v[i]) for k, v in signed.items()}})
    return records


# ------------------------------------------------------------ scoring

def auc(p, u):
    pos, neg = p[u == 1], p[u == 0]
    if not len(pos) or not len(neg): return None
    order = np.argsort(np.r_[pos, neg]); ranks = np.empty(len(order)); ranks[order] = np.arange(1, len(order) + 1)
    # average ranks for ties
    allv = np.r_[pos, neg]
    for v in np.unique(allv):
        k = allv == v
        if k.sum() > 1: ranks[k] = ranks[k].mean()
    return float((ranks[:len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def calibration_slope(p, u):
    """Slope of a logistic regression of the outcome on logit(p): 1 = well
    scaled, below 1 = probabilities too extreme (overfit), above 1 = too timid."""
    z = np.log(np.clip(p, 1e-6, 1 - 1e-6) / np.clip(1 - p, 1e-6, 1)); X = np.c_[np.ones(len(z)), z]
    if np.std(z) < 1e-9: return None
    beta = np.zeros(2)
    for _ in range(50):
        q = 1 / (1 + np.exp(-np.clip(X @ beta, -30, 30))); w = np.maximum(q * (1 - q), 1e-9)
        step = np.linalg.solve((X.T * w) @ X + np.eye(2) * 1e-9, X.T @ (u - q)); beta += step
        if np.max(np.abs(step)) < 1e-8: break
    return float(beta[1])


def score(records, horizon):
    out = seq.score(records, horizon)
    if not records: return out
    y = np.array([r['target'] for r in records]); u = (y > 0).astype(float); block = 7 if horizon == 1 else 2
    base = np.clip([r['prob']['baseRate'] for r in records], 1e-6, 1 - 1e-6)
    base_ll = -u * np.log(base) - (1 - u) * np.log(1 - base)
    for model, m in out['direction'].items():
        p = np.clip([r['prob'][model] for r in records], 1e-6, 1 - 1e-6)
        call = p > 0.5
        tp, tn = float(np.sum(call & (u == 1))), float(np.sum(~call & (u == 0)))
        fp, fn = float(np.sum(call & (u == 0))), float(np.sum(~call & (u == 1)))
        sens = tp / (tp + fn) if tp + fn else 0.0; spec = tn / (tn + fp) if tn + fp else 0.0
        den = math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn))
        ll = -u * np.log(p) - (1 - u) * np.log(1 - p)
        m.update({'auc': auc(p, u), 'balancedAccuracy': (sens + spec) / 2, 'mcc': (tp * tn - fp * fn) / den if den else 0.0,
                  'calibrationSlope': calibration_slope(p, u), 'logLossImprovement': tr.block_interval(base_ll - ll, block),
                  'meanP': float(np.mean(p)), 'shareUpCalls': float(np.mean(call))})
    g = np.array([r['var']['garchWeekday'] for r in records]); ql = lambda v: y * y / v + np.log(v)
    for model in records[0]['var']:
        v = np.array([r['var'][model] for r in records])
        if not (np.all(np.isfinite(v)) and np.all(v > 0)): continue
        out['magnitude'].setdefault(model, {})
        out['magnitude'][model]['qlike'] = float(np.mean(ql(v)))
        out['magnitude'][model]['qlikeVsGarchWeekday'] = tr.block_interval(ql(g) - ql(v), block)
        out['magnitude'][model]['varianceRatio'] = float(np.mean(y * y / v))
    return out


def run_asset(task):
    """One (symbol, horizon) cell; a separate process loads only its rows."""
    path, symbol, h, test_start, asof, season = task
    import pickle
    everything = pickle.loads(Path(path).read_bytes())
    rows = [r for r in everything if r['horizon'] == h]
    t0 = time.time(); stats = {}
    recs = evaluate_asset(rows, h, test_start, asof, season=season, stats=stats, daily_rows=everything) if rows else []
    return symbol, h, score(recs, h), recs, stats, time.time() - t0


# ------------------------------------------------------------ correction

def correct(tests):
    """Holm (no false positive anywhere at 5%) and Benjamini-Hochberg (at most
    5% of passes false) across every test in the run."""
    ordered = sorted(tests, key=lambda t: t['p']); n = len(ordered); prev = 0.0
    for i, t in enumerate(ordered):
        prev = max(prev, min(1.0, t['p'] * (n - i))); t['holmP'] = prev
    q = 1.0
    for i in range(n - 1, -1, -1):
        q = min(q, ordered[i]['p'] * n / (i + 1)); ordered[i]['bhQ'] = q
    return n


def family_tests(assets):
    """Every new-family comparison in the run, in one family."""
    tests = []
    for sym, hs in assets.items():
        for h, r in hs.items():
            if not r.get('observations'): continue
            for name in DIRECTION_NEW:
                d = r['direction'].get(name)
                if d: tests.append({**d['brierImprovement'], 'cell': f'{sym}|{h}', 'model': name, 'question': 'direction'})
            for name in MAGNITUDE_NEW:
                d = r['magnitude'].get(name)
                if not d: continue
                if 'vsGarchWeekday' in d:
                    tests.append({**d['vsGarchWeekday'], 'cell': f'{sym}|{h}', 'model': name, 'question': 'sizeMaeVsGarch'})
                if 'qlikeVsGarchWeekday' in d:
                    tests.append({**d['qlikeVsGarchWeekday'], 'cell': f'{sym}|{h}', 'model': name, 'question': 'sizeQlikeVsGarch'})
    return tests


# ------------------------------------------------------------ prediction intervals

def vol90_at(dates, dret, h):
    """{date: 90-day realized volatility (population sd of daily % returns,
    worker.js realizedVolPct) x sqrt(h)} for every date with 90 prior days."""
    out = {}
    c1 = np.concatenate([[0.0], np.cumsum(dret)]); c2 = np.concatenate([[0.0], np.cumsum(dret * dret)])
    for i in range(89, len(dret)):
        s1, s2 = c1[i + 1] - c1[i - 89], c2[i + 1] - c2[i - 89]
        mu = s1 / 90; out[dates[i]] = math.sqrt(max(s2 / 90 - mu * mu, 0.0)) * math.sqrt(h)
    return out


def interval_bounds(z_pool, level):
    a = (1 - level) / 2
    return float(np.quantile(z_pool, a)), float(np.quantile(z_pool, 1 - a))


def interval_score(lo, hi, y, level):
    a = 1 - level
    return (hi - lo) + (2 / a) * np.maximum(lo - y, 0) + (2 / a) * np.maximum(y - hi, 0)


def interval_study(by_symbol, horizon, test_start, asof, sims=20000, seed=11):
    """68% and 95% ranges for every asset of one class at one horizon.

    Sources of the volatility (sigma for the whole horizon, in %):
      garch   GARCH(1,1) + weekday (the size champion)
      vol90   90-day realized volatility x sqrt(h) (the worker's band since 2026-09-27)
      ewma    RiskMetrics EWMA (lambda 0.94) x sqrt(h), the timely classic
    Methods, each refitted every 28 days on labels matured by then:
      gaussRaw        +-z sigma, sigma as the source gives it
      gaussVarAsset   +-z s sigma, s^2 = mean(z^2) over the asset's own labels
      gaussVarClass   the same s from every asset in the class (the worker's band)
      quantAsset      the asset's own empirical quantiles of y / sigma
      quantClass      the class's pooled empirical quantiles
      monteCarlo      h-day sums of bootstrapped 1-day standardized moves (class
                      pool), scaled by the class's h-day variance factor: the
                      shape of an h-day move under fat daily tails
    Scored on each asset's non-overlapping test rows by coverage, width and
    the interval score (Gneiting & Raftery 2007), which a forecaster only
    minimizes by quoting the true quantiles."""
    rng = np.random.default_rng(seed)
    cal, test = [], []
    for sym, (rows, rows1, dates, dret) in by_symbol.items():
        v90 = vol90_at(dates, dret, horizon); v90_1 = vol90_at(dates, dret, 1)
        def sigmas(r, h=horizon, v=v90):
            g = r.get('garchWeekdayPct'); e = r['values'].get('ewmaVol')
            return {'garch': g if g and g > 0 else None, 'vol90': v.get(r['date']),
                    'ewma': e * 100 * math.sqrt(h) if e and e > 0 else None}
        for r in rows:
            cal.append((sym, r['date'], r['targetDate'], r['target'], sigmas(r), False))
        for r in rows1:
            cal.append((sym, r['date'], r['targetDate'], r['target'], sigmas(r, 1, v90_1), True))
        for r in tr.nonoverlap([r for r in rows if test_start <= r['date'] and r['targetDate'] < asof]):
            test.append((sym, r['date'], r['target'], sigmas(r)))
    sources = ('garch', 'vol90', 'ewma'); levels = (0.68, 0.95)
    methods = ('gaussRaw', 'gaussVarAsset', 'gaussVarClass', 'quantAsset', 'quantClass') + (('monteCarlo',) if horizon > 1 else ())
    rows_out = []
    starts = []
    d = np.datetime64(test_start)
    while str(d) < asof: starts.append(str(d)); d += np.timedelta64(28, 'D')
    cal.sort(key=lambda c: c[2])
    for k, d0 in enumerate(starts):
        d1 = starts[k + 1] if k + 1 < len(starts) else '9999-12-31'
        lo_date = str(np.datetime64(d0) - np.timedelta64(730, 'D'))
        known = [c for c in cal if c[2] < d0 and c[1] >= lo_date]
        block = [t for t in test if d0 <= t[1] < d1]
        if not block: continue
        z = {s: {'class': [], 'asset': {}, 'daily': []} for s in sources}
        for sym, dt, _, y, sg, daily in known:
            for s in sources:
                if sg[s]:
                    if daily: z[s]['daily'].append(y / sg[s])
                    else:
                        z[s]['class'].append(y / sg[s]); z[s]['asset'].setdefault(sym, []).append(y / sg[s])
        fitted = {}
        for s in sources:
            zc = np.array(z[s]['class'])
            if len(zc) < 200: continue
            sc = math.sqrt(float(np.mean(np.minimum(zc ** 2, 50))))
            f = {'sClass': sc, 'qClass': {lv: interval_bounds(zc, lv) for lv in levels}, 'asset': {}}
            for sym, za in z[s]['asset'].items():
                za = np.array(za[-730:])
                if len(za) >= 60:
                    f['asset'][sym] = (math.sqrt(float(np.mean(np.minimum(za ** 2, 50)))), {lv: interval_bounds(za, lv) for lv in levels})
            if horizon > 1 and len(z[s]['daily']) >= 200:
                zd = np.array(z[s]['daily']); zd = zd / math.sqrt(float(np.mean(np.minimum(zd ** 2, 50))))
                draws = zd[rng.integers(0, len(zd), size=(sims, horizon))].sum(axis=1) / math.sqrt(horizon)
                draws = draws / math.sqrt(float(np.mean(draws ** 2))) * sc
                f['qMc'] = {lv: interval_bounds(draws, lv) for lv in levels}
            fitted[s] = f
        for sym, dt, y, sg in block:
            for s in sources:
                if s not in fitted or not sg[s]: continue
                f = fitted[s]; sig = sg[s]; own = f['asset'].get(sym)
                for lv in levels:
                    zq = Z68 if lv == 0.68 else Z95
                    b = {'gaussRaw': (-zq * sig, zq * sig), 'gaussVarClass': (-zq * f['sClass'] * sig, zq * f['sClass'] * sig),
                         'quantClass': (f['qClass'][lv][0] * sig, f['qClass'][lv][1] * sig)}
                    if own:
                        b['gaussVarAsset'] = (-zq * own[0] * sig, zq * own[0] * sig)
                        b['quantAsset'] = (own[1][lv][0] * sig, own[1][lv][1] * sig)
                    if 'qMc' in f: b['monteCarlo'] = (f['qMc'][lv][0] * sig, f['qMc'][lv][1] * sig)
                    for mth, (lo_, hi_) in b.items():
                        rows_out.append((sym, dt, s, mth, lv, lo_, hi_, y))
    # summarise
    out = {'testRows': len(test), 'byMethod': {}}
    arr = {}
    for sym, dt, s, mth, lv, lo_, hi_, y in rows_out:
        arr.setdefault((s, mth, lv), []).append((dt, sym, lo_, hi_, y))
    base_key = lambda lv: ('vol90', 'gaussVarClass', lv)
    for (s, mth, lv), items in arr.items():
        lo_ = np.array([i[2] for i in items]); hi_ = np.array([i[3] for i in items]); y = np.array([i[4] for i in items])
        isc = interval_score(lo_, hi_, y, lv)
        entry = {'n': len(items), 'coverage': float(np.mean((y >= lo_) & (y <= hi_))), 'width': float(np.mean(hi_ - lo_)),
                 'intervalScore': float(np.mean(isc)), 'belowShare': float(np.mean(y < lo_)), 'aboveShare': float(np.mean(y > hi_))}
        base = {(i[0], i[1]): interval_score(i[2], i[3], i[4], lv) for i in arr.get(base_key(lv), [])}
        per_date = {}
        for (dt, sym, a, b_, yy), sc_ in zip(items, isc):
            if (dt, sym) in base: per_date.setdefault(dt, []).append(base[(dt, sym)] - sc_)
        if per_date and (s, mth, lv) != base_key(lv):
            dd = np.array([np.mean(per_date[k]) for k in sorted(per_date)])
            entry['vsWorkerBand'] = tr.block_interval(dd, 7 if horizon == 1 else 2)
        out['byMethod'][f'{s}|{mth}|{int(lv * 100)}'] = entry
    return out


# ------------------------------------------------------------ one model for the whole class

def global_direction(rows_by_symbol, horizon, test_start, asof, light=False):
    """Direction models fitted on EVERY asset of the class at once (a global
    model, the cross-learning that won the M4/M5 forecasting competitions),
    refitted every 28 days, scored per asset against that asset's own base
    rate and against the class's base rate."""
    from sklearn.naive_bayes import GaussianNB
    from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier, AdaBoostClassifier
    from sklearn.tree import DecisionTreeClassifier
    from sklearn.linear_model import LogisticRegression
    warnings.filterwarnings('ignore')
    allrows = sorted([dict(r, symbol=s) for s, rs in rows_by_symbol.items() for r in rs if r['target'] is not None],
                     key=lambda r: r['date'])
    tests = []
    for s, rs in rows_by_symbol.items():
        tests += [dict(r, symbol=s) for r in tr.nonoverlap([r for r in rs if r['target'] is not None
                                                            and test_start <= r['date'] and r['targetDate'] < asof])]
    starts = []; d = np.datetime64(test_start)
    while str(d) < asof: starts.append(str(d)); d += np.timedelta64(28, 'D')
    valdays = 60 if horizon == 1 else 140
    records = []
    for k, d0 in enumerate(starts):
        d1 = starts[k + 1] if k + 1 < len(starts) else '9999-12-31'
        block = [t for t in tests if d0 <= t['date'] < d1]
        if not block: continue
        lo_date = str(np.datetime64(d0) - np.timedelta64(730, 'D'))
        vstart = str(np.datetime64(d0) - np.timedelta64(valdays, 'D'))
        known = [r for r in allrows if r['targetDate'] < d0 and r['date'] >= lo_date]
        val = [r for r in known if r['date'] >= vstart]
        train = [r for r in known if r['targetDate'] < vstart]
        if len(train) < (200 if light else 2000) or len(val) < (20 if light else 200): continue
        full = train + val
        u = np.array([r['target'] > 0 for r in train], dtype=float); uv = np.array([r['target'] > 0 for r in val], dtype=float)
        uf = np.array([r['target'] > 0 for r in full], dtype=float)
        x, _ = seq.tabular(train, block[:1]); _, xv = seq.tabular(train, val); xf, xt = seq.tabular(full, block)
        prob = {'classBaseRate': np.full(len(block), (uf.sum() + 1) / (len(uf) + 2))}
        own = {}
        for sym in {t['symbol'] for t in block}:
            mine = [r for r in rows_by_symbol[sym] if r['target'] is not None and r['targetDate'] < d0][-730:]
            um = np.array([r['target'] > 0 for r in mine], dtype=float)
            own[sym] = (um.sum() + 1) / (len(um) + 2)
        prob['baseRate'] = np.array([own[t['symbol']] for t in block])
        prob['logistic'] = LogisticRegression(C=0.1, max_iter=2000).fit(xf, uf).predict_proba(xt)[:, 1]
        prob['naiveBayes'] = GaussianNB().fit(xf, uf).predict_proba(xt)[:, 1]
        nr, ns = (20, 30) if light else (200, 300)
        prob['randomForest'] = RandomForestClassifier(n_estimators=nr, max_samples=0.5, min_samples_leaf=200, max_features='sqrt',
                                                      random_state=7, n_jobs=1).fit(xf, uf).predict_proba(xt)[:, 1]
        gb = GradientBoostingClassifier(max_depth=1, learning_rate=0.05, n_estimators=ns, subsample=0.5,
                                        min_samples_leaf=100, random_state=7).fit(x, u)
        n_gb = staged_best(gb, x, u, xv, uv)
        prob['gradientBoostedStumps'] = GradientBoostingClassifier(max_depth=1, learning_rate=0.05, n_estimators=n_gb, subsample=0.5,
                                                                   min_samples_leaf=100, random_state=7).fit(xf, uf).predict_proba(xt)[:, 1]
        ada = AdaBoostClassifier(estimator=DecisionTreeClassifier(max_depth=1), n_estimators=ns * 2 // 3, learning_rate=0.1,
                                 random_state=7).fit(x, u)
        n_ada = staged_best(ada, x, u, xv, uv)
        prob['adaBoostStumps'] = AdaBoostClassifier(estimator=DecisionTreeClassifier(max_depth=1), n_estimators=n_ada,
                                                    learning_rate=0.1, random_state=7).fit(xf, uf).predict_proba(xt)[:, 1]
        for i, t in enumerate(block):
            records.append({'symbol': t['symbol'], 'date': t['date'], 'target': t['target'],
                            'prob': {m: float(v[i]) for m, v in prob.items()}})
    return records


def score_global(records, horizon):
    """Pooled across assets: Brier and log-loss improvement of each global
    model over (a) each asset's own base rate and (b) the class's base rate,
    averaged per date first (assets on one date move together)."""
    if not records: return {'observations': 0}
    block = 7 if horizon == 1 else 2
    u = np.array([r['target'] > 0 for r in records], dtype=float)
    dates = [r['date'] for r in records]
    out = {'observations': len(records), 'assets': len({r['symbol'] for r in records}), 'upRate': float(u.mean()), 'models': {}}
    def per_date(v):
        acc = {}
        for d, x in zip(dates, v): acc.setdefault(d, []).append(x)
        return np.array([np.mean(acc[d]) for d in sorted(acc)])
    losses = {m: (np.clip([r['prob'][m] for r in records], 1e-6, 1 - 1e-6) - u) ** 2 for m in records[0]['prob']}
    for m in records[0]['prob']:
        p = np.clip([r['prob'][m] for r in records], 1e-6, 1 - 1e-6)
        out['models'][m] = {'brier': float(losses[m].mean()), 'auc': auc(p, u), 'calibrationSlope': calibration_slope(p, u),
                            'vsOwnBaseRate': tr.block_interval(per_date(losses['baseRate'] - losses[m]), block),
                            'vsClassBaseRate': tr.block_interval(per_date(losses['classBaseRate'] - losses[m]), block)}
    return out


def run_global(task):
    rows_dir, symbols, h, test_start, asof, cls = task
    import pickle
    by = {}
    for s in symbols:
        rs = pickle.loads((Path(rows_dir) / f'{s}.pkl').read_bytes())
        by[s] = [r for r in rs if r['horizon'] == h]
    t0 = time.time()
    recs = global_direction(by, h, test_start, asof)
    return cls, h, score_global(recs, h), recs, time.time() - t0


# ------------------------------------------------------------ entry point

def main():
    import pickle, gzip
    from multiprocessing import Pool
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', default='', help='tournament input (model-tournament-io.mjs data) or research rows')
    ap.add_argument('--rows-dir', default='', help="reuse an earlier run's split rows (its _rows folder, with manifest.json)")
    ap.add_argument('--extra', default='', help='more rows, e.g. market indexes, with their own assetClassBySymbol')
    ap.add_argument('--output', required=True); ap.add_argument('--test-days', type=int, default=720)
    ap.add_argument('--symbols', default=''); ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--stages', default='assets,intervals,global')
    a = ap.parse_args()
    dest = Path(a.output); dest.mkdir(parents=True, exist_ok=True)
    if a.rows_dir:
        rows_dir = Path(a.rows_dir); man = json.loads((rows_dir / 'manifest.json').read_text())
        asof, cls_of, input_hash = man['asOf'], man['assetClassBySymbol'], man['inputHash']
        symbols = [s for s in a.symbols.split(',') if s] or list(man['symbols'])
    else:
        rows_dir = dest / '_rows'; rows_dir.mkdir(exist_ok=True)
        raw = Path(a.input).read_bytes(); data = json.loads(raw); input_hash = hashlib.sha256(raw).hexdigest(); del raw
        asof = data['asOf']
        cls_of = dict(data.get('assetClassBySymbol') or {})
        symbols = [s for s in a.symbols.split(',') if s] or list(data['symbols'])
        by = {}
        for r in data['rows']:
            if r['symbol'] in symbols: by.setdefault(r['symbol'], []).append(r)
        if a.extra:
            ex = json.loads(Path(a.extra).read_bytes()); cls_of.update(ex.get('assetClassBySymbol') or {})
            for r in ex['rows']: by.setdefault(r['symbol'], []).append(r)
            symbols += [s for s in ex['symbols'] if s not in symbols]
        for s, rs in by.items():
            (rows_dir / f'{s}.pkl').write_bytes(pickle.dumps(rs))
        (rows_dir / 'manifest.json').write_text(json.dumps({'asOf': asof, 'symbols': symbols, 'assetClassBySymbol': cls_of,
                                                           'inputHash': input_hash}))
        del data, by
    test_start = str(np.datetime64(asof) - np.timedelta64(a.test_days, 'D'))
    report = {'version': VERSION, 'asOf': asof, 'testStart': test_start, 'testDays': a.test_days, 'actionable': False,
              'inputHash': input_hash, 'codeHash': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'assets': {}, 'stats': {}, 'timings': {}}
    stages = set(a.stages.split(','))
    horizons = lambda s: (1, 5) if cls_of.get(s) == 'stock' else (1, 7)
    season = lambda s: 5 if cls_of.get(s) == 'stock' else 7
    tasks = [(str(rows_dir / f'{s}.pkl'), s, h, test_start, asof, season(s)) for s in symbols
             if (rows_dir / f'{s}.pkl').exists() for h in horizons(s)]
    preds = {}
    if 'assets' in stages:
        t0 = time.time()
        with Pool(a.workers) as pool:
            for sym, h, sc, recs, stats, dt in pool.imap_unordered(run_asset, tasks):
                report['assets'].setdefault(sym, {})[str(h)] = sc; report['stats'][f'{sym}|{h}'] = stats
                report['timings'][f'{sym}|{h}'] = round(dt, 1); preds[f'{sym}|{h}'] = recs
                print(f'{sym} {h}d: {sc.get("observations", 0)} test outcomes in {dt:.0f}s ({time.time() - t0:.0f}s elapsed)', flush=True)
        tests = family_tests(report['assets']); report['familySize'] = correct(tests)
        report['tests'] = tests
    if 'global' in stages:
        report['global'] = {}
        gtasks = []
        for cls in ('crypto', 'stock'):
            members = [s for s in symbols if cls_of.get(s) == cls and not s.startswith('MKT_') and s != 'SPY'
                       and (rows_dir / f'{s}.pkl').exists()]
            for h in ((1, 5) if cls == 'stock' else (1, 7)):
                gtasks.append((str(rows_dir), members, h, test_start, asof, cls))
        with Pool(min(a.workers, len(gtasks))) as pool:
            for cls, h, sc, recs, dt in pool.imap_unordered(run_global, gtasks):
                report['global'][f'{cls}|{h}'] = sc; preds[f'global|{cls}|{h}'] = recs
                print(f'global {cls} {h}d: {sc.get("observations", 0)} outcomes in {dt:.0f}s', flush=True)
    if 'intervals' in stages:
        report['intervals'] = {}
        for cls in ('crypto', 'stock'):
            members = [s for s in symbols if cls_of.get(s) == cls and not s.startswith('MKT_') and (rows_dir / f'{s}.pkl').exists()]
            for h in ((1, 5) if cls == 'stock' else (1, 7)):
                bys = {}
                for s in members:
                    rs = [r for r in pickle.loads((rows_dir / f'{s}.pkl').read_bytes()) if r['target'] is not None]
                    dates, dret, _ = daily_series(rs)
                    bys[s] = ([r for r in rs if r['horizon'] == h], [r for r in rs if r['horizon'] == 1], dates, dret)
                t0 = time.time()
                report['intervals'][f'{cls}|{h}'] = interval_study(bys, h, test_start, asof)
                print(f'intervals {cls} {h}d in {time.time() - t0:.0f}s', flush=True)
    (dest / 'report.json').write_text(json.dumps(report, indent=1, allow_nan=False, default=float))
    with gzip.open(dest / 'predictions.json.gz', 'wt') as f: json.dump(preds, f, allow_nan=False)
    print('done', flush=True)


if __name__ == '__main__':
    main()
