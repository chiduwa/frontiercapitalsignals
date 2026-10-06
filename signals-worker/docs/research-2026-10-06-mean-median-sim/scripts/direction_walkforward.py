"""Walk-forward direction forecasts for every tournament asset and every
direction family the generator can propose (asked 2026-10-06: "could the
learning model be also checking precision, recall/sensitivity, specificity,
and negative predictive value, to see if we can learn from those to improve
the models per asset").

Uses the tournament's own code (scripts/model-tournament.py: fit_predict,
matured, candidate_grid), with its backtest's refit schedule (every 28
decision dates at 1 day, every 4 at multi-day horizons, one decision every h
dates so outcomes do not overlap), over the whole input rather than its last
360 days. Each forecast is fitted only on labels matured by its block's first
decision date.

Input: the tournament run's input.json split per symbol (TOUR_SYM/<sym>.pkl,
_meta.pkl). Output: TOUR_OUT/direction_wf.pkl, one row per (asset, horizon,
model, decision date): pUp, the realized return, the training base rate.
"""
import os, sys, time, pickle, importlib.util
from multiprocessing import Pool
import numpy as np, pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SYM = os.environ["TOUR_SYM"]
OUT = os.environ.get("TOUR_OUT", os.path.join(ROOT, "reports", "confusion"))


def tournament():
    spec = importlib.util.spec_from_file_location("model_tournament", os.path.join(ROOT, "scripts", "model-tournament.py"))
    mt = importlib.util.module_from_spec(spec); spec.loader.exec_module(mt)
    return mt


def run_symbol(sym):
    mt = tournament()
    meta = pickle.load(open(f"{SYM}/_meta.pkl", "rb"))
    rows = pickle.load(open(f"{SYM}/{sym}.pkl", "rb"))
    cls = meta["assetClassBySymbol"].get(sym, "crypto")
    specs = [mt.BENCHMARKS["direction"]] + mt.candidate_grid("direction")
    out = []
    t0 = time.time()
    for target, h in mt.SLOTS_BY_CLASS[cls]:
        if target != "direction": continue
        lab = sorted([r for r in rows if r["horizon"] == h and r["target"] is not None], key=lambda r: r["date"])
        test = lab[::h] if h > 1 else lab
        step = 28 if h == 1 else 4
        for spec in specs:
            for k in range(0, len(test), step):
                block = test[k:k + step]
                train = mt.matured(lab, block[0]["date"])
                if len(train) < 150: continue
                base = float((sum(r["target"] > 0 for r in train) + 1) / (len(train) + 2))
                fc, _ = mt.fit_predict(spec, train, block, h)
                for r, f in zip(block, fc):
                    out.append((sym, cls, h, spec["id"], mt.describe(spec), r["date"], f["pUp"], r["target"], base))
    print(f"   {sym}: {len(out)} forecasts in {time.time() - t0:.0f}s", flush=True)
    return out


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    syms = sorted(s[:-4] for s in os.listdir(SYM) if s.endswith(".pkl") and not s.startswith("_"))
    if len(sys.argv) > 1: syms = [s for s in syms if s in sys.argv[1].split(",")]
    t0 = time.time()
    with Pool(int(os.environ.get("WORKERS", "7"))) as p:
        parts = p.map(run_symbol, syms, chunksize=1)
    df = pd.DataFrame([r for part in parts for r in part],
                      columns=["sym", "cls", "h", "model", "label", "date", "pUp", "ret", "base"])
    df.to_pickle(f"{OUT}/direction_wf.pkl")
    print(f"{len(df):,} forecasts, {df.sym.nunique()} assets, {df.model.nunique()} models in {time.time() - t0:.0f}s")
