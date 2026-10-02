"""Darvas box theory on the always-tracked coins and the majors.

The box (Darvas 1960), built causally bar by bar:
  * a NEW HIGH: the bar's high is the highest of the last `lookback` bars
    (Darvas used new 52-week highs: 365 days for coins, 252 sessions for stocks;
    a 20-bar variant tests the looser "trading range" use of boxes)
  * the TOP is confirmed when 3 bars in a row fail to exceed that high
  * the BOTTOM is the lowest low after the top, confirmed when 3 bars in a row
    fail to undercut it
  * then: a close above the top is a BREAKOUT (buy), a close below the bottom a
    BREAKDOWN (sell / exit). A breakout starts the search for the next box.

Judged two ways, each in two periods (coins 2018-22 / 2023-26, stocks
2000-12 / 2013-26):
  1. the move after the signal against the same asset's average move over the
     same number of bars (excess), pooled per date, Newey-West t
  2. as Darvas traded it: buy the breakout, stop at the box bottom, raise the
     stop to each new box's bottom, net of costs; against buy-and-hold AND
     against the SAME exits entered on random bars (so the test is the entry,
     not the trailing stop)
"""
import glob, os, sys, json
import numpy as np, pandas as pd
from stats_util import nw_mean

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("DZ_DATA", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "reports", "day-zones"))   # fetch.py writes h1/ and d1s/ here (gitignored)
# the 2026-10-01 category study's Binance daily klines (its fetch_daily.py)
CAT = os.environ.get("CAT_DAILY", os.path.join(HERE, "..", "..", "research-2026-10-01-categories", "scripts", "daily"))
TRACKED = ["BTC", "ETH", "SOL", "XLM", "XRP", "HYPE", "HBAR", "ARB"]
MAJORS_CRYPTO = ["BNB", "DOGE", "ADA", "TRX", "LINK", "AVAX", "LTC", "BCH", "DOT"]
STOCKS = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "AVGO"]
HORIZONS = (1, 5, 10, 20)
COST = {"crypto": 0.001, "stock": 0.0005}        # per side


def daily_crypto(sym):
    if sym == "HYPE":
        return from_hourly("HYPE", "1D")
    z = np.load(f"{CAT}/{sym}.npz")
    df = pd.DataFrame(z["s"][:, :5], index=pd.to_datetime(z["t"], unit="ms"), columns=["o", "h", "l", "c", "v"])
    return df[df.c > 0]


def from_hourly(sym, rule):
    z = np.load(f"{DATA}/h1/{sym}.npz")
    h = pd.DataFrame(z["s"][:, :5], index=pd.to_datetime(z["t"], unit="ms"), columns=["o", "h", "l", "c", "v"])
    g = h.resample(rule, origin="epoch")
    out = pd.DataFrame({"o": g.o.first(), "h": g.h.max(), "l": g.l.min(), "c": g.c.last(), "v": g.v.sum(), "n": g.c.count()})
    full = 24 if rule == "1D" else int(rule[:-1])
    return out[out.n == full].drop(columns="n")


def daily_stock(sym):
    z = np.load(f"{DATA}/d1s/{sym}.npz")
    s = z["s"]
    df = pd.DataFrame(s[:, :5], index=pd.to_datetime(z["t"], unit="ms").normalize(), columns=["o", "h", "l", "c", "v"])
    if s.shape[1] > 5:                                   # split/dividend adjust OHLC by adjclose/close
        f = s[:, 5] / s[:, 3]
        for k in ("o", "h", "l", "c"): df[k] = df[k] * f
    df = df[(df.c > 0) & df.h.notna()]
    return df[df.index >= "2000-01-01"]


