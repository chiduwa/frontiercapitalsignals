# Per-asset trading-time and stablecoin study
As of 2026-09-19. Development through 2025; holdout from 2026-01-01. Research only.

| Asset | Development-selected busiest hours ET | Holdout activity vs typical hour | 8–10 up: higher NY daily close | 8–10 down: lower NY daily close |
|---|---|---|---|---|
| BTC | 10:00, 9:00, 11:00 | +46.5%; replicated | 70.9% (n=117; subsequent move follows 57.3%) | 67.8% (n=143; subsequent move follows 48.3%) |
| ETH | 10:00, 9:00, 11:00 | +43.1%; replicated | 64.0% (n=114; subsequent move follows 53.5%) | 62.3% (n=146; subsequent move follows 44.5%) |
| SOL | 10:00, 11:00, 9:00 | +35.7%; replicated | 53.8% (n=119; subsequent move follows 52.1%) | 56.7% (n=141; subsequent move follows 45.4%) |
| XLM | 10:00, 11:00, 9:00 | +32.2%; replicated | 56.0% (n=134; subsequent move follows 47.0%) | 74.4% (n=117; subsequent move follows 55.6%) |
| XRP | 10:00, 11:00, 9:00 | +36.5%; replicated | 55.6% (n=126; subsequent move follows 43.7%) | 67.2% (n=134; subsequent move follows 48.5%) |
| HYPE perp | 10:00, 12:00, 9:00 | +19.4%; replicated | 61.4% (n=127; subsequent move follows 52.0%) | 56.4% (n=133; subsequent move follows 49.6%) |
| HBAR | 10:00, 20:00, 11:00 | +28.3%; replicated | 50.8% (n=130; subsequent move follows 40.0%) | 63.1% (n=130; subsequent move follows 50.0%) |

Daily-close percentages include the morning movement. They do not establish a trade after 10 ET. Full JSON contains incremental distance-to-prior-close controls, future-only returns, costs, sample counts and corrected tests.

All 887 reported tests share one Holm family. No production model is promoted.

## Stablecoin tests
Binance USDC/USDT quote turnover divided by BTC+ETH+SOL USDT quote turnover; disjoint pairs, one venue
Existing global snapshots: 18 completed days; insufficient.

| Asset/proxy | Daily stable-ratio Brier change (positive = better) | Daily stable-ratio magnitude MAE change |
|---|---|---|
| BTC | -0.00014 (Holm p=1.000) | +0.064 pp (Holm p=1.000) |
| ETH | -0.00071 (Holm p=1.000) | -0.037 pp (Holm p=1.000) |
| SOL | +0.00008 (Holm p=1.000) | +0.138 pp (Holm p=0.044) |
| XLM | +0.00154 (Holm p=1.000) | +0.010 pp (Holm p=0.086) |
| XRP | +0.00148 (Holm p=1.000) | +0.145 pp (Holm p=0.044) |
| HYPE | -0.00664 (Holm p=1.000) | -0.021 pp (Holm p=1.000) |
| HBAR | -0.00222 (Holm p=1.000) | +0.228 pp (Holm p=0.044) |
| BTC_ETH_SOL | +0.00019 (Holm p=1.000) | +0.052 pp (Holm p=0.044) |

Stable-ratio gains against a fitted regression also require comparison with a simpler median-size forecast. 0 daily candidates beat both controls with corrected significance in this run. All remain research-only. Component-control results are in the JSON.

## Limits
- Retrospective holdout, not a prospectively registered experiment; no trading promotion.
- HYPE uses Binance perpetual prices; all other tracked assets use spot. HYPE has shorter history.
- Clock windows include exchange holidays; weekday means Monday-Friday, not an exchange trading calendar.
- 8-10 ET includes part of the daily return: close association alone is not a forecast after 10 ET.
- Stable-to-stable turnover is not stablecoin issuance, net inflow, or global stablecoin trading volume. Venue fee promotions and USDC depegs can change turnover.
- Global stablecoin snapshots are too short for a reliable inference; supply history lacks first-seen vintages.
- Supply is all stablecoin pegs valued in USD; it is not restricted to USD-pegged coins. Weekly flow holdouts below 40 observations abstain.
- All significance tests are exploratory. Holm correction covers every reported direction, magnitude, activity and rule test.
