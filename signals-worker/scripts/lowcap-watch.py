#!/usr/bin/env python3
"""Low-cap watch (lowcap-watch-v1): Binance's smallest coins whose trading is
most likely to surge, the coins to stay away from, and a private spike ranking
that is logged but not shown until its live record earns it.

Asked 2026-10-13: rank the very low market-cap coins on Binance by how likely
they are to spike, and forecast the inflows that move them. Studied on every
Binance USDT pair since 2017 including 192 delisted ones (docs/LOWCAP_SPIKES.md):

  * Inflows ARE forecastable. Walked forward Nov 2021..Jul 2026 on the bottom
    40% of Binance market caps, the daily top 10 of this script's inflow model
    saw their next-30-day volume triple 17.3% of the time against 8.2% for all
    low caps (AUC 0.67). Which way the price then goes is not forecast.
  * Which coin doubles is only slightly forecastable: the spike model's top 10
    closed at 2x within 90 days 13.3% of the time against 11.0% (AUC 0.55),
    and its take-profit returns were about break-even after costs since 2024.
    So that list is written to D1 every day and stays off the page until its
    own live record beats the low-cap average (SPIKE_GATE).
  * Binance's monitoring tag and Upbit's formal warning designation came
    before the worst 90 days in the data; those coins are excluded and listed as "avoid".
  * The model's probability LEVELS were miscalibrated (regime-driven), so only
    ranks are published.

Daily, for the last completed UTC day (as_of):
  1. Fetch: Binance spot pairs and daily klines (data-api mirror), Binance
     product tags (monitoring, fan token) and delisting notices (www), CMC
     market caps (keyless data-api), Upbit markets, USD-M perp archive, and the
     order book of the coins that are shown.
  2. Features exactly as in the study (docs/research-2026-10-13-lowcap/scripts
     /panel.py), on the newest bar of each pair's current series.
  3. Fit both models on the frozen study panel (lowcap-training-v1.csv.gz,
     2019..2026-09) and rank today's low caps.
  4. Score rows whose 30/90 days have passed, and compute the live record.
Writes results.json for lowcap-watch-io.mjs. Places nothing.
"""
import argparse, gzip, hashlib, io, json, math, re, sys, time, zipfile
import concurrent.futures as cf
import urllib.error, urllib.request
from pathlib import Path
import numpy as np, pandas as pd

VERSION = 'lowcap-watch-v1'
HERE = Path(__file__).parent
TRAINING = HERE / 'lowcap-training-v1.csv.gz'
EVIDENCE = HERE / 'lowcap-evidence-v1.json'
LOWCAP_PCT = 0.4          # bottom 40% of the day's Binance market caps
MIN_AGE = 120             # days of history before a pair is ranked
TOP_N = 10                # the published list and the scored record are the same 10
INFLOW_H, SPIKE_H = 30, 90
COST = 0.006              # round trip charged to every take-profit return
SPIKE_GATE = {'minCohorts': 180, 'minT': 2.0}   # private until its live record clears this
INFLOW_DEMOTE = {'minCohorts': 60, 'maxT': -2.0}  # pulled from the page if it trails the base
UA = {'User-Agent': 'Mozilla/5.0 (FCS lowcap-watch)'}

PROD_CONT = ['log_mcap', 'log_price', 'age', 'mom_7', 'mom_30', 'mom_90', 'mom_180', 'vol_30', 'vol_ratio', 'range_30',
             'max_ret_30', 'max_ret_90', 'dd_365', 'dd_ath', 'up_from_low_365', 'days_since_low', 'log_qv30',
             'vol_surge_7_90', 'vol_surge_30_90', 'turnover_30', 'amihud_30', 'taker_buy_7', 'taker_buy_chg',
             'trades_surge', 'avg_trade_usd', 'supply_growth_90', 'log_lambda', 'net_flow_7', 'net_flow_30', 'prior_spikes']
PROD_FLAG = ['has_perp', 'monitoring', 'upbit_krw']
FEATS = PROD_CONT + PROD_FLAG

# Not crypto risk assets: stablecoins, fiat, wrapped/staked majors, tokenised gold.
STABLE = {'USDC', 'BUSD', 'TUSD', 'FDUSD', 'USDP', 'DAI', 'EUR', 'GBP', 'AEUR', 'PAXG', 'XAUT', 'USD1', 'XUSD', 'BFUSD',
          'RLUSD', 'U', 'EURI', 'USDE', 'PYUSD', 'USDS', 'SUSD', 'UST', 'PAX', 'BKRW', 'IDRT', 'BIDR', 'BVND', 'RWUSD',
          'USDSB', 'TRY', 'BRL', 'AUD', 'RUB', 'NGN', 'UAH', 'ZAR', 'PLN', 'RON', 'ARS', 'JPY', 'MXN', 'COP', 'CZK',
          'USDT', 'WBTC', 'WBETH', 'BETH', 'BNSOL'}
