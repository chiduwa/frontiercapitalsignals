"""Conditional intraday event study; offline, no authority to notify or trade.

Fixed hypotheses, next-bar entry, real global-futures candles, recorded funding,
gaps rejected, nonoverlapping outcomes, calendar-aware sessions, multiplicity
correction, frozen holding selection, delayed-entry and cost stress tests.
Returns are unlevered percentages; MAE is adverse excursion, not a stop rule.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import numpy as np
import pandas as pd
from scipy.stats import t as student_t
import exchange_calendars as xcals

_spec = importlib.util.spec_from_file_location('scenario_data', Path(__file__).with_name('scenario-data.py'))
data = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(data)
STEP = pd.Timedelta(minutes=15)
HORIZONS = (1, 4, 16, 96, 288, 672)
SPLIT = pd.Timestamp('2025-06-01', tz='UTC')
TEST_MID = pd.Timestamp('2026-02-01', tz='UTC')
END = pd.Timestamp('2026-10-01', tz='UTC')
ROUND_TRIP_PCT = 0.20  # 10 bp fees + 10 bp total slippage; stress at 40 bp


def load_bars(directory, symbol):
    raw = data.read_archives(directory, 'klines', symbol)
    if raw.empty: return raw
    raw.index = pd.to_datetime(raw.open_time, unit='ms', utc=True)
    raw = raw[~raw.index.duplicated()].sort_index()
    bars = raw[['open', 'high', 'low', 'close', 'quote_volume', 'taker_buy_quote_volume']].apply(pd.to_numeric)
    valid = ((bars[['open', 'high', 'low', 'close']] > 0).all(axis=1)
             & (bars.high >= bars[['open', 'close', 'low']].max(axis=1))
             & (bars.low <= bars[['open', 'close', 'high']].min(axis=1))
             & (bars.quote_volume >= 0))
    bars.loc[~valid] = np.nan
    return bars.reindex(pd.date_range(bars.index.min(), bars.index.max(), freq='15min'))


def session_mask(index, calendar, edge):
    cal = xcals.get_calendar(calendar, start=str(index.min().date()), end=str(index.max().date()))
    boundary = pd.DatetimeIndex(cal.schedule[edge])
    # Information at the close of a bar, not its open. Half-days and DST
    # follow the exchange's actual schedule; holidays are absent.
    return pd.Series((index + STEP).isin(boundary), index=index)


def features(bars, metrics=None, funding=None):
    f = bars.copy()
    f['r1'] = f.close.pct_change(fill_method=None) * 100
    f['r4'] = f.close.pct_change(4, fill_method=None) * 100
    f['r8'] = f.close.pct_change(8, fill_method=None) * 100
    f['volumeRatio'] = f.quote_volume / f.quote_volume.shift(1).rolling(96, min_periods=96).median()
    f['efficiency'] = f.r1.rolling(8).sum().abs() / f.r1.abs().rolling(8).sum()
    f['quiet'] = f.quote_volume.rolling(8).mean() < 0.7 * f.quote_volume.shift(8).rolling(96).median()
    f['priorHigh'] = f.high.shift(1).rolling(96).max()
    f['priorLow'] = f.low.shift(1).rolling(96).min()
    f['takerShare'] = f.taker_buy_quote_volume / f.quote_volume.replace(0, np.nan)
    f['valid'] = f.close.notna().rolling(104).sum().eq(104)
    f['oiChange1h'] = np.nan
    if metrics is not None and not metrics.empty:
        m = metrics.copy()
        # A five-minute report is treated as available five minutes later.
        m.index = pd.to_datetime(m.create_time, utc=True) + pd.Timedelta(minutes=5)
        m = m[~m.index.duplicated()].sort_index()
        at = f.index + STEP
        oi = m.sum_open_interest.reindex(at, method='ffill', tolerance=pd.Timedelta(minutes=10))
        oi.index = f.index
        f['oiChange1h'] = oi.pct_change(4, fill_method=None) * 100
    f['funding8h'] = np.nan
    if funding is not None and not funding.empty:
        rates = funding.sort_values('calc_time').drop_duplicates('calc_time')
        rates.index = pd.to_datetime(rates.calc_time, unit='ms', utc=True)
        normalized = rates.last_funding_rate * 8 / rates.funding_interval_hours
        known = normalized.reindex(f.index + STEP, method='ffill', tolerance=pd.Timedelta(hours=9))
        f['funding8h'] = known.to_numpy()
    return f


def rules(f):
    """Direction is the proposed position side, never a future label."""
    out = {}
    spike_side = np.sign(f.r1.shift(2))
    spike = (f.volumeRatio.shift(2) >= 3) & (f.r1.shift(2).abs() >= 0.75)
    fade = (f.quote_volume < 0.7 * f.quote_volume.shift(2)) & (f.quote_volume.shift(1) < f.quote_volume.shift(2))
    persistence = (spike_side * f.r1 > 0) & (spike_side * f.r1.shift(1) > 0)
    out['volume_spike_fades_price_continues'] = spike_side.where(spike & fade & persistence, 0)
    drift = f.quiet & (f.efficiency >= 0.8) & f.r8.abs().between(0.4, 1.5)
    out['quiet_creep_continues'] = np.sign(f.r8).where(drift, 0)
    out['quiet_creep_then_volume_expands'] = np.sign(f.r8.shift(1)).where(
        drift.shift(1).fillna(False) & (f.volumeRatio >= 2)
        & (np.sign(f.r8.shift(1)) * f.r1 > 0), 0)
    # A close outside a prior range followed by a close back inside is a
    # confirmed failure. The rejection bar is fully over before entry.
    out['failed_upside_breakout_short'] = pd.Series(-1, index=f.index).where(
        (f.close.shift(1) > f.priorHigh.shift(1)) & (f.close < f.priorHigh.shift(1)), 0)
    out['failed_downside_breakout_long'] = pd.Series(1, index=f.index).where(
        (f.close.shift(1) < f.priorLow.shift(1)) & (f.close > f.priorLow.shift(1)), 0)
    for calendar, label in [('XNYS', 'new_york'), ('XLON', 'london')]:
        for edge in ['open', 'close']:
            mask = session_mask(f.index, calendar, edge) & (f.r4.abs() >= 1)
            out[f'{label}_{edge}_1pct_continue'] = np.sign(f.r4).where(mask, 0)
            out[f'{label}_{edge}_1pct_reverse'] = -out[f'{label}_{edge}_1pct_continue']
    move = f.r4.abs() >= 1
    for name, mask in [('oi_builds', f.oiChange1h >= 1), ('oi_unwinds', f.oiChange1h <= -1),
                       ('funding_crowded', np.sign(f.r4) * f.funding8h >= 0.0001),
                       ('funding_opposes', np.sign(f.r4) * f.funding8h <= -0.0001),
                       ('taker_confirms', np.sign(f.r4) * (f.takerShare - 0.5) >= 0.1)]:
        out[f'one_percent_move_{name}'] = np.sign(f.r4).where(move & mask, 0)
    return {name: side.where(f.valid, 0).fillna(0).astype(int) for name, side in out.items()}


def funding_cost(funding, entry_time, exit_time, entry_price, bars, side):
    if funding is None or funding.empty: return None
    ts = pd.to_datetime(funding.calc_time, unit='ms', utc=True)
    if entry_time < ts.min() or exit_time > ts.max(): return None
    rows = funding.loc[(ts >= entry_time) & (ts < exit_time)]
    if rows.empty: return 0.0
    # Quantity is fixed. Settlement notional varies with price; use the
    # corresponding 15m open as a mark-price approximation, documented.
    settle = pd.DatetimeIndex(pd.to_datetime(rows.calc_time, unit='ms', utc=True))
    prices = bars.open.reindex(settle.floor('15min')).to_numpy()
    if not np.isfinite(prices).all(): return None
    return float(side * np.sum(rows.last_funding_rate.to_numpy() * prices / entry_price) * 100)


def forward_paths(bars, h, funding):
    """Vectorized outcomes for every possible entry, independent of a rule."""
    index, px = bars.index, bars.open
    high = bars.high.iloc[::-1].rolling(h).max().iloc[::-1]
    low = bars.low.iloc[::-1].rolling(h).min().iloc[::-1]
    valid = bars.close.notna().iloc[::-1].rolling(h).sum().iloc[::-1].eq(h)
    exit_px = px.shift(-h)
    cash = np.full(len(bars), np.nan)
    if funding is not None and not funding.empty:
        rates = funding.sort_values('calc_time').drop_duplicates('calc_time')
        ts = pd.DatetimeIndex(pd.to_datetime(rates.calc_time, unit='ms', utc=True))
        mark = px.reindex(ts.floor('15min')).to_numpy()
        missing = np.r_[0, np.cumsum(~np.isfinite(mark))]
        cumulative = np.r_[0, np.cumsum(np.nan_to_num(mark) * rates.last_funding_rate.to_numpy())]
        a, b = ts.searchsorted(index), ts.searchsorted(index + h * STEP)
        cash = (cumulative[b] - cumulative[a]) / px.to_numpy() * 100
        known = (index >= ts.min()) & (index + h * STEP <= ts.max()) & (missing[b] == missing[a])
        cash[~known] = np.nan
        # Missing settlement files cannot be interpreted as free funding.
        intervals = rates.funding_interval_hours.to_numpy()
        for k in range(1, len(ts)):
            expected = max(intervals[k - 1], intervals[k])
            if ts[k] - ts[k - 1] > pd.Timedelta(hours=float(expected), minutes=5):
                gap_start = ts[k - 1] + pd.Timedelta(hours=float(expected))
                cash[(index < ts[k]) & (index + h * STEP > gap_start)] = np.nan
    result = pd.DataFrame({'grossLong': (exit_px / px - 1) * 100, 'cashLong': cash,
                         'up': (high / px - 1) * 100, 'down': (1 - low / px) * 100,
                         'valid': valid & px.gt(0) & exit_px.gt(0)}, index=index)
    # Descriptive matched control: same asset, side, weekday/hour and period,
    # all eligible entry bars, without the event filter. It is never a model
    # input. This prevents a long rule from claiming ordinary market drift
    # as evidence that its special condition improves an entry.
    era = np.where(index < SPLIT, 'train', np.where(index < TEST_MID, 'early', 'late'))
    for side, name in [(1, 'long'), (-1, 'short')]:
        net = (side * (result.grossLong - result.cashLong) - ROUND_TRIP_PCT).where(result.valid)
        control = net.groupby([era, index.dayofweek, index.hour]).transform('mean')
        result[f'{name}Excess'] = net - control
    return result


def event_rows(bars, side, h, funding, delay=0, paths=None):
    paths = forward_paths(bars, h, funding) if paths is None else paths
    out = []
    # First event wins while its outcome window is running, across BOTH sides.
    next_free = 0
    for i in np.flatnonzero(side.to_numpy()):
        entry = i + 1 + delay
        end = entry + h
        if entry < next_free or end >= len(bars): continue
        path = paths.iloc[entry]
        if not path.valid or not np.isfinite(path.cashLong): continue
        direction = int(side.iloc[i])
        gross, cost = direction * path.grossLong, direction * path.cashLong
        mae, mfe = (path.down, path.up) if direction > 0 else (path.up, path.down)
        out.append({'signalTime': bars.index[i] + STEP, 'entryTime': bars.index[entry], 'exitTime': bars.index[end],
                    'side': direction, 'gross': gross, 'net': gross - ROUND_TRIP_PCT - cost,
                    'excess': path.longExcess if direction > 0 else path.shortExcess,
                    'fundingCost': cost, 'mae': max(0, mae), 'mfe': max(0, mfe)})
        next_free = end
    return pd.DataFrame(out)


def stats(frame):
    if frame.empty: return {'n': 0, 'meanNet': None, 'p': 1.0}
    blocks = ((frame.entryTime - pd.Timestamp('2024-01-01', tz='UTC')).dt.days // 14)
    means = frame.groupby(blocks).net.mean()
    se = means.std(ddof=1) / np.sqrt(len(means)) if len(means) > 1 else np.nan
    p = float(student_t.sf(means.mean() / se, len(means) - 1)) if se > 0 else 1.0
    return {'n': len(frame), 'blocks': len(means), 'meanNet': float(frame.net.mean()),
            'winRate': float((frame.net > 0).mean()), 'medianMAE': float(frame.mae.median()),
            'p90MAE': float(frame.mae.quantile(0.9)), 'medianMFE': float(frame.mfe.median()),
            'meanFundingCost': float(frame.fundingCost.mean()),
            'blockLower95': float(means.mean() - student_t.ppf(0.975, len(means) - 1) * se) if se > 0 else None,
            'p': p}


def adjust_bh(rows):
    ordered = sorted(rows, key=lambda r: max(r['test']['p'], r['excessTest']['p']))
    q = 1.0
    for rank in range(len(ordered), 0, -1):
        row = ordered[rank - 1]
        q = min(q, max(row['test']['p'], row['excessTest']['p']) * len(ordered) / rank)
        row['q'] = q


def market_conditions(directory):
    """A fixed seven-coin reference basket; no current market-cap weights."""
    symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HBARUSDT', 'XRPUSDT', 'XLMUSDT', 'ARBUSDT']
    closes, volumes = {}, {}
    for sym in symbols:
        b = load_bars(directory, sym)
        if b.empty: raise ValueError(f'missing fixed market reference {sym}')
        closes[sym] = np.log(b.close).diff()
        volumes[sym] = b.quote_volume / b.quote_volume.shift(1).rolling(96).median()
    returns = pd.DataFrame(closes)
    volume = pd.DataFrame(volumes)
    full = returns.notna().all(axis=1) & volume.notna().all(axis=1)
    r = returns.mean(axis=1).where(full)
    r8 = np.expm1(r.rolling(8).sum()) * 100
    efficiency = r.rolling(8).sum().abs() / r.abs().rolling(8).sum()
    vol = volume.median(axis=1).where(full)
    creep = (efficiency >= 0.8) & r8.abs().between(0.3, 1.5) & (vol.rolling(8).mean() < 0.7)
    breadth = (returns > 0).mean(axis=1)
    return {
        'market_quiet_creep_continue': np.sign(r8).where(creep, 0).fillna(0).astype(int),
        'market_quiet_creep_volume_expands': np.sign(r8.shift(1)).where(
            creep.shift(1).fillna(False) & (vol >= 1.5) & (np.sign(r8.shift(1)) * r > 0), 0).fillna(0).astype(int),
        'market_one_percent_broad_move': np.sign(r8).where((r8.abs() >= 1)
            & (((r8 > 0) & (breadth >= .7)) | ((r8 < 0) & (breadth <= .3))), 0).fillna(0).astype(int)}


def study(directory, output_directory=None):
    directory = Path(directory)
    output_directory = Path(output_directory) if output_directory else directory
    output_directory.mkdir(parents=True, exist_ok=True)
    results, coverage, all_events = [], [], []
    market = market_conditions(directory)
    for folder in sorted((directory / 'raw' / 'klines').iterdir()):
        sym = folder.name
        bars = load_bars(directory, sym)
        if bars.empty: continue
        funding = data.read_archives(directory, 'fundingRate', sym)
        metrics = data.read_archives(directory, 'metrics', sym)
        f = features(bars, metrics, funding)
        masks = rules(f)
        masks.update({name: mask.reindex(f.index).where(f.valid, 0).fillna(0).astype(int) for name, mask in market.items()})
        paths_by_h = {h: forward_paths(bars, h, funding) for h in HORIZONS}
        coverage.append({'symbol': sym, 'bars': int(bars.close.notna().sum()), 'gaps': int(bars.close.isna().sum()),
                         'from': str(bars.index.min()), 'to': str(bars.index.max()),
                         'metricsRows': len(metrics), 'fundingRows': len(funding)})
        for name, mask in masks.items():
            for h in HORIZONS:
                events = event_rows(bars, mask, h, funding, paths=paths_by_h[h])
                delayed = event_rows(bars, mask, h, funding, delay=1, paths=paths_by_h[h])
                if events.empty: continue
                events['symbol'], events['rule'], events['horizonBars'] = sym, name, h
                all_events.append(events)
                for side in (-1, 1):
                    e = events[events.side == side]
                    train = e[e.exitTime < SPLIT]
                    test = e[(e.entryTime >= SPLIT) & (e.exitTime < END)]
                    delay_test = delayed[(delayed.side == side) & (delayed.entryTime >= SPLIT) & (delayed.exitTime < END)] if not delayed.empty else delayed
                    results.append({'symbol': sym, 'rule': name, 'side': side, 'horizonBars': h,
                                    'train': stats(train), 'test': stats(test), 'delay15m': stats(delay_test),
                                    'excessTest': stats(test.assign(net=test.excess)),
                                    'excessEarly': stats(test[test.entryTime < TEST_MID].assign(net=lambda x: x.excess)),
                                    'excessLate': stats(test[test.entryTime >= TEST_MID].assign(net=lambda x: x.excess)),
                                    'earlyTest': stats(test[test.entryTime < TEST_MID]),
                                    'lateTest': stats(test[test.entryTime >= TEST_MID])})
        print(sym, 'bars', coverage[-1]['bars'], 'tested cells', len(results), flush=True)
    adjust_bh(results)
    # A holding time is selected only on pre-split outcomes. The test never
    # chooses its own best exit. Sparse scenarios remain unselected.
    groups = {}
    for r in results:
        if r['train']['n'] >= 30:
            key = (r['symbol'], r['rule'], r['side'])
            if key not in groups or r['train']['meanNet'] > groups[key]['train']['meanNet']:
                groups[key] = r
    selected_ids = {id(r) for r in groups.values()}
    for r in results:
        r['selectedOnTrain'] = id(r) in selected_ids
        r['researchCandidate'] = bool(r['selectedOnTrain'] and r['q'] < 0.05 and r['test']['n'] >= 60
            and r['test'].get('blockLower95') is not None and r['test']['blockLower95'] > 0.20
            and all(r[k]['n'] >= 20 and r[k]['meanNet'] > 0.20 for k in ['earlyTest', 'lateTest', 'delay15m'])
            and all(r[k]['n'] >= 20 and r[k]['meanNet'] > 0 for k in ['excessEarly', 'excessLate']))
        r['actionable'] = False
    pd.concat(all_events, ignore_index=True).to_pickle(output_directory / 'scenario-events.pkl')
    result = {'version': 'conditional-scenarios-v1', 'actionable': False,
              'selectionEnds': str(SPLIT), 'testEnds': str(END), 'roundTripCostPct': ROUND_TRIP_PCT,
              'stressRoundTripCostPct': 0.40, 'coverage': coverage, 'tests': len(results),
              'researchCandidates': [r for r in results if r['researchCandidate']], 'results': results,
              'limits': ['Fixed present-day universe, not a survivorship-free market-wide claim.',
                         'Funding cashflows use 15m trade opens as a mark-price approximation.',
                         'OI archive availability here is too recent for the fixed training window.',
                         'Block tests screen associations, not causal effects; candidates need fresh forward evidence.',
                         'No protective stop is simulated; path excursions are required context, not permission to widen stops.']}
    (output_directory / 'scenario-results.json').write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
    return result


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--data', default='reports/scenarios')
    ap.add_argument('--out'); ap.add_argument('--split', default=str(SPLIT)); ap.add_argument('--test-mid', default=str(TEST_MID))
    args = ap.parse_args()
    SPLIT, TEST_MID = pd.Timestamp(args.split), pd.Timestamp(args.test_mid)
    if SPLIT.tzinfo is None: SPLIT = SPLIT.tz_localize('UTC')
    if TEST_MID.tzinfo is None: TEST_MID = TEST_MID.tz_localize('UTC')
    if not SPLIT < TEST_MID < END: raise ValueError('require split < test-mid < end')
    out = study(args.data, args.out)
    print('research candidates', len(out['researchCandidates']), 'of', out['tests'], flush=True)
