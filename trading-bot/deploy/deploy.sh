#!/usr/bin/env bash
# Run from your local machine: ./deploy/deploy.sh <user>@<vm-ip>
# Copies the bot to the VM and (re)starts it as a systemd service. Does
# NOT touch .env on the remote side — it's created once, by hand, on the
# VM itself (see README), never synced from a local copy.
set -euo pipefail
TARGET="${1:?usage: deploy.sh user@host}"
REMOTE_DIR=/opt/fcs-trading-bot

rsync -avz --exclude .env --exclude state --exclude node_modules \
  ./ "$TARGET:$REMOTE_DIR/"

ssh "$TARGET" "sudo cp $REMOTE_DIR/deploy/trading-bot.service /etc/systemd/system/ && \
  sudo systemctl daemon-reload && \
  sudo systemctl enable trading-bot && \
  sudo systemctl restart trading-bot && \
  sudo systemctl status trading-bot --no-pager"