EXCLUDE_TAGS = {'bStocks', 'tCommodities', 'stablecoin'}
LEVERAGED = re.compile(r'(UP|DOWN|BULL|BEAR)$')
KLINE_COLS = ['t', 'open', 'high', 'low', 'close', 'vol', 'tc', 'qv', 'trades', 'tbv', 'tbqv', 'ign']


# ---------------------------------------------------------------- network
def get(url, raw=False, tries=4, headers=None, pause=0.0, timeout=60):
    h = dict(UA)
    h.update(headers or {})
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as r:
                b = r.read()
            if pause:
                time.sleep(pause)
            return b if raw else json.loads(b)
        except urllib.error.HTTPError as e:
            if e.code in (400, 404, 410):
                return None
            time.sleep((20 if e.code in (418, 429) else 3) * (i + 1))
        except Exception:
            time.sleep(2 * (i + 1))
    return None


def frame_klines(rows):
    if not rows:
        return None
    df = pd.DataFrame([r[:12] for r in rows], columns=KLINE_COLS)
    t = df.t.astype('int64').to_numpy()
    t = np.where(t > 10 ** 14, t // 1000, t)               # the archive switched to microseconds in 2025
    df.index = pd.to_datetime(t, unit='ms').normalize()
    df = df[['open', 'high', 'low', 'close', 'qv', 'trades', 'tbqv']].astype(float)
    return df[~df.index.duplicated()].sort_index()


def spot_klines(pair, fetch=get):
    out, t = [], int(pd.Timestamp('2017-07-01', tz='UTC').timestamp() * 1000)
    while True:
        j = fetch(f'https://data-api.binance.vision/api/v3/klines?symbol={pair}&interval=1d&startTime={t}&limit=1000')
        if not j:
            break
        out += j
        if len(j) < 1000:
            break
        t = j[-1][0] + 1
    return frame_klines(out)


def _s3_keys(prefix, fetch=get, after=''):
    keys, marker = [], after
    while True:
        x = fetch('https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?prefix=' + prefix
                  + ('&marker=' + marker if marker else ''), raw=True)
        if x is None:
            return keys
        ks = re.findall(r'<Key>([^<]+\.zip)</Key>', x.decode())
        keys += ks
        if b'<IsTruncated>true</IsTruncated>' not in x or not ks:
            return keys
        marker = ks[-1]


def _zip_rows(key, fetch=get):
    b = fetch('https://data.binance.vision/' + key, raw=True)
    if not b:
        return []
    with zipfile.ZipFile(io.BytesIO(b)) as z:
        d = pd.read_csv(io.BytesIO(z.read(z.namelist()[0])), header=None)
    if not str(d.iloc[0, 0]).isdigit():
        d = d.iloc[1:]
    return d.iloc[:, :12].values.tolist()


def archive_klines(pair, since, fetch=get):
    """A delisted pair is gone from the REST mirror; its bars stay in the public
    archive: whole months as monthly files, the final (delisting) month only as
    daily files."""
    month0 = since[:7]
    monthly = [k for k in _s3_keys(f'data/spot/monthly/klines/{pair}/1d/', fetch) if k[-11:-4] >= month0]
    rows = [r for k in monthly for r in _zip_rows(k, fetch)]
    after_month = monthly[-1][-11:-4] if monthly else None
    start = (pd.Timestamp(after_month + '-01') + pd.offsets.MonthBegin(1)).strftime('%Y-%m-%d') if after_month else since
    prefix = f'data/spot/daily/klines/{pair}/1d/'
    daily = _s3_keys(prefix, fetch, after=f'{prefix}{pair}-1d-{(pd.Timestamp(start) - pd.Timedelta(days=1)):%Y-%m-%d}.zip')
    rows += [r for k in daily if k[-14:-4] >= start for r in _zip_rows(k, fetch)]
    return frame_klines(rows)


def has_perp(pair, as_of, fetch=get):
    for p in (pair, '1000' + pair):
        x = fetch(f'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?prefix=data/futures/um/daily/klines/{p}/1d/&max-keys=1', raw=True)
        if x is None:
            return None
        m = re.search(r'-1d-(\d{4}-\d{2}-\d{2})\.zip', x.decode())
        if m and m.group(1) <= as_of:
            return True
    return False


def book_depth(pair, fetch=get):
    j = fetch(f'https://data-api.binance.vision/api/v3/depth?symbol={pair}&limit=5000', pause=3.0)
    if not j or not j.get('asks') or not j.get('bids'):
        return None
    asks = [(float(p), float(q)) for p, q in j['asks']]
    mid = (asks[0][0] + float(j['bids'][0][0])) / 2
    return {'lift10Usd': sum(p * q for p, q in asks if p <= mid * 1.1), 'lift20Usd': sum(p * q for p, q in asks if p <= mid * 1.2),
            'spreadBp': (asks[0][0] - float(j['bids'][0][0])) / mid * 1e4}


def parse_delistings(articles, as_of):
    """'Binance Will Delist ICX, SCRT, STORJ on 2026-09-03' -> {ticker: date}, spot only, date >= as_of."""
    out = {}
    for a in articles or []:
        t = a.get('title') or ''
        if not re.search(r'\bWill Delist\b', t) or re.search(r'Futures|Margin|Alpha|Perpetual|Loan', t):
            continue
        m = re.search(r'on (\d{4}-\d{2}-\d{2})', t)
        if not m or m.group(1) < as_of:
            continue
        head = t.split(' on ')[0].replace('Binance Will Delist', '')
        for tick in re.findall(r'\b([A-Z0-9]{2,15})\b', head):
            out[tick] = m.group(1)
    return out


def parse_upbit(markets):
    """{base: {'markets': {'KRW', 'BTC', ...}, 'flag': 'warning' | ''}}.
    Only the formal designation (유의종목, market_event.warning) is what the study
    tested (-22% vs the market over 90 days). The 'caution' sub-flags are same-day
    alerts (price swings, volume or deposit spikes), never tested, so they mark
    nothing."""
    upbit = {}
    for m in markets or []:
        quote, base = m['market'].split('-', 1)
        u = upbit.setdefault(base, {'markets': set(), 'flag': ''})
        u['markets'].add(quote)
        if (m.get('market_event') or {}).get('warning'):
            u['flag'] = 'warning'
    return upbit


def fetch_market(as_of, fetch=get, log=print):
    """Everything the ranking needs, with the source status of each feed."""
    src = {}
    info = fetch('https://data-api.binance.vision/api/v3/exchangeInfo?permissions=SPOT')
    if not info:
        raise RuntimeError('Binance exchangeInfo unavailable: nothing can be ranked')
    pairs = {s['symbol']: s['baseAsset'] for s in info['symbols'] if s['quoteAsset'] == 'USDT' and s['status'] == 'TRADING'}
    prod = fetch('https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=false')
    tags = {p['s']: p.get('tags') or [] for p in (prod or {}).get('data') or []}
    src['binanceTags'] = bool(tags)
    cms = fetch('https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=161&pageNo=1&pageSize=50')
    arts = [a for c in ((cms or {}).get('data') or {}).get('catalogs') or [] for a in c.get('articles', [])]
    src['binanceDelistings'] = bool(arts)
    delist = parse_delistings(arts, as_of)
    pairs = {p: b for p, b in pairs.items() if b.isascii() and b not in STABLE and not LEVERAGED.search(b)
             and not (EXCLUDE_TAGS & set(tags.get(p, [])))}
    # CMC: the Binance pair -> coin id table, then every coin's market cap in one call.
    cmc_ids, start = {}, 1
    while True:
        j = fetch(f'https://api.coinmarketcap.com/data-api/v3/exchange/market-pairs/latest?slug=binance&category=spot&start={start}&limit=1000')
        mp = ((j or {}).get('data') or {}).get('marketPairs') or []
        for p in mp:
            if p.get('quoteSymbol') == 'USDT':
                cmc_ids[p['marketPair'].replace('/', '')] = p['baseCurrencyId']
        if len(mp) < 1000:
            break
        start += 1000
    listing = fetch('https://api.coinmarketcap.com/data-api/v3/cryptocurrency/listing?start=1&limit=5000&sortBy=market_cap'
                    '&sortType=desc&convert=USD&cryptoType=all&tagType=all&audited=false')
    coins = {}
    for c in ((listing or {}).get('data') or {}).get('cryptoCurrencyList') or []:
        q = next((x for x in c.get('quotes') or [] if x.get('name') == 'USD'), None)
        if q:
            coins[c['id']] = {'name': c.get('name'), 'mcap': q.get('marketCap'), 'price': q.get('price'), 'circ': c.get('circulatingSupply')}
    src['cmc'] = bool(cmc_ids) and bool(coins)
    if not src['cmc']:
        raise RuntimeError('CMC market caps unavailable: the low-cap set cannot be drawn')
    upbit = parse_upbit(fetch('https://api.upbit.com/v1/market/all?isDetails=true'))
    src['upbit'] = bool(upbit)
    kl = {}
    with cf.ThreadPoolExecutor(8) as ex:
        for p, df in zip(pairs, ex.map(lambda p: spot_klines(p, fetch), list(pairs))):
            if df is not None and len(df):
                kl[p] = df
    src['binanceSpot'] = len(kl) / max(1, len(pairs))
    log(f'lowcap fetch: {len(pairs)} pairs, {len(kl)} with klines, {len(cmc_ids)} CMC-mapped; tags={src["binanceTags"]} '
        f'delistings={src["binanceDelistings"]} upbit={src["upbit"]}')
    return {'pairs': pairs, 'tags': tags, 'delist': delist, 'cmc_ids': cmc_ids, 'coins': coins, 'upbit': upbit,
            'klines': kl, 'sources': src}


def cmc_circ_on(cid, day, fetch=get):
    a = int((pd.Timestamp(day) - pd.Timedelta(days=4)).tz_localize('UTC').timestamp())
    b = int((pd.Timestamp(day) + pd.Timedelta(days=1)).tz_localize('UTC').timestamp())
    j = fetch(f'https://api.coinmarketcap.com/data-api/v3/cryptocurrency/historical?id={cid}&convertId=2781&timeStart={a}&timeEnd={b}', pause=0.2)
    pts = [(q['timeOpen'][:10], (q.get('quote') or {}).get('circulatingSupply')) for q in (((j or {}).get('data') or {}).get('quotes') or [])]
    pts = [(d, c) for d, c in pts if d <= day and c]
    return float(pts[-1][1]) if pts else None


# ---------------------------------------------------------------- features
def current_segment(df):
    """The pair's current series: history before a 30+ day gap or a 10x one-day
    jump (a reused ticker or a redenomination) belongs to another asset."""
    d = df[df.close > 0].sort_index()
    if d.empty:
        return d
    gap = d.index.to_series().diff().dt.days.fillna(1) > 30
    r = (d.close / d.close.shift()).fillna(1)
    seg = (gap | (r > 10) | (r < 0.1)).cumsum()
    return d[seg == seg.iloc[-1]]


def coin_features(bars, as_of, mcap=None, circ_now=None, circ_90=None):
    """Features of the as_of bar, computed exactly as panel.py did for the study
    (calendar-daily series, close carried over non-trading days)."""
    s = current_segment(bars.loc[:pd.Timestamp(as_of)])
    if s.empty or s.index[-1] != pd.Timestamp(as_of):
        return None
    idx = pd.date_range(s.index[0], s.index[-1], freq='D')
    s = s.reindex(idx)
    traded = s.close.notna()
    s['close'] = s.close.ffill()
    s['high'] = s.high.fillna(s.close)
    s['low'] = s.low.fillna(s.close)
    for c in ('qv', 'trades', 'tbqv'):
        s[c] = s[c].fillna(0.0)
    c, h, l, qv = s.close, s.high, s.low, s.qv
    lr = np.log(c).diff()
    f = {'age': len(s) - 1, 'close': float(c.iloc[-1]), 'log_price': float(np.log(c.iloc[-1]))}
    f['mcap'] = mcap
    f['log_mcap'] = float(np.log(mcap)) if mcap and mcap > 0 else np.nan
    last = lambda x: float(x.iloc[-1]) if len(x) and pd.notna(x.iloc[-1]) else np.nan
    for w in (7, 30, 90, 180):
        f[f'mom_{w}'] = last(c / c.shift(w) - 1)
    f['vol_30'] = last(lr.rolling(30).std())
    f['vol_ratio'] = last(lr.rolling(30).std() / lr.rolling(180, min_periods=120).std())
    f['range_30'] = last(h.rolling(30).max() / l.rolling(30).min() - 1)
    f['max_ret_30'] = last(lr.rolling(30).max())
    f['max_ret_90'] = last(lr.rolling(90).max())
    f['dd_365'] = last(c / h.rolling(365, min_periods=MIN_AGE).max() - 1)
    f['dd_ath'] = last(c / h.cummax() - 1)
    f['up_from_low_365'] = last(c / l.rolling(365, min_periods=MIN_AGE).min() - 1)
    tail = l.iloc[-365:]
    f['days_since_low'] = float(len(tail) - 1 - int(np.argmin(tail.values))) if len(tail) >= MIN_AGE else np.nan
    qv7, qv30, qv90 = qv.rolling(7).mean(), qv.rolling(30).mean(), qv.rolling(90).mean()
    f['qv7'], f['qv30'], f['qv90'] = last(qv7), last(qv30), last(qv90)
    f['log_qv30'] = float(np.log1p(f['qv30'])) if pd.notna(f['qv30']) else np.nan
    f['vol_surge_7_90'] = float(np.log((f['qv7'] + 1) / (f['qv90'] + 1))) if pd.notna(f['qv90']) else np.nan
    f['vol_surge_30_90'] = float(np.log((f['qv30'] + 1) / (f['qv90'] + 1))) if pd.notna(f['qv90']) else np.nan
    f['turnover_30'] = f['qv30'] / mcap if mcap else np.nan
    f['amihud_30'] = last((lr.abs() / (qv + 1)).rolling(30).mean() * 1e6)
    nf = (2 * s.tbqv - qv) / 1e6
    mp = dict(min_periods=60)
    cov = (lr * nf).rolling(90, **mp).mean() - lr.rolling(90, **mp).mean() * nf.rolling(90, **mp).mean()
    lam = last(cov / nf.rolling(90, **mp).var(ddof=0).replace(0, np.nan))
    f['log_lambda'] = float(np.log(max(lam, 1e-6))) if pd.notna(lam) else np.nan
    f['net_flow_7'] = float(nf.iloc[-7:].sum() * 1e6 / mcap) if mcap else np.nan
    f['net_flow_30'] = float(nf.iloc[-30:].sum() * 1e6 / mcap) if mcap else np.nan
    tb7 = s.tbqv.rolling(7).sum() / (qv.rolling(7).sum() + 1)
    f['taker_buy_7'] = last(tb7)
    f['taker_buy_chg'] = last(tb7 - s.tbqv.rolling(90).sum() / (qv.rolling(90).sum() + 1))
    f['trades_surge'] = last(np.log((s.trades.rolling(7).mean() + 1) / (s.trades.rolling(90).mean() + 1)))
    f['avg_trade_usd'] = last(np.log1p(qv30 / (s.trades.rolling(30).mean() + 1)))
    f['supply_growth_90'] = (circ_now / circ_90 - 1) if circ_now and circ_90 else np.nan
    # Prior spikes: how often in the last year the close doubled within 90 days,
    # counting only windows that had finished by as_of.
    fwdmax = c[::-1].rolling(90, min_periods=1).max()[::-1].shift(-1)
    past = ((fwdmax / c - 1).shift(90) >= 1.0).astype(float)
    f['prior_spikes'] = float(past.iloc[-365:].sum() / 30)
    f['dead_days_30'] = float((~traded).iloc[-30:].sum() + (qv < 1000).iloc[-30:].sum())
    return f


# ---------------------------------------------------------------- model
def design(df):
    """Within-day rank percentiles for the continuous features, 0/1 flags."""
    X = pd.DataFrame(index=df.index)
    by = df.groupby('date')
    for c in PROD_CONT:
        X[c] = by[c].rank(pct=True).fillna(0.5)
    for c in PROD_FLAG:
        X[c] = df[c].astype(float).fillna(0.0)
    return X[FEATS]


def fit_models(train):
    from sklearn.linear_model import LogisticRegression
    from sklearn.ensemble import HistGradientBoostingClassifier
    X = design(train)
    a, b = train.inflow3x.notna(), train.y2c.notna()
    inflow = LogisticRegression(C=0.05, max_iter=2000).fit(X[a].values, train.loc[a, 'inflow3x'].values)
    spike = HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=150, min_samples_leaf=200,
                                           l2_regularization=1.0, early_stopping=False,
                                           random_state=0).fit(X[b].values, train.loc[b, 'y2c'].values)
    return inflow, spike


