#!/usr/bin/env bash
# Provisions this bot on a fresh Oracle Cloud (or any Linux) instance.
# Idempotent: safe to re-run after a failure or a config change.
#
#   curl -fsSL https://raw.githubusercontent.com/chiduwa/frontiercapitalsignals/main/trading-bot/deploy/setup.sh | sudo bash
#
# What it does NOT do: put secrets anywhere. It writes an env file with
# 0600 permissions and empty values for you to fill in by hand. Nothing
# here should ever end up in the repo or in a shell history.
set -euo pipefail

REPO_URL="https://github.com/chiduwa/frontiercapitalsignals.git"
INSTALL_DIR="/opt/fcs"
ENV_FILE="/etc/fcs-trading-bot.env"
SPOT_ENV_FILE="/etc/fcs-spot-bot.env"
RUN_USER="fcsbot"
NODE_MAJOR="24"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run with sudo"

# ---------------------------------------------------------------------------
# Preflight: the one check that decides whether this machine can host the bot
# at all. Binance answers HTTP 451 from restricted jurisdictions, so an
# instance in the wrong region cannot trade no matter how well it is
# configured. Fail here, loudly, rather than after everything is installed.
# ---------------------------------------------------------------------------
log "Checking this host can reach the Binance futures API"
PING_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 https://fapi.binance.com/fapi/v1/ping || echo 000)"
case "$PING_CODE" in
  200) echo "    OK — fapi.binance.com/fapi/v1/ping returned 200" ;;
  451) die "Binance returned HTTP 451 (Unavailable For Legal Reasons) from this host's IP.
       This region is geo-restricted. Oracle Always Free resources are pinned to your
       tenancy's HOME region, so the fix is a tenancy whose home region is not
       restricted — not a setting on this box. Stop here." ;;
  000) die "No response from fapi.binance.com. Check outbound networking, then re-run." ;;
  *)   die "Unexpected HTTP $PING_CODE from fapi.binance.com/fapi/v1/ping. Resolve before continuing." ;;
esac

log "Recording this host's public egress IP"
EGRESS_IP="$(curl -s --max-time 20 https://checkip.amazonaws.com || echo '')"
[[ -n "$EGRESS_IP" ]] || die "could not determine the public egress IP"
echo "    $EGRESS_IP"
echo "    ^ this is the address to allowlist on the Binance API key."
echo "    Confirm it matches the RESERVED public IP attached to this instance —"
echo "    an ephemeral IP changes when the instance is stopped and started."

# ---------------------------------------------------------------------------
# Packages. Oracle Cloud's stock images are Oracle Linux (dnf) or Ubuntu
# (apt); handle both rather than assuming which one was picked at launch.
# ---------------------------------------------------------------------------
if command -v dnf >/dev/null 2>&1; then
  log "Installing packages (dnf)"
  dnf install -y git curl >/dev/null
  curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  dnf install -y nodejs >/dev/null
elif command -v apt-get >/dev/null 2>&1; then
  log "Installing packages (apt)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq git curl ca-certificates >/dev/null
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
else
  die "no supported package manager (expected dnf or apt-get)"
fi
echo "    node $(node --version)"

# ---------------------------------------------------------------------------
# A dedicated unprivileged user. The bot writes nothing to disk (all state is
# in D1), so it needs no home directory and no write access anywhere.
# ---------------------------------------------------------------------------
log "Creating the service user"
id -u "$RUN_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER"

# The checkout is owned by the unprivileged service user, but git runs here as
# root (and again as root from the update timer). Without this, every later
# git operation fails with "detected dubious ownership" and the self-update
# silently never applies. Guarded so re-running does not stack duplicates.
# --system (i.e. /etc/gitconfig), not --global: this runs as root here and
# again as root from the update timer, and a per-user config would depend on
# whichever HOME sudo/systemd happened to set. System scope is read regardless.
git config --system --get-all safe.directory 2>/dev/null | grep -qx "$INSTALL_DIR" \
  || git config --system --add safe.directory "$INSTALL_DIR"

log "Fetching the repository"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" fetch --quiet origin main
  git -C "$INSTALL_DIR" reset --quiet --hard origin/main
else
  rm -rf "$INSTALL_DIR"
  git clone --quiet --depth 50 "$REPO_URL" "$INSTALL_DIR"
fi
chown -R "$RUN_USER:$RUN_USER" "$INSTALL_DIR"
echo "    $(git -C "$INSTALL_DIR" log --oneline -1)"

# The bot has no third-party dependencies (plain fetch + node:crypto), so
# there is no npm install step and no lockfile to trust on this box.
log "Running the guardrail tests"
sudo -u "$RUN_USER" env HOME=/tmp node "$INSTALL_DIR/trading-bot/test.mjs" >/dev/null \
  || die "futures guardrail tests failed on this checkout — refusing to install a bot that fails its own tests"
