# Per-asset prediction weights: what the data supports

2026-09-14. Follow-up to `OI_MEASUREMENT_EVIDENCE.md`, answering two questions
that were asked after it: use the `flush_event` rows rather than clearing them,
and find per-asset weights for prediction at long, short, or scalping horizons.

Short version: the `flush_event` rows turned out to be worth keeping, because
they independently confirm the measurement bug on live data. The per-asset
weights do not exist. Four independent tests, three datasets, all negative, and
the reason is the same each time — the dispersion between assets is real but it
does not persist, so there is nothing stable to weight on.

## 1. The `flush_event` rows, used rather than cleared

274 rows, 2026-09-13T09:53 to 2026-09-14T03:34, BTW and FIL. They collapse to
**97 episodes** — the flood the dedupe fix addressed. Each row was joined to
this project's own `oi_tick` table, which stores `oi_contracts`, `oi_usd` and
`mark_price` side by side, so the two ways of measuring open interest can be
compared over the identical five-minute window on live production data.

| over the same 5-minute window, 274 live rows | |
| --- | --- |
| correlation, OI **as USD notional** vs price change | **r = 0.998** |
| correlation, OI **in contracts** vs price change | r = 0.354 |
| notional change has the same sign as the price change | **97.8%** |
| contracts change has the same sign as the price change | 63.9% |
| mean absolute change, notional | 3.156% |
| mean absolute change, contracts | 0.140% |
| the two columns disagree on the sign | **33.9%** |

The historical study in `OI_MEASUREMENT_EVIDENCE.md` used 804,082 bars across 38
symbols and an entirely separate data source (`data.binance.vision`). It found
r = 0.910, a 22x magnitude gap, and a 33.8% sign disagreement. The live rows
give r = 0.998, 22.5x, and 33.9%.

Two independent datasets agreeing to three significant figures on the
disagreement rate. The number the alerts called "open interest" was the price
move, and these rows are the proof. That is what they are for; they should be
kept.

## 2. Per-asset weights, short horizons

**Data.** 148 Binance USDs-M perpetuals, 2026-03-17 to 2026-09-13,
**6,800,046 five-minute bars**, from `data.binance.vision`. Four times the
earlier study, and the universe was picked by ranking all 876 available perps by
traded volume rather than by hand. Every forward return is market-excess: the
cross-sectional mean at that instant is subtracted, so "the whole market moved"
cannot survive as a signal. The metrics/kline alignment trap documented in the
earlier file is applied here too.

**Information coefficients**, against market-excess forward returns, with the
sign required to agree across chronological halves:

| feature | 15m | 30m | 60m | 4h | 8h | 24h | stable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| change in all-account long/short ratio | **-0.0177** | -0.0134 | -0.0102 | -0.0069 | -0.0057 | -0.0027 | 15m–8h |
| return over prior 5m | -0.0162 | -0.0114 | -0.0089 | -0.0057 | -0.0038 | -0.0012 | 15m–4h |
| return over prior 15m | -0.0154 | -0.0117 | -0.0103 | -0.0066 | -0.0038 | -0.0010 | 15m–4h |
| volume vs its own 24h median | 0.0044 | 0.0053 | 0.0064 | **0.0082** | 0.0082 | 0.0080 | 30m–24h |
| trade count vs its own 24h median | 0.0041 | 0.0052 | 0.0061 | 0.0063 | 0.0069 | 0.0076 | 30m–24h |
| **open interest in contracts, 60m** | 0.0024 | 0.0032 | 0.0038 | 0.0061 | **0.0071** | 0.0067 | 4h–24h |
| open interest, any 5m or 15m form | ~0.000 | 0.001 | 0.002 | 0.004 | 0.004 | 0.004 | none |

Two things here are new. Contract open interest does carry a small, sign-stable
signal, but only from four hours out — not at the scalping horizons it was being
used for. And volume and trade-count ratios are the most durable features in the
set, stable from 30 minutes to a day.

**The portfolios.** Composite of the sign-stable features for each horizon,
cross-sectionally z-scored and winsorised at 3, decile long minus decile short,
measured on **non-overlapping** observations:

