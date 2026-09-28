"""classic-models-research.py: the smoothing filter is statsmodels' own, no
forecast sees a later row, and the interval study's quantiles are calibrated."""
import importlib.util, math, unittest, warnings
from pathlib import Path
import numpy as np

spec = importlib.util.spec_from_file_location('cm', Path(__file__).parent / 'scripts' / 'classic-models-research.py')
cm = importlib.util.module_from_spec(spec); spec.loader.exec_module(cm)


def synthetic(n=520, seed=3, symbol='T'):
    rng = np.random.default_rng(seed)
    start = np.datetime64('2023-01-01')
    vol = 0.02 * (1 + 0.5 * np.sin(np.arange(n) / 40))
    daily = rng.normal(0, 1, n) * vol
    days = [str(start + np.timedelta64(i, 'D')) for i in range(n)]
    rows = []
    for i in range(40, n - 1):
        values = {name: float(rng.normal()) for name in cm.tr.PV}
        for k in range(10): values[f'returnLag{k}'] = float(daily[i - k])
        values.update(weekday=i % 7, month=int(days[i][5:7]), momentumAcceleration=float(rng.normal()), ewmaVol=float(vol[i]))
        rows.append({'symbol': symbol, 'date': days[i], 'targetDate': days[i + 1], 'horizon': 1,
                     'target': math.expm1(daily[i + 1]) * 100, 'values': values, 'garchWeekdayPct': float(vol[i] * 100)})
    return rows, days


class Smoothing(unittest.TestCase):
    def test_the_filter_reproduces_statsmodels_for_every_form(self):
        from statsmodels.tsa.exponential_smoothing.ets import ETSModel
        warnings.filterwarnings('ignore')
        rng = np.random.default_rng(3); m = 7
        season = np.array([1.0, 1.3, 0.9, 1.1, 0.8, 1.2, 0.7])
        y = np.array([season[t % m] * (2 + np.sin(t / 50)) * rng.chisquare(1) for t in range(400)]) + 0.05
        for name, form in {**cm.VAR_FORMS, 'price': cm.PRICE_FORMS['holtWintersPrice']}.items():
            fit = cm.fit_ets(y, form, m)
            self.assertIsNotNone(fit, name)
            yhat, L, B, S = cm.ets_states(y, form, m, fit)
            error, trend, damped, seasonal = form
            kw = dict(error=error, trend=trend, damped_trend=damped, seasonal=seasonal, initialization_method='heuristic')
            if seasonal: kw['seasonal_periods'] = m
            res = ETSModel(y, **kw).fit(disp=False, maxiter=400)
            self.assertLess(float(np.max(np.abs(yhat - np.asarray(res.fittedvalues)))), 1e-8, name)
            mine = [cm.hw_forecast(L, B, S, len(y) - 1, k, trend, seasonal, m, fit['phi']) for k in range(1, m + 1)]
            self.assertLess(float(np.max(np.abs(np.asarray(res.forecast(m)) - mine))), 1e-8, name)


class NoLookAhead(unittest.TestCase):
    def test_predictions_never_depend_on_later_rows(self):
        rows, days = synthetic()
        full = cm.evaluate_asset(rows, 1, days[300], days[-1], light=True)
        cut = days[420]
        short = cm.evaluate_asset([r for r in rows if r['targetDate'] < cut], 1, days[300], cut, light=True)
        later = {r['date']: r for r in full}
        self.assertGreater(len(short), 50)
        for r in short:
            other = later[r['date']]
            for kind in ('prob', 'mag', 'var', 'signed'):
                for model, v in r[kind].items():
                    self.assertAlmostEqual(v, other[kind][model], places=9, msg=f'{kind} {model} {r["date"]}')

    def test_the_class_model_never_sees_later_rows(self):
        by = {s: synthetic(seed=k, symbol=s)[0] for k, s in enumerate(('A', 'B', 'C'))}
        days = synthetic()[1]
        full = cm.global_direction(by, 1, days[300], days[-1], light=True)
        cut = days[420]
        short = cm.global_direction({s: [r for r in rs if r['targetDate'] < cut] for s, rs in by.items()}, 1, days[300], cut, light=True)
        later = {(r['symbol'], r['date']): r for r in full}
        self.assertGreater(len(short), 50)
        for r in short:
            for model, v in r['prob'].items():
                self.assertAlmostEqual(v, later[(r['symbol'], r['date'])]['prob'][model], places=9, msg=model)


class Intervals(unittest.TestCase):
    def test_quantile_ranges_contain_what_they_claim(self):
        by = {}
        for k, s in enumerate(('A', 'B', 'C', 'D')):
            rows, _ = synthetic(n=900, seed=10 + k, symbol=s)
            dates, dret, _ = cm.daily_series(rows)
            by[s] = (rows, rows, dates, dret)
        days = synthetic(n=900)[1]
        res = cm.interval_study(by, 1, days[500], days[-1])['byMethod']
        for level in (68, 95):
            for method in ('garch|quantClass', 'garch|gaussVarClass'):
                cov = res[f'{method}|{level}']['coverage']
                self.assertAlmostEqual(cov, level / 100, delta=0.06, msg=f'{method} {level}: {cov}')


if __name__ == '__main__':
    unittest.main()
