# Per-asset trading-time and stablecoin study
As of 2026-09-20. Development through 2025; holdout from 2026-01-01. Research only.

| Asset | Development-selected busiest hours ET | Holdout activity vs typical hour | 8–10 up: higher NY daily close | 8–10 down: lower NY daily close |
|---|---|---|---|---|
| BTC | 10:00, 9:00, 11:00 | +47.2%; replicated | 71.2% (n=118; subsequent move follows 57.6%) | 67.8% (n=143; subsequent move follows 48.3%) |
| ETH | 10:00, 9:00, 11:00 | +43.5%; replicated | 64.3% (n=115; subsequent move follows 53.9%) | 62.3% (n=146; subsequent move follows 44.5%) |
| SOL | 10:00, 11:00, 9:00 | +36.2%; replicated | 54.2% (n=120; subsequent move follows 52.5%) | 56.7% (n=141; subsequent move follows 45.4%) |
| XLM | 10:00, 11:00, 9:00 | +32.8%; replicated | 56.3% (n=135; subsequent move follows 47.4%) | 74.4% (n=117; subsequent move follows 55.6%) |
| XRP | 10:00, 11:00, 9:00 | +37.3%; replicated | 55.9% (n=127; subsequent move follows 44.1%) | 67.2% (n=134; subsequent move follows 48.5%) |
| HYPE perp | 10:00, 12:00, 9:00 | +19.5%; replicated | 61.7% (n=128; subsequent move follows 52.3%) | 56.4% (n=133; subsequent move follows 49.6%) |
| HBAR | 10:00, 20:00, 11:00 | +28.4%; replicated | 51.1% (n=131; subsequent move follows 40.5%) | 63.1% (n=130; subsequent move follows 50.0%) |

Daily-close percentages include the morning movement. They do not establish a trade after 10 ET. Full JSON contains incremental distance-to-prior-close controls, future-only returns, costs, sample counts and corrected tests.

All 887 reported tests share one Holm family. No production model is promoted.

## Stablecoin tests
Binance USDC/USDT quote turnover divided by BTC+ETH+SOL USDT quote turnover; disjoint pairs, one venue
Existing global snapshots: 19 completed days; insufficient.

| Asset/proxy | Daily stable-ratio Brier change (positive = better) | Daily stable-ratio magnitude MAE change |
|---|---|---|
| BTC | -0.00009 (Holm p=1.000) | +0.066 pp (Holm p=1.000) |
| ETH | -0.00084 (Holm p=1.000) | -0.038 pp (Holm p=1.000) |
| SOL | +0.00012 (Holm p=1.000) | +0.140 pp (Holm p=0.044) |
| XLM | +0.00102 (Holm p=1.000) | +0.010 pp (Holm p=0.044) |
| XRP | +0.00099 (Holm p=1.000) | +0.147 pp (Holm p=0.044) |
| HYPE | -0.00636 (Holm p=1.000) | -0.021 pp (Holm p=1.000) |
| HBAR | -0.00245 (Holm p=1.000) | +0.225 pp (Holm p=0.044) |
| BTC_ETH_SOL | +0.00031 (Holm p=1.000) | +0.052 pp (Holm p=0.044) |

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
