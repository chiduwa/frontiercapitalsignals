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
    model: 'confluence-v9',
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
    dataQuality: { asOf: '2026-09-19', needsAttention: 1, assets: [{symbol:'BTC',issues:['Settlement-rate collection missing or stale']}] },
    prediction: { 'crypto|1': { assets: 272, shrinkage } }
  }
});

const learned = await render(hierarchical({ atFinalRefit: 0.0425, overScoredForecasts: 0.0052, learnedFeatures: [] }), { settleMs: 1200 });
const learnedCard = learned.doc.getElementById('dashboardInsights').textContent;
check('the card reports the share of each asset model that is its own',
  learnedCard.includes('Own coefficients earned') && learnedCard.includes('4%'), learnedCard.slice(0, 40));
check('and states the remainder is pooled with the class, with the reason',
  /9[5-6]% of the average asset model is pooled/.test(learnedCard)
  && learnedCard.includes('sampling noise'));
check('the per-asset lane never presents itself as a live vote',
  learnedCard.includes('no live vote') && !/\bBUY\b|\bSELL\b/.test(learnedCard));
check('per-asset data quality is visible without implying accuracy', learnedCard.includes('Tracked data checks') && learnedCard.includes('BTC') && learnedCard.includes('Settlement-rate collection missing or stale') && learnedCard.includes('Coverage does not establish prediction accuracy'));
learned.dom.window.close();

// Fully pooled is the EXPECTED result on this data, so it must render as a
// real zero rather than falling through to the unavailable branch.
const pooled = await render(hierarchical({ atFinalRefit: 0, overScoredForecasts: 0, learnedFeatures: [] }), { settleMs: 1200 });
const pooledCard = pooled.doc.getElementById('dashboardInsights').textContent;
check('zero shrinkage renders as a measured 0%, not as missing data',
  pooledCard.includes('Own coefficients earned') && pooledCard.includes('0%')
  && pooledCard.includes('100% of the average asset model is pooled'), pooledCard.slice(0, 60));
pooled.dom.window.close();

// And an absent or not-yet-run lane must infer nothing at all.
const awaiting = await render({ ...payload(),
  hierarchicalResearch: { status: 'awaiting-first-run', actionable: false } }, { settleMs: 1200 });
check('a lane awaiting its first run infers no value',
  awaiting.doc.getElementById('dashboardInsights').textContent.includes('awaiting its first run'));
awaiting.dom.window.close();
// Reuses the plain-payload render above rather than paying for another one:
// rendering this 500KB+ page in jsdom is the single most expensive thing in
// this suite, and the deploy job has a wall-clock budget.
check('and an absent lane adds nothing to the card rather than rendering a zero',
  !ui.doc.getElementById('dashboardInsights').textContent.includes('Own coefficients earned'));

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
  meta.body.textContent.includes('confluence-v9'));

for (const view of ['screens', 'watchlists', 'research', 'timing', 'overview']) {
  check(`the ${view} view has content to show`, meta.querySelectorAll(`[data-dashboard-view="${view}"]`).length > 0);
}

const sessionView = await render({ ...payload(), sessionResearch:{asOf:'2026-09-19',status:'research-only',actionable:false,
  assets:{BTC:{instrument:'spot',profiles:{weekday:{hoursET:[10,9,11],replicated:true,testDays:186},all:{directions:[]}},
    morning:[{if:'up',n:117,closeProbability:.709,forwardProbability:.573,supported:false}]}},
  stablecoin:{snapshotDays:18,proxy:'USDC/USDT turnover proxy',assets:{BTC:[{horizonDays:1,features:'ratio',directionEvidence:{adjustedP:1,low:-.1},magnitudeEvidence:{adjustedP:1,low:-.1}}]}}}}, {settleMs:1200});
const sessionText=sessionView.doc.getElementById('panel-sessionResearch')?.textContent||'';
check('session research renders without disrupting the page',sessionView.pageErrors.length===0 && sessionText.includes('BTC'));
check('conditional close association is distinct from subsequent return',sessionText.includes('70.9% close higher') && sessionText.includes('57.3% continue after 10') && sessionText.includes('descriptive only'));
check('timing and stablecoin evidence never become a directional call',sessionText.includes('no cost-clearing evidence') && sessionText.includes('direction unconfirmed') && sessionText.includes('do not create trade calls'));
check('weekday time is local and missing weekend history stays missing',sessionText.includes('10:00, 09:00, 11:00 ET') && sessionText.includes('Insufficient history'));
sessionView.dom.window.close();

