"""How late does GitHub START each daily scheduled workflow? (ROTATION.md
section 9). Reads every workflow's first cron from .github/workflows, then the
last 30 `schedule` runs of each daily one through `gh api`, and reports the
gap between the cron's time of day and the run's created_at."""
import glob, json, os, re, statistics, subprocess
from datetime import datetime, timedelta

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".."))
REPO = "chiduwa/frontiercapitalsignals"

for path in sorted(glob.glob(os.path.join(ROOT, ".github", "workflows", "*.yml"))):
    m = re.search(r"^\s*-\s*cron:\s*['\"]?([^'\"\n]+)", open(path).read(), re.M)
    if not m: continue
    mm, hh, dom, mon, dow = m.group(1).split()
    if not (mm.isdigit() and hh.isdigit()) or dow != "*": continue        # daily jobs only
    f = os.path.basename(path)
    out = subprocess.run(["gh", "api", f"repos/{REPO}/actions/workflows/{f}/runs?event=schedule&per_page=30"],
                         capture_output=True, text=True).stdout
    runs = json.loads(out or "{}").get("workflow_runs", [])
    delays = []
    for r in runs:
        c = datetime.fromisoformat(r["created_at"].replace("Z", "+00:00"))
        sched = c.replace(hour=int(hh), minute=int(mm), second=0, microsecond=0)
        if sched > c: sched -= timedelta(days=1)
        delays.append((c - sched).total_seconds() / 3600)
    if delays:
        print(f"{f:34s} cron {int(hh):02d}:{int(mm):02d} UTC  runs {len(delays):2d}  start delay h: median {statistics.median(delays):4.1f}  "
              f"min {min(delays):4.1f}  max {max(delays):4.1f}  last 7 median {statistics.median(delays[:7]):4.1f}")
