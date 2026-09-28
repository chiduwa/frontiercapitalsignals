"""What happens after a coin first breaks away from the market: continuation or
give-back? Event-based: the first hour an episode's 8-hour excess return
enters the coin's top (bottom) 1% or 5%, at most one per coin per 24 hours,
then the next 24 hours' excess return. Split by year and by what the move
looked like (volume, open interest, market direction)."""
import os, json, math, collections
import numpy as np
DATA = os.environ.get('DC_DATA', '.')
Z = np.load(os.path.join(DATA, 'decoupling_panel.npz'))
hours = Z['hours'].astype('datetime64[h]'); SPLIT = np.datetime64('2025-09-01T00:00', 'h')
days = hours.astype('datetime64[D]').astype(str)
syms = sorted({k.split('|')[0] for k in Z.files if '|' in k})


def events(q, side):
    out = []
    for s in syms:
        x = Z[f'{s}|excz_8']; f = Z[f'{s}|fwd24']
        for h, sel in (('discovery', hours < SPLIT), ('validation', hours >= SPLIT)):
            ok = sel & np.isfinite(x) & np.isfinite(f)
            if ok.sum() < 500: continue
            cut = np.quantile(x[ok], 1 - q) if side > 0 else np.quantile(x[ok], q)
            hit = ok & ((x >= cut) if side > 0 else (x <= cut))
            last = -10 ** 9
            for i in np.nonzero(hit)[0]:
                if i - last >= 24:
                    out.append(dict(coin=s, half=h, day=days[i], fwd=float(f[i]), vr8=float(Z[f'{s}|vr_8'][i]), oi8=float(Z[f'{s}|oi_8'][i]),
                                    mkt8=float(Z[f'{s}|mkt_8'][i]), exc8=float(Z[f'{s}|exc_8'][i])))
                    last = i
    return out


def summary(ev):
    if len(ev) < 10: return None
    f = np.array([e['fwd'] for e in ev]); by = collections.defaultdict(list)
    for e in ev: by[e['day']].append(e['fwd'])
    m = np.array([np.mean(v) for v in by.values()])
    t = m.mean() / (m.std(ddof=1) / math.sqrt(len(m))) if len(m) > 2 and m.std(ddof=1) > 0 else float('nan')
    return {'n': len(ev), 'mean': float(f.mean()), 'median': float(np.median(f)), 'sharePositive': float(np.mean(f > 0)),
            'shareGiveBackHalf': None, 'tDays': float(t)}


res = {}
for q in (0.05, 0.01):
    for side, lab in ((1, 'breakout'), (-1, 'breakdown')):
        ev = events(q, side)
        for h in ('discovery', 'validation'):
            e = [x for x in ev if x['half'] == h]
            key = f'{lab}|top{int(q * 100)}pct|{h}'
            res[key] = {'all': summary(e)}
            # conditioned on the move's character
            conds = {'volume >= 2x norm': lambda x: x['vr8'] >= math.log(2), 'volume < 2x norm': lambda x: x['vr8'] < math.log(2),
                     'open interest up >= 5%': lambda x: x['oi8'] >= math.log(1.05), 'open interest not up': lambda x: x['oi8'] < 0.0,
                     'against a falling market': lambda x: x['mkt8'] <= -0.01, 'with a rising market': lambda x: x['mkt8'] >= 0.01}
            for name, c in conds.items():
                res[key][name] = summary([x for x in e if np.isfinite(x['vr8']) and np.isfinite(x['oi8']) and c(x)])
json.dump(res, open(os.path.join(DATA, 'after_spikes.json'), 'w'), indent=1)
for key, v in res.items():
    a = v['all']
    if not a: continue
    print(f"{key:34s} n {a['n']:4d}  next-24h excess mean {a['mean'] * 100:+.2f}% median {a['median'] * 100:+.2f}%  up {a['sharePositive'] * 100:.0f}%  (t {a['tDays']:.1f})")
    for name, s in v.items():
        if name == 'all' or not s: continue
        print(f"     {name:26s} n {s['n']:4d}  mean {s['mean'] * 100:+.2f}%  median {s['median'] * 100:+.2f}%  up {s['sharePositive'] * 100:.0f}%  (t {s['tDays']:.1f})")
