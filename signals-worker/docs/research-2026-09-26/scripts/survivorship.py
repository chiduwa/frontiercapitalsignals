"""How much of each year's filers are still listed today, by profitability.
Free price data only covers today's listings, so this is the size of the gap
the backtest cannot see."""
import json, os
import pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__))
F = pd.read_pickle(os.path.join(HERE, "fundamentals.pkl"))
tx = json.load(open(os.path.join(HERE, "tickers_exchange.json")))
listed = {r[0] for r in tx["data"] if r[3] in ("Nasdaq", "NYSE", "NYSE American", "CBOE", "NYSE Arca")}
by = {cik: dict(zip(g.cq.astype(int), g.ni)) for cik, g in F.groupby("cik")}
for year in (2017, 2019, 2021, 2023, 2025):
    k = year * 4 + 1
    rows = []
    for cik, g in by.items():
        last = k if k in g else (k - 1 if (k - 1) in g else None)
        if last is None: continue
        q = [last - i for i in range(8)]
        if not all(x in g for x in q): continue
        rows.append((sum(g[x] for x in q[:4]) > 0, cik in listed))
    d = pd.DataFrame(rows, columns=["profitable", "listed_now"])
    for p in (True, False):
        s = d[d.profitable == p]
        print(f"{year} Q2 filers, {'profitable  ' if p else 'unprofitable'}: n={len(s):5d}  exchange-listed today {s.listed_now.mean()*100:4.0f}%")
