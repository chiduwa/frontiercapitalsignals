"""Publish compact, account-free long-cycle evidence; raw/private data stays local."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import numpy as np
import pandas as pd

sp = importlib.util.spec_from_file_location('cycles', Path(__file__).with_name('cycle-research.py'))
c = importlib.util.module_from_spec(sp); sp.loader.exec_module(c)
CORE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HBARUSDT']


def adjust_family(direction, volatility):
    family = []
    for target, result in [('direction', direction), ('variance', volatility)]:
        for row in result['results']:
            if row['model'] in ['season', 'cycle', 'combined', 'interaction']:
                row['target'] = target; family.append(row)
    family.sort(key=lambda r: r['p']); adjusted = 0.
    for i, r in enumerate(family):
        adjusted = max(adjusted, min(1., (len(family)-i) * r['p']))
        r['jointHolmP'] = adjusted
        robust = [x for x in r['cycles'] if x['halvingYear'] > 0 and x['n'] >= 180]
        gains = ['gainVsBase', 'gainVsRecentBase', 'gainVsState'] if r['target'] == 'direction' else ['gainVs_base', 'gainVs_ewma', 'gainVs_state']
        baselines = ['vsBase', 'vsRecentBase', 'vsState'] if r['target'] == 'direction' else ['vs_base', 'vs_ewma', 'vs_state']
        r['historicalCandidate'] = bool(adjusted < .05 and len(robust) >= 2 and
            all(x[k] > 0 for x in robust for k in gains) and
            all(r[k]['lower95'] is not None and r[k]['lower95'] > 0 for k in baselines))
        r['actionable'] = False
    return family


def intraday_context(root):
    source = root / 'long-history' / 'scenario-events.pkl'
    # This is our local generated research artifact, never an untrusted pickle.
    events = pd.read_pickle(source)
    events = events[events.symbol.isin(CORE) & events.horizonBars.isin([4, 16, 96]) &
        events.rule.isin(['volume_spike_fades_price_continues', 'quiet_creep_continues',
                         'failed_upside_breakout_short', 'failed_downside_breakout_long'])].copy()
    output = []
    for asset, rows in events.groupby('symbol'):
        bars = c.scenario.load_bars(root, asset)
        daily = bars.close.resample('1D').last().where(bars.close.resample('1D').count() == 96)
        daily.index = daily.index.tz_localize(None)
        prior_date = pd.DatetimeIndex(rows.signalTime).tz_localize(None).normalize() - pd.Timedelta(days=1)
        cycle = c.cycle_features(prior_date)
        rows['halvingYear'] = cycle.cycleId.to_numpy()
        rows['calendarQuarter'] = prior_date.quarter
        trend = (daily / daily.rolling(200).mean() - 1).reindex(prior_date).to_numpy()
        rows['priorTrend'] = np.where(np.isnan(trend), 'unknown', np.where(trend > 0, 'above200d', 'below200d'))
        for keys, e in rows.groupby(['rule', 'side', 'horizonBars', 'halvingYear', 'calendarQuarter', 'priorTrend']):
            output.append({'symbol': asset, **dict(zip(['rule', 'side', 'horizonBars', 'halvingYear', 'calendarQuarter', 'priorTrend'], keys)),
              'n': len(e), 'meanNetPct': float(e.net.mean()), 'positiveFraction': float(e.net.gt(0).mean()),
              'adverse90Pct': float(e.mae.quantile(.9)), 'actionable': False})
    return output


def report(root, out):
    direction = json.loads((root/'cycles/cycle-results.json').read_text())
    volatility = json.loads((root/'cycles/volatility-results.json').read_text())
    scenarios = json.loads((root/'long-history/scenario-results.json').read_text())
    family = adjust_family(direction, volatility)
    candidates = [r for r in family if r['historicalCandidate']]
    out.mkdir(parents=True, exist_ok=True)
    # All public output is sourced exclusively from market/research artifacts.
    manifest_hashes = {name: hashlib.sha256((root/name).read_bytes()).hexdigest()
                       for name in ['manifest.json', 'cycles/daily-manifest.json']}
    public = {'version': 'long-cycle-review-v1', 'actionable': False, 'coverage': direction['coverage'],
      'protocol': direction['protocol'], 'jointHypotheses': len(family), 'jointCorrection': 'Holm family-wise',
      'manifestSha256': manifest_hashes, 'historicalCandidates': candidates,
      'direction': direction['results'], 'variance': volatility['results'],
      'seasonality': direction['seasonality'], 'latestContext': direction['latestContext'],
      'longIntraday': {k: scenarios[k] for k in ['coverage', 'selectionEnds', 'testEnds', 'tests', 'researchCandidates']},
      'limits': direction['limits'] + volatility['limits']}
    (out/'cycle-summary.json').write_text(json.dumps(public, indent=2, allow_nan=False)+'\n')
    contexts = intraday_context(root)
    (out/'intraday-cycle-context.json').write_text(json.dumps({'actionable': False,
        'purpose': 'Descriptive context only; no cell selected as a live rule; no causal claim.',
        'conditioning': 'Prior completed UTC-day trend and halving state, calendar quarter at signal; future outcomes are labels only.',
        'limits': 'Sparse cells, overlapping outcomes across horizons/rules, current survivor universe; do not treat cell means as forecasts.',
        'cells': contexts}, indent=2, allow_nan=False)+'\n')
    (out/'source-manifest.json').write_text((root/'cycles/daily-manifest.json').read_text())
    md = ['# Cycles, seasonality and longer-history research — October 8, 2026', '',
          f'**{len(candidates)} historical candidates passed the joint screen across {len(family):,} cycle/seasonality comparisons.** '
          'No cycle rule is authorized to alter live forecasts, alerts, orders, leverage, stops or holding periods.', '',
          'This extends the earlier study; it does not assume that a four-year price pattern must repeat. '
          'Bitcoin has a block-subsidy halving schedule. A recurring price cycle is a separate empirical hypothesis.', '',
          '![Observed Bitcoin cycles; no future price path](bitcoin-cycles.png)', '',
          '## Actual history available', '',
          '| Series | First observation | Last observation | Valid daily prices |', '|---|---|---|---:|']
    for r in direction['coverage']:
        md.append(f'| {r["asset"]} | {r["from"]} | {r["to"]} | {r["rows"]:,} |')
    md += ['', 'Coin Metrics and Bitstamp are independent data-source cross-checks of the same Bitcoin market, '
           'not independent market cycles. Their series are not spliced. Coin Metrics community price archives '
           'available in this run stop in May 2026; Binance/Bitstamp/reference equities continue into October. '
           'Younger assets cannot supply cycles before their listing. The stock/ETF history includes market proxies '
           'and Robinhood-relevant instruments; it is not a claim about account-specific eligibility or executable prices.', '',
           '## Predeclared model comparison', '',
           '- Expanding history; refit once per quarter. At least 730 fully observed training outcomes after the feature warm-up. '
           'Labels maturing on or after the fit date are excluded. No random train/test shuffle.',
           '- Forecast 1, 7, 30 and 90 calendar days for crypto, or sessions for stocks. Research entry is the next observed close, '
           'so the close used to form a feature cannot also be its assumed entry fill.',
           '- State model: prior price momentum, 200-period trend, drawdown and volatility, plus lagged BTC, stock, bond, gold and dollar proxies.',
           '- Add annual/weekly seasonality, phase since the last known halving, both together, or their interactions with trend and volatility. '
           'The 1,461-day phase is a fixed hypothesis; the realized next halving date and future peaks/troughs are never inputs.',
           '- Direction: regularized logistic regression (fixed C=0.01), compared with expanding and recent base rates and the state model. '
           'Volatility: ridge regression of future log realized variance (fixed alpha=100), training-only retransformation, compared with '
           '30-period realized variance, an EWMA and the state model. Score uncapped QLIKE, not a more convenient capped objective.',
           '- Train-only imputation/scaling. Additional full-day lag for reference markets. Missing crypto holding paths are rejected. '
           'No Bitcoin phase is invented before genesis.',
           '- Paired 90-day blocks (180 days for 90-period forecasts), joint Holm correction over both targets, every tested source, asset, '
           'feature set and horizon. Also require positive gains over all three comparators in every adequately represented halving era '
           '(at least two eras, at least 180 predictions each). Block statistics are approximate diagnostics, not a trading guarantee.', '',
           '## Results for the core assets', '',
           'Positive values below mean lower loss than the state-only model. They are descriptive averages; '
           'a positive cell alone does not pass the joint gate.', '',
           '| Asset/source | Horizon | Seasonality Brier gain | Cycle Brier gain | Combined Brier gain | Interaction Brier gain |',
           '|---|---:|---:|---:|---:|---:|']
    for asset in ['CM_BTC', 'BITSTAMP_BTC', 'CM_ETH', 'BINANCE_BTC', 'BINANCE_ETH', 'BINANCE_SOL', 'BINANCE_HBAR']:
        for h in c.HORIZONS:
            rr = {r['model']: r for r in direction['results'] if r['asset']==asset and r['horizon']==h}
            if not rr: continue
            vals = ' | '.join(f'{rr[n]["vsState"]["gain"]:+.5f}' for n in ['season','cycle','combined','interaction'])
            md.append(f'| {asset} | {h} | {vals} |')
    md += ['', 'Full per-asset direction, calibration-loss, volatility, per-era and annual results are in `cycle-summary.json`. '
           'Monthly return tables show how the same calendar month varies between eras; those tables are descriptive and were not '
           'used to select a favorable month or adjust a forecast. `latestContext` records observed trend/volatility and halving age, '
           'not an instruction to buy, sell or hold.', '', '## Longer intraday scenarios', '',
           f'The Binance Global extension contains **{sum(r["bars"] for r in scenarios["coverage"]):,} valid 15-minute candles**, '
           f'**{len(scenarios["coverage"])} contracts** and **{scenarios["tests"]:,} rule/side/horizon cells**. '
           'Holding times are selected on outcomes before January 2023, then examined in January 2023–December 2024 and '
           'January 2025–September 2026. The thresholds remain the same as the original study. '
           f'**{len(scenarios["researchCandidates"])} rules cleared the full cost, delay, evidence and stability gate.**', '',
           '`intraday-cycle-context.json` breaks the BTC/ETH/SOL/HBAR volume-fade, quiet-drift and failed-breakout observations '
           'down by previously known halving era, season and prior 200-day trend, at 1h/4h/24h. Sparse cells stay descriptive. '
           'This is a historical robustness extension, not a new untouched holdout: some later data was already examined in the first study.', '',
           'Historical OI and funding are not interchangeable with prices. Funding cashflows are included where known in the futures '
           'event study; the downloaded OI window remains June–October 2026 and cannot validate an OI rule across cycles. '
           'No missing OI values are fabricated. Stocks do not inherit crypto funding assumptions.', '',
           '## Implication for forecasts and holding periods', '',
           'Longer history supplies a better rejection test and shows regime dependence. It does not supply enough independent '
           'four-year cycles to justify a deterministic cycle clock. Calendar or halving context must earn incremental skill over '
           'current market conditions before it changes a forecast. The same requirement applies per asset and per horizon. '
           'A short that eventually profits can still suffer an intervening squeeze or liquidation; these daily scores do not '
           'replace the journal path review or justify increasing risk or removing exits.', '',
           'There are only **three completed intervals between the four observed halvings** (2012–2016, 2016–2020, 2020–2024). '
           'The 2024 interval is incomplete. More daily observations do not create more independent cycles. Present-day survivor '
           'selection, historical data revisions and very different early Bitcoin liquidity limit generalization. '
           'These models have not been compared prospectively with the actual live FCS output; passing a historical screen would '
           'only justify a frozen challenger collecting future evidence.', '',
           '## Cost and reproduction', '',
           'Local research only: cached public data, no new Cloudflare schedule, D1 schema/write, paid subscription, neural inference '
           'service or production model. The daily extension uses 32 requests/cache hits; the older futures backfill uses 1,664 '
           'requests/cache hits, with unavailable pre-listing archives recorded. Cached archives are reused and checksum manifests '
           'are preserved across backfills. No account journal data is included in this report.', '',
           'From `signals-worker/`, with an isolated environment:', '', '```sh',
           'python -m pip install -r scripts/cycle-requirements.txt',
           'python scripts/scenario-data.py',
           "python scripts/scenario-data.py --start 2019-09 --end 2023-12-31 --metrics-symbols ''",
           'python scripts/cycle-data.py',
           'python -m unittest test-cycle-research.py test-scenario-research.py',
           'OPENBLAS_NUM_THREADS=1 python scripts/cycle-research.py',
           'OPENBLAS_NUM_THREADS=1 python scripts/cycle-volatility.py',
           'python scripts/scenario-research.py --out reports/scenarios/long-history --split 2023-01-01 --test-mid 2025-01-01',
           'python scripts/cycle-report.py', 'python scripts/cycle-plot.py', '```', '',
           '## Sources', '',
           '- [Bitcoin halving dates and block-based schedule](https://bitcoin.org/en/halving)',
           '- [Binance public market-data archives](https://github.com/binance/binance-public-data)',
           '- [Bitstamp public OHLC API](https://www.bitstamp.net/api/)',
           '- [Coin Metrics community archives and data license](https://github.com/coinmetrics/data) — used as noncommercial research inputs, not added to the production feed.',
           '- Yahoo chart reference prices; exact requests and downloaded-file SHA-256 values are in `source-manifest.json`.',
           '- [scikit-learn logistic regression](https://scikit-learn.org/stable/modules/generated/sklearn.linear_model.LogisticRegression.html)', '']
    (out/'README.md').write_text('\n'.join(md))
    print('Joint hypotheses', len(family), 'historical candidates', len(candidates), 'intraday context cells', len(contexts))


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--data', default='reports/scenarios')
    ap.add_argument('--out', default='docs/research-2026-10-08-cycles')
    a = ap.parse_args(); report(Path(a.data), Path(a.out))
