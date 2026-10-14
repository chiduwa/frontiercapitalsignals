# Hosting the bot on Oracle Cloud

Why it moved off GitHub Actions: two problems with one cause. The `*/5`
schedule **never fired once** (this repo has measured GitHub dropping
high-frequency crons before), and GitHub-hosted runners egress from 7,251
published CIDR blocks covering ~28 million rotating addresses, so a Binance
API key can never be IP-restricted. A single instance you own fixes both.

## Before you create anything: two Oracle-specific traps

**1. Your home region decides whether this can work at all.** Always Free
resources are pinned to the tenancy's home region, chosen at signup and not
changeable. Binance answers **HTTP 451** from restricted jurisdictions — so if
your home region is a restricted one, no amount of configuration on the
instance will help. `setup.sh` tests this first and aborts with that
explanation rather than installing a bot that cannot trade.

**2. Always Free compute gets reclaimed when idle.** Oracle reclaims Always
Free instances whose CPU, network and memory all sit below ~20% for 7 days.
A five-minute Node script is light enough to plausibly qualify — and a
silently reclaimed instance means a silently dead trading bot. Upgrading the
tenancy to **Pay As You Go** exempts you from reclamation while Always Free
resources stay free. Worth doing before you rely on this.

## Creating the instance

**What is actually deployed** (af-casablanca-1, provisioned 2026-09-05):

| Setting | Value |
|---|---|
| Name / shape | `fcs-trading-bot` · `VM.Standard.A1.Flex` · 1 OCPU / 6 GB |
| Image | `Canonical-Ubuntu-22.04-aarch64` (arm64) |
| Reserved IP | `84.8.217.132` |
| Boot volume | 45 GB usable, 6% used |

Shape note, corrected from an earlier draft of this file: **af-casablanca-1
offers ARM only.** `VM.Standard.E2.1.Micro` (the AMD micro shape usually
recommended because it dodges the capacity lottery) does not exist in this
region, so `A1.Flex` is the only Always-Free option here — which means the
lottery is unavoidable. This instance took ~2 hours of retrying at 1 OCPU /
6 GB, the smallest ask available, before a host freed up. Oracle also
rate-limits the launch API itself (`Too many requests for the user`)
independently of capacity, so a retry loop needs a real backoff or it makes
its own odds worse.

Both bot processes run on this one instance, with separate keys — see the note
in [`../README.md`](../README.md). This process/key separation does not isolate
manual Futures trades from the futures bot when both use the same Binance
one-way account. Use a dedicated Futures subaccount/account if hard position
isolation is required.

**Reserve the public IP.** OCI cannot convert an ephemeral IP to reserved in
place: you must release the ephemeral one and create a `RESERVED` public IP
against the same private IP object. Do it *before* creating the Binance key —
an ephemeral IP changes whenever the instance is stopped and started, which
would break the allowlist silently, with every API call rejected and no
obvious cause.

No firewall work is needed: the default security list already permits inbound
SSH and all outbound traffic, and the bot only needs outbound.

## Provisioning

```bash
ssh -i ~/.ssh/oracle_fcs_bot ubuntu@<RESERVED_IP>     # 'opc@' on Oracle Linux

curl -fsSL https://raw.githubusercontent.com/chiduwa/frontiercapitalsignals/main/trading-bot/deploy/setup.sh | sudo bash
```

**Re-running it after pushing a change to the script itself?** Use the local
copy, not the URL:

```bash
sudo git -C /opt/fcs fetch origin main && sudo git -C /opt/fcs reset --hard origin/main
sudo bash /opt/fcs/trading-bot/deploy/setup.sh
```

`raw.githubusercontent.com` serves a CDN-cached copy for several minutes and
**ignores a `?cache-buster` query string**, so a fresh `curl` can silently run
the previous version of the script. That cost real debugging time here: a fix
appeared not to work when the code under test simply was not the code that
ran. The one-liner above is for the first provision only.

It checks Binance reachability, prints the egress IP to allowlist, installs
Node 24, clones the repo, **runs the guardrail tests and refuses to install if
they fail**, creates an unprivileged `fcsbot` user, and installs the timers —
stopped, with two empty env files (futures and spot).

