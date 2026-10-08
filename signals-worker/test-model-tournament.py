"""model-tournament.py: the promotion test stays valid under continuous
monitoring, forecasts never see later data, and the lifecycle promotes,
resets and demotes as documented."""
import importlib.util, json, math, unittest
from pathlib import Path
import numpy as np

spec = importlib.util.spec_from_file_location('mt', Path(__file__).parent / 'scripts' / 'model-tournament.py')
mt = importlib.util.module_from_spec(spec); spec.loader.exec_module(mt)


def synthetic_rows(n=700, seed=5, symbol='A', edge=0.0):
    """Daily rows with every feature group populated; `edge` plants a real
    momentum effect so a fitted model has something to find."""
    rng = np.random.default_rng(seed)
    start = np.datetime64('2023-01-01')
    rows, prev = [], 0.0
    vol = 0.02
    for i in range(n):
        date = str(start + np.timedelta64(i, 'D'))
        values = {}
        for names in mt.GROUPS.values():
            for k in names: values[k] = float(rng.normal())
        values['return5'] = prev
        values.update(weekday=(i + 0) % 7, month=int(date[5:7]), dailyVol=vol, ewmaVol=vol * 1.1,
                      harDaily=vol, harWeek=vol, harMonth=vol, leader_B_1=float(rng.normal()))
        move = rng.normal(edge * np.sign(prev), vol)
        prev = float(rng.normal())
        for h in (1, 7):
            rows.append({'symbol': symbol, 'date': date, 'targetDate': str(start + np.timedelta64(i + h, 'D')),
                         'horizon': h, 'target': math.expm1(move * math.sqrt(h)) * 100, 'values': values,
                         'garchWeekdayPct': math.expm1(vol * math.sqrt(h)) * 100,
                         'garchPct': math.expm1(vol * math.sqrt(h)) * 100, 'harWeekdayPct': math.expm1(vol * math.sqrt(h)) * 100})
    return rows


class EProcess(unittest.TestCase):
    def test_no_better_challenger_is_rarely_promoted_however_often_checked(self):
        rng = np.random.default_rng(11)
        alpha = mt.alpha_for(1)  # the largest share any challenger gets
        crossings = 0
        runs = 400
        for _ in range(runs):
            # Heavy-tailed, zero-mean advantage, checked after EVERY outcome.
            d = np.clip(rng.standard_t(3, size=600) * 0.05, -1, 1)
            xs = mt.bounded_differences(list(d), 'direction')
            logs = np.zeros(len(mt.LAMBDAS)); crossed = False
            for x in xs:
                if x is None: continue
                logs += np.log1p(mt.LAMBDAS * x)
                if np.mean(np.exp(logs)) >= 1 / alpha: crossed = True; break
            crossings += crossed
        rate = crossings / runs
        # Ville bounds the rate by alpha; allow Monte Carlo slack.
        self.assertLessEqual(rate, alpha + 2.5 * math.sqrt(alpha * (1 - alpha) / runs), f'false promotion rate {rate}')

    def test_a_real_improvement_is_found(self):
        rng = np.random.default_rng(3)
        found = 0
        for _ in range(50):
            d = np.clip(rng.normal(0.4, 1.0, size=400), -1, 1)
            e, n = mt.e_value(mt.bounded_differences(list(d), 'direction'))
            found += e >= 1 / mt.alpha_for(1)
        self.assertGreaterEqual(found, 45)

    def test_alpha_is_spent_not_exceeded(self):
        self.assertLessEqual(sum(mt.alpha_for(j) for j in range(1, 10000)), mt.ALPHA)

    def test_scale_is_predictable(self):
        # Changing difference 40 may change x_40 itself, never anything before
        # it -- and x_40's scale comes only from differences 0..39.
        d = list(np.random.default_rng(1).normal(size=50))
        a = mt.scaled(d); d[40] = 1e6; b = mt.scaled(d)
        self.assertEqual(a[:40], b[:40])
        self.assertEqual(b[40], 1.0)
        d[40] = -a[40] * 3 * float(np.std(d[:40]))
        self.assertAlmostEqual(mt.scaled(d)[40], -a[40])


