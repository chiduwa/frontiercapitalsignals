"""Is a more timely typical move better for the published band? Each call's
68% band = class multiplier x typical |move|, where the typical move is the
asset's whole matured history (as shipped), its last N outcomes (60 daily or
12 weekly), or their geometric mean. Multipliers are refitted every 28 days on
matured outcomes only. Data: the engine's composite calls (comp_*.json, see
the README)."""
import glob, json, os, collections
import numpy as np
DATA = os.environ.get('OVF_DATA', '.')
IS = lambda lo, hi, y: (hi - lo) + (2 / 0.32) * np.maximum(lo - y, 0) + (2 / 0.32) * np.maximum(y - hi, 0)
rows = collections.defaultdict(list)
for path in sorted(glob.glob(os.path.join(DATA, 'comp_*_*.json'))):
    cls = os.path.basename(path).split('_')[1]
    for r in json.load(open(path)):
        if r['r'] is not None: rows[(cls, int(r['h']))].append(r)
res = {}
for (cls, h), rs in sorted(rows.items()):
    N = 60 if h == 24 else 12
    rs.sort(key=lambda r: (r['d'], r['s'])); by = collections.defaultdict(list)
    for r in rs: by[r['d']].append(r)
    ordered = sorted(by); ptr = 0; hist = collections.defaultdict(list); items = []
    for d in ordered:
        known = str(np.datetime64(d) - np.timedelta64(h // 24, 'D'))
        while ptr < len(ordered) and ordered[ptr] <= known:
            for r in by[ordered[ptr]]: hist[r['s']].append(abs(r['r']))
            ptr += 1
        for r in by[d]:
            hs = hist[r['s']]
            if len(hs) >= max(20, N): items.append((d, abs(r['r']), float(np.mean(hs)), float(np.mean(hs[-N:]))))
    d = np.array([i[0] for i in items]); a = np.array([i[1] for i in items])
    whole = np.array([i[2] for i in items]); recent = np.array([i[3] for i in items]); blend = np.sqrt(whole * recent)
    out = {}
    for name, den in (('whole', whole), ('recent', recent), ('blend', blend)):
        with np.errstate(divide='ignore', invalid='ignore'): z = a / den
        order = np.argsort(d); ds, zs = d[order], z[order]
        kmap, block_end, kk = {}, None, None
        for dd in sorted(set(d)):
            if block_end is None or dd >= block_end:
                cutoff = str(np.datetime64(dd) - np.timedelta64(h // 24, 'D')); lo = str(np.datetime64(dd) - np.timedelta64(730, 'D'))
                sel = zs[(ds < cutoff) & (ds >= lo)]; sel = sel[np.isfinite(sel)]
                kk = float(np.quantile(sel, 0.68)) if len(sel) >= 500 else None
                block_end = str(np.datetime64(dd) + np.timedelta64(28, 'D'))
            kmap[dd] = kk
        k = np.array([kmap[x] if kmap[x] else np.nan for x in d]); ok = np.isfinite(k) & np.isfinite(den) & (den > 0)
        half = k[ok] * den[ok]; y = a[ok]
        out[name] = {'coverage': float(np.mean(y <= half)), 'intervalScore': float(np.mean(IS(-half, half, y))), 'n': int(ok.sum())}
    res[f'{cls}|{h}'] = out
    print(cls, h, json.dumps(out))
json.dump(res, open(os.path.join(DATA, 'band_timely.json'), 'w'), indent=1)