def load_training(path=TRAINING):
    with gzip.open(path, 'rt') as f:
        return pd.read_csv(f)


def avoid_reasons(pair, base, market):
    r = []
    tags = market['tags'].get(pair, [])
    if 'Monitoring' in tags:
        r.append('Binance monitoring tag')
    up = market['upbit'].get(base)
    if up and up['flag']:
        r.append(f'Upbit {up["flag"]}')
    if base in market['delist']:
        r.append(f'Binance delisting {market["delist"][base]}')
    return r


def rank_today(market, as_of, models, circ_lookup=cmc_circ_on, perp_lookup=has_perp, fetch=get):
    """Features for every live pair, the low-cap set, and both ranks."""
    rows = []
    for pair, base in market['pairs'].items():
        bars = market['klines'].get(pair)
        cid = market['cmc_ids'].get(pair)
        coin = market['coins'].get(cid) if cid else None
        if bars is None or not coin or not coin.get('mcap') or not coin.get('price'):
            continue
        mult = 1e6 if pair.startswith('1M') else 1000.0 if pair.startswith('1000') else 1.0
        live_close = float(bars.close.iloc[-1])
        if abs(math.log(coin['price'] * mult / live_close)) > 0.3:       # a reused ticker, not this coin
            continue
        f = coin_features(bars, as_of, mcap=float(coin['mcap']))
        if not f or f['age'] < MIN_AGE or f['dead_days_30'] >= 10:
            continue
        f.update(pair=pair, symbol=base, cmc_id=cid, name=coin.get('name'), circ_now=coin.get('circ'))
        rows.append(f)
    U = pd.DataFrame(rows)
    if U.empty:
        raise RuntimeError('no pair could be ranked')
    U['mcap_pct'] = U.mcap.rank(pct=True)
    L = U[U.mcap_pct <= LOWCAP_PCT].copy()
    # Supply growth and the perp flag only for the low caps (one call each).
    day90 = (pd.Timestamp(as_of) - pd.Timedelta(days=90)).strftime('%Y-%m-%d')
    with cf.ThreadPoolExecutor(4) as ex:
        circ90 = list(ex.map(lambda cid: circ_lookup(cid, day90, fetch), L.cmc_id))
        perps = list(ex.map(lambda p: perp_lookup(p, as_of, fetch), L.pair))
    L['supply_growth_90'] = [(cn / c9 - 1) if cn and c9 else np.nan for cn, c9 in zip(L.circ_now, circ90)]
    L['has_perp'] = [1.0 if p else 0.0 for p in perps]
    perp_ok = sum(p is not None for p in perps) / max(1, len(perps))
    L['monitoring'] = [1.0 if 'Monitoring' in market['tags'].get(p, []) else 0.0 for p in L.pair]
    L['upbit_krw'] = [1.0 if 'KRW' in (market['upbit'].get(b) or {}).get('markets', set()) else 0.0 for b in L.symbol]
    L['date'] = as_of
    X = design(L)
    inflow, spike = models
    L['inflow_score'] = inflow.predict_proba(X.values)[:, 1]
    L['spike_score'] = spike.predict_proba(X.values)[:, 1]
    L['inflow_rank'] = L.inflow_score.rank(ascending=False, method='first').astype(int)
    L['spike_rank'] = L.spike_score.rank(ascending=False, method='first').astype(int)
    L['avoid'] = [avoid_reasons(p, b, market) for p, b in zip(L.pair, L.symbol)]
    L['fan_token'] = ['fan_token' in market['tags'].get(p, []) for p in L.pair]
    L['eligible'] = [(not a) and (not ft) for a, ft in zip(L.avoid, L.fan_token)]
    return U, L.reset_index(drop=True), perp_ok