const {researchSupplement}=await import('./scripts/session-health.mjs');
const {explainAssetMove}=await import('./scripts/market-explanations.mjs');
const calendarFixture=JSON.parse(readFileSync(new URL('./docs/research-2026-09-19/calendar-report.json',import.meta.url),'utf8'));
const basketFixture=researchSupplement(JSON.parse(readFileSync(new URL('./docs/research-2026-09-19/stable-basket-report.json',import.meta.url),'utf8')));
const newResearch=await render({...payload(),sessionResearch:{calendar:calendarFixture,stableBasket:basketFixture},marketExplanations:{asOf:new Date(NOW).toISOString(),liquidationProviderStatus:'not-configured',assets:{BTC:explainAssetMove({symbol:'BTC',nowMs:NOW})}}},{settleMs:1200});
const calendarText=newResearch.doc.getElementById('panel-calendarResearch')?.textContent||'';
const basketText=newResearch.doc.getElementById('panel-stableBasketResearch')?.textContent||'';
const insightText=newResearch.doc.getElementById('panel-marketExplanations')?.textContent||'';
check('real calendar, stablecoin and insight payloads render without errors',newResearch.pageErrors.length===0,JSON.stringify(newResearch.pageErrors));
check('calendar exposes weekdays with counts and avoids majority peak claims',calendarText.includes('Monday')&&calendarText.includes('Sunday')&&calendarText.includes('20% fraction does not mean')&&calendarText.includes('Large dumps:'));
check('HYPE weekday insufficiency is visible',calendarText.includes('HYPE')&&calendarText.includes('insufficient development history'));
check('exact named basket and market benchmarks appear',basketText.includes('USDG')&&basketText.includes('RLUSD')&&basketText.includes('CMC100')&&basketText.includes('TRACKED_MEDIAN'));
check('unproven flow rules stay descriptive',basketText.includes('Direction: unconfirmed')&&basketText.includes('Corrected comparisons passing: 0')&&basketText.includes('Conditional percentages are descriptive'));
check('missing OI and liquidations cannot render fabricated causal explanations',insightText.includes('insufficient-live-data')&&insightText.includes('Missing reports are not zero')&&insightText.includes('cannot be confirmed'));
newResearch.dom.window.close();

