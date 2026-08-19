// Structured JSON-lines logging to stdout — this bot runs as a one-shot
// GitHub Actions script (see .github/workflows/trading-bot-cycle.yml)
// with no local disk that survives between runs, so the job's own log
// output IS the audit trail, same as every other scheduled script in
// this repo. Read it via the Actions tab or the GitHub API, not a local
// file.
export function log(event, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}
