#!/bin/zsh
# usage: d1q.sh "SQL" -> prints JSON array of result rows
cd "$(dirname "$0")/../../.."
npx --yes wrangler@4 d1 execute frontier-capital-signals-reliability --remote --json --command "$1" 2>/dev/null | python3 -c "
import json,sys
raw=sys.stdin.read(); i=raw.find('[')
d=json.loads(raw[i:])
print(json.dumps(d[0]['results']))
"
