"""Bounded, resumable local download of Binance GLOBAL futures research data.

No API keys, orders, D1 writes, scheduler, or paid feed. Archives retain the
actual contract symbol (including 1000 prefixes). Missing files are recorded,
never silently replaced with Binance.US or another venue.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path
import time
import urllib.error
import urllib.request
import zipfile
import pandas as pd

BASE = 'https://data.binance.vision/data/futures/um'
KLINE_COLUMNS = ['open_time', 'open', 'high', 'low', 'close', 'volume', 'close_time',
                 'quote_volume', 'count', 'taker_buy_volume', 'taker_buy_quote_volume', 'ignore']


def validate_archive(data):
    if len(data) > 8_000_000: raise ValueError('archive exceeds size budget')
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        if sum(x.file_size for x in z.infolist()) > 50_000_000: raise ValueError('expanded archive too large')
        if z.testzip(): raise ValueError('corrupt archive')


def fetch_archive(job, directory):
    kind, symbol, period, daily = job
    interval = '/15m' if kind == 'klines' else ''
    label = '15m' if kind == 'klines' else kind
    url = f'{BASE}/{"daily" if daily else "monthly"}/{kind}/{symbol}{interval}/{symbol}-{label}-{period}.zip'
    dest = directory / 'raw' / kind / symbol / f'{period}.zip'
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        data = dest.read_bytes()
        validate_archive(data)
    else:
        data = None
        for attempt in range(3):
            try:
                request = urllib.request.Request(url, headers={'User-Agent': 'FCS-scenario-research'})
                with urllib.request.urlopen(request, timeout=20) as response:
                    candidate = response.read(8_000_001)
                validate_archive(candidate)
                data = candidate
                dest.write_bytes(data)
                break
            except urllib.error.HTTPError as error:
                if error.code == 404: break
                if error.code in (403, 451):
                    return {'url': url, 'status': f'HTTP {error.code}', 'path': str(dest)}
                time.sleep(attempt + 1)
            except (OSError, ValueError, zipfile.BadZipFile):
                time.sleep(attempt + 1)
    return {'url': url, 'status': 'ok' if data else 'unavailable', 'path': str(dest),
            'sha256': hashlib.sha256(data).hexdigest() if data else None,
            'bytes': len(data) if data else 0}


def jobs(symbols, first, end, metrics_symbols, metrics_start):
    end = pd.Timestamp(end)
    for symbol in symbols:
        for month in pd.period_range(first, end, freq='M'):
            if month.end_time.date() <= end.date():
                yield 'klines', symbol, str(month), False
                yield 'fundingRate', symbol, str(month), False
            else:
                for date in pd.date_range(month.start_time, end, freq='D'):
                    yield 'klines', symbol, str(date.date()), True
        for date in pd.date_range(metrics_start, end, freq='D'):
            if symbol in metrics_symbols:
                yield 'metrics', symbol, str(date.date()), True


def read_archives(directory, kind, symbol):
    parts = []
    for path in sorted((Path(directory) / 'raw' / kind / symbol).glob('*.zip')):
        with zipfile.ZipFile(path) as z:
            frame = pd.read_csv(z.open(z.namelist()[0]))
            # Binance's older futures candles have no header. Do not discard
            # their first observation or interpret a timestamp as a column.
            if kind == 'klines' and 'open_time' not in frame:
                frame = pd.read_csv(z.open(z.namelist()[0]), header=None, names=KLINE_COLUMNS)
            parts.append(frame)
    return pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--symbols', default='BTCUSDT,ETHUSDT,SOLUSDT,HBARUSDT,XRPUSDT,XLMUSDT,ARBUSDT,HYPEUSDT,BNBUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,SUIUSDT,AAVEUSDT,ZECUSDT')
    ap.add_argument('--start', default='2024-01')
    ap.add_argument('--end', default='2026-10-07')
    ap.add_argument('--metrics-symbols', default='BTCUSDT,ETHUSDT,SOLUSDT,HBARUSDT')
    ap.add_argument('--metrics-start', default='2026-06-01')
    ap.add_argument('--out', default='reports/scenarios')
    a = ap.parse_args()
    directory = Path(a.out); directory.mkdir(parents=True, exist_ok=True)
    work = list(jobs(a.symbols.split(','), a.start, a.end, a.metrics_symbols.split(','), a.metrics_start))
    if len(work) > 2500: raise ValueError('request budget exceeded; split the research explicitly')
    results = []
    with ThreadPoolExecutor(max_workers=6) as pool:
        for row in pool.map(lambda job: fetch_archive(job, directory), work):
            results.append(row)
            if len(results) % 100 == 0: print(f'{len(results)}/{len(work)} archives; {sum(r["status"] == "ok" for r in results)} available', flush=True)
    manifest = directory / 'manifest.json'
    previous = json.loads(manifest.read_text()) if manifest.exists() else []
    combined = {r['url']: r for r in previous}
    combined.update({r['url']: r for r in results})
    manifest.write_text(json.dumps(list(combined.values()), indent=2) + '\n')
    print(f'Complete: {len(results)} requests/cache hits, {sum(r["status"] == "ok" for r in results)} available', flush=True)
