"""Local, cached long-history research inputs. No account access or cloud jobs.

Coin Metrics community files are attribution/noncommercial research inputs;
they are not added to the production data feed. Sources remain separate.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import urllib.request
import pandas as pd

END = pd.Timestamp('2026-10-08')  # exclude this incomplete UTC day
STOCKS = ['SPY', 'QQQ', 'TLT', 'GLD', 'UUP', 'AAPL', 'MSFT', 'NVDA', 'TSLA',
          'AMZN', 'META', 'AMD', 'HOOD', 'TQQQ', 'SQQQ', 'SOXL', 'NVDL',
          'TSLL', 'BITX', 'CONL', 'MSTU']


def cached(url, path, limit=25_000_000):
    if not path.exists():
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 FCS offline research'})
        with urllib.request.urlopen(req, timeout=30) as response: body = response.read(limit + 1)
        if len(body) > limit: raise ValueError('response exceeds local research budget')
        path.write_bytes(body)
    body = path.read_bytes()
    return {'url': url, 'file': path.name, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}


def download(directory):
    directory.mkdir(parents=True, exist_ok=True)
    jobs = []
    for sym in ['btc', 'eth', 'ltc', 'xrp', 'doge']:
        jobs.append((f'https://raw.githubusercontent.com/coinmetrics/data/master/csv/{sym}.csv', directory / f'coinmetrics-{sym}.csv'))
    for sym in STOCKS:
        url = (f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1d'
               f'&period1=946684800&period2={int(END.timestamp())}&includePrePost=false&events=div%2Csplits')
        jobs.append((url, directory / f'yahoo-{sym}.json'))
    for start in pd.date_range('2011-08-18', END, freq='1000D'):
        end = min(start + pd.Timedelta(days=999), END - pd.Timedelta(days=1))
        url = (f'https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=86400&limit=1000'
               f'&start={int(start.timestamp())}&end={int(end.timestamp())}')
        jobs.append((url, directory / f'bitstamp-BTC-{start.date()}.json'))
    if len(jobs) > 60: raise ValueError('request budget exceeded')
    with ThreadPoolExecutor(3) as pool:
        results = list(pool.map(lambda job: cached(*job), jobs))
    (directory.parent / 'daily-manifest.json').write_text(json.dumps(results, indent=2) + '\n')
    print(f'{len(results)} cached/public requests; {sum(r["bytes"] for r in results):,} bytes', flush=True)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--out', default='reports/scenarios/cycles/raw')
    args = ap.parse_args(); download(Path(args.out))
