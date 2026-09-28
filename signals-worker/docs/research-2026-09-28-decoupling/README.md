# Coins pulling away from the market, 2026-09-28: scripts and results

Findings: [`../DECOUPLING.md`](../DECOUPLING.md). The live rule is
`scripts/decoupling-watch.mjs` (tested by `test-decoupling-watch.mjs`, run
hourly by the live scan); this folder holds the study behind it and each
analysis's output as it ran on 2026-09-28.

Every input is public Binance data or production's own D1, read-only. Put the
data in folders and point `DC_DATA` at them. Run from `signals-worker/`.

```sh
R=docs/research-2026-09-28-decoupling/scripts
COINS="BTC ETH XRP BNB SOL TRX DOGE ADA HYPE LINK XLM HBAR BCH SUI AVAX LTC TON 1000SHIB DOT UNI AAVE NEAR ENA ONDO APT ICP ETC ARB OP FIL ALGO TAO WLD 1000PEPE ATOM FET INJ SEI VET XMR"

# 1. perpetual bars and 5-minute derivatives metrics (data.binance.vision), then the study
python $R/fetch_um.py /data/um 2024-09-01 2026-09-27 $COINS
DC_DATA=/data/um python $R/decoupling_study.py      # decoupling_report.json, decoupling_panel.npz
DC_DATA=/data/um python $R/decoupling_models.py     # per-coin signs, the combined model (decoupling_models.json, bigmove_model.pkl)
DC_DATA=/data/um python $R/after_spikes.py          # after_spikes.json
DC_DATA=/data/um python $R/setup_rules.py           # candidate hourly rules on perp data

# 2. the same on spot bars, the live scanner's own source (no open interest)
python $R/fetch_spot.py /data/spot 2024-09-01 2026-09-27 $(echo $COINS | sed 's/1000//g')
DC_DATA=/data/spot python $R/decoupling_study.py
DC_DATA=/data/spot python $R/setup_rules.py         # written as setup_rules.json; kept here as setup_rules_spot.json
DC_DATA=/data/spot python $R/setup_filters.py       # the same-hours comparison and the market-wide filter
DC_DATA=/data/spot python $R/parity.py              # production module against the study, 250 coin-hours

# 3. what the production watch would have said over a recent window (fetches its own bars)
node $R/replay_live.mjs 2026-09-21T00:00Z 2026-09-28T17:30Z
```

`hbar_case.py` scores the hours after the bulk files end, so it reads two
more inputs from `DC_DATA` (the perp folder, next to `bigmove_model.pkl`):

- `k1h_recent.json`: `{SYMBOL: [[open_ms, close, volume, quote_volume, taker_buy_volume], ...]}`,
  the last 1,000 spot hours per coin from `data-api.binance.vision/api/v3/klines`.
- `oi_hourly_live.json`: each hour's last open-interest tick from the host's
  sampler, via `../research-2026-09-27-overfitting/scripts/d1q.sh "SELECT symbol, MAX(ts) AS ts, oi_contracts FROM oi_tick GROUP BY symbol, ts / 3600000"`.
  A tick is filed under the hour it falls in (`floor(ts / 3600000)`), so every
  bar carries its own closing open interest.

| script | DECOUPLING.md section | output here |
| --- | --- | --- |
| `decoupling_study.py` | 2, 3: the panel, pooled lifts | `decoupling_report_perp.json`, `decoupling_report_spot.json` |
| `decoupling_models.py` | 3, 4: per-coin signs, the combined model | `decoupling_models.json.gz`, `per_coin_table.md` |
| `hbar_case.py` | 1: the model's rank for HBAR by hour | `hbar_case_scores.json` |
| `after_spikes.py` | 5: after a coin pulls away | `after_spikes.json` |
| `setup_rules.py` | 1, 6: candidate hourly rules | `setup_rules_perp.json`, `setup_rules_spot.json` |
| `setup_filters.py` | 6: same-hours rates, the filter, by side, by week | `setup_filters.json`, `setup_filters.out` |
| `parity.py` + `parity.mjs` | 6: production against the study | `parity.json`, `parity.out` |
| `replay_live.mjs` | 6: 2026-09-21 to 09-28 | `replay-2026-09-21-to-28.out` |

`setup_rules.py` scores rules against the flat base rate (2.4% of
coin-hours). `setup_filters.py` replaced that with the same hours' rate, which
is what the live watch is judged on.