Then:

```bash
sudo nano /etc/fcs-trading-bot.env      # futures key + Cloudflare token
sudo nano /etc/fcs-spot-bot.env         # spot key (a DIFFERENT Binance key)
sudo systemctl start fcs-trading-bot    # one cycle, by hand
journalctl -u fcs-trading-bot -n 100 --no-pager
sudo systemctl start fcs-spot-bot
journalctl -u fcs-spot-bot -n 60 --no-pager
sudo systemctl start fcs-account-journal
journalctl -u fcs-account-journal -n 100 --no-pager
```

Confirm in that log: `equity` is a real number **for the account you intend**
(`/fapi/v3/account` returns your standard USDS-M account, so check the figure
if you meant the Lead Trader portfolio), `signals_contract` shows
`confluence-v7`, skips cite real gates, and there are no `error_*` lines.
Expect **zero opens** — the engine withholds every call during its cold start,
and the bot records unfilled shadow LIMIT proposals instead.

Once that looks right:

```bash
sudo systemctl enable --now fcs-trading-bot.timer      # every 5 min
sudo systemctl enable --now fcs-trading-protection.timer # protection-only every 15 s
sudo systemctl enable --now fcs-spot-bot.timer         # every 4 h
sudo systemctl enable --now fcs-account-journal.timer  # read-only sync every 15 min
sudo systemctl enable --now fcs-trading-bot-update.timer
```

## Operating it

```bash
systemctl list-timers 'fcs-*'                        # next firing
journalctl -u fcs-trading-bot -f                     # follow decisions live
journalctl -u fcs-trading-protection -n 100 --no-pager # resting-fill protection
journalctl -u fcs-trading-bot --since '2 hours ago' | grep decision_open
journalctl -u fcs-bot-update -n 50 --no-pager        # update history
journalctl -u fcs-account-journal -n 100 --no-pager  # imported account fills
sudo systemctl stop fcs-trading-bot.timer            # stop trading now
```

Every timer schedules in UTC (`OnCalendar=... UTC`), not the host's local
clock, so a daylight-saving change can neither move a run nor skip or repeat
one. `trading-bot/test.mjs` fails on a timer without it, and the updater
checks each staged schedule with `systemd-analyze calendar` before it
installs any unit.

The update timer pulls `main` hourly into a detached staging worktree and runs
all guardrail suites there. A failed target never replaces `/opt/fcs`. After a
pass, the updater takes the journal, spot and futures runtime locks and switches
the checkout only for the short install step; services therefore cannot import
a half-switched tree. It neither restarts services nor enables timers. The
decision log is JSON on journald — that is the audit trail, the same role the
Actions job log used to play.

Schema is deployed separately from the host updater. Before pulling a version
that uses a new D1 table, apply migrations from a trusted checkout:

```bash
cd signals-worker
npx --yes wrangler@4 d1 migrations apply frontier-capital-signals-reliability --remote
```

For this release, verify that migrations through
`0031_account_journal_position_snapshots.sql` are reported as applied before
the next bot or journal cycle. Migration 0030 supplies the durable write-ahead
intent required before any live LIMIT submission and the conservative
hourly-OHLC reachability fields used by dry/shadow research; migration 0031
supplies the separate read-only current-position and append-only snapshot
journal tables.

The futures bot now places authorized entries as adaptive `LIMIT`/`GTD`
orders, 4–10% away from the immutable signal reference, and expires them after
the evidence clock (never longer than 24 hours). It reconciles and cancels by
the exact bot client ID. The protection-only timer checks resting fills every
15 seconds without fetching signals or opening trades; it shares the main
execution lease, so the two one-shot services do not mutate state together.
Dry and shadow rows are proposals, not fills. Manual
positions remain alert-only; inspect `foreign_position_*`,
`position_ownership_conflict`, `cancelled_tracked_entry` and
`retired_legacy_assisted_protection` events during rollout.

On an existing host, the updater installs but intentionally does not enable a
new timer. After this release has passed its staged update, explicitly arm the
protection-only timer without stopping or restarting the decision bot:

```bash
sudo systemctl enable --now fcs-trading-protection.timer
systemctl is-active fcs-trading-bot.timer fcs-trading-protection.timer
```

