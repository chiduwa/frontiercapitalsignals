# Sequence, time and momentum models for the always-tracked assets

As of 2026-09-23; untouched test from 2024-10-03 (720 days). `tracked-sequence-v1`. Research only.
Holm-corrected across 233 comparisons.

## Direction: Brier improvement over the base rate (positive = better)

| Asset / h | n | logistic | lightgbm | xgboost | svr | sarima | sarimax | lstm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| BTC 1d | 719 | -13.94e-3 (p 1.00) | -3.79e-3 (p 1.00) | -12.47e-3 (p 1.00) | -10.35e-3 (p 1.00) | +0.08e-3 (p 1.00) | -0.71e-3 (p 1.00) | -0.24e-3 (p 1.00) |
| BTC 7d | 102 | -47.27e-3 (p 1.00) | +0.51e-3 (p 1.00) | -26.68e-3 (p 1.00) | -23.71e-3 (p 1.00) | +4.62e-3 (p 1.00) | — | -1.28e-3 (p 1.00) |
| ETH 1d | 719 | -9.82e-3 (p 1.00) | -1.18e-3 (p 1.00) | -1.92e-3 (p 1.00) | -12.26e-3 (p 1.00) | -0.06e-3 (p 1.00) | -6.06e-3 (p 1.00) | -0.62e-3 (p 1.00) |
| ETH 7d | 102 | -55.44e-3 (p 1.00) | -2.57e-3 (p 1.00) | -29.25e-3 (p 1.00) | -12.68e-3 (p 1.00) | -8.40e-3 (p 1.00) | — | -6.42e-3 (p 1.00) |
| SOL 1d | 719 | -16.20e-3 (p 1.00) | -2.29e-3 (p 1.00) | -6.27e-3 (p 1.00) | -15.10e-3 (p 1.00) | -2.00e-3 (p 1.00) | -4.16e-3 (p 1.00) | -1.37e-3 (p 1.00) |
| SOL 7d | 102 | -29.32e-3 (p 1.00) | -4.00e-3 (p 1.00) | -11.32e-3 (p 1.00) | -12.44e-3 (p 1.00) | -3.26e-3 (p 1.00) | — | -6.80e-3 (p 1.00) |
| XLM 1d | 719 | -21.60e-3 (p 1.00) | -0.86e-3 (p 1.00) | -3.62e-3 (p 1.00) | -9.78e-3 (p 1.00) | -8.84e-3 (p 1.00) | -20.99e-3 (p 1.00) | +0.04e-3 (p 1.00) |
| XLM 7d | 102 | -8.23e-3 (p 1.00) | +7.03e-3 (p 1.00) | +8.29e-3 (p 1.00) | +11.43e-3 (p 1.00) | -32.05e-3 (p 1.00) | — | +2.55e-3 (p 1.00) |
| XRP 1d | 719 | -21.22e-3 (p 1.00) | -3.00e-3 (p 1.00) | -5.18e-3 (p 1.00) | -7.02e-3 (p 1.00) | -1.65e-3 (p 1.00) | -6.97e-3 (p 1.00) | -1.80e-3 (p 1.00) |
| XRP 7d | 102 | -35.12e-3 (p 1.00) | -10.30e-3 (p 1.00) | -13.13e-3 (p 1.00) | -5.27e-3 (p 1.00) | -11.10e-3 (p 1.00) | — | -9.83e-3 (p 1.00) |
| HYPE 1d | 168 | -30.27e-3 (p 1.00) | +2.71e-3 (p 1.00) | -14.87e-3 (p 1.00) | -5.27e-3 (p 1.00) | +1.23e-3 (p 1.00) | -1.11e-3 (p 1.00) | -5.63e-3 (p 1.00) |
| HYPE 7d | 0 | — | — | — | — | — | — | — |
| HBAR 1d | 719 | -17.98e-3 (p 1.00) | -6.93e-3 (p 1.00) | -6.87e-3 (p 1.00) | -8.32e-3 (p 1.00) | -2.40e-3 (p 1.00) | -7.63e-3 (p 1.00) | -2.75e-3 (p 1.00) |
| HBAR 7d | 102 | -39.61e-3 (p 1.00) | -11.33e-3 (p 1.00) | -10.84e-3 (p 1.00) | +9.20e-3 (p 1.00) | -1.30e-3 (p 1.00) | — | -7.95e-3 (p 1.00) |
| ARB 1d | 702 | -16.79e-3 (p 1.00) | -4.63e-3 (p 1.00) | -21.33e-3 (p 1.00) | -12.86e-3 (p 1.00) | -1.59e-3 (p 1.00) | -7.67e-3 (p 1.00) | -5.38e-3 (p 1.00) |
| ARB 7d | 100 | -8.07e-3 (p 1.00) | -1.79e-3 (p 1.00) | +2.80e-3 (p 1.00) | +0.22e-3 (p 1.00) | +0.68e-3 (p 1.00) | — | -0.06e-3 (p 1.00) |

