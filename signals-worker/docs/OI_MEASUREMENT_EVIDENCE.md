# Open interest: how it was being measured, and what it actually predicts

2026-09-14. Prompted by a real complaint: BTW sent a stream of alerts over 24
hours, most of them about open interest rising, and at 01:36 UTC one said the
asset was rising while it had just dropped hard over the preceding hour.

Three separate things were wrong. One is a measurement bug that invalidates an
earlier study. One is a reporting bug. The third is the answer to "is there a
scalping signal in here", and the answer is no.

## Data

804,082 five-minute bars, 38 Binance USDs-M perpetuals, 2026-07-01 to
2026-09-12, from `data.binance.vision` (`futures/um/daily/metrics` joined to
`futures/um/daily/klines/5m`). Independent of the 60-day window the original
flush study used. Reproduction scripts are not checked in; the numbers below
are what they produced.

### An alignment trap worth recording

A metrics row stamped `create_time = T` looks like it summarises the five
minutes ending at T. It does not. The snapshot is taken at **T + 5 minutes**,
so `create_time` labels the window's START.

The test is exact, because `sum_open_interest_value / sum_open_interest` is the
mark price at the instant of the snapshot. Against the kline opening at `T-5m`
the mean error is **0.0683%**; against the kline opening at `T` it is
**0.0041%**.

Joining the intuitive way attaches open-interest data from five minutes in the
future to every price bar. Any forward-return study built on that join would
have manufactured an edge out of nothing.

## 1. The measurement bug

`sum_open_interest_value` is contracts multiplied by mark price. A price move
appears in it whether or not a single contract changed hands. Everything in
this project that classified a move on "open interest" read that column:
`oi-sampler.mjs`, `flush-research.mjs`, and the `openinterest` technique.

| measured over the same 5-minute bar | correlation with the price move |
| --- | --- |
| open interest as **USD notional** | **r = 0.910** |
| open interest in **contracts** | r = 0.192 |

On bars that moved at least 2% in five minutes:

| | notional says | contracts say |
| --- | --- | --- |
| price rose, read as "new-position" | **98.6%** | 9.6% |
| price fell, read as "liquidation" | **99.3%** | 16.3% |

So the classifier was `sign(price change)` with about 99% fidelity, reported to
the reader as an independent confirmation of it. The two columns disagree on
the sign of the OI change on **33.8%** of fast bars.

Scale, on the bars the live detector actually fires on (at least 4% in five
minutes): median |change| is **5.47% in notional against 0.247% in contracts**,
a factor of 22. This is why `OI_DECISIVE_PCT = 1` could not simply be carried
over to contracts: it would have abstained on 94% of events.

### The BTW alert, in numbers

01:31:44 to 01:36:44 UTC on 2026-09-14, from this project's own `oi_tick` rows:

| | |
| --- | --- |
| mark price | 0.65745 to 0.68527, **+4.23%** |
| open interest, USD notional | 105.58M to 109.88M, **+4.07%** |
| open interest, contracts | 160,591,513 to 160,337,695, **-0.16%** |

The entire "+4% of new positioning" was the 4.2% price rise. Contracts fell.
And the 4.2% itself was a bounce off a five-minute low inside a collapse: BTW
was 7.0% below its price an hour earlier and 11.0% below the session high.

## 2. The flush study does not replicate on contracts

`docs/FLUSH_EVIDENCE.md` reports that open-interest direction through a violent
move separates what happens next. Replicated here, 1,451 episodes (771 dips,
680 spikes), same 2x2, both columns:

| | separation in 30-minute retrace | t |
| --- | --- | --- |
| dips, notional OI | +35.8 points | 8.02 |
| dips, **contracts** | +6.1 points | **1.37** |
| spikes, notional OI | -38.6 points | -7.75 |
| spikes, **contracts** | -4.9 points | **-1.22** |

The notional numbers reproduce the original study closely (+31.9 and -54.8).
The contracts numbers are not significant.

**The mechanism is visible in the data.** Episodes the notional column labels
"OI rose" had already retraced a median **47.1%** of the move before the
30-minute measurement window opened. Episodes it labels "OI fell" had retraced
**17.5%**. Because `oiv` carries the price back in, the classification was
sorting episodes by how much of the outcome had already happened, and then
predicting the outcome. It is outcome leakage, not an open-interest finding.

**Money was on this.** `planEntry` has two callers. The observer in
`oi-sampler.mjs` only records, but `trading-bot/src/flush-executor.mjs` places
real Binance futures orders from it, and it is enabled on the host: it attempted
a live SELL on BTW at 2026-09-13 10:03 UTC. That order did not fill, and the
only reason is that Binance rejected it for quantity precision (HTTP 400,
`-1111 Precision is over the maximum defined for this asset`). No safety gate
stopped it. Fixing that unrelated formatting bug would have armed it.

`flush-gates.mjs` now refuses the setup by default, consistent with that file's
own rule that every gate defaults to a refusal, and names the override
(`FLUSH_EXEC_ALLOW_UNPROVEN=true`) in the refusal message. This is not a claim
that the setup loses money. It is that the number it was sized and justified on
does not survive being measured correctly.

## 3. Is there a short-horizon signal? No.

