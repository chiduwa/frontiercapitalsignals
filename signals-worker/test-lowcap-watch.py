"""lowcap-watch.py: features never see later bars, outcomes are scored the way
the study scored them, the live record compares the published picks with the
same day's whole low-cap set, and the spike list cannot reach the page before
its gate."""
import importlib.util, json, math, unittest
from pathlib import Path
import numpy as np, pandas as pd

spec = importlib.util.spec_from_file_location('lw', Path(__file__).parent / 'scripts' / 'lowcap-watch.py')
lw = importlib.util.module_from_spec(spec); spec.loader.exec_module(lw)


def bars(days=600, seed=1, start='2024-01-01', drift=0.0, vol=0.05, qv=2e5):
    rng = np.random.default_rng(seed)
    idx = pd.date_range(start, periods=days, freq='D')
    c = 1.0 * np.exp(np.cumsum(drift + vol * rng.standard_normal(days)))
    q = qv * rng.lognormal(0, 0.5, days)
    return pd.DataFrame({'open': c, 'high': c * 1.03, 'low': c * 0.97, 'close': c, 'qv': q,
                         'trades': q / 50, 'tbqv': q * rng.uniform(0.4, 0.6, days)}, index=idx)


class Features(unittest.TestCase):
    def test_features_at_a_close_ignore_every_later_bar(self):
        b = bars()
        as_of = str(b.index[400].date())
        full = lw.coin_features(b, as_of, mcap=5e6)
        cut = lw.coin_features(b.iloc[:401], as_of, mcap=5e6)
        for k in lw.PROD_CONT:
            a, c = full.get(k), cut.get(k)
            self.assertTrue((pd.isna(a) and pd.isna(c)) or math.isclose(a, c, rel_tol=1e-12, abs_tol=1e-12), k)

    def test_prior_spikes_count_only_windows_finished_by_the_close(self):
        b = bars(700, vol=0.0)
        b.loc[b.index[410]:, ['open', 'high', 'low', 'close']] *= 3     # doubles right after as_of
        as_of = str(b.index[400].date())
        full = lw.coin_features(b, as_of, mcap=5e6)['prior_spikes']
        cut = lw.coin_features(b.iloc[:401], as_of, mcap=5e6)['prior_spikes']
        self.assertEqual(full, cut)
        self.assertEqual(full, 0.0)
        later = lw.coin_features(b, str(b.index[600].date()), mcap=5e6)['prior_spikes']
        self.assertGreater(later, 0)                                   # once the window has closed, it counts
        # Exact, as panel.py defined it: day k counts if the close doubled within the
        # 90 days that END at k. A tripling on day 410 counts on days 410..450 at
        # as_of 450 (41 days), divided by 30.
        self.assertAlmostEqual(lw.coin_features(b, str(b.index[450].date()), mcap=5e6)['prior_spikes'], 41 / 30)

    def test_a_redenomination_or_reused_ticker_starts_a_new_series(self):
        b = bars(300)
        b.iloc[150:, :4] *= 1000                                   # a 1000x jump: a different asset from here on
        self.assertEqual(lw.current_segment(b).index[0], b.index[150])
        g = pd.concat([bars(200), bars(200, start='2025-01-01', seed=2)])  # a long gap: relisted
        self.assertEqual(lw.current_segment(g).index[0], pd.Timestamp('2025-01-01'))

    def test_young_series_and_missing_as_of_are_not_ranked(self):
        b = bars(300)
        self.assertIsNone(lw.coin_features(b, '2030-01-01', mcap=1e6))
        self.assertEqual(lw.coin_features(b, str(b.index[100].date()), mcap=1e6)['age'], 100)


