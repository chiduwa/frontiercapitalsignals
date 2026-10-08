"""Regression evidence for immutable readouts and inexpensive repeat runs."""
import importlib.util
import json
import unittest
import numpy as np
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('suite', Path(__file__).with_name('test-model-tournament.py'))
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)
mt = suite.mt


class LearningIntegrity(unittest.TestCase):
    def test_asymmetric_no_skill_cannot_exploit_clipping_to_promote(self):
        rng = np.random.default_rng(71008)
        crossings = 0
        for _ in range(200):
            # A negative mean within the Brier difference's [-1, 1] range.
            differences = np.where(rng.random(540) < .98, .01, -.51)
            rows = []
            for k, d in enumerate(differences):
                date = mt.add_days('2024-01-01', k)
                rows += [dict(model_id=mid, symbol='A', horizon=1, as_of=date, loss=loss)
                         for mid, loss in [('direction:c', .2), ('direction:i', .2 + d)]]
            # Keep losses nonnegative while preserving the same differences.
            for row in rows: row['loss'] += .6
            _, xs = mt.slot_series(mt.Ledger(rows), 'direction:c', 'direction:i', ['A'], 1, '2024-01-01', False)
            logs = np.zeros(len(mt.LAMBDAS))
            for n, x in enumerate(xs):
                if x is None: continue
                logs += np.log1p(mt.LAMBDAS * x)
                if n + 1 >= 60 and np.mean(np.exp(logs)) >= 1 / mt.alpha_for(1):
                    crossings += 1
                    break
        self.assertLessEqual(crossings, 12, f'{crossings}/200 false promotions under an asymmetric null')

    def test_unbounded_magnitude_loss_cannot_claim_a_bounded_mean_guarantee(self):
        rows = []
        for k in range(100):
            for mid, value in [('magnitude:c', -5.), ('magnitude:i', -4.)]:
                rows.append(dict(model_id=mid, symbol='A', horizon=1, as_of=mt.add_days('2024-01-01', k), loss=value))
        diffs, xs = mt.slot_series(mt.Ledger(rows), 'magnitude:c', 'magnitude:i', ['A'], 1, '2024-01-01', False)
        self.assertEqual(len(diffs), 100, 'the raw learning record still accumulates')
        self.assertEqual(mt.e_value(xs)[0], 1., 'QLIKE lacks a finite distribution-free difference bound')

    def test_corrupt_pooled_evidence_invalidates_the_whole_comparison(self):
        rows = []
        for symbol, date, loss in [('A', '2026-01-01', .1), ('A', '2026-01-02', .1), ('B', '2026-01-02', 4.)]:
            for mid, value in [('direction:c', .2), ('direction:i', loss)]:
                rows.append(dict(model_id=mid, symbol=symbol, horizon=1, as_of=date, loss=value))
        raw, xs = mt.slot_series(mt.Ledger(rows), 'direction:c', 'direction:i', ['A','B'], 1, '2026-01-01', True)
        self.assertEqual(len(raw), 2)
        self.assertEqual(xs, [None, None], 'do not select apparently valid dates after detecting corrupt evidence')

    def tournament(self, ledger):
        # The current archive now disagrees with the outcome originally scored.
        data = {'symbols': ['A'], 'rows': [{'symbol': 'A', 'horizon': 1,
                'date': '2026-09-01', 'targetDate': '2026-09-02', 'target': -4.0,
                'values': {}}]}
        return mt.Tournament(data, [], ledger, '2026-09-03', '2026-09-04T00:00:00Z')

    def forecast(self, **over):
        return dict(model_id='model', symbol='A', horizon=1, target='direction',
                    as_of='2026-09-01', target_date='2026-09-02',
                    forecast_json='{"pUp":0.9}', **over)

    def test_accuracy_uses_frozen_outcome_despite_archive_revision(self):
        t = self.tournament([self.forecast(loss=0.01, outcome_json='{"value":3.0}')])
        self.assertEqual(t.calls('model', 'A', 1, '2026-09-01')['precision'], 1.0)

    def test_unscored_or_missing_frozen_outcome_is_not_evidence(self):
        for row in [self.forecast(loss=None), self.forecast(loss=0.01),
                    self.forecast(loss=0.01, outcome_json='invalid')]:
            with self.subTest(row=row):
                self.assertIsNone(self.tournament([row]).calls('model', 'A', 1, '2026-09-01'))

    def test_scored_record_does_not_require_archive_row_to_survive(self):
        t = self.tournament([self.forecast(loss=0.01, outcome_json='{"value":3.0}')])
        t.outcome.clear()
        self.assertEqual(t.calls('model', 'A', 1, '2026-09-01')['n'], 1)

    def test_wrong_json_shapes_and_nonfinite_probabilities_abstain(self):
        for fc in ['[]', 'null', '{"pUp":true}', '{"pUp":2}', '{"pUp":NaN}']:
            row = self.forecast(loss=.01, outcome_json='{"value":3.0}')
            row['forecast_json'] = fc
            self.assertIsNone(self.tournament([row]).calls('model', 'A', 1, '2026-09-01'))

    def test_repeat_issue_does_not_fit_already_saved_forecasts(self):
        rows = suite.synthetic_rows(n=200)
        asof = rows[-1]['date']
        for r in rows:
            if r['targetDate'] > asof:
                r['target'] = None
        t = mt.Tournament({'symbols': ['A'], 'rows': rows}, [], [], asof, '2026-01-01T00:00:00Z')
        t.issue()
        self.assertEqual(len(t.forecasts), 4)
        with patch.object(mt, 'fit_predict', side_effect=AssertionError('redundant fit')):
            t.issue()
        self.assertEqual(len(t.forecasts), 4)


if __name__ == '__main__':
    unittest.main()