def boxes(df, lookback, confirm=3, vol_mult=None):
    """Causal Darvas state machine. Returns signal rows: (bar index, kind, top, bottom)."""
    h, l, c, v = df.h.values, df.l.values, df.c.values, df.v.values
    n = len(df)
    rollmax = pd.Series(h).rolling(lookback, min_periods=lookback).max().shift(1).values   # highest of the previous bars
    vavg = pd.Series(v).rolling(50, min_periods=20).mean().shift(1).values
    sig = []
    state, top, top_i, bot, bot_i, box = "seek", None, None, None, None, None
    for i in range(n):
        if box is not None:
            t, b = box
            if c[i] > t:
                if vol_mult is None or (np.isfinite(vavg[i]) and v[i] >= vol_mult * vavg[i]):
                    sig.append((i, "breakout", t, b))
                box, state = None, "seek"
            elif c[i] < b:
                sig.append((i, "breakdown", t, b))
                box, state = None, "seek"
            if box is not None: continue
        if state == "seek":
            if np.isfinite(rollmax[i]) and h[i] > rollmax[i]:
                state, top, top_i = "top", h[i], i
            continue
        if state == "top":
            if h[i] > top:
                top, top_i = h[i], i
            elif i - top_i >= confirm:
                state, bot, bot_i = "bottom", l[top_i + 1:i + 1].min(), top_i + 1 + int(np.argmin(l[top_i + 1:i + 1]))
            continue
        if state == "bottom":
            if h[i] > top:                                 # broke out before the bottom formed: a new high
                state, top, top_i = "top", h[i], i
                continue
            if l[i] < bot:
                bot, bot_i = l[i], i
            elif i - bot_i >= confirm:
                box, state = (top, bot), "boxed"
    return sig


def trade(df, entries, boxes_after, cost):
    """Darvas exits: stop at the entry box's bottom, raised to each later box's bottom.
    entries: list of (i, stop). Returns per-trade net log returns and bars held."""
    l, c, o = df.l.values, df.c.values, df.o.values
    out = []
    for i0, stop in entries:
        px = c[i0]
        j = i0 + 1
        exit_px = None
        while j < len(df):
            if j in boxes_after and boxes_after[j] > stop: stop = boxes_after[j]
            if l[j] <= stop:
                exit_px = min(o[j], stop) if o[j] < stop else stop
                break
            j += 1
        if exit_px is None: exit_px, j = c[-1], len(df) - 1
        out.append((np.log(exit_px / px) - 2 * cost, j - i0, df.index[i0]))
    return out


def run(assets, frame, lookback, vol_mult=None, split=None, label=""):
    rows, trades, rnd = [], [], []
    rng = np.random.default_rng(11)
    for sym, kind in assets:
        df = frame(sym)
        if len(df) < lookback + 60: continue
        sig = boxes(df, lookback, vol_mult=vol_mult)
        lc = np.log(df.c.values)
        for h in HORIZONS:
            fwd = np.r_[lc[h:] - lc[:-h], [np.nan] * h]
            base = pd.Series(fwd, index=df.index)
            for i, k, t, b in sig:
                if np.isfinite(fwd[i]):
                    per = "A" if df.index[i] < split[kind] else "B"
                    mu = base[(base.index < split[kind]) if per == "A" else (base.index >= split[kind])].mean()
                    rows.append(dict(sym=sym, kind=kind, date=df.index[i].normalize(), sig=k, h=h, fwd=fwd[i], excess=fwd[i] - mu, per=per))
        # Darvas trades: every breakout, stop at its box bottom; each later confirmed box bottom raises the stop
        later = {i: b for i, k, t, b in sig}                 # the bar a box resolves carries that box's bottom
        bo = [(i, b) for i, k, t, b in sig if k == "breakout"]
        tr = trade(df, bo, later, COST[kind])
        for r_, held, d in tr: trades.append(dict(sym=sym, kind=kind, ret=r_, held=held, per="A" if d < split[kind] else "B"))
        # the same exits, entered on random bars: same count, same stop distance as a share of price
        if bo:
            gaps = [np.log(df.c.values[i] / b) for i, b in bo]
            for rep in range(20):
                idx = rng.choice(np.arange(lookback, len(df) - 2), size=len(bo), replace=False)
                ent = [(i, df.c.values[i] * np.exp(-g)) for i, g in zip(idx, rng.permutation(gaps))]
                for r_, held, d in trade(df, ent, later, COST[kind]):
                    rnd.append(dict(sym=sym, kind=kind, ret=r_, held=held, per="A" if d < split[kind] else "B"))
    return pd.DataFrame(rows), pd.DataFrame(trades), pd.DataFrame(rnd)