class Scoring(unittest.TestCase):
    def row(self, b, i, **kw):
        return {'as_of': str(b.index[i].date()), 'symbol': 'X', 'pair': 'XUSDT', 'close': float(b.close.iloc[i]),
                'qv90': float(b.qv.iloc[i - 89:i + 1].mean()), 'scored30_at': None, 'scored90_at': None, **kw}

    def test_a_double_on_the_close_sells_at_2x(self):
        b = bars(400, vol=0.0)
        b.loc[b.index[240]:, ['open', 'high', 'low', 'close']] *= 2.5
        r = self.row(b, 200)
        o = lw.score_row(r, b, b.index[-1], False)
        self.assertEqual(o['tp100'], 1.0)
        self.assertEqual(o['tp50'], 0.5)
        self.assertAlmostEqual(o['max_close_mult'], 2.5)
        self.assertEqual(o['delisted'], 0)

    def test_a_rise_short_of_2x_holds_to_day_90(self):
        b = bars(400, vol=0.0)
        b.loc[b.index[240]:b.index[250], ['open', 'high', 'low', 'close']] *= 1.7
        o = lw.score_row(self.row(b, 200), b, b.index[-1], False)
        self.assertEqual(o['tp50'], 0.5)
        self.assertAlmostEqual(o['tp100'], o['ret90'])
        self.assertAlmostEqual(o['max_close_mult'], 1.7)

    def test_a_wick_alone_is_not_a_double(self):
        b = bars(400, vol=0.0)
        b.loc[b.index[230], 'high'] *= 3                           # intraday only
        o = lw.score_row(self.row(b, 200), b, b.index[-1], False)
        self.assertLess(o['max_close_mult'], 2)
        self.assertAlmostEqual(o['tp100'], o['ret90'])

    def test_a_delisted_coin_exits_at_its_last_close(self):
        b = bars(400, vol=0.0)
        b = b.iloc[:230]
        b.loc[b.index[-1], 'close'] *= 0.4
        o = lw.score_row(self.row(b, 200), b, pd.Timestamp('2025-12-31'), True)
        self.assertEqual(o['delisted'], 1)
        self.assertAlmostEqual(o['ret90'], -0.6, places=6)
        self.assertTrue(o['score30'])
        self.assertIsNone(o['inflow3x'])                           # no 30 days of trading: no inflow label

    def test_inflow_is_the_next_30_days_against_the_trailing_90(self):
        b = bars(400, vol=0.01, qv=1e5)
        b.loc[b.index[201]:b.index[230], 'qv'] = 1e6
        o = lw.score_row(self.row(b, 200), b, b.index[240], False)
        self.assertEqual(o['inflow3x'], 1)
        self.assertNotIn('score90', o)                              # 90 days have not passed

    def test_a_row_not_yet_due_is_left_alone(self):
        b = bars(400)
        self.assertEqual(lw.score_row(self.row(b, 390), b, b.index[-1], False), {})


def cohort(as_of, n=40, edge=True, rng=None):
    rng = rng or np.random.default_rng(0)
    out = []
    for i in range(n):
        top = i < 10
        out.append({'as_of': as_of, 'symbol': f'C{i}', 'eligible': 1, 'inflow_rank': i + 1, 'spike_rank': i + 1,
                    'inflow3x': float(rng.random() < (0.6 if (edge and top) else 0.1)),
                    'tp100': 1.0 if (edge and top and rng.random() < 0.5) else -0.2, 'max_close_mult': 1.0})
    return out


