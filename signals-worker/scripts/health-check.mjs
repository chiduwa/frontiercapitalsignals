// Probes the LIVE site and says what is wrong, in words someone can act on.
//
// WHY A SECOND LAYER AT ALL
//
// Everything else in this repo tests the SOURCE, before deploy. That cannot see
// the failures that actually hurt this project, because all of them happened to
// code that was already correct:
//
//   - 2026-09-11..15  Signals Discovery died daily on a D1 size ceiling. The
//                     code was fine; the archive had grown. Five days passed
//                     before anyone noticed, and the tell was sitting in the
//                     public payload the whole time: every research_registry
//                     row frozen at 2026-09-10T10:00:08.
//   - same window     daily-refresh hit the same ceiling inside a try/catch, so
//                     the job stayed GREEN while lead/lag and support/resistance
//                     silently lost their input. No alert is possible from CI
//                     for a job that reports success.
//   - the scheduler   sub-daily GitHub crons deliver 7-26% of what they request.
//                     A job that never runs emits no failure to notice.
//
// The through-line: a green pipeline is not evidence that the live thing works.
// So this asks the live thing directly, and it is deliberately weighted towards
// STALENESS and MISSING-ness rather than errors, because that is the shape every
// real incident here has taken.
//
// DELIBERATELY NOT SELF-HEALING. This reports; it does not repair. An automated
// fixer for a system whose failure mode is "quietly publishing something it
// should not" is a worse risk than the outage it would paper over. The place
// bugs get FIXED automatically is the pre-deploy gate, which refuses to ship
// them; this is the place they get NOTICED.
//
// Optional env: NTFY_TOPIC (alerting), FCS_HEALTH_ORIGIN (defaults to prod).
import { JSDOM, VirtualConsole } from 'jsdom';

const ORIGIN = process.env.FCS_HEALTH_ORIGIN || 'https://frontiercapitalsignals.com';
const { NTFY_TOPIC } = process.env;
const SIGNALS = `${ORIGIN}/signals/`;

// ---- thresholds, each tied to a mechanism rather than a feeling -------------
export const THRESHOLDS = Object.freeze({
  // CACHE_SECONDS is 3600 and the Worker cron dispatches a rebuild once the
  // payload goes stale, so a build older than 3h means that whole chain is
  // broken, not merely late.
  modelAgeWarnHours: 1.75,
  modelAgeFailHours: 3,
  // The Worker refreshes the price layer on its own 5-minute cron, and the page
  // itself calls anything over 15 minutes not-fresh.
  priceAgeWarnMinutes: 15,
  priceAgeFailMinutes: 30,
  // Measured live 2026-09-15: crypto 211, stocks 290. The pre-widening crypto
  // universe was 146, so dropping under 100 means the archive read is failing,
  // which is exactly how the D1 ceiling would show up here.
  cryptoUniverseWarn: 150,
  cryptoUniverseFail: 100,
  stockUniverseWarn: 260,
  stockUniverseFail: 200,
  // Discovery runs daily. Rows frozen for more than 3 days is the signature of
  // the 5-day outage; 36h catches it on the second missed run instead.
  registryAgeWarnHours: 36,
  registryAgeFailHours: 72,
  // The dashboard's own feed warning uses the same 80% equity coverage bar.
  equityCoverageFail: 0.8
});

const hours = (ms) => ms / 3_600_000;
const minutes = (ms) => ms / 60_000;

function result(id, level, ok, detail) { return { id, level, ok, detail }; }

