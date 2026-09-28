"""Would the combined model have flagged HBAR before 08:00 UTC on 2026-09-28?

The model (decoupling_models.py) was fitted on the discovery year only. The
hours in question are after the bulk files end, so their features are rebuilt
from Binance spot hourly bars (k1h_recent.json, 38 coins) and this project's
own open-interest record (oi_tick, hourly), the way the live scan would see
them. Futures taker and long/short features are not available for those hours
and are set to neutral (0). Scores are compared with the model's score
distribution over every coin-hour of the validation year."""
import json, math, os, pickle
import numpy as np
D = os.environ.get('DC_DATA', '.')
K = json.load(open(os.path.join(D, 'k1h_recent.json')))
OI = json.load(open(os.path.join(D, 'oi_hourly_live.json')))
rep = json.load(open(os.path.join(D, 'decoupling_report.json')))
clf = pickle.load(open(os.path.join(D, 'bigmove_model.pkl'), 'rb'))
mdl = json.load(open(os.path.join(D, 'decoupling_models.json')))
FEATS = mdl['model']['features']
syms = [s for s in K if len(K[s]) >= 900]
T = sorted(set.intersection(*[set(r[0] for r in K[s]) for s in syms]))
n = len(T); idx = {t: i for i, t in enumerate(T)}
close = {s: np.full(n, np.nan) for s in syms}; qv = {s: np.full(n, np.nan) for s in syms}; tbs = {s: np.full(n, np.nan) for s in syms}
for s in syms:
    for r in K[s]:
        if r[0] in idx: close[s][idx[r[0]]] = r[1]; qv[s][idx[r[0]]] = r[3]; tbs[s][idx[r[0]]] = r[4] / max(r[2], 1e-12)
