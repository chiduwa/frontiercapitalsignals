import json, re, time, urllib.request, urllib.error, os, sys
S = '.'
d = json.load(open(f'{S}/alerts.json'))[0]['results']
rows = []
for r in d:
    if r['cls'] == 'stock': continue
    m = re.search(r'changed ([+-]?\d+\.\d)% ', r['message'])
    if not m: continue
    pct = float(m.group(1))
    rung = {}
    for lab, v in re.findall(r'vs (1h|3h|6h|1d) ago: ([+-]?\d+\.\d)%', r['message']):
        rung[lab] = float(v)
    rows.append(dict(symbol=r['symbol'], sent_at=r['sent_at'], pct=pct, rev='now reversing' in r['title'], rung=rung))
print(len(rows), sum(r['rev'] for r in rows))
cache = {}
def klines(sym, start, end):
    url = f'https://data-api.binance.vision/api/v3/klines?symbol={sym}USDT&interval=5m&startTime={start}&endTime={end}&limit=1000'
    for a in range(4):
        try:
            with urllib.request.urlopen(url, timeout=20) as f: return json.load(f)
        except urllib.error.HTTPError as e:
            if e.code == 400: return None
            time.sleep(2 + 3*a)
        except Exception: time.sleep(2 + 3*a)
    return None
out = []
for i, r in enumerate(rows):
    from datetime import datetime
    t = int(datetime.fromisoformat(r['sent_at'].replace('Z','+00:00')).timestamp()*1000)
    k = klines(r['symbol'], t - 2*3600_000, t + 49*3600_000 - 1)  # 51h of 5m = 612 bars
    r['t'] = t
    r['k'] = [[x[0], float(x[1]), float(x[2]), float(x[3]), float(x[4]), float(x[7])] for x in k] if k else None
    out.append(r)
    if i % 50 == 0: print(i, r['symbol'], bool(k), flush=True)
    time.sleep(0.12)
# BTC for the market control, whole span
t0 = min(r['t'] for r in out) - 3*3600_000; t1 = max(r['t'] for r in out) + 50*3600_000
btc = []
s = t0
while s < t1:
    k = klines('BTC', s, min(t1, s + 1000*300_000) - 1)
    btc += [[x[0], float(x[1]), float(x[4])] for x in k]
    s += 1000*300_000; time.sleep(0.12)
json.dump({'alerts': out, 'btc': btc}, open('live.json', 'w'))
print('done', sum(1 for r in out if r['k']), 'with bars')
