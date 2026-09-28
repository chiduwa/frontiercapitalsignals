"""The buying-time slot: smoothing, Holt-Winters and Monte Carlo.

The tournament's timing target is which of the six 4-hour opens (00, 04, ...,
20 UTC) is the day's cheapest, the firing the spot bot would have bought at.
Its candidates count how often each slot was cheapest over the last 30/90/365
days, with and without the weekday. Tested here, with the tournament's own
walk-forward (firing days known two days before the day forecast) and its own
loss (log loss over the six slots), on its own 4-hour data:

  ewma{H}          simple exponential smoothing of each slot's "was cheapest"
                   indicator, half-life H days (14, 45, 120): the count with
                   a fading memory instead of a hard window
  ewma{H}Weekday   the same, blended with the same weekday's history the way
                   the tournament's weekday variant blends it
  randomWalkMc     Monte Carlo: 20,000 days of five 4-hour moves drawn from
                   the coin's own recent moves (no drift), slot probabilities
                   = how often each open was the lowest. A driftless walk is
                   lowest at its ends more often than in the middle, a
                   structure no window count needs to relearn
  holtWintersMc    the same simulation with each step's drift taken from a
                   Holt-Winters fit (season = 6 slots) of the 4-hour log price
Scored on the last 360 days per coin against the uniform benchmark and the
tournament's firingFrequency candidates.
"""
import importlib.util, json, math, os, sys, warnings
import numpy as np

SW = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sp = importlib.util.spec_from_file_location('mt', os.path.join(SW, 'scripts', 'model-tournament.py'))
mt = importlib.util.module_from_spec(sp); sp.loader.exec_module(mt)
sp = importlib.util.spec_from_file_location('cm', os.path.join(SW, 'scripts', 'classic-models-research.py'))
cm = importlib.util.module_from_spec(sp); sp.loader.exec_module(cm)
DATA = os.environ.get('OVF_DATA', '.')
FIR = mt.FIRINGS


def arcsine(n=FIR):
    """Sparre Andersen: for a driftless walk with symmetric continuous steps,
    the lowest of n equally spaced points falls at k with probability
    C(2k, k) C(2(n-1-k), n-1-k) / 4^(n-1), whatever the step distribution."""
    m = n - 1
    return np.array([math.comb(2 * k, k) * math.comb(2 * (m - k), m - k) / 4 ** m for k in range(n)])


def ewma_probs(known, half_life, weekday=None):
    last = mt.day(known[-1]['date'])
    w = np.array([0.5 ** (float((last - mt.day(d['date'])) / mt.DAY) / half_life) for d in known])
    counts = np.zeros(FIR)
    np.add.at(counts, [d['cheapest'] for d in known], w)
    base = (counts + 1) / (counts.sum() + FIR)
    if weekday is None: return base
    same = [(d, wi) for d, wi in zip(known, w) if d['weekday'] == weekday]
    cw = np.zeros(FIR)
    if same: np.add.at(cw, [d['cheapest'] for d, _ in same], [wi for _, wi in same])
    return (cw + 10 * base) / (cw.sum() + 10)


def simulate(drift, moves, rng, sims=20000):
    """P(open j is the day's lowest) for five 4-hour steps with the given
    per-step drift and moves bootstrapped from `moves`."""
    steps = rng.choice(moves, size=(sims, FIR - 1)) + drift
    path = np.c_[np.zeros(sims), np.cumsum(steps, axis=1)]
    counts = np.bincount(np.argmin(path, axis=1), minlength=FIR).astype(float)
    return (counts + 1) / (sims + FIR)


def intraday(klines):
    """4-hour log opens (x100) with each bar's UTC day and slot."""
    t = np.array([k[0] for k in klines], dtype='int64'); o = np.array([k[1] for k in klines], dtype=float)
    keep = o > 0; t, o = t[keep], o[keep]
    d = t.astype('datetime64[ms]').astype('datetime64[D]')
    slot = ((t.astype('datetime64[ms]') - d.astype('datetime64[ms]')) / np.timedelta64(4, 'h')).astype(int)
    return d, slot, np.log(o) * 100


