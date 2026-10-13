"""Universe: every Binance USDT spot pair ever listed (live + delisted), mapped to a CMC id.

Live pairs map through CMC's own Binance market-pair table (exact, no ticker guessing).
Delisted pairs map through CMC's full coin map by symbol; ambiguous symbols are resolved
later in fetch_cmc_history.py by checking the CMC price against the Binance close.
"""
import re
from common import get, dump, STABLE, LEVERAGED

# 1. Binance product feed: live pairs, circulating supply, Binance's own tags (incl. Monitoring/Seed).
prod = get('https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=false')['data']
dump(prod, 'bapi_products.json')

# 2. Every symbol that ever had spot klines in the public archive (delisted ones included).
prefixes, marker = [], ''
while True:
    x = get('https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?prefix=data/spot/monthly/klines/&delimiter=/'
            + ('&marker=' + marker if marker else ''), raw=True).decode()
    ps = re.findall(r'<Prefix>data/spot/monthly/klines/([^<]+)/</Prefix>', x)
    prefixes += ps
    if '<IsTruncated>true</IsTruncated>' not in x or not ps:
        break
    marker = 'data/spot/monthly/klines/' + ps[-1] + '/'
info = get('https://data-api.binance.vision/api/v3/exchangeInfo?permissions=SPOT')
live = {s['symbol']: s['baseAsset'] for s in info['symbols'] if s['quoteAsset'] == 'USDT' and s['status'] == 'TRADING'}
allsyms = sorted(set(p for p in prefixes if p.endswith('USDT')) | set(live))
rows = []
for s in allsyms:
    base = live.get(s, s[:-4])
    if not base.isascii() or base in STABLE or LEVERAGED.search(base):
        continue
    rows.append({'sym': s, 'base': base, 'live': s in live})
print(len(rows), 'USDT pairs;', sum(r['live'] for r in rows), 'live')

# 3. CMC's Binance spot market pairs -> exact base currency id for live pairs.
pairs, start = [], 1
while True:
    j = get(f'https://api.coinmarketcap.com/data-api/v3/exchange/market-pairs/latest?slug=binance&category=spot&start={start}&limit=1000')
    mp = (j or {}).get('data', {}).get('marketPairs', [])
    pairs += mp
    if len(mp) < 1000:
        break
    start += 1000
dump(pairs, 'cmc_binance_pairs.json')
pair_id = {p['marketPair'].replace('/', ''): p['baseCurrencyId'] for p in pairs if p.get('quoteSymbol') == 'USDT'}

# 4. CMC full coin map (active, inactive, untracked) for delisted pairs.
cmap, start = [], 1
while True:
    j = get(f'https://api.coinmarketcap.com/data-api/v3/map/all?listing_status=active,inactive,untracked&start={start}&limit=5000&exchangeAux=is_active&cryptoAux=is_active,status,first_historical_data,last_historical_data')
    cm = (j or {}).get('data', {}).get('cryptoCurrencyMap', [])
    cmap += cm
    if len(cm) < 5000:
        break
    start += 5000
dump(cmap, 'cmc_map.json')
by_sym = {}
for c in cmap:
    by_sym.setdefault(c['symbol'].upper(), []).append(c)

for r in rows:
    r['cmc_id'] = pair_id.get(r['sym'])
    cands = by_sym.get(r['base'].upper(), [])
    r['cmc_candidates'] = [c['id'] for c in cands]
dump(rows, 'universe.json')
print('mapped exactly:', sum(1 for r in rows if r['cmc_id']), '; symbol candidates for rest:',
      sum(1 for r in rows if not r['cmc_id'] and r['cmc_candidates']), '; none:',
      sum(1 for r in rows if not r['cmc_id'] and not r['cmc_candidates']))
