# Robinhood leveraged-ETF reversal rule

Buys a **confirmed bottom** in a leveraged US ETF and exits on volatility-scaled
targets. Shadow-first: it records decisions and resolves them against real
prices, and does not place orders until the forward record earns it.

## What was actually measured

Three tests, in order, on real data. Each one changed the answer.

**1. The original idea — buy the intraday dip, sell +5–10% — does not work.**
Tested on 4,160 30-minute bars over 64 sessions. The apparent edge was entirely
**look-ahead bias**: a daily-bar backtest cannot tell whether the low came
before the high, so "buy −3%, sell +5%" credits a rally that already happened
before the dip. Requiring the correct order:

| | daily bars (biased) | path-ordered |
|---|---|---|
| SOXL −3% → +5% | **+122.2%** | **−26.8%** |
| TQQQ −3% → +5% | +19.0% | +0.9% |
| NVDL −3% → +5% | +21.4% | −2.5% |

Best surviving result was TQQQ at +0.9% over 64 sessions — indistinguishable
from zero, before spread and slippage.

**2. Fixed percentage stops are the wrong unit.** A first pass at this reversal
rule with a fixed 15% target and 10% stop lost on 8 of 10 symbols, and the
median trade was *exactly the stop*. A 10% stop sits inside the ordinary noise
of an asset whose weekly range is 10–25%.

**3. Sigma-scaled thresholds flip it.** Rescaling every threshold to each
asset's own measured 60-day daily sigma:

| | trades | win | compounded | held instead |
|---|---|---|---|---|
| PLTZ | 3 | 67% | +41.5% | −68.7% |
| NVDL | 4 | 50% | +32.4% | +119.8% |
| TQQQ | 4 | 50% | +29.3% | +93.2% |
| SOXL | 2 | 50% | +25.8% | +416.0% |
| SQQQ | 8 | 50% | +25.4% | −75.7% |
| BITX | 5 | 60% | +21.2% | −53.5% |
| TSLL | 4 | 50% | +3.1% | −32.0% |
| CONL | 9 | 44% | −49.7% | −75.3% |
| TSDD | 6 | 33% | −42.0% | −85.0% |
| MSTU | 9 | 11% | −81.4% | −92.5% |

7 of 10 positive, median +25.4%, consistent across three parameter sets.

## Three things that are not settled

- **The sample is far too small.** 54 trades total, 2–9 per symbol. Nothing
  here separates skill from luck, and the two best results (PLTZ, SOXL) rest on
  3 and 2 trades.
- **It still loses on the structurally decaying products.** MSTU −81%, TSDD
  −42%, CONL −50%. Daily-reset decay is not something a good entry fixes.
- **On the assets worth owning, holding beat it.** SOXL returned +416% held
  against +25.8% traded. Much of the rule's apparent success is being in cash
  while the collapsing names collapsed — which is risk avoided, not alpha.

## The rule

Every clause is an observation about what price has already done. Nothing here
forecasts.

1. The trailing 120-session low was set within the last **15 sessions** — the
   low must be *current*. A 120-session low from four months ago describes an
   asset that already recovered; entering on it is a momentum trade wearing the
   wrong label.
2. Price has since risen at least **1.5σ** off that low, σ being the asset's
   own 60-day daily dispersion measured strictly on prior bars. Without this
   the rule buys the low itself, which is catching the knife.
3. Today **closed up** — the turn is still intact.

Exit at **+6σ**, **−4σ**, or **25 sessions**, whichever comes first. When one
daily bar spans both the stop and the target it resolves as the **stop**: daily
bars cannot order the two, and taking the unflattering reading is the
difference between an honest backtest and the +122% artefact above.

## Long versus inverse is not a detail

A bottom in a leveraged **long** (TQQQ, SOXL, NVDL) is a bet the underlying
recovers, amplified 2–3x — the leverage works with you. A bottom in an
**inverse** (PLTZ, TSDD, SQQQ) is a bet the underlying *falls*, with
daily-reset decay working against the position the whole time. Both are
tradeable; they are not the same trade, and the ledger never pools them.

## Where it runs

Unlike the Binance bots, this cannot run on the Oracle instance: Robinhood
access here is through a session-bound connector, not an API key on a server.
So the rule lives here as versioned, tested code and the evidence accumulates
in D1 (`robinhood_shadow_trades`, `robinhood_watchlist_state`), but execution
needs either a scheduled agent with connector access or a manual run.

`robinhood_watchlist_state` records where every candidate stood on every
observation day, whether or not it fired — without the misses there is no way
to ask later how close the near-misses came, or whether the thresholds are set
anywhere near right.

## Account reality

The agentic account is a **cash** account holding **$50.61**. T+1 settlement
limits round-trips, and at this size the exercise is educational rather than
material. That is an argument for letting the shadow record run, not against.

```bash
node test.mjs    # 20 assertions, no network, no broker
```
