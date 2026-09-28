# Overfitting audit, 2026-09-27: scripts and results

Findings: [`../MODEL_OVERFITTING.md`](../MODEL_OVERFITTING.md). `results/` holds
each script's output as it ran on 2026-09-27.

The inputs are too large to check in. Rebuild them from production's own
tools into one data folder, then point `OVF_DATA` at it. Run from the repo root
(`frontiercapitalsignals/`) unless noted. Everything reads D1 and changes
nothing.

```sh
export OVF_DATA=/path/to/data     # any empty folder
R=signals-worker/docs/research-2026-09-27-overfitting/scripts

# 1. the research panel (~250 MB), read-only
node signals-worker/scripts/hierarchical-research.mjs --wrangler --dry-run \
  --as-of 2026-09-26 --save-input $OVF_DATA/hier-panel.json --load-only

# 2. the tournament input (~310 MB), built from that panel
(cd signals-worker && node --max-old-space-size=6144 scripts/model-tournament-io.mjs \
  data $OVF_DATA/hier-panel.json $OVF_DATA/tourn-input.json)

# 3. per-asset regression fits and every walk-forward forecast (~10 min)
node $R/ovf_regression.mjs            # -> is_fits.json, wf_outcomes.json

# 4. technique outcomes: live halves, and the engine's own records by year
$R/d1q.sh "SELECT asset_class, symbol, series_key AS tech, horizon_minutes AS hz, CASE WHEN target_at < '2026-09-16' THEN 1 ELSE 2 END AS half, SUM(correct) AS c, COUNT(*) AS n, SUM(CASE WHEN dir=1 THEN 1 ELSE 0 END) AS up FROM forecast_outcomes WHERE provenance='live' AND series_kind='technique' AND aggregated=1 GROUP BY asset_class, symbol, series_key, horizon_minutes, half" > $OVF_DATA/tech_halves.json
for hz in 1440 10080; do
  $R/d1q.sh "SELECT asset_class AS cls, symbol AS s, series_key AS t, substr(target_at,1,4) AS y, SUM(correct) AS c, COUNT(*) AS n FROM forecast_outcomes WHERE series_kind='technique' AND aggregated=1 AND model_version='confluence-v9' AND label_version='direction-deadband-0.5pct-v1' AND horizon_minutes=$hz GROUP BY asset_class, symbol, series_key, y" > $OVF_DATA/engine_cells_$hz.json
done
```

Then, with numpy (the tournament scripts also need what
`scripts/sequence-research-requirements.txt` installs):

| script | MODEL_OVERFITTING.md section | reads |
| --- | --- | --- |
| `r2_audit.py` | 1, the regression's R² | `is_fits.json`, `wf_outcomes.json` |
| `vol_calibration.py` | 2, calibration factor | `tourn-input.json` |
| `screen_check.py` | 2, the generator's own screen | `tourn-input.json` |
| `vol_selection.py` | 3, per-asset model choice | `tourn-input.json` |
| `lookback_audit.py` | 4, the band's window | `hier-panel.json` |
| `band_check.mjs` | 4, the shipped band factor | `hier-panel.json` |
| `tech_weights.py` | 5, live technique records | `tech_halves.json` |
| `tech_weights_engine.py` | 5, large records (composite) | `engine_cells_*.json` |
| `composite_curse.py` | 6, per-asset composite records | `engine_cells_*.json` |

`tech_i2.json` is an intermediate check on `technique_reliability`. It shows
the composite's per-asset hit rates spread more than chance allows, which is
what section 5's year folds then test for persistence.
