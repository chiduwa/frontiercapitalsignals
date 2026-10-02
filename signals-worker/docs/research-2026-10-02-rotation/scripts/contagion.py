"""Does a coin's category (or size tier) moving hard today make the coin's own
big move (>= 12% within two days, either way) more likely, beyond what the
big-move watch already knows?

The watch's own features are computed by importing production's
scripts/big-move-watch.py (coin_features, panel), so the baseline is exactly
what runs. Candidate features are computed at the same close from the same
bars, leave-one-out (a coin is never its own peer):

  catAbsR1     mean |1-day move| of the coin's category peers
  catBig1      share of peers that moved >= 8% today
  catVolRatio  median log volume ratio of peers (volume surge)
  catVolExp    mean 5-day / 60-day volatility of peers
  catR5        mean 5-day move of peers (signed)
  catBurst     catAbsR1 minus the whole market's median |move| (category-specific)
  tierAbsR1    mean |1-day move| of the coin's size-tier peers
  relCatR5     the coin's 5-day move minus its peers'

Test 1 (here): per-day linear probability regressions on within-day ranks,
watch features as controls, Newey-West t over days, by period.
Test 2 (contagion_wf.py): the watch's own LightGBM walked forward with and
without the candidates, top 10 per day.
"""
import importlib.util, os, sys
import numpy as np, pandas as pd
from rot_panel import load, WORK
from stats_util import fama_macbeth, rank_cs

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get("FCS_SIGNALS_WORKER", os.path.join(HERE, "..", "..", ".."))
spec = importlib.util.spec_from_file_location("bmw", os.path.join(REPO, "scripts", "big-move-watch.py"))
bmw = importlib.util.module_from_spec(spec); spec.loader.exec_module(bmw)
OUT = os.path.join(WORK, "contagion_panel.pkl")
NEW = ["catAbsR1", "catBig1", "catVolRatio", "catVolExp", "catR5", "catBurst", "tierAbsR1", "relCatR5"]
MIN_PEERS = 4


def series_from_panel(d):
    out = {}
    for s in d["P"].columns:
        c = d["P"][s]; ok = c.notna()
        if ok.sum() < 120: continue
        out[s] = [[t.strftime("%Y-%m-%d"), float(c[t]), float(d["H"][s][t]), float(d["L"][s][t]), float(d["V"][s][t])] for t in c.index[ok]]
    return out


def loo(D, key, col, how="mean"):
    """Leave-one-out peer aggregate of `col` within (date, key)."""
    g = D.groupby(["date", key])[col]
    x = D[col]
    if how == "mean":
        s, n = g.transform("sum"), g.transform("count")
        return ((s - x.fillna(0)) / (n - x.notna())).where((n - x.notna()) >= MIN_PEERS)
    raise ValueError(how)


def build():
    d = load()
    D = bmw.panel(series_from_panel(d))
    D["cat"] = D["symbol"].map(d["prim"]).where(lambda c: c.notna() & (c != "stablecoin"))
    tier = d["tier"].stack().rename("tier").reset_index().rename(columns={"level_0": "date", "level_1": "symbol"})
    D = D.merge(tier, on=["date", "symbol"], how="left")
    D.loc[D.symbol.isin(["BTC", "ETH"]), "tier"] = "major"
    D["big1"] = (D["absR1"] >= np.log(1.08)).astype(float)
    D["lvr"] = np.log(D["volumeRatio"].clip(lower=1e-3))
    Dc = D[D.cat.notna()]
    D.loc[Dc.index, "catAbsR1"] = loo(Dc, "cat", "absR1")
    D.loc[Dc.index, "catBig1"] = loo(Dc, "cat", "big1")
    D.loc[Dc.index, "catVolRatio"] = loo(Dc, "cat", "lvr")
    D.loc[Dc.index, "catVolExp"] = loo(Dc, "cat", "volExpansion")
    D.loc[Dc.index, "catR5"] = loo(Dc, "cat", "r5")
    D["catBurst"] = D["catAbsR1"] - D["marketTurbulence"]
    D["relCatR5"] = D["r5"] - D["catR5"]
    Dt = D[D.tier.notna()]
    D.loc[Dt.index, "tierAbsR1"] = loo(Dt, "tier", "absR1")
    D["big2"] = (D["fwd2"].abs() >= bmw.BIG).astype(float).where(np.isfinite(D["fwd2"]))
    D.to_pickle(OUT)
    return D


def main():
    D = pd.read_pickle(OUT) if os.path.exists(OUT) and "--rebuild" not in sys.argv else build()
    D = D[D.date >= "2021-03-01"]
    print(f"panel: {len(D):,} coin-days, {D.symbol.nunique()} coins, {D.date.min().date()}..{D.date.max().date()}; "
          f"with a category {D.cat.notna().mean():.0%}; base rate of a >=12% two-day move {D.big2.mean():.1%}")
    base = [f for f in bmw.FEATS if f not in ("btcR5", "btcVol20", "breadth5", "marketTurbulence")]   # day-constant features drop out of a per-day regression
    sub = D[D.cat.notna() & D.big2.notna()].copy()
    Pr = rank_cs(sub, base + NEW)
    print("\n## 6. Category and tier peers -> the coin's own >= 12% two-day move; per-day linear probability on ranks")
    print("   slope = change in probability from the bottom to the top of the day's ranking (pp); t Newey-West over days")
    for label, xs in (("each candidate alone, watch controls", None), ("all candidates together, watch controls", NEW)):
        print(f"   -- {label}")
        for p, lo, hi in (("2021-03..2023-12", "2021-03-01", "2024-01-01"), ("2024-01..2026-09", "2024-01-01", "2026-10-01")):
            S = Pr[(Pr.date >= lo) & (Pr.date < hi)]
            if xs is None:
                cells = []
                for f in NEW:
                    fm = fama_macbeth(S, "big2", base + [f], min_n=40)
                    cells.append(f"{f} {fm[f][0] * 100:+.1f}pp t {fm[f][1]:+.1f}")
                print(f"     {p}: " + " | ".join(cells))
            else:
                fm = fama_macbeth(S, "big2", base + xs, min_n=40)
                print(f"     {p}: " + " | ".join(f"{f} {fm[f][0] * 100:+.1f}pp t {fm[f][1]:+.1f}" for f in xs))
    # direction, for completeness: does a hot category say WHICH WAY?
    print("\n## 6b. Same panel, the two-day signed move (excess over the day's median coin): do peers say which way?")
    sub["fwd2x"] = sub["fwd2"] - sub.groupby("date")["fwd2"].transform("median")
    Pr = rank_cs(sub, base + NEW + ["r1", "r5"])
    for p, lo, hi in (("2021-03..2023-12", "2021-03-01", "2024-01-01"), ("2024-01..2026-09", "2024-01-01", "2026-10-01")):
        S = Pr[(Pr.date >= lo) & (Pr.date < hi)]
        fm = fama_macbeth(S, "fwd2x", ["r1", "r5", "catR5", "relCatR5", "catAbsR1"], min_n=40)
        print(f"   {p}: " + " | ".join(f"{f} {fm[f][0] * 1e4:+.0f}bp t {fm[f][1]:+.1f}" for f in ["r1", "r5", "catR5", "relCatR5", "catAbsR1"]))


if __name__ == "__main__":
    main()