# ---------------------------------------------------------------- scoring
def outcome_path(bars, as_of, horizon):
    """Calendar-daily closes after as_of (carried over gaps), as in the study."""
    s = current_segment(bars)
    t0 = pd.Timestamp(as_of)
    if t0 not in s.index:
        return None, None
    c0 = float(s.close.loc[t0])
    fut = s.loc[t0 + pd.Timedelta(days=1): t0 + pd.Timedelta(days=horizon)]
    fut = fut.reindex(pd.date_range(fut.index[0], fut.index[-1], freq='D')).ffill() if len(fut) else fut
    return c0, fut


def score_row(row, bars, last_day, delisted):
    """Outcomes for one ledger row that has matured; None where a window is still open."""
    out = {}
    t0 = pd.Timestamp(row['as_of'])
    if row.get('scored30_at') is None and t0 + pd.Timedelta(days=INFLOW_H) <= last_day:
        _, fut = outcome_path(bars, row['as_of'], INFLOW_H) if bars is not None else (None, None)
        if fut is not None and len(fut) >= INFLOW_H and row.get('qv90') is not None:
            ratio = float(fut.qv.fillna(0).mean() / (float(row['qv90']) + 1))
            out.update(fwd_qv_ratio=ratio, inflow3x=int(ratio >= 3))
        else:
            out.update(fwd_qv_ratio=None, inflow3x=None)        # delisted before 30 days: no inflow label, as in the study
        out['score30'] = True
    if row.get('scored90_at') is None and (t0 + pd.Timedelta(days=SPIKE_H) <= last_day or delisted):
        c0, fut = outcome_path(bars, row['as_of'], SPIKE_H) if bars is not None else (None, None)
        complete = fut is not None and len(fut) >= SPIKE_H
        ended = fut is not None and len(fut) and delisted and not complete
        if complete or ended:
            c0 = float(row['close'])
            cl = fut.close.values
            mx = float(np.max(cl) / c0)
            ret = float(cl[-1] / c0 - 1)
            out.update(max_close_mult=mx, ret90=ret, tp50=0.5 if mx >= 1.5 else ret, tp100=1.0 if mx >= 2 else ret,
                       delisted=int(bool(ended)), score90=True)
        elif delisted and (fut is None or not len(fut)):
            out.update(max_close_mult=None, ret90=None, tp50=None, tp100=None, delisted=1, score90=True)
    return out