The question asked was whether rapid open-interest changes predict 15 to 30
minute price movement, alone or combined with other metrics.

**Open interest alone: nothing.** Bucketing by `oiZ` (how unusual this bar's
contract change is against the symbol's own trailing 24 hours) produces no
stable, significant cell at 15 or 30 minutes. Its information coefficient
against market-excess forward returns is 0.000 to 0.002 and does not hold its
sign across chronological halves.

**The four-quadrant read: nothing.** Price direction crossed with contracts
direction, on rapid moves, gives spreads of 0.04 percentage points or less at
both horizons with |t| below 1 after adjusting for overlapping windows. 36
hypotheses were tested; |t| near 2 is expected by chance at that count.

**Two other columns do carry signal**, both contrarian and both sign-stable
across halves:

| feature | IC vs excess fwd15 | IC vs excess fwd30 | halves agree |
| --- | --- | --- | --- |
| change in all-account long/short ratio | **-0.046** | -0.030 | yes |
| price return over the prior 30 min | -0.031 | **-0.036** | yes |
| change in top-trader position ratio | -0.014 | -0.011 | yes |
| trade-count ratio vs median | +0.015 | +0.021 | yes |
| **open interest (any form)** | ~0.000 | ~0.002 | no |

Read plainly: when the retail crowd rotates long, the asset underperforms over
the next half hour, and short-term moves partly revert. Open interest adds
nothing to either.

**The composite is real and too small to trade.** Cross-sectional z-scores of
the three contrarian features, winsorised at 3, decile long minus decile short
on market-excess returns:

| hold | spread | t | halves | vs the 0.24pp cost of a long/short pair |
| --- | --- | --- | --- | --- |
| 15m | 0.064pp | 10.47 | 0.060 / 0.069 | 0.27x |
| 30m | 0.075pp | 6.25 | 0.077 / 0.073 | 0.31x |
| 60m | 0.087pp | 3.71 | 0.102 / 0.072 | 0.36x |
| 8h | 0.095pp | 0.54 | 0.085 / 0.105 | 0.40x |

The effect is about a third of the cost of harvesting it, at every horizon. It
does not grow fast enough with holding time to catch up.

The edge does concentrate in the tail (top and bottom 0.5% of the score spread
0.397pp, 1.65x cost), and a long-only version of the top 1% at 30 minutes has a
mean of +0.204% against a 0.12% round trip, 56.6% win rate, both halves
agreeing. It still fails, for three reasons that are each sufficient:

1. **The median signal loses money.** Median +0.089% against a 0.12% cost. The
   mean is carried by a right tail, and dropping the 50 best outcomes out of
   8,038 cuts the net edge from +0.084% to +0.018%. Any stop-loss clips exactly
   that tail.
2. **It only exists where the cost is highest.** By liquidity tier, at 30
   minutes: deepest 10 symbols +0.061% (against ~0.10% cost), middle 14
   +0.089% (~0.14%), thinnest 14 **+0.317%** (~0.20%). Only the thin tier is
   positive gross, and that estimate of its cost is generous.
3. **It does not survive latency.** 53% of the 30-minute move happens in the
   first five minutes. Delaying entry by one 5-minute bar drops the mean from
   +0.204% to +0.109% and the win rate from 56.6% to 52.6%. The long/short
   account ratio publishes on a 5-minute schedule, so the delayed case is the
   real one.

Thin books **and** realistic latency together, which is the only configuration
that could actually run:

| tier | immediate | delayed 5 min | cost | net when delayed |
| --- | --- | --- | --- | --- |
| deepest 10 | +0.061% | +0.016% | 0.10% | **-0.084%** |
| middle 14 | +0.089% | +0.042% | 0.14% | **-0.098%** |
| thinnest 14 | +0.317% | +0.176% | 0.20% | **-0.024%** |

Every realistic cell is negative. **No scalping indicator was built, because
the evidence does not support one.**

This is the same shape as the finding in the earlier volume work: a real,
reproducible, statistically strong microstructure effect that is smaller than
the cost of trading it. Measuring it was worth doing. Shipping it would not
have been.

## What changed in the code

- `scripts/price-change.mjs`, new. Point-to-point change, excursion from an
  extreme, and path efficiency are three different quantities and are now kept
  apart. Every percentage an alert reports carries its anchor.
- `scripts/oi-sampler.mjs` classifies on contracts, anchors the OI change to the
  move's own window rather than to a sliding sample window, cuts decisive at
  0.25% (the median |contracts change| on its own trigger population), and
  dedupes alerts by episode with a 30-minute cooldown. One BTW move previously
  wrote 262 `flush_event` rows and alerted on nearly all of them, because the
  event id keyed off the first tick of a window that advanced every sample.
- `scripts/flush-entry.mjs` keeps its constants and marks them unproven.
  `continuationCall` no longer asserts a 12-hour median and no longer claims a
  move will continue.
- `trading-bot/src/flush-gates.mjs` refuses the live short-covering setup unless
  `FLUSH_EXEC_ALLOW_UNPROVEN=true`, and `flush-executor.mjs` logs the hold
  rather than reporting "no candidates".
- `scripts/notify.mjs` sends the full horizon ladder with each sudden-move
  alert and says so in the title when the horizons disagree.
