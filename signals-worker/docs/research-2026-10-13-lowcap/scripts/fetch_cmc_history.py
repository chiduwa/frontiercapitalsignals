"""Daily market cap, circulating supply and volume from CMC's keyless data-api, 2018-06 onward.

Live pairs use the exact id from CMC's Binance pair table. Delisted pairs have only a symbol, so
each candidate id is checked against the Binance close over the last 60 traded days: the id
whose CMC close has median |log ratio| < 0.15 to Binance wins (else the pair stays unmapped).
Output: raw/cmc_hist.parquet (cmc_id, date, close, mcap, circ, volume), raw/cmc_choice.json.
"""
import os, sys, time
import concurrent.futures as cf
import numpy as np, pandas as pd
from common import get, load, dump, RAW

START = pd.Timestamp('2018-06-01', tz='UTC')
END = pd.Timestamp.now(tz='UTC').normalize()
CHUNK = pd.Timedelta(days=360)


def hist(cid, a=START, b=END):
    out, t = [], a
    while t < b:
        e = min(t + CHUNK, b)
        j = get(f'https://api.coinmarketcap.com/data-api/v3/cryptocurrency/historical?id={cid}&convertId=2781'
                f'&timeStart={int(t.timestamp())}&timeEnd={int(e.timestamp())}', pause=0.25)
        for q in ((j or {}).get('data') or {}).get('quotes') or []:
            x = q['quote']
            out.append((cid, q['timeOpen'][:10], x.get('close'), x.get('marketCap'), x.get('circulatingSupply'), x.get('volume')))
        t = e
    return out


def frame(rows):
    df = pd.DataFrame(rows, columns=['cmc_id', 'date', 'close', 'mcap', 'circ', 'volume'])
    df['date'] = pd.to_datetime(df.date)
    return df.drop_duplicates(['cmc_id', 'date'])


if __name__ == '__main__':
    K = pd.read_parquet(os.path.join(RAW, 'klines.parquet'))
    uni = {u['sym']: u for u in load('universe.json')}
    syms = sorted(K.sym.unique())
    choice = {}
    # Resolve delisted pairs first (one short window per candidate).
    todo = [s for s in syms if not uni[s]['live'] and uni[s]['cmc_candidates']]
    print('resolving', len(todo), 'delisted pairs', flush=True)

    def resolve(s):
        k = K[K.sym == s].close
        k = k[k > 0].iloc[-60:]
        if len(k) < 10:
            return s, None, None
        a, b = pd.Timestamp(k.index[0], tz='UTC'), pd.Timestamp(k.index[-1], tz='UTC') + pd.Timedelta(days=1)
        best = (None, 9.0)
        for cid in uni[s]['cmc_candidates'][:8]:
            h = frame(hist(cid, a, b))
            if h.empty:
                continue
            m = h.set_index('date').close.reindex(k.index).dropna()
            m = m[m > 0]
            if len(m) < 10:
                continue
            err = float(np.median(np.abs(np.log(m / k.reindex(m.index)))))
            if err < best[1]:
                best = (cid, err)
        return s, best[0] if best[1] < 0.15 else None, best[1]

    with cf.ThreadPoolExecutor(4) as ex:
        for s, cid, err in ex.map(resolve, todo):
            choice[s] = cid
    for s in syms:
        if uni[s]['live']:
            choice[s] = uni[s]['cmc_id']
    dump(choice, 'cmc_choice.json')
    ids = sorted({c for c in choice.values() if c})
    print('fetching', len(ids), 'ids; delisted mapped', sum(1 for s in todo if choice.get(s)), 'of', len(todo), flush=True)
    rows = []
    with cf.ThreadPoolExecutor(4) as ex:
        for i, r in enumerate(ex.map(hist, ids)):
            rows += r
            if i % 50 == 0:
                print(i, len(rows), flush=True)
    H = frame(rows)
    H.to_parquet(os.path.join(RAW, 'cmc_hist.parquet'))
    print('cmc_hist', H.cmc_id.nunique(), 'ids', len(H), 'rows', flush=True)