def nw_t(x, lag):
    x = np.asarray([v for v in x if v is not None and np.isfinite(v)], float)
    n = len(x)
    if n < 10:
        return None
    e = x - x.mean()
    s = e @ e / n
    for k in range(1, min(lag, n - 1) + 1):
        s += 2 * (1 - k / (lag + 1)) * (e[k:] @ e[:-k]) / n
    return float(x.mean() / math.sqrt(max(s, 1e-18) / n))


def live_record(scored):
    """Picks (top 10 eligible by rank) against the whole low-cap set of the same day."""
    df = pd.DataFrame(scored)
    rec = {'inflow': {'cohorts': 0}, 'spike': {'cohorts': 0}}
    if df.empty:
        return rec
    for key, rank, label, lag in (('inflow', 'inflow_rank', 'inflow3x', INFLOW_H), ('spike', 'spike_rank', 'tp100', SPIKE_H)):
        d = df[df[label].notna()]
        rows = []
        for as_of, g in d.groupby('as_of'):
            if len(g) < 20:
                continue
            top = g[g.eligible == 1].nsmallest(TOP_N, rank)
            if len(top) < TOP_N // 2:
                continue
            if key == 'inflow':
                rows.append((as_of, top.inflow3x.mean(), g.inflow3x.mean()))
            else:
                rows.append((as_of, top.tp100.mean() - COST, g.tp100.mean() - COST,
                             (top.max_close_mult >= 2).mean(), (g.max_close_mult >= 2).mean()))
        if not rows:
            continue
        r = pd.DataFrame(rows)
        diff = (r[1] - r[2]).tolist()
        rec[key] = {'cohorts': len(r), 'since': r[0].min(), 'through': r[0].max(), 'top10': float(r[1].mean()),
                    'base': float(r[2].mean()), 'diff': float(np.mean(diff)), 't': nw_t(diff, lag)}
        if key == 'spike':
            rec[key].update(top10Doubled=float(r[3].mean()), baseDoubled=float(r[4].mean()))
    return rec