def main():
    kl = json.load(open(os.path.join(DATA, 'klines.json')))['klines']
    rng = np.random.default_rng(5)
    models = ['uniform', 'freq30', 'freq90', 'freq365', 'freq30Weekday', 'freq90Weekday', 'freq365Weekday',
              'ewma14', 'ewma45', 'ewma120', 'ewma45Weekday', 'randomWalkMc', 'holtWintersMc',
              'mcPrior30', 'mcPrior100', 'mcPrior300', 'poolMcEwma120', 'arcsine', 'arcsinePrior100']
    losses = {m: {} for m in models}   # model -> {(sym, date): loss}
    for sym, klines in sorted(kl.items()):
        days = mt.firing_days(klines)
        if len(days) < 400: continue
        start = mt.add_days(days[-1]['date'], -mt.SCREEN_DAYS)
        d_arr, slot, logp = intraday(klines)
        moves_all = np.diff(logp)
        hw_cache = {}
        for t in days:
            if t['date'] < start: continue
            cutoff = mt.add_days(t['date'], -2)
            known = [d for d in days if d['date'] <= cutoff]
            if len(known) < 30: continue
            out = {'uniform': np.full(FIR, 1 / FIR)}
            for n in (30, 90, 365):
                for wd in (False, True):
                    spec = mt.make('timing', 'firingFrequency', window=n, weekday=wd)
                    out[f'freq{n}' + ('Weekday' if wd else '')] = np.array(mt.fit_predict(spec, known, [t], 2)[0][0]['probs'])
            for hl in (14, 45, 120): out[f'ewma{hl}'] = ewma_probs(known, hl)
            out['ewma45Weekday'] = ewma_probs(known, 45, t['weekday'])
            # bars through the end of the cutoff day: the same information set
            end = int(np.searchsorted(d_arr, np.datetime64(cutoff) + np.timedelta64(1, 'D')))
            recent = moves_all[max(0, end - 1 - 6 * 30):end - 1]
            recent = recent[np.isfinite(recent)]
            if len(recent) >= 60:
                out['randomWalkMc'] = simulate(np.zeros(FIR - 1), recent - recent.mean(), rng)
                # Holt-Winters (level + additive 6-slot season) fitted on 90 days of
                # 4-hour log prices every 28 days, then filtered forward from the
                # same first bar (so its heuristic start is the fit's own) to the cutoff.
                key = int((mt.day(t['date']) - mt.day(start)) / mt.DAY) // 28
                if key not in hw_cache:
                    lo0 = max(0, end - 6 * 90)
                    hw_cache[key] = (cm.fit_ets(logp[lo0:end], ('add', None, False, 'add'), FIR), lo0)
                fit, lo = hw_cache[key]
                if fit is not None:
                    _, L, B, S = cm.ets_states(logp[lo:end], ('add', None, False, 'add'), FIR, fit)
                    tt = end - 1 - lo
                    # opens of the forecast day are steps k whose slot phases are 0..5
                    phase_last = int(slot[end - 1])
                    ks = [((j - phase_last - 1) % FIR) + 1 + FIR for j in range(FIR)]
                    f = np.array([cm.hw_forecast(L, B, S, tt, k, None, 'add', FIR, 1.0) for k in ks])
                    out['holtWintersMc'] = simulate(np.diff(f), recent - recent.mean(), rng)
            if 'randomWalkMc' in out:
                # The walk as the prior, the coin's own (fading) firing record as
                # the evidence: a Dirichlet update worth kappa days of prior.
                last = mt.day(known[-1]['date'])
                w = np.array([0.5 ** (float((last - mt.day(d['date'])) / mt.DAY) / 120) for d in known])
                cnt = np.zeros(FIR); np.add.at(cnt, [d['cheapest'] for d in known], w)
                for kappa in (30, 100, 300):
                    out[f'mcPrior{kappa}'] = (cnt + kappa * out['randomWalkMc']) / (cnt.sum() + kappa)
                out['poolMcEwma120'] = 0.5 * out['randomWalkMc'] + 0.5 * out['ewma120']
                out['arcsine'] = arcsine()
                out['arcsinePrior100'] = (cnt + 100 * arcsine()) / (cnt.sum() + 100)
            for m, p in out.items():
                losses[m][(sym, t['date'])] = -math.log(max(float(p[t['cheapest']]), 1e-9))
        print(f'{sym}: {sum(1 for k in losses["uniform"] if k[0] == sym)} days', flush=True)
    tr = cm.tr
    res = {}
    base = losses['freq90Weekday']
    for m in models:
        common = [k for k in losses[m] if k in base and k in losses['uniform']]
        per = {}
        for k in common: per.setdefault(k[1], []).append(base[k] - losses[m][k])
        dd = np.array([np.mean(per[d]) for d in sorted(per)])
        un = {}
        for k in common: un.setdefault(k[1], []).append(losses['uniform'][k] - losses[m][k])
        du = np.array([np.mean(un[d]) for d in sorted(un)])
        res[m] = {'n': len(common), 'meanLogLoss': float(np.mean([losses[m][k] for k in common])),
                  'vsFreq90Weekday': tr.block_interval(dd, 7), 'vsUniform': tr.block_interval(du, 7)}
        v = res[m]
        print(f"{m:15s} n {v['n']:6d}  log loss {v['meanLogLoss']:.4f}  vs uniform {v['vsUniform']['mean']:+.4f} (p {v['vsUniform']['p']:.3f})"
              f"  vs freq90Weekday {v['vsFreq90Weekday']['mean']:+.4f} (p {v['vsFreq90Weekday']['p']:.3f})")
    # how often each slot was the cheapest (the structure a walk implies)
    cheapest = np.zeros(FIR)
    for sym, klines in kl.items():
        for d in mt.firing_days(klines)[-360:]: cheapest[d['cheapest']] += 1
    res['_cheapestShare'] = (cheapest / cheapest.sum()).tolist()
    print('share of days each slot was cheapest (00..20 UTC):', np.round(cheapest / cheapest.sum(), 3))
    json.dump(res, open(os.path.join(DATA, 'timing_study.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
