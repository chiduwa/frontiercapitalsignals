"""Per-coin early predictors and a combined model, on decoupling_study.py's panel.

1. Per coin: for every early sign, is its top decile followed by more
   breakouts / breakdowns away from the market (event lift), and by a higher
   or lower excess return, in BOTH years? Binomial tests for the lifts and
   day-clustered t-tests for the returns, Benjamini-Hochberg across every coin
   x sign x question, and only same-sign replications in the validation year
   count.
2. One model for all 40 (gradient-boosted trees), fitted on the discovery
   year, judged on the validation year: can it tell which coin-hours come
   before a big move away from the market (either way), and, given one, which
   way?
3. Alert rules simple enough to run hourly: precision, recall, lead and how
   often they would fire.
"""
import os, json, math, collections
import numpy as np
from scipy import stats

DATA = os.environ.get('DC_DATA', '.')
Z = np.load(os.path.join(DATA, 'decoupling_panel.npz'))
hours = Z['hours'].astype('datetime64[h]')
SPLIT = np.datetime64('2025-09-01T00:00', 'h')
syms = sorted({k.split('|')[0] for k in Z.files if '|' in k})
FEATS = sorted({k.split('|')[1] for k in Z.files if '|' in k} - {'fwd24', 'fwd8', 'fwd48', 'thr', 'fwdm24', 'close', 'e', 'sd_e', 'hbar'})
days = hours.astype('datetime64[D]').astype(str)
halves = {'discovery': hours < SPLIT, 'validation': hours >= SPLIT}


def bh(ps):
    ps = np.asarray(ps, float); n = len(ps); order = np.argsort(ps); q = np.empty(n); prev = 1.0
    for rank, i in enumerate(order[::-1]):
        k = n - rank; prev = min(prev, ps[i] * n / k); q[i] = prev
    return q


def day_t(vals, dys):
    by = collections.defaultdict(list)
    for v, d in zip(vals, dys): by[d].append(v)
    m = np.array([np.mean(v) for v in by.values()])
    if len(m) < 8 or m.std(ddof=1) == 0: return float(np.mean(vals)) if len(vals) else float('nan'), float('nan'), len(m)
    return float(m.mean()), float(m.mean() / (m.std(ddof=1) / math.sqrt(len(m)))), len(m)


def per_coin():
    rows = []
    for s in syms:
        fwd, thr = Z[f'{s}|fwd24'], Z[f'{s}|thr']
        up, dn = fwd >= thr, fwd <= -thr
        for f in FEATS:
            x = Z[f'{s}|{f}']
            rec = {'coin': s, 'sign': f}
            for h, sel in halves.items():
                ok = sel & np.isfinite(x) & np.isfinite(fwd) & np.isfinite(thr)
                if ok.sum() < 500: break
                q9 = np.quantile(x[ok], 0.9); top = ok & (x >= q9)
                pu, pd = up[ok].mean(), dn[ok].mean()
                # events cluster in time: count distinct event days, not hours
                def lift_p(ev, p):
                    k_days = len(set(days[top & ev])); n_days = len(set(days[top])); base_days = len(set(days[ok & ev])) / max(len(set(days[ok])), 1)
                    return (k_days / n_days / base_days if base_days > 0 and n_days else float('nan'),
                            stats.binomtest(k_days, n_days, base_days, alternative='greater').pvalue if base_days > 0 and n_days else 1.0)
                lu, plu = lift_p(up, pu); ld, pld = lift_p(dn, pd)
                m, t, nd = day_t(fwd[top], days[top])
                rec[h] = {'upLift': lu, 'pUp': plu, 'downLift': ld, 'pDown': pld, 'fwd': m, 't': t, 'days': nd}
            else:
                rows.append(rec)
    # BH on the validation-year p-values of the signs whose discovery year pointed the same way
    tests = []
    for i, r in enumerate(rows):
        d, v = r['discovery'], r['validation']
        if d['upLift'] > 1.5: tests.append((i, 'up', v['pUp']))
        if d['downLift'] > 1.5: tests.append((i, 'down', v['pDown']))
        if abs(d['t']) >= 2 and np.isfinite(v['t']):
            p = stats.t.sf(v['t'] * np.sign(d['t']), max(v['days'] - 1, 1))
            tests.append((i, 'direction', p))
    q = bh([t[2] for t in tests])
    survivors = []
    for (i, kind, p), qq in zip(tests, q):
        r = rows[i]
        if qq < 0.05:
            if kind == 'direction' and np.sign(r['validation']['t']) != np.sign(r['discovery']['t']): continue
            survivors.append({'coin': r['coin'], 'sign': r['sign'], 'kind': kind, 'q': float(qq),
                              'discovery': r['discovery'], 'validation': r['validation']})
    return rows, tests, survivors