| horizon | independent obs | spread | t | win rate | cost | net |
| --- | --- | --- | --- | --- | --- | --- |
| 60m | 4,307 | 0.0873% | **5.66** | 54.4% | 0.24% | **-0.153%** |
| 4h | 1,076 | 0.0736% | 1.53 | 49.8% | 0.24% | -0.166% |
| 8h | 538 | 0.1125% | 1.11 | 49.3% | 0.24% | -0.128% |
| 24h | 179 | 0.0934% | 0.36 | 46.4% | 0.24% | -0.147% |

The 60-minute effect is strongly significant and reproduces the earlier finding
on four times the data. The hope behind testing 4h to 24h was that a slower book
would amortise the cost. **It does not: the spread stays near 0.09% no matter
how long the position is held**, so the cost is never earned back. Holding
longer only destroys the significance.

## 3. Per-asset weights do not persist

This is the question that was actually asked, so it was tested directly. Each
symbol's own sensitivity to the 60-minute composite was fitted on the first half
of the panel and compared with the second half. 136 symbols had enough data.

| | |
| --- | --- |
| correlation, first-half IC vs second-half IC | **-0.036** |
| strongest quintile in the first half | IC 0.0558 → **0.0177** in the second |
| weakest quintile in the first half | IC -0.0191 → **0.0206** in the second |
| cross-symbol spread of IC | 0.0284 |
| spread expected from sampling noise alone | 0.0062 |

The dispersion between assets is larger than noise, so assets genuinely do differ
in how strongly they respond. But which assets those are does not carry over:
the correlation between one half and the next is -0.036, and both extreme
quintiles revert almost exactly to the universe average. The symbols that looked
best were the ones that had been lucky.

The economic version confirms it. Restricting the book to the twenty-seven
symbols that scored highest in the first half, and trading only those in the
held-out half:

| book | spread | t | net of cost |
| --- | --- | --- | --- |
| all 148 symbols | 0.0873% | 5.66 | -0.153% |
| best-quintile symbols only | 0.0867% | 3.42 | -0.153% |

Per-asset selection bought nothing at all — the same spread, fewer names, the
same loss after cost.

## 4. Per-asset weights on the daily and weekly log

`forecast_outcomes` holds 1,143,975 scored forecasts over 558 symbols back to
2021. **One caveat that governs how it can be read: 838,792 of those rows are
`provenance = 'replay'`, a backtest of `confluence-v8` over history. Only 63,460
are live, and only since 2026-09-03.** The replay is still a legitimate
point-in-time simulation, but it is not a live track record and is not described
as one here.

Per-asset edge was fitted on an early period and tested on a later one, with the
significance taken across dates rather than across observations — because
everything in one day shares a market and pooling the observations overstates
the evidence, which is exactly what it did here (pooled quintiles looked clean
until they were clustered by date).

| test | held-out | spread | t | win days |
| --- | --- | --- | --- | --- |
| crypto, 1-day horizon | 513 days | +0.082%/day | **1.21** | 52.6% |
| crypto, 7-day horizon | 88 obs | -0.125% | **-0.29** | 51.1% |
| stocks, 1-day horizon | 219 days | +0.067%/day | **1.27** | 51.6% |

None of the three reaches significance, and the weekly horizon has the wrong
sign. Together with the 5-minute panel, that is four independent tests of
per-asset weighting across three datasets and four horizon families, all
negative.

## What this means for the code

No weights were shipped, because fitting them would have been fitting noise. The
honest summary is that this system's cross-sectional signal is real at one hour,
worth about a third of what it costs to trade, and identical across assets once
you account for luck.

The signal is not worthless — it is worth exactly zero *net of fees*, which is a
different thing. Where it costs nothing to apply, it still carries information,
and that is where it belongs: ranking and annotating alerts, not sizing trades.

Reproduction scripts are not checked in. The numbers above are what they
produced, and the inputs are all public (`data.binance.vision`) or in this
project's own D1 tables (`flush_event`, `oi_tick`, `forecast_outcomes`).
