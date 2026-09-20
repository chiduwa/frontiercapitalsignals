# Eight-stablecoin volume hypothesis
As of 2026-09-20; coins: USDT, USDC, USDE, DAI, USD1, USDG, PYUSD, RLUSD. Research only.

| Target | Test days | Basket volume growth: direction gain | Signed-return regression gain | Selected model direction gain |
|---|---|---|---|---|
| CMC100 | 119 | +0.00311 (Holm p=1.000) | -0.0235 (p=1.000) | -0.00275 (p=1.000) |
| BTC | 119 | +0.00311 (Holm p=1.000) | -0.0451 (p=1.000) | -0.00129 (p=1.000) |
| ETH | 119 | +0.00054 (Holm p=1.000) | -0.0364 (p=1.000) | -0.01084 (p=1.000) |
| SOL | 119 | -0.00029 (Holm p=1.000) | -0.0769 (p=1.000) | -0.00417 (p=1.000) |
| XLM | 119 | +0.00124 (Holm p=1.000) | -0.3872 (p=1.000) | +0.00116 (p=1.000) |
| XRP | 119 | +0.00127 (Holm p=1.000) | -0.1678 (p=1.000) | -0.02069 (p=1.000) |
| HYPE | 119 | -0.00464 (Holm p=1.000) | -0.2718 (p=1.000) | +0.00081 (p=1.000) |
| HBAR | 119 | +0.00092 (Holm p=1.000) | -0.2834 (p=1.000) | -0.00885 (p=1.000) |
| TRACKED_MEDIAN | 119 | +0.00077 (Holm p=1.000) | -0.0976 (p=1.000) | -0.00257 (p=1.000) |

Positive gains mean lower error than the price/volume/order-flow control; negative means worse. Brier measures direction probability error. Regression gain is reduction in squared percentage-return error.

## Broad market: individual stablecoins
| Coin | Future return correlation | Same-period correlation | P(market down) after volume +10% | After volume −10% |
|---|---|---|---|---|
| USDT | +0.009 | +0.011 | 53.8% (n=39) | 50.0% (n=34) |
| USDC | -0.055 | -0.019 | 58.5% (n=41) | 47.4% (n=38) |
| USDE | +0.086 | -0.092 | 47.5% (n=61) | 52.1% (n=48) |
| DAI | -0.065 | -0.050 | 55.3% (n=47) | 43.8% (n=48) |
| USD1 | -0.028 | +0.123 | 58.3% (n=48) | 48.9% (n=45) |
| USDG | +0.011 | +0.070 | 53.3% (n=45) | 51.2% (n=43) |
| PYUSD | -0.033 | +0.034 | 56.9% (n=51) | 50.0% (n=50) |
| RLUSD | -0.019 | +0.090 | 52.0% (n=50) | 42.0% (n=50) |
| basket8 | -0.007 | +0.002 | 52.4% (n=42) | 50.0% (n=36) |
| core3 | -0.008 | +0.003 | 53.7% (n=41) | 51.4% (n=37) |

Unconditional CMC100 down frequency in this holdout: 50.4%. Conditional frequencies are descriptive; compare model controls and corrected tests before calling them leading indicators.

0 comparisons clear the 1359-test family; none is automatically promoted.

- Unsigned volume does not identify investors selling crypto: each trade has a buyer and seller, and stablecoin/crypto volume attribution overlaps.
- Global stablecoin USD volume is distinct from disjoint venue pair turnover. No splicing with the earlier USDC/USDT study.
- 364 midnight observations are retrospective revised history, not first-seen vintages. One full-day embargo reduces timing risk without solving revisions.
- CMC100 is a provider market index; TRACKED_MEDIAN tests the majority direction among the seven tracked assets, not every listed coin.
- Baseline controls own returns/volatility, major-crypto volume changes, and available Binance BTC/ETH/SOL net aggressive selling.
- Test candidates use volume growth over 1/3/7 days, additional lags 0/1/3/7, volume ratio and turnover controls; per-asset selection uses earlier validation only.
- Descriptive correlations and full-sample coefficients do not establish causal flows or forecasting value.
- All formal comparisons share one Holm family; 50,000 paired moving-block bootstrap draws, seven-day blocks, fixed seed.
- A 120-day retrospective outer window is short. Any candidate needs frozen prospective confirmation and stronger baselines before promotion.