def model():
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.metrics import roc_auc_score
    X, big, up, S, H = [], [], [], [], []
    for s in syms:
        fwd, thr = Z[f'{s}|fwd24'], Z[f'{s}|thr']
        M = np.column_stack([Z[f'{s}|{f}'] for f in FEATS])
        ok = np.isfinite(fwd) & np.isfinite(thr) & (np.isfinite(M).sum(axis=1) >= len(FEATS) * 0.6)
        X.append(M[ok]); big.append((np.abs(fwd) >= thr)[ok]); up.append((fwd >= thr)[ok]); S.append(np.full(ok.sum(), s)); H.append(hours[ok])
    X, big, up, S, H = (np.concatenate(v) for v in (X, big, up, S, H))
    tr, te = H < SPLIT, H >= SPLIT
    # hourly rows overlap: fit on every 4th hour to keep the trees from memorizing runs
    fit = tr & (np.arange(len(H)) % 4 == 0)
    clf = HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=300, min_samples_leaf=200,
                                         l2_regularization=1.0, random_state=7).fit(X[fit], big[fit])
    p = clf.predict_proba(X[te])[:, 1]
    res = {'features': FEATS, 'bigMove': {'baseRate': float(big[te].mean()), 'auc': float(roc_auc_score(big[te], p))}}
    order = np.argsort(-p)
    for share in (0.01, 0.05, 0.10):
        k = int(len(order) * share); sel = order[:k]
        res['bigMove'][f'top{int(share * 100)}pct'] = {'hitRate': float(big[te][sel].mean()), 'lift': float(big[te][sel].mean() / big[te].mean()),
                                                      'recall': float(big[te][sel].sum() / big[te].sum())}
    # per coin AUC in the validation year
    res['perCoinAuc'] = {}
    for s in syms:
        k = S[te] == s
        if big[te][k].sum() >= 10 and (~big[te][k]).sum() >= 10:
            res['perCoinAuc'][s] = float(roc_auc_score(big[te][k], p[k]))
    # direction, given a big move: fitted on discovery big-move rows only
    bt, be = tr & big, te & big
    dclf = HistGradientBoostingClassifier(max_depth=2, learning_rate=0.05, max_iter=200, min_samples_leaf=100,
                                          l2_regularization=1.0, random_state=7).fit(X[bt], up[bt])
    pd = dclf.predict_proba(X[be])[:, 1]
    res['directionGivenBig'] = {'n': int(be.sum()), 'upShare': float(up[be].mean()), 'auc': float(roc_auc_score(up[be], pd))}
    # permutation importance on the validation year (big-move model)
    from sklearn.inspection import permutation_importance
    sub = np.nonzero(te)[0][::7]
    imp = permutation_importance(clf, X[sub], big[sub], scoring='roc_auc', n_repeats=3, random_state=7)
    res['importance'] = sorted(((FEATS[i], float(imp.importances_mean[i])) for i in range(len(FEATS))), key=lambda x: -x[1])[:12]
    return res, clf


