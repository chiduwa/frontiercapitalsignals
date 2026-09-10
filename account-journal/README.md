# Binance account journal

This service imports Binance spot and USDⓈ-M futures fills into D1 without
placing, changing, or cancelling orders. It runs independently from both
trading bots, and stores exchange facts separately from their strategy
ledgers.

Provenance is deliberately conservative:

- `bot`: an exact bot order ID, an explicit override, or an `fcsf-`/`fcss-`
  client-order ID proves one of this repository's bots submitted it.
- `manual`: an exact operator override or an explicitly configured manual
  client-order prefix proves it.
- `unknown`: the exchange does not provide enough evidence. An unmatched
  historical fill is never relabelled “manual” just to make the report neat.

Legacy emergency protection from older FCS versions used the separate `fcsa-`
namespace and remains `unknown` rather than contaminating the bot-strategy P&L
cohort. Current code never creates protection for an externally opened trade
and retires only those exact legacy IDs.

Spot does not supply realized P&L, so the journal reports spot buy/sell quote
flow and fees by their actual fee asset. It does not invent cost-basis P&L.
Futures realized P&L is copied directly from Binance fill records.

## Coverage

Futures symbol discovery uses the account-wide order history plus current
positions. The importer also reads Binance's separate `allAlgoOrders` history
for conditional TP/SL orders. It stores each parent algo ID and polls every
non-terminal parent by exact identity until Binance supplies its triggered
`actualOrderId`; that preserves the original `clientAlgoId` provenance even
when a stop was created before the rolling history overlap window. This avoids
assuming that an older parent will reappear in a later time-window query when
its status changes. Polling is read-only and bounded by
`JOURNAL_MAX_ALGO_POLLS_PER_SYMBOL` (default `25`) per run, with oldest-polled
parents first.

Binance's standard futures trade-list endpoint currently exposes only the past
three months; older history requires a one-time Binance export.

Binance has no account-wide spot fill endpoint. The service discovers current
holdings and previously journaled/bot-traded symbols, and it always checks the
pinned FCS symbols plus FIL and PEPE. Add fully sold historical pairs to
`JOURNAL_SPOT_SYMBOLS` in `/etc/fcs-spot-bot.env`.

The first run imports available history. Later runs use per-symbol exchange
trade IDs and overlapping time cursors, with idempotent D1 upserts. A crash can
repeat a row but cannot advance the cursor past an unwritten fill. After every
ingestion pass, all stored fills are reclassified from the latest order IDs,
bot ledgers, and operator overrides before analytics are rebuilt; an early
`unknown` label therefore cannot become permanently stale.

Each successful futures account read also refreshes a read-only table of open
positions and appends a timestamped position snapshot. A live position is
classified `bot` only when its side and quantity exactly match the bot's
exchange-confirmed durable ownership record; every unmatched or mixed net
position remains `unknown` rather than being guessed manual. Current rows that
disappear from Binance are removed only after the replacement snapshot has
been stored successfully. Historical snapshots have no automatic deletion and
can support later trade-path/behavior analysis without changing any order.

## Operations

```bash
sudo systemctl start fcs-account-journal
journalctl -u fcs-account-journal -n 100 --no-pager
sudo systemctl enable --now fcs-account-journal.timer
systemctl list-timers fcs-account-journal.timer
```

The authenticated report is served at
`https://frontiercapitalsignals.com/signals/trades`. Its token is a Cloudflare
Worker secret, not a query string or a repository variable. Browser access uses
HTTP Basic authentication with username `fcs` and that token as the password;
API clients may instead send `Authorization: Bearer <token>` to
`/signals/api/trades` or `/signals/api/trades.csv`.

The HTML report, JSON endpoint, and CSV endpoint share the same filters:

- `period=week|month|year|all` uses rolling 7-, 30-, or 365-day windows, or all
  retained rows. `from=YYYY-MM-DD` and/or `to=YYYY-MM-DD` select an inclusive
  UTC calendar-date range and take precedence over a preset.
- `symbol`, `market=spot|futures|all`, `origin=external|manual|unknown|bot|all`,
  and `side=BUY|SELL|all` filter exchange facts. `external` means the union of
  proven-manual and unknown-provenance fills, not a claim that every row was
  submitted manually.
- `pnl=reported|win|loss|breakeven|all`, `min_pnl`, and `max_pnl` apply only to
  individual futures fills with Binance-reported realized P&L. They never
  derive spot P&L. Fees remain separate in their actual commission asset.
- `sort=time|symbol|market|origin|side|price|quantity|quote|pnl|commission` and
  `direction=asc|desc` are server-whitelisted. `page` and `page_size` paginate
  deterministically; page size is capped at 500 and the CSV link exports the
  current filtered page.

The journal has no automatic retention cutoff, and this service never deletes
rows from `account_journal_fills`, `account_journal_orders`, or
`account_journal_position_snapshots`. The finite D1 database capacity still
applies and should be monitored. Daily statistics and fee tables are derived
materializations: the importer may clear and rebuild those derived rows from
the retained raw fills without deleting the raw ledger.

The Worker checks for newly ingested `manual` or `unknown` fills every five
minutes and sends a compact count, affected symbols, and exchange-reported
futures realized P&L to the existing private ntfy topic. Its watermark advances
only after ntfy accepts the message, so a delivery failure is retried rather
than silently acknowledged.

Failed sends persist a cooldown and sanitized delivery status in KV. Retries
use exponential backoff (five minutes up to six hours), honoring a longer
valid `Retry-After` delay. Only ntfy's explicit daily-message-quota code
`42908` waits for the next UTC daily reset plus a five-minute grace period;
other HTTP 429 responses are not assumed to be daily quotas. The watermark
does not advance on an HTTP, network, or timeout failure. Fills imported during
cooldown are included in the next attempt.

The private HTML report and JSON `alertDelivery` field show the last accepted
send, failure/cooldown state, provider status, and next allowed attempt. Pending
fill counts describe the last attempted batch, not an always-current queue
size. Acceptance by ntfy is not proof that a phone displayed the notification.
Neither the topic nor credentials appear in these status fields.

An existing authenticated ntfy account can optionally supply `NTFY_TOKEN` as
a Worker secret (`wrangler secret put NTFY_TOKEN` from `signals-worker`). The
deployment workflow preserves that secret but does not create an account,
purchase a subscription, or provision the token. Authentication does not
override the provider's applicable limits. See the provider's
[publishing documentation](https://docs.ntfy.sh/publish/) and
[quota definitions](https://github.com/binwiederhier/ntfy/blob/main/server/errors.go).
