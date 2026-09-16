// Behavioural tests for the /signals dashboard: the page is actually RENDERED
// in a DOM, with a payload, and then interrogated.
//
// WHY THIS EXISTS SEPARATELY FROM test-worker.mjs
//
// test-worker checks the dashboard by string-matching the HTML
// (`pageText.includes('dir-arrow')`). That catches markup being deleted, and it
// caught a real incident once (an unescaped apostrophe that broke the whole
// inline script). What it cannot see is everything between "the string is
// present" and "the page works":
//
//   - the script parses but throws on the first real payload
//   - a renderer silently no-ops and the boards come out empty
//   - a filter hides rows it should not, or fails to hide rows it should
//   - the withholding gate is present in the source but not reached at runtime
//
// That last one is the one that matters. This page's entire claim is that it
// does NOT publish a direction it has not earned. Asserting that against a
// string is asserting nothing; it has to be asserted against rendered rows.
//
// Two fixtures, deliberately: one where every class is unproven (today's live
// state) and one where a class HAS cleared its gate. Without the second, "no
// direction is ever shown" would pass on a page that renders nothing at all.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`); }
}

// ---- the page under test ---------------------------------------------------
// PAGE_HTML is a template literal in worker.js and is not exported. It contains
// no ${} and no escaped backticks (test-worker asserts the script parses, and
// this slice would break loudly here if either changed), so the literal's source
// text IS its value.
const workerSource = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const TICK = String.fromCharCode(96);
const OPEN = `const PAGE_HTML = ${TICK}`;
const CLOSE = `\n${TICK};\n`;
const start = workerSource.indexOf(OPEN);
const end = workerSource.indexOf(CLOSE, start);
if (start < 0 || end < 0) throw new Error('could not locate PAGE_HTML in worker.js');
const PAGE_HTML = workerSource.slice(start + OPEN.length, end);
check('PAGE_HTML extracted from worker.js', PAGE_HTML.length > 10000 && PAGE_HTML.includes('</html>'), `${PAGE_HTML.length} chars`);

// ---- fixtures --------------------------------------------------------------
const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function row(symbol, name, price, chg24h, chg7d, rsi, score, overrides = {}) {
  return {
    symbol, name, price, chg24h, chg7d, rsi, score,
    dir: 0,
    conf: { agree: 3, total: 9 },
    drivers: ['rsi regime', 'macd histogram'],
    abstained: { reason: 'no-demonstrated-edge', measured: { accuracy: 42.1, baseline: 42.3, samples: 92763 } },
    analysis: { reference_price: price, analyzed_at: iso(18 * 60000) },
    ...overrides
  };
}

// A row whose class HAS cleared its gate: a real published call, with the
// horizon and range that only a validated setup is allowed to carry.
const provenRow = row('BTC', 'Bitcoin', 64210.5, 1.2, 3.4, 58, 71, {
  dir: 1,
  abstained: null,
  confidence: { conservative_win_rate: 0.58, conservative_edge: 0.09 },
  horizon: { label: '24h' },
  range: { low: 63000, high: 66000, basis: 'historical' }
});

function payload({ cryptoProven = false, stockProven = false, cryptoRows = null } = {}) {
  return {
    generated_at: iso(18 * 60000),
    prices_generated_at: iso(25 * 1000),
    model: 'confluence-v8',
    health: { stocks_ok: 280, stocks_total: 290, coingecko: true, valuation_ok: 120, crypto_daily_ok: 211, crypto_daily_total: 231 },
    classSkill: {
      crypto: { accuracy: 0.42, baseline: 0.4213, edge: -0.0013, samples: 92763, effectiveSamples: 1305, proven: cryptoProven },
      stock: { accuracy: 0.3819, baseline: 0.3828, edge: -0.0009, samples: 133521, effectiveSamples: 794, proven: stockProven }
    },
    crypto: {
      universe: 211,
      breakout: cryptoRows || [row('BTC', 'Bitcoin', 64210.5, 1.2, 3.4, 58, 31), row('SOL', 'Solana', 142.33, -2.1, 8.9, 71, 28), row('JUP', 'Jupiter', 0.8123, 0.4, -1.2, 44, 22)],
      breakdown: [row('DOGE', 'Dogecoin', 0.1234, -3.3, -9.1, 29, 26)],
      favorites: [row('ETH', 'Ethereum', 3120.44, 0.8, 2.2, 55, 24)],
      longTermPotential: []
    },
    stocks: {
      universe: 290,
      breakout: [row('NVDA', 'NVIDIA Corporation', 121.4, 2.4, 5.5, 64, 30), row('SOFI', 'SoFi Technologies', 8.12, -0.4, 1.1, 48, 19)],
      breakdown: [row('INTC', 'Intel Corporation', 22.11, -1.9, -4.2, 33, 25)],
      favorites: [], longTermPotential: []
    },
    overview: {
      global: { mcap: 2.4e12, mcap_chg24h: 1.1, vol24h: 9e10, btc_dom: 54.2 },
      fear_greed: 48,
      btc: { price: 64210.5, chg24h: 1.2 }, eth: { price: 3120.44, chg24h: 0.8 }, spy: { price: 552.1, chg24h: 0.3 }
    },
    highAccuracy: [], bestHours: {}, dayRange: {}
  };
}

