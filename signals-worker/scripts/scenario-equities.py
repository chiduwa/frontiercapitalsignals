"""Recent US-stock/ETF scenario audit for the Robinhood watchlist.

Yahoo 15m data is reference-market data, NOT a Robinhood execution feed.
Limited recent history is expressly insufficient for promoting a rule.
Regular-session horizons never jump an overnight closure or missing candle.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import urllib.request
import numpy as np
import pandas as pd

sp = importlib.util.spec_from_file_location('scenario', Path(__file__).with_name('scenario-research.py'))
s = importlib.util.module_from_spec(sp); sp.loader.exec_module(s)
SYMBOLS = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'META', 'AMD', 'HOOD',
           'TQQQ', 'SQQQ', 'SOXL', 'NVDL', 'TSLL', 'BITX', 'CONL', 'MSTU']


def fetch(symbol, directory):
    path = directory / f'{symbol}.json'
    if not path.exists():
        url = f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=15m&range=60d&includePrePost=false'
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 FCS research'})
            with urllib.request.urlopen(request, timeout=20) as response: path.write_bytes(response.read(5_000_000))
        except OSError as e: return {'symbol': symbol, 'error': str(e)}
    try:
        raw = json.loads(path.read_text())['chart']['result'][0]
        index = pd.to_datetime(raw['timestamp'], unit='s', utc=True)
        b = pd.DataFrame(raw['indicators']['quote'][0], index=index)[['open', 'high', 'low', 'close', 'volume']]
        # Keep completed candles only; no current forming bar in a backtest.
        b = b[b.index + s.STEP <= pd.Timestamp.now(tz='UTC')]
        b = b[~b.index.duplicated()].sort_index()
        b['quote_volume'] = b.volume * b.close
        b['taker_buy_quote_volume'] = np.nan
        f = s.features(b)
        for k, n in [('r1', 1), ('r4', 4), ('r8', 8)]:
            f[k] = f[k].where(pd.Series(b.index, index=b.index).diff(n) == n * s.STEP)
        signals = s.rules(f)
        cells = []
        for name, side in signals.items():
            for h in [1, 4, 16]:
                p = s.forward_paths(b, h, pd.DataFrame())
                p['cashLong'] = 0.0  # stocks have no perp funding; short borrow is UNKNOWN
                p['valid'] &= pd.Series(b.index, index=b.index).shift(-h) - b.index == h * s.STEP
                events = s.event_rows(b, side, h, None, paths=p)
                for direction in [-1, 1]:
                    e = events[events.side == direction] if not events.empty else events
                    if not e.empty:
                        cells.append({'rule': name, 'side': direction, 'minutes': h * 15,
                                      'stats': s.stats(e), 'actionable': False})
        return {'symbol': symbol, 'bars': len(b), 'from': str(b.index.min()), 'to': str(b.index.max()),
                'actionable': False, 'results': cells}
    except (KeyError, TypeError, ValueError) as e:
        return {'symbol': symbol, 'error': str(e), 'actionable': False}


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--out', default='reports/scenarios')
    a = ap.parse_args(); root = Path(a.out); directory = root / 'equities'; directory.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(3) as pool: results = list(pool.map(lambda sym: fetch(sym, directory), SYMBOLS))
    out = {'actionable': False, 'limits': ['60 calendar days cannot validate durable asset-specific rules.',
           'Reference-market candles; Robinhood quotes, spreads and fills can differ.',
           'Short borrow, availability and leveraged-ETF holding costs are not modeled; no short permission inferred.',
           'Stock volume is shares times close, an approximation to quote volume.',
           'No extended-hours inference or overnight interpolation.'], 'assets': results}
    (root / 'equity-scenarios.json').write_text(json.dumps(out, indent=2, allow_nan=False) + '\n')
    for r in results: print(r['symbol'], r.get('bars', 0), 'bars', len(r.get('results', [])), 'cells', r.get('error', ''))
