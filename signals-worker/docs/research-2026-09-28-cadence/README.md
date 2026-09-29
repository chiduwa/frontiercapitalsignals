# Rhythm and cadence, 2026-09-28: scripts and results

Findings: [`../CADENCE.md`](../CADENCE.md). Everything here is research: no
production code reads it.

Inputs are public Binance data and production's research panel
(`hier-panel.json`, rebuilt as in
[`../research-2026-09-27-overfitting/README.md`](../research-2026-09-27-overfitting/README.md)).
Put them in one folder and point `CAD_DATA` at it. The hourly spot files come
from the decoupling study's `fetch_spot.py`
([`../research-2026-09-28-decoupling/README.md`](../research-2026-09-28-decoupling/README.md)).
Run from this folder, with numpy and scipy.

```sh
export CAD_DATA=/data/cad
# 1. inputs: hourly spot closes for the 38 largest coins; daily closes for US
#    stocks and SPY (research panel) and for coins (Binance spot daily candles,
#    because the archive's daily crypto closes mix tokens under one ticker)
node -e "import('../../../worker.js').then(async w => console.log(JSON.stringify([...await w.binanceGlobalTradablePairs()])))" > $CAD_DATA/binance_tradable.json
DC_SPOT=/data/spot HIER=/path/hier-panel.json BINANCE_TRADABLE=$CAD_DATA/binance_tradable.json CAD_OUT=$CAD_DATA python cadence_data.py

# 2. the checks: planted rhythms are found, random walks show none
python test_cadence.py

# 3. per asset, every test, against each asset's own 200 sign-randomized copies
python cadence_study.py all && python cadence_summary.py
# 4. pumps and breakdowns, per asset and pooled
python cadence_episodes.py all && python episodes_summary.py
# 5. class-wide, with one sign draw shared by every asset in a class (keeps
#    their co-movement), the class indexes, and moves relative to the class
python cadence_class.py && python cadence_resid.py && python class_summary.py
# 6. what the tempting rules would have made, net of costs
python cadence_backtest.py && python deadcat_concentration.py
# 7. the rhythm in size: hour of day, weekends, swing lengths
python size_rhythm.py
# 8. the coin rotation as the live paper log runs it, replayed since 2021 on
#    the 100 most-traded Binance coins (scripts/coin-rotation.mjs)
python fetch_daily_all.py $CAD_DATA/binance_tradable.json $CAD_DATA/daily_all.json
node rotation_replay.mjs $CAD_DATA/daily_all.json $CAD_DATA/rotation_replay.json
```

| script | CADENCE.md section | output here |
| --- | --- | --- |
| `cadence_data.py` | 2: the data | (inputs) |
| `test_cadence.py` | 2: the method's checks | `results/tests.out` |
| `cadence_study.py`, `cadence_summary.py` | 3: per asset | `results/summary.out`, `results/cadence_summary.json` |
| `cadence_episodes.py`, `episodes_summary.py` | 5: pumps and breakdowns | `results/episodes_summary.out` |
| `cadence_class.py`, `cadence_resid.py`, `class_summary.py` | 4, 5: class-wide, relative to the market | `results/class_summary.out`, `results/class_results.json`, `results/resid_results.json` |
| `cadence_backtest.py` | 7: the rules, net of costs | `results/backtest.out`, `results/backtest_results.json` |
| `deadcat_concentration.py` | 7: how few weeks the dead-cat short depends on | `results/deadcat_concentration.out` |
| `size_rhythm.py` | 6: the rhythm in size | `results/size_rhythm.out`, `results/size_rhythm.json` |
| `fetch_daily_all.py`, `rotation_replay.mjs` | 7: the rotation on the most-traded coins | `results/rotation_replay.out`, `results/rotation_replay.json` |