const LIVE_TICK = { generated_at: iso(5000), crypto: { BTC: { price: 64999.99, chg24h: 2.5 } }, stocks: {} };

// ---- harness ---------------------------------------------------------------
// Renders the real page against a payload and hands back the window plus
// anything the page threw. A thrown error here is a page-down bug: the inline
// script is one block, so an exception in it stops every renderer after it.
async function render(data, { tick = LIVE_TICK, settleMs = 2600 } = {}) {
  const pageErrors = [];
  const dom = new JSDOM(PAGE_HTML, {
    runScripts: 'dangerously',
    url: 'https://frontiercapitalsignals.com/signals/',
    pretendToBeVisual: true,
    virtualConsole: new (await import('jsdom')).VirtualConsole().on('jsdomError', (e) => pageErrors.push(e.message)),
    beforeParse(win) {
      win.fetch = (input) => {
        const url = String(input);
        const body = url.endsWith('/api/signals') ? data
          : url.endsWith('/api/prices') ? tick
            : url.endsWith('/api/scalp') ? { unavailable: true }
              : { requiresConsent: false };
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve(body) });
      };
      win.addEventListener('error', (e) => pageErrors.push(String(e.message)));
      win.addEventListener('unhandledrejection', (e) => pageErrors.push(String(e.reason)));
    }
  });
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const doc = dom.window.document;
  return {
    dom, win: dom.window, doc, pageErrors,
    rows: () => [...doc.querySelectorAll('#boards tr[data-symbol]')],
    visibleRows: () => [...doc.querySelectorAll('#boards tr[data-symbol]')]
      .filter((tr) => !tr.hidden && !tr.closest('.board-slot').hidden),
    type: (value) => {
      const input = doc.getElementById('assetSearch');
      input.value = value;
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    },
    click: (selector) => doc.querySelector(selector).dispatchEvent(new dom.window.Event('click', { bubbles: true })),
    sortBy: (key) => {
      const select = doc.getElementById('sortKey');
      select.value = key;
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
  };
}

// ============================ the page renders =============================
console.log('\n== the page renders at all ==');
const withheld = await render(payload());
check('the inline script ran without throwing', withheld.pageErrors.length === 0, withheld.pageErrors.join(' | '));
check('boards rendered from the payload', withheld.rows().length === 8, String(withheld.rows().length));
check('every board is wrapped in a class-tagged slot', withheld.doc.querySelectorAll('#boards .board-slot').length === 5);
check('the overview tiles rendered', withheld.doc.querySelectorAll('#overview .tile').length > 0);
check('no renderer left its loading placeholder behind', !withheld.doc.querySelector('.dashboard-loading'));

// ===================== the withholding gate, at runtime ====================
// This is the page's core claim. Asserted against rendered rows, not source.
console.log('\n== an unproven class publishes NOTHING directional ==');
check('every row shows the withheld marker instead of an arrow',
  withheld.rows().every((r) => r.querySelector('.dir-arrow').textContent.includes('WITHHELD')));
check('no row renders an up or down arrow',
  withheld.doc.querySelectorAll('.dir-arrow.dir-up, .dir-arrow.dir-down').length === 0);
check('no trade timeframe is published', withheld.doc.querySelectorAll('.horizon.hz-hist').length === 0
  && withheld.doc.querySelectorAll('.horizon.hz-meth').length === 8);
