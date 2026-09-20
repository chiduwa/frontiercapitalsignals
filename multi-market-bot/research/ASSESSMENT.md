# Facebook trading-bot claim assessment — 2026-09-11

**Verdict: plausible automation, unverified income, insufficient trading edge.**
Built a separate FCS research bot. No change to live trading is supported by
the evidence collected here.

## Claim and provenance

The supplied [Facebook reel](https://www.facebook.com/share/r/18gkTSRmJE/?mibextid=wwXIfr)
resolves to Raycfu's video 27793737410218584. Its publicly retrieved metadata
identifies a Claude-built bot and a $3,000/month earnings claim. Full video
audio was not available. The creator's matching
[companion guide](https://www.raycfu.com/guides/claude-fable-trading-bot)
provides the strategy descriptions; it calls the earnings one person's
reported, non-typical result. The retrieved guide supplies no independently
audited account history, starting capital or complete drawdown record. This
assessment evaluates that guide rather than inventing a video transcript.

Arithmetic illustrates why capital matters: $3,000 is 30% of $10,000, 3% of
$100,000, or 0.6% of $500,000 **per month**, before considering costs or losses.
The dollar headline alone establishes no return or repeatable advantage.

## What has merit, and what needs correction

Different market hypotheses and volatility-aware sizing are testable.
Published [time-series momentum research](https://www.aqr.com/Insights/Research/Journal-Article/Time-Series-Momentum)
supports investigating trend effects across asset classes. It does not
validate these intraday windows, these ETFs or a 50/200 crossover specifically.
No independent evidence validating this exact SPY/QQQ rule was found in this
bounded review.

The guide's one-ATR sizing formula is inconsistent with its two/three-ATR
stops: at that quantity, the planned price loss is two/three times the stated
equity risk. Sizing must use the actual stop distance. Gaps and costs can
still exceed the resulting budget. The implementation uses that correction.

[Alpaca's crypto documentation](https://docs.alpaca.markets/us/docs/crypto-trading)
says crypto cannot be shorted or purchased on margin. Its
[crypto fee schedule](https://docs.alpaca.markets/us/docs/crypto-fees)
includes a 25-bp lowest-volume taker rate per side. The guide's blanket
zero-commission backtest assumption therefore understates crypto costs.
This experiment uses long/cash positions and includes explicit costs.

[Alpaca describes paper-trading omissions](https://docs.alpaca.markets/us/docs/paper-trading)
including market impact, latency slippage and queue position. A working
simulation cannot establish live profitability. Also,
[USCF describes USO's futures-based exposure](https://www.uscfinvestments.com/disclosures):
its price is not interchangeable with spot crude oil or a Binance contract.

## First reproducible experiment

Fixed rules, no parameter tuning. Independent $10,000 cash accounts, one per
instrument; **these are not returns on a combined portfolio**. All samples
end September 10 or 11, 2026. The later 30% is chronological, with warmup
excluded and cash reset at the boundary. Because the strategy and coverage
were evaluated retrospectively, this is exploratory, not a prospective test.

| Instrument | Later sample begins (UTC) | Trades | Net return | Buy/hold | Net return, higher slippage |
|---|---|---:|---:|---:|---:|
| SPY | Aug 24, 17:30 | 20 | −1.94% | −0.84% | −10.11% |
| QQQ | Aug 24, 17:30 | 10 | −0.58% | +0.08% | −2.73% |
| BTC/USD | Aug 4, 18:00 | 15 | +6.42% | +20.16% | +3.94% |
| GLD | Aug 19, 17:30 | 0 | 0.00% | −3.82% | 0.00% |
| USO | Aug 19, 17:30 | 0 | 0.00% | +19.26% | 0.00% |

Base costs are 5 bps slippage per side plus 1 bp equity fee allowance or
25 bps BTC fee per side. Stress raises slippage to 15 bps. BTC lost 9.85%
in the earlier sample, further weakening any repeatable-income interpretation.
Its later gain also trailed full buy/hold, although the strategies have
different exposures and risks; this is not a risk-adjusted alpha test.

The index rules lost in this test. Commodity rules generated too few trades
to judge. These results neither verify the creator's earnings nor prove that
all possible variants fail. They support retaining the experiment in research.

## Data provenance and limits

Inputs: [retained candles](2026-09-11-data.json).
Outputs: [full report, trades and equity observations](2026-09-11-report.json)
and [historical signal snapshot](2026-09-11-snapshot.json).
Hashes are in [SHA256SUMS](SHA256SUMS).

ETF prices came from Yahoo's public chart endpoint, already used in FCS.
BTC candles and volume came from the
[Coinbase Exchange candles API](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles).
A five-hour BTC history gap on May 8 was retained in provenance; analysis
starts after it, leaving 3,024 continuous hourly bars. SPY and QQQ each have
1,092 retained 15-minute bars. GLD and USO each retain 304 session bars after
the last known unusable completed session. The coverage rule was chosen for
data completeness before inspecting returns, not to improve performance.

This is a long/cash adaptation, not an exact reproduction of the full guide.
There is no equity-short simulation or combined correlation filter. GLD/USO
use 4-hour regular-session bars with a 2.5-hour closing bar; session choices
affect indicators. Whole missing equity sessions are not calendar-audited.
Feeds differ from Alpaca, and no executable spread/queue observations were
available. Fees are scenarios; distributions, taxes, settlement and actual
fills are not modeled. No significance or monthly-income estimate is claimed.

## Implementation decision

Keep these fixed hypotheses in `multi-market-bot/`, with no route into existing
FCS live authorization. Its collector, replay engine and snapshot scanner can
be rerun using the documented commands. No service was deployed or scheduled,
and no live orders or broker-account changes were made. Reconsider integration
only after longer broker-matched, prospective after-cost evidence and a tested
portfolio execution path exist.
