# Eight-stablecoin volume hypothesis
As of 2026-09-19; coins: USDT, USDC, USDE, DAI, USD1, USDG, PYUSD, RLUSD. Research only.

| Target | Test days | Basket volume growth: direction gain | Signed-return regression gain | Selected model direction gain |
|---|---|---|---|---|
| CMC100 | 119 | +0.00338 (Holm p=1.000) | -0.0121 (p=1.000) | -0.00414 (p=1.000) |
| BTC | 119 | +0.00335 (Holm p=1.000) | -0.0358 (p=1.000) | +0.00015 (p=1.000) |
| ETH | 119 | +0.00089 (Holm p=1.000) | -0.0076 (p=1.000) | +0.00011 (p=1.000) |
| SOL | 119 | -0.00051 (Holm p=1.000) | -0.0776 (p=1.000) | -0.00525 (p=1.000) |
| XLM | 119 | +0.00145 (Holm p=1.000) | -0.2617 (p=1.000) | -0.00119 (p=1.000) |
| XRP | 119 | +0.00196 (Holm p=1.000) | -0.1546 (p=1.000) | -0.00701 (p=1.000) |
| HYPE | 119 | -0.00501 (Holm p=1.000) | -0.0601 (p=1.000) | -0.00292 (p=1.000) |
| HBAR | 119 | +0.00157 (Holm p=1.000) | -0.2908 (p=1.000) | -0.00702 (p=1.000) |
| TRACKED_MEDIAN | 119 | +0.00120 (Holm p=1.000) | -0.0958 (p=1.000) | -0.00375 (p=1.000) |

Positive gains mean lower error than the price/volume/order-flow control; negative means worse. Brier measures direction probability error. Regression gain is reduction in squared percentage-return error.

## Broad market: individual stablecoins
| Coin | Future return correlation | Same-period correlation | P(market down) after volume +10% | After volume −10% |
|---|---|---|---|---|
| USDT | +0.016 | +0.024 | 53.8% (n=39) | 51.5% (n=33) |
| USDC | -0.059 | -0.006 | 59.5% (n=42) | 47.4% (n=38) |
| USDE | +0.073 | -0.095 | 49.2% (n=61) | 52.1% (n=48) |
| DAI | -0.085 | -0.034 | 56.2% (n=48) | 43.8% (n=48) |
| USD1 | -0.007 | +0.115 | 58.3% (n=48) | 51.1% (n=45) |
| USDG | +0.011 | +0.078 | 54.3% (n=46) | 52.4% (n=42) |
| PYUSD | -0.012 | +0.036 | 56.9% (n=51) | 52.0% (n=50) |
| RLUSD | -0.004 | +0.081 | 52.0% (n=50) | 43.1% (n=51) |
| basket8 | -0.003 | +0.014 | 52.4% (n=42) | 51.4% (n=35) |
| core3 | -0.004 | +0.015 | 53.7% (n=41) | 52.8% (n=36) |

Unconditional CMC100 down frequency in this holdout: 51.3%. Conditional frequencies are descriptive; compare model controls and corrected tests before calling them leading indicators.

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