## Going live

`DRY_RUN=true` until you have days of cycles you are happy with. Then set
`DRY_RUN=false` in the env file and `sudo systemctl restart fcs-trading-bot.timer`.

Remember what actually gates you: the bot places nothing until
`classSkill.crypto` goes `proven: true` and an individual row earns its full
calibration. Flipping `DRY_RUN` does not change that, and the thresholds must
not be lowered to make it change.

## Rolling the key

The Binance secret lives only in `/etc/fcs-trading-bot.env` (mode 640,
root:fcsbot) — not in GitHub, not in this repo. To rotate: create the new key
with the same IP restriction, edit the file, restart the timer, then delete
the old key on Binance.

## Research recorders (added 2026-10-13, data only)

Two read-only recorders came out of the NEAR/RED liquidation review
(`signals-worker/reports/scenarios/2026-10-12-near-red/`, gitignored). Neither sends
alerts, places orders or writes to D1.

| Unit | What it records | Where |
|---|---|---|
| `fcs-liquidation-collector.service` (always on, restarts daily) | Binance `!forceOrder@arr` liquidation snapshots, from the `/market/ws` route (the old `/ws` route delivers nothing) | `/var/lib/fcs-liquidations/forceorder-YYYY-MM-DD.ndjson[.gz]` |
| `fcs-fuel-shadow.timer` (every 15 min, :04 UTC) | Squeeze-warning signs for 12h after each pushed exhaustion alert: contracts OI change, premium index, account ratio, thrust | `/var/lib/fcs-fuel-shadow/fuel-shadow-YYYY-MM.ndjson` |

The hourly updater installs the unit files but never enables a new unit, so turn
them on once (needs SSH):

```sh
sudo systemctl enable --now fcs-liquidation-collector.service fcs-fuel-shadow.timer
journalctl -u fcs-liquidation-collector -n 20 --no-pager
```

Disable with `sudo systemctl disable --now` on the same names; the updater will not
re-enable them.

### Recorder data quality update (2026-10-14)

New liquidation rows have `schemaVersion: 2`, retain the complete exchange
payload in `raw` (including `st` and `ps` when provided), and identify the
connection with `epochId`. Binance publishes sampled snapshots, not a complete
liquidation tape. No received message does not mean no liquidations occurred.
Separate `forceorder-health-YYYY-MM-DD.ndjson[.gz]` files record connection
attempts, minute heartbeats, valid/invalid/written/dropped counters, storage
failures and uncertain coverage intervals. Connection, valid-message silence
and close deadlines prevent a silently stuck connection. Both file families
rotate and follow the same retention policy; incomplete compression is
recovered from the retained raw file.

Fuel rows have `schema_version: 2` and protocol `fuel-shadow-prospective-v2`.
They retain candle inputs, OI/account-ratio values and timestamps, source receipt
times, a source-file hash, and separate `price_asof` and
`decision_available_at` times. Missing, stale, duplicate or malformed inputs
leave affected features and combined counts null; valid independent features
remain available. Every eligible alert gets a coverage row, including unsupported
perpetuals and failed sources. `fuel-shadow-runs-YYYY-MM.ndjson` records run
start, expected cohort and completion counts, so an interrupted run is visible.
First valid historical OI and account-ratio baselines are frozen under
`baselines/fuel-shadow-prospective-v2/`; later source revisions are recorded
without changing those baselines.

The timer still runs at :04, :19, :34 and :49 UTC. This prospective protocol
uses the latest closed five-minute boundary at each observation and is not the
historical study's decision grid. Outcome studies must use actual availability
times plus their declared execution delay. Existing unversioned rows stay intact
and must be analyzed separately; missing old coverage cannot be reconstructed.

The Worker CI and host updater both run the offline recorder and delivery
regression suites. After the updater installs a recorder change, restart only
the continuous collector to load it immediately. A manual fuel run records an
additional observation without sending an alert or placing an order:

```sh
sudo systemctl restart fcs-liquidation-collector.service
sudo systemctl start fcs-fuel-shadow.service
systemctl show fcs-liquidation-collector.service fcs-fuel-shadow.service -p ActiveState -p Result
```
