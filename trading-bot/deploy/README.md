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

Compute → Instances → **Create instance**.

| Setting | Value | Why |
|---|---|---|
| Shape | **VM.Standard.E2.1.Micro** (AMD, 1 OCPU / 1 GB) | Always Free and almost always available. The ARM `A1.Flex` shape is the one that returns *"Out of host capacity"* — if that's what's been failing, this is why. 1 GB is ample: the bot has no dependencies and holds no state in memory. |
| Image | Ubuntu 22.04/24.04 **or** Oracle Linux 9 | `setup.sh` handles both (apt and dnf). |
| Subnet | **Public subnet**, assign a public IPv4 | Outbound traffic from a public-subnet instance is 1:1 NAT'd through its own public IP, which is the address Binance will see. |
| SSH key | paste `~/.ssh/oracle_fcs_bot.pub` | Generated on your Mac for this purpose. |

Then, before you touch the Binance key:

**Reserve the public IP.** Networking → *Reserved public IPs* → reserve one and
attach it to the instance's VNIC, or convert the ephemeral IP to reserved on
the instance's VNIC page. An **ephemeral IP changes whenever the instance is
stopped and started**, which would silently break the Binance allowlist and
leave every API call rejected. This is the single most important step on this
page.

No firewall work is needed: the default security list already permits inbound
SSH and all outbound traffic, and the bot only needs outbound.

## Provisioning

```bash
ssh -i ~/.ssh/oracle_fcs_bot ubuntu@<RESERVED_IP>     # 'opc@' on Oracle Linux

curl -fsSL https://raw.githubusercontent.com/chiduwa/frontiercapitalsignals/main/trading-bot/deploy/setup.sh | sudo bash
```

It checks Binance reachability, prints the egress IP to allowlist, installs
Node 24, clones the repo, **runs the guardrail tests and refuses to install if
they fail**, creates an unprivileged `fcsbot` user, and installs the timers —
stopped, with an empty env file.

Then:

```bash
sudo nano /etc/fcs-trading-bot.env      # paste the Binance key + Cloudflare token
sudo systemctl start fcs-trading-bot    # one cycle, by hand
journalctl -u fcs-trading-bot -n 100 --no-pager
```

Confirm in that log: `equity` is a real number **for the account you intend**
(`/fapi/v3/account` returns your standard USDS-M account, so check the figure
if you meant the Lead Trader portfolio), `signals_contract` shows
`confluence-v7`, skips cite real gates, and there are no `error_*` lines.
Expect **zero opens** — the engine withholds every call during its cold start,
and the bot records shadow entries instead.

Once that looks right:

```bash
sudo systemctl enable --now fcs-trading-bot.timer
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
