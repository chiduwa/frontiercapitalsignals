"""Which of the live rule's setups carry news about the coin itself?

The rule (8-hour volume >= 3x the coin's norm, 8-hour excess >= 2 sds, at most
one setup per coin per 24 hours) was first scored against the 2.4% of all
coin-hours followed by a big move. But setups bunch into busy hours, when
every coin is more likely to move, so the fair comparison is the share of ALL
the coins that moved that far over the SAME 24 hours. On that basis this
script tests filters that keep the rule to setups whose volume surge is the
coin's own, choosing on the first year and reading the second once.

Reads DC_DATA/decoupling_panel.npz as decoupling_study.py writes it, built on
Binance SPOT bars (fetch_spot.py), the live scanner's own source. Writes
DC_DATA/setup_filters.json.

usage: DC_DATA=/path/to/spot python setup_filters.py"""
import collections, json, math, os
import numpy as np

D = os.environ.get('DC_DATA', '.')
Z = np.load(os.path.join(D, 'decoupling_panel.npz'))
hours = Z['hours'].astype('datetime64[h]')
SPLIT = np.datetime64('2025-09-01T00:00', 'h')
days = hours.astype('datetime64[D]')
syms = sorted({k.split('|')[0] for k in Z.files if '|' in k})
M = lambda f: np.vstack([Z[f'{s}|{f}'] for s in syms])
vr, vrx, ez, fw, th = M('vr_8'), M('vrx_8'), M('excz_8'), M('fwd24'), M('thr')   # vrx_8 = vr_8 less the median coin's
L3 = math.log(3)
ok = np.isfinite(fw) & np.isfinite(th)
with np.errstate(invalid='ignore'):
    big = (np.abs(fw) >= th) & ok
    hot_n = (vr >= L3).sum(axis=0)                     # coins on 3x volume at each hour
avail = np.isfinite(vr).sum(axis=0)
base_h = np.where(ok.sum(axis=0) > 0, big.sum(axis=0) / np.maximum(ok.sum(axis=0), 1), np.nan)
months = {'discovery': (hours < SPLIT).sum() / 720, 'validation': (hours >= SPLIT).sum() / 720}


def take(fire):
    """The study's cooldown: the first hour a coin fires, then nothing for 24 hours."""
    out = []
    for k in range(len(syms)):
        last = -10 ** 9
        for i in np.nonzero(fire[k])[0]:
            if i - last < 24: continue
            last = i
            if ok[k, i]: out.append((k, i))
    return out


def score(fire):
    recs = take(fire)
    res = {}
    for name, sel in (('discovery', lambda i: hours[i] < SPLIT), ('validation', lambda i: hours[i] >= SPLIT)):
        r = [(k, i) for k, i in recs if sel(i)]
        if not r: res[name] = None; continue
        n = len(r); h = sum(big[k, i] for k, i in r); b = sum(base_h[i] for _, i in r)
        per_day = collections.defaultdict(list)
        for k, i in r: per_day[days[i]].append(big[k, i] - base_h[i])
        dm = np.array([np.mean(v) for v in per_day.values()])
        t = dm.mean() / (dm.std(ddof=1) / math.sqrt(len(dm))) if len(dm) > 2 else float('nan')
        ups = sum(1 for k, i in r if big[k, i] and fw[k, i] > 0)
        f = np.array([fw[k, i] for k, i in r])
        res[name] = dict(setups=n, perCoinPerMonth=n / len(syms) / months[name], hitRate=h / n, sameHoursBase=b / n,
                         lift=h / b, tDays=float(t), upShareOfHits=ups / h if h else None,
                         next24ExcessMedian=float(np.median(f)), next24ExcessMean=float(f.mean()), sharePositive=float((f > 0).mean()))
    return res


def line(label, o):
    s = label.ljust(50)
    for k in ('discovery', 'validation'):
        x = o[k]
        s += (f" | {k[:4]} {x['setups']:4d} ({x['perCoinPerMonth']:.2f}/coin/mo) hit {x['hitRate'] * 100:4.1f}%"
              f" vs {x['sameHoursBase'] * 100:4.1f}% lift {x['lift']:.1f} t {x['tDays']:.1f}")
    print(s)


out = {'coins': len(syms), 'first': str(hours[0]), 'last': str(hours[-1]), 'filters': {}, 'adopted': {}}
with np.errstate(invalid='ignore'):
    rule = (vr >= L3) & (np.abs(ez) >= 2.0)
    cands = {'live rule, no filter': rule}
    for kmax in (2, 3, 4, 5, 6, 8):
        cands[f'+ at most {kmax} coins on 3x volume that hour'] = rule & (hot_n <= kmax)[None, :]
    for f in (0.05, 0.08, 0.10, 0.13, 0.16, 0.20):
        cands[f'+ at most {f:.0%} of coins on 3x volume'] = rule & ((hot_n / np.maximum(avail, 1)) <= f)[None, :]
    for x in (2.0, 2.5, 3.0):
        cands[f'volume vs median coin >= {x}x (no own floor)'] = (vrx >= math.log(x)) & (np.abs(ez) >= 2.0)
    for x in (2.0, 2.5, 3.0):
        cands[f'+ volume vs median coin >= {x}x'] = rule & (vrx >= math.log(x))
    print(f'{len(syms)} coins, {hours[0]} to {hours[-1]}; each rate against the same hours\' base rate\n')
    for label, fire in cands.items():
        o = score(fire); out['filters'][label] = o; line(label, o)

    adopted = rule & (vrx >= math.log(2))
    print('\nadopted: own volume >= 3x its norm, >= 2x the median coin\'s, |excess z| >= 2')
    for side, cond in (('ahead', ez >= 2.0), ('behind', ez <= -2.0), ('either', np.abs(ez) >= 2.0)):
        o = score(adopted & cond); out['adopted'][side] = o; line(f'  {side}', o)
        for k in ('discovery', 'validation'):
            x = o[k]
            print(f"      {k:10s} up share of big moves {x['upShareOfHits']:.2f}; next 24h excess median {x['next24ExcessMedian'] * 100:+.2f}%"
                  f" mean {x['next24ExcessMean'] * 100:+.2f}%, share positive {x['sharePositive']:.2f}")
    dropped = score(rule & ~(vrx >= math.log(2)))
    out['dropped'] = dropped
    line('  what the filter drops', dropped)

    # how often a poor week happens under the adopted rule
    wk = collections.defaultdict(lambda: [0, 0, 0.0])
    for k, i in take(adopted):
        w = str(hours[i].astype('datetime64[W]')); wk[w][0] += 1; wk[w][1] += int(big[k, i]); wk[w][2] += base_h[i]
    rates = np.array([h / n for n, h, _ in wk.values() if n >= 5])
    out['weekly'] = dict(weeksWith5Plus=int(len(rates)), medianHitRate=float(np.median(rates)), p10=float(np.percentile(rates, 10)),
                         shareAtOrUnder5pct=float((rates <= 0.05).mean()),
                         last=[(w, n, h, round(b / n, 3)) for w, (n, h, b) in sorted(wk.items())[-6:]])
    print(f"\nweeks with 5+ setups: {len(rates)}; weekly hit rate median {np.median(rates):.2f}, 10th percentile {np.percentile(rates, 10):.2f}; "
          f"{(rates <= 0.05).mean():.0%} of weeks at or under 5%")
    print('last weeks (Thursday start: setups, big moves, same-hours base):', out['weekly']['last'])
json.dump(out, open(os.path.join(D, 'setup_filters.json'), 'w'), indent=1)
