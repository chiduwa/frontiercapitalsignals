"""Binance grid-bot replay on the FCS research panel.

Spot grid: geometric levels, equal quote per grid, the slots above the launch
price are bought at launch, every fill pays a fee. Neutral futures grid: the
same fills from a flat start, so its P&L is the spot grid's P&L less the P&L
of the launch inventory, plus funding on the net position.

The benchmark is "hold the launch inventory". A grid's excess over it is what
the grid trading itself added: under a random walk, zero less fees.
"""
import datetime as dt, gzip, json, os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.normpath(os.path.join(HERE, "..", ".."))
PANEL = os.path.join(DOCS, "research-2026-09-23-sequence", "panel.json.gz")
STABLE = os.path.join(DOCS, "research-2026-09-19", "stable-basket-panel.json.gz")
HOURLY = os.path.normpath(os.path.join(DOCS, "..", "..", "multi-market-bot", "research", "2026-09-11-data.json"))
RESULTS = os.path.normpath(os.path.join(HERE, "..", "results"))


def load_panel():
    """Daily OHLC per coin, and Binance funding (daily mean of the 8h rates).

    Yahoo rows carry no open; a 24/7 market opens at the prior close. ARB's
    CoinGecko rows track a different series from its Binance rows, so only
    the contiguous Binance block is kept. HYPE is close-only.
    """
    d = json.load(gzip.open(PANEL))
    out = {}
    for a in d["assets"]:
        if a["assetClass"] != "crypto":
            continue
        raw = a["bars"]
        if a["symbol"] == "ARB":
            raw = [b for b in raw if b["source"] == "binance"]
            keep = [raw[0]]
            for b in raw[1:]:
                if (dt.date.fromisoformat(b["date"]) - dt.date.fromisoformat(keep[-1]["date"])).days != 1:
                    break
                keep.append(b)
            raw = keep
        bars, prev = [], None
        for b in raw:
            c = b["close"]
            if not c:
                continue
            o = b["open"] or prev or c
            h = max(b["high"] or c, o, c)
            l = min(b["low"] or c, o, c)
            bars.append((b["date"], o, h, l, c))
            prev = c
        out[a["symbol"]] = {
            "date": [b[0] for b in bars],
            "o": np.array([b[1] for b in bars]), "h": np.array([b[2] for b in bars]),
            "l": np.array([b[3] for b in bars]), "c": np.array([b[4] for b in bars]),
        }
    fund = {s: {r["date"]: r["funding_rate"] for r in rows} for s, rows in d["funding"].items()}
    return out, fund


def bar_path(o, h, l, c):
    """Path through a bar: an up bar visits its low first."""
    return (o, l, h, c) if c >= o else (o, h, l, c)


def build_path(a):
    path, day = [], []
    for i in range(len(a["c"])):
        for p in bar_path(a["o"][i], a["h"][i], a["l"][i], a["c"][i]):
            path.append(p); day.append(i)
    return np.array(path), np.array(day)


def geometric_range(p0, sigma, horizon, k):
    w = k * sigma * np.sqrt(horizon)
    return p0 * np.exp(-w), p0 * np.exp(w)


def grid_count(lo, hi, step):
    return max(2, int(round(np.log(hi / lo) / np.log(1 + step))))


def run_grid(path, day, lo, hi, n, funding=None):
    """Replay one grid, fee-free; fees are applied afterwards from `notional`.

    Returns outcomes per unit of starting capital.
    """
    levels = lo * (hi / lo) ** (np.arange(n + 1) / n)
    qty = (1.0 / n) / levels[:-1]
    p0 = path[0]
    holding = levels[:-1] >= p0
    launch = float((qty[holding] * p0).sum())
    base0 = float(qty[holding].sum())
    cash, base = 1.0 - launch, base0
    notional = fund = 0.0
    trips = in_range = 0
    last_day = day[0]
    for k in range(1, len(path)):
        a, b = path[k - 1], path[k]
        if b > a:
            hit = (levels[1:] > a) & (levels[1:] <= b) & holding
            if hit.any():
                v = float((qty[hit] * levels[1:][hit]).sum())
                cash += v; notional += v; base -= float(qty[hit].sum())
                holding[hit] = False; trips += int(hit.sum())
        elif b < a:
            hit = (levels[:-1] < a) & (levels[:-1] >= b) & ~holding
            if hit.any():
                v = float((qty[hit] * levels[:-1][hit]).sum())
                cash -= v; notional += v; base += float(qty[hit].sum())
                holding[hit] = True
        in_range += lo <= b <= hi
        if funding is not None and day[k] != last_day:
            fund += (base - base0) * b * funding[day[k]] * 3   # longs pay when positive
            last_day = day[k]
    end = path[-1]
    hold = (1.0 - launch) + base0 * end
    return {
        "equity": cash + base * end, "hold": hold, "excess": cash + base * end - hold,
        "hodl": end / p0 - 1.0, "launch": launch, "notional": notional, "fund": fund,
        "trips": trips, "in_range": in_range / (len(path) - 1),
        "below": end < lo, "above": end > hi,
    }