class NoLookAhead(unittest.TestCase):
    def test_every_family_forecasts_the_same_without_later_rows(self):
        rows = synthetic_rows()
        asof = rows[1000]['date']
        for target, h in (('direction', 1), ('direction', 7), ('magnitude', 1), ('magnitude', 7)):
            series = [r for r in rows if r['horizon'] == h]
            # The forecast row is OPEN in production: its own outcome unknown.
            test = [dict(r, target=None) for r in series if r['date'] == asof]
            cut = [r for r in series if r['targetDate'] <= asof] + test
            for spec in mt.candidate_grid(target) + [mt.BENCHMARKS[target]]:
                full, _ = mt.fit_predict(spec, mt.matured(series, asof), test, h)
                short, _ = mt.fit_predict(spec, mt.matured(cut, asof), test, h)
                self.assertEqual(json.dumps(full), json.dumps(short), f'{spec["id"]} changed with later rows')
                self.assertTrue(all(r['targetDate'] <= asof for r in mt.matured(series, asof)))

    def test_timing_uses_only_days_known_at_the_close(self):
        rng = np.random.default_rng(2)
        t0 = int(np.datetime64('2025-01-01T00:00', 'ms').astype('int64'))
        kl = [[t0 + k * 4 * 3600000, float(100 + rng.normal())] for k in range(6 * 200)]
        days = mt.firing_days(kl)
        self.assertEqual(len(days), 200)
        asof = days[150]['date']
        known = mt.timing_known(days, asof)
        self.assertTrue(all(d['date'] <= asof for d in known))
        target = {'date': mt.add_days(asof, 2), 'weekday': 3}
        for spec in mt.candidate_grid('timing'):
            p = mt.fit_predict(spec, known, [target], 2)[0][0]['probs']
            self.assertAlmostEqual(sum(p), 1.0, places=9)
            p2 = mt.fit_predict(spec, mt.timing_known(days[:152], asof), [target], 2)[0][0]['probs']
            self.assertEqual(p, p2)

    def test_the_cheapest_firing_is_the_lowest_open(self):
        t0 = int(np.datetime64('2025-03-03T00:00', 'ms').astype('int64'))
        opens = [5, 4, 6, 3, 7, 8]
        d = mt.firing_days([[t0 + k * 4 * 3600000, o] for k, o in enumerate(opens)])
        self.assertEqual(d[0]['cheapest'], 3)


class Losses(unittest.TestCase):
    def test_qlike_is_minimized_at_the_true_scale(self):
        rng = np.random.default_rng(4)
        r = rng.normal(0, 0.03, 20000)
        pct = np.expm1(r) * 100
        avg = lambda s: np.mean([mt.loss('magnitude', {'sigma': s}, p) for p in pct])
        self.assertLess(avg(0.03), avg(0.02)); self.assertLess(avg(0.03), avg(0.045))

    def test_brier_and_log_loss(self):
        self.assertAlmostEqual(mt.loss('direction', {'pUp': 0.7}, 1.0), 0.09)
        self.assertAlmostEqual(mt.loss('timing', {'probs': [0.5, 0.1, 0.1, 0.1, 0.1, 0.1]}, 0), math.log(2))


