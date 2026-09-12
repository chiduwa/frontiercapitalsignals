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

> **SUPERSEDED BELOW.** The first pass (n=189) double-counted: scanning for
> up-spikes also matched the REBOUND out of every dip, so a V-shape was logged
> twice and the "OI rose → 106% retrace" figure for dips was contaminated by
> its own rebounds. `dedupeEpisodes` fixes it. The corrected study (n=248,
> both directions, one episode per move) is the authority; the OI effect
> survives, but the interpretation changes materially. Kept here because the
> error is instructive.

## Corrected result — OI direction says whether the move CONTINUES

248 episodes, 30 symbols, 60 days, one record per move.

| | 30-min retrace | 12h return vs pre-event | median trough |
| --- | --- | --- | --- |
| **dip**, OI fell (longs liquidated) | 55.4% | **−9.69%** | 8.45% |
| **dip**, OI rose (new shorts) | **87.3%** | **−13.47%** | 7.56% |
| **spike**, OI fell (shorts covering) | **106.2%** | +6.76% | — |
| **spike**, OI rose (new longs) | 51.4% | **+10.82%** | — |

Dips: +31.9 points between OI buckets, permutation p < 0.0001.
Spikes: −54.8 points, p < 0.0001. The effect is real in both directions.

**But the two columns disagree, and that is the whole point.** A dip with OI
RISING retraces hardest in thirty minutes (87.3%) and is the WORST place to be
twelve hours later (−13.47%). The bounce is a dead cat. Reading only the
recovery column — which is what the first pass did — gets this exactly
backwards.

The unified rule that fits all four cells:

> **Open interest rising through a move means new money is taking that side,
> and the move CONTINUES. Open interest falling means positions are being
> forced shut, and the move is mechanical — it reverses harder in the short
> run and goes less far in the end.**

So OI does not tell you "will it bounce". It tells you **whether the bounce is
worth anything**. Dip + OI falling is a genuine flush that partly recovers and
stabilises. Dip + OI rising is a trend beginning, whose violent bounce will
trap anyone who mistakes it for a reversal.

## Result — a pre-event predictor that works

| pre-event feature | Spearman vs retrace | t | n |
| --- | --- | --- | --- |
| **realized vol, prior 60 min** | **+0.246** | **+3.97** | 246 |
| prior-hour OI trend | −0.056 | −0.89 | 248 |
| prior-hour taker-buy share | −0.057 | −0.90 | 248 |

Only prior volatility carries information, and it is observable *before* the
event: moves that erupt out of an already-volatile tape retrace more. A dip out
of a dead-calm tape is the one that keeps going.

## Result — timing: not periodic, but far from uniform

**Time of day is strongly non-uniform.** χ² = 104.8 against 23 df (p < 0.001;
35.2 would be p = 0.05):

| hour (UTC) | episodes | vs expected (~10.3) |
| --- | --- | --- |
| **05:00** | **39** | **3.8×** |
| 12:00 | 19 | 1.8× |
| 00:00 | 13 | 1.3× |
| 19:00–23:00 | 3–6 each | 0.3–0.6× |

05:00 UTC is the thinnest book of the day — US asleep, Europe pre-open, Asia at
lunch. Nearly four times the episode rate of an average hour, and roughly ten
times the quietest.

**They are bursty, not periodic.** Coefficient of variation of the gap between
consecutive episodes on the same symbol = **2.77** (1.0 would be memoryless
Poisson; below 1 would be regular). Median gap 1.1 hours, mean 33.4 hours — a
distribution that skewed is clusters separated by long silence.

**79% of gaps are under 6 hours.** Once a symbol has flushed, another is likely
within hours.

**They are idiosyncratic, not market-wide.** Only 1 of 60 days had ≥8 of 30
symbols flush together (2026-08-22 — the day both WLFI and DEXE flushed). 24
days had exactly one symbol. Just 12% of episodes fall on market-wide days.

Base rate: **one episode per 7.3 symbol-days** (0.138/symbol/day).

### What that means for the spot bot

* **You cannot time these on a clock.** There is no interval to schedule around.
* **You can avoid the worst window.** 05:00 UTC carries ~4× the risk of an
  average hour; 19:00–23:00 UTC is the calmest. Sizing down or widening stops
  around 05:00 is defensible purely on frequency.
* **The first flush is not the end.** 79% of repeat episodes arrive within six
  hours. Treating a flush as "the event has passed" is wrong more often than
  not — this is the single most actionable timing fact here.
* **A market-wide volatility filter will not protect you.** 88% of episodes are
  single-symbol. The risk is per-asset, not regime-level.

## What this implies for the bot

The trading bot's entry offset is an **uncalibrated 5% operator floor**
(`entryOffsetMinPct`), and only 1 of 16 shadow intents was ever touched at it.
Against these measurements 5% is not conservative — it is in the wrong place
entirely: the median flush bottoms at −7.8%, so a 5% limit is filled on the way
DOWN, mid-cascade, with another ~3% still to come. That is close to the
worst-possible fill, and it matches the reported experience.

Two changes follow, and they are opposite in direction:

1. **For entries taken during or just after a flush**, the offset should be
   ~8.45% for a liquidation flush (median trough, corrected), not 5%, with the
   p90 at 14.7% informing the stop rather than the entry.
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
