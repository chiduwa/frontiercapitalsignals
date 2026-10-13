"""Santiment free tier (no key): dev_activity (full history, unrestricted) and social_volume_total
(free window is 1 year ending 30 days ago). Aliased batches keep it to ~50 calls of the
1,000/month free quota. Slugs map by ticker, confirmed by name similarity to the CMC name.
Output: raw/santiment.parquet (slug, sym, metric, date, value)."""
import json, os, re, sys, time, urllib.request
import pandas as pd
from common import RAW, load, UA

URL = 'https://api.santiment.net/graphql'


def gql(q):
    for i in range(4):
        try:
            req = urllib.request.Request(URL, data=json.dumps({'query': q}).encode(),
                                         headers={**UA, 'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=120) as r:
                rem = r.headers.get('x-ratelimit-remaining-month')
                return json.loads(r.read()), rem
        except Exception as e:
            print('retry', e, flush=True)
            time.sleep(30 * (i + 1))
    return None, None


def norm(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


projects = json.load(open(os.path.join(RAW, 'santiment_projects.json')))['data']['allProjects']
by_tick = {}
for p in projects:
    by_tick.setdefault((p['ticker'] or '').upper(), []).append(p)
cmc = {int(k): v for k, v in load('snap_cmc.json').items() if v}
cmap = {c['id']: c for c in load('cmc_map.json')}
choice = load('cmc_choice.json')
pairs = []
for sym, cid in choice.items():
    if not cid:
        continue
    c = cmap.get(cid) or {}
    name, tick = c.get('name') or (cmc.get(cid) or {}).get('name'), (c.get('symbol') or '').upper()
    cands = by_tick.get(tick, [])
    best = None
    for p in cands:
        a, b = norm(p['name']), norm(name)
        if a and b and (a == b or a in b or b in a or norm(p['slug']) == norm(c.get('slug'))):
            best = p
            break
    if best:
        pairs.append((sym, best['slug']))
print(len(pairs), 'of', sum(1 for v in choice.values() if v), 'pairs mapped to a Santiment slug', flush=True)

windows = {'dev_activity': ('2018-06-01T00:00:00Z', pd.Timestamp.utcnow().strftime('%Y-%m-%dT00:00:00Z')),
           'social_volume_total': ((pd.Timestamp.utcnow() - pd.Timedelta(days=364)).strftime('%Y-%m-%dT00:00:00Z'),
                                   (pd.Timestamp.utcnow() - pd.Timedelta(days=31)).strftime('%Y-%m-%dT00:00:00Z'))}
rows = []
slugs = sorted({s for _, s in pairs})
B = int(os.environ.get('SAN_BATCH', '20'))
for metric, (a, b) in windows.items():
    for i in range(0, len(slugs), B):
        chunk = slugs[i:i + B]
        iv = '7d' if metric == 'dev_activity' else '1d'
        q = '{ ' + ' '.join(
            f'a{j}: getMetric(metric: "{metric}") {{ timeseriesData(slug: "{s}", from: "{a}", to: "{b}", interval: "{iv}") {{ datetime value }} }}'
            for j, s in enumerate(chunk)) + ' }'
        j, rem = gql(q)
        data = (j or {}).get('data') or {}
        for k, v in data.items():
            if not v:
                continue
            s = chunk[int(k[1:])]
            for pt in v['timeseriesData']:
                rows.append((s, metric, pt['datetime'][:10], pt['value']))
        if j and j.get('errors'):
            print(metric, i, 'errors', str(j['errors'])[:200], flush=True)
        print(metric, i, 'rows', len(rows), 'month quota left', rem, flush=True)
        time.sleep(2)
S = pd.DataFrame(rows, columns=['slug', 'metric', 'date', 'value'])
S['date'] = pd.to_datetime(S.date)
S.to_parquet(os.path.join(RAW, 'santiment.parquet'))
json.dump(pairs, open(os.path.join(RAW, 'santiment_pairs.json'), 'w'))
print('santiment', S.slug.nunique(), 'slugs', len(S), 'rows', flush=True)
