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
die() { log "ERROR: $*"; exit 1; }

# Self-heal on a box provisioned before this was added to setup.sh: the
# checkout belongs to the service user while this runs as root, and git
# refuses to operate across that boundary without an explicit exception.
# --system (i.e. /etc/gitconfig), not --global: this runs as root here and
# again as root from the update timer, and a per-user config would depend on
# whichever HOME sudo/systemd happened to set. System scope is read regardless.
git config --system --get-all safe.directory 2>/dev/null | grep -qx "$INSTALL_DIR" \
  || git config --system --add safe.directory "$INSTALL_DIR"

PREVIOUS="$(git -C "$INSTALL_DIR" rev-parse HEAD)"

git -C "$INSTALL_DIR" fetch --quiet origin main
TARGET="$(git -C "$INSTALL_DIR" rev-parse origin/main)"

if [[ "$PREVIOUS" == "$TARGET" ]]; then
  log "already at ${PREVIOUS:0:7}, nothing to do"
  exit 0
fi

log "staging ${PREVIOUS:0:7} -> ${TARGET:0:7}; active services remain on the old checkout"
TEST_LOG="$(mktemp /tmp/fcs-bot-test.XXXXXX.log)"
STAGE_DIR="$(mktemp -d /opt/fcs-update.XXXXXX)"
STAGE_ATTACHED=false
cleanup() {
  if [[ "$STAGE_ATTACHED" == true ]]; then
    git -C "$INSTALL_DIR" worktree remove --force "$STAGE_DIR" >/dev/null 2>&1 || true
  else
    rmdir "$STAGE_DIR" >/dev/null 2>&1 || true
  fi
  rm -f "$TEST_LOG"
}
trap cleanup EXIT
rmdir "$STAGE_DIR"
git -C "$INSTALL_DIR" worktree add --quiet --detach "$STAGE_DIR" "$TARGET"
STAGE_ATTACHED=true
# The worktree is created by root, but every guardrail test below runs as
# $RUN_USER. Without this the staged tree is unreadable-and-unexecutable to
# them and the whole gate fails for reasons that have nothing to do with the
# commit being tested.
#
chown -R "$RUN_USER:$RUN_USER" "$STAGE_DIR"

# ...and run them from a directory $RUN_USER can actually read.
#
# This is the part that was silently breaking every update. node --test
# isolates each test file in a CHILD PROCESS, and a spawn inherits the parent's
# working directory. The invoking shell here sits in the calling admin's home,
# which on this image is mode 750 and owned by that admin — so fcsbot could
# exec /usr/bin/node directly but could NOT spawn from that cwd, and
# account-journal's suite died with "EACCES: spawn /usr/bin/node" while
# trading-bot's and spot-bot's single-process suites passed untouched.
#
# The updater then reported GUARDRAIL TESTS FAILED, correctly refused to
# promote, and the host sat 10 commits behind main with every timer green. The
# refusal was right; the reason was spurious. Diagnosed by running the same
# command from /tmp, where all 22 tests pass.
cd "$STAGE_DIR"

if ! sudo -u "$RUN_USER" node --check "$STAGE_DIR/trading-bot/src/index.mjs" >"$TEST_LOG" 2>&1 \
   || ! sudo -u "$RUN_USER" node --check "$STAGE_DIR/trading-bot/src/protection-cycle.mjs" >>"$TEST_LOG" 2>&1 \
   || ! sudo -u "$RUN_USER" node "$STAGE_DIR/trading-bot/test.mjs" >>"$TEST_LOG" 2>&1 \
   || ! sudo -u "$RUN_USER" node "$STAGE_DIR/spot-bot/test.mjs" >>"$TEST_LOG" 2>&1 \
   || ! sudo -u "$RUN_USER" node --test "$STAGE_DIR"/account-journal/test/*.test.mjs >>"$TEST_LOG" 2>&1; then
  log "GUARDRAIL TESTS FAILED on staged ${TARGET:0:7} — live checkout was not changed"
  sed -n '1,40p' "$TEST_LOG" | while IFS= read -r line; do log "  $line"; done
  exit 1
fi
log "guardrail tests passed on staged ${TARGET:0:7}"

# Services execute files directly from /opt/fcs. Take their filesystem locks
# only for the short tested-checkout switch; they keep running the old version
# throughout the longer test phase. Acquire the futures lock last so fill
# protection is never held behind a journal sync. The updated units take these
# same locks before Node starts, preventing mixed-version imports on all later
# automatic updates.
# Reclaim ownership of every runtime lock before opening it.
#
# /run/lock is drwxrwxrwt and this kernel runs fs.protected_regular=2, which
# refuses an O_CREAT open of a file you do not own inside a sticky,
# world-writable directory — and it refuses it for ROOT too. The policy-research
# lock is handed to $RUN_USER a few lines down so its service can take it, which
# meant the NEXT update could no longer open it: a works-once-then-never-again
# failure that left the host pinned and every timer green. Reclaiming first is
# idempotent and costs nothing when the lock is already root-owned.
for lock in fcs-policy-research-runtime fcs-account-journal-runtime \
            fcs-spot-runtime fcs-futures-runtime; do
  [ -e "/run/lock/$lock.lock" ] && chown root:root "/run/lock/$lock.lock" 2>/dev/null || true
done

exec 6>/run/lock/fcs-policy-research-runtime.lock
chown "$RUN_USER:$RUN_USER" /run/lock/fcs-policy-research-runtime.lock
chmod 660 /run/lock/fcs-policy-research-runtime.lock
flock --exclusive --wait 300 6 || die "timed out waiting for policy research runtime lock"
exec 9>/run/lock/fcs-account-journal-runtime.lock
flock --exclusive --wait 900 9 || die "timed out waiting for account-journal runtime lock"
exec 8>/run/lock/fcs-spot-runtime.lock
flock --exclusive --wait 300 8 || die "timed out waiting for spot runtime lock"
exec 7>/run/lock/fcs-futures-runtime.lock
flock --exclusive --wait 180 7 || die "timed out waiting for futures runtime lock"

[[ "$(git -C "$INSTALL_DIR" rev-parse HEAD)" == "$PREVIOUS" ]] \
  || die "live checkout changed during staging; refusing to overwrite it"
git -C "$INSTALL_DIR" reset --quiet --hard "$TARGET"
chown -R "$RUN_USER:$RUN_USER" "$INSTALL_DIR"

# Reinstall units and helpers from the already-tested target. This does not
# restart a service or enable a timer the operator disabled.
for unit in "$INSTALL_DIR"/trading-bot/deploy/fcs-*.service "$INSTALL_DIR"/trading-bot/deploy/fcs-*.timer; do
  [ -f "$unit" ] || continue
  install -m 644 "$unit" /etc/systemd/system/
done
install -m 755 "$INSTALL_DIR/trading-bot/deploy/update.sh" /usr/local/bin/fcs-bot-update
install -m 755 "$INSTALL_DIR/trading-bot/deploy/golive.sh" /usr/local/bin/fcs-golive
systemctl daemon-reload
log "units and helper scripts reinstalled; tested ${TARGET:0:7} now live (no service restarted)"
