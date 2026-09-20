// Workflow wiring guardrail.
//
// WHY THIS EXISTS: signals-replay.yml read the D1 database id from
// `secrets.FCS_D1_DATABASE_ID` while the other nineteen workflows read it from
// `vars.FCS_D1_DATABASE_ID`. GitHub does not fail, warn, or even log when a
// workflow interpolates a context entry that was never defined — it silently
// substitutes the empty string. So the job started, checked out, installed
// Node, applied migrations successfully (Wrangler resolves the database BY
// NAME and never needs the id), and only then handed an empty id to
// replay-history.mjs, which died on its own argument check one second in.
//
// The replay ran twice, on 2026-09-13 and 2026-09-20, and failed identically
// both times. It has never once succeeded. Nothing upstream could have caught
// it: the YAML is valid, the secret name is plausible, the step that would
// have proved the credential works (migrations) does not use it, and the
// guardrail tests that run first pass because they never touch D1.
//
// That is the whole failure class this file closes. These are deliberately
// static, credential-free checks over the workflow text — they run in the same
// `node --test`-less style as the rest of the suite and need no network, no
// D1, and no GitHub token, so they can run on every branch.
//
// NOT a YAML parser. signals-worker/package.json is intentionally free of
// runtime dependencies, so this scans the workflow text directly. The checks
// below are chosen so that text scanning is sufficient and cannot produce a
// false positive: they ask "is this name sourced the same way everywhere" and
// "does this file mention this credential at all", never anything that depends
// on YAML block structure.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = join(__dirname, '..', '.github', 'workflows');
const SCRIPT_DIR = join(__dirname, 'scripts');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`       ${detail}`);
  }
};

const workflows = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map((f) => ({ name: f, text: readFileSync(join(WORKFLOW_DIR, f), 'utf8') }));

check('workflow directory is readable and non-empty', workflows.length > 0, `found ${workflows.length}`);

// ---------------------------------------------------------------------------
// 1. A given name is read from ONE context across the whole repository.
//
// This is the exact replay bug. A name that is a repository variable in
// nineteen files and a secret in the twentieth is always a typo, because the
// two contexts are populated from different places and GitHub will never tell
// you which one you meant. Enforcing agreement is enough: it does not matter
// whether the project stores the id as a variable or a secret, only that every
// workflow asks for it the same way.
// ---------------------------------------------------------------------------
console.log('\n== every secrets./vars. name is sourced consistently ==');
const contexts = new Map(); // NAME -> { secrets:Set<file>, vars:Set<file> }
for (const wf of workflows) {
  for (const [, kind, name] of wf.text.matchAll(/\$\{\{\s*(secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
    if (!contexts.has(name)) contexts.set(name, { secrets: new Set(), vars: new Set() });
    contexts.get(name)[kind].add(wf.name);
  }
}
check('workflows reference at least one configured name', contexts.size > 0, `found ${contexts.size}`);
for (const [name, seen] of [...contexts].sort()) {
  const inBoth = seen.secrets.size > 0 && seen.vars.size > 0;
  check(
    `${name} is read from a single context`,
    !inBoth,
    inBoth
      ? `secrets. in [${[...seen.secrets].sort().join(', ')}] but vars. in [${[...seen.vars].sort().join(', ')}] `
        + '— GitHub substitutes an empty string for whichever one is not defined, with no error'
      : null
  );
}

// ---------------------------------------------------------------------------
// 2. A workflow that runs a D1 script supplies all three D1 credentials.
//
// The scripts themselves validate this at runtime, which is why the replay
// failure was a clean one-line error rather than a confusing HTTP 400 against
// a malformed URL. But a runtime check only fires once the job has been
// scheduled, checked out and installed — on a weekly cron that is a seven-day
// feedback loop. This moves the same question to commit time.
//
// Deliberately file-scoped rather than step-scoped: the question asked is
// "does this workflow know about this credential at all", which a missing
// `env:` entry answers no to regardless of which job or step owns it. That
// keeps the check free of YAML-structure guessing while still catching the
// omission, and it cannot fire spuriously on a correctly wired file.
// ---------------------------------------------------------------------------
console.log('\n== workflows running a D1 script pass the D1 credentials ==');
const D1_CREDENTIALS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'FCS_D1_DATABASE_ID'];

// A script needs D1 if it reads the database id out of the environment. That
// is the same condition d1-client.mjs uses to build a query URL, so the set
// tracks the code rather than a hand-maintained list that would drift.
const needsD1 = new Set(
  readdirSync(SCRIPT_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => /\bFCS_D1_DATABASE_ID\b/.test(readFileSync(join(SCRIPT_DIR, f), 'utf8')))
    .map((f) => basename(f))
);
check('D1-dependent scripts were discovered from source', needsD1.size > 0, `found ${needsD1.size}`);

for (const wf of workflows) {
  // Every `node scripts/<name>.mjs` this workflow invokes, including the
  // shell-variable form the replay uses (`node scripts/replay-history.mjs $ARGS`).
  const invoked = [...wf.text.matchAll(/node\s+(?:--[\w-]+(?:=\S+)?\s+)*scripts\/([\w.-]+\.mjs)/g)]
    .map((m) => m[1])
    .filter((s) => needsD1.has(s));
  if (!invoked.length) continue;
  const missing = D1_CREDENTIALS.filter((c) => !wf.text.includes(c));
  check(
    `${wf.name} supplies D1 credentials for ${[...new Set(invoked)].sort().join(', ')}`,
    missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : null
  );
}

// ---------------------------------------------------------------------------
// 3. Scheduled workflows declare a timeout.
//
// A cron job with no timeout-minutes inherits GitHub's six-hour default. The
// replay and the backfills hold a concurrency group, so one wedged run blocks
// every later run of the same workflow for the rest of that window — the
// failure looks like "the schedule stopped firing" rather than "one run hung",
// which is a much harder thing to notice from the run list.
// ---------------------------------------------------------------------------
console.log('\n== scheduled workflows bound their own runtime ==');
for (const wf of workflows) {
  if (!/^\s*(-\s*)?cron:/m.test(wf.text)) continue;
  check(`${wf.name} sets timeout-minutes`, /^\s*timeout-minutes:\s*\d+/m.test(wf.text),
    'a scheduled job with no timeout inherits the 6h default and can hold its concurrency group');
}

console.log(`\n${failures === 0 ? 'All workflow guardrails passed.' : `${failures} workflow guardrail(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
