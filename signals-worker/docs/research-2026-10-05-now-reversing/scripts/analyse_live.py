import json, math, collections, statistics as st
D = json.load(open('live.json'))
btc = {b[0]: b for b in D['btc']}
def price_at(k, ts):   # close of the 5m bar that contains ts (k: [open_ts, o, h, l, c, quote])
    best = None
    for b in k:
        if b[0] <= ts: best = b
        else: break
    return best[4] if best and ts - best[0] < 600_000 else None
def btc_at(ts):
    b = btc.get(ts - ts % 300_000); return b[2] if b else None
H = [1, 4, 12, 24, 48]
rows = []
for a in D['alerts']:
    k = a['k']
    if not k: continue
    d6 = 1 if a['pct'] > 0 else -1
    e = next((b for b in k if b[0] >= a['t'] + 60_000), None)
    if not e: continue
    pe, te = e[1], e[0]
    be = btc.get(te)
    r = dict(sym=a['symbol'], t=a['sent_at'], rev=a['rev'], d6=d6, pct=a['pct'], rung=a['rung'], batch=a['sent_at'][:16])
    r1 = a['rung'].get('1h'); r3 = a['rung'].get('3h'); r24 = a['rung'].get('1d')
    if not a['rev']: r['case'] = 'aligned'
    elif r1 is not None and r1 * d6 < 0: r['case'] = 'last-hour-turned'
    elif r3 is not None and r3 * d6 < 0: r['case'] = '3h-turned'
    else: r['case'] = 'day-opposite-only'
    for h in H:
        p = price_at(k, te + h*3600_000); b = btc_at(te + h*3600_000)
        if p is None: continue
        ret = (p/pe - 1)*100
        r[f'fade{h}'] = -d6*ret
        if be and b: r[f'xfade{h}'] = -d6*(ret - (b/be[1]-1)*100)
    rows.append(r)
print('alerts with bars:', len(rows), collections.Counter(r['case'] for r in rows))
def clustered(vals_by_batch):
    # one mean per alert batch (same build), then t across batches
    m = [st.mean(v) for v in vals_by_batch.values() if v]
    if len(m) < 3: return len(m), None, None
    mu = st.mean(m); sd = st.stdev(m)
    return len(m), mu, mu/(sd/math.sqrt(len(m))) if sd else None
print(f"\n{'case':22s} {'h':>3s} {'n':>4s} {'batches':>7s} {'fade%':>7s} {'win%':>5s} {'t(batch)':>8s} {'xfade%':>7s} {'t':>6s}")
for case in ['last-hour-turned', '3h-turned', 'day-opposite-only', 'aligned']:
    for h in H:
        sel = [r for r in rows if r['case'] == case and f'fade{h}' in r]
        if not sel: continue
        f = [r[f'fade{h}'] for r in sel]
        byb = collections.defaultdict(list); byx = collections.defaultdict(list)
        for r in sel:
            byb[r['batch']].append(r[f'fade{h}'])
            if f'xfade{h}' in r: byx[r['batch']].append(r[f'xfade{h}'])
        nb, mu, t = clustered(byb); _, xmu, xt = clustered(byx)
        fmt = lambda v, p=2: f'{v:.{p}f}' if v is not None else '—'
        print(f"{case:22s} {h:>3d} {len(f):>4d} {nb:>7d} {fmt(st.mean(f)):>7s} {100*sum(x>0 for x in f)/len(f):>5.0f} {fmt(t):>8s} {fmt(xmu):>7s} {fmt(xt):>6s}")
    print()
json.dump(rows, open('live_rows.json', 'w'))