// ---- payload invariants (pure, so they are unit-tested) ---------------------
export function checkPayload(payload, now = Date.now()) {
  const out = [];
  const push = (id, level, ok, detail) => out.push(result(id, level, ok, detail));

  if (!payload || typeof payload !== 'object') {
    push('payload-shape', 'fail', false, 'the signals API returned no usable JSON');
    return out;
  }

  // --- the two clocks ---
  const built = Date.parse(payload.generated_at);
  if (!Number.isFinite(built)) push('model-clock', 'fail', false, 'payload carries no usable generated_at');
  else {
    const age = hours(now - built);
    push('model-freshness',
      age >= THRESHOLDS.modelAgeFailHours ? 'fail' : 'warn',
      age < THRESHOLDS.modelAgeWarnHours,
      `model build is ${age.toFixed(1)}h old (${payload.generated_at}); the refresh dispatch chain should keep this under ${THRESHOLDS.modelAgeWarnHours}h`);
  }
  const priced = Date.parse(payload.prices_generated_at);
  if (!Number.isFinite(priced)) push('price-clock', 'fail', false, 'payload carries no usable prices_generated_at');
  else {
    const age = minutes(now - priced);
    push('price-freshness',
      age >= THRESHOLDS.priceAgeFailMinutes ? 'fail' : 'warn',
      age < THRESHOLDS.priceAgeWarnMinutes,
      `price tick is ${age.toFixed(0)} min old; the Worker cron refreshes it every 5 min`);
  }

  // --- coverage: the shape a silently-failing archive read takes ---
  const cryptoUniverse = payload.crypto?.universe ?? 0;
  const stockUniverse = payload.stocks?.universe ?? 0;
  push('crypto-universe',
    cryptoUniverse < THRESHOLDS.cryptoUniverseFail ? 'fail' : 'warn',
    cryptoUniverse >= THRESHOLDS.cryptoUniverseWarn,
    `${cryptoUniverse} crypto assets screened (expected >= ${THRESHOLDS.cryptoUniverseWarn})`);
  push('stock-universe',
    stockUniverse < THRESHOLDS.stockUniverseFail ? 'fail' : 'warn',
    stockUniverse >= THRESHOLDS.stockUniverseWarn,
    `${stockUniverse} equities screened (expected >= ${THRESHOLDS.stockUniverseWarn})`);

  const boards = ['crypto', 'stocks'].flatMap((cls) => ['breakout', 'breakdown'].map((side) => (payload[cls]?.[side] || []).length));
  push('boards-populated', 'fail', boards.some((n) => n > 0),
    `board row counts: ${boards.join('/')} — every board empty means the build produced nothing`);

  // --- feed health ---
  const health = payload.health || {};
  push('coingecko-feed', 'fail', health.coingecko === true, 'CoinGecko is reported down by the build');
  if (health.stocks_total) {
    const coverage = health.stocks_ok / health.stocks_total;
    push('equity-feed', 'warn', coverage >= THRESHOLDS.equityCoverageFail,
      `equity coverage ${health.stocks_ok}/${health.stocks_total} (${Math.round(coverage * 100)}%)`);
  }

  // --- THE GATE. Nothing here may publish a direction its class has not earned.
  for (const [cls, key] of [['crypto', 'crypto'], ['stock', 'stocks']]) {
    const skill = payload.classSkill?.[cls];
    const proven = skill?.proven === true;
    if (proven) continue;
    const rows = ['breakout', 'breakdown', 'favorites', 'longTermPotential']
      .flatMap((side) => payload[key]?.[side] || []);
    const leaked = rows.filter((r) => r && (r.dir === 1 || r.dir === -1));
    push(`gate-${cls}`, 'fail', leaked.length === 0,
      `${leaked.length} ${cls} row(s) carry a direction while the class is unproven`
      + (leaked.length ? `: ${leaked.slice(0, 5).map((r) => `${r.symbol}=${r.dir}`).join(', ')}` : ''));
    const withHorizon = rows.filter((r) => r && r.horizon);
    push(`gate-${cls}-horizon`, 'fail', withHorizon.length === 0,
      `${withHorizon.length} unproven ${cls} row(s) publish a trade timeframe`);
    const withRange = rows.filter((r) => r && r.range);
    push(`gate-${cls}-range`, 'fail', withRange.length === 0,
      `${withRange.length} unproven ${cls} row(s) publish a projected range`);
  }

  // --- the learning loop is actually learning ---
  // This is the check that would have caught the 5-day Discovery outage on its
  // second day: the registry simply stops moving while everything else looks
  // perfectly healthy.
  const registry = payload.quantResearch?.rows || [];
  if (!registry.length) {
    push('research-registry', 'warn', false, 'the research registry is empty');
  } else {
    const newest = Math.max(...registry.map((r) => Date.parse(r.updatedAt) || 0));
    const age = hours(now - newest);
    push('research-registry-fresh',
      age >= THRESHOLDS.registryAgeFailHours ? 'fail' : 'warn',
      age < THRESHOLDS.registryAgeWarnHours,
      `research registry last moved ${age.toFixed(0)}h ago (${new Date(newest).toISOString()}) — Signals Discovery writes this daily, so a frozen registry means it is failing`);
  }

  return out;
}

