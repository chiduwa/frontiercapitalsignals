# FCS multi-market research bot

A runnable, local research bot for evaluating three fixed strategy families
across SPY, QQQ, BTC/USD, GLD and USO. It collects public historical candles,
replays long/cash decisions, and prints the latest historical signal snapshot.
It has no broker client, account credentials, order endpoint or live mode.

The first investigation is in [research/ASSESSMENT.md](research/ASSESSMENT.md),
with retained input, per-trade results and equity observations. The evidence
does not support integrating these rules into FCS live entry authorization.
The futures bot, spot accumulator and Robinhood reversal rule have different
instruments, purposes and evidence gates, so this is a separate research bot
inside the same repository.

## Run

Requires Node 22 or later, no installed dependencies. From this directory:

```sh
npm test
node research.mjs research/2026-09-11-data.json > /tmp/fcs-multi-market-report.json
node scan.mjs research/2026-09-11-data.json
```

Collect another snapshot, then evaluate it:

```sh
node collect.mjs /tmp/fcs-market-data-new.json
node research.mjs /tmp/fcs-market-data-new.json > /tmp/fcs-market-report-new.json
node scan.mjs /tmp/fcs-market-data-new.json
```

Collection refuses to overwrite an existing dataset. It makes four Yahoo
requests and fifteen Coinbase requests, each with a 25-second timeout, and
fails visibly on invalid data. It does not poll or schedule itself. `scan`
prints observations from the supplied history, explicitly non-executable;
it is not a forward paper-trading ledger or an order proposal. Dataset age
is exposed, and a historical signal never authorizes a current trade.

## Fixed experiment

| Instrument | Signal bars | Long entry | Signal exit | Initial stop |
|---|---|---|---|---|
| SPY | 15 minutes | Close below 20-bar mean by >1.5 population standard deviations | Close reaches mean | 1 ATR |
| QQQ | 15 minutes | Same, >1.8 deviations | Close reaches mean | 1 ATR |
| BTC/USD | 1 hour | Close exceeds prior 20 highs; volume ≥1.5× prior mean volume | Close below prior 20 lows | 2 ATR |
| GLD, USO | Session bars | 50 EMA crosses above 200 EMA | Opposite crossover | 3 ATR |

These are hypotheses adapted from the creator's guide, not discovered optimal
parameters. The long/cash variant omits stock shorts and the guide's combined
portfolio filter. ATR uses Wilder smoothing over 14 bars. EMAs seed with
their own initial simple average. Commodity session bars are 09:30–13:30 and
13:30–16:00 New York, including the 2.5-hour closing bar. This explicit
convention affects crossover results; it is not a 24-hour commodity contract.

Decisions use only completed candles. Entries and signal exits execute at the
next bar's open with adverse slippage. Breakout thresholds exclude the signal
bar. Trailing stops tighten using the close and ATR after processing that
bar's existing stop; they never loosen. Stops crossed by an opening gap use
the opening price. Intrabar stop exits are timestamped at bar end because
OHLC cannot reveal their exact execution time.

Each symbol has its own hypothetical $10,000 cash account, with no leverage.
Quantity is the smaller of cash affordability and 1% equity divided by the
actual stop distance plus estimated round-trip costs. This fixes the guide's
conflict between sizing on one ATR and stopping at multiple ATRs. A 10%
observed account drawdown latches an entry halt and exits an outstanding
position at its next open. It does not promise a 10% maximum loss. Drawdown
uses observed opens/closes and modeled stop fills, not a complete tick path.
Account funds and P&L are never pooled across instruments.

## Evaluation and limitations

Parameters are frozen. Each instrument splits its available history 70/30
after indicator warmup; both periods start with fresh cash and fresh
decisions. Prior bars can warm indicators, but positions never cross the
split. No training optimization occurs. The later historical sample is
descriptive, **not a prospective or statistically validated holdout**.

Base execution assumptions per side: 5 bps slippage, 1 bp equity fee allowance,
25 bps crypto taker fee. Stress uses 15 bps slippage. Equity fees are a
scenario allowance, not an exact account tariff. Crypto fees are modeled as
proportional cash costs, not exact fee-denominated asset accounting. Buy/hold
uses the same dates, full starting cash and modeled costs. Returns are price
returns; dividends, cash interest and taxes are omitted. There is no claim
about Sharpe, significance, monthly income or combined portfolio performance.

Yahoo supplies 59 calendar days of 15-minute ETF bars and up to 700 days of
hourly GLD/USO bars. Only complete regular sessions are assembled. A known
unusable completed session discards the preceding history, preventing trades
from crossing a known gap. Coinbase requests 180 days of hourly BTC candles,
then retains the latest continuous segment if gaps exist. Gap records and
discarded counts are retained. This coverage rule depends only on missing
data, never returns; it still narrows market-regime coverage. Whole missing
equity sessions require an exchange-calendar audit; this collector does not
claim that audit. In-progress sessions are omitted.

Prices are research proxies, not executable Alpaca quotes. Coinbase volume
is actual Coinbase volume, which can differ from Alpaca. Settlement, broker
restrictions, order size rounding, partial fills and market impact are not
simulated. A short later sample with no trades supplies no evidence of an
edge. Every result and observation remains `liveEligible: false`.

Before any live integration, this needs broker-matched data, a longer frozen
forward paper record, and portfolio/settlement/execution modeling. Those are
unimplemented; installing this code changes no running service or live policy.
