"""Catalyst events: Binance announcements (listings, delistings, news incl. monitoring tags,
HODLer airdrops, perp launches), Upbit trade notices (KRW listings, caution flags), and
each pair's USD-M perpetual launch date from the public archive. Outputs in raw/."""
import re, time
import concurrent.futures as cf
from common import get, dump, load

# Binance CMS catalogs: 48 new listings, 161 delisting, 49 latest news, 93 latest activities.
arts = []
for cat in (48, 161, 49, 93):
    page = 1
    while True:
        j = get(f'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId={cat}&pageNo={page}&pageSize=50', pause=0.4)
        cs = ((j or {}).get('data') or {}).get('catalogs') or []
        got = [dict(a, catalogId=cat) for c in cs for a in c.get('articles', [])]
        arts += got
        if len(got) < 50 or page > 120:
            break
        page += 1
    print('binance catalog', cat, 'cumulative', len(arts), flush=True)
dump(arts, 'binance_announcements.json')

# Upbit notices (trade category = listings, caution designations, delistings).
ups, page = [], 1
while True:
    j = get(f'https://api-manager.upbit.com/api/v1/announcements?os=web&page={page}&per_page=20&category=trade', pause=0.3)
    ns = ((j or {}).get('data') or {}).get('notices') or []
    ups += ns
    tp = ((j or {}).get('data') or {}).get('total_pages') or 0
    if not ns or page >= tp:
        break
    page += 1
dump(ups, 'upbit_notices.json')
print('upbit notices', len(ups), flush=True)


# Perp launch date = first daily kline file of the USD-M symbol in the archive.
def first_perp(sym):
    x = get(f'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?prefix=data/futures/um/daily/klines/{sym}/1d/&max-keys=1', raw=True)
    if not x:
        return sym, None
    m = re.search(r'-1d-(\d{4}-\d{2}-\d{2})\.zip', x.decode())
    return sym, m.group(1) if m else None


syms = []
for u in load('universe.json'):
    syms += [u['sym'], '1000' + u['sym']]
perp = {}
with cf.ThreadPoolExecutor(12) as ex:
    for s, d in ex.map(first_perp, syms):
        if d:
            perp[s] = d
dump(perp, 'perp_launch.json')
print('perp launch dates', len(perp), flush=True)
