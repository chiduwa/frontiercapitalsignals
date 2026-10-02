"""Shared statistics for the rotation study (same estimators as the 2026-10-01
category study, so the numbers compare)."""
import numpy as np, pandas as pd


def nw_ols(y, X, lags=None):
    """OLS with a constant and Newey-West (Bartlett) standard errors.
    Returns (coefficients, t statistics, n), constant first."""
    y = np.asarray(y, float)
    X = np.asarray(X, float)
    if X.ndim == 1: X = X[:, None]
    X = np.c_[np.ones(len(y)), X]
    ok = np.isfinite(y) & np.isfinite(X).all(1)
    y, X = y[ok], X[ok]
    n, p = X.shape
    if n < max(20, 3 * p): return np.full(p, np.nan), np.full(p, np.nan), n
    b = np.linalg.lstsq(X, y, rcond=None)[0]
    e = y - X @ b
    L = lags if lags is not None else int(4 * (n / 100) ** (2 / 9))
    XtX = np.linalg.pinv(X.T @ X)
    Xe = X * e[:, None]
    S = Xe.T @ Xe
    for l in range(1, L + 1):
        w = 1 - l / (L + 1)
        G = Xe[l:].T @ Xe[:-l]
        S += w * (G + G.T)
    V = XtX @ S @ XtX
    return b, b / np.sqrt(np.diag(V)), n


def nw_mean(x, lags=None):
    b, t, n = nw_ols(np.asarray(x, float), np.zeros((len(x), 0)), lags)
    return b[0], t[0], n


def blocks(s, k, start):
    """Sum a daily series over non-overlapping k-day blocks anchored at start.
    A block with any missing day is missing."""
    s = s[s.index >= start]
    g = (np.arange(len(s)) // k)
    full = s.notna().groupby(g).sum() == k
    out = s.groupby(g).sum().where(full)
    out.index = s.index[::k][: len(out)]
    return out


def fama_macbeth(panel, y, xs, date="date", min_n=8):
    """Per-date cross-sectional OLS, then the mean slope with a Newey-West t
    over dates. Returns {x: (mean slope, t, dates)}."""
    rows = []
    for d, g in panel.groupby(date):
        g = g[[y] + xs].replace([np.inf, -np.inf], np.nan).dropna()
        if len(g) < max(min_n, len(xs) + 3): continue
        X = np.c_[np.ones(len(g)), g[xs].values]
        b = np.linalg.lstsq(X, g[y].values, rcond=None)[0]
        rows.append([d] + list(b[1:]))
    if not rows: return {x: (np.nan, np.nan, 0) for x in xs}
    B = pd.DataFrame(rows, columns=[date] + xs).set_index(date).sort_index()
    return {x: nw_mean(B[x].values) for x in xs}


def rank_cs(df, cols, by="date"):
    """Within-date percentile ranks (0..1), so features are on one scale and a
    single absurd print cannot drive a regression."""
    out = df.copy()
    for c in cols:
        out[c] = df.groupby(by)[c].rank(pct=True)
    return out
