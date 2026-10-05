import json, time, urllib.request, urllib.error, os
from concurrent.futures import ThreadPoolExecutor
perps = json.load(open('perps.json'))
syms = sorted({p['symbol'] for p in perps} | {'BTC'})
START = 1719792000000; END = int(time.time()*1000)
def get(url):
    for a in range(5):
        try:
            with urllib.request.urlopen(url, timeout=30) as f: return json.load(f)
        except urllib.error.HTTPError as e:
            if e.code == 400: return None
            time.sleep(3 + 5*a)
        except Exception: time.sleep(3 + 5*a)
    return None
def one(s):
    fn = f'h1/{s}.json'
    if os.path.exists(fn): return s, -1
    bars, t = [], START
    while t < END:
        k = get(f'https://data-api.binance.vision/api/v3/klines?symbol={s}USDT&interval=1h&startTime={t}&limit=1000')
        if not k: break
        bars += [[x[0], float(x[1]), float(x[2]), float(x[3]), float(x[4]), float(x[7])] for x in k]
        t = k[-1][0] + 3600_000
        if len(k) < 1000: break
    json.dump(bars, open(fn, 'w'))
    return s, len(bars)
n = 0
with ThreadPoolExecutor(16) as ex:
    for s, nb in ex.map(one, syms):
        n += 1
        if n % 25 == 0: print(n, s, nb, flush=True)
print('symbols', len(syms), 'files', len(os.listdir('h1')), flush=True)
