"""Spot 1h bars, 2022-11 .. 2026-10-13, for every Binance USDT spot pair, delisted ones included.

Delisted pairs matter here: a study of "which exhaustion coins keep rising" run only on
coins that still trade today is conditioned on survival. Monthly archive files are
listed per symbol (S3 listing) so no request is wasted on months a coin did not trade;
October 2026 comes from the REST mirror for pairs still listed. Zips are parsed in
memory and never written (the disk is nearly full).

Output: RAW/spot1h/<SYM>.parquet (open_time ms, OHLC, quote_volume, count, taker_buy_quote_volume)
        RAW/symbols.json  {sym: listed_now}
"""
import io, json, os, re, sys, time, zipfile, urllib.request, urllib.error
import concurrent.futures as cf
import numpy as np, pandas as pd

RAW = os.environ.get('RAW', os.path.join(os.path.dirname(__file__), '../../reports/scenarios/2026-10-14-followthrough/raw'))
OUT = os.path.join(RAW, 'spot1h')
os.makedirs(OUT, exist_ok=True)
UA = {'User-Agent': 'Mozilla/5.0 FCS research'}
COLS = ['open_time', 'open', 'high', 'low', 'close', 'volume', 'close_time', 'quote_volume', 'count',
        'taker_buy_volume', 'taker_buy_quote_volume', 'ignore']
KEEP = ['open_time', 'open', 'high', 'low', 'close', 'quote_volume', 'count', 'taker_buy_quote_volume']
FIRST, LAST = '2022-11', '2026-09'


def get(url, raw=False, tries=5):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                b = r.read()
                return b if raw else json.loads(b)
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                return None
            time.sleep(2 * (i + 1))
        except Exception:
            time.sleep(2 * (i + 1))
    return None


def listing(prefix):
    keys, marker = [], ''
    while True:
        x = get('https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?prefix=' + prefix
                + ('&marker=' + marker if marker else ''), raw=True)
        if x is None:
            return keys
        ks = re.findall(r'<Key>([^<]+\.zip)</Key>', x.decode())
        keys += ks
        if b'<IsTruncated>true</IsTruncated>' not in x or not ks:
            return keys
        marker = ks[-1]


def symbols():
    keys, marker, syms = [], '', []
    while True:
        x = get('https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?delimiter=/&prefix=data/spot/monthly/klines/'
                + ('&marker=' + marker if marker else ''), raw=True)
        ps = re.findall(r'<Prefix>data/spot/monthly/klines/([^<]+)/</Prefix>', x.decode())
        syms += ps
        if b'<IsTruncated>true</IsTruncated>' not in x or not ps:
            break
        marker = 'data/spot/monthly/klines/' + ps[-1] + '/'
    return syms


def parse_zip(b):
    with zipfile.ZipFile(io.BytesIO(b)) as z:
        raw = z.read(z.namelist()[0])
    first = raw[:200].decode(errors='ignore').split('\n')[0]
    hdr = any(c.isalpha() for c in first.split(',')[0])
    df = pd.read_csv(io.BytesIO(raw), header=0 if hdr else None)
    df.columns = COLS[:df.shape[1]]
    t = df.open_time.astype('int64').values
    df['open_time'] = np.where(t > 10**14, t // 1000, t)       # spot files switched to microseconds in 2025
    return df[KEEP]


def rest_recent(sym, start_ms):
    out, t = [], start_ms
    while True:
        j = get(f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval=1h&startTime={t}&limit=1000')
        if not j:
            break
        out += j
        if len(j) < 1000:
            break
        t = j[-1][0] + 1
    if not out:
        return None
    df = pd.DataFrame(out).iloc[:, :12]
    df.columns = COLS
    return df[KEEP]


def one(sym, listed):
    fn = os.path.join(OUT, f'{sym}.parquet')
    if os.path.exists(fn):
        return sym, 'cached'
    keys = [k for k in listing(f'data/spot/monthly/klines/{sym}/1h/')
            if FIRST <= k[-11:-4] <= LAST]
    fr = []
    for k in keys:
        b = get('https://data.binance.vision/' + k, raw=True)
        if b:
            fr.append(parse_zip(b))
    if listed:
        r = rest_recent(sym, int(pd.Timestamp('2026-10-01', tz='UTC').timestamp() * 1000))
        if r is not None:
            fr.append(r)
    if not fr:
        pd.DataFrame(columns=KEEP).to_parquet(fn, index=False)
        return sym, 'empty'
    df = pd.concat(fr, ignore_index=True)
    for c in KEEP[1:]:
        df[c] = df[c].astype('float64')
    df['open_time'] = df.open_time.astype('int64')
    df = df.drop_duplicates('open_time').sort_values('open_time')
    df.to_parquet(fn, index=False)
    return sym, len(df)


def main():
    info = get('https://data-api.binance.vision/api/v3/exchangeInfo?permissions=SPOT')
    listed = {s['symbol'] for s in info['symbols'] if s['quoteAsset'] == 'USDT' and s['status'] == 'TRADING'}
    stable = re.compile(r'^(USDC|BUSD|TUSD|FDUSD|USDP|DAI|EUR|GBP|AEUR|PAXG|USD1|XUSD|BFUSD|RLUSD|U|EURI|USDE|PYUSD|USTC|UST|SUSD|USDS|USDSB|XAUT)USDT$')
    syms = [s for s in symbols() if s.endswith('USDT') and s.isascii() and not stable.match(s)
            and not re.search(r'(UP|DOWN|BULL|BEAR)USDT$', s)]
    syms += [s for s in listed if s not in syms and not stable.match(s)]
    json.dump({s: s in listed for s in syms}, open(os.path.join(RAW, 'symbols.json'), 'w'))
    print(len(syms), 'symbols;', sum(s in listed for s in syms), 'listed now', flush=True)
    done = 0
    with cf.ThreadPoolExecutor(24) as ex:
        for sym, n in ex.map(lambda s: one(s, s in listed), syms):
            done += 1
            if done % 50 == 0:
                print(done, sym, n, flush=True)
    print('done', flush=True)


if __name__ == '__main__':
    main()
