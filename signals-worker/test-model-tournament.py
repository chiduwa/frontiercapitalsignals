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
            d = rng.standard_t(3, size=600) * 0.05
            xs = mt.scaled(list(d))
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
            d = rng.normal(0.4, 1.0, size=400)
            e, n = mt.e_value(mt.scaled(list(d)))
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
            ledger.append(ledger_row(good['id'], 'A', 1, d, 0.20 + rng.normal(0, 0.02)))
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


if __name__ == '__main__':
    unittest.main()