// ============ time-series panel: a size forecast, never a direction ==========
// The section is built by the real builder on synthetic series, so what is
// asserted is what the daily job would actually publish: a planted weekend
// effect is found, a stale series says so, a missing one is reported rather
// than skipped, and the panel never renders anything that reads as a call.
console.log('\n== the time-series panel publishes a volatility band and nothing directional ==');
{
  const { buildTimeSeriesSection } = await import('./scripts/time-series-research.mjs');
  const tsDay = i => new Date(Date.UTC(2023, 0, 1 + i)).toISOString().slice(0, 10);
  const seeded = seed => { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return (x + 0.5) / 4294967296; }; };
  const series = (seed, n, weekend) => {
    const r = seeded(seed); let price = 100, s2 = 4e-4; const bars = [{ date: tsDay(0), close: price }];
    for (let t = 1; t <= n; t++) {
      const wd = new Date(Date.parse(tsDay(t) + 'T00:00:00Z')).getUTCDay();
      const e = Math.sqrt(s2) * Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r());
      price *= Math.exp(e * (weekend && (wd === 0 || wd === 6) ? 0.5 : 1));
      s2 = 4e-4 * 0.02 + 0.08 * e * e + 0.9 * s2;
      bars.push({ date: tsDay(t), close: price });
    }
    return bars;
  };
  const tracked = ['BTC', 'ETH', 'SOL', 'XLM', 'XRP', 'HYPE', 'HBAR', 'ARB'];
  const assets = tracked.map((symbol, i) => ({ symbol, assetClass: 'crypto', bars: series(60 + i, symbol === 'HYPE' ? 700 : 720, i < 2) }));
  assets.push({ symbol: 'MCAP:BROAD', assetClass: 'market', bars: series(99, 720, true) });
  const asOf = tsDay(721);
  const lane = (qlikeT, bandCoverage = 0.794) => ({ zoo: {
    byCohort: { established: { field: {
      arima: { direction: { hitRate: 0.4997, netPct: -0.179, netT: -1.72, forecasts: 209346 } },
      structural: { direction: { hitRate: 0.5031, netPct: -0.074, netT: -0.70, forecasts: 209116 } } } } },
    timeSeries: {
      headToHead: { garchWeekdayVol_vs_trailingVol: { byCohort: { established: {
        forecasts: 209346, qlikeT, firstHalf: { qlikeT: qlikeT + 0.2 }, secondHalf: { qlikeT: qlikeT + 0.4 },
        spearmanCandidate: 0.308, spearmanIncumbent: 0.273 } } } },
      intervals: { established: { models: {
        trailingVol: { coverage: 0.791, meanWidthPct: 11.0, weekdayCoverageSpread: 0.103 },
        garchWeekdayVol: { coverage: bandCoverage, meanWidthPct: 10.59, weekdayCoverageSpread: 0.057 } } } } } } });
  const section = buildTimeSeriesSection({ asOf, assets }, { asOf,
    prediction: { 'crypto|1': lane(-5.36), 'crypto|7': lane(-2.81, 0.773), 'stock|1': lane(-7.64), 'stock|5': lane(1.01) } });
  const tsView = await render({ ...payload(), hierarchicalResearch: { status: 'shadow', actionable: false, timeSeries: section } }, { settleMs: 1200 });
  const panelEl = tsView.doc.getElementById('panel-timeSeriesResearch');
  const text = panelEl?.textContent || '';
  check('the time-series panel renders without disrupting the page', tsView.pageErrors.length === 0 && Boolean(panelEl), JSON.stringify(tsView.pageErrors));
  check('it sits in the timing view, not on a board', Boolean(panelEl?.closest('[data-dashboard-view="timing"]')));
  check('every tracked asset and both markets get a row',
    [...tracked, 'Crypto market', 'US stock market'].every(label => text.includes(label)), text.slice(0, 200));
  check('ARB, the newest always-tracked asset, is measured like the rest',
    Boolean(panelEl?.querySelector('[data-ts="ARB"]')) && /80% band for/.test(panelEl.querySelector('[data-ts="ARB"]').textContent));
  check('the panel states that only the band is a forecast, and of size only',
    text.includes('Only the 80% band is a forecast') && text.includes('never which way') && text.includes('no trade call'));
  check('no direction arrow or trade verb is rendered inside the panel',
    panelEl.querySelectorAll('.dir-arrow, .dir-up, .dir-down').length === 0 && !/\bBUY\b|\bSELL\b|\bLONG\b|\bSHORT\b/.test(text));
  check('a planted weekend effect is reported with its corrected p-value',
    /BTC[\s\S]*Move size varies by weekday: (Sat|Sun)/.test(text) && text.includes('adj. p'));
  check('series without the effect say so instead of inventing one', text.includes('No confirmed weekday effect on move size'));
  check('cycles are only claimed when they survive correction', text.includes('No cycle detected') && !text.includes('Candidate ~'));
  check('a missing series is reported, not silently dropped', text.includes('No archived daily bars for this series.'));
  const hypeRow = panelEl.querySelector('[data-ts="HYPE"]')?.textContent || '';
  check('an old archive is marked stale next to its last close', /stale · last close/.test(hypeRow), hypeRow.slice(0, 120));
  check('and a stale series gets no band: a k-step forecast dated to a closed session is not current',
    hypeRow.includes('80% band withheld') && !/80% band for/.test(hypeRow));
  check('the evidence line carries the measured verdicts, not adjectives',
    text.includes('beat the production volatility scale (QLIKE t=-5.36') && text.includes('no clear difference from the production scale (QLIKE t=1.01')
    && text.includes('no skill after costs (ARIMA net t=-1.72, structural net t=-0.70)'));
  check('a lower loss with an under-covering band is not reported as a plain win',
    /Crypto, 7 days: move size — GARCH with a weekday factor beat the production volatility scale \(QLIKE t=-2\.81[^)]*\), but its band under-covers/.test(text)
    && !/Crypto, 1 day: [^.]*under-covers/.test(text));
  check('percentiles read as English ordinals', !/\d(1|2|3)th percentile/.test(text.replace(/1[123]th/g, '')) && /\d+(st|nd|rd|th) percentile/.test(text));
  check('phones get labelled cells rather than a four-column grid',
    panelEl.querySelectorAll('.bh-cell[data-l="Trend"]').length >= 8);
  tsView.dom.window.close();

  const failedView = await render({ ...payload(), hierarchicalResearch: { status: 'shadow', actionable: false,
    timeSeries: { status: 'failed', actionable: false, error: 'boom' } } }, { settleMs: 1200 });
  const failedText = failedView.doc.getElementById('panel-timeSeriesResearch')?.textContent || '';
  check('a failed run renders as unavailable, inferring nothing', failedView.pageErrors.length === 0
    && failedText.includes('unavailable this run (failed)') && !failedText.includes('80% band'));
  failedView.dom.window.close();
}