check('no projected range is published', withheld.doc.querySelectorAll('.range.hz-hist').length === 0);
check('the withheld reason carries its measured numbers, not just a label',
  withheld.doc.body.innerHTML.includes('42.1% measured vs 42.3% baseline'));
check('both asset classes surface a class-level withheld banner',
  withheld.doc.querySelectorAll('[data-withheld-class]').length === 2);

// THE SECOND FAIL-CLOSED LAYER.
// worker.js's own comment says this UI gate exists to protect "clients viewing
// a payload written by an older build that did not strip the row directions".
// Nothing tested that, because every fixture above sends dir=0 -- so the gate
// was never actually asked to refuse anything. Here the class is unproven but
// the rows arrive carrying a direction, a horizon and a range anyway, exactly
// as a stale or regressed build would serve them. The page must refuse all
// three on its own authority.
console.log('\n== an unproven class refuses rows that arrive WITH a direction ==');
const leaked = await render(payload({
  cryptoProven: false,
  cryptoRows: [{ ...provenRow }, { ...provenRow, symbol: 'SOL', name: 'Solana', dir: -1 }]
}));
check('a leaked direction is still rendered as withheld',
  leaked.rows().filter((r2) => r2.getAttribute('data-class') === 'crypto')
    .every((r2) => r2.querySelector('.dir-arrow').textContent.includes('WITHHELD')));
check('no up or down arrow reaches the page from a leaked payload',
  leaked.doc.querySelectorAll('.dir-arrow.dir-up, .dir-arrow.dir-down').length === 0);
check('a leaked timeframe is refused', leaked.doc.querySelectorAll('.horizon.hz-hist').length === 0);
check('a leaked expected-move band is refused', leaked.doc.querySelectorAll('.range.hz-hist').length === 0);
check('the class-level banner still says the calls are withheld',
  leaked.doc.querySelectorAll('[data-withheld-class="crypto"]').length === 1);
leaked.dom.window.close();

// The mirror test. Without this, the assertions above would also pass on a
// page that had simply stopped rendering directions at all.
console.log('\n== a PROVEN class does publish its call (the gate is a gate, not a wall) ==');
const proven = await render(payload({ cryptoProven: true, cryptoRows: [provenRow] }));
check('the proven class renders a real direction arrow',
  proven.doc.querySelectorAll('[data-board-id="crypto-long"] .dir-arrow.dir-up').length === 1);
check('the proven row publishes its validated timeframe',
  proven.doc.querySelector('[data-board-id="crypto-long"] .horizon.hz-hist') !== null);
check('the proven row publishes its expected-move band',
  proven.doc.querySelector('[data-board-id="crypto-long"] .range.hz-hist') !== null);
check('the proven class drops its withheld banner',
  proven.doc.querySelectorAll('[data-withheld-class="crypto"]').length === 0);
check('the still-unproven equity class keeps withholding alongside it',
  proven.doc.querySelectorAll('[data-withheld-class="stock"]').length === 1
  && [...proven.doc.querySelectorAll('[data-board-id="stock-long"] tr[data-symbol]')]
    .every((r) => r.querySelector('.dir-arrow').textContent.includes('WITHHELD')));

// ========================= the screen controls =============================
console.log('\n== search, filter and sort ==');
const ui = await render(payload());
ui.type('sol');
check('search matches on ticker', ui.visibleRows().map((r) => r.getAttribute('data-symbol')).join(',') === 'SOL');
ui.type('technolog');
check('search matches on asset name too', ui.visibleRows().map((r) => r.getAttribute('data-symbol')).join(',') === 'SOFI');
ui.type('zzzz');
check('a search with no hits says so rather than showing an empty page',
  ui.doc.getElementById('screenStatus').textContent.includes('Nothing listed matches'));
ui.type('<img src=x onerror=alert(1)>');
check('typed input is escaped into the status line', !ui.doc.getElementById('screenStatus').querySelector('img'));
ui.type('');
check('clearing the search restores every row', ui.visibleRows().length === 8);

ui.click('[data-class-filter="crypto"]');
check('the crypto filter leaves only crypto rows',
  ui.visibleRows().length === 5 && ui.visibleRows().every((r) => r.getAttribute('data-class') === 'crypto'));
check('it hides the equity withheld banner along with its boards',
  [...ui.doc.querySelectorAll('[data-withheld-class="stock"]')].every((b) => b.hidden));
