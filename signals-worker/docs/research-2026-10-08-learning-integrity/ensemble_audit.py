"""Cheap direction ensembles on SAVED walk-forward forecasts, no new fitting.

python ensemble_audit.py --input reports/confusion/direction_wf.pkl --output results.json
Run from signals-worker. The existing pickle is a trusted local research artifact.
This reuses explored history: results can reject a change, never promote one.
Equal model mean; 25/50/75% shrinkage toward the training-only base rate;
and a per-asset mixture selected before 2025-04-01, frozen thereafter.
Every comparison uses common rows, and uncertainty uses paired 14-day block
means to account for shared market moves and overlapping multi-day windows.
"""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
import pandas as pd

SPLIT = '2025-04-01'
WEIGHTS = (0.0, 0.25, 0.5, 0.75, 1.0)


def audit(path):
    df = pd.read_pickle(path)
    keys = ['sym', 'cls', 'h', 'date']
    if df.duplicated(keys + ['model']).any():
        raise ValueError('duplicate forecast keys')
    if df.groupby(keys)[['ret', 'base']].nunique().max().max() != 1:
        raise ValueError('models disagree about the target or training base rate')
    p = df.pivot(index=keys, columns='model', values='pUp').dropna()
    if not np.isfinite(p.to_numpy()).all() or not ((p >= 0) & (p <= 1)).all().all():
        raise ValueError('invalid probabilities')
    nonbase = [c for c in p if not c.startswith('direction:baseRate:')]
    x = df.drop_duplicates(keys).set_index(keys)[['ret', 'base']].reindex(p.index)
    x['ensemble'] = p[nonbase].mean(axis=1)
    x['y'] = (x.ret > 0).astype(float)
    x = x.reset_index()
    x['baseLoss'] = (x.base - x.y) ** 2
    for w in WEIGHTS:
        x[f'p{w}'] = x.base + w * (x.ensemble - x.base)
        x[f'l{w}'] = (x[f'p{w}'] - x.y) ** 2
    rows = []
    for (cls, h), g in x.groupby(['cls', 'h']):
        early, late = g[g.date < SPLIT], g[g.date >= SPLIT].copy()
        # Minimum history prevents picking on a handful of observations.
        picked = {}
        for sym, train in early.groupby('sym'):
            picked[sym] = (min(WEIGHTS, key=lambda w: train[f'l{w}'].mean())
                           if len(train) >= 60 else 0.0)
        late['selectedWeight'] = late.sym.map(picked).fillna(0.0)
        late['selectedP'] = late.base + late.selectedWeight * (late.ensemble - late.base)
        candidates = {f'ensemble_weight_{w}': late[f'p{w}'] for w in WEIGHTS[1:]}
        candidates['per_asset_frozen_weight'] = late.selectedP
        for name, pred in candidates.items():
            scored = late.assign(loss=(pred - late.y) ** 2)
            scored['gain'] = scored.baseLoss - scored.loss
            block = (pd.to_datetime(scored.date) - pd.Timestamp(SPLIT)).dt.days // 14
            blocks = scored.groupby(block).gain.mean().to_numpy()
            se = float(blocks.std(ddof=1) / np.sqrt(len(blocks))) if len(blocks) > 1 else None
            # Show both halves of the later period; never tune on either.
            midpoint = str(pd.to_datetime(sorted(late.date.unique())[len(late.date.unique()) // 2]).date())
            asset_gain = scored.groupby('sym').gain.mean()
            rows.append({'class': cls, 'horizon': int(h), 'candidate': name,
                         'n': len(scored), 'assets': int(scored.sym.nunique()),
                         'brier': float(scored.loss.mean()), 'baselineBrier': float(scored.baseLoss.mean()),
                         'brierSkill': float(1 - scored.loss.mean() / scored.baseLoss.mean()),
                         'pairedGain': float(scored.gain.mean()),
                         'blockMeanGain': float(blocks.mean()), 'blockSE': se,
                         'blockT': float(blocks.mean() / se) if se else None,
                         'laterHalfGains': [float(scored.loc[scored.date < midpoint, 'gain'].mean()),
                                            float(scored.loc[scored.date >= midpoint, 'gain'].mean())],
                         'assetsImproved': int((asset_gain > 0).sum()),
                         'selectedWeights': {str(w): list(picked.values()).count(w) for w in WEIGHTS}
                                            if name == 'per_asset_frozen_weight' else None})
    return {'inputSHA256': hashlib.sha256(Path(path).read_bytes()).hexdigest(),
            'inputForecasts': len(df), 'commonAssetDates': len(x),
            'modelCount': len(nonbase), 'selectionBefore': SPLIT,
            'evaluationEnd': str(x.date.max()), 'actionable': False,
            'limitations': ['Previously explored historical panel; not fresh forward evidence.',
                            'Surviving fixed asset universe; delisted assets not added.',
                            'Block t values are diagnostics, not multiplicity-adjusted promotion tests.',
                            'Brier improvement does not establish net trading profit or executable timing.'],
            'results': rows}


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--output', required=True)
    args = ap.parse_args()
    result = audit(args.input)
    Path(args.output).write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
    for r in result['results']:
        print(r['class'], r['horizon'], r['candidate'], 'Brier skill', round(r['brierSkill'], 5),
              'block t', round(r['blockT'], 2) if r['blockT'] is not None else None,
              'assets improved', r['assetsImproved'], '/', r['assets'])
