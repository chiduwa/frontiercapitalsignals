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

Both bots run on this one instance, with separate keys — see the note on that
in [`../README.md`](../README.md). A second instance would double the capacity
wait and consume the whole 2-OCPU quota for no benefit.

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
```

Confirm in that log: `equity` is a real number **for the account you intend**
(`/fapi/v3/account` returns your standard USDS-M account, so check the figure
if you meant the Lead Trader portfolio), `signals_contract` shows
`confluence-v7`, skips cite real gates, and there are no `error_*` lines.
Expect **zero opens** — the engine withholds every call during its cold start,
and the bot records shadow entries instead.

Once that looks right:

```bash
sudo systemctl enable --now fcs-trading-bot.timer      # every 5 min
sudo systemctl enable --now fcs-spot-bot.timer         # every 4 h
sudo systemctl enable --now fcs-trading-bot-update.timer
```

## Operating it

```bash
systemctl list-timers 'fcs-*'                        # next firing
journalctl -u fcs-trading-bot -f                     # follow decisions live
journalctl -u fcs-trading-bot --since '2 hours ago' | grep decision_open
journalctl -u fcs-bot-update -n 50 --no-pager        # update history
sudo systemctl stop fcs-trading-bot.timer            # stop trading now
```

The update timer pulls `main` hourly and **rolls back** if the new commit
fails the guardrail tests, so a broken push cannot arm an untested bot. The
decision log is JSON on journald — that is the audit trail, the same role the
Actions job log used to play.

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