def gate(record):
    sp, inf = record.get('spike') or {}, record.get('inflow') or {}
    spike_live = (sp.get('cohorts', 0) >= SPIKE_GATE['minCohorts'] and sp.get('t') is not None
                  and sp['t'] >= SPIKE_GATE['minT'] and sp.get('diff', 0) > 0)
    inflow_demoted = (inf.get('cohorts', 0) >= INFLOW_DEMOTE['minCohorts'] and inf.get('t') is not None
                      and inf['t'] <= INFLOW_DEMOTE['maxT'])
    return ('live' if spike_live else 'shadow'), ('demoted' if inflow_demoted else 'live')


# ---------------------------------------------------------------- summary
def korea_label(base, upbit):
    u = upbit.get(base)
    if not u:
        return None
    if 'KRW' in u['markets']:
        return 'krw'
    return 'btc-usdt-only'


def build_summary(as_of, run_at, U, L, market, record, depth, perp_ok, evidence):
    spike_status, inflow_status = gate(record)
    up = market['upbit']

    def item(r, rank):
        d = depth.get(r.pair) or {}
        return {'rank': rank, 'symbol': r.symbol, 'pair': r.pair, 'name': r['name'], 'mcap': r.mcap,
                'mom30': r.mom_30, 'volRatio': (r.qv7 + 1) / (r.qv90 + 1) if pd.notna(r.qv90) else None,
                'qv30': r.qv30, 'lift20Usd': d.get('lift20Usd'), 'spreadBp': d.get('spreadBp'),
                'korea': korea_label(r.symbol, up), 'perp': bool(r.has_perp)}

    E = L[L.eligible]
    inflow_list = [item(r, i + 1) for i, (_, r) in enumerate(E.nsmallest(TOP_N, 'inflow_rank').iterrows())]
    avoid = []
    for pair, base in market['pairs'].items():
        reasons = avoid_reasons(pair, base, market)
        if reasons:
            row = U[U.pair == pair]
            mc = float(row.mcap.iloc[0]) if len(row) else None
            avoid.append({'symbol': base, 'reasons': reasons, 'mcap': mc,
                          'lowcap': bool(len(row) and row.mcap_pct.iloc[0] <= LOWCAP_PCT)})
    avoid.sort(key=lambda a: (not a['lowcap'], a['symbol']))
    src = dict(market['sources'], perpArchive=perp_ok)
    notes = []
    if not src.get('binanceTags'):
        notes.append('Binance product tags were unavailable: monitoring-tag coins may be missing from the avoid list')
    if not src.get('binanceDelistings'):
        notes.append('Binance delisting notices were unavailable')
    if not src.get('upbit'):
        notes.append('Upbit was unavailable: its warning designations and KRW status are missing')
    summary = {
        'version': VERSION, 'asOf': as_of, 'runAt': run_at,
        'universe': {'binancePairs': len(market['pairs']), 'ranked': int(len(U)), 'lowcaps': int(len(L)),
                     'eligible': int(L.eligible.sum()), 'mcapCeiling': float(L.mcap.max()) if len(L) else None},
        'inflowWatch': {'status': inflow_status, 'list': inflow_list if inflow_status == 'live' else []},
        'avoid': avoid,
        'spike': {'status': spike_status, 'gate': SPIKE_GATE},
        'live': record, 'evidence': evidence, 'sources': src, 'notes': notes,
    }
    # Fail closed: the spike list exists in the payload ONLY once its record clears the gate.
    if spike_status == 'live':
        summary['spike']['list'] = [item(r, i + 1) for i, (_, r) in enumerate(E.nsmallest(TOP_N, 'spike_rank').iterrows())]
    return summary


