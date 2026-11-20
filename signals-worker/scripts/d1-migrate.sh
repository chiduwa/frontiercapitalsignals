#!/usr/bin/env bash
# Applies pending D1 migrations, waiting out D1's overload refusals.
#
# Every Signals workflow starts with this step. It is a few tiny queries, but
# on 2026-11-04 it failed Signals Refresh (12:05) and Signals Microstructure
# (02:35, 15:20) with
#   D1 DB is overloaded. Too many resources consumed within a 10 second window [code: 7429]
# because another job's ~20-second reliability scan of forecast_outcomes was
# running at that moment. A 7429 is refused before anything executes, so
# asking again is safe; the window clears within seconds. Any other failure
# (bad SQL in a migration, auth) fails at once, as before.
set -uo pipefail

DB=frontier-capital-signals-reliability
DELAYS=(10 20 40 60)
log=$(mktemp)

for attempt in 0 1 2 3 4; do
  npx --yes wrangler@4 d1 migrations apply "$DB" --remote 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  [ "$status" -eq 0 ] && exit 0
  if ! grep -q -E '7429|DB is overloaded' "$log" || [ "$attempt" -ge ${#DELAYS[@]} ]; then
    exit "$status"
  fi
  echo "D1 is overloaded (7429); asking again in ${DELAYS[$attempt]}s"
  sleep "${DELAYS[$attempt]}"
done