def rules():
    """Transparent hourly alert candidates, scored on both years."""
    out = {}
    cands = {
        'hbarPattern': lambda g: (g('vr_8') >= math.log(2)) & (g('oi_8') >= math.log(1.05)) & (g('exc_8') >= 0.01) & (g('mkt_8') <= -0.01),
        'volumeRamp': lambda g: (g('vr_8') >= math.log(2.5)),
        'volumeRampAndOi': lambda g: (g('vr_8') >= math.log(2)) & (g('oi_8') >= math.log(1.05)),
        'volumeRampOiAndStrength': lambda g: (g('vr_8') >= math.log(2)) & (g('oi_8') >= math.log(1.05)) & (g('excz_8') >= 1.5),
        'oiBuildQuietPrice': lambda g: (g('oi_8') >= math.log(1.08)) & (np.abs(g('exc_8')) <= 0.01),
    }
    for name, rule in cands.items():
        out[name] = {}
        for h, sel in halves.items():
            fired, bigs, ups, fwds, dys, lead = 0, 0, 0, [], [], []
            n_alert_days = 0; tot_big = 0; caught = 0
            for s in syms:
                g = lambda f: Z[f'{s}|{f}']
                fwd, thr = Z[f'{s}|fwd24'], Z[f'{s}|thr']
                with np.errstate(invalid='ignore'):
                    r = rule(g) & sel & np.isfinite(fwd) & np.isfinite(thr)
                # one alert per coin per 24 hours (the first hour it fires)
                idx = np.nonzero(r)[0]; keep = []; last = -10 ** 9
                for i in idx:
                    if i - last >= 24: keep.append(i); last = i
                keep = np.array(keep, int)
                big = np.abs(fwd) >= thr
                fired += len(keep); bigs += int(big[keep].sum()); ups += int((fwd >= thr)[keep].sum())
                fwds += list(fwd[keep]); dys += list(days[keep])
                # recall: of this coin's big-move episodes (first hour of each), how many had an alert in the 24h before
                ev = np.nonzero(big & sel & np.isfinite(fwd))[0]; starts = []; last = -10 ** 9
                for i in ev:
                    if i - last > 24: starts.append(i)
                    last = i
                tot_big += len(starts)
                alert_set = np.zeros(len(fwd), bool); alert_set[keep] = True
                for i in starts:
                    if alert_set[max(0, i - 24):i + 1].any(): caught += 1
            base = np.mean([np.mean((np.abs(Z[f'{s}|fwd24']) >= Z[f'{s}|thr'])[sel & np.isfinite(Z[f'{s}|fwd24'])]) for s in syms])
            m, t, nd = day_t(np.array(fwds), np.array(dys)) if fwds else (float('nan'), float('nan'), 0)
            out[name][h] = {'alerts': fired, 'perCoinPerMonth': fired / len(syms) / (sel.sum() / 720), 'bigMoveRate': bigs / fired if fired else None,
                            'baseRate': float(base), 'lift': (bigs / fired / base) if fired and base else None,
                            'upShareOfBig': ups / bigs if bigs else None, 'recall': caught / tot_big if tot_big else None,
                            'fwdExcessMean': m, 'fwdExcessT': t}
    return out


if __name__ == '__main__':
    rows, tests, survivors = per_coin()
    res, clf = model()
    rl = rules()
    out = {'perCoinTests': len(tests), 'survivors': survivors, 'model': res, 'rules': rl,
           'perCoin': rows}
    json.dump(out, open(os.path.join(DATA, 'decoupling_models.json'), 'w'), indent=1, default=float)
    import pickle
    pickle.dump(clf, open(os.path.join(DATA, 'bigmove_model.pkl'), 'wb'))
    print('per-coin tests', len(tests), 'survivors', len(survivors))
    print(json.dumps({k: v for k, v in res.items() if k != 'perCoinAuc'}, indent=1)[:3000])
    print('per-coin AUC (validation):', {k: round(v, 3) for k, v in sorted(res['perCoinAuc'].items(), key=lambda x: -x[1])})
    for name, v in rl.items():
        for h in ('discovery', 'validation'):
            x = v[h]
            print(f"{name:26s} {h:10s} alerts {x['alerts']:5d} ({x['perCoinPerMonth']:.2f}/coin/month)  big-move rate {x['bigMoveRate'] if x['bigMoveRate'] is None else round(x['bigMoveRate'] * 100, 1)}% vs {x['baseRate'] * 100:.1f}%  "
                  f"lift {x['lift'] if x['lift'] is None else round(x['lift'], 2)}  up share {x['upShareOfBig'] if x['upShareOfBig'] is None else round(x['upShareOfBig'], 2)}  recall {x['recall'] if x['recall'] is None else round(x['recall'], 3)}  fwd {x['fwdExcessMean'] * 100:+.2f}% (t {x['fwdExcessT']:.1f})")