// ============ per-asset model tournament: forward-tested, never a call ========
// The summary is the real output of scripts/model-tournament.py on the tracked
// panel (2026-09-23 seeding run), passed through the real payload loader.
console.log('\n== the model-tournament panel shows who is in force and what is being tested ==');
{
  const { loadTournamentHealth } = await import('./scripts/model-tournament-io.mjs');
  const summary = JSON.parse(readFileSync(new URL('./test-fixtures/model-tournament-summary.json', import.meta.url), 'utf8'));
  // One slot promoted, to see the promoted rendering; the rest as seeded.
  summary.assets.BTC['magnitude:1'] = { ...summary.assets.BTC['magnitude:1'], promoted: true,
    incumbentLabel: 'GARCH + weekday, calibrated', championSince: '2026-11-02T15:20:00Z' };
  const created = '2026-09-23T15:30:00Z';
  const query = async () => [{ created_at: created, summary_json: JSON.stringify(summary) }];
  const tournament = await loadTournamentHealth({}, Date.parse('2026-09-23T18:00:00Z'), query);
  const mtView = await render({ ...payload(), modelTournament: tournament }, { settleMs: 1200 });
  const el = mtView.doc.getElementById('panel-modelTournament');
  const text = el?.textContent || '';
  check('the tournament panel renders without disrupting the page', mtView.pageErrors.length === 0 && Boolean(el), JSON.stringify(mtView.pageErrors));
  check('it sits in the timing view', Boolean(el?.closest('[data-dashboard-view="timing"]')));
  check('every always-tracked asset and the pooled slot get a row',
    ['*', 'BTC', 'ETH', 'SOL', 'XLM', 'XRP', 'HYPE', 'HBAR', 'ARB'].every(sym => el.querySelector(`[data-mt="${sym}"]`)));
  check('the rule is stated: promotion only on forecasts logged before their outcomes, research only',
    text.includes('only on forecasts it logged before their outcomes existed') && text.includes('Research only; nothing here places a trade'));
  check('a promoted slot says so, with its date', /GARCH \+ weekday, calibrated promoted on forward evidence 2026-11-02/.test(el.querySelector('[data-mt="BTC"]').textContent));
  check('an unpromoted slot shows the current method and its challengers\' progress',
    /base rate \(no skill\) current method/.test(text) && /challengers? logging forecasts; leader .*% of the way to promotion/.test(text));
  check('forecasts render in plain units', /P\(up\) \d+%/.test(text) && /typical move ±\d/.test(text) && /likeliest cheapest firing \d\d:00 UTC/.test(text));
  check('each asset shows how its models weigh the inputs, and whether the weights held',
    /direction .*%/.test(el.querySelector('[data-mt="ETH"]').textContent) && /sign held across \d+ refits|no top weight held its sign/.test(text));
  check('no direction arrow or trade verb inside the panel',
    el.querySelectorAll('.dir-arrow, .dir-up, .dir-down').length === 0 && !/\bBUY\b|\bSELL\b|\bLONG\b|\bSHORT\b/.test(text));
  check('only the promoted slot is actionable', tournament.assets.BTC['magnitude:1'].actionable === true
    && tournament.assets.ETH['direction:1'].actionable === false && tournament.actionable === true);
  mtView.dom.window.close();

  // Widened to 40 coins and 40 stocks: a promoted stock shows in sessions,
  // with no buying-time slot, under a line naming what else was promoted.
  const base = summary.assets.BTC;
  const stockSlot = k => ({ ...base[k.replace(':5', ':7')], incumbentLabel: 'base rate (no skill)', promoted: false });
  const wide = { ...tournament, universe: { crypto: 40, stock: 40 }, promotedElsewhere: ['NVDA'],
    classes: { NVDA: 'stock', '*stock': 'stock' },
    assets: { ...tournament.assets,
      NVDA: { 'direction:1': { ...stockSlot('direction:1'), promoted: true, actionable: true, incumbentLabel: 'logistic on momentum (light shrinkage)' },
              'direction:5': stockSlot('direction:5'), 'magnitude:1': stockSlot('magnitude:1'), 'magnitude:5': stockSlot('magnitude:5') },
      '*stock': { 'direction:1': stockSlot('direction:1'), 'direction:5': stockSlot('direction:5'), 'magnitude:1': stockSlot('magnitude:1'), 'magnitude:5': stockSlot('magnitude:5') } } };
  const wideView = await render({ ...payload(), modelTournament: wide }, { settleMs: 1200 });
  const wEl = wideView.doc.getElementById('panel-modelTournament');
  const nv = wEl?.querySelector('[data-mt="NVDA"]')?.textContent || '';
  check('a promoted stock renders in trading sessions, with no buying-time slot', wideView.pageErrors.length === 0
    && /1 session: logistic on momentum \(light shrinkage\) promoted/.test(nv) && /5 sessions:/.test(nv) && nv.includes('not applicable'), nv.slice(0, 300));
  check('pools are labelled by class and come first', /All crypto/.test(wEl.querySelector('[data-mt="*"]')?.textContent || '')
    && /All stocks/.test(wEl.querySelector('[data-mt="*stock"]')?.textContent || '')
    && wEl.querySelectorAll('[data-mt]')[0].getAttribute('data-mt') === '*');
  check('the panel says how wide the tournament is and names what else was promoted',
    /40 coins and 40 stocks/.test(wEl.textContent) && /promoted model \(NVDA\)/.test(wEl.textContent));
  wideView.dom.window.close();

  const firstView = await render({ ...payload(), modelTournament: { status: 'awaiting-first-run', actionable: false } }, { settleMs: 1200 });
  const firstText = firstView.doc.getElementById('panel-modelTournament')?.textContent || '';
  check('before the first run the panel says the current methods stand', firstView.pageErrors.length === 0
    && firstText.includes('has not published a run yet (awaiting-first-run)') && firstText.includes('current methods stand'));
  firstView.dom.window.close();
}

