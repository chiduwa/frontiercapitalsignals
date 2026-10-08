import importlib.util
from pathlib import Path
import unittest
import numpy as np
import pandas as pd

spec = importlib.util.spec_from_file_location('scenarios', Path(__file__).parent / 'scripts/scenario-research.py')
s = importlib.util.module_from_spec(spec); spec.loader.exec_module(s)


def bars(n=300):
    rng = np.random.default_rng(10)
    px = 100 * np.exp(np.cumsum(rng.normal(0, .001, n)))
    return pd.DataFrame({'open': px, 'high': px * 1.003, 'low': px * .997,
                         'close': px * 1.0001, 'quote_volume': np.full(n, 1000.),
                         'taker_buy_quote_volume': np.full(n, 550.)},
                        index=pd.date_range('2026-01-01', periods=n, freq='15min', tz='UTC'))


def funding(b):
    ix = b.index[::32]
    return pd.DataFrame({'calc_time': ix.as_unit('ms').asi8, 'funding_interval_hours': 8,
                         'last_funding_rate': np.full(len(ix), .001)})


class CausalScenarios(unittest.TestCase):
    def test_future_bars_cannot_change_features_or_conditions(self):
        b = bars(); cut = 220
        full = s.features(b); short = s.features(b.iloc[:cut])
        pd.testing.assert_frame_equal(full.iloc[:cut], short)
        a, c = s.rules(full), s.rules(short)
        for name in a: pd.testing.assert_series_equal(a[name].iloc[:cut], c[name])

    def test_no_signal_before_closed_confirmation_and_next_open_entry(self):
        b = bars(); side = pd.Series(0, index=b.index); side.iloc[100] = -1
        e = s.event_rows(b, side, 4, funding(b))
        self.assertEqual(e.iloc[0].entryTime, b.index[101])
        self.assertEqual(e.iloc[0].signalTime, b.index[101])
        self.assertEqual(e.iloc[0].exitTime, b.index[105])
        self.assertAlmostEqual(e.iloc[0].gross, -(b.open.iloc[105] / b.open.iloc[101] - 1) * 100)

    def test_missing_bar_cannot_be_bridged_into_a_trade(self):
        b = bars(); side = pd.Series(0, index=b.index); side.iloc[100] = 1
        b.iloc[103] = np.nan
        self.assertTrue(s.event_rows(b, side, 4, funding(b)).empty)

    def test_funding_sign_and_vectorized_cashflow_match_scalar(self):
        b = bars(); rate = funding(b)
        p = s.forward_paths(b, 40, rate)
        for entry in [20, 30, 31, 32, 33]:
            for side in [-1, 1]:
                expected = s.funding_cost(rate, b.index[entry], b.index[entry+40], b.open.iloc[entry], b, side)
                self.assertAlmostEqual(side * p.cashLong.iloc[entry], expected)
        self.assertGreater(p.cashLong.iloc[30], 0, 'positive funding costs longs, pays shorts')

    def test_overlapping_and_unfunded_windows_are_not_counted(self):
        b = bars(); side = pd.Series(1, index=b.index)
        e = s.event_rows(b, side, 16, funding(b))
        self.assertTrue((e.entryTime.iloc[1:].reset_index(drop=True) >= e.exitTime.iloc[:-1].reset_index(drop=True)).all())
        self.assertTrue(s.event_rows(b, side, 16, pd.DataFrame()).empty)

    def test_new_york_open_moves_with_dst_and_skips_holidays(self):
        ix = pd.date_range('2026-03-06', '2026-03-10', freq='15min', tz='UTC')
        hits = ix[s.session_mask(ix, 'XNYS', 'open')] + s.STEP
        self.assertEqual(list(hits.strftime('%Y-%m-%d %H:%M')), ['2026-03-06 14:30', '2026-03-09 13:30'])
        ix = pd.date_range('2026-12-24', '2026-12-26', freq='15min', tz='UTC')
        hits = ix[s.session_mask(ix, 'XNYS', 'close')] + s.STEP
        self.assertEqual(list(hits.strftime('%Y-%m-%d %H:%M')), ['2026-12-24 18:00'])

    def test_oi_is_unavailable_until_reporting_delay_passes(self):
        b = bars()
        m = pd.DataFrame({'create_time': ['2026-01-02T00:00:00Z', '2026-01-02T01:00:00Z'],
                          'sum_open_interest': [100., 110.]})
        f = s.features(b, m)
        self.assertTrue(np.isnan(f.loc['2026-01-02T00:45:00Z', 'oiChange1h']))
        self.assertAlmostEqual(f.loc['2026-01-02T01:00:00Z', 'oiChange1h'], 10.)


if __name__ == '__main__': unittest.main()