def ledger_row(mid, sym, h, asof, loss, target='direction'):
    return {'model_id': mid, 'symbol': sym, 'target': target, 'horizon': h, 'as_of': asof,
            'target_date': mt.add_days(asof, h), 'forecast_json': json.dumps({'pUp': 0.5}), 'loss': loss}


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.rows = synthetic_rows(n=260)
        self.asof = self.rows[-1]['date']
        for r in self.rows:
            if r['date'] == self.asof: r['target'] = None

    def tournament(self, registry, ledger):
        data = {'symbols': ['A'], 'rows': self.rows, 'klines': {}}
        t = mt.Tournament(data, registry, ledger, self.asof, '2026-01-01T00:00:00Z')
        for target, h in mt.SLOTS:
            for sym in [mt.POOLED, 'A']:
                if t.slot_symbols(sym, target): t.register(mt.BENCHMARKS[target], sym, h, 'benchmark', 'production method')
        return t

    def test_forward_winner_is_promoted_then_rivals_reset_then_decay_demotes(self):
        bench = mt.BENCHMARKS['direction']['id']
        grid = mt.candidate_grid('direction')
        good, other = grid[0], grid[1]
        start = mt.add_days(self.asof, -200)
        reg = []
        t = self.tournament(reg, [])
        for s in (good, other):
            m = t.register(s, 'A', 1, 'challenger', 'test'); m['epoch_start'] = start
        rng = np.random.default_rng(8)
        ledger = []
        for k in range(200):
            d = mt.add_days(start, k)
            ledger.append(ledger_row(bench, 'A', 1, d, 0.25 + rng.normal(0, 0.02)))
            # The bounded mean test needs a stronger finite-sample effect
            # than the old, invalid variance-scaled clipping shortcut.
            ledger.append(ledger_row(good['id'], 'A', 1, d, 0.17 + rng.normal(0, 0.02)))
            ledger.append(ledger_row(other['id'], 'A', 1, d, 0.25 + rng.normal(0, 0.02)))
        t2 = self.tournament(list(t.registry.values()), ledger)
        t2.lifecycle()
        champ = t2.champion('A', 'direction', 1)
        self.assertIsNotNone(champ); self.assertEqual(champ['model_id'], good['id'])
        self.assertEqual(t2.incumbent_id('A', 'direction', 1), good['id'])
        # The rival now faces a new incumbent: fresh epoch, a new (smaller) alpha.
        t2.lifecycle()
        rival = t2.registry[(other['id'], 'A', 1)]
        self.assertEqual(rival['incumbent_id'], good['id'])
        self.assertEqual(rival['epoch_start'], mt.add_days(self.asof, 1))
        self.assertGreater(rival['alpha_index'], 2)
        # The champion then does worse than the benchmark it replaced: demoted.
        after = []
        for k in range(1, 200):
            d = mt.add_days(self.asof, k)
            after.append(ledger_row(bench, 'A', 1, d, 0.25 + rng.normal(0, 0.02)))
            after.append(ledger_row(good['id'], 'A', 1, d, 0.30 + rng.normal(0, 0.02)))
        t3 = self.tournament(list(t2.registry.values()), ledger + after)
        t3.asof = mt.add_days(self.asof, 200)
        t3.lifecycle()
        self.assertIsNone(t3.champion('A', 'direction', 1))
        self.assertEqual(t3.registry[(good['id'], 'A', 1)]['status'], 'retired')
        self.assertIn('demoted', t3.registry[(good['id'], 'A', 1)]['reason'])
        self.assertEqual(t3.incumbent_id('A', 'direction', 1), bench)

    def test_too_few_forward_outcomes_never_promote_even_with_a_huge_edge(self):
        bench = mt.BENCHMARKS['direction']['id']; good = mt.candidate_grid('direction')[0]
        start = mt.add_days(self.asof, -30)
        t = self.tournament([], [])
        t.register(good, 'A', 1, 'challenger', 'test')['epoch_start'] = start
        ledger = [ledger_row(m, 'A', 1, mt.add_days(start, k), l) for k in range(30)
                  for m, l in ((bench, 0.25 + 0.01 * (k % 3)), (good['id'], 0.05))]
        t2 = self.tournament(list(t.registry.values()), ledger); t2.lifecycle()
        self.assertIsNone(t2.champion('A', 'direction', 1))

    def test_seven_day_outcomes_are_counted_once_per_week(self):
        led = mt.Ledger([ledger_row(m, 'A', 7, mt.add_days('2026-01-01', k), 0.2) for k in range(70) for m in ('c', 'i')])
        pairs = led.paired('c', 'i', 'A', 7, '2026-01-01')
        self.assertEqual(len(pairs), 10)
        self.assertTrue(all((mt.day(d) - mt.day('2026-01-01')) // mt.DAY % 7 == 0 for d, _ in pairs))

    def test_an_issued_forecast_is_never_rewritten(self):
        t = self.tournament([], [ledger_row(mt.BENCHMARKS['direction']['id'], 'A', 1, self.asof, None)])
        t.emit(mt.BENCHMARKS['direction'], 'A', 'direction', 1, mt.add_days(self.asof, 1), {'pUp': 0.9})
        self.assertEqual(t.forecasts, [])

    def test_the_generator_only_admits_what_history_favours_and_scores_it_later(self):
        rows = synthetic_rows(n=900, edge=0.012)
        asof = rows[-1]['date']
        for r in rows:
            if r['date'] == asof: r['target'] = None
        out = mt.run({'symbols': ['A'], 'rows': rows, 'klines': {}}, [], [], generate=True, run_at='2026-01-01T00:00:00Z', weights=True)
        admitted = [m for m in out['registry'] if m['status'] == 'challenger' and m['target'] == 'direction' and m['horizon'] == 1 and m['symbol'] == 'A']
        self.assertTrue(admitted, 'a planted momentum edge should be admitted for forward testing')
        self.assertTrue(all(json.loads(m['backtest_json'])['meanScaled'] > 0 for m in admitted))
        self.assertTrue(any('momentum' in json.loads(m['spec_json'])['params'].get('groups', []) for m in admitted))
        # Every active model issued exactly one forecast per slot for today.
        keys = [(f['model_id'], f['symbol'], f['horizon'], f['as_of']) for f in out['forecasts']]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertTrue(all(f['as_of'] == asof for f in out['forecasts']))
        # And the weights report says how much each input group carries.
        w = out['summary']['weights']['A']['direction:1']
        self.assertAlmostEqual(sum(w['groupShare'].values()), 1.0, places=3)
        self.assertEqual(max(w['groupShare'], key=w['groupShare'].get), 'momentum')


class CallMetrics(unittest.TestCase):
    """The precision / NPV / sensitivity / specificity readout (2026-10-06):
    counted right, honest about a model that always says up, and never part
    of a promotion decision."""

    def test_counts_on_a_hand_example(self):
        m = mt.call_metrics([(0.6, 1.0), (0.6, -1.0), (0.4, -1.0), (0.4, 2.0), (0.7, 3.0)])
        self.assertEqual((m['n'], m['upRate'], m['callsUp']), (5, 0.6, 0.6))
        self.assertEqual((m['precision'], m['npv']), (round(2 / 3, 4), 0.5))
        self.assertEqual((m['sensitivity'], m['specificity']), (round(2 / 3, 4), 0.5))
        self.assertAlmostEqual(m['informedness'], round(2 / 3, 4) + 0.5 - 1, places=4)
        self.assertIsNone(mt.call_metrics([]))
        # P(up) of exactly 0.5 says nothing, so it is not an "up" call.
        e = mt.call_metrics([(0.6, 1.0), (0.6, -1.0), (0.4, -1.0), (0.4, 2.0), (0.7, 3.0), (0.5, 1.0)])
        self.assertEqual((e['callsUp'], e['sensitivity'], e['npv']), (0.5, 0.5, round(1 / 3, 4)))

    def test_a_model_that_always_says_up_shows_no_skill(self):
        rng = np.random.default_rng(3)
        m = mt.call_metrics([(0.55, float(r)) for r in rng.normal(size=400)])
        self.assertEqual((m['sensitivity'], m['specificity'], m['informedness']), (1.0, 0.0, 0.0))
        self.assertEqual(m['precision'], m['upRate'])          # precision is just the up-rate
        self.assertIsNone(m['npv'])                            # it never said down

    def test_precision_and_npv_lifts_always_share_a_sign(self):
        rng = np.random.default_rng(4)
        for _ in range(300):
            n = int(rng.integers(20, 200))
            m = mt.call_metrics(list(zip(rng.random(n), rng.normal(size=n))))
            if m['precision'] is None or m['npv'] is None: continue
            a, b = m['precision'] - m['upRate'], m['npv'] - (1 - m['upRate'])
            if abs(a) > 2e-4 and abs(b) > 2e-4: self.assertEqual(np.sign(a), np.sign(b))

    def test_the_summary_reports_forward_calls_for_direction_slots_only(self):
        rows = synthetic_rows(n=260)
        asof = rows[-1]['date']
        for r in rows:
            if r['date'] == asof: r['target'] = None
        data = {'symbols': ['A'], 'rows': rows, 'klines': {}}
        bench, good = mt.BENCHMARKS['direction']['id'], mt.candidate_grid('direction')[0]
        start = mt.add_days(asof, -70)
        t = mt.Tournament(data, [], [], asof, '2026-01-01T00:00:00Z')
        for target, h in mt.SLOTS:
            for sym in [mt.POOLED, 'A']:
                if t.slot_symbols(sym, target): t.register(mt.BENCHMARKS[target], sym, h, 'benchmark', 'production method')
        for h in (1, 7):
            t.register(good, 'A', h, 'challenger', 'test')['epoch_start'] = start
        mag = t.register(mt.candidate_grid('magnitude')[0], 'A', 1, 'challenger', 'test'); mag['epoch_start'] = start
        ledger = []
        for k in range(70):
            d = mt.add_days(start, k)
            for h in (1, 7):
                for mid, p in ((good['id'], 0.6 if k % 2 else 0.4), (bench, 0.55)):
                    row = ledger_row(mid, 'A', h, d, 0.25)
                    row['forecast_json'] = json.dumps({'pUp': p})
                    row['outcome_json'] = json.dumps({'value': t.outcome.get(('A', h, d))})
                    ledger.append(row)
        t2 = mt.Tournament(data, list(t.registry.values()), ledger, asof, '2026-01-01T00:00:00Z')
        s = t2.summary()['assets']['A']
        c1 = s['direction:1']['challengers'][0]['calls']
        matured = [mt.add_days(start, k) for k in range(70) if (('A', 1, mt.add_days(start, k)) in t2.outcome)]
        self.assertEqual(c1['n'], len(matured))
        self.assertAlmostEqual(c1['callsUp'], round(sum(1 for d in matured if (mt.day(d) - mt.day(start)) // mt.DAY % 2) / len(matured), 4), places=4)
        self.assertEqual(s['direction:1']['incumbentCalls']['sensitivity'], 1.0)    # the base rate says up every day here
        weekly = [mt.add_days(start, k) for k in range(0, 70, 7) if ('A', 7, mt.add_days(start, k)) in t2.outcome]
        self.assertEqual(s['direction:7']['challengers'][0]['calls']['n'], len(weekly))   # one 7-day outcome per week, never 70
        self.assertLess(len(weekly), 11)
        self.assertNotIn('calls', s['magnitude:1']['challengers'][0])


class Stocks(unittest.TestCase):
    def rows(self, symbol, dates, h_list, seed):
        rng = np.random.default_rng(seed)
        out = []
        for i, d in enumerate(dates):
            values = {k: float(rng.normal()) for names in mt.GROUPS.values() for k in names}
            values.update(weekday=int((mt.day(d).astype('int64') + 4) % 7), month=int(d[5:7]), dailyVol=0.02, ewmaVol=0.02,
                          harDaily=0.02, harWeek=0.02, harMonth=0.02)
            for h in h_list:
                if i + h < len(dates):
                    out.append({'symbol': symbol, 'date': d, 'targetDate': dates[i + h], 'horizon': h,
                                'target': float(rng.normal(0, 2)), 'values': values, 'garchWeekdayPct': 2.0})
                elif i == len(dates) - 1:
                    out.append({'symbol': symbol, 'date': d, 'targetDate': mt.add_days(d, h), 'horizon': h, 'target': None,
                                'values': values, 'garchWeekdayPct': 2.0})
        return out

    def test_a_stock_gets_session_slots_its_own_pool_and_forecasts_from_its_last_session(self):
        days = [mt.add_days('2024-01-01', k) for k in range(504)]  # ends on a Sunday
        sessions = [d for d in days if int((mt.day(d).astype('int64') + 4) % 7) not in (0, 6)]
        data = {'symbols': ['A', 'S'], 'assetClassBySymbol': {'A': 'crypto', 'S': 'stock'}, 'klines': {},
                'rows': self.rows('A', days, (1, 7), 1) + self.rows('S', sessions, (1, 5), 2)}
        out = mt.run(data, [], [], generate=False, run_at='2026-01-01T00:00:00Z', weights=False)
        slots = {(m['symbol'], m['target'], m['horizon']) for m in out['registry']}
        self.assertIn(('S', 'direction', 5), slots); self.assertIn(('*stock', 'magnitude', 5), slots)
        self.assertNotIn(('S', 'timing', 2), slots); self.assertNotIn(('S', 'direction', 7), slots)
        self.assertIn(('*', 'direction', 7), slots); self.assertNotIn(('*', 'direction', 5), slots)
        # The run's as-of is the coin's newest close (a weekend day); the stock
        # still forecasts, from its own last session.
        stock = [f for f in out['forecasts'] if f['symbol'] == 'S']
        self.assertTrue(stock and all(f['as_of'] == sessions[-1] for f in stock))
        self.assertEqual({f['horizon'] for f in stock}, {1, 5})
        self.assertNotEqual(out['asOf'], sessions[-1])

    def test_five_session_outcomes_count_once_per_five_sessions(self):
        sessions = [d for d in (mt.add_days('2026-01-05', k) for k in range(60)) if int((mt.day(d).astype('int64') + 4) % 7) not in (0, 6)]
        led = mt.Ledger([ledger_row(m, 'S', 5, d, 0.2) for d in sessions for m in ('c', 'i')])
        pairs = led.paired('c', 'i', 'S', 5, sessions[0])
        self.assertEqual(len(pairs), math.ceil(len(sessions) / 5))



def with_sequences(rows):
    """The 30-day window a row knows at its close: returns THROUGH its date
    (the previous row's move), never its own target."""
    daily = sorted((r for r in rows if r['horizon'] == 1), key=lambda r: r['date'])
    moves = {r['date']: math.log1p(r['target'] / 100) if r['target'] is not None else None for r in daily}
    order = [r['date'] for r in daily]
    window = {}
    for i, d in enumerate(order):
        window[d] = [[moves[order[k - 1]] if k >= 1 else None, 0.1 * ((k * 7) % 5 - 2)] for k in range(i - 29, i + 1)]
    return [dict(r, sequence=window[r['date']]) for r in rows]


HAS_TORCH = importlib.util.find_spec('torch') is not None
LSTM = {'symbol': 'A', 'assetClass': 'crypto', 'target': 'magnitude', 'horizon': 1, 'family': 'lstm',
        'evidence': 'test: beat GARCH+weekday in both halves'}


class Screened(unittest.TestCase):
    """A candidate the archive-wide screen validated enters its slot once,
    first in line for alpha, and still has to win forward."""
    def data(self, rows, screened):
        return {'symbols': ['A'], 'rows': rows, 'klines': {}, 'screened': screened}

    @unittest.skipUnless(HAS_TORCH, 'torch is installed in the tournament workflow')
    def test_admitted_once_first_in_line_and_the_slot_still_seeds(self):
        # Production's trailing scale reads twice the true volatility, so the
        # generator has calibrated candidates worth seeding beside the LSTM.
        rows = [dict(r, values=dict(r['values'], dailyVol=0.04)) for r in with_sequences(synthetic_rows(n=420))]
        asof = rows[-1]['date']
        for r in rows:
            if r['date'] == asof: r['target'] = None
        extra = [dict(LSTM, symbol='ZZZ'), dict(LSTM, horizon=5)]  # not in the universe; not a crypto slot
        out = mt.run(self.data(rows, [LSTM] + extra), [], [], run_at='2026-01-01T00:00:00Z', weights=False)
        lstm_id = mt.make('magnitude', 'lstm')['id']
        slot = [m for m in out['registry'] if m['symbol'] == 'A' and m['target'] == 'magnitude' and m['horizon'] == 1]
        mine = [m for m in slot if m['model_id'] == lstm_id]
        self.assertEqual(len(mine), 1)
        self.assertEqual((mine[0]['status'], mine[0]['alpha_index']), ('challenger', 1))
        self.assertIn('both halves', mine[0]['reason'])
        self.assertTrue(any(m['status'] == 'challenger' and m['model_id'] != lstm_id for m in slot),
                        'the generator still seeds the slot around it')
        self.assertEqual(sum(1 for m in out['registry'] if m['model_id'] == lstm_id), 1, 'nothing admitted off-universe or off-slot')
        f = [x for x in out['forecasts'] if x['model_id'] == lstm_id]
        self.assertEqual(len(f), 1)
        self.assertGreater(json.loads(f[0]['forecast_json'])['sigma'], 0)
        again = mt.run(self.data(rows, [LSTM]), out['registry'], out['forecasts'], run_at='2026-01-02T00:00:00Z', weights=False)
        self.assertFalse([x for x in again['transitions'] if x['model_id'] == lstm_id], 'admitted once, never again')

    @unittest.skipUnless(HAS_TORCH, 'torch is installed in the tournament workflow')
    def test_the_lstm_forecasts_the_same_without_later_rows_and_twice_alike(self):
        rows = [r for r in with_sequences(synthetic_rows(n=520)) if r['horizon'] == 1]
        asof = rows[400]['date']
        test = [dict(r, target=None) for r in rows if r['date'] == asof]
        cut = [r for r in rows if r['targetDate'] <= asof] + test
        spec = mt.make('magnitude', 'lstm')
        full, _ = mt.fit_predict(spec, mt.matured(rows, asof), test, 1)
        short, _ = mt.fit_predict(spec, mt.matured(cut, asof), test, 1)
        again, _ = mt.fit_predict(spec, mt.matured(rows, asof), test, 1)
        self.assertEqual(json.dumps(full), json.dumps(short))
        self.assertEqual(json.dumps(full), json.dumps(again), 'deterministic on CPU')
        realized = float(np.std([math.log1p(r['target'] / 100) for r in mt.matured(rows, asof)]))
        self.assertTrue(0.2 * realized < full[0]['sigma'] < 5 * realized)

    def test_no_window_means_no_forecast_never_a_stand_in(self):
        rows = synthetic_rows(n=260)
        asof = rows[-1]['date']
        for r in rows:
            if r['date'] == asof: r['target'] = None
        fc, _ = mt.fit_predict(mt.make('magnitude', 'lstm'), mt.matured([r for r in rows if r['horizon'] == 1], asof),
                               [r for r in rows if r['horizon'] == 1 and r['date'] == asof], 1)
        self.assertEqual(fc, [{'sigma': None}])
        out = mt.run(self.data(rows, [LSTM]), [], [], run_at='2026-01-01T00:00:00Z', weights=False)
        lstm_id = mt.make('magnitude', 'lstm')['id']
        self.assertTrue(any(m['model_id'] == lstm_id for m in out['registry']))
        self.assertFalse([x for x in out['forecasts'] if x['model_id'] == lstm_id], 'nothing logged under its name')


class ShrunkCalibration(unittest.TestCase):
    """2026-09-27 (docs/MODEL_OVERFITTING.md): an asset's own calibration
    factor is shrunk toward its class by the weight its precision earns."""

    def assets(self, true_k_by_symbol, n=900, seed=11):
        rows = []
        for j, (sym, k) in enumerate(true_k_by_symbol.items()):
            rng = np.random.default_rng(seed + j)
            start = np.datetime64('2023-01-01')
            for i in range(n):
                d = str(start + np.timedelta64(i, 'D'))
                # the model reports vol 0.02; the truth is sqrt(k) times that
                move = rng.normal(0, 0.02 * math.sqrt(k))
                rows.append({'symbol': sym, 'date': d, 'targetDate': str(start + np.timedelta64(i + 1, 'D')), 'horizon': 1,
                             'target': math.expm1(move) * 100, 'values': {'dailyVol': 0.02}})
        return rows

    def pool_at(self, rows, asof, source='trailing', h=1):
        syms = sorted({r['symbol'] for r in rows})
        by = {s: [r for r in rows if r['symbol'] == s] for s in syms}
        return mt.pool_scales([mt.log_scale_estimate(mt.matured(by[s], asof), source, h) for s in syms]), by

    def test_noise_only_differences_pool_to_the_class(self):
        rows = self.assets({f'S{i}': 1.5 for i in range(8)})
        asof = rows[-2]['date']
        pool, by = self.pool_at(rows, asof)
        mu, tau2 = pool
        self.assertAlmostEqual(math.exp(mu), 1.5, delta=0.15)
        for s, rs in by.items():
            own = mt.log_scale_estimate(mt.matured(rs, asof), 'trailing', 1)
            shrunk = mt.shrunk_scale(own, pool) ** 2
            # pulled closer to the class than the asset's own noisy estimate
            self.assertLessEqual(abs(math.log(shrunk) - mu), abs(own[0] - mu) + 1e-12)

    def test_real_differences_are_kept(self):
        rows = self.assets({'A': 1.0, 'B': 1.0, 'C': 1.0, 'D': 4.0, 'E': 4.0, 'F': 4.0}, n=1500)
        asof = rows[-2]['date']
        pool, by = self.pool_at(rows, asof)
        self.assertGreater(pool[1], 0.1, 'a four-fold difference is not sampling noise')
        for s, want in (('A', 1.0), ('D', 4.0)):
            got = mt.shrunk_scale(mt.log_scale_estimate(mt.matured(by[s], asof), 'trailing', 1), pool) ** 2
            self.assertAlmostEqual(got, want, delta=0.35 * want)

    def test_the_class_estimate_never_sees_later_labels(self):
        rows = self.assets({f'S{i}': 1.0 + 0.2 * i for i in range(5)})
        asof = rows[600]['date']
        early, _ = self.pool_at([r for r in rows if r['date'] <= asof], asof)
        full, _ = self.pool_at(rows, asof)
        self.assertEqual(early, full)

    def test_the_tournament_issues_it_with_the_pool_from_its_own_date(self):
        rows = self.assets({f'S{i}': 1.5 for i in range(4)})
        asof = rows[-1]['date']
        for r in rows:
            if r['date'] == asof: r['target'] = None
        t = mt.Tournament({'symbols': [f'S{i}' for i in range(4)], 'rows': rows, 'klines': {}}, [], [], asof, '2026-01-01T00:00:00Z')
        spec = mt.make('magnitude', 'scale', source='trailing', calibrated='shrunk')
        self.assertIn(spec['id'], [c['id'] for c in mt.candidate_grid('magnitude')])
        pool = t.pool_for(spec, 'S0', 1, asof)
        self.assertIsNotNone(pool)
        test = [r for r in t.rows[('S0', 1)] if r['date'] == asof]
        fc, _ = mt.fit_predict(spec, mt.matured(t.rows[('S0', 1)], asof), test, 1, pool=pool)
        self.assertAlmostEqual(fc[0]['sigma'], 0.02 * math.sqrt(1.5), delta=0.02 * 0.2)
        self.assertEqual(mt.describe(spec), 'trailing volatility, calibrated toward its class')


class ArcsineTiming(unittest.TestCase):
    """2026-09-28 (docs/CLASSIC_MODELS.md): where a random walk's low falls
    among six opens is the discrete arcsine law, whatever the steps."""

    def test_the_law_is_exact_and_symmetric(self):
        p = mt.arcsine_law()
        self.assertEqual([round(x * 1024) for x in p], [252, 140, 120, 120, 140, 252])
        self.assertAlmostEqual(float(p.sum()), 1.0, places=12)

    def test_any_symmetric_walk_follows_it(self):
        rng = np.random.default_rng(3)
        for steps in (rng.normal(size=(60000, 5)), rng.standard_t(2.5, size=(60000, 5))):
            path = np.c_[np.zeros(len(steps)), np.cumsum(steps, axis=1)]
            share = np.bincount(np.argmin(path, axis=1), minlength=6) / len(path)
            self.assertLess(float(np.max(np.abs(share - mt.arcsine_law()))), 0.01)

    def test_the_record_moves_it_only_as_far_as_its_weight(self):
        spec = mt.make('timing', 'arcsine', kappa=100, halfLife=120)
        self.assertIn(spec['id'], [c['id'] for c in mt.candidate_grid('timing')])
        days = [{'date': mt.add_days('2026-01-01', i), 'weekday': 0, 'cheapest': 2} for i in range(60)]
        p = mt.fit_predict(spec, days, [{'date': '2026-03-05', 'weekday': 0}], 2)[0][0]['probs']
        w = sum(0.5 ** (i / 120) for i in range(60))
        self.assertAlmostEqual(p[2], (w + 100 * 120 / 1024) / (w + 100), places=9)
        self.assertAlmostEqual(p[0], 100 * 252 / 1024 / (w + 100), places=9)
        pure = mt.fit_predict(mt.make('timing', 'arcsine'), days, [{'date': '2026-03-05', 'weekday': 0}], 2)[0][0]['probs']
        self.assertEqual(pure, [float(v) for v in mt.arcsine_law()])
        self.assertEqual(mt.describe(spec), "random-walk low (arcsine law), updated by the coin's record (120-day half-life)")


if __name__ == '__main__':
    unittest.main()