ui.click('[data-class-filter="stock"]');
check('the equities filter leaves only equity rows',
  ui.visibleRows().length === 3 && ui.visibleRows().every((r) => r.getAttribute('data-class') === 'stock'));
ui.click('[data-class-filter="all"]');
check('All restores both classes', ui.visibleRows().length === 8);

const cryptoLong = () => [...ui.doc.querySelectorAll('[data-board-id="crypto-long"] tr[data-symbol]')]
  .map((r) => r.getAttribute('data-symbol'));
ui.sortBy('price');
check('sorting by price orders high-first by default', cryptoLong().join(',') === 'BTC,SOL,JUP', cryptoLong().join(','));
ui.click('#sortDir');
check('the direction toggle reverses it', cryptoLong().join(',') === 'JUP,SOL,BTC', cryptoLong().join(','));
ui.sortBy('symbol');
check('a ticker column sorts alphabetically', cryptoLong().join(',') === 'BTC,JUP,SOL', cryptoLong().join(','));
check('the sort applies to every board, which is the only sort control below 760px',
  [...ui.doc.querySelectorAll('[data-board-id="stock-long"] tr[data-symbol]')]
    .map((r) => r.getAttribute('data-symbol')).join(',') === 'NVDA,SOFI');
check('a sort re-render replays the live tick instead of reverting the price',
  ui.doc.querySelector('tr[data-symbol="BTC"] .live-price').textContent === '64,999.99',
  ui.doc.querySelector('tr[data-symbol="BTC"] .live-price').textContent);
ui.type('sol');
ui.sortBy('');
check('an active search survives a sort re-render', ui.visibleRows().length === 1);
ui.type('');

// Sorting and filtering must not become a side door around the gate.
check('no amount of sorting or filtering reveals a withheld direction',
  ui.rows().every((r) => r.querySelector('.dir-arrow').textContent.includes('WITHHELD')));

// ========================== the two clocks =================================
console.log('\n== data timestamps ==');
const clocks = await render(payload());
check('the model build reports a relative age', /min ago|s ago/.test(clocks.doc.getElementById('frModel').textContent));
check('the model build reports an absolute UTC stamp', /UTC/.test(clocks.doc.getElementById('frModelSub').textContent));
check('the price tick is reported separately from the model build',
  clocks.doc.getElementById('frPrice').textContent !== clocks.doc.getElementById('frModel').textContent);
check('every board states which of its columns follow which clock',
  clocks.doc.querySelectorAll('.board-stamp').length === 5
  && clocks.doc.querySelector('.board-stamp').textContent.includes('tick live'));

// A stale model layer has to be visible, not just internally known.
const stale = await render({ ...payload(), generated_at: iso(5 * 3600 * 1000) });
check('a hours-old model layer raises a visible notice',
  stale.doc.getElementById('stateBox').textContent.includes('model layer is'),
  stale.doc.getElementById('stateBox').textContent.slice(0, 80));
check('and the freshness strip flags it rather than reading as current',
  stale.doc.getElementById('frModelItem').className.includes('fr-warn'));

// ============== the per-asset learning card states a measurement ============
// This card reports a SHRINKAGE weight, not an accuracy. The failure mode worth
// testing is it reading as a call or a skill claim when the number is really
// "how much of each asset model is its own rather than its class's".
console.log('\n== per-asset learning is reported as a measurement, never as a call ==');
const hierarchical = (shrinkage) => ({
  ...payload(),
  hierarchicalResearch: {
    status: 'shadow', actionable: false,
    prediction: { 'crypto|1': { assets: 272, shrinkage } }
  }
});

const learned = await render(hierarchical({ atFinalRefit: 0.0425, overScoredForecasts: 0.0052, learnedFeatures: [] }));
const learnedCard = learned.doc.getElementById('dashboardInsights').textContent;
check('the card reports the share of each asset model that is its own',
  learnedCard.includes('Own coefficients earned') && learnedCard.includes('4%'), learnedCard.slice(0, 40));
check('and states the remainder is pooled with the class, with the reason',
  /9[5-6]% of the average asset model is pooled/.test(learnedCard)
  && learnedCard.includes('sampling noise'));
check('the per-asset lane never presents itself as a live vote',
  learnedCard.includes('no live vote') && !/\bBUY\b|\bSELL\b/.test(learnedCard));

