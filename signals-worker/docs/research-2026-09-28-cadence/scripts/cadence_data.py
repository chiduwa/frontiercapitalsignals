"""Inputs for the cadence study, as two compact files in CAD_OUT:

hourly.npz   the largest coins' Binance SPOT hourly closes on one UTC grid,
             2024-09-01 to 2026-09-27 (fetch_spot.py's files, in DC_SPOT)
daily.npz    US stocks (sessions) and SPY from production's research panel
             (hier-panel.json, built by the overfitting study), and the panel's
             coins as Binance SPOT daily candles (UTC days) from 2021-01-01: at
             least 1,000 bars each. Pegged coins (stablecoins, gold tokens) and
             wrapped copies of other coins are left out: they have no rhythm of
             their own.

Why Binance for coins: the archive's daily crypto closes carry tickers that
different tokens used in different years (JUP and SKY in 2021 were other
coins), two tokens under one ticker (FLUID alternating between two prices),
and micro-priced coins rounded to 6 decimals (SHIB moving 1e-6 -> 2e-6). Each
prints a spike that reverts the next day, which looks exactly like a reversal.
A Binance pair is one token at full precision. Coins not on Binance spot
(BINANCE_TRADABLE, a JSON list) are left out rather than kept on archive data.

usage: DC_SPOT=/data/spot HIER=/path/hier-panel.json BINANCE_TRADABLE=/path/list.json CAD_OUT=/data/cad python cadence_data.py"""
import glob, json, os, time, urllib.request
import numpy as np

OUT = os.environ.get('CAD_OUT', '.')
os.makedirs(OUT, exist_ok=True)

# ---- hourly: spot bars of the largest coins
files = sorted(glob.glob(os.path.join(os.environ['DC_SPOT'], '*.npz')))
series = {}
for f in files:
    s = os.path.basename(f)[:-4]
    if s == 'decoupling_panel': continue
    k = np.load(f)['klines']
    if len(k) < 5000: continue
    series[s] = k
t0 = min(int(k[0, 0]) for k in series.values()); t1 = max(int(k[-1, 0]) for k in series.values())
H = 3600000
n = (t1 - t0) // H + 1
syms = sorted(series)
close = np.full((len(syms), n), np.nan); qv = np.full((len(syms), n), np.nan)
for j, s in enumerate(syms):
    k = series[s]; i = ((k[:, 0].astype(np.int64) - t0) // H).astype(int)
    close[j, i] = k[:, 4]; qv[j, i] = k[:, 6]
np.savez_compressed(os.path.join(OUT, 'hourly.npz'), syms=np.array(syms), t0=t0, close=close, qv=qv)
print(f'hourly: {len(syms)} coins, {n} hours from {np.datetime64(t0, "ms")}')

# ---- daily: production's research panel
PEGGED = {'USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDE', 'USDS', 'PYUSD', 'USD1', 'BUSD', 'USDP', 'GUSD', 'FRAX', 'LUSD',
          'USDD', 'RLUSD', 'USDX', 'SUSDS', 'SUSDE', 'USDY', 'BUIDL', 'USTB', 'USDTB', 'USYC', 'OUSG', 'EURC', 'XSGD',
          'PAXG', 'XAUT', 'KAU', 'KAG', 'BFUSD', 'USDF', 'USD0', 'DEUSD', 'CRVUSD', 'GHO', 'USR', 'USDG', 'USDAI', 'AUSD', 'USDO'}
WRAPPED = {'WBTC', 'WETH', 'STETH', 'WSTETH', 'WEETH', 'CBBTC', 'RETH', 'METH', 'EZETH', 'RSETH', 'WBETH', 'CBETH', 'BTCB',
           'LBTC', 'SOLVBTC', 'TBTC', 'JITOSOL', 'MSOL', 'BNSOL', 'JUPSOL', 'STSOL', 'WBNB', 'WTRX', 'WAVAX', 'WHYPE',
           'KHYPE', 'STHYPE', 'OSETH', 'SFRXETH', 'SWETH', 'ETHX', 'CMETH', 'LSETH', 'WEETH', 'CLBTC', 'BBTC', 'UNIBTC',
           'FBTC', 'SUSDE', 'SAVAX', 'STX.B', 'WBT', 'BGB', 'LEO', 'OKB', 'HT', 'KCS', 'GT', 'CRO'}
def binance_daily(sym, first='2021-01-01', last='2026-09-27'):
    t = int(np.datetime64(first + 'T00:00', 'ms').astype(np.int64)); end = int(np.datetime64(last + 'T00:00', 'ms').astype(np.int64))
    rows = []
    while t <= end:
        url = f'https://data-api.binance.vision/api/v3/klines?symbol={sym}USDT&interval=1d&startTime={t}&endTime={end}&limit=1000'
        for k in range(6):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'fcs-research'}), timeout=30) as r:
                    page = json.loads(r.read()); break
            except Exception:
                page = None; time.sleep(1.5 ** k)
        if not page: break
        rows += page
        if len(page) < 1000: break
        t = page[-1][0] + 86400000
    return rows


panel = json.load(open(os.environ['HIER']))
tradable = set(json.load(open(os.environ['BINANCE_TRADABLE'])))
out = {}; kept = []
for a in panel['assets']:
    s, cls, bars = a['symbol'], a['assetClass'], a['bars']
    if cls == 'market': continue                     # the archive's own index, built from the same closes
    if cls == 'crypto' and (s in PEGGED or s in WRAPPED or s not in tradable): continue
    if cls == 'crypto':
        k = binance_daily(s)
        bars = [{'date': str(np.datetime64(int(x[0]), 'ms').astype('datetime64[D]')), 'close': float(x[4])} for x in k]
    if len(bars) < 1000: continue
    d = np.array([np.datetime64(b['date'], 'D') for b in bars]); c = np.array([float(b['close'] or np.nan) for b in bars])
    ok = np.isfinite(c) & (c > 0)
    d, c = d[ok], c[ok]
    r = np.diff(np.log(c))
    if cls == 'crypto' and np.nanmedian(np.abs(r)) < 0.003: continue      # pegged, whatever it is called
    key = s if cls != 'market' else s.replace(':', '_')
    out[f'{key}|date'] = d.astype('datetime64[D]').astype(np.int64); out[f'{key}|close'] = c
    kept.append((key, cls if cls != 'benchmark' else 'market', len(c)))
np.savez_compressed(os.path.join(OUT, 'daily.npz'), syms=np.array([k[0] for k in kept]), cls=np.array([k[1] for k in kept]), **out)
by = {}
for _, c, _ in kept: by[c] = by.get(c, 0) + 1
print(f'daily: {len(kept)} series {by}')