def ledger_rows(L, run_at):
    out = []
    for _, r in L.iterrows():
        out.append({'as_of': r.date, 'symbol': r.symbol, 'pair': r.pair, 'close': r.close, 'mcap': r.mcap,
                    'qv90': r.qv90, 'eligible': int(bool(r.eligible)), 'inflow_rank': int(r.inflow_rank),
                    'inflow_score': float(r.inflow_score), 'spike_rank': int(r.spike_rank), 'spike_score': float(r.spike_score),
                    'detail': {'name': r['name'], 'mom30': r.mom_30, 'avoid': r.avoid, 'fanToken': bool(r.fan_token),
                               'hasPerp': bool(r.has_perp), 'upbitKrw': bool(r.upbit_krw), 'monitoring': bool(r.monitoring)}})
    return out


def clean(o):
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, set):
        return sorted(o)
    return o


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--state', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--as-of', default=None)
    a = ap.parse_args()
    run_at = pd.Timestamp.now(tz='UTC').strftime('%Y-%m-%dT%H:%M:%SZ')
    as_of = a.as_of or (pd.Timestamp.now(tz='UTC').normalize() - pd.Timedelta(days=1)).strftime('%Y-%m-%d')
    state = json.loads(Path(a.state).read_text())
    market = fetch_market(as_of)
    models = fit_models(load_training())
    U, L, perp_ok = rank_today(market, as_of, models)
    # Order books only for what is shown (and what would be shown).
    show = set(L[L.eligible].nsmallest(TOP_N, 'inflow_rank').pair) | set(L[L.eligible].nsmallest(TOP_N, 'spike_rank').pair)
    depth = {p: book_depth(p) for p in sorted(show)}
    # Score matured rows: live pairs from today's fetch, delisted ones from the archive.
    last_day = pd.Timestamp(as_of)
    scores = []
    open_rows = state.get('open') or []
    delisted_pairs = {r['pair'] for r in open_rows if r['pair'] not in market['pairs']}
    archive = {p: archive_klines(p, min(r['as_of'] for r in open_rows if r['pair'] == p)) for p in sorted(delisted_pairs)}
    stopped = {p for p, b in archive.items() if b is None or b.index[-1] < last_day - pd.Timedelta(days=3)}
    for r in open_rows:
        if r['pair'] in delisted_pairs and r['pair'] not in stopped:
            continue                                              # halted, not delisted: wait
        dl = r['pair'] in delisted_pairs
        bars = archive.get(r['pair']) if dl else market['klines'].get(r['pair'])
        if bars is not None:
            bars = bars.loc[:last_day]
        o = score_row(r, bars, last_day, dl)
        if o:
            scores.append({'as_of': r['as_of'], 'symbol': r['symbol'], **o})
    # The record includes what was just scored.
    scored = {(s['as_of'], s['symbol']): dict(s) for s in state.get('scored') or []}
    for s in scores:
        k = (s['as_of'], s['symbol'])
        base = scored.get(k) or next((dict(r) for r in open_rows if (r['as_of'], r['symbol']) == k), {})
        base.update({kk: v for kk, v in s.items() if kk in ('fwd_qv_ratio', 'inflow3x', 'max_close_mult', 'ret90', 'tp50', 'tp100', 'delisted')})
        scored[k] = base
    record = live_record(list(scored.values()))
    evidence = json.loads(EVIDENCE.read_text())
    summary = build_summary(as_of, run_at, U, L, market, record, depth, perp_ok, evidence)
    rows = ledger_rows(L, run_at)
    h = hashlib.sha256(json.dumps(clean(rows), sort_keys=True).encode()).hexdigest()[:16]
    out = clean({'version': VERSION, 'asOf': as_of, 'runAt': run_at, 'inputHash': h, 'rows': rows, 'scores': scores, 'summary': summary})
    Path(a.output).write_text(json.dumps(out))
    print(f'lowcap watch {as_of}: {len(U)} ranked, {len(L)} low caps (<= ${summary["universe"]["mcapCeiling"] / 1e6:.1f}M), '
          f'{int(L.eligible.sum())} eligible, {len(summary["avoid"])} to avoid; {len(scores)} rows scored; '
          f'inflow {summary["inflowWatch"]["status"]}, spike {summary["spike"]["status"]}; sources {summary["sources"]}')


if __name__ == '__main__':
    main()