// ============ big-move watch: size, never direction ============================
// The summary is the real output of scripts/big-move-watch.py on the archive
// (2026-09-23), as the payload loader returns it.
console.log('\n== the big-move watch lists the likeliest movers and says direction is unknown ==');
{
  const summary = JSON.parse(readFileSync(new URL('./test-fixtures/big-move-watch-summary.json', import.meta.url), 'utf8'));
  const view = await render({ ...payload(), bigMoveWatch: { ...summary, status: 'live', ageHours: 3 } }, { settleMs: 1200 });
  const el = view.doc.getElementById('panel-bigMoveWatch');
  const text = el?.textContent || '';
  check('the watch renders without disrupting the page', view.pageErrors.length === 0 && Boolean(el), JSON.stringify(view.pageErrors));
  check('it sits with the watchlists, open', Boolean(el?.closest('[data-dashboard-view="watchlists"]')) && el.open === true);
  check('every watched coin gets a row with its chance of a 12%+ move',
    summary.watch.every(w => el.querySelector(`[data-bmw="${w.symbol}"]`)) && /\d+%/.test(el.querySelector('[data-bmw]').textContent));
  check('it states size, not direction, and that it is not advice',
    text.includes('either way') && text.includes('Size, not direction') && text.includes('not financial advice'));
  check('no direction arrow or trade verb inside the panel',
    el.querySelectorAll('.dir-arrow, .dir-up, .dir-down').length === 0 && !/\bBUY\b|\bSELL\b|\bLONG\b|\bSHORT\b/.test(text));
  check('a missing value renders as a dash, not NaN', !/NaN|undefined/.test(text));
  check('before any day is scored, the live record says it starts with this list', text.includes('starts with this list'));
  view.dom.window.close();
  const scored = await render({ ...payload(), bigMoveWatch: { ...summary, status: 'live', live: { days: 12, hitRate: 0.41, baseRate: 0.09, t: 4.2 }, recall: 0.22 } }, { settleMs: 1200 });
  const st = scored.doc.getElementById('panel-bigMoveWatch')?.textContent || '';
  check('once scored, it reports its hit rate against all coins and its recall',
    /41% of watched coins moved 12%\+ within two days, against 9% of all coins/.test(st) && /22% of all 12%\+ movers/.test(st));
  scored.dom.window.close();
  const first = await render({ ...payload(), bigMoveWatch: { status: 'awaiting-first-run' } }, { settleMs: 1200 });
  check('before the first run it says so', (first.doc.getElementById('panel-bigMoveWatch')?.textContent || '').includes('has not published a list yet'));
  first.dom.window.close();
}

