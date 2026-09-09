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

Emergency protection submitted by FCS for an externally opened futures
position uses the separate `fcsa-` namespace and remains `unknown` rather than
contaminating the bot-strategy P&L cohort.

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

The Worker checks for newly ingested `manual` or `unknown` fills every five
minutes and sends a compact count, affected symbols, and exchange-reported
futures realized P&L to the existing private ntfy topic. Its watermark advances
only after ntfy accepts the message, so a delivery failure is retried rather
than silently acknowledged.
