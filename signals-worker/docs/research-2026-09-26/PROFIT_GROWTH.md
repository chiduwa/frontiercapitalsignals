# Profit growers: small and mid-cap companies growing their profits

2026-09-26. Asked: "for the stock check for companies making profit and then other relevant. profit seems to drive stock growth and i believe small and mid cap companies with relatively growing profits might be gems with their own categories to consider."

## Short answer

Supported, moderately. Over 37 quarters (April 2017 to July 2026), the top 25 profitable, growing companies in each size bucket beat every other company of their size over the next 13 weeks:

| List | Per quarter vs same-size stocks | t | Quarters ahead | Halves | Since mid-2021 |
|---|---|---|---|---|---|
| Small caps ($300M-$2B), ranked by revenue growth | **+1.72%** | 1.58 | 65% | +0.38 / +2.99 | **+2.97%** (t 1.94, 70%) |
| Mid caps ($2B-$10B), ranked by operating-profit growth | **+1.99%** | 2.73 | 73% | +1.15 / +2.78 | **+2.66%** (t 2.37, 80%) |

Large caps show the same direction with a smaller effect (consistent growers +0.8%/quarter recently), which fits "small and mid caps are where the gems are".

## Data

* **Profits:** SEC XBRL "frames", which return one fact for every filer for one period in one call: `NetIncomeLoss`, `OperatingIncomeLoss`, `Revenues` / `RevenueFromContractWithCustomerExcludingAssessedTax` / `SalesRevenueNet`, `EarningsPerShareDiluted`, `dei:EntityCommonStockSharesOutstanding`, 2009-2026. 14,812 companies, 404,043 company-quarters.
* **Tickers:** SEC `company_tickers_exchange.json`. **Universe and market caps:** Nasdaq's stock screener (7,017 US listings in one call). **Prices:** Nasdaq's quote API, 10 years daily, split-adjusted, not dividend-adjusted (Yahoo rate-limited the download machine).
* Scripts: `scripts/fetch_frames.py`, `build_fundamentals.py`, `fetch_prices_nasdaq.py`, `backtest.py`, `profit_stats.py`, `final_screen.py`, `survivorship.py`. Outputs: `profit-growth-*-output.txt`, `survivorship-output.txt`.

A fourth quarter is rarely tagged on its own, so it is derived as the annual figure minus the three quarters inside it, matched on the records' real start and end dates. Checked against Apple's reported numbers (fiscal Q4 2024 net income $14.736B, the quarter with the EU tax charge) and in the production JavaScript against the Python on 469 quarterly values across 7 companies with September, June and January fiscal years: all identical.

## Method

* **Point in time.** Formation date = calendar quarter end + 105 days, so every filer's 10-Q (45 days) and even a late non-accelerated 10-K (90 days) is public. Only quarters ending by then are used; a company needs eight consecutive quarters and a filing for the latest or previous quarter.
* **Size at formation:** today's share count times the price then. Share issuance since makes this approximate, the same way for every group.
* **Filters, identical for every group:** price >= $2, median weekly dollar volume over the prior 13 weeks >= $2.5M (about $500K a day).
* **Outcome:** price return to the next formation (13 weeks, non-overlapping). Excess = the list's equal-weight return minus the equal-weight return of every stock in the same bucket that passed the same filters. Each stock-quarter clipped at -100%/+300%.

## Survivorship: the bias that shaped what is quoted

Free price data covers only companies still listed today. Of the companies filing in mid-2017, **57% of the profitable ones are exchange-listed today but only 27% of the unprofitable ones** (2021: 69% vs 43%; 2025: 82% vs 64%). The unprofitable companies in the early backtest are the lucky survivors, which flatters the comparison group and works **against** profit growers. It also explains the raw pattern: in the early half, unprofitable small caps "beat" the bucket by +3.5%/quarter, and in the recent half they are flat. So the recent half (formed mid-2021 on), where the bias is smallest, is quoted alongside the full period.

Two more biases, both also against the growers: prices exclude dividends, which profitable companies pay more often, and companies acquired at a premium (disproportionately profitable) are missing.

## How the screen was chosen

First pass, fixed before looking (13-week excess, full period / since mid-2021):

| Small caps | Full | Recent |
|---|---|---|
| Profitable (any) | -0.78% | +0.03% |
| Unprofitable | +1.72% (survivorship) | -0.09% |
| Growing profits (net +20%, revenue up) | +0.18% | +1.50% |
| Consistent growers (profitable 4/4, up YoY 3 of 4, revenue up) | +0.45% | +2.12% (t 2.03) |
| Operating growers (op. profit +20%, revenue up) | +0.74% | +1.91% (t 2.26, 80%) |
| Turned profitable | -0.85% | n/a |

Medians told the survivorship story more plainly: the typical profit grower beat the typical small cap by about +1.1% to +1.35% a quarter even in the full period.

Growth *speed* alone (fastest vs slowest third of profitable companies) added nothing. Inside the consistent-or-operating growers, six ranking variables were tried; the only ones positive in both halves were **revenue growth for small caps** (+1.44%/quarter top half vs bottom) and **operating-profit growth for mid caps** (+0.66%). Momentum and P/E were inconsistent. Picking from six candidates on the same history flatters the result a little; it is stated on the page.

Looking at the first live lists showed net-loss companies (operating profit up, net result negative) and revenue jumps over 1,000% (acquisitions). Two refinements were tested before adoption:

| Top 25 | Small, full | Small, recent | Mid, full | Mid, recent |
|---|---|---|---|---|
| First version | +2.11% (t 1.91) | +3.44% | +1.51% (t 1.86) | +1.72% |
| + net profit > 0 | +1.45% | +2.80% | +1.98% (t 2.59) | +2.64% |
| **+ net profit > 0, revenue growth <= 300% (adopted)** | **+1.72% (t 1.58)** | **+2.97%** | **+1.99% (t 2.73)** | **+2.66%** |

Adopted because every listed company should actually be making money (the user's own framing) and because it held or improved the result, with both halves positive in both buckets. Held longer (overlapping windows, mean only): small +3.9% over a year, mid +1.2% over a year; the mid-cap edge sits mostly in the first quarter after a company qualifies, which suits lists that refresh daily as filings arrive.

## What was built

* `scripts/profit-growth.mjs`: the daily job (SEC frames for 11 quarters and 4 annual periods, Nasdaq screener, 13-week liquidity for the leading candidates), the lists, profit facts for every listed company (`company_profit_metrics`), a weekly snapshot of each bucket (`profit_growth_benchmark`), and forward scoring of weekly cohorts at 28, 91 and 182 days (`profit_growth_outcomes`).
* `.github/workflows/signals-profit-growth.yml`, daily at 22:40 UTC.
* The dashboard's **Profit growers** view, and a profit line in every US stock's details on the Live screens.

## Honest limits

* t of 1.6 to 2.7 over 37 quarters is moderate evidence, not proof.
* The live record will take a year or more to say anything on its own (four independent 13-week periods a year).
* SEC frames carry the most recently filed value for a period, so restatements can leak in slightly.