class Record(unittest.TestCase):
    def test_a_planted_edge_is_found_and_judged_against_the_same_day(self):
        rng = np.random.default_rng(3)
        rows = [r for k in range(120) for r in cohort(str(pd.Timestamp('2027-01-01') + pd.Timedelta(days=k))[:10], rng=rng)]
        rec = lw.live_record(rows)
        self.assertEqual(rec['inflow']['cohorts'], 120)
        self.assertGreater(rec['inflow']['top10'], rec['inflow']['base'])
        self.assertGreater(rec['inflow']['t'], 2)

    def test_coins_on_the_avoid_list_are_never_counted_as_picks(self):
        rows = cohort('2027-01-01')
        for r in rows[:10]:
            r['eligible'] = 0
        rows2 = [dict(r, as_of=f'2027-01-{d:02d}') for d in range(1, 29) for r in rows]
        rec = lw.live_record(rows2)
        self.assertLess(rec['inflow']['top10'], 0.3)               # the planted winners were ineligible

    def test_the_spike_gate_needs_both_time_and_a_t_of_two(self):
        strong = {'spike': {'cohorts': 179, 't': 9.0, 'diff': 0.2}, 'inflow': {}}
        self.assertEqual(lw.gate(strong)[0], 'shadow')
        self.assertEqual(lw.gate({'spike': {'cohorts': 180, 't': 1.9, 'diff': 0.1}, 'inflow': {}})[0], 'shadow')
        self.assertEqual(lw.gate({'spike': {'cohorts': 180, 't': 2.0, 'diff': 0.1}, 'inflow': {}})[0], 'live')
        self.assertEqual(lw.gate({'spike': {}, 'inflow': {'cohorts': 60, 't': -2.1}})[1], 'demoted')
        self.assertEqual(lw.gate({'spike': {}, 'inflow': {'cohorts': 59, 't': -5}})[1], 'live')


def fake_market(n=50, as_of='2025-08-01'):
    pairs, kl, ids, coins = {}, {}, {}, {}
    for i in range(n):
        p = f'C{i}USDT'
        pairs[p] = f'C{i}'
        b = bars(500, seed=i, start='2024-03-20').loc[:'2025-08-02']
        kl[p] = b
        ids[p] = 1000 + i
        coins[1000 + i] = {'name': f'Coin {i}', 'mcap': 1e6 * (i + 1), 'price': float(b.close.iloc[-1]), 'circ': 1e6 * (i + 1) / float(b.close.iloc[-1])}
    tags = {'C0USDT': ['Monitoring'], 'C1USDT': ['fan_token']}
    upbit = {'C2': {'markets': {'KRW'}, 'flag': 'warning'}, 'C3': {'markets': {'BTC'}, 'flag': ''}}
    return {'pairs': pairs, 'tags': tags, 'delist': {'C4': '2025-08-10'}, 'cmc_ids': ids, 'coins': coins, 'upbit': upbit,
            'klines': kl, 'sources': {'binanceTags': True, 'binanceDelistings': True, 'cmc': True, 'upbit': True, 'binanceSpot': 1.0}}


TRAIN = None


def small_models():
    global TRAIN
    if TRAIN is None:
        t = lw.load_training()
        TRAIN = lw.fit_models(t[t.date >= '2025-01-01'])
    return TRAIN


