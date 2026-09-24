#!/usr/bin/env python3
"""Combine tracked-sequence-research reports into ONE corrected family.

A study run in batches is one search, and correcting each batch alone is an
uncorrected search (docs/SEQUENCE_MODELS.md, handoff pitfall 1). This pools
every asset x horizon x model x question from every report and corrects them
together, two ways:

  Holm (family-wise): nothing in the whole screen is a false positive, at 5%.
  Benjamini-Hochberg (false-discovery rate): at most ~5% of what passes is
  false. The right tool for a screen of thousands of tests, whose passes are
  CANDIDATES for the model tournament's forward test, never conclusions.

The per-test bootstrap p-values bottom out at 1/20001; with ~20,000 tests
Holm's first bar (0.05/20,000) sits below that floor, so nothing could pass
however real. The combined p-values therefore come from each test's
bootstrap interval (mean / half-width x 1.96), one-sided, which is
continuous. The per-report p is kept alongside for reference.
"""
import argparse, json, math
from pathlib import Path


def normal_sf(z):
    return 0.5 * math.erfc(z / math.sqrt(2))


def interval_p(t):
    """One-sided p for 'mean > 0' from a bootstrap 95% interval."""
    lo, hi, m = t.get('low'), t.get('high'), t.get('mean')
    if lo is None or hi is None or m is None or not (hi > lo): return 1.0
    se = (hi - lo) / (2 * 1.959964)
    return normal_sf(m / se) if se > 0 else 1.0


def collect(reports, exclude=()):
    tests = []
    for rep in reports:
        cls = rep.get('assetClass', 'crypto')
        for sym, hs in rep['assets'].items():
            if sym in exclude: continue
            for h, r in hs.items():
                if not r.get('observations'): continue
                for m, v in r.get('direction', {}).items():
                    if m != 'baseRate': tests.append((cls, sym, h, m, 'direction vs base rate', v['brierImprovement']))
                for m, v in r.get('magnitude', {}).items():
                    if m != 'medianAbs': tests.append((cls, sym, h, m, 'size vs median', v['vsMedian']))
                    if m not in ('medianAbs', 'garchWeekday'): tests.append((cls, sym, h, m, 'size vs GARCH+weekday', v['vsGarchWeekday']))
    return tests


def correct(tests):
    ps = [interval_p(t[5]) for t in tests]
    order = sorted(range(len(ps)), key=lambda i: ps[i])
    n = len(ps)
    holm, prev = [1.0] * n, 0.0
    for rank, i in enumerate(order):
        prev = max(prev, min(1.0, ps[i] * (n - rank))); holm[i] = prev
    bh, run = [1.0] * n, 1.0
    for rank in range(n - 1, -1, -1):
        i = order[rank]
        run = min(run, ps[i] * n / (rank + 1)); bh[i] = min(1.0, run)
    return ps, holm, bh


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('reports', nargs='+'); ap.add_argument('--output', required=True)
    ap.add_argument('--exclude', default='', help='symbols whose series are known bad (e.g. stored at too few decimals)')
    a = ap.parse_args()
    reports = [json.loads(Path(p).read_text()) for p in a.reports]
    exclude = {s for s in a.exclude.split(',') if s}
    tests = collect(reports, exclude)
    ps, holm, bh = correct(tests)
    rows = []
    for (cls, sym, h, m, q, t), p, ph, pb in zip(tests, ps, holm, bh):
        rows.append({'assetClass': cls, 'symbol': sym, 'horizon': int(h), 'model': m, 'question': q,
                     'mean': t.get('mean'), 'low': t.get('low'), 'high': t.get('high'),
                     'bootstrapP': t.get('p'), 'p': p, 'holmP': ph, 'bhQ': pb})
    passes_holm = [r for r in rows if r['holmP'] < 0.05 and (r['mean'] or 0) > 0]
    passes_bh = [r for r in rows if r['bhQ'] < 0.05 and (r['mean'] or 0) > 0]
    assets = {(r['assetClass'], r['symbol']) for r in rows}
    summary = {'reports': len(reports), 'assets': len(assets), 'excluded': sorted(exclude),
               'assetsByClass': {c: sum(1 for x in assets if x[0] == c) for c in {x[0] for x in assets}},
               'tests': len(rows), 'holmPasses': len(passes_holm), 'bhPasses': len(passes_bh),
               'rawBelow05': sum(1 for r in rows if r['p'] < 0.05 and (r['mean'] or 0) > 0),
               'expectedByChance05': round(0.05 * len(rows), 1)}
    by = {}
    for r in passes_bh:
        k = (r['question'], r['model'])
        by[k] = by.get(k, 0) + 1
    summary['bhPassesByQuestionModel'] = {f'{k[0]} | {k[1]}': v for k, v in sorted(by.items(), key=lambda t: -t[1])}
    out = Path(a.output); out.mkdir(parents=True, exist_ok=True)
    (out / 'combined.json').write_text(json.dumps({'summary': summary, 'holm': passes_holm, 'bh': passes_bh}, indent=1))
    (out / 'all-tests.json').write_text(json.dumps(rows))
    print(json.dumps(summary, indent=1))
    for r in sorted(passes_bh, key=lambda r: r['p'])[:40]:
        print(f"  {r['assetClass']:6s} {r['symbol']:8s} {r['horizon']}  {r['model']:12s} {r['question']:24s} mean {r['mean']:+.5f}  p {r['p']:.2e}  holm {r['holmP']:.3f}  bh {r['bhQ']:.3f}")


if __name__ == '__main__':
    main()
