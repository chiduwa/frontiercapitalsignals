"""Does the live band's per-asset lookback choice (bestVolLookback) overfit?

Replicates worker.js exactly: realizedVolPct = population std of daily %
returns over the last L closes; bestVolLookback picks, from {10,20,30,60,90},
the L whose mean squared standardized 7-day move over ALL history so far is
closest to 1 (needs 40 samples). Walk-forward: at each date t the choice uses
only closes up to t; the forecast is scored on the next 7-day move.

Compared with a fixed lookback for everyone (10, 20, 30, 60, 90) and with an
equal-weight average of the five variances. Score: QLIKE on the 7-day move
(lower is better) and calibration (mean squared standardized move, 1 = right).
One forecast per asset per week so outcomes do not overlap.
"""
import os
SW = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))   # signals-worker/
import json, math, collections
import numpy as np

SP = os.environ.get('OVF_DATA', '.')
panel = json.load(open(f'{SP}/hier-panel.json'))
LS = (10, 20, 30, 60, 90); H = 7; MIN_SAMPLES = 40
START = '2023-01-01'

def rolling_pop_std(r, L):
    out = np.full(len(r) + 1, np.nan)          # out[t] = std of r[t-L:t] (returns ending at close t)
    c1 = np.concatenate([[0], np.cumsum(r)]); c2 = np.concatenate([[0], np.cumsum(r * r)])
    for t in range(L, len(r) + 1):
        s1 = c1[t] - c1[t - L]; s2 = c2[t] - c2[t - L]
        m = s1 / L; out[t] = math.sqrt(max(s2 / L - m * m, 0))
    return out

res = collections.defaultdict(list)   # variant -> list of (date, cls, loss, z2)
raw_fixed90 = []
picks = collections.Counter()
for a in panel['assets']:
    bars = [b for b in a['bars'] if b.get('close') and b['close'] > 0]
    if len(bars) < 400: continue
    cls = 'stock' if a['assetClass'] in ('stock', 'benchmark') else 'crypto'
    dates = [b['date'] for b in bars]; c = np.array([b['close'] for b in bars], float)
    r = (c[1:] / c[:-1] - 1) * 100
    # Dead, pegged or quantized series (a sub-cent coin stored at a few decimals
    # "moves" only when its rounding flips) are not volatility forecasts at all.
    if np.mean(r == 0) > 0.05 or np.median(np.abs(r)) < 0.05: continue
    # One-day jumps beyond +-2000% are the archive's known stuck-then-jump
    # artifacts (see archive.mjs barsRowsToReturnsBySymbol); skip such assets.
    if np.max(np.abs(r)) > 300: continue
    # vol_L[i] = realizedVolPct over the closes ending at index i
    vol = {L: rolling_pop_std(r, L) for L in LS}      # index = close index
    move = np.full(len(c), np.nan); move[:-H] = (c[H:] / c[:-H] - 1) * 100
    # expanding calibration statistic per L, as bestVolLookback computes it at each t
    first = max(LS) + 1
    sumsq = {L: 0.0 for L in LS}; cnt = {L: 0 for L in LS}
    for t in range(first, len(c) - H):
        # history available at t: test points i with i + H <= t
        i = t - H
        if i >= first:
            for L in LS:
                v = vol[L][i]
                if v and v > 0 and math.isfinite(move[i]):
                    sumsq[L] += (move[i] / (v * math.sqrt(H))) ** 2; cnt[L] += 1
        if dates[t] < START or (t % H) != 0: continue      # one forecast a week
        if not math.isfinite(move[t]): continue
        cands = {L: abs(sumsq[L] / cnt[L] - 1) for L in LS if cnt[L] >= MIN_SAMPLES}
        chosen = min(cands, key=cands.get) if cands else 30
        picks[(cls, chosen)] += 1
        variants = {f'fixed{L}': vol[L][t] for L in LS}
        variants['perAsset'] = vol[chosen][t]
        vs = [vol[L][t] for L in LS]
        variants['combo'] = math.sqrt(np.mean([x * x for x in vs])) if all(x and x > 0 for x in vs) else np.nan
        if not all(x and x > 0.05 and math.isfinite(x) for x in variants.values()): continue
        # the asset's own past 7-day moves, one a week, as moveStats uses them
        past = move[first:t - H + 1:H]
        past = past[np.isfinite(past)]
        variants['moveStats'] = float(np.std(past)) / math.sqrt(H) if len(past) >= 20 else np.nan
        if not math.isfinite(variants['moveStats']): continue
        for name, v in variants.items():
            s2 = (v * v) * H
            res[(cls, name)].append((dates[t], move[t] ** 2 / s2 + math.log(s2), move[t] ** 2 / s2))
        raw_fixed90.append((cls, dates[t], move[t], vol[90][t]))

