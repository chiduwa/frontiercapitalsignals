import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile
import numpy as np
import pandas as pd

spec = importlib.util.spec_from_file_location('cycles', Path(__file__).parent / 'scripts/cycle-research.py')
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
vspec = importlib.util.spec_from_file_location('volatility', Path(__file__).parent / 'scripts/cycle-volatility.py')
v = importlib.util.module_from_spec(vspec); vspec.loader.exec_module(v)


def price(n=1100):
    rng = np.random.default_rng(62)
    return pd.Series(100 * np.exp(np.cumsum(rng.normal(.0001, .02, n))),
                     index=pd.date_range('2013-01-01', periods=n))


class LongHistoryIntegrity(unittest.TestCase):
    def test_cycle_features_do_not_know_next_halving_date(self):
        index = pd.date_range('2014-01-01', '2015-12-31')
        before = c.cycle_features(index)
        with patch.object(c, 'HALVINGS', pd.DatetimeIndex(['2009-01-03', '2012-11-28', '2017-03-01', '2021-12-01'])):
            pd.testing.assert_frame_equal(before, c.cycle_features(index))
        self.assertEqual(c.cycle_features(pd.DatetimeIndex(['2024-04-19'])).iloc[0].cycleId, 2020)
        self.assertEqual(c.cycle_features(pd.DatetimeIndex(['2024-04-20'])).iloc[0].cycleAge, 0)
        early = c.cycle_features(pd.DatetimeIndex(['2005-01-01'])).iloc[0]
        self.assertEqual(early.cycleId, 0)
        self.assertTrue(pd.isna(early.cycleSin), 'do not invent Bitcoin cycles before genesis')

    def test_future_prices_cannot_change_features_or_imputation_inputs(self):
        p = price(); refs = {'BITSTAMP_BTC': p * 2, 'SPY': p}
        original, _, _ = c.feature_frame(p, refs)
        changed = p.copy(); changed.iloc[850:] *= 8
        modified, _, _ = c.feature_frame(changed, {'BITSTAMP_BTC': changed * 2, 'SPY': changed})
        pd.testing.assert_frame_equal(original.iloc[:850], modified.iloc[:850])

    def test_reference_markets_have_full_day_reporting_lag(self):
        p = price(); altered = p.copy(); altered.iloc[800] *= 2
        a, _, _ = c.feature_frame(p, {'SPY': p})
        b, _, _ = c.feature_frame(p, {'SPY': altered})
        self.assertEqual(a.market_SPY.iloc[800], b.market_SPY.iloc[800])
        self.assertNotEqual(a.market_SPY.iloc[801], b.market_SPY.iloc[801])

    def test_targets_enter_after_feature_and_reject_missing_path(self):
        p = price(); y, ret, end = c.targets(p, 7)
        self.assertAlmostEqual(ret.iloc[500], p.iloc[508]/p.iloc[501]-1)
        self.assertEqual(end.iloc[500], p.index[508])
        p.iloc[505] = np.nan
        self.assertTrue(pd.isna(c.targets(p, 7)[0].iloc[500]))

    def test_quarterly_fit_purges_unmatured_outcomes(self):
        p = price()
        pred = c.walk_forward(p, {}, 30, min_train=100)
        self.assertGreater(len(pred), 100)
        self.assertTrue((pred.latestTrainOutcome < pred.fitBefore).all())
        changed = p.copy(); cutoff = pd.Timestamp('2015-07-01')
        changed[changed.index >= cutoff] *= 4
        second = c.walk_forward(changed, {}, 30, min_train=100)
        # Even overlapping labels near the future shock cannot affect earlier
        # probabilities; only their retrospective y/return may change.
        common = pred.index.intersection(second.index)
        common = common[common < cutoff]
        pd.testing.assert_frame_equal(pred.loc[common, list(c.MODELS)], second.loc[common, list(c.MODELS)])

    def test_old_binance_headerless_candles_keep_first_row(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)/'raw/klines/BTCUSDT'; target.mkdir(parents=True)
            with zipfile.ZipFile(target/'2019-09.zip', 'w') as z:
                z.writestr('old.csv', '1569888000000,10,11,9,10,1,1569888899999,10,3,.5,5,0\n1569888900000,10,12,9,11,2,1569889799999,21,4,1,10,0\n')
            result = c.scenario.data.read_archives(folder, 'klines', 'BTCUSDT')
            self.assertEqual(len(result), 2)
            self.assertEqual(result.open_time.iloc[0], 1569888000000)

    def test_bad_archive_is_never_reported_as_success(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(c.scenario.data.urllib.request, 'urlopen', side_effect=lambda *a, **k: io.BytesIO(b'bad zip')):
                with patch.object(c.scenario.data.time, 'sleep'):
                    result = c.scenario.data.fetch_archive(('klines', 'BTCUSDT', '2019-09', False), Path(folder))
            self.assertEqual(result['status'], 'unavailable')
            self.assertEqual(result['bytes'], 0)

    def test_variance_target_uses_only_post_entry_returns(self):
        p = price(); squared = np.log(p).diff() ** 2
        actual = v.realized_variance(p, 7)
        self.assertAlmostEqual(actual.iloc[500], squared.iloc[502:509].sum())
        p.iloc[505] = np.nan
        self.assertTrue(pd.isna(v.realized_variance(p, 7).iloc[500]))

    def test_variance_fits_are_purged_and_positive(self):
        p = price()
        pred = v.forecasts(p, {}, 30, min_train=100)
        self.assertTrue((pred.latestTrainOutcome < pred.fitBefore).all())
        self.assertTrue(np.isfinite(pred[list(c.MODELS[2:])]).all().all())
        self.assertTrue((pred[list(c.MODELS[2:])] > 0).all().all())
        self.assertAlmostEqual(v.qlike(2., 2.), 0.)


if __name__ == '__main__': unittest.main()
