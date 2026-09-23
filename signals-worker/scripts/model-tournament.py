#!/usr/bin/env python3
"""Per-asset model tournament (model-tournament-v1).

Asked 2026-09-23: let the learning model get better at predicting and timing
from everything we log, "even if that means creating/generating its own models
per asset", and "learn how to weigh each data/information per asset".

Every always-tracked asset has five slots -- direction at 1 and 7 days, move
size at 1 and 7 days, and timing (which 4-hour firing of the day after next is
cheapest) -- plus one pooled slot per target across all of them. Each slot has
an incumbent (production's current method, or a model that has since earned
its place) and up to six challengers. Every challenger is fitted per asset,
so it learns that asset's own weights; the weekly generator proposes
challengers built from different groups of inputs, so the inputs themselves
compete per asset.

The one rule that makes a self-generating search safe: NOTHING IS PROMOTED ON
THE DATA THAT CHOSE IT. The generator may rank candidates on history, but a
challenger replaces the incumbent only on forecasts it logged before their
outcomes existed (model_forecasts), through a test that stays valid however
often it is checked: a betting e-process on the paired loss difference,
promotion when it reaches 1/alpha_j (Ville's inequality), with alpha spent
across challengers in admission order. A champion that stops beating what it
replaced is demoted the same way. Search width therefore costs time, never
false promotions.

Research only in the sense that matters: this writes forecasts and a
registry, and places nothing. Downstream use of a champion is gated by the
reader (build-signals marks it actionable only once promoted).
"""
import argparse, hashlib, importlib.util, json, math, sys, time, warnings
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('tracked_research', HERE / 'tracked-research.py')
tr = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(tr)

VERSION = 'model-tournament-v1'
POOLED = '*'
SLOTS = (('direction', 1), ('direction', 7), ('magnitude', 1), ('magnitude', 7), ('timing', 2))
TRAIN_MAX = 730              # matured labels a fit may use
ALPHA = 0.05                 # per slot, spent over challengers in admission order
DEMOTE_E = 20.0              # a champion worse than its fallback at e >= 20 is demoted
RETIRE_E = 20.0              # a challenger worse than the incumbent at e >= 20 is retired
MIN_FORWARD = {1: 60, 7: 20, 2: 60}
MAX_FORWARD = {1: 540, 7: 80, 2: 540}
LIVE_CHALLENGERS = 6
ADMIT_PER_RUN = 2
LAMBDAS = np.array([0.05, 0.1, 0.2, 0.35, 0.5])
BURN_IN = 10                 # paired outcomes that only set the scale
SCREEN_DAYS = 360            # history the generator ranks candidates on
FIRINGS = 6                  # 4-hour slots per UTC day: 00, 04, ... 20

LAGS = [f'returnLag{k}' for k in range(10)]
GROUPS = {
    'momentum': ['return1', 'return5', 'return20', 'return60', 'trendGap', 'momentumAcceleration',
                 'drawdownFromHigh', 'rangePosition'],
    'volatility': ['volRatio', 'volOfVol', 'downsideShare', 'dailyVol', 'intradayRange', 'dwellShare'],
    'volume': ['volumeRatio', 'volumeTrend'],
    'market': ['market5', 'market20', 'relative5', 'beta60'],
    'lags': LAGS,
    'derivatives': ['oiChange1', 'oiChange7', 'oiPercentile', 'oiPriceDivergence', 'takerRatio',
                    'accountLsChange', 'oiQuantityChange1', 'topTraderPosition'],
    'funding': ['fundingRank'],
    'liquidity': ['bookImbalance', 'logDepth'],
    'supply': ['supplyGrowth30', 'supplyOverhang'],
}
ALL_GROUPS = list(GROUPS) + ['leaders', 'calendar']
DAY = np.timedelta64(1, 'D')


def day(s): return np.datetime64(s, 'D')
def iso(d): return str(np.datetime64(d, 'D'))
def add_days(s, n): return iso(day(s) + n * DAY)


# ------------------------------------------------------------------ specs

def model_id(spec):
    body = json.dumps({k: spec[k] for k in ('target', 'family', 'params')}, sort_keys=True)
    return f"{spec['target']}:{spec['family']}:{hashlib.sha1(body.encode()).hexdigest()[:8]}"


def make(target, family, **params):
    spec = {'target': target, 'family': family, 'params': params}
    spec['id'] = model_id(spec)
    return spec


BENCHMARKS = {
    'direction': make('direction', 'baseRate'),
    'magnitude': make('magnitude', 'scale', source='trailing', calibrated=False),
    'timing': make('timing', 'uniform'),
}


