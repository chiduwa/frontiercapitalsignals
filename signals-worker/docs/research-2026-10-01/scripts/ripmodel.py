"""Can a rip (coin beats the market by >20% in the 24h after an exhaustion print)
be told apart BEFORE it happens? Logistic fit on the discovery half only,
judged on the validation half."""
import numpy as np, pandas as pd
E = pd.read_pickle("events_ep.pkl")
E = E[E.exc24.notna()].copy()
E["day"] = pd.to_datetime(E.t, unit="ms").dt.floor("D")
lg = lambda x: np.log10(np.clip(x, 1e-6, None))
F = {
  "log_turn": lg(E.turn_proxy), "log_mcap": lg(E.mcap_proxy), "log_base_turn": lg(24 * E.liq30 / E.mcap_proxy),
  "run24Z": E.run24Z.clip(-5, 20), "barZ": E.barZ.clip(-5, 20), "volZ": E.volZ.clip(-5, 10),
  "log_vol24x": lg(E.vol24_x), "k_in_ep": np.log1p(E.k_in_ep), "vs_first": E.vs_first.clip(-1, 3),
  "dd365": E.dd365, "brk90": E.brk90.clip(-1, 2), "ret30d": E.ret30d.clip(-1, 5),
  "taker": E.taker, "mkt72": E.mkt72_before, "log_perp_x": lg(E.perp_x), "funding": E.funding.clip(-0.01, 0.01) * 1000,
}
X = pd.DataFrame(F, index=E.index)
y = (E.exc24 > 0.20).astype(float).values
A = (E.day < pd.Timestamp("2025-05-29")).values
med = X[A].median(); X = X.fillna(med)
mu, sd = X[A].mean(), X[A].std(); Z = ((X - mu) / sd).values
Z = np.c_[np.ones(len(Z)), Z]

def fit(Z, y, lam=1.0):
    w = np.zeros(Z.shape[1])
    for _ in range(50):
        p = 1 / (1 + np.exp(-Z @ w)); W = p * (1 - p)
        H = Z.T @ (Z * W[:, None]) + lam * np.eye(len(w)); H[0, 0] -= lam
        g = Z.T @ (p - y) + lam * np.r_[0, w[1:]]
        w -= np.linalg.solve(H, g)
    return w
def auc(s, y):
    r = pd.Series(s).rank().values; n1 = y.sum(); n0 = len(y) - n1
    return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)

w = fit(Z[A], y[A])
print("coef (standardized, fit on discovery half):")
for k, v in sorted(zip(X.columns, w[1:]), key=lambda kv: -abs(kv[1])): print(f"  {k:14s} {v:+.3f}")
s = Z @ w
print(f"AUC discovery {auc(s[A], y[A]):.3f}   validation {auc(s[~A], y[~A]):.3f}   base rip rate A {y[A].mean():.3f} B {y[~A].mean():.3f}")
B = E[~A].copy(); B["score"] = s[~A]
B["dec"] = pd.qcut(B.score, 10, labels=False)
out = B.groupby("dec").agg(n=("exc24", "size"), rip20=("exc24", lambda x: 100 * (x > .2).mean()),
    mean=("exc24", lambda x: 100 * x.mean()), median=("exc24", lambda x: 100 * x.median()),
    fell=("fwd24", lambda x: 100 * (x < 0).mean()), exc72=("exc72", lambda x: 100 * x.mean()))
print("\nvalidation half, by predicted rip-risk decile (9 = riskiest):"); print(out.round(2).to_string())
E["rip_score"] = s
cut = np.quantile(s[A], 0.9); E["rip_top10"] = s >= cut
E.to_pickle("events_rip.pkl"); np.save("rip_w.npy", w); pd.to_pickle((mu, sd, med, list(X.columns), cut), "rip_norm.pkl")
m = E[E.coin == "MOVR"]; m = m[m.t >= 1.7591e12]
print("\nMOVR this week, rip-score percentile vs discovery half:")
for t, sc in zip(pd.to_datetime(m.t, unit="ms"), m.rip_score): print(f"  {t}  pct {100*(s[A] < sc).mean():.0f}")
