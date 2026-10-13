"""Daily OHLCV for every Binance USDT pair in universe.json (live from the REST mirror, delisted
from the monthly archive), with taker-buy quote volume (the free proxy for aggressive buying)
and trade count. Output: raw/klines.parquet."""
import io, os, re, zipfile
import concurrent.futures as cf
import numpy as np, pandas as pd
from common import get, load, RAW

COLS = ['t', 'open', 'high', 'low', 'close', 'vol', 'tc', 'qv', 'trades', 'tbv', 'tbqv', 'ign']
KEEP = ['open', 'high', 'low', 'close', 'qv', 'trades', 'tbqv']
uni = load('universe.json')
tags = {p['s']: p.get('tags') or [] for p in load('bapi_products.json')}
uni = [u for u in uni if not {'bStocks', 'tCommodities', 'stablecoin'} & set(tags.get(u['sym'], []))]


def frame(rows):
    df = pd.DataFrame(rows, columns=COLS)
    t = df.t.astype('int64').to_numpy()
    t = np.where(t > 10**14, t // 1000, t)
    df.index = pd.to_datetime(t, unit='ms').normalize()
    df = df[KEEP].astype(float)
    return df[~df.index.duplicated()].sort_index()


def rest(sym):
    out, t = [], int(pd.Timestamp('2017-07-01', tz='UTC').timestamp() * 1000)
    while True:
        j = get(f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval=1d&startTime={t}&limit=1000')
        if not j:
            break
        out += j
        if len(j) < 1000:
            break
        t = j[-1][0] + 1
    return frame(out) if out else None


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


def archive(sym):
    fr = []
    keys = listing(f'data/spot/monthly/klines/{sym}/1d/')
    for k in keys:
        b = get('https://data.binance.vision/' + k, raw=True)
        if not b:
            continue
        with zipfile.ZipFile(io.BytesIO(b)) as z:
            d = pd.read_csv(io.BytesIO(z.read(z.namelist()[0])), header=None)
        if not str(d.iloc[0, 0]).isdigit():
            d = d.iloc[1:]
        fr.append(d.iloc[:, :12].values.tolist())
    # The month a pair is delisted in only exists as daily files.
    last = sorted(keys)[-1] if keys else None
    if last:
        y, m = re.search(r'(\d{4})-(\d{2})\.zip$', last).groups()
        nxt = pd.Timestamp(f'{y}-{m}-01') + pd.offsets.MonthBegin(1)
        for k in listing(f'data/spot/daily/klines/{sym}/1d/{sym}-1d-{nxt:%Y-%m}'):
            b = get('https://data.binance.vision/' + k, raw=True)
            if b:
                with zipfile.ZipFile(io.BytesIO(b)) as z:
                    d = pd.read_csv(io.BytesIO(z.read(z.namelist()[0])), header=None)
                fr.append(d.iloc[:, :12].values.tolist())
    rows = [r for f in fr for r in f]
    return frame(rows) if rows else None


def one(u):
    df = rest(u['sym']) if u['live'] else archive(u['sym'])
    if df is None or df.empty:
        return None
    df['sym'] = u['sym']
    df['live'] = u['live']
    return df


out = []
with cf.ThreadPoolExecutor(12) as ex:
    for i, df in enumerate(ex.map(one, uni)):
        if df is not None:
            out.append(df)
        if i % 100 == 0:
            print(i, flush=True)
K = pd.concat(out)
K.index.name = 'date'
K.to_parquet(os.path.join(RAW, 'klines.parquet'))
print('klines', K.sym.nunique(), 'symbols,', len(K), 'rows;', K.groupby('sym').live.first().value_counts().to_dict())
