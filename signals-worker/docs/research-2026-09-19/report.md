# Always-tracked asset research

As of 2026-09-19; outer evaluation from 2026-03-23. `tracked-specialists-v1`. Shadow only.

| Asset / horizon | Test n | Selected direction Brier | Base-rate Brier | Direction hit | Selected magnitude MAE % | Median baseline MAE % | Signed combination R² |
|---|---:|---:|---:|---:|---:|---:|---:|
| BTC 1d | 178 | 0.2562 | 0.2499 | 46.0% | 1.003 | 0.986 | 0.0001 |
| BTC 7d | 25 | 0.2561 | 0.2489 | 50.0% | 3.280 | 3.304 | -0.0231 |
| ETH 1d | 178 | 0.2598 | 0.2498 | 51.4% | 1.324 | 1.357 | -0.0288 |
| ETH 7d | 25 | 0.2917 | 0.2536 | 35.3% | 5.178 | 4.909 | -0.0372 |
| SOL 1d | 178 | 0.2530 | 0.2498 | 48.7% | 1.518 | 1.586 | -0.0062 |
| SOL 7d | 25 | 0.2496 | 0.2532 | 47.8% | 5.609 | 5.800 | -0.0079 |
| XLM 1d | 178 | 0.2575 | 0.2467 | 51.2% | 1.835 | 1.954 | -0.0136 |
| XLM 7d | 25 | 0.2617 | 0.2463 | 45.8% | 7.190 | 6.300 | -0.0191 |
| XRP 1d | 178 | 0.2530 | 0.2492 | 48.2% | 1.543 | 1.435 | -0.0106 |
| XRP 7d | 25 | 0.2715 | 0.2469 | 45.5% | 4.676 | 4.124 | -0.0214 |
| HYPE 1d | 178 | 0.2553 | 0.2508 | 48.9% | 2.132 | 2.203 | -0.0068 |
| HYPE 7d | 0 — insufficient history | — | — | — | — | — | — |
| HBAR 1d | 178 | 0.2566 | 0.2497 | 48.2% | 1.315 | 1.465 | -0.0350 |
| HBAR 7d | 25 | 0.2154 | 0.2574 | 60.9% | 3.224 | 4.422 | 0.0912 |

Selections below use earlier validation only; frequency is descriptive. Test winners are not promoted.

- **BTC 1d**: direction {'coin': 1, 'ridge_all': 2, 'momentum': 2, 'reversal': 1, 'logistic_liquidity': 1}; magnitude {'trailing': 2, 'medianAbs': 4, 'ewma': 1}.
- **BTC 7d**: direction {'reversal': 1, 'baseRate': 1, 'ridge_pv': 1, 'coin': 4}; magnitude {'medianAbs': 2, 'harBlend': 4, 'knn_all': 1}.
- **ETH 1d**: direction {'logistic_lead_HYPE': 1, 'ridge_all': 1, 'logistic_all': 2, 'logistic_lead_XLM': 1, 'momentum': 1, 'knn_all': 1}; magnitude {'fittedHarProxy': 1, 'medianAbs': 2, 'ewma': 4}.
- **ETH 7d**: direction {'ridge_lead_XLM': 1, 'ridge_pv': 1, 'logistic_pv': 1, 'coin': 2, 'momentum': 2}; magnitude {'harBlend': 4, 'ewma': 1, 'knn_all': 2}.
- **SOL 1d**: direction {'knn_all': 1, 'coin': 2, 'momentum': 2, 'baseRate': 1, 'ridge_funding': 1}; magnitude {'absoluteRidge_all': 2, 'knn_all': 2, 'harBlend': 2, 'ewma': 1}.
- **SOL 7d**: direction {'ridge_liquidity': 3, 'knn_all': 1, 'logistic_liquidity': 1, 'logistic_all': 1, 'momentum': 1}; magnitude {'absoluteRidge_all': 1, 'signedRidge_pv': 1, 'harBlend': 3, 'signedRidge_all': 2}.
- **XLM 1d**: direction {'knn_all': 4, 'momentum': 1, 'baseRate': 2}; magnitude {'medianAbs': 2, 'harBlend': 2, 'absoluteRidge_oi': 1, 'absoluteRidge_pv': 1, 'knn_all': 1}.
- **XLM 7d**: direction {'reversal': 5, 'knn_all': 2}; magnitude {'absoluteRidge_oi': 1, 'signedRidge_all': 1, 'signedRidge_oi': 4, 'absoluteRidge_pv': 1}.
- **XRP 1d**: direction {'knn_all': 3, 'logistic_liquidity': 2, 'momentum': 1, 'baseRate': 1}; magnitude {'medianAbs': 2, 'harBlend': 1, 'signedRidge_oi': 1, 'knn_all': 1, 'ewma': 1, 'signedRidge_pv': 1}.
- **XRP 7d**: direction {'ridge_all': 1, 'reversal': 1, 'knn_all': 5}; magnitude {'knn_all': 2, 'trailing': 2, 'medianAbs': 2, 'ewma': 1}.
- **HYPE 1d**: direction {'reversal': 4, 'ridge_liquidity': 2, 'logistic_pv': 1}; magnitude {'medianAbs': 1, 'ewma': 4, 'harBlend': 2}.
- **HBAR 1d**: direction {'baseRate': 2, 'logistic_lead_BTC': 1, 'ridge_lead_ETH': 1, 'momentum': 1, 'reversal': 1, 'coin': 1}; magnitude {'knn_all': 2, 'harBlend': 3, 'absoluteRidge_oi': 1, 'ewma': 1}.
- **HBAR 7d**: direction {'logistic_lead_SOL': 1, 'knn_all': 5, 'reversal': 1}; magnitude {'harBlend': 6, 'ewma': 1}.

## Data coverage

| Asset | Price bars | Last close | OI days | Funding days | Binance-labeled days | Depth days |
|---|---:|---|---:|---:|---:|---:|
| BTC | 2086 | 2026-09-17 | 1357 | 173 | 169 | 1354 |
| ETH | 2086 | 2026-09-17 | 1357 | 173 | 169 | 1355 |
| HBAR | 2086 | 2026-09-17 | 1357 | 173 | 169 | 1355 |
| HYPE | 393 | 2026-09-17 | 477 | 90 | 86 | 477 |
| SOL | 2086 | 2026-09-17 | 1357 | 173 | 169 | 1352 |
| XLM | 2086 | 2026-09-17 | 1356 | 173 | 169 | 1353 |
| XRP | 2086 | 2026-09-17 | 1357 | 173 | 169 | 1353 |

## Limits

- Research test dates were chosen before this run, but are not a registered untouched live holdout.
- Seven current favorites are a selected surviving universe; not survivorship-free.
- Daily close-to-close labels; not executable issue-time quotes.
- Legacy funding source labels can be wrong after snapshot overwrite. Funding ablations remain diagnostic pending settlement backfill; no funding edge is established.
- Flat 20 bps round trip excludes funding, borrow and market impact; not a trading simulation.
- Daily 1/3-day leader lags cannot rule out relationships at intraday horizons.
- Magnitude means absolute close return, not intraday high-low range or interval coverage.
- Refit/selection every 28 days using only matured validation labels; no automatic promotion.
