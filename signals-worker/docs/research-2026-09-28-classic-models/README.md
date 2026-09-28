# Classic forecasting models, 2026-09-28: scripts and results

Findings: [`../CLASSIC_MODELS.md`](../CLASSIC_MODELS.md). The main study is
`scripts/classic-models-research.py` (tested by `test-classic-models-research.py`,
run daily in `signals-model-tournament.yml`); this folder holds the one-off
analyses around it and each one's output as it ran on 2026-09-28.

Every input is rebuilt from production's own tools, read-only. Put them in one
folder and point `OVF_DATA` at it. Run from the repo root (`frontiercapitalsignals/`).

```sh
export OVF_DATA=/path/to/data
R=signals-worker/docs/research-2026-09-28-classic-models/scripts

# 1. the research panel and the tournament input, as in
#    docs/research-2026-09-27-overfitting/README.md (hier-panel.json, tourn-input.json)

# 2. the market as a whole: equal-weight indexes of the tournament's coins and
#    stocks, and SPY, as research rows (universe.json lists the tournament's
#    symbols by class: {"crypto": [...], "stock": [...]})
node --max-old-space-size=6144 $R/market-index-rows.mjs $OVF_DATA/hier-panel.json $OVF_DATA/universe.json $OVF_DATA/market-rows.json

# 3. the study itself (about 45 minutes on 7 cores)
python signals-worker/scripts/classic-models-research.py --input $OVF_DATA/tourn-input.json \
  --extra $OVF_DATA/market-rows.json --output $OVF_DATA/classic --workers 7
python $R/summarize.py $OVF_DATA/classic/report.json

# 4. the engine's own composite calls, for the range study, one file per class and year
for c in crypto stock; do for y in 2021 2022 2023 2024 2025 2026; do
  signals-worker/docs/research-2026-09-27-overfitting/scripts/d1q.sh "SELECT symbol AS s, horizon_minutes/60 AS h, substr(target_at,1,10) AS d, dir, score, return_pct AS r FROM forecast_outcomes WHERE series_kind='technique' AND series_key='composite' AND model_version='confluence-v9' AND aggregated=1 AND return_pct IS NOT NULL AND asset_class='$c' AND substr(target_at,1,4)='$y'" > $OVF_DATA/comp_${c}_${y}.json
done; done

# 5. the 4-hour opens the tournament's timing slot uses, cut out of tourn-input.json
python -c "import json,os; d=json.load(open(os.environ['OVF_DATA']+'/tourn-input.json')); json.dump({'asOf': d['asOf'], 'klines': d['klines']}, open(os.environ['OVF_DATA']+'/klines.json','w'))"
```

| script | CLASSIC_MODELS.md section | reads |
| --- | --- | --- |
| `summarize.py` | 1 to 3, the tables | the study's `report.json` |
| `band_drift.py` | 4, the published band rebuilt on every call | `comp_*.json` |
| `band_timely.py` | 4, a more timely typical move | `comp_*.json` |
| `band_widths_check.mjs` | 4, the shipped widths on the archive | `hier-panel.json` |
| `timing_study.py` | 5, the buying time | `klines.json` |
| `timing_price.py` | 5, what each slot costs on average | `klines.json` |
| `regression_validation.py` | 6, in-sample significance vs out of sample | the 2026-09-27 audit's `is_fits.json`, `wf_outcomes.json` |
| `market-index-rows.mjs` | 3, the market series | `hier-panel.json` |
