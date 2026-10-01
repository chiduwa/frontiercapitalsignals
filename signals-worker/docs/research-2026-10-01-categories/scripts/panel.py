"""Daily panel: Binance spot closes (listed coins from 2019, plus delisted coins
from the 2024+ hourly archive), each coin's utility tags, and a primary tag.

Everything downstream works on log returns in excess of the equal-weight
market of all coins trading that day.
"""
import glob, json, os
import numpy as np, pandas as pd
from taxonomy import UTILITY
from curated import CRYPTO, CRYPTO_EXTRA_LABELS

HERE = os.path.dirname(os.path.abspath(__file__))
ARCH = "/private/tmp/claude-501/-Users-owner/b677f588-0ff8-4f26-8c37-a5e343026c67/scratchpad/exh/data"
MKTS = os.path.join(HERE, "..", "cg", "markets.json")
EXCLUDE = {"PAXG", "XAUT", "WBTC", "WBETH", "BETH", "STETH", "WSTETH", "BNSOL", "CBBTC", "WETH", "USDT", "USDC", "FDUSD", "TUSD", "DAI", "USDE", "USD1", "EURI", "AEUR"}

# Most specific first: when a coin has several uses, the first one listed here
# is its primary category for the indices.
PRIORITY = ["legacy", "stablecoin", "meme", "ai", "depin", "rwa", "gaming", "derivatives", "prediction", "lending", "dex",
            "liquid-staking", "yield", "oracle", "interop", "privacy", "nft", "social", "exchange", "payments", "money",
            "scaling", "gas", "staking", "mining", "infra", "governance"]
LABELS = {**{k: v[0] for k, v in UTILITY.items()}, **CRYPTO_EXTRA_LABELS}

def load_prices():
    closes = {}
    for f in glob.glob(os.path.join(HERE, "daily", "*.npz")):
        s = os.path.basename(f)[:-4]
        z = np.load(f)
        closes[s] = pd.Series(z["s"][:, 3], index=pd.to_datetime(z["t"], unit="ms"))
    # delisted coins: the hourly archive's last close of each UTC day
    for f in glob.glob(os.path.join(ARCH, "*.npz")):
        s = os.path.basename(f)[:-4]
        if s in closes: continue
        z = np.load(f)
        if "empty" in z.files: continue
        h = pd.Series(z["s"][:, 3], index=pd.to_datetime(z["s_t"], unit="ms"))
        closes[s] = h.resample("1D").last().dropna()
    P = pd.DataFrame(closes).sort_index()
    return P[[c for c in P.columns if c not in EXCLUDE and c not in tokenized_stocks()]]

def tokenized_stocks():
    """Binance 'bStocks' (tokenized equities and ETFs, listed from June 2026): not crypto."""
    out = set()
    p = os.path.join(HERE, "mem", "tokenized-stock.json")
    if os.path.exists(p): out |= {r["symbol"].upper() for r in json.load(open(p))}
    for m in json.load(open(MKTS)):
        if "tokenized stock" in (m.get("name") or "").lower(): out.add(m["symbol"].upper())
    return out

def tags_by_symbol():
    """Utility tags per Binance symbol: curated first, else from CoinGecko category membership."""
    mk = json.load(open(MKTS))
    best = {}
    for m in mk:                       # the largest coin wins a shared ticker
        s = m["symbol"].upper()
        if s not in best: best[s] = m["id"]
    by_id = {}
    for tag, (_, cats) in UTILITY.items():
        for c in cats:
            p = os.path.join(HERE, "mem", c + ".json")
            if not os.path.exists(p): continue
            for r in json.load(open(p)):
                by_id.setdefault(r["id"], set()).add(tag)
    out = {}
    for s, cid in best.items():
        if s in CRYPTO: out[s] = list(CRYPTO[s]); continue
        t = by_id.get(cid)
        if t: out[s] = sorted(t, key=PRIORITY.index)[:4]
    for s, t in CRYPTO.items(): out.setdefault(s, list(t))
    return out, best

def denom(sym):
    import re
    m = re.match(r"^(1000000|1000|1M)(.+)$", sym)
    return m.group(2) if m else sym

def primary(tags):
    return sorted(tags, key=PRIORITY.index)[0] if tags else None

def excess_returns(P, min_days=60, clip=0.5):
    R = np.log(P / P.shift(1))
    R = R.where(R.abs() < np.log(1 + clip) * 3)          # drop redenomination / relaunch jumps
    age = P.notna().cumsum()
    R = R.where(age > min_days)                            # a listing's first weeks are their own regime
    M = R.mean(axis=1, skipna=True).where(R.notna().sum(axis=1) >= 30)
    return R, M
