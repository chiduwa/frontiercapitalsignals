"""Point-in-time snapshot of the live Binance universe for the ranking (not used in the backtest):
- spot order book (data-api mirror, 5000 levels): USD needed to lift the price +2/5/10/20/50%
- CMC detail: watchers, holders, links, tags, launch date, supply, ATH/52w stats
- CoinGecko (Demo key): watchlist users, sentiment votes, categories (incl. VC portfolios)
Outputs raw/snap_depth.json, raw/snap_cmc.json, raw/snap_cg.json."""
import os, sys, time
import concurrent.futures as cf
from common import get, load, dump

CG_KEY = os.environ.get('COINGECKO_API_KEY', '')
prod = load('bapi_products.json')
uni = [p for p in prod if p['q'] == 'USDT' and not {'bStocks', 'tCommodities', 'stablecoin'} & set(p.get('tags') or [])]
pairs = {p['marketPair'].replace('/', ''): p for p in load('cmc_binance_pairs.json') if p.get('quoteSymbol') == 'USDT'}
lanes = sys.argv[1:] or ['depth', 'cmc', 'cg']


def depth(sym):
    j = get(f'https://data-api.binance.vision/api/v3/depth?symbol={sym}&limit=5000', pause=2.6)
    if not j or not j.get('asks') or not j.get('bids'):
        return sym, None
    asks = [(float(p), float(q)) for p, q in j['asks']]
    bids = [(float(p), float(q)) for p, q in j['bids']]
    mid = (asks[0][0] + bids[0][0]) / 2
    out = {'mid': mid, 'spread_bp': (asks[0][0] - bids[0][0]) / mid * 1e4, 'ask_levels': len(asks),
           'ask_max_pct': (asks[-1][0] / mid - 1) * 100, 'bid_max_pct': (1 - bids[-1][0] / mid) * 100}
    for pct in (2, 5, 10, 20, 50):
        out[f'ask_usd_{pct}'] = sum(p * q for p, q in asks if p <= mid * (1 + pct / 100))
        out[f'bid_usd_{pct}'] = sum(p * q for p, q in bids if p >= mid * (1 - pct / 100))
    return sym, out


def cmc(cid):
    j = get(f'https://api.coinmarketcap.com/data-api/v3/cryptocurrency/detail?id={cid}', pause=0.3)
    d = (j or {}).get('data')
    if not d:
        return cid, None
    keep = ['id', 'name', 'symbol', 'slug', 'category', 'dateAdded', 'dateLaunched', 'status', 'watchCount',
            'watchListRanking', 'tags', 'urls', 'statistics', 'holders', 'cryptoRating', 'upcoming',
            'supplyDetails', 'isInfiniteMaxSupply', 'selfReportedCirculatingSupply', 'platforms',
            'volume', 'cexVolume', 'dexVolume', 'notice', 'description', 'profileCompletionScore']
    return cid, {k: d.get(k) for k in keep}


if 'depth' in lanes:
    res = {}
    with cf.ThreadPoolExecutor(1) as ex:
        for s, o in ex.map(depth, [p['s'] for p in uni]):
            res[s] = o
    dump(res, 'snap_depth.json')
    print('depth', sum(1 for v in res.values() if v), 'of', len(res), flush=True)

if 'cmc' in lanes:
    ids = sorted({pairs[p['s']]['baseCurrencyId'] for p in uni if p['s'] in pairs})
    res = {}
    with cf.ThreadPoolExecutor(3) as ex:
        for cid, o in ex.map(cmc, ids):
            res[cid] = o
    dump(res, 'snap_cmc.json')
    print('cmc', sum(1 for v in res.values() if v), 'of', len(res), flush=True)

if 'cg' in lanes and CG_KEY:
    H = {'x-cg-demo-api-key': CG_KEY}
    tick, page = [], 1
    while page < 30:
        j = get(f'https://api.coingecko.com/api/v3/exchanges/binance/tickers?page={page}&order=volume_desc', headers=H, pause=2.5)
        t = (j or {}).get('tickers') or []
        tick += t
        if len(t) < 100:
            break
        page += 1
    cg_id = {}
    for t in tick:
        if t.get('target') == 'USDT' and t.get('coin_id'):
            cg_id[t['base'] + 'USDT'] = t['coin_id']
    res = {}
    for p in uni:
        cid = cg_id.get(p['s'])
        mc = (p.get('cs') or 0) * float(p['c'])
        if not cid or mc > 300e6:
            continue
        j = get(f'https://api.coingecko.com/api/v3/coins/{cid}?localization=false&tickers=false&market_data=true'
                '&community_data=true&developer_data=true&sparkline=false', headers=H, pause=2.5)
        if j:
            md = j.get('market_data') or {}
            res[p['s']] = {'cg_id': cid, 'categories': j.get('categories'), 'watchlist_users': j.get('watchlist_portfolio_users'),
                           'sentiment_up': j.get('sentiment_votes_up_percentage'), 'genesis': j.get('genesis_date'),
                           'links': {k: j.get('links', {}).get(k) for k in ('homepage', 'twitter_screen_name', 'telegram_channel_identifier', 'subreddit_url', 'repos_url')},
                           'fdv': md.get('fully_diluted_valuation', {}).get('usd'), 'mcap': md.get('market_cap', {}).get('usd'),
                           'total_supply': md.get('total_supply'), 'max_supply': md.get('max_supply'), 'circ': md.get('circulating_supply'),
                           'ath_date': md.get('ath_date', {}).get('usd'), 'ath_chg': md.get('ath_change_percentage', {}).get('usd'),
                           'atl_date': md.get('atl_date', {}).get('usd'), 'atl_chg': md.get('atl_change_percentage', {}).get('usd'),
                           'community': j.get('community_data'), 'developer': j.get('developer_data')}
    dump({'map': cg_id, 'coins': res}, 'snap_cg.json')
    print('cg', len(res), 'coins', flush=True)