# fixed 90 x a class calibration factor learned only from EARLIER forecasts:
# k = mean(min(z^2, 50)) over the class's scored 7-day moves whose outcome was
# known before the forecast date (trailing two years).
import bisect
for cls in ('crypto', 'stock'):
    items = sorted([x for x in raw_fixed90 if x[0] == cls], key=lambda x: x[1])
    known_dates, known_z = [], []
    order = sorted(items, key=lambda x: x[1])
    zs = [(x[1], min(x[2] ** 2 / (x[3] ** 2 * H), 50)) for x in order]
    import numpy as _np
    dts = [z[0] for z in zs]; cum = _np.concatenate([[0], _np.cumsum([z[1] for z in zs])])
    for d, mv, v in [(x[1], x[2], x[3]) for x in order]:
        cutoff = str(_np.datetime64(d) - _np.timedelta64(H, 'D'))        # outcome known by then
        lo = str(_np.datetime64(d) - _np.timedelta64(730, 'D'))
        i1 = bisect.bisect_right(dts, cutoff); i0 = bisect.bisect_right(dts, lo)
        k = (cum[i1] - cum[i0]) / (i1 - i0) if i1 - i0 >= 500 else 1.0
        s2 = v * v * H * k
        res[(cls, 'fixed90cal')].append((d, mv ** 2 / s2 + math.log(s2), mv ** 2 / s2))

print('7-day band, one forecast per asset per week, 2023-2026. QLIKE vs the live per-asset choice (negative = better than live)')
out = {}
for cls in ('crypto', 'stock'):
    base = res[(cls, 'perAsset')]
    bydate = collections.defaultdict(list)
    print(f'\n=== {cls}: {len(base)} forecasts; live choice calibration {np.mean([min(z, 50) for _, _, z in base]):.3f} (1.0 = right, z^2 capped at 50) ===')
    base_map = collections.defaultdict(list)
    for d2, l2, _ in base: base_map[d2].append(l2)
    for name in ['fixed10', 'fixed20', 'fixed30', 'fixed60', 'fixed90', 'combo', 'moveStats', 'fixed90cal']:
        other = res[(cls, name)]
        per = collections.defaultdict(list)
        if name == 'fixed90cal':
            om = collections.defaultdict(list)
            for d1, l1, _ in other: om[d1].append(l1)
            for d in om:
                if d in base_map: per[d].append(np.mean(om[d]) - np.mean(base_map[d]))
        else:
            for (d1, l1, _), (d2, l2, _) in zip(other, base):
                per[d1].append(l1 - l2)
        m = np.array([np.mean(v) for v in per.values()])
        t = m.mean() / (m.std(ddof=1) / math.sqrt(len(m)))
        cal = np.mean([min(z, 50) for _, _, z in other])
        out[f'{cls}|{name}'] = {'diff': float(m.mean()), 't': float(t), 'calibration': float(cal)}
        print(f'  {name:8s} QLIKE {m.mean():+.4f} (t {t:+.1f})  calibration {cal:.3f}')
    print('  live picks:', sorted(((k[1], v) for k, v in picks.items() if k[0] == cls)))
json.dump(out, open(f'{SP}/lookback_audit.json', 'w'), indent=1)