// ============ sell pressure and profit growers (2026-09-26) ==================
console.log('\n== sell pressure: per-coin exhaustion, your coins, and the market as context ==');
{
  const exhaustion = {
    status: 'live', at: iso(20 * 60000).slice(0, 13) + ':00:00.000Z', createdAt: iso(10 * 60000), ageHours: 0.2,
    gauge: { scanned: 479, indexCoins: 472, breadth: 0.044, prints24h: 40, aggVolumeZ: -0.24, marketRun72Z: 1.61, marketRet24Pct: 2.7,
      state: 'normal', headline: 'Ordinary conditions.', detail: '4.4% of 479 coins printed exhaustion in the last 24 hours (a typical day is 3.1%).' },
    reference: { median: 0.031, p90: 0.089, p97: 0.157 },
    prints: [
      { symbol: 'QNT', at: iso(60 * 60000), close: 110.7, barPct: 4.3, volZ: 3.07, tier: 'thin', configs: ['exhaustion_calibrated'], moveSincePct: -0.6 },
      { symbol: 'SPELL', at: iso(2 * 3600000), close: 0.0001164, barPct: 4.96, volZ: 4.03, tier: 'thin', configs: ['exhaustion20', 'exhaustion_calibrated'], moveSincePct: -1.6 }
    ],
    watch: [
      { symbol: 'BTC', price: 84034, barPct: 0.1, volZ: -0.97, tier: 'major', onVenue: true, lastPrint: null },
      { symbol: 'HBAR', price: 0.094, barPct: 0.8, volZ: 0.04, tier: 'mid', onVenue: true, lastPrint: null },
      { symbol: 'WLFI', price: 0.059, barPct: 3.1, volZ: 3.4, tier: 'mid', onVenue: true, lastPrint: { at: iso(3 * 3600000) }, moveSinceLastPrintPct: -2.4 },
      { symbol: 'NEWC', price: 1.2, tier: null, volZ: null, onVenue: true, lastPrint: null },
      { symbol: 'HYPE', onVenue: false }
    ],
    configs: [
      { id: 'exhaustion20', label: 'Volume exhaustion', notifying: true, casts: 116, excessPct: 4.94, excessT: 2.64, days: 21 },
      { id: 'exhaustion_calibrated', label: 'Volume exhaustion (per-coin)', notifying: true, casts: 0, excessPct: null, days: 0 }
    ],
    evidence: { period: 'Jan 2024 to Sep 2026, 478 Binance pairs, hourly', byTier: { thin: { excess24: -5.32 }, mid: { excess24: -2.82 }, major: { excess24: -0.27 } },
      bothRules: { excess24: -4.62, fellShare24: 0.76 }, market: { surgeInRally72: 2.74, surgeInRally168: 4.83 } },
    stocks: { note: 'On US stocks, no version of this signal held up in both halves of ten years of daily data (the best was about -0.8% against the market over 10 days), so there are no stock sell warnings.' }
  };
  const view = await render({ ...payload(), exhaustion }, { settleMs: 1200 });
  const sec = view.doc.querySelector('[data-dashboard-view="sell"]');
  const text = sec?.textContent || '';
  const rowText = (sym) => view.doc.querySelector(`[data-exh="${sym}"]`)?.textContent || '';
  check('the sell-pressure view renders without disrupting the page', view.pageErrors.length === 0 && Boolean(sec), JSON.stringify(view.pageErrors));
  check('it has its own tab', Boolean(view.doc.querySelector('[data-view-link="sell"]')));
  check('a large coin never gets a sell warning, and says why', /Large coin: volume surges here have tended to continue/.test(rowText('BTC')));
  check('a smaller coin that printed shows when, and what happened since', /Exhaustion 3h ago/.test(rowText('WLFI')) && /-2\.4% since/.test(rowText('WLFI')));
  check('a quiet smaller coin reads quiet', /Quiet/.test(rowText('HBAR')));
  check('coins without history or off the venue say so', /Not enough trading history/.test(rowText('NEWC')) && /Not on Binance spot/.test(rowText('HYPE')));
  check('the market panel is context, never a sell signal', /never a sell signal/.test(text) && /more upside/.test(text));
  check('recent prints say when both rules fired', /both rules/.test(view.doc.getElementById('panel-exhPrints')?.textContent || ''));
  check('the live record reads in plain words', /coins then trailed the market by 4\.94% per warning/.test(text) && /live record still collecting/.test(text));
  check('stocks are stated as tested and not signalled', /no stock sell warnings/.test(text));
  check('no NaN, undefined or em dash in the view', !/NaN|undefined|—/.test(text), (text.match(/.{0,30}(NaN|undefined|—).{0,30}/) || [])[0]);
  view.dom.window.close();
  const first = await render({ ...payload(), exhaustion: { status: 'awaiting-first-run', evidence: exhaustion.evidence } }, { settleMs: 1200 });
  check('before the first scan it says so', first.pageErrors.length === 0 && /first scan has not landed yet/.test(first.doc.querySelector('[data-dashboard-view="sell"]')?.textContent || ''));
  first.dom.window.close();
}