// ---- page invariants -------------------------------------------------------
export function checkPageResponse(status, contentType, headers, html) {
  const out = [];
  out.push(result('page-status', 'fail', status === 200, `GET /signals/ returned ${status}`));
  out.push(result('page-content-type', 'fail', String(contentType || '').includes('text/html'), `content-type was ${contentType}`));
  out.push(result('page-security-headers', 'warn',
    !!headers['content-security-policy'] && headers['x-content-type-options'] === 'nosniff' && headers['x-frame-options'] === 'DENY',
    'CSP / nosniff / frame-options missing from the live response'));
  if (!html) return out;

  // The whole dashboard is one inline script. A parse error there takes the
  // entire page down and every other layer stays silent about it — the reason
  // this check exists at all.
  const blocks = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .map((m) => ({ attrs: m[1], body: m[2] })).filter((s) => s.body.trim());
  const data = blocks.filter((s) => /application\/(ld\+)?json/i.test(s.attrs));
  let scriptError = null;
  for (const block of blocks.filter((b) => !data.includes(b))) {
    try { new Function(block.body); } catch (e) { scriptError = e.message; break; }
  }
  out.push(result('page-scripts-parse', 'fail', scriptError === null, `inline script does not parse: ${scriptError}`));
  let jsonError = null;
  for (const block of data) { try { JSON.parse(block.body); } catch (e) { jsonError = e.message; break; } }
  out.push(result('page-structured-data', 'warn', jsonError === null, `JSON-LD invalid: ${jsonError}`));
  out.push(result('page-canonical', 'warn', html.includes('rel="canonical"'), 'canonical link missing'));
  out.push(result('page-disclaimer', 'fail',
    html.includes('not a recommendation') || html.includes('not investment advice'),
    'the risk disclaimer is missing from the live page'));
  return out;
}

// ---- the page, actually rendered, against the live payload ------------------
export async function checkRender(html, payload, prices) {
  const errors = [];
  const virtualConsole = new VirtualConsole().on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: SIGNALS, pretendToBeVisual: true, virtualConsole,
    beforeParse(win) {
      win.fetch = (input) => {
        const url = String(input);
        const body = url.endsWith('/api/signals') ? payload
          : url.endsWith('/api/prices') ? prices
            : url.endsWith('/api/scalp') ? { unavailable: true } : { requiresConsent: false };
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve(body) });
      };
      win.addEventListener('error', (e) => errors.push(String(e.message)));
      win.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const doc = dom.window.document;
  const rows = doc.querySelectorAll('#boards tr[data-symbol]');
  const out = [
    result('render-no-errors', 'fail', errors.length === 0, `the live page threw while rendering: ${errors.slice(0, 3).join(' | ')}`),
    result('render-rows', 'fail', rows.length > 0, 'the live payload rendered zero board rows'),
    result('render-chain-complete', 'fail',
      !doc.getElementById('stateBox').textContent.includes('failed to render'),
      'a renderer failed part-way through the chain'),
    result('render-controls', 'warn',
      !!doc.getElementById('assetSearch') && !!doc.getElementById('sortKey') && doc.querySelectorAll('[data-class-filter]').length === 3,
      'the screen controls (search / class filter / sort) are not on the live page'),
    result('render-freshness-strip', 'warn',
      /ago/.test(doc.getElementById('frModel')?.textContent || ''),
      'the freshness strip is not reporting a model build age')
  ];
  // The rendered mirror of the payload gate: whatever the payload said, the
  // page itself must not draw an arrow for an unproven class.
  const anyUnproven = ['crypto', 'stock'].some((c) => payload?.classSkill?.[c]?.proven !== true);
  if (anyUnproven) {
    const arrows = doc.querySelectorAll('.dir-arrow.dir-up, .dir-arrow.dir-down').length;
    const provenCount = ['crypto', 'stock'].filter((c) => payload?.classSkill?.[c]?.proven === true).length;
    out.push(result('render-gate', 'fail', provenCount > 0 || arrows === 0,
      `${arrows} direction arrow(s) rendered while no asset class has cleared its gate`));
  }
  dom.window.close();
  return out;
}

