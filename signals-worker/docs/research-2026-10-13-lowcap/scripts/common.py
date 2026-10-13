"""Shared helpers for the 2026-10-13 low-cap spike study (keyless sources only)."""
import json, os, re, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..', 'reports', 'lowcap'))
RAW = os.path.join(ROOT, 'raw')
OUT = os.path.abspath(os.path.join(HERE, '..', 'results'))
os.makedirs(RAW, exist_ok=True)
os.makedirs(OUT, exist_ok=True)
UA = {'User-Agent': 'Mozilla/5.0 FCS research'}

# Not crypto risk assets: stablecoins, fiat, tokenised gold/stocks, leveraged tokens.
STABLE = {'USDC', 'BUSD', 'TUSD', 'FDUSD', 'USDP', 'DAI', 'EUR', 'GBP', 'AEUR', 'PAXG', 'XAUT', 'USD1',
          'XUSD', 'BFUSD', 'RLUSD', 'U', 'EURI', 'USDE', 'PYUSD', 'USDS', 'SUSD', 'UST', 'USTC', 'PAX',
          'BKRW', 'IDRT', 'BIDR', 'BVND', 'RWUSD', 'USDSB', 'TRY', 'BRL', 'AUD', 'RUB', 'NGN', 'UAH',
          'ZAR', 'PLN', 'RON', 'ARS', 'JPY', 'MXN', 'COP', 'CZK', 'USDT', 'WBTC', 'WBETH', 'BETH', 'BNSOL'}
LEVERAGED = re.compile(r'(UP|DOWN|BULL|BEAR)$')


def get(url, raw=False, tries=5, headers=None, pause=0.0):
    h = dict(UA)
    if headers:
        h.update(headers)
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=60) as r:
                b = r.read()
                if pause:
                    time.sleep(pause)
                return b if raw else json.loads(b)
        except urllib.error.HTTPError as e:
            if e.code in (400, 404, 410):
                return None
            time.sleep(3 * (i + 1) if e.code != 429 else 20 * (i + 1))
        except Exception:
            time.sleep(2 * (i + 1))
    return None


def dump(obj, name):
    with open(os.path.join(RAW, name), 'w') as f:
        json.dump(obj, f)


def load(name):
    with open(os.path.join(RAW, name)) as f:
        return json.load(f)