console.log('\n== profit growers: small and mid caps, from SEC filings ==');
{
  const pgRow = (list, rank, symbol, extra = {}) => ({ list, rank, symbol, name: `${symbol} Holdings Inc. Common Stock`, sector: 'Technology', price: 20,
    mcap: list === 'small' ? 9e8 : 4e9, ttm_ni: 5.5e7, ni_growth: 0.42, rev_growth: 0.31, oi_growth: 0.55, yoy_up: 4, profitable_quarters: 4, pe: 16.4,
    why: 'operating profit +55% on revenue +31%', ...extra });
  const profitGrowth = {
    status: 'live', asOf: '2026-09-26',
    lists: { small: [pgRow('small', 1, 'AAAA'), pgRow('small', 2, 'BBBB', { oi_growth: 327.8, ni_growth: null, pe: null })], mid: [pgRow('mid', 1, 'CCCC')] },
    live: {},
    evidence: { period: 'Apr 2017 to Jul 2026, 37 quarters', small: { perQuarterPct: 1.72, recentPerQuarterPct: 2.97 }, mid: { perQuarterPct: 1.99, recentPerQuarterPct: 2.66 },
      caveats: ['Only companies still listed today have prices.', 'Prices exclude dividends.', 'The ranking was picked from six candidates.'] }
  };
  const base = payload();
  base.stocks.breakout[0].profit = { ttmNi: 7.2e10, niGrowth: 1.45, revGrowth: 0.94, grower: true, latestQuarterEnd: '2026-07-27' };
  const view = await render({ ...base, profitGrowth }, { settleMs: 1200 });
  const sec = view.doc.querySelector('[data-dashboard-view="profits"]');
  const text = sec?.textContent || '';
  check('the profit-grower view renders without disrupting the page', view.pageErrors.length === 0 && Boolean(sec), JSON.stringify(view.pageErrors));
  check('it has its own tab', Boolean(view.doc.querySelector('[data-view-link="profits"]')));
  check('both size lists render their companies', Boolean(view.doc.querySelector('#panel-profitSmall [data-pg="AAAA"]')) && Boolean(view.doc.querySelector('#panel-profitMid [data-pg="CCCC"]')));
  check('growth off a tiny base reads as a bound, not thousands of percent', /over \+500%/.test(view.doc.querySelector('[data-pg="BBBB"]')?.textContent || ''));
  check('names are shortened and the reason is shown', /AAAA Holdings Inc\./.test(text) && !/Common Stock/.test(text) && /operating profit \+55% on revenue \+31%/.test(text));
  check('the evidence and its caveats are on the page', /moderate evidence, not a guarantee/.test(text) && /Prices exclude dividends/.test(text));
  check('missing values read n/a, never NaN', !/NaN|undefined|—/.test(text));
  const nvda = view.doc.querySelector('tr[data-symbol="NVDA"] .profit-note');
  check('an equity row on the live screens carries its profit facts', Boolean(nvda) && /Profitable, \$72\.0B net over 4 quarters/.test(nvda?.textContent || '') && /profit grower/.test(nvda?.textContent || ''), nvda?.textContent);
  view.dom.window.close();
}

[withheld, proven, ui, clocks, stale].forEach((r) => r.dom.window.close());

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log('DASHBOARD OK');
