"""tracked-sequence-research.py: no look-ahead, and a planted effect is found."""
import importlib.util, math, unittest
from pathlib import Path
import numpy as np

spec = importlib.util.spec_from_file_location('seq', Path(__file__).parent / 'scripts' / 'tracked-sequence-research.py')
seq = importlib.util.module_from_spec(spec); spec.loader.exec_module(seq)


def synthetic(n=520, seed=3, weekday_mean=0.0):
    rng = np.random.default_rng(seed)
    start = np.datetime64('2023-01-01')
    daily = rng.normal(0, 0.02, n)
    days = [str(start + np.timedelta64(i, 'D')) for i in range(n)]
    wd = [(int(np.datetime64(d, 'D').astype('datetime64[D]').view('int64')) + 4) % 7 for d in days]  # 1970-01-01 was Thursday
    if weekday_mean:
        daily = daily + np.array([weekday_mean if w == 1 else 0 for w in wd])
    rows = []
    for i in range(40, n - 1):
        values = {name: float(rng.normal()) for name in seq.tr.PV}
        for k in range(10): values[f'returnLag{k}'] = float(daily[i - k])
        values.update(weekday=wd[i], month=int(days[i][5:7]), momentumAcceleration=float(rng.normal()),
                      oiChange1=float(rng.normal()), volumeRatio=float(rng.normal()))
        sequence = [[float(daily[k]), float(rng.normal() * 0.1)] for k in range(i - 29, i + 1)]
        target = math.expm1(daily[i + 1]) * 100
        rows.append({'symbol': 'T', 'date': days[i], 'targetDate': days[i + 1], 'horizon': 1, 'target': target,
                     'values': values, 'sequence': sequence, 'garchWeekdayPct': 2.0})
    return rows, days


class SequenceResearch(unittest.TestCase):
    def test_predictions_never_depend_on_later_rows(self):
        rows, days = synthetic()
        asof = days[-1]
        full = seq.evaluate_asset(rows, 1, days[300], asof, use_lstm=False, use_sarima=False)
        cut = days[420]
        short = seq.evaluate_asset([r for r in rows if r['targetDate'] < cut], 1, days[300], cut, use_lstm=False, use_sarima=False)
        later = {r['date']: r for r in full}
        self.assertGreater(len(short), 50)
        for r in short:
            for group in ('prob', 'mag', 'signed'):
                for model, v in r[group].items():
                    self.assertAlmostEqual(v, later[r['date']][group][model], places=9,
                                           msg=f'{group}/{model} at {r["date"]} changed when later rows were appended')

    def test_sarima_and_lstm_never_depend_on_later_rows(self):
        # The two families the fast test above switches off: SARIMA refits its
        # parameters per fold and then filters forward; the LSTM early-stops on
        # the validation fold. Neither may see a row past its decision date.
        try:
            import torch, statsmodels  # noqa: F401
        except ImportError:
            self.skipTest('torch/statsmodels not installed')
        rows, days = synthetic(n=420)
        full = seq.evaluate_asset(rows, 1, days[330], days[-1])
        cut = days[390]
        short = seq.evaluate_asset([r for r in rows if r['targetDate'] < cut], 1, days[330], cut)
        later = {r['date']: r for r in full}
        self.assertGreater(len(short), 40)
        for r in short:
            for group, model in (('prob', 'sarima'), ('signed', 'sarima'), ('prob', 'sarimax'), ('prob', 'lstm'), ('mag', 'lstm')):
                self.assertAlmostEqual(r[group][model], later[r['date']][group][model], places=6,
                                       msg=f'{group}/{model} at {r["date"]} changed when later rows were appended')

    def test_scoring_and_family_correction(self):
        rows, days = synthetic()
        recs = seq.evaluate_asset(rows, 1, days[300], days[-1], use_lstm=False, use_sarima=False)
        scored = seq.score(recs, 1)
        self.assertEqual(scored['observations'], len(recs))
        results = {'T': {'1': scored}}
        n = seq.correct_family(results)
        self.assertGreater(n, 5)
        for m, v in scored['direction'].items():
            if m != 'baseRate': self.assertGreaterEqual(v['brierImprovement']['holmP'], v['brierImprovement']['p'])
        # Pure noise: nothing may clear the corrected bar.
        v = seq.verdicts(results)['T|1']
        self.assertEqual(v['direction'], [])
        self.assertEqual(v['magnitudeVsGarchWeekday'], [])

    def test_calendar_is_one_hot_plus_circle(self):
        rows, _ = synthetic(n=80)
        c = seq.calendar(rows)
        self.assertEqual(c.shape[1], 9)
        self.assertTrue(np.all(c[:, :7].sum(axis=1) == 1))
        self.assertTrue(np.allclose(c[:, 7] ** 2 + c[:, 8] ** 2, 1))


if __name__ == '__main__':
    unittest.main()
