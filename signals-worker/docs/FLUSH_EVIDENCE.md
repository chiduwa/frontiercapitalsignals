# Liquidation flushes: what rebounds, what keeps falling, and where the bottom is

Method version `fcs-flush-v1`, 2026-09-12. Motivated by a real loss:

> "even though they were going to move upwards eventually, they dipped
> drastically for a few minutes (five minutes or less) liquidating me before
> rebounding."

## The event

**WLFI, 2026-09-11 10:15 UTC: −16.45% in under five minutes, 56× normal
volume, 57% of the drop retraced within thirty minutes.** Taker buying was 26%
of flush volume (i.e. three quarters of it was hitting the bid) and open
interest fell 5.67% across the window.

Found by scanning 1-minute klines from Binance's public data portal. DEXE shows
ten comparable events in 45 days.

## Study

189 flush events across 30 symbols over 60 days. A flush is a drop of ≥6% from
the highest high of the preceding 5 minutes to the lowest low of the next 5.
"Recovery" is the fraction of that drop retraced within the following 30
minutes; 100% means price returned to the pre-flush high.

Open interest is measured across the same window from the portal's 5-minute
metrics files, so "did positions close or open during the drop" is observed,
not inferred.

## Result 1 — the discriminator is open interest, and it runs OPPOSITE to intuition

| open interest across the flush | n | median recovery |
| --- | --- | --- |
| **fell ≥1%** (positions being liquidated out) | 121 | **50.3%** |
| flat (−1%…+1%) | 25 | 62.2% |
| **rose ≥1%** (new shorts entering) | 43 | **106.2%** |

Difference in medians **+55.9 points, permutation p < 0.0001**.
Spearman(OI change, recovery) = **+0.505, t = 7.99, n = 189**.

The hypothesis this study was built to test was the reverse: that falling OI
means forced selling is exhausting itself and the move should therefore be
self-limiting. **That is wrong, and it is wrong with a large effect size.**

The mechanism that fits the data instead:

* **OI falling = the leveraged longs are gone.** Liquidation does structural
  damage. The accounts that would have bought the dip have just been closed out
  of it and cannot come back. Median recovery ~50% — the price finds a new,
  lower level.
* **OI rising = new shorts are pressing into a fast drop.** Those shorts are
  themselves leveraged and vulnerable, and the >100% median recovery is them
  being squeezed back out. The drop retraces *completely*.

So a violent dip is not one phenomenon. Whether it is an opportunity or a
warning depends on who is on the other side, and OI direction says which.

## Result 2 — who is absorbing matters too

| taker buy share during the flush | n | median recovery |
| --- | --- | --- |
| <35% (heavy forced selling into bids) | 37 | 56.5% |
| 35–50% | 139 | 62.2% |
| **>50% (buyers lifting offers)** | 13 | **108.1%** |

**+51.6 points, permutation p < 0.0001.** Same story from the trade tape rather
than the position data, which is a useful independent confirmation.

## Result 3 — a NEGATIVE result, recorded because it looked convincing

On the first twelve events I eyeballed, volume surge looked like a clean
discriminator: the 37–56× events recovered 57–96% while the 2–9× events
recovered 30–37%. **It did not replicate.** On the full 189:

| volume surge | n | median recovery |
| --- | --- | --- |
| >35× normal | 7 | 71.0% |
| <5× normal | 147 | 67.2% |

**+3.8 points, permutation p = 0.85.** Volume surge tells you a flush is
happening. It tells you nothing about whether it comes back. Do not build on it.

## Result 4 — where the bottom actually is

The number the entry offset needs:

| regime | n | median trough vs pre-flush high | 10th pct | 90th pct |
| --- | --- | --- | --- | --- |
| OI fell (liquidation) | 121 | **−7.80%** | −13.0% | −6.2% |
| OI flat | 25 | −6.73% | −9.6% | −6.1% |
| OI rose (new shorts) | 43 | −7.32% | −12.5% | −6.1% |

## What this implies for the bot

The trading bot's entry offset is an **uncalibrated 5% operator floor**
(`entryOffsetMinPct`), and only 1 of 16 shadow intents was ever touched at it.
Against these measurements 5% is not conservative — it is in the wrong place
entirely: the median flush bottoms at −7.8%, so a 5% limit is filled on the way
DOWN, mid-cascade, with another ~3% still to come. That is close to the
worst-possible fill, and it matches the reported experience.

Two changes follow, and they are opposite in direction:

1. **For entries taken during or just after a flush**, the offset should be
   ~7.8% (median trough), not 5%, with the tail at −13% informing the stop
   rather than the entry.
2. **For entries with no flush in progress**, 5% is far too wide — it is a
   flush-sized offset applied to a calm tape, which is why almost nothing fills.

The single offset is trying to serve two different regimes. Splitting it is the
work this evidence enables, and neither number should be hand-set again.

## Limits

* 60 days, 30 symbols, 189 events. Enough for the OI effect (p < 0.0001, ρ =
  0.505); thin for the taker-buy cut (n = 13 in the high bucket).
* Recovery is measured over a fixed 30-minute window. A different horizon may
  rank these regimes differently.
* Flushes are detected with hindsight. **Nothing here shows the OI signal is
  readable FAST ENOUGH to act on mid-cascade** — the portal publishes OI at
  5-minute granularity after the day closes. Live use requires the Oracle
  host's direct feed, and that latency question is unanswered.
* No costs, no slippage. A 16% flush does not fill at its low.