// Fully pooled is the EXPECTED result on this data, so it must render as a
// real zero rather than falling through to the unavailable branch.
const pooled = await render(hierarchical({ atFinalRefit: 0, overScoredForecasts: 0, learnedFeatures: [] }));
const pooledCard = pooled.doc.getElementById('dashboardInsights').textContent;
check('zero shrinkage renders as a measured 0%, not as missing data',
  pooledCard.includes('Own coefficients earned') && pooledCard.includes('0%')
  && pooledCard.includes('100% of the average asset model is pooled'), pooledCard.slice(0, 60));

// And an absent or not-yet-run lane must infer nothing at all.
const awaiting = await render({ ...payload(),
  hierarchicalResearch: { status: 'awaiting-first-run', actionable: false } });
check('a lane awaiting its first run infers no value',
  awaiting.doc.getElementById('dashboardInsights').textContent.includes('awaiting its first run'));
const absent = await render(payload());
check('and an absent lane adds nothing to the card rather than rendering a zero',
  !absent.doc.getElementById('dashboardInsights').textContent.includes('Own coefficients earned'));

// ===================== degraded payloads must not crash ====================
// Every renderer runs inside ONE inline script. A throw in any of them stops
// all the ones after it, so a thin or partial payload has to degrade, not
// explode. Each of these has been a real shape at some point in this project.
console.log('\n== partial and degraded payloads degrade, they do not crash ==');
const degraded = [
  ['no rows on any board', { ...payload(), crypto: { universe: 211, breakout: [], breakdown: [], favorites: [], longTermPotential: [] }, stocks: { universe: 290, breakout: [], breakdown: [], favorites: [], longTermPotential: [] } }],
  ['classSkill absent entirely (cold start)', { ...payload(), classSkill: {} }],
  ['no overview block', { ...payload(), overview: {} }],
  ['rows missing rsi, drivers and analysis', { ...payload(), crypto: { universe: 211, breakout: [{ symbol: 'BTC', name: 'Bitcoin', price: 1, chg24h: null, chg7d: null, rsi: null, score: 0, dir: 0 }], breakdown: [], favorites: [], longTermPotential: [] } }],
  ['no price tick at all', payload()]
];
for (const [label, data] of degraded) {
  const result = await render(data, { tick: label === 'no price tick at all' ? null : LIVE_TICK, settleMs: 1200 });
  check(`renders without throwing: ${label}`, result.pageErrors.length === 0, result.pageErrors.join(' | '));
  // Not throwing is only half of it. The renderers run as one chain, so a
  // silent stop halfway leaves the page looking fine while the sections after
  // the break never drew. Assert the LAST thing the chain does actually ran.
  check(`the render chain ran to completion: ${label}`,
    result.doc.querySelector('[data-dashboard-view="overview"]')?.hidden === false
    && result.doc.getElementById('boards').innerHTML.length > 0
    && !result.doc.getElementById('stateBox').textContent.includes('failed to render'),
    result.doc.getElementById('stateBox').textContent.slice(0, 90));
  result.dom.window.close();
}

// ============================ page contract ================================
console.log('\n== page contract ==');
const meta = withheld.doc;
check('the page keeps its canonical URL', meta.querySelector('link[rel="canonical"]')?.getAttribute('href') === 'https://frontiercapitalsignals.com/signals/');
check('the page keeps a title and description', (meta.title || '').length > 10 && (meta.querySelector('meta[name="description"]')?.content || '').length > 40);
check('the page keeps its social preview image', !!meta.querySelector('meta[property="og:image"]'));
check('the structured-data block is valid JSON', (() => {
  const node = meta.querySelector('script[type="application/ld+json"]');
  try { JSON.parse(node.textContent); return true; } catch { return false; }
})());
check('the risk disclaimer is present and not hidden behind a view',
  meta.body.textContent.includes('not a recommendation or financial advice')
  || meta.body.textContent.includes('not investment advice'));
check('the model version in the footer matches the payload it rendered',
  meta.body.textContent.includes('confluence-v8'));

for (const view of ['screens', 'watchlists', 'research', 'timing', 'overview']) {
  check(`the ${view} view has content to show`, meta.querySelectorAll(`[data-dashboard-view="${view}"]`).length > 0);
}

[withheld, proven, ui, clocks, stale].forEach((r) => r.dom.window.close());

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log('DASHBOARD OK');