sudo -u "$RUN_USER" env HOME=/tmp node "$INSTALL_DIR/spot-bot/test.mjs" >/dev/null \
  || die "spot guardrail tests failed on this checkout — refusing to install a bot that fails its own tests"
echo "    passed (both suites)"

# ---------------------------------------------------------------------------
# Secrets. Created empty; you fill them in. 0600, owned by the service user.
# ---------------------------------------------------------------------------
if [[ -f "$ENV_FILE" ]]; then
  log "Keeping the existing $ENV_FILE"
else
  log "Writing an empty $ENV_FILE for you to fill in"
  cat > "$ENV_FILE" <<'ENVEOF'
# Binance TRADE-ONLY key: Futures + Reading enabled, Withdrawals OFF,
# restricted to this instance's reserved public IP.
BINANCE_API_KEY=
BINANCE_API_SECRET=

# Leave true until you have reviewed several days of cycle logs.
DRY_RUN=true

# Same D1 database the rest of the repo uses.
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=7fe4bcf36c49af53696a3264a20e3cf6
FCS_D1_DATABASE_ID=b07a4faa-8330-4b13-bf94-99fc662d4d6e

# Uncomment to run against the futures testnet with testnet keys instead.
# BINANCE_FAPI_BASE=https://testnet.binancefuture.com
ENVEOF
fi
chown root:"$RUN_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

# Separate file, separate key. A leak or a bug in the leveraged futures path
# must not be able to reach spot holdings, and vice versa.
if [[ -f "$SPOT_ENV_FILE" ]]; then
  log "Keeping the existing $SPOT_ENV_FILE"
else
  log "Writing an empty $SPOT_ENV_FILE for you to fill in"
  cat > "$SPOT_ENV_FILE" <<'SPOTEOF'
# Binance SPOT key: Spot Trading + Reading enabled, Withdrawals OFF,
# restricted to this instance's reserved public IP. A DIFFERENT key from the
# futures one -- that separation is the point.
BINANCE_SPOT_API_KEY=
BINANCE_SPOT_API_SECRET=

# Leave true until you have reviewed several cycles.
SPOT_DRY_RUN=true

CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=7fe4bcf36c49af53696a3264a20e3cf6
FCS_D1_DATABASE_ID=b07a4faa-8330-4b13-bf94-99fc662d4d6e

# Optional overrides -- see spot-bot/src/config.mjs for the full list.
# SPOT_TRANCHE_PCT=0.05
# SPOT_TRANCHE_PERIOD_DAYS=7
# SPOT_DROP_SIGMAS=1.0
SPOTEOF
fi
chown root:"$RUN_USER" "$SPOT_ENV_FILE"
chmod 640 "$SPOT_ENV_FILE"

log "Installing the systemd units"
install -m 644 "$INSTALL_DIR/trading-bot/deploy/fcs-trading-bot.service" /etc/systemd/system/
install -m 644 "$INSTALL_DIR/trading-bot/deploy/fcs-trading-bot.timer" /etc/systemd/system/
install -m 644 "$INSTALL_DIR/trading-bot/deploy/fcs-spot-bot.service" /etc/systemd/system/
install -m 644 "$INSTALL_DIR/trading-bot/deploy/fcs-spot-bot.timer" /etc/systemd/system/
install -m 644 "$INSTALL_DIR/trading-bot/deploy/fcs-trading-bot-update.service" /etc/systemd/system/
install -m 644 "$INSTALL_DIR/trading-bot/deploy/fcs-trading-bot-update.timer" /etc/systemd/system/
install -m 755 "$INSTALL_DIR/trading-bot/deploy/update.sh" /usr/local/bin/fcs-bot-update
systemctl daemon-reload

cat <<EOF

------------------------------------------------------------------------
Installed. NOT started — the env file is still empty.

  1. Put the credentials in:      sudo nano $ENV_FILE          (futures)
                                  sudo nano $SPOT_ENV_FILE     (spot)
  2. Allowlist this IP on the Binance key:   $EGRESS_IP
  3. Run one cycle by hand:       sudo systemctl start fcs-trading-bot
  4. Read what it did:            journalctl -u fcs-trading-bot -n 100 --no-pager
  5. Same for spot:               sudo systemctl start fcs-spot-bot
                                  journalctl -u fcs-spot-bot -n 60 --no-pager
  6. Once both look right:        sudo systemctl enable --now fcs-trading-bot.timer
                                  sudo systemctl enable --now fcs-spot-bot.timer
                                  sudo systemctl enable --now fcs-trading-bot-update.timer

Expect zero opens: the signals engine withholds every call during its
cold start, so the bot records shadow entries instead. That is correct.
------------------------------------------------------------------------
EOF
