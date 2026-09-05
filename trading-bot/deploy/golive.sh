#!/usr/bin/env bash
# Gated transition from dry run to live trading.
#
# Runs ONCE, from a systemd timer set to a specific instant. It does not flip
# on a schedule alone: it reads the journal the bots have actually produced
# since going up and refuses if anything in it looks wrong. Four real bugs
# surfaced in the first two live-account cycles (a NaN stop-loss trigger among
# them), so "24 hours have passed" is not by itself evidence that this is safe.
#
# Abort at any time:   sudo systemctl disable --now fcs-golive.timer
# Reverse afterwards:  sudo sed -i 's/^DRY_RUN=false/DRY_RUN=true/' /etc/fcs-trading-bot.env
#                      sudo sed -i 's/^SPOT_DRY_RUN=false/SPOT_DRY_RUN=true/' /etc/fcs-spot-bot.env
set -uo pipefail

LOG=/var/log/fcs-golive.log
MARKER=/var/lib/fcs-golive.done
WINDOW="${FCS_GOLIVE_WINDOW:-24 hours ago}"
MIN_FUTURES_CYCLES="${FCS_MIN_FUTURES_CYCLES:-50}"
MIN_SPOT_CYCLES="${FCS_MIN_SPOT_CYCLES:-3}"

say() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG"; }

[[ -f "$MARKER" ]] && { say "already ran; nothing to do"; exit 0; }

fail=0
note() { say "  FAIL  $*"; fail=$((fail+1)); }
ok()   { say "  ok    $*"; }

say "=== go-live health gate ==="

fut_log="$(journalctl -u fcs-trading-bot --since "$WINDOW" --no-pager -o cat 2>/dev/null)"
spot_log="$(journalctl -u fcs-spot-bot --since "$WINDOW" --no-pager -o cat 2>/dev/null)"

fut_cycles=$(grep -c '"event":"cycle_end"' <<<"$fut_log")
spot_cycles=$(grep -c '"event":"cycle_end"' <<<"$spot_log")

# 1. Enough completed cycles to have actually exercised the code paths.
(( fut_cycles >= MIN_FUTURES_CYCLES )) \
  && ok "futures completed $fut_cycles cycles (needs $MIN_FUTURES_CYCLES)" \
  || note "futures completed only $fut_cycles cycles (needs $MIN_FUTURES_CYCLES)"
(( spot_cycles >= MIN_SPOT_CYCLES )) \
  && ok "spot completed $spot_cycles cycles (needs $MIN_SPOT_CYCLES)" \
  || note "spot completed only $spot_cycles cycles (needs $MIN_SPOT_CYCLES)"

# 2. No cycle crashed outright.
for name in fcs-trading-bot fcs-spot-bot; do
  crashes=$(journalctl -u "$name" --since "$WINDOW" --no-pager 2>/dev/null | grep -c "Failed with result")
  (( crashes == 0 )) && ok "$name: no failed invocations" || note "$name: $crashes failed invocation(s)"
done
for label in error_cycle; do
  n=$(grep -c "\"event\":\"$label\"" <<<"$fut_log$spot_log")
  (( n == 0 )) && ok "no $label events" || note "$n $label event(s)"
done

# 3. The protection failures specifically. An unprotected leveraged position
#    is the worst outcome this system can produce, so any sign of one blocks
#    the flip outright rather than being weighed against the rest.
for label in error_no_price_reference_for_protection error_bad_stop_price error_ensuring_protection error_loading_position_risk; do
  n=$(grep -c "\"event\":\"$label\"" <<<"$fut_log")
  (( n == 0 )) && ok "no $label" || note "$n $label — protective orders are not reliable yet"
done

# 4. Any open position must have a stop the bot can actually compute. A null
#    trigger price is exactly the bug that would have left a live position
#    naked, so it is checked by value, not by absence of an error string.
nulltrig=$(grep -c '"triggerPrice":null' <<<"$fut_log")
(( nulltrig == 0 )) && ok "no null protective trigger prices" || note "$nulltrig null trigger price(s)"

# 5. Account reads are returning real numbers, not undefined coerced to NaN.
last_equity=$(grep '"event":"cycle_start"' <<<"$fut_log" | tail -1 | grep -o '"equity":[0-9.]*' | cut -d: -f2)
[[ -n "$last_equity" ]] && awk -v e="$last_equity" 'BEGIN{exit !(e>0)}' \
  && ok "futures equity reads $last_equity" || note "futures equity missing or non-positive"
last_quote=$(grep '"event":"cycle_start"' <<<"$spot_log" | tail -1 | grep -o '"freeQuote":[0-9.]*' | cut -d: -f2)
[[ -n "$last_quote" ]] && ok "spot free balance reads $last_quote" || note "spot free balance missing"

# 6. The checkout must still be the tested one. The update timer rolls back a
#    commit that fails the guardrails, so a rolled-back state means the newest
#    code is NOT what is running and should not be promoted to live.
if git config --system --get-all safe.directory >/dev/null 2>&1 \
   && git -C /opt/fcs diff --quiet 2>/dev/null; then
  ok "checkout clean at $(git -C /opt/fcs rev-parse --short HEAD 2>/dev/null)"
else
  note "checkout is dirty or unreadable"
fi

if (( fail > 0 )); then
  say "RESULT: $fail check(s) failed — STAYING IN DRY RUN. Nothing was changed."
  say "Re-run by hand after fixing: sudo /usr/local/bin/fcs-golive"
  exit 1
fi

say "RESULT: all checks passed — going live"
sed -i 's/^DRY_RUN=true$/DRY_RUN=false/' /etc/fcs-trading-bot.env
sed -i 's/^SPOT_DRY_RUN=true$/SPOT_DRY_RUN=false/' /etc/fcs-spot-bot.env
say "  futures: $(grep '^DRY_RUN=' /etc/fcs-trading-bot.env)"
say "  spot:    $(grep '^SPOT_DRY_RUN=' /etc/fcs-spot-bot.env)"
touch "$MARKER"
say "Live. The futures bot will still open nothing until the engine authorizes a"
say "call; the spot bot will buy as soon as an asset meets its measured bar."
