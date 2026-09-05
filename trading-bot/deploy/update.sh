#!/usr/bin/env bash
# Pulls the latest main and refuses to leave the box running code that fails
# the bot's own guardrail tests.
#
# This matters more here than in a normal deploy: the thing being updated
# places leveraged orders unattended, and the tests are what pin its binding
# to the engine's publication gate. A commit that breaks that binding must not
# become the running version just because it is newer.
set -euo pipefail

INSTALL_DIR="/opt/fcs"
RUN_USER="fcsbot"

log() { printf '%s fcs-bot-update: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

cd "$INSTALL_DIR"
PREVIOUS="$(git rev-parse HEAD)"

git fetch --quiet origin main
TARGET="$(git rev-parse origin/main)"

if [[ "$PREVIOUS" == "$TARGET" ]]; then
  log "already at ${PREVIOUS:0:7}, nothing to do"
  exit 0
fi

log "updating ${PREVIOUS:0:7} -> ${TARGET:0:7}"
git reset --quiet --hard "$TARGET"
chown -R "$RUN_USER:$RUN_USER" "$INSTALL_DIR"

if sudo -u "$RUN_USER" env HOME=/tmp node "$INSTALL_DIR/trading-bot/test.mjs" >/tmp/fcs-bot-test.log 2>&1; then
  log "guardrail tests passed on ${TARGET:0:7} — now live"
  exit 0
fi

# Roll back rather than leave an untested bot armed. The next hourly run will
# try again, so a genuine fix lands on its own without intervention.
log "GUARDRAIL TESTS FAILED on ${TARGET:0:7} — rolling back to ${PREVIOUS:0:7}"
sed -n '1,40p' /tmp/fcs-bot-test.log | while IFS= read -r line; do log "  $line"; done
git reset --quiet --hard "$PREVIOUS"
chown -R "$RUN_USER:$RUN_USER" "$INSTALL_DIR"
log "rolled back; the previous version is still running"
exit 1