## Magnitude: MAE improvement over GARCH + weekday (positive = better)

| Asset / h | GARCH+weekday MAE % | vs median | lightgbm | xgboost | svr | lstm |
|---|---:|---:|---:|---:|---:|---:|
| BTC 1d | 1.087 | +0.045 (p 0.15) | -0.106 (p 1.00) | -0.103 (p 1.00) | -0.082 (p 1.00) | -0.076 (p 1.00) |
| BTC 7d | 3.075 | +0.097 (p 1.00) | -0.462 (p 1.00) | -0.775 (p 1.00) | -0.382 (p 1.00) | -0.391 (p 1.00) |
| ETH 1d | 1.749 | +0.057 (p 0.13) | -0.153 (p 1.00) | -0.174 (p 1.00) | -0.075 (p 1.00) | -0.048 (p 1.00) |
| ETH 7d | 4.431 | -0.015 (p 1.00) | -0.455 (p 1.00) | -1.183 (p 1.00) | -0.054 (p 1.00) | -0.338 (p 1.00) |
| SOL 1d | 1.900 | +0.056 (p 1.00) | -0.154 (p 1.00) | -0.162 (p 1.00) | -0.074 (p 1.00) | -0.065 (p 1.00) |
| SOL 7d | 4.789 | +0.522 (p 1.00) | -1.044 (p 1.00) | -1.042 (p 1.00) | -0.310 (p 1.00) | -1.237 (p 1.00) |
| XLM 1d | 2.156 | +0.121 (p 1.00) | -0.115 (p 1.00) | -0.152 (p 1.00) | -0.132 (p 1.00) | -0.068 (p 1.00) |
| XLM 7d | 7.500 | -0.221 (p 1.00) | -0.069 (p 1.00) | -1.077 (p 1.00) | +0.064 (p 1.00) | +0.111 (p 1.00) |
| XRP 1d | 1.951 | +0.067 (p 1.00) | -0.262 (p 1.00) | -0.244 (p 1.00) | -0.077 (p 1.00) | -0.116 (p 1.00) |
| XRP 7d | 6.061 | -0.017 (p 1.00) | -0.858 (p 1.00) | -0.707 (p 1.00) | -0.713 (p 1.00) | -0.448 (p 1.00) |
| HYPE 1d | 2.264 | -0.004 (p 1.00) | -0.213 (p 1.00) | -0.117 (p 1.00) | -0.011 (p 1.00) | -0.023 (p 1.00) |
| HBAR 1d | 2.223 | +0.123 (p 0.20) | -0.223 (p 1.00) | -0.267 (p 1.00) | -0.085 (p 1.00) | -0.064 (p 1.00) |
| HBAR 7d | 7.100 | +0.368 (p 1.00) | -1.721 (p 1.00) | -1.284 (p 1.00) | -0.546 (p 1.00) | -0.452 (p 1.00) |
| ARB 1d | 2.493 | +0.071 (p 1.00) | -0.165 (p 1.00) | -0.201 (p 1.00) | -0.064 (p 1.00) | -0.045 (p 1.00) |
| ARB 7d | 6.591 | -0.123 (p 1.00) | -0.284 (p 1.00) | -0.531 (p 1.00) | -0.347 (p 1.00) | -0.133 (p 1.00) |

## Verdicts after correction

- **BTC|1**: direction none; magnitude vs median none; vs GARCH+weekday none; positive signed R² ['sarima']
- **BTC|7**: direction none; magnitude vs median none; vs GARCH+weekday none; positive signed R² none
- **ETH|1**: direction none; magnitude vs median none; vs GARCH+weekday none; positive signed R² none
- **ETH|7**: direction none; magnitude vs median none; vs GARCH+weekday none; positive signed R² none
- **SOL|1**: direction none; magnitude vs median none; vs GARCH+weekday none; positive signed R² none
- **SOL|7**: direction none; magnitude vs median none; vs GARCH+weekday none; positive signed R² none
- **XLM|1**: direction none; magnitude vs median none; vs GARCH+weekday none; positive signed R² ['lightgbm']
- **XLM|7**: direction none; magnitude vs median none; vs GARCH+weekday none; positive signed R² ['svr']
- **XRP|1**: direction none; magnitude vs median none; vs GARCH+weekday none; positive signed R² none
- **XRP|7**: direction none; magnitude vs median none; vs GARCH+weekday none; positive signed R² ['lightgbm']
- **HYPE|1**: direction none; magnitude vs median none; vs GARCH+weekday none; positive signed R² ['lightgbm']
- **HBAR|1**: direction none; magnitude vs median none; vs GARCH+weekday none; positive signed R² none
- **HBAR|7**: direction none; magnitude vs median none; vs GARCH+weekday none; positive signed R² ['lightgbm']
- **ARB|1**: direction none; magnitude vs median none; vs GARCH+weekday none; positive signed R² none
- **ARB|7**: direction none; magnitude vs median none; vs GARCH+weekday none; positive signed R² none