def candidate_grid(target):
    """What the generator may propose. Ordered, finite, and every entry is
    fitted per asset -- the weights are learned, the menu is not."""
    if target == 'direction':
        sets = [['momentum'], ['momentum', 'calendar'], ['momentum', 'volume', 'volatility'],
                ['derivatives', 'funding'], ['derivatives', 'funding', 'momentum'], ['leaders'],
                ['lags', 'calendar'], ['market', 'momentum'], ALL_GROUPS]
        grid = [make('direction', 'logistic', C=c, groups=g) for g in sets for c in (0.03, 0.3)]
        grid += [make('direction', 'lightgbm', groups=g) for g in (['momentum', 'volatility', 'volume'], ALL_GROUPS)]
        return grid
    if target == 'magnitude':
        grid = [make('magnitude', 'scale', source=s, calibrated=c)
                for s in ('garchWeekday', 'garch', 'harWeekday', 'ewma', 'harEqual', 'trailing')
                for c in (True, False) if not (s == 'trailing' and not c)]
        grid += [make('magnitude', 'harx', groups=g) for g in
                 ([], ['volume'], ['volatility'], ['derivatives', 'funding'], ['market'], ['calendar'])]
        return grid
    return [make('timing', 'firingFrequency', window=n, weekday=w) for n in (30, 90, 365) for w in (False, True)]


SOURCE_LABELS = {'trailing': 'trailing volatility', 'garchWeekday': 'GARCH + weekday', 'garch': 'GARCH',
                 'harWeekday': 'seasonal HAR', 'ewma': 'EWMA', 'harEqual': 'HAR'}


def describe(spec):
    """The plain-language name the dashboard shows."""
    f, p = spec['family'], spec['params']
    groups = lambda: ', '.join(p.get('groups') or []) if len(p.get('groups') or []) < len(ALL_GROUPS) else 'every input group'
    if f == 'baseRate': return 'base rate (no skill)'
    if f == 'logistic': return f"logistic on {groups()} ({'strong' if p['C'] < 0.1 else 'light'} shrinkage)"
    if f == 'lightgbm': return f"boosted trees on {groups()}"
    if f == 'scale':
        name = SOURCE_LABELS[p['source']]
        return name + (', calibrated' if p.get('calibrated') else '') + (' (production)' if spec == BENCHMARKS['magnitude'] else '')
    if f == 'harx': return 'HAR regression' + (f" + {groups()}" if p.get('groups') else '')
    if f == 'uniform': return 'no firing preferred'
    if f == 'firingFrequency': return f"cheapest-firing frequency, {p['window']} days" + (', by weekday' if p['weekday'] else '')
    return f


# ------------------------------------------------------------- features

def names_for(groups, rows):
    names = []
    for g in groups:
        if g == 'leaders':
            names += sorted({k for k in (rows[0]['values'] if rows else {}) if k.startswith('leader_')})
        elif g != 'calendar':
            names += GROUPS[g]
    return names


def calendar_block(rows):
    out = []
    for r in rows:
        wd = int(r['values'].get('weekday') or 0); m = int(r['values'].get('month') or 1)
        out.append([1.0 if wd == k else 0.0 for k in range(7)] + [math.sin(2 * math.pi * m / 12), math.cos(2 * math.pi * m / 12)])
    return np.array(out, dtype=float).reshape(len(rows), 9)


CAL_NAMES = [f'weekday:{k}' for k in range(7)] + ['month:sin', 'month:cos']


def design(train, test, groups):
    """tracked-research.transform, keeping column names so weights can be
    reported: fields measured < 25 times in TRAIN dropped, train-median fill,
    one missing indicator per kept field, train-only standardization."""
    names = names_for(groups, train)
    a, b = tr.matrix(train, names), tr.matrix(test, names)
    keep = np.sum(np.isfinite(a), axis=0) >= 25 if names else np.zeros(0, dtype=bool)
    kept = [n for n, k in zip(names, keep) if k]
    a, b = a[:, keep], b[:, keep]
    med = np.nanmedian(np.where(np.isfinite(a), a, np.nan), axis=0) if kept else np.zeros(0)
    fill = lambda x: np.c_[np.where(np.isfinite(x), x, med), (~np.isfinite(x)).astype(float)]
    a, b = fill(a), fill(b)
    cols = kept + [f'{n}:missing' for n in kept]
    if 'calendar' in groups:
        a, b = np.c_[a, calendar_block(train)], np.c_[b, calendar_block(test)]
        cols += CAL_NAMES
    if a.shape[1] == 0:
        return np.zeros((len(train), 0)), np.zeros((len(test), 0)), []
    mu, sd = a.mean(axis=0), a.std(axis=0); sd = np.where(sd > 1e-8, sd, 1.0)
    return np.clip((a - mu) / sd, -8, 8), np.clip((b - mu) / sd, -8, 8), cols


def matured(rows, asof, n=TRAIN_MAX):
    """Labels whose outcome was known at the close of `asof`."""
    return [r for r in rows if r['target'] is not None and r['targetDate'] <= asof][-n:]


# ------------------------------------------------------------ families

