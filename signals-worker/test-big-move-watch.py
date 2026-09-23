"""big-move-watch.py: features and training never see the future, the live
record is judged against the same day's base rate, and a planted edge is
found."""
import importlib.util, math, unittest
from pathlib import Path
import numpy as np, pandas as pd

spec = importlib.util.spec_from_file_location('bw', Path(__file__).parent / 'scripts' / 'big-move-watch.py')
bw = importlib.util.module_from_spec(spec); spec.loader.exec_module(bw)


def synthetic(coins=40, days=900, seed=4):
    """Coins with persistent volatility levels: the volatile ones make the
    big moves, as in the real archive."""
    rng = np.random.default_rng(seed)
    start = pd.Timestamp('2023-01-01')
    series = {}
    for k in range(coins):
        sym = 'BTC' if k == 0 else f'C{k}'
        vol = 0.01 + 0.07 * (k % 10) / 9
        r = rng.standard_t(4, size=days) * vol / math.sqrt(2)
        c = 10 * np.exp(np.cumsum(r))
        v = rng.lognormal(12, 0.4, size=days)
        series[sym] = [[str((start + pd.Timedelta(days=i)).date()), float(c[i]), float(c[i] * 1.01), float(c[i] * 0.99), float(v[i])]
                       for i in range(days)]
    return series


class NoLookAhead(unittest.TestCase):
    def test_features_at_a_close_ignore_every_later_bar(self):
        rows = synthetic(coins=2)['C1']
        full = bw.coin_features('C1', rows).set_index('date')
        cut = bw.coin_features('C1', rows[:500]).set_index('date')
        common = cut.index[:-bw.HORIZON_DAYS]
        cols = [c for c in bw.FEATS if c in cut.columns]
        pd.testing.assert_frame_equal(full.loc[common, cols], cut.loc[common, cols])

    def test_training_uses_only_labels_matured_by_the_close(self):
        D = bw.panel(synthetic())
        asof = D['date'].max() - pd.Timedelta(days=30)
        top, _ = bw.fit_and_rank(D, asof)
        # Scramble every label that was NOT yet known at the close: same ranking.
        D2 = D.copy()
        future = D2['date'] > asof - pd.Timedelta(days=bw.HORIZON_DAYS)
        D2.loc[future, 'fwd2'] = np.random.default_rng(1).normal(0, 1, future.sum())
        top2, _ = bw.fit_and_rank(D2, asof)
        self.assertEqual(list(top['symbol']), list(top2['symbol']))
        np.testing.assert_allclose(top['p'].values, top2['p'].values)


class Scoring(unittest.TestCase):
    def test_a_watched_row_is_judged_against_the_same_days_share_of_all_coins(self):
        outcome = {('2026-01-01', 'A'): 0.20, ('2026-01-01', 'B'): 0.01}
        base = {'2026-01-01': 0.1}
        s = bw.score([{'as_of': '2026-01-01', 'symbol': 'A'}, {'as_of': '2026-01-01', 'symbol': 'B'},
                      {'as_of': '2026-01-02', 'symbol': 'A'}], outcome, base)
        self.assertEqual([(x['symbol'], x['big']) for x in s], [('A', 1), ('B', 0)])
        self.assertTrue(all(x['day_base_rate'] == 0.1 for x in s))

    def test_the_live_record_counts_days_not_rows(self):
        rows = [{'as_of': f'2026-01-{d:02d}', 'symbol': str(k), 'big': int(k < 3), 'day_base_rate': 0.1}
                for d in range(1, 11) for k in range(10)]
        rec = bw.live_record(rows)
        self.assertEqual(rec['days'], 10); self.assertAlmostEqual(rec['hitRate'], 0.3); self.assertAlmostEqual(rec['excess'], 0.2)

    def test_proven_at_discovery_notifies_until_its_live_record_trails_the_base(self):
        good = [{'as_of': f'2026-{1 + d // 28:02d}-{1 + d % 28:02d}', 'symbol': str(k), 'big': int(k < 3 + d % 2), 'day_base_rate': 0.1}
                for d in range(40) for k in range(10)]
        bad = [dict(r, big=0, day_base_rate=0.1 + (hash(r['as_of']) % 5) / 100) for r in good]
        self.assertTrue(bw.notify_gate(bw.live_record(good[:50]))[0], 'too little live data: discovery evidence stands')
        self.assertTrue(bw.notify_gate(bw.live_record(good))[0])
        allowed, why = bw.notify_gate(bw.live_record(bad))
        self.assertFalse(allowed); self.assertIn('demoted', why)


class Finds(unittest.TestCase):
    def test_a_planted_volatility_edge_is_found_and_beats_the_base(self):
        D = bw.panel(synthetic())
        hits, bases = [], []
        for d in sorted(D['date'].unique())[-120::12]:
            top, _ = bw.fit_and_rank(D, pd.Timestamp(d))
            day = D[(D['date'] == d) & np.isfinite(D['fwd2'])]
            out = day.set_index('symbol')['fwd2']
            hits.append(np.mean([abs(out[s]) >= bw.BIG for s in top['symbol'] if s in out.index]))
            bases.append((day['fwd2'].abs() >= bw.BIG).mean())
        self.assertGreater(np.mean(hits), 2 * np.mean(bases), f'watch {np.mean(hits):.2f} vs base {np.mean(bases):.2f}')

    def test_missing_values_are_reported_as_missing(self):
        self.assertIsNone(bw.num(float('nan'))); self.assertIsNone(bw.num(None)); self.assertEqual(bw.num(0.5, 100), 50.0)


if __name__ == '__main__':
    unittest.main()