class Ranking(unittest.TestCase):
    def setUp(self):
        self.m = fake_market()
        self.U, self.L, _ = lw.rank_today(self.m, '2025-08-01', small_models(),
                                          circ_lookup=lambda cid, day, fetch: None, perp_lookup=lambda p, a, fetch: True)

    def test_the_low_caps_are_the_bottom_40_percent(self):
        self.assertEqual(len(self.U), 50)
        self.assertEqual(len(self.L), 20)
        self.assertLessEqual(self.L.mcap.max(), 20e6)

    def test_ranks_are_a_permutation(self):
        self.assertEqual(sorted(self.L.inflow_rank), list(range(1, 21)))
        self.assertEqual(sorted(self.L.spike_rank), list(range(1, 21)))

    def test_flagged_coins_are_ineligible_and_explained(self):
        why = dict(zip(self.L.symbol, self.L.avoid))
        self.assertEqual(why['C0'], ['Binance monitoring tag'])
        self.assertEqual(why['C2'], ['Upbit warning'])
        self.assertEqual(why['C4'], ['Binance delisting 2025-08-10'])
        elig = dict(zip(self.L.symbol, self.L.eligible))
        self.assertFalse(elig['C0'] or elig['C1'] or elig['C2'] or elig['C4'])
        self.assertTrue(elig['C3'])

    def summary(self, record):
        return lw.build_summary('2025-08-01', 'now', self.U, self.L, self.m, record, {}, 1.0, {'version': 'test'})

    def test_the_spike_list_is_not_in_the_payload_while_shadow(self):
        s = self.summary({'inflow': {}, 'spike': {'cohorts': 10, 't': 5, 'diff': 0.3}})
        self.assertEqual(s['spike']['status'], 'shadow')
        self.assertNotIn('list', s['spike'])
        self.assertNotIn('spike_rank', json.dumps(lw.clean(s)))
        self.assertEqual(len(s['inflowWatch']['list']), 10)
        self.assertTrue(all(x['symbol'] not in ('C0', 'C1', 'C2', 'C4') for x in s['inflowWatch']['list']))

    def test_the_spike_list_appears_once_the_gate_clears(self):
        s = self.summary({'inflow': {}, 'spike': {'cohorts': 200, 't': 2.5, 'diff': 0.05}})
        self.assertEqual(s['spike']['status'], 'live')
        self.assertEqual(len(s['spike']['list']), 10)

    def test_a_demoted_inflow_watch_publishes_no_list(self):
        s = self.summary({'inflow': {'cohorts': 90, 't': -2.5}, 'spike': {}})
        self.assertEqual(s['inflowWatch'], {'status': 'demoted', 'list': []})

    def test_the_avoid_list_covers_every_live_pair_not_only_low_caps(self):
        self.m['tags']['C49USDT'] = ['Monitoring']
        s = self.summary({'inflow': {}, 'spike': {}})
        big = [a for a in s['avoid'] if a['symbol'] == 'C49']
        self.assertEqual(len(big), 1)
        self.assertFalse(big[0]['lowcap'])
        self.assertNotIn('C1', [a['symbol'] for a in s['avoid']])   # fan tokens are excluded from the watch, not "avoid"


class Model(unittest.TestCase):
    def test_training_file_has_every_feature_and_both_labels(self):
        t = lw.load_training()
        for c in lw.FEATS + ['date', 'inflow3x', 'y2c']:
            self.assertIn(c, t.columns)
        self.assertGreater(len(t), 15000)

    def test_the_fit_is_deterministic(self):
        t = lw.load_training()
        t = t[t.date >= '2025-06-01']
        X = lw.design(t).values
        a, b = lw.fit_models(t), lw.fit_models(t)
        np.testing.assert_array_equal(a[1].predict_proba(X), b[1].predict_proba(X))
        np.testing.assert_array_equal(a[0].predict_proba(X), b[0].predict_proba(X))


class Upbit(unittest.TestCase):
    def test_only_the_formal_warning_marks_a_coin(self):
        mk = [{'market': 'KRW-AAA', 'market_event': {'warning': True, 'caution': {}}},
              {'market': 'BTC-BBB', 'market_event': {'warning': False, 'caution': {'PRICE_FLUCTUATIONS': True}}},
              {'market': 'KRW-BBB', 'market_event': {'warning': False, 'caution': {}}},
              {'market': 'USDT-CCC'}]
        u = lw.parse_upbit(mk)
        self.assertEqual(u['AAA']['flag'], 'warning')
        self.assertEqual(u['BBB']['flag'], '')
        self.assertEqual(u['BBB']['markets'], {'BTC', 'KRW'})
        self.assertEqual(lw.korea_label('CCC', u), 'btc-usdt-only')
        self.assertEqual(lw.korea_label('BBB', u), 'krw')
        self.assertIsNone(lw.korea_label('ZZZ', u))


class Delistings(unittest.TestCase):
    def test_only_future_spot_delistings_count(self):
        arts = [{'title': 'Binance Will Delist ICX, SCRT, STORJ on 2026-09-03'},
                {'title': 'Binance Will Delist ABC & DEF on 2026-10-20'},
                {'title': 'Binance Futures Will Delist Multiple USDⓈ-M Perpetual Contracts (2026-10-25)'},
                {'title': 'Binance Margin Will Delist GHI on 2026-10-22'}]
        self.assertEqual(lw.parse_delistings(arts, '2026-10-13'), {'ABC': '2026-10-20', 'DEF': '2026-10-20'})


if __name__ == '__main__':
    unittest.main()