R = {s: np.concatenate([[np.nan], np.diff(np.log(close[s]))]) for s in syms}
tot = np.nansum([R[s] for s in syms], axis=0); cnt = np.sum([np.isfinite(R[s]) for s in syms], axis=0)
oi = {}
for r in OI:
    h = (int(r['ts']) // 3600000) * 3600000                  # the last tick inside a bar is that bar's closing open interest
    if h in idx and r['oi_contracts']: oi.setdefault(r['symbol'], np.full(n, np.nan))[idx[h]] = float(r['oi_contracts'])
WIN = 720
def rsum(x, k):
    c = np.concatenate([[0.0], np.cumsum(np.nan_to_num(x))]); out = np.full(len(x), np.nan); out[k - 1:] = c[k:] - c[:-k]; return out
def feats_for(s):
    r = R[s]; mkt = (tot - r) / np.maximum(cnt - 1, 1)
    f = {}
    ok = np.isfinite(r) & np.isfinite(mkt)
    # beta and residual sd from the first 30 days available, applied after
    b = np.cov(mkt[ok][:WIN], r[ok][:WIN])[0, 1] / np.var(mkt[ok][:WIN], ddof=1)
    e = r - b * mkt
    sd = np.array([np.nanstd(e[max(1, t - WIN):t], ddof=1) if t > 200 else np.nan for t in range(n)])
    for k in (1, 4, 8, 24, 72): f[f'exc_{k}'] = rsum(e, k); f[f'excz_{k}'] = f[f'exc_{k}'] / (sd * math.sqrt(k))
    for k in (8, 24): f[f'mkt_{k}'] = rsum(mkt, k)
    mq = np.array([np.nanmean(qv[s][max(0, t - WIN - 24):t - 24]) if t > 224 else np.nan for t in range(n)])
    for k in (1, 4, 8, 24): f[f'vr_{k}'] = np.log(rsum(qv[s], k) / (k * mq))
    o = np.log(oi[s]) if s in oi else np.full(n, np.nan)
    for k in (4, 8, 24, 72): f[f'oi_{k}'] = o - np.concatenate([np.full(k, np.nan), o[:-k]])
    tb = tbs[s]; mb = np.array([np.nanmean(tb[max(0, t - WIN - 24):t - 24]) if t > 224 else np.nan for t in range(n)])
    sb = np.array([np.nanstd(tb[max(0, t - WIN - 24):t - 24], ddof=1) if t > 224 else np.nan for t in range(n)])
    for k in (4, 8): f[f'tb_{k}'] = (rsum(tb, k) / k - mb) / sb
    for k in (4, 8, 24): f[f'taker_{k}'] = np.zeros(n)
    for name in ('ls_acct', 'ls_pos', 'ls_all'): f[f'{name}_chg24'] = np.zeros(n); f[f'{name}_z'] = np.zeros(n)
    f['ivol'] = np.log(np.sqrt(rsum(e * e, 24) / 24) / sd)
    def rc(x, y, k):
        xy, xx, yy, sx, sy = rsum(x * y, k), rsum(x * x, k), rsum(y * y, k), rsum(x, k), rsum(y, k)
        return (xy / k - sx * sy / k ** 2) / np.sqrt((xx / k - (sx / k) ** 2) * (yy / k - (sy / k) ** 2))
    f['corrgap'] = rc(r, mkt, 72) - rc(r, mkt, WIN)
    lc = np.log(close[s]); f['hidist'] = lc - np.array([np.nanmax(lc[max(0, t - WIN):t + 1]) for t in range(n)])
    return f, e
F = {s: feats_for(s)[0] for s in syms}
for base, key, ks in (('vr', 'vrx', (1, 4, 8, 24)), ('oi', 'oix', (4, 8, 24, 72))):
    for k in ks:
        med = np.nanmedian(np.vstack([F[s][f'{base}_{k}'] for s in syms]), axis=0)
        for s in syms: F[s][f'{key}_{k}'] = F[s][f'{base}_{k}'] - med
med = np.nanmedian(np.vstack([F[s]['hidist'] for s in syms]), axis=0)
for s in syms: F[s]['hidist'] = F[s]['hidist'] - med
peers = [p for p in rep['peers']['HBAR'] if p in F]
for k in (8, 24): F['HBAR'][f'peer_{k}'] = np.nanmean(np.vstack([F[p][f'exc_{k}'] for p in peers]), axis=0) if peers else np.full(n, np.nan)
X = np.column_stack([F['HBAR'][f] for f in FEATS])
p = clf.predict_proba(X)[:, 1]
# the validation-year score distribution, from the panel
Z = np.load(os.path.join(D, 'decoupling_panel.npz')); hours = Z['hours'].astype('datetime64[h]')
val = hours >= np.datetime64('2025-09-01T00:00', 'h')
allp = np.concatenate([clf.predict_proba(np.column_stack([Z[f'{s}|{f}'] for f in FEATS])[val])[:, 1]
                       for s in sorted({k.split('|')[0] for k in Z.files if '|' in k})])
allp = np.sort(allp[np.isfinite(allp)])
hbar_hist = np.sort(clf.predict_proba(np.column_stack([Z[f'HBAR|{f}'] for f in FEATS])[val])[:, 1])
out = []
print('hour (UTC)         model p   percentile, all coins   percentile, HBAR   vol 8h x   OI 8h   excess 8h   market 8h')
for t in T:
    if t < int(np.datetime64('2026-09-27T16:00', 'ms').astype('int64')) or t > int(np.datetime64('2026-09-28T09:00', 'ms').astype('int64')): continue
    i = idx[t]
    pct = np.searchsorted(allp, p[i]) / len(allp) * 100; ph = np.searchsorted(hbar_hist, p[i]) / len(hbar_hist) * 100
    row = dict(hour=str(np.datetime64(t, 'ms'))[:16], p=float(p[i]), pctAll=float(pct), pctHbar=float(ph), vr8=float(np.exp(F['HBAR']['vr_8'][i])),
               oi8=float(np.expm1(F['HBAR']['oi_8'][i]) * 100), exc8=float(np.expm1(F['HBAR']['exc_8'][i]) * 100), mkt8=float(np.expm1(F['HBAR']['mkt_8'][i]) * 100))
    out.append(row)
    print(f"{row['hour']}   {row['p']:.3f}      {row['pctAll']:5.1f}                  {row['pctHbar']:5.1f}          x{row['vr8']:.2f}   {row['oi8']:+.1f}%   {row['exc8']:+.1f}%     {row['mkt8']:+.1f}%")
json.dump(out, open(os.path.join(D, 'hbar_case_scores.json'), 'w'), indent=1)
