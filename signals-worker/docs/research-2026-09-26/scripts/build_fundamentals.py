"""Assemble per-company quarterly series from SEC XBRL frames.

Quarter values come from 3-month frames. Companies rarely tag a standalone Q4,
so a missing quarter is derived as (annual value - the three quarters inside
that annual period), matched on the records' real start/end dates rather than
on the frame labels: a September fiscal year's fourth quarter sits in the
CY..Q3 slot, and label arithmetic would subtract the wrong three quarters.

Output: fundamentals.pkl, one row per (cik, quarter end) with ni, rev, oi, eps
and the shares-outstanding instants, plus each quarter's calendar key."""
import glob, gzip, json, os
from collections import defaultdict
from datetime import date
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
FR = os.path.join(HERE, "frames")

def load(tag):
    """{cik: {(start, end): val}} for durations, {cik: {end: val}} for instants."""
    out = defaultdict(dict)
    for path in sorted(glob.glob(os.path.join(FR, f"{tag}__CY*.json.gz"))):
        d = json.loads(gzip.open(path).read())
        instant = path.endswith("I.json.gz")
        for r in d.get("data", []):
            try:
                key = r["end"] if instant else (r["start"], r["end"])
                out[r["cik"]][key] = float(r["val"])
            except Exception:
                continue
    return out

def days(a, b):
    return (date.fromisoformat(b) - date.fromisoformat(a)).days

def quarterly(tag_series):
    """{cik: DataFrame(end, start, val)} of 3-month values, Q4s derived."""
    out = {}
    for cik, recs in tag_series.items():
        q = {}
        annual = []
        for (s, e), v in recs.items():
            dur = days(s, e)
            if 80 <= dur <= 100:
                q[e] = (s, v)
            elif 350 <= dur <= 380:
                annual.append((s, e, v))
        for s, e, v in annual:
            inside = [(qe, qs, qv) for qe, (qs, qv) in q.items() if qs >= s and qe <= e]
            if len(inside) == 3:
                covered_end = max(x[0] for x in inside)
                # the missing quarter is the one ending at the annual end
                if covered_end < e and e not in q:
                    miss_start = covered_end  # approx: day after the last covered quarter
                    q[e] = (miss_start, v - sum(x[2] for x in inside))
        if q:
            out[cik] = pd.DataFrame([(e, s, v) for e, (s, v) in q.items()], columns=["end", "start", "val"]).sort_values("end")
    return out

print("loading frames...")
ni = quarterly(load("NetIncomeLoss"))
oi = quarterly(load("OperatingIncomeLoss"))
eps = quarterly(load("EarningsPerShareDiluted"))
rev_tags = {t: quarterly(load(t)) for t in ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet")}
shares = load("EntityCommonStockSharesOutstanding")
print(f"companies with quarterly net income: {len(ni):,}")

def cal_key(end):
    d = date.fromisoformat(end)
    # a quarter ending within the first ~10 days of a month belongs to the prior month's quarter
    m = d.month - (1 if d.day <= 10 else 0)
    y = d.year
    if m == 0:
        m, y = 12, y - 1
    return y * 4 + (m - 1) // 3   # integer calendar-quarter index

rows = []
for cik, dfq in ni.items():
    base = {cal_key(e): (e, v) for e, v in zip(dfq.end, dfq.val)}
    def lookup(series):
        s = series.get(cik)
        return {} if s is None else {cal_key(e): v for e, v in zip(s.end, s.val)}
    o = lookup(oi); p = lookup(eps)
    r = {}
    for t in ("SalesRevenueNet", "RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues"):
        r.update(lookup(rev_tags[t]))   # later tags win: Revenues preferred
    for k, (e, v) in base.items():
        rows.append((cik, k, e, v, r.get(k), o.get(k), p.get(k)))
F = pd.DataFrame(rows, columns=["cik", "cq", "end", "ni", "rev", "oi", "eps"])
F = F.sort_values(["cik", "cq"]).drop_duplicates(["cik", "cq"], keep="last")
F.to_pickle(os.path.join(HERE, "fundamentals.pkl"))
S = pd.DataFrame([(cik, e, v) for cik, d in shares.items() for e, v in d.items()], columns=["cik", "date", "shares"])
S.to_pickle(os.path.join(HERE, "shares.pkl"))
print(f"wrote {len(F):,} company-quarters for {F.cik.nunique():,} companies; {len(S):,} share-count instants")
print(F[F.cik == 320193].tail(8).to_string())