// ---- the rest of the site --------------------------------------------------
export async function checkSitePages(fetchImpl = fetch) {
  const paths = ['/', '/intelligence', '/signals/api/feed'];
  const out = [];
  for (const path of paths) {
    try {
      const res = await fetchImpl(ORIGIN + path, { redirect: 'follow' });
      out.push(result(`site${path}`, 'fail', res.ok, `GET ${path} returned ${res.status}`));
    } catch (e) {
      out.push(result(`site${path}`, 'fail', false, `GET ${path} failed: ${e.message}`));
    }
  }
  return out;
}

async function notify(title, body, priority) {
  if (!NTFY_TOPIC) return;
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST', headers: { Title: title, Priority: priority, Tags: 'rotating_light' }, body
    });
  } catch (e) { console.error('health alert could not be sent:', e.message); }
}

// --scope=page  what a DEPLOY can break: the page renders, its contract holds,
//               the site answers. Used as a post-deploy smoke test, where
//               failing on data age would be blaming the deploy for a stale
//               upstream it cannot fix.
// --scope=data  what TIME can break: freshness, coverage, the learning loop.
// --scope=all   both (default), for the scheduled monitor.
function requestedScope() {
  const arg = process.argv.find((a2) => a2.startsWith('--scope='));
  const scope = arg ? arg.slice('--scope='.length) : 'all';
  if (!['page', 'data', 'all'].includes(scope)) {
    console.error(`unknown --scope=${scope}; expected page, data or all`);
    process.exit(2);
  }
  return scope;
}

async function main() {
  const now = Date.now();
  const scope = requestedScope();
  const wantPage = scope === 'page' || scope === 'all';
  const wantData = scope === 'data' || scope === 'all';
  console.log(`health check scope=${scope} origin=${ORIGIN}\n`);
  const checks = [];

  let html = null;
  try {
    const res = await fetch(SIGNALS, { headers: { 'User-Agent': 'fcs-health-check' } });
    html = res.ok ? await res.text() : null;
    const headers = Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v]));
    if (wantPage) checks.push(...checkPageResponse(res.status, res.headers.get('content-type'), headers, html));
  } catch (e) {
    checks.push(result('page-status', 'fail', false, `GET /signals/ failed outright: ${e.message}`));
  }

  let payload = null;
  let prices = null;
  try { payload = await (await fetch(`${ORIGIN}/signals/api/signals`)).json(); } catch (e) {
    checks.push(result('payload-fetch', 'fail', false, `the signals API is unreachable: ${e.message}`));
  }
  try { prices = await (await fetch(`${ORIGIN}/signals/api/prices`)).json(); } catch { prices = null; }
  if (wantData) checks.push(result('prices-endpoint', 'fail', !!prices && (!!prices.crypto || !!prices.stocks), 'the live price endpoint returned nothing usable'));

  if (wantData && payload) checks.push(...checkPayload(payload, now));
  if (wantPage && html && payload) checks.push(...await checkRender(html, payload, prices || { generated_at: new Date().toISOString(), crypto: {}, stocks: {} }));
  if (wantPage) checks.push(...await checkSitePages());

  const failures = checks.filter((c) => !c.ok && c.level === 'fail');
  const warnings = checks.filter((c) => !c.ok && c.level === 'warn');

  for (const c of checks) {
    if (c.ok) console.log(`  ok    ${c.id}`);
    else console.log(`  ${c.level === 'fail' ? 'FAIL' : 'warn'}  ${c.id}: ${c.detail}`);
  }
  console.log(`\n${checks.filter((c) => c.ok).length} ok, ${warnings.length} warning(s), ${failures.length} failure(s)`);

  if (failures.length) {
    await notify(`FCS health (${scope}): ${failures.length} failing`,
      failures.map((f) => `• ${f.id}: ${f.detail}`).join('\n')
      + (warnings.length ? `\n\nAlso warning:\n${warnings.map((w) => `• ${w.id}`).join('\n')}` : ''),
      'high');
    process.exit(1);
  }
  if (warnings.length) {
    await notify(`FCS health: ${warnings.length} warning(s)`, warnings.map((w) => `• ${w.id}: ${w.detail}`).join('\n'), 'default');
  }
  console.log('HEALTH OK');
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
