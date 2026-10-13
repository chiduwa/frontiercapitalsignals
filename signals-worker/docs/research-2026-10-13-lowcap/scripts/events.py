"""Parse catalyst events into (sym, date, kind) rows.

kinds:
  upbit_krw        Upbit opens a KRW market for the coin (new listing or BTC->KRW upgrade)
  upbit_caution    Upbit 'investment caution' designation (거래 유의 종목 지정)
  bn_perp          Binance USD-M perpetual launched (first archive day) for a coin already on spot
  bn_monitoring    Binance announcement adding/extending the Monitoring Tag naming the coin
  bn_delist        Binance announcement that it will delist the coin's spot pairs
  bn_support       Binance adds the coin to Earn/Margin/Convert/Futures/HODLer etc. (existing coin)
Output: raw/events.parquet
"""
import os, re, json
import pandas as pd
from common import RAW, load

uni = load('universe.json')
bases = {u['base'].upper(): u['sym'] for u in uni}
# Binance renamed a handful of tickers; the 1000x and old tickers map back to the pair.
bases.update({'1000' + b: s for b, s in list(bases.items())})
rows = []


def tickers(text):
    found = set(re.findall(r'\(([A-Z0-9]{2,15})\)', text))
    found |= set(re.findall(r'\b([A-Z0-9]{2,15})\b', text))
    return [bases[t] for t in found if t in bases]


# Upbit trade notices
for n in load('upbit_notices.json'):
    t, d = n['title'], pd.Timestamp(n['first_listed_at']).tz_convert('UTC').tz_localize(None).normalize()
    paren = re.findall(r'\(([A-Z0-9]{2,15})\)', t)
    syms = [bases[x] for x in paren if x in bases]
    if 'KRW' in t and ('디지털 자산 추가' in t or '신규 거래지원' in t or '마켓 추가' in t):
        kind = 'upbit_krw'
    elif '유의 종목 지정' in t and '해제' not in t and '연장' not in t:
        kind = 'upbit_caution'
    elif '거래지원 종료' in t:
        kind = 'upbit_delist'
    else:
        continue
    for s in syms:
        rows.append((s, d, kind, t))

# Binance announcements
SKIP_SUPPORT = re.compile(r'Will List|Delist|Monitoring|Removal|Remove|Notice of', re.I)
for a in load('binance_announcements.json'):
    t = a['title']
    d = pd.to_datetime(a['releaseDate'], unit='ms').normalize()
    syms = tickers(t)
    if not syms:
        continue
    if re.search(r'Monitoring Tag', t, re.I) and not re.search(r'Remov', t, re.I):
        kind = 'bn_monitoring'
    elif re.search(r'Binance Will Delist|Notice of Removal of Spot|Will Delist', t, re.I) and 'Futures' not in t and 'Alpha' not in t:
        kind = 'bn_delist'
    elif re.search(r'Perpetual', t, re.I) and re.search(r'Launch', t, re.I):
        kind = 'bn_perp_ann'
    elif not SKIP_SUPPORT.search(t) and re.search(r'Will Add|Adds|Introduc|Earn|Margin|Convert|HODLer|Launchpool|Megadrop|Simple Earn|Buy Crypto', t):
        kind = 'bn_support'
    else:
        continue
    for s in syms:
        rows.append((s, d, kind, t))

# Perp launch from the archive (exact date, independent of announcement parsing)
for s, d in load('perp_launch.json').items():
    sym = s[4:] if s.startswith('1000') and s[4:] in {u['sym'] for u in uni} else s
    rows.append((sym, pd.Timestamp(d), 'bn_perp', 'archive first day'))

E = pd.DataFrame(rows, columns=['sym', 'date', 'kind', 'title']).drop_duplicates(['sym', 'date', 'kind'])
E.to_parquet(os.path.join(RAW, 'events.parquet'))
print(E.groupby('kind').agg(n=('sym', 'size'), first=('date', 'min'), last=('date', 'max')))
