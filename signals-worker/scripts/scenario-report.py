"""Compact, public research report. Never reads the private account journal."""
import argparse
import importlib.util
import json
from pathlib import Path
import pandas as pd

sp = importlib.util.spec_from_file_location('scenario', Path(__file__).with_name('scenario-research.py'))
s = importlib.util.module_from_spec(sp); sp.loader.exec_module(s)


def report(directory, output):
    directory, output = Path(directory), Path(output)
    output.mkdir(parents=True, exist_ok=True)
    results = json.loads((directory / 'scenario-results.json').read_text())
    equities = json.loads((directory / 'equity-scenarios.json').read_text())
    events = pd.read_pickle(directory / 'scenario-events.pkl')
    events = events[(events.entryTime >= s.SPLIT) & (events.exitTime < s.END)]
    pooled = []
    for (rule, direction, h), g in events.groupby(['rule', 'side', 'horizonBars']):
        # Collapse correlated coins on an entry date before uncertainty. The
        # stats() layer then collapses dates into 14-day blocks.
        byday = g.groupby(g.entryTime.dt.floor('D')).agg(
            net=('net', 'mean'), excess=('excess', 'mean'), mae=('mae', 'mean'),
            mfe=('mfe', 'mean'), fundingCost=('fundingCost', 'mean')).reset_index()
        pooled.append({'rule': rule, 'side': int(direction), 'minutes': int(h * 15),
                       'events': len(g), 'assets': int(g.symbol.nunique()),
                       'test': s.stats(byday), 'excessTest': s.stats(byday.assign(net=byday.excess))})
    s.adjust_bh(pooled)
    core = [r for r in results['results'] if r['symbol'] in ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HBARUSDT']
            and r['horizonBars'] in [4, 96] and r['test']['n'] > 0]
    compact = {'version': results['version'], 'actionable': False, 'coverage': results['coverage'],
               'tests': results['tests'], 'researchCandidates': results['researchCandidates'],
               'pooled': pooled, 'coreAssets': core,
               'equityCoverage': [{k: r.get(k) for k in ['symbol', 'bars', 'from', 'to', 'error']} for r in equities['assets']]}
    (output / 'scenario-summary.json').write_text(json.dumps(compact, indent=2, allow_nan=False) + '\n')
    lines = ['# Conditional market and asset scenarios — October 8, 2026', '',
        'The [longer-history extension](../research-2026-10-08-cycles/README.md) preserves this first run and adds '
        'earlier Binance history, cycle/season/regime breakdowns, and separate daily direction/volatility models using BTC history from 2010.', '',
        '**Decision: keep every new scenario research-only. No new alert, entry, or holding rule is authorized by these results.**', '',
        f'Tested {results["tests"]:,} asset/rule/side/horizon cells on {sum(r["bars"] for r in results["coverage"]):,} '
        f'15-minute Binance Global USDⓈ-M futures candles across {len(results["coverage"])} contracts, '
        f'{min(r["from"] for r in results["coverage"])[:10]}–{max(r["to"] for r in results["coverage"])[:10]}. '
        f'{len(results["researchCandidates"])} cells passed the full research gate. Also inspected {sum(r.get("bars", 0) for r in equities["assets"]):,} '
        f'recent regular-session candles across {len(equities["assets"])} US stocks/ETFs relevant to Robinhood. '
        'That 60-day equity sample cannot validate persistent per-asset rules.', '',
        '## Fixed scenarios', '',
        '- A ≥0.75% 15-minute move with ≥3× prior-day median volume; two more closes in the same direction while volume falls below 70% of the spike.',
        '- Two hours of 0.4–1.5% directional drift, ≥80% path efficiency, volume below 70% of the earlier-day median; continuation and subsequent ≥2× volume expansion.',
        '- A close beyond the previous 24-hour high/low followed by a close back inside: failed upside breakout short / failed downside breakout long. The rejection must already be observed.',
        '- A ≥1% prior-hour move at the actual New York/London open or close; both continuation and reversal, with holidays, half-days and DST.',
        '- A ≥1% prior-hour move with rising/falling open-interest quantity, crowded/opposing funding, or confirming taker flow.',
        '- A fixed seven-coin reference basket creeping on quiet volume, accelerating in volume, or moving broadly by ≥1%. This is a basket proxy, not all of crypto.', '',
        '## Method and limits', '',
        'Conditions use completed bars only. Enter at the next bar open, then repeat with 15 minutes of delay. '
        'Test 15m, 1h, 4h, 24h, 72h and 7d. Outcomes cannot overlap within an asset/rule/horizon. '
        'Subtract 20 bp round-trip fees/slippage, stress at 40 bp, and apply actual funding settlements '
        '(15-minute trade price approximates settlement mark). Missing bars and missing funding coverage abstain.', '',
        'Choose each asset/rule/side holding horizon using outcomes ending before June 1, 2025. Evaluate June 1, 2025–September 30, 2026, '
        'also split at February 1, 2026. Compare with the same asset/side/hour/weekday without the scenario filter; this matched '
        'control measures association, not causation. Use 14-day blocks for uncertainty and BH correction across all tested cells. '
        'Require positive performance in both halves, ≥60 test events, ≥20 events per half, delay resilience and the higher cost stress. '
        'The gate is an offline screen; even a pass would still need new forward outcomes.', '',
        'Current asset selection has survivorship bias. Recent OI covers only June–October 2026 for BTC/ETH/SOL/HBAR, '
        'so OI scenarios have no pre-June-2025 training sample and cannot earn a frozen holding choice. '
        'Funding sign uses the last observed settlement, not an unknowable future fee. Equities lack historical short-borrow/execution costs; '
        'their rows confer no permission to short on Robinhood. Stops, liquidation and portfolio interactions are not simulated in these strategy returns. '
        'A later profitable exit does not establish that the path was survivable.', '',
        '## One-hour volume-fade continuation, per core asset', '',
        'Net returns below are unlevered percentages after modeled costs. These are descriptive test-period results, not recommendations.', '',
        '| Asset | Side | Events | Mean net | Mean above matched control | 90th-percentile adverse move |',
        '|---|---|---:|---:|---:|---:|']
    for r in core:
        if r['rule'] == 'volume_spike_fades_price_continues' and r['horizonBars'] == 4:
            lines.append(f'| {r["symbol"]} | {"long" if r["side"] > 0 else "short"} | {r["test"]["n"]} | '
                f'{r["test"]["meanNet"]:+.3f}% | {r["excessTest"]["meanNet"]:+.3f}% | {r["test"]["p90MAE"]:.3f}% |')
    lines += ['', '## Holding duration and traps', '',
        'The tested failed-breakout, funding, OI and volume conditions do not justify a blanket “hold shorts longer” rule. '
        'The report retains 15m–7d forward returns, funding, maximum favorable excursion and maximum adverse excursion for every event. '
        'Historical failed breakouts can fail again: a re-entry short can still suffer a larger squeeze. '
        'Use the private journal report to distinguish each entry basis, partial exit and observed liquidation level; it is intentionally excluded from this public research artifact.', '',
        '## Reproduce and cost', '',
        'Install `scripts/scenario-requirements.txt` in a research environment. From `signals-worker`:', '', '```bash',
        'python scripts/scenario-data.py', 'python test-scenario-research.py',
        'python scripts/scenario-research.py', 'python scripts/scenario-equities.py',
        'python scripts/scenario-report.py', '```', '',
        'Downloads are cached locally, with a 2,500-request ceiling and six download threads. No new Cloudflare storage, '
        'cron, paid API, or production inference has been added. The first run used 1,684 archive requests (1,652 available). '
        'Raw bars, full outcomes and account data remain in ignored `reports/scenarios/`; only the compact research report is versioned.', '',
        '## Sources', '',
        '- [Binance public archive, formats and venues](https://github.com/binance/binance-public-data). These futures candles are Binance Global, not Binance.US.',
        '- [Binance futures market data, OI and funding](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data). OI quantity avoids confusing a price rise with new contracts.',
        '- [Robinhood crypto availability](https://robinhood.com/us/en/support/articles/coin-availability/). Availability depends on account/jurisdiction; no account access was inferred.',
        '- [NYSE hours and calendar](https://www.nyse.com/markets/hours-calendars) and [exchange_calendars](https://github.com/gerrymanoim/exchange_calendars).',
        '- [CoinMarketCap OHLCV documentation](https://coinmarketcap.com/api/documentation/pro-api-reference/cryptocurrency). CMC is useful for aggregate context; exchange-specific execution/volume and funding come from Binance. No paid CMC history was purchased.']
    (output / 'README.md').write_text('\n'.join(lines) + '\n')
    return compact


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--data', default='reports/scenarios')
    ap.add_argument('--out', default='docs/research-2026-10-08-scenarios')
    a = ap.parse_args(); r = report(a.data, a.out)
    print('Report saved;', len(r['pooled']), 'pooled rule/side/horizon comparisons.')