def base_sigma(row, source, h):
    v = row['values']; g = lambda k: row.get(k)
    if source == 'trailing': s = v.get('dailyVol')
    elif source == 'ewma': s = v.get('ewmaVol')
    elif source == 'harEqual':
        parts = [v.get(k) for k in ('harDaily', 'harWeek', 'harMonth')]
        s = sum(parts) / 3 if all(p is not None and math.isfinite(p) for p in parts) else None
    else:
        pct = {'garch': g('garchPct'), 'garchWeekday': g('garchWeekdayPct'), 'harWeekday': g('harWeekdayPct')}[source]
        return math.log1p(pct / 100) if pct is not None and pct > -100 else None
    return s * math.sqrt(h) if s is not None and math.isfinite(s) and s > 0 else None


def log_move(r): return math.log1p(r['target'] / 100)


def fit_predict(spec, train, test, h, klines=None):
    """(forecasts for `test`, weights or None). Only `train` is ever fitted on."""
    fam, p = spec['family'], spec['params']
    if spec['target'] == 'direction':
        u = np.array([r['target'] > 0 for r in train], dtype=float)
        if fam == 'baseRate' or len(train) < 60 or u.min() == u.max():
            return [{'pUp': float((u.sum() + 1) / (len(u) + 2))} for _ in test], None
        x, xt, cols = design(train, test, p['groups'])
        if x.shape[1] == 0:
            return [{'pUp': float((u.sum() + 1) / (len(u) + 2))} for _ in test], None
        warnings.filterwarnings('ignore')
        if fam == 'logistic':
            from sklearn.linear_model import LogisticRegression
            m = LogisticRegression(C=p['C'], max_iter=2000).fit(x, u)
            return [{'pUp': float(q)} for q in m.predict_proba(xt)[:, 1]], dict(zip(cols, map(float, m.coef_[0])))
        if fam == 'lightgbm':
            import lightgbm as lgb
            valn = 60 if h == 1 else 20
            fit_rows, val_rows = train[:-valn], train[-valn:]
            fit_rows = [r for r in fit_rows if r['targetDate'] < val_rows[0]['date']]
            make_m = lambda n: lgb.LGBMClassifier(n_estimators=n, num_leaves=7, min_child_samples=30, learning_rate=0.03,
                                                  subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=1.0,
                                                  random_state=7, n_jobs=1, verbose=-1)
            m = make_m(400)
            uf = np.array([r['target'] > 0 for r in fit_rows], dtype=float); uv = np.array([r['target'] > 0 for r in val_rows], dtype=float)
            if len(fit_rows) >= 60 and uf.min() != uf.max():
                xf, xv, _ = design(fit_rows, val_rows, p['groups'])
                m.fit(xf, uf, eval_set=[(xv, uv)], callbacks=[lgb.early_stopping(40, verbose=False)])
                best = max(10, int(m.best_iteration_ or 400))
            else:
                best = 50
            full = make_m(best).fit(x, u)
            gain = full.booster_.feature_importance(importance_type='gain')
            return [{'pUp': float(q)} for q in full.predict_proba(xt)[:, 1]], dict(zip(cols, map(float, gain)))
        raise ValueError(fam)

    if spec['target'] == 'magnitude':
        if fam == 'scale':
            src = p['source']
            c = 1.0
            if p.get('calibrated'):
                ratios = [log_move(r) ** 2 / s ** 2 for r in train for s in [base_sigma(r, src, h)] if s]
                c = math.sqrt(float(np.mean(ratios))) if len(ratios) >= 30 else 1.0
            out = []
            for r in test:
                s = base_sigma(r, src, h) or base_sigma(r, 'trailing', h)
                out.append({'sigma': float(s * c) if s else None})
            return out, None
        if fam == 'harx':
            parts = ('harDaily', 'harWeek', 'harMonth')
            ok = lambda r: all((r['values'].get(k) or 0) > 0 for k in parts)
            tr_rows = [r for r in train if ok(r)]
            if len(tr_rows) < 60:
                return fit_predict(BENCHMARKS['magnitude'], train, test, h)[0], None
            har_raw = lambda rs: np.array([[math.log(r['values'][k] * math.sqrt(h)) for k in parts] for r in rs]).reshape(len(rs), 3)
            hm, hs = har_raw(tr_rows).mean(axis=0), har_raw(tr_rows).std(axis=0)
            hs = np.where(hs > 1e-8, hs, 1.0)
            # Standardized like every other input, so the weights compare.
            har = lambda rs: (har_raw(rs) - hm) / hs
            x, xt, cols = design(tr_rows, test, p['groups'])
            xa = np.c_[np.ones(len(tr_rows)), har(tr_rows), x]
            floor = (0.1 * np.median([abs(log_move(r)) for r in tr_rows])) ** 2 + 1e-12
            y = np.array([math.log(log_move(r) ** 2 + floor) for r in tr_rows])
            reg = np.eye(xa.shape[1]) * 2.0; reg[0, 0] = 0
            beta = np.linalg.solve(xa.T @ xa + reg, xa.T @ y)
            fitted = np.exp(xa @ beta)
            c = float(np.mean([log_move(r) ** 2 for r in tr_rows] / fitted))
            out = []
            for i, r in enumerate(test):
                if not ok(r):
                    s = base_sigma(r, 'trailing', h); out.append({'sigma': float(s) if s else None}); continue
                xr = np.r_[1.0, har([r])[0], xt[i]]
                out.append({'sigma': float(math.sqrt(math.exp(xr @ beta) * c))})
            return out, dict(zip(['har:day', 'har:week', 'har:month'] + cols, map(float, beta[1:])))
        raise ValueError(fam)

    # timing: `train` and `test` are firing-day records, not feature rows.
    if fam == 'uniform':
        return [{'probs': [1.0 / FIRINGS] * FIRINGS} for _ in test], None
    if fam == 'firingFrequency':
        window, by_weekday = p['window'], p['weekday']
        recent = train[-window:]
        counts = np.bincount([d['cheapest'] for d in recent], minlength=FIRINGS).astype(float)
        base = (counts + 1) / (counts.sum() + FIRINGS)
        out = []
        for t in test:
            probs = base
            if by_weekday:
                same = [d['cheapest'] for d in train if d['weekday'] == t['weekday']][-max(8, window // 7):]
                cw = np.bincount(same, minlength=FIRINGS).astype(float) if same else np.zeros(FIRINGS)
                probs = (cw + 10 * base) / (cw.sum() + 10)
            out.append({'probs': [float(v) for v in probs]})
        return out, None
    raise ValueError(fam)


def loss(target, forecast, outcome):
    if target == 'direction':
        p = min(max(forecast['pUp'], 1e-6), 1 - 1e-6)
        return (p - (1.0 if outcome > 0 else 0.0)) ** 2
    if target == 'magnitude':
        s = forecast.get('sigma')
        if not s or s <= 0: return None
        r = math.log1p(outcome / 100)
        return r * r / (s * s) + math.log(s * s)  # QLIKE: proper for a variance forecast
    return -math.log(max(forecast['probs'][int(outcome)], 1e-9))


# ----------------------------------------------------------- timing data

def firing_days(klines):
    """UTC days with all six 4-hour opens -> the index of the cheapest open,
    the firing the spot bot would have bought at."""
    by = {}
    for t, o in klines:
        d = np.datetime64(int(t), 'ms').astype('datetime64[D]')
        slot = int((np.datetime64(int(t), 'ms') - d.astype('datetime64[ms]')) / np.timedelta64(4, 'h'))
        by.setdefault(iso(d), {})[slot] = float(o)
    out = []
    for d in sorted(by):
        s = by[d]
        if len(s) == FIRINGS and all(v > 0 for v in s.values()):
            out.append({'date': d, 'weekday': int((day(d).astype('int64') + 4) % 7), 'cheapest': int(min(s, key=s.get))})
    return out


def timing_known(days, asof):
    return [d for d in days if d['date'] <= asof]


# --------------------------------------------------------------- e-process

def scaled(diffs):
    """Predictably scaled, clipped paired differences: None during burn-in.
    The scale at t uses only differences before t, so the bet stays
    predictable and the e-process valid."""
    out, hist = [], []
    for d in diffs:
        if len(hist) >= BURN_IN:
            s = max(float(np.std(hist)), 1e-12)
            out.append(max(-1.0, min(1.0, d / (3 * s))))
        else:
            out.append(None)
        hist.append(d)
    return out


def e_value(xs):
    """Mixture betting e-process for H0: E[x_t | past] <= 0. Under H0 it is a
    nonnegative supermartingale, so P(ever >= 1/a) <= a however often read."""
    logs = np.zeros(len(LAMBDAS)); n = 0
    for x in xs:
        if x is None: continue
        logs += np.log1p(LAMBDAS * x); n += 1
    return float(np.mean(np.exp(logs))), n


def alpha_for(index):
    return ALPHA * 6 / (math.pi ** 2 * index ** 2)


# --------------------------------------------------------------- ledger ops

class Ledger:
    def __init__(self, rows):
        self.by, self.dates = {}, {}
        for r in rows: self.add(r)

    def add(self, r):
        key = (r['model_id'], r['symbol'], int(r['horizon']), r['as_of'])
        if key not in self.by: self.dates.setdefault(key[:3], []).append(key[3])
        self.by[key] = r

    def get(self, mid, sym, h, asof): return self.by.get((mid, sym, h, asof))

    def paired(self, challenger, incumbent, sym, h, start):
        """Loss differences (incumbent - challenger, positive = challenger
        better) on dates >= start where both were scored; one per 7 days at
        h = 7 so no two outcomes overlap."""
        dates = sorted(d for d in self.dates.get((challenger, sym, h), []) if d >= start)
        out = []
        for d in dates:
            if h == 7 and ((day(d) - day(start)) // DAY) % 7: continue
            c, i = self.get(challenger, sym, h, d), self.get(incumbent, sym, h, d)
            if c and i and c.get('loss') is not None and i.get('loss') is not None:
                out.append((d, i['loss'] - c['loss']))
        return out


def slot_series(ledger, cid, iid, symbols, h, start, pooled):
    if not pooled:
        pairs = ledger.paired(cid, iid, symbols[0], h, start)
        return [d for _, d in pairs], scaled([d for _, d in pairs])
    per_date = {}
    for s in symbols:
        pairs = ledger.paired(cid, iid, s, h, start)
        for (d, _), x in zip(pairs, scaled([v for _, v in pairs])):
            if x is not None: per_date.setdefault(d, []).append(x)
    xs = [float(np.mean(per_date[d])) for d in sorted(per_date)]
    return xs, xs


# ----------------------------------------------------------------- run

def slot_key(sym, target, h): return f'{sym}|{target}|{h}'


class Tournament:
    def __init__(self, data, registry, ledger_rows, asof, run_at):
        self.data, self.asof, self.run_at = data, asof, run_at
        self.rows = {}
        for r in data['rows']:
            self.rows.setdefault((r['symbol'], r['horizon']), []).append(r)
        for v in self.rows.values(): v.sort(key=lambda r: r['date'])
        self.days = {s: firing_days(k) for s, k in (data.get('klines') or {}).items()}
        self.outcome = {(r['symbol'], r['horizon'], r['date']): r['target'] for r in data['rows'] if r['target'] is not None}
        self.day_outcome = {(s, d['date']): d['cheapest'] for s, ds in self.days.items() for d in ds}
        self._bt = {}
        self.symbols = [s for s in data['symbols'] if (s, 1) in self.rows]
        self.registry = {(r['model_id'], r['symbol'], int(r['horizon'])): dict(r) for r in registry}
        self.ledger = Ledger(ledger_rows)
        self.forecasts, self.scores, self.transitions, self.weights = [], [], [], {}

    # -- registry helpers
    def slot_models(self, sym, target, h, statuses=None):
        return [m for (mid, s, hh), m in self.registry.items()
                if s == sym and hh == h and m['target'] == target and (statuses is None or m['status'] in statuses)]

    def spec(self, m): return json.loads(m['spec_json']) if isinstance(m['spec_json'], str) else m['spec_json']

    def champion(self, sym, target, h):
        c = self.slot_models(sym, target, h, ('champion',))
        return c[0] if c else None

    def incumbent_id(self, sym, target, h):
        own = self.champion(sym, target, h) if sym != POOLED else None
        pooled = self.champion(POOLED, target, h)
        return (own or pooled or {'model_id': BENCHMARKS[target]['id']})['model_id']

    def fallback_id(self, sym, target, h):
        if sym == POOLED: return BENCHMARKS[target]['id']
        pooled = self.champion(POOLED, target, h)
        return (pooled or {'model_id': BENCHMARKS[target]['id']})['model_id']

    def register(self, spec, sym, h, status, reason, backtest=None):
        key = (spec['id'], sym, h)
        if key in self.registry: return self.registry[key]
        used = [m.get('alpha_index') or 0 for m in self.slot_models(sym, spec['target'], h)]
        m = {'model_id': spec['id'], 'symbol': sym, 'target': spec['target'], 'horizon': h,
             'spec_json': json.dumps(spec, sort_keys=True), 'status': status,
             'alpha_index': (max(used) + 1) if status == 'challenger' else None,
             'admitted_at': self.asof, 'epoch_start': add_days(self.asof, 1),
             'incumbent_id': self.incumbent_id(sym, spec['target'], h) if status == 'challenger' else None,
             'status_changed_at': self.run_at, 'e_value': None, 'e_worse': None, 'forward_n': 0,
             'forward_mean_diff': None, 'backtest_json': json.dumps(backtest) if backtest else None,
             'reason': reason, 'updated_at': self.run_at}
        self.registry[key] = m
        self.transitions.append({'model_id': spec['id'], 'symbol': sym, 'horizon': h, 'from_status': None,
                                 'to_status': status, 'at': self.run_at, 'reason': reason, 'e_value': None, 'forward_n': 0})
        return m

    def move(self, m, status, reason):
        self.transitions.append({'model_id': m['model_id'], 'symbol': m['symbol'], 'horizon': m['horizon'],
                                 'from_status': m['status'], 'to_status': status, 'at': self.run_at, 'reason': reason,
                                 'e_value': m.get('e_value'), 'forward_n': m.get('forward_n')})
        m['status'], m['reason'], m['status_changed_at'], m['updated_at'] = status, reason, self.run_at, self.run_at

    def slot_symbols(self, sym, target):
        base = self.symbols if sym == POOLED else [sym]
        return [s for s in base if target != 'timing' or s in self.days]

    # -- 1. score what has matured
    def score(self):
        for key, r in self.ledger.by.items():
            if r.get('loss') is not None: continue
            mid, sym, h, asof = key
            target = r['target']
            outcome = (self.day_outcome.get((sym, r['target_date'])) if target == 'timing'
                       else self.outcome.get((sym, h, asof)))
            if outcome is None: continue
            fc = json.loads(r['forecast_json']) if isinstance(r['forecast_json'], str) else r['forecast_json']
            l = loss(target, fc, outcome)
            if l is None: continue
            r['loss'], r['outcome'] = l, outcome
            self.scores.append({'model_id': mid, 'symbol': sym, 'horizon': h, 'as_of': asof,
                                'outcome_json': json.dumps({'value': outcome}), 'loss': l, 'scored_at': self.run_at})

    # -- 2. lifecycle, pooled slots first so per-asset incumbents are current
    def lifecycle(self):
        for sym in [POOLED] + self.symbols:
            for target, h in SLOTS:
                syms = self.slot_symbols(sym, target)
                if not syms: continue
                pooled = sym == POOLED
                inc = self.incumbent_id(sym, target, h)
                champ = self.champion(sym, target, h)
                if champ:
                    fb = self.fallback_id(sym, target, h)
                    diffs, xs = slot_series(self.ledger, champ['model_id'], fb, syms, h, champ['epoch_start'], pooled)
                    ew, n = e_value([None if x is None else -x for x in xs])
                    champ['e_worse'] = ew
                    if ew >= DEMOTE_E:
                        self.move(champ, 'retired', f'demoted: worse than {fb} (e={ew:.1f}, n={n})')
                        inc = self.incumbent_id(sym, target, h)
                best = None
                for m in self.slot_models(sym, target, h, ('challenger',)):
                    if m['incumbent_id'] != inc:
                        # A new incumbent is a new hypothesis: fresh epoch, fresh alpha.
                        used = [x.get('alpha_index') or 0 for x in self.slot_models(sym, target, h)]
                        m.update(incumbent_id=inc, epoch_start=add_days(self.asof, 1), alpha_index=max(used) + 1,
                                 e_value=None, e_worse=None, forward_n=0, forward_mean_diff=None, updated_at=self.run_at)
                        continue
                    diffs, xs = slot_series(self.ledger, m['model_id'], inc, syms, h, m['epoch_start'], pooled)
                    e, n = e_value(xs); ew, _ = e_value([None if x is None else -x for x in xs])
                    m.update(e_value=e, e_worse=ew, forward_n=len(diffs),
                             forward_mean_diff=float(np.mean(diffs)) if diffs else None, updated_at=self.run_at)
                    if e >= 1 / alpha_for(m['alpha_index']) and len(diffs) >= MIN_FORWARD[h]:
                        if best is None or e > best['e_value']: best = m
                    elif ew >= RETIRE_E:
                        self.move(m, 'retired', f'worse than incumbent {inc} (e={ew:.1f}, n={len(diffs)})')
                    elif len(diffs) >= MAX_FORWARD[h]:
                        self.move(m, 'retired', f'no verdict after {len(diffs)} forward outcomes')
                if best:
                    old = self.champion(sym, target, h)
                    if old: self.move(old, 'retired', f"superseded by {best['model_id']}")
                    self.move(best, 'champion', f"beat {inc} forward: e={best['e_value']:.1f} >= "
                                                f"{1 / alpha_for(best['alpha_index']):.0f}, n={best['forward_n']}")
                    best['epoch_start'] = add_days(self.asof, 1)

    # -- 3. propose new challengers, ranked on history (forward decides)
    def screen(self, spec, sym, target, h):
        syms = self.slot_symbols(sym, target)
        inc_spec = self.spec_for(self.incumbent_id(sym, target, h), target)
        diffs_all = []
        for s in syms:
            a, b = self.backtest(spec, s, target, h), self.backtest(inc_spec, s, target, h)
            diffs_all.append([b[d] - a[d] for d in sorted(a) if d in b])
        flat = [d for ds in diffs_all for d in ds]
        if not flat: return None
        sc = [x for ds in diffs_all for x in scaled(ds) if x is not None]
        return {'n': len(flat), 'meanDiff': float(np.mean(flat)), 'meanScaled': float(np.mean(sc)) if sc else 0.0,
                'screenDays': SCREEN_DAYS, 'incumbent': inc_spec['id']}

    def spec_for(self, mid, target):
        for m in self.registry.values():
            if m['model_id'] == mid: return self.spec(m)
        for s in candidate_grid(target) + [BENCHMARKS[target]]:
            if s['id'] == mid: return s
        raise KeyError(mid)

    def backtest(self, spec, sym, target, h, refit=28):
        """{date: loss} walk-forward over the last SCREEN_DAYS: refit every
        28 days on labels matured by the block's first decision date, then
        forecast the block. Cached per (spec, symbol, horizon), so the pooled
        slot and every per-asset slot share one fit."""
        key = (spec['id'], sym, h)
        if key in self._bt: return self._bt[key]
        start = add_days(self.asof, -SCREEN_DAYS)
        out = {}
        if target == 'timing':
            days = self.days.get(sym, [])
            for t in days:
                if t['date'] < start: continue
                known = [d for d in days if d['date'] <= add_days(t['date'], -2)]
                if len(known) < 30: continue
                out[t['date']] = loss('timing', fit_predict(spec, known, [t], h)[0][0], t['cheapest'])
        else:
            rows = [r for r in self.rows.get((sym, h), []) if r['target'] is not None]
            test = [r for r in rows if r['date'] >= start]
            if h == 7: test = test[::7]
            step = refit if h == 1 else 4
            for k in range(0, len(test), step):
                block = test[k:k + step]
                train = matured(rows, block[0]['date'])
                if len(train) < 150: continue
                fc, _ = fit_predict(spec, train, block, h)
                for r, f in zip(block, fc):
                    l = loss(target, f, r['target'])
                    if l is not None: out[r['date']] = l
        self._bt[key] = out
        return out

    def generate(self, force=False):
        for sym in [POOLED] + self.symbols:
            for target, h in SLOTS:
                if not self.slot_symbols(sym, target): continue
                live = self.slot_models(sym, target, h, ('challenger',))
                room = LIVE_CHALLENGERS - len(live)
                if room <= 0: continue
                ever = self.slot_models(sym, target, h)
                seeding = not any(m['status'] != 'benchmark' for m in ever)
                if not (force or seeding): continue
                tried = {m['model_id'] for m in ever}
                inc = self.incumbent_id(sym, target, h)
                ranked = []
                for spec in candidate_grid(target):
                    if spec['id'] in tried or spec['id'] == inc: continue
                    res = self.screen(spec, sym, target, h)
                    if res and res['meanScaled'] > 0: ranked.append((res['meanScaled'], spec, res))
                ranked.sort(key=lambda t: -t[0])
                for _, spec, res in ranked[:min(room, room if seeding else ADMIT_PER_RUN)]:
                    self.register(spec, sym, h, 'challenger', f"admitted: history ranked it {res['meanScaled']:+.3f} vs {inc}", res)

    # -- 4. issue today's forecasts for every active model
    def active(self, sym, target, h):
        ids = {BENCHMARKS[target]['id']}
        for s in (sym, POOLED):
            for m in self.slot_models(s, target, h, ('champion', 'challenger')): ids.add(m['model_id'])
        return [self.spec_for(i, target) for i in sorted(ids)]

    def issue(self):
        for sym in self.symbols:
            for target, h in SLOTS:
                if target == 'timing':
                    days = self.days.get(sym)
                    if not days: continue
                    known = timing_known(days, self.asof)
                    if len(known) < 30 or known[-1]['date'] < add_days(self.asof, -1): continue
                    tdate = add_days(self.asof, h)
                    test = [{'date': tdate, 'weekday': int((day(tdate).astype('int64') + 4) % 7)}]
                    for spec in self.active(sym, target, h):
                        fc = fit_predict(spec, known, test, h)[0][0]
                        self.emit(spec, sym, target, h, tdate, fc, as_of=self.asof)
                    continue
                rows = self.rows.get((sym, h), [])
                # Each asset forecasts from its own newest close. A CoinGecko-only
                # asset is a midnight sample, one day behind by construction;
                # anything older than that is stale and never forecast from.
                open_rows = [r for r in rows if r['target'] is None]
                if not open_rows: continue
                latest = max(r['date'] for r in open_rows)
                if latest < add_days(self.asof, -1): continue
                open_rows = [r for r in open_rows if r['date'] == latest]
                train = matured(rows, latest)
                if len(train) < 150: continue
                for spec in self.active(sym, target, h):
                    fc, w = fit_predict(spec, train, open_rows, h)
                    self.emit(spec, sym, target, h, open_rows[0]['targetDate'], fc[0], as_of=latest)

    def emit(self, spec, sym, target, h, tdate, fc, as_of=None):
        as_of = as_of or self.asof
        key = (spec['id'], sym, h, as_of)
        if self.ledger.get(*key): return  # issued earlier: the first forecast stands
        row = {'model_id': spec['id'], 'symbol': sym, 'target': target, 'horizon': h, 'as_of': as_of,
               'target_date': tdate, 'forecast_json': json.dumps(fc), 'issued_at': self.run_at,
               'code_version': VERSION, 'input_hash': self.data.get('inputHash')}
        self.forecasts.append(row)
        self.ledger.add(dict(row, loss=None))

    # -- 5. how each asset's fitted models weigh each kind of information
    def weights_report(self, refits=13):
        groups_of = {}
        for g, names in GROUPS.items():
            for n in names: groups_of[n] = g
        def group(col):
            base = col.split(':')[0]
            if base.startswith('leader_'): return 'leaders'
            if base in ('weekday', 'month'): return 'calendar'
            if base == 'har': return 'har'
            return groups_of.get(base, 'other')
        probes = {('direction', 1): make('direction', 'logistic', C=0.3, groups=ALL_GROUPS),
                  ('magnitude', 1): make('magnitude', 'harx', groups=[g for g in ALL_GROUPS if g != 'leaders'])}
        for sym in self.symbols:
            for (target, h), spec in probes.items():
                rows = [r for r in self.rows.get((sym, h), []) if r['target'] is not None]
                fits = []
                for k in range(refits):
                    cut = add_days(self.asof, -28 * k)
                    train = matured(rows, cut)
                    if len(train) < 150: break
                    _, w = fit_predict(spec, train, train[-1:], h)
                    if w: fits.append({c: v for c, v in w.items() if not c.endswith(':missing')})
                if not fits: continue
                latest = fits[0]
                total = sum(abs(v) for v in latest.values()) or 1.0
                share = {}
                for c, v in latest.items(): share[group(c)] = share.get(group(c), 0) + abs(v) / total
                top = sorted(latest, key=lambda c: -abs(latest[c]))[:6]
                stab = lambda c: float(np.mean([np.sign(f.get(c, 0)) == np.sign(latest[c]) for f in fits]))
                self.weights.setdefault(sym, {})[f'{target}:{h}'] = {
                    'probe': spec['id'], 'refits': len(fits),
                    'groupShare': {g: round(v, 4) for g, v in sorted(share.items(), key=lambda t: -t[1])},
                    'top': [{'feature': c, 'weight': round(latest[c], 4), 'signStability': round(stab(c), 2)} for c in top]}

    # -- 6. the compact summary build-signals reads
    def summary(self):
        assets = {}
        for sym in [POOLED] + self.symbols:
            for target, h in SLOTS:
                if not self.slot_symbols(sym, target): continue
                inc = self.incumbent_id(sym, target, h)
                champ = self.champion(sym, target, h)
                ch = sorted(self.slot_models(sym, target, h, ('challenger',)), key=lambda m: -(m.get('e_value') or 0))
                latest = None
                if sym != POOLED:
                    dates = [d for d in self.ledger.dates.get((inc, sym, h), [])]
                    latest = self.ledger.get(inc, sym, h, max(dates)) if dates else None
                assets.setdefault(sym, {})[f'{target}:{h}'] = {
                    'incumbent': inc, 'incumbentLabel': describe(self.spec_for(inc, target)),
                    'promoted': bool(champ) or (sym != POOLED and bool(self.champion(POOLED, target, h))),
                    'championSince': champ['status_changed_at'] if champ else None,
                    'forecast': json.loads(latest['forecast_json']) if latest else None,
                    'challengers': [{'model': m['model_id'], 'label': describe(self.spec(m)), 'eValue': round(m['e_value'], 3) if m.get('e_value') else None,
                                     'threshold': round(1 / alpha_for(m['alpha_index'])), 'forwardN': m.get('forward_n') or 0,
                                     'meanDiff': m.get('forward_mean_diff')} for m in ch]}
        return {'version': VERSION, 'asOf': self.asof, 'generatedAt': self.run_at, 'assets': assets,
                'weights': self.weights, 'transitions': self.transitions[-50:],
                'counts': {'forecasts': len(self.forecasts), 'scored': len(self.scores),
                           'champions': sum(1 for m in self.registry.values() if m['status'] == 'champion'),
                           'challengers': sum(1 for m in self.registry.values() if m['status'] == 'challenger')},
                'rules': {'alpha': ALPHA, 'demoteE': DEMOTE_E, 'retireE': RETIRE_E, 'minForward': MIN_FORWARD,
                          'liveChallengers': LIVE_CHALLENGERS}}


def run(data, registry, ledger_rows, generate=False, run_at=None, weights=True):
    # Forecasts are "as of the close of" the newest complete daily bar.
    asof = max(r['date'] for r in data['rows'] if r['target'] is None and r['horizon'] == 1)
    t = Tournament(data, registry, ledger_rows, asof, run_at or time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
    for target, h in SLOTS:
        for sym in [POOLED] + t.symbols:
            if t.slot_symbols(sym, target): t.register(BENCHMARKS[target], sym, h, 'benchmark', 'production method')
    t.score()
    t.lifecycle()
    t.generate(force=generate)
    t.issue()
    if weights: t.weights_report()
    return {'version': VERSION, 'asOf': asof, 'runAt': t.run_at, 'forecasts': t.forecasts, 'scores': t.scores,
            'registry': list(t.registry.values()), 'transitions': t.transitions, 'summary': t.summary()}


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True, help='rows + klines (model-tournament-data.mjs)')
    ap.add_argument('--state', required=True, help='registry + ledger exported from D1')
    ap.add_argument('--output', required=True)
    ap.add_argument('--generate', action='store_true', help='propose new challengers (weekly)')
    a = ap.parse_args()
    raw = Path(a.input).read_bytes(); data = json.loads(raw); data['inputHash'] = hashlib.sha256(raw).hexdigest()
    state = json.loads(Path(a.state).read_text())
    t0 = time.time()
    out = run(data, state.get('registry', []), state.get('ledger', []), generate=a.generate)
    out['inputHash'] = data['inputHash']; out['codeHash'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    Path(a.output).write_text(json.dumps(out, allow_nan=False))
    c = out['summary']['counts']
    print(f"{VERSION} as of {out['asOf']}: {c['forecasts']} forecasts, {c['scored']} scored, "
          f"{c['champions']} champions, {c['challengers']} challengers, {len(out['transitions'])} transitions "
          f"in {time.time() - t0:.0f}s", flush=True)
