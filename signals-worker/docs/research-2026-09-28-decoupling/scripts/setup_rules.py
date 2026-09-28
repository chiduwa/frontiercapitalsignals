"""Candidate live alerts for a coming move away from the market, scored on both
years: at most one alert per coin per 24 hours (the first hour it fires), and
an alert counts as a hit when the next 24 hours' excess move clears the event
threshold either way."""
import os, json, math, collections
import numpy as np
D = os.environ.get('DC_DATA', '.')
Z = np.load(os.path.join(D, 'decoupling_panel.npz')); hours = Z['hours'].astype('datetime64[h]')
SPLIT = np.datetime64('2025-09-01T00:00', 'h'); days = hours.astype('datetime64[D]').astype(str)
syms = sorted({k.split('|')[0] for k in Z.files if '|' in k})
L2, L105 = math.log(2), math.log(1.05)
RULES = {
    'setupEitherSide': lambda g: (g('vr_8') >= L2) & (g('oi_8') >= L105) & (np.abs(g('excz_8')) >= 1.5),
    'setupStrength':   lambda g: (g('vr_8') >= L2) & (g('oi_8') >= L105) & (g('excz_8') >= 1.5),
    'setupWeakness':   lambda g: (g('vr_8') >= L2) & (g('oi_8') >= L105) & (g('excz_8') <= -1.5),
    'hbarStrict':      lambda g: (g('vr_8') >= L2) & (g('oi_8') >= L105) & (g('exc_8') >= 0.01) & (g('mkt_8') <= -0.01),
    'setupNoOi':       lambda g: (g('vr_8') >= L2) & (np.abs(g('excz_8')) >= 1.5),
    'strengthNoOi':    lambda g: (g('vr_8') >= L2) & (g('excz_8') >= 1.5),
    'strengthNoOiStrict': lambda g: (g('vr_8') >= math.log(3)) & (g('excz_8') >= 2.0),
    'weaknessNoOiStrict': lambda g: (g('vr_8') >= math.log(3)) & (g('excz_8') <= -2.0),
    'eitherNoOiStrict':   lambda g: (g('vr_8') >= math.log(3)) & (np.abs(g('excz_8')) >= 2.0),
}
out = {}
for name, rule in RULES.items():
    out[name] = {}
    for h, sel in (('discovery', hours < SPLIT), ('validation', hours >= SPLIT)):
        hits = ups = n = 0; fw = []; base_num = base_den = 0; months = sel.sum() / 720
        per_day = collections.defaultdict(list)
        for s in syms:
            g = lambda f: Z[f'{s}|{f}']
            f, thr = Z[f'{s}|fwd24'], Z[f'{s}|thr']
            with np.errstate(invalid='ignore'):
                fire = rule(g) & sel & np.isfinite(f) & np.isfinite(thr)
                big = np.abs(f) >= thr
            ok = sel & np.isfinite(f) & np.isfinite(thr); base_num += int(big[ok].sum()); base_den += int(ok.sum())
            last = -10 ** 9
            for i in np.nonzero(fire)[0]:
                if i - last < 24: continue
                last = i; n += 1; hits += int(big[i]); ups += int(f[i] >= thr[i]); fw.append(f[i]); per_day[days[i]].append(float(big[i]))
        base = base_num / base_den
        dm = np.array([np.mean(v) for v in per_day.values()]) - base
        t = dm.mean() / (dm.std(ddof=1) / math.sqrt(len(dm))) if len(dm) > 2 else float('nan')
        out[name][h] = {'alerts': n, 'perCoinPerMonth': n / len(syms) / months, 'hitRate': hits / n if n else None, 'base': base,
                        'lift': hits / n / base if n else None, 'tVsBase': float(t), 'upShareOfHits': ups / hits if hits else None,
                        'fwdMedian': float(np.median(fw)) if fw else None, 'fwdMean': float(np.mean(fw)) if fw else None}
        x = out[name][h]
        if not n:
            print(f'{name:16s} {h:10s} no alerts (the rule needs data this source lacks)'); continue
        print(f"{name:16s} {h:10s} alerts {n:4d} ({x['perCoinPerMonth']:.2f}/coin/month)  hit {x['hitRate'] * 100:5.1f}% vs {base * 100:.1f}%  "
              f"lift {x['lift']:.1f} (t {t:.1f})  up share {x['upShareOfHits'] if x['upShareOfHits'] is None else round(x['upShareOfHits'], 2)}  "
              f"next-24h excess median {x['fwdMedian'] * 100:+.2f}% mean {x['fwdMean'] * 100:+.2f}%")
json.dump(out, open(os.path.join(D, 'setup_rules.json'), 'w'), indent=1)