def report(S, T, Rn, label):
    print(f"\n### {label}")
    if S.empty: print("   no signals"); return
    print("   signal -> excess move over the next h bars vs the asset's own average (pooled per date, Newey-West t)")
    for k in ("breakout", "breakdown"):
        line = []
        for h in HORIZONS:
            cell = []
            for per in ("A", "B"):
                s = S[(S.sig == k) & (S.h == h) & (S.per == per)]
                if len(s) < 10: cell.append(f"{per} n<10"); continue
                daily = s.groupby("date").excess.mean()
                m, t, n = nw_mean(daily.values, lags=h)
                hit = (s.fwd > 0).mean()
                cell.append(f"{per} {m * 100:+.2f}% t{t:+.1f} up {hit:.0%} n{len(s)}")
            line.append(f"h={h}: " + ", ".join(cell))
        print(f"   {k:9s} " + " | ".join(line))
    if T.empty: return
    print("   Darvas trades (buy breakout, trailing box-bottom stop, net of costs) vs the same exits on random entries")
    for per in ("A", "B"):
        t, r = T[T.per == per], Rn[Rn.per == per]
        if len(t) < 5: continue
        diff = t.ret.mean() - r.ret.mean()
        se = np.sqrt(t.ret.var() / len(t) + r.ret.var() / len(r))
        print(f"     {per}: {len(t)} trades, mean {t.ret.mean() * 100:+.2f}% (median {t.ret.median() * 100:+.2f}%, win {(t.ret > 0).mean():.0%}, held {t.held.median():.0f} bars) "
              f"| random entries {r.ret.mean() * 100:+.2f}% (win {(r.ret > 0).mean():.0%}) | entry edge {diff * 100:+.2f}% per trade, t {diff / se:+.2f}")


if __name__ == "__main__":
    split = {"crypto": pd.Timestamp("2023-01-01"), "stock": pd.Timestamp("2013-01-01")}
    sets = {
        "always-tracked coins, daily": [(s, "crypto") for s in TRACKED],
        "major coins, daily": [(s, "crypto") for s in MAJORS_CRYPTO],
        "major stocks and ETFs, daily": [(s, "stock") for s in STOCKS],
    }
    frames = {"crypto": daily_crypto, "stock": daily_stock}
    out = {}
    for name, assets in sets.items():
        kind = assets[0][1]
        fr = frames[kind]
        for lb_name, lb in (("52-week-high boxes (classic)", 365 if kind == "crypto" else 252), ("20-bar boxes", 20)):
            for vm in (None, 1.5):
                S, T, Rn = run(assets, fr, lb, vol_mult=vm, split=split)
                lab = f"{name}: {lb_name}{', breakout volume >= 1.5x its 50-bar average' if vm else ''}"
                report(S, T, Rn, lab)
                out[lab] = {"signals": len(S), "trades": len(T)}
    # 4-hour boxes on the always-tracked coins
    four = lambda s: from_hourly(s, "4h")
    for lb_name, lb in (("new 90-day-high boxes", 540), ("20-bar boxes", 20)):
        S, T, Rn = run([(s, "crypto") for s in TRACKED], four, lb, split=split)
        report(S, T, Rn, f"always-tracked coins, 4-hour bars: {lb_name}")
    # buy and hold, for scale
    print("\n### buy and hold, mean daily log return x 365 (coins) / 252 (stocks), by period")
    for sym, kind in [(s, "crypto") for s in TRACKED + MAJORS_CRYPTO] + [(s, "stock") for s in STOCKS]:
        df = frames[kind](sym)
        r = np.log(df.c).diff()
        a, b = r[r.index < split[kind]], r[r.index >= split[kind]]
        k = 365 if kind == "crypto" else 252
        print(f"   {sym:5s} A {a.mean() * k * 100:+6.1f}%/yr  B {b.mean() * k * 100:+6.1f}%/yr")
