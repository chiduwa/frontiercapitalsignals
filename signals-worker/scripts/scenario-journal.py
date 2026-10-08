"""Read-only counterfactuals for journaled short exits; output stays private.

The fill's Binance realized P&L identifies its cost basis. Counterfactuals
describe the subsequent path, not what was knowable or tradable at the exit.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import numpy as np
import pandas as pd

sp = importlib.util.spec_from_file_location('scenario', Path(__file__).with_name('scenario-research.py'))
s = importlib.util.module_from_spec(sp); sp.loader.exec_module(s)


def review(directory):
    directory = Path(directory)
    raw = json.loads((directory / 'journal-fills.json').read_text())[0]['results']
    fills = pd.DataFrame(raw)
    fills['event_time'] = pd.to_datetime(fills.event_time, utc=True)
    results = []
    for sym in ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HBARUSDT']:
        rows = fills[fills.symbol == sym].sort_values('event_time')
        b = s.load_bars(directory, sym)
        funding = s.data.read_archives(directory, 'fundingRate', sym)
        hypotheses = s.rules(s.features(b, s.data.read_archives(directory, 'metrics', sym), funding))
        # Reconstruct the sign/size before each fill; only an identifiable
        # short reduction qualifies. A fill that flips net side is excluded.
        inventory = 0.0
        closes = []
        for r in rows.to_dict('records'):
            q = float(r['quantity'])
            if r['side'] == 'BUY' and inventory < -1e-8 and q <= -inventory + 1e-7:
                if r['event_time'] >= pd.Timestamp('2026-09-24', tz='UTC'):
                    closes.append(r)
            inventory += q * (1 if r['side'] == 'BUY' else -1)
            if abs(inventory) < 1e-8: inventory = 0.0
        if not closes: continue
        for oid, group in pd.DataFrame(closes).groupby('order_id'):
            q = float(group.quantity.sum())
            exit_px = float((group.price * group.quantity).sum() / q)
            realized = float(group.realized_pnl.sum())
            implied_entry = exit_px + realized / q
            at = group.event_time.max()
            start = b.index.searchsorted(at.ceil('15min'))
            if start >= len(b): continue
            # Most recent fully closed bar at the actual exit.
            known_idx = b.index.searchsorted(at.floor('15min')) - 1
            active = {name: int(mask.iloc[known_idx]) for name, mask in hypotheses.items()
                      if known_idx >= 0 and mask.iloc[known_idx] != 0}
            item = {'symbol': sym, 'exitAt': str(at), 'exitPrice': exit_px,
                    'impliedShortBasis': implied_entry, 'realizedPnlBeforeFees': realized,
                    'knownScenariosAtExit': active, 'paths': []}
            for hours in [1, 4, 24, 72, 168]:
                end = b.index.searchsorted(at + pd.Timedelta(hours=hours))
                if end >= len(b): continue
                path = b.iloc[start:end]
                if path.empty or path.close.isna().any(): continue
                later_px = float(b.open.iloc[end])
                extra = (exit_px - later_px) / exit_px * 100
                cost = s.funding_cost(funding, at, b.index[end], implied_entry, b, -1)
                item['paths'].append({'hours': hours, 'priceAtHorizon': later_px,
                    'extraShortReturnPctBeforeCosts': extra,
                    'adverseRiseAfterExitPct': float(max(0, path.high.max() / exit_px - 1) * 100),
                    'worstLossFromBasisPct': float(max(0, path.high.max() / implied_entry - 1) * 100),
                    'shortReturnFromBasisPctBeforeCosts': float((implied_entry - later_px) / implied_entry * 100),
                    'incrementalFundingCostPctApprox': cost})
            results.append(item)
    (directory / 'journal-path-review.json').write_text(json.dumps(results, indent=2, allow_nan=False) + '\n')
    lines = ['# Private journal path review: September 24–October 7, 2026', '',
             'Observed counterfactuals, not instructions to hold or widen a stop. Futures prices and returns are unlevered.',
             'The reference basis is inferred from Binance realized P&L for each identifiable short-reducing order. Fees remain separate.',
             'Forward prices are sampled at the first 15-minute open after the requested time. Intrabar risk before that open is unobserved.',
             'October funding settlements were unavailable in the downloaded monthly archive; unknown funding stays null, not zero.', '',
             '| Asset | Exit UTC | Exit | Basis | P&L before fees | Extra short return at 24h | Adverse rise during 24h | Extra short return at 7d |',
             '|---|---|---:|---:|---:|---:|---:|---:|']
    for r in sorted(results, key=lambda x: x['exitAt']):
        p = {v['hours']: v for v in r['paths']}
        num = lambda h, field: f'{p[h][field]:+.2f}%' if h in p else 'unmatured'
        lines.append(f'| {r["symbol"]} | {r["exitAt"][:16]} | {r["exitPrice"]:.5g} | {r["impliedShortBasis"]:.5g} | {r["realizedPnlBeforeFees"]:+.2f} | '
                     f'{num(24, "extraShortReturnPctBeforeCosts")} | {num(24, "adverseRiseAfterExitPct")} | {num(168, "extraShortReturnPctBeforeCosts")} |')
    (directory / 'PRIVATE-JOURNAL-REVIEW.md').write_text('\n'.join(lines) + '\n')
    return results


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--data', default='reports/scenarios')
    args = ap.parse_args(); rows = review(args.data)
    print(f'Reviewed {len(rows)} short-closing orders; private report saved locally.')
