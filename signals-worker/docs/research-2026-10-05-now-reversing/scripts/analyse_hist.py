# Replays the live post-move detector (notify.mjs checkAndNotifySuddenMoves)
# on hourly Binance closes, then scores what a fade or follow trade would have
# made. Close-at-build entry, plus a one-hour-late entry as a robustness check.
import json, os, math, collections, statistics as st, sys
THR = float(os.environ.get('THR', 10)); WIN = int(os.environ.get('WIN', 6)); LAG = int(os.environ.get('LAG', 0))
H = [1, 4, 12, 24, 48]
btc = {b[0]: b[4] for b in json.load(open('h1/BTC.json'))}
ev = []
for fn in sorted(os.listdir('h1')):
    s = fn[:-5]
    if s in ('BTC',): continue
    b = json.load(open('h1/' + fn))
    if len(b) < 500: continue
    ts = [x[0] for x in b]; c = [x[4] for x in b]; hi = [x[2] for x in b]; lo = [x[3] for x in b]; q = [x[5] for x in b]
    seen = set()
    for i in range(25, len(b) - 49 - LAG):
        if ts[i] - ts[i-24] != 24*3600_000: continue       # gap in the series: skip, never step across it
        pct = (c[i]/c[i-WIN] - 1)*100
        if abs(pct) < THR: continue
        d6 = 1 if pct > 0 else -1
        day = (ts[i] + 3600_000)//86400_000
        if (day, d6) in seen: continue
        seen.add((day, d6))
        rung = {k: (c[i]/c[i-k] - 1)*100 for k in (1, 3, 6, 24)}
        signs = {math.copysign(1, v) for v in rung.values() if v != 0}
        if len(signs) <= 1: case = 'aligned'
        elif rung[1]*d6 < 0: case = 'last-hour-turned'
        elif rung[3]*d6 < 0: case = '3h-turned'
        else: case = 'day-opposite-only'
        j = i + LAG
        pe = c[j]; bt = btc.get(ts[j])
        r = dict(s=s, ts=ts[i], day=day, d6=d6, pct=pct, case=case, rung=rung, qv=sum(q[i-23:i+1]))
        for h in H:
            if ts[j+h] - ts[j] != h*3600_000: continue
            ret = (c[j+h]/pe - 1)*100
            r[f'f{h}'] = -d6*ret
            b2 = btc.get(ts[j+h])
            if bt and b2: r[f'x{h}'] = -d6*(ret - (b2/bt - 1)*100)
        # path for stop/target sims: next 48 bars' high/low relative to entry
        r['path'] = [(hi[j+k]/pe - 1)*100 for k in range(1, 49)], [(lo[j+k]/pe - 1)*100 for k in range(1, 49)], [(c[j+k]/pe - 1)*100 for k in range(1, 49)]
        ev.append(r)
print(f'THR={THR} WIN={WIN}h LAG={LAG}h  events={len(ev)}  span', min(e['day'] for e in ev), max(e['day'] for e in ev), collections.Counter(e['case'] for e in ev))
def by_day_t(sel, key):
    g = collections.defaultdict(list)
    for e in sel:
        if key in e: g[e['day']].append(e[key])
    m = [st.mean(v) for v in g.values()]
    if len(m) < 5: return len(m), None, None
    mu, sd = st.mean(m), st.stdev(m)
    return len(m), mu, mu/(sd/math.sqrt(len(m)))
fmt = lambda v, p=2: f'{v:.{p}f}' if v is not None else '—'
mid = sorted(e['day'] for e in ev)[len(ev)//2]
print(f"{'case':20s} {'side':>3s} {'h':>3s} {'n':>5s} {'days':>5s} {'fade%':>6s} {'med':>6s} {'win%':>5s} {'t(day)':>7s} {'xfade':>6s} {'t':>6s} | {'1st half':>8s} {'2nd half':>8s}")
for case in ['last-hour-turned', '3h-turned', 'day-opposite-only', 'aligned']:
    for side, sgn in (('up', 1), ('dn', -1)):
        for h in H:
            sel = [e for e in ev if e['case'] == case and e['d6'] == sgn and f'f{h}' in e]
            if len(sel) < 10: continue
            f = [e[f'f{h}'] for e in sel]
            nd, mu, t = by_day_t(sel, f'f{h}'); _, xmu, xt = by_day_t(sel, f'x{h}')
            _, m1, t1 = by_day_t([e for e in sel if e['day'] < mid], f'f{h}'); _, m2, t2 = by_day_t([e for e in sel if e['day'] >= mid], f'f{h}')
            print(f"{case:20s} {side:>3s} {h:>3d} {len(f):>5d} {nd:>5d} {fmt(st.mean(f)):>6s} {fmt(st.median(f)):>6s} {100*sum(x>0 for x in f)/len(f):>5.0f} {fmt(t):>7s} {fmt(xmu):>6s} {fmt(xt):>6s} | {fmt(m1)+'/'+fmt(t1,1):>8s} {fmt(m2)+'/'+fmt(t2,1):>8s}")
        print()
import pickle; pickle.dump(ev, open(f'ev_{THR}_{WIN}_{LAG}.pkl', 'wb'))
