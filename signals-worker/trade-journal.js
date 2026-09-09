const JOURNAL_STATE_KEY = 'signals:account-journal-alert-watermark-v1';
const JOURNAL_URL = 'https://frontiercapitalsignals.com/signals/trades';
const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  Vary: 'Authorization',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY'
};

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function journalSelection(value) {
  return ['external', 'manual', 'unknown', 'bot', 'all'].includes(value) ? value : 'external';
}

function originPredicate(selection) {
  if (selection === 'external') return { sql: "origin IN ('manual','unknown')", params: [] };
  if (selection === 'all') return { sql: '1 = 1', params: [] };
  return { sql: 'origin = ?', params: [selection] };
}

function extractCredential(request) {
  const header = request.headers.get('Authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  if (!header.startsWith('Basic ')) return null;
  try {
    const decoded = atob(header.slice(6));
    const colon = decoded.indexOf(':');
    if (colon < 0 || decoded.slice(0, colon) !== 'fcs') return null;
    return decoded.slice(colon + 1);
  } catch { return null; }
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value))));
}

export async function constantTimeCredentialEqual(left, right) {
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  // Cloudflare Workers exposes this WebCrypto extension. The fixed-length XOR
  // fallback keeps local Node tests portable and does not short-circuit.
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let difference = a.length ^ b.length;
  const width = Math.max(a.length, b.length);
  for (let i = 0; i < width; i++) difference |= (a[i] || 0) ^ (b[i] || 0);
  return difference === 0;
}

export async function isTradeJournalRequestAuthorized(request, env) {
  if (!env?.TRADE_JOURNAL_TOKEN) return false;
  const credential = extractCredential(request);
  return credential != null && constantTimeCredentialEqual(credential, env.TRADE_JOURNAL_TOKEN);
}

function privateResponse(body, init = {}) {
  return new Response(body, { ...init, headers: { ...PRIVATE_HEADERS, ...(init.headers || {}) } });
}

function privateJson(body, status = 200) {
  return privateResponse(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function displayNumber(value, digits = 2) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function displayTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ') : '—';
}

async function all(db, sql, params = []) {
  const result = await db.prepare(sql).bind(...params).all();
  return result.results || [];
}

export async function loadTradeJournal(env, url) {
  if (!env?.FCS_DB) throw new Error('FCS_DB is not bound');
  const selection = journalSelection(url.searchParams.get('origin'));
  const days = clampInteger(url.searchParams.get('days'), 30, 1, 365);
  const limit = clampInteger(url.searchParams.get('limit'), 100, 1, 500);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const predicate = originPredicate(selection);
  const [origins, fills, daily, fees, reviewRows, runs] = await Promise.all([
    all(env.FCS_DB, 'SELECT * FROM account_journal_origin_summary ORDER BY market, origin'),
    all(env.FCS_DB, `SELECT market, symbol, trade_id, order_id, client_order_id,
        event_time, side, position_side, price, quantity, quote_quantity,
        realized_pnl, commission, commission_asset, is_maker, origin,
        classification_method, classification_evidence
      FROM account_journal_fills WHERE ${predicate.sql}
      ORDER BY event_time DESC LIMIT ?`, [...predicate.params, limit]),
    all(env.FCS_DB, `SELECT * FROM account_journal_daily_stats
      WHERE day >= ? AND ${predicate.sql}
      ORDER BY day DESC, market, symbol LIMIT 1000`, [cutoff, ...predicate.params]),
    all(env.FCS_DB, `SELECT * FROM account_journal_daily_fees
      WHERE day >= ? AND ${predicate.sql}
      ORDER BY day DESC, market, symbol, commission_asset LIMIT 1000`, [cutoff, ...predicate.params]),
    all(env.FCS_DB, 'SELECT COUNT(*) AS n FROM account_journal_review_queue'),
    all(env.FCS_DB, `SELECT run_id, started_at, completed_at, status,
        markets_requested, symbols_requested, fills_seen, pages_read,
        error_count, error_summary
      FROM account_journal_runs ORDER BY started_at DESC LIMIT 10`)
  ]);
  return {
    generatedAt: new Date().toISOString(), selection, days, limit,
    definitions: {
      bot: 'Proven by an exact bot ledger/order ID or reserved FCS client-order prefix.',
      manual: 'Proven by an operator override or explicitly reserved manual client-order prefix.',
      unknown: 'Not attributable from documented exchange evidence; never presumed manual.',
      spotPnl: 'Binance spot fills do not supply realized P&L; quote flow and fees are reported without synthetic profit.'
    },
    reviewCount: Number(reviewRows[0]?.n || 0), origins, daily, fees, fills, runs
  };
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function journalCsv(data) {
  const columns = ['market', 'symbol', 'trade_id', 'order_id', 'client_order_id',
    'event_time', 'side', 'position_side', 'price', 'quantity', 'quote_quantity',
    'realized_pnl', 'commission', 'commission_asset', 'is_maker', 'origin',
    'classification_method', 'classification_evidence'];
  return [columns.join(','), ...data.fills.map((row) => columns.map((column) => csvCell(row[column])).join(','))].join('\n');
}

function summaryRows(data) {
  if (!data.origins.length) return '<tr><td colspan="9">No imported fills yet.</td></tr>';
  return data.origins.map((row) => `<tr>
    <td>${escapeHtml(row.market)}</td><td><span class="pill ${escapeHtml(row.origin)}">${escapeHtml(row.origin)}</span></td>
    <td>${displayNumber(row.fill_count, 0)}</td><td>${displayNumber(row.order_count, 0)}</td>
    <td>${displayNumber(row.symbol_count, 0)}</td><td>${displayNumber(row.buy_quote_quantity, 2)}</td>
    <td>${displayNumber(row.sell_quote_quantity, 2)}</td>
    <td>${row.market === 'futures' ? displayNumber(row.realized_pnl, 4) : 'not supplied'}</td>
    <td>${escapeHtml(displayTime(row.last_fill_at))}</td>
  </tr>`).join('');
}

function fillRows(data) {
  if (!data.fills.length) return '<tr><td colspan="11">No fills in this selection.</td></tr>';
  return data.fills.map((row) => `<tr>
    <td>${escapeHtml(displayTime(row.event_time))}</td><td>${escapeHtml(row.market)}</td>
    <td>${escapeHtml(row.symbol)}</td><td>${escapeHtml(row.side)}</td>
    <td>${displayNumber(row.price, 10)}</td><td>${displayNumber(row.quantity, 10)}</td>
    <td>${displayNumber(row.quote_quantity, 4)}</td>
    <td>${row.market === 'futures' ? displayNumber(row.realized_pnl, 4) : '—'}</td>
    <td>${displayNumber(row.commission, 8)} ${escapeHtml(row.commission_asset || '')}</td>
    <td><span class="pill ${escapeHtml(row.origin)}">${escapeHtml(row.origin)}</span></td>
    <td title="${escapeHtml(row.classification_evidence)}">${escapeHtml(row.classification_method)}</td>
  </tr>`).join('');
}

function dailyRows(data) {
  if (!data.daily.length) return '<tr><td colspan="10">No daily analytics in this window.</td></tr>';
  return data.daily.map((row) => `<tr>
    <td>${escapeHtml(row.day)}</td><td>${escapeHtml(row.market)}</td><td>${escapeHtml(row.origin)}</td>
    <td>${escapeHtml(row.symbol)}</td><td>${displayNumber(row.fill_count, 0)}</td>
    <td>${displayNumber(row.order_count, 0)}</td><td>${displayNumber(row.buy_quote_quantity, 2)}</td>
    <td>${displayNumber(row.sell_quote_quantity, 2)}</td>
    <td>${row.market === 'futures' ? displayNumber(row.realized_pnl, 4) : 'not supplied'}</td>
    <td>${escapeHtml(displayTime(row.last_fill_at))}</td>
  </tr>`).join('');
}

function runRows(data) {
  if (!data.runs.length) return '<tr><td colspan="7">The importer has not run yet.</td></tr>';
  return data.runs.map((row) => `<tr>
    <td>${escapeHtml(displayTime(row.started_at))}</td><td>${escapeHtml(row.status)}</td>
    <td>${displayNumber(row.symbols_requested, 0)}</td><td>${displayNumber(row.fills_seen, 0)}</td>
    <td>${displayNumber(row.pages_read, 0)}</td><td>${displayNumber(row.error_count, 0)}</td>
    <td class="error">${escapeHtml(row.error_summary || '')}</td>
  </tr>`).join('');
}

function journalHtml(data) {
  const filter = (name, label) => `<a class="${data.selection === name ? 'active' : ''}" href="?origin=${name}&days=${data.days}">${label}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>FCS Private Trade Journal</title><style>
  :root{color-scheme:dark;--bg:#07101d;--panel:#0d1a2a;--line:#24364a;--text:#e8f0fa;--muted:#9cafc4;--accent:#60d8b0}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif}main{max-width:1500px;margin:auto;padding:28px 18px 60px}h1{margin:0 0 6px;font-size:27px}h2{margin:28px 0 10px;font-size:18px}.muted{color:var(--muted);max-width:1000px}.warn{border-left:3px solid #f5c76b;padding:9px 12px;background:#1b1920}.filters{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.filters a,.download{color:var(--text);text-decoration:none;border:1px solid var(--line);padding:7px 10px;border-radius:7px}.filters a.active{background:var(--accent);color:#06120e;border-color:var(--accent)}.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;overflow:auto}table{border-collapse:collapse;width:100%;white-space:nowrap}th,td{text-align:right;padding:9px 10px;border-bottom:1px solid var(--line)}th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}.pill{padding:2px 7px;border-radius:999px;background:#26384b}.pill.bot{background:#173b35;color:#83e6c4}.pill.manual{background:#29396b;color:#b9c9ff}.pill.unknown{background:#4a3820;color:#ffd996}.error{white-space:normal;max-width:420px;text-align:left;color:#ffc0c0}.meta{display:flex;gap:18px;flex-wrap:wrap;color:var(--muted)}code{color:#b8d9ff}</style></head><body><main>
  <h1>Private Binance account journal</h1>
  <p class="muted">Exchange fills kept separate from strategy predictions and bot outcome ledgers. Updated ${escapeHtml(displayTime(data.generatedAt))}.</p>
  <p class="warn"><strong>${displayNumber(data.reviewCount, 0)} fill(s) need provenance review.</strong> “Unknown” does not mean manual; it means Binance's documented records do not prove which client submitted the historical order. Spot realized P&amp;L is not supplied and is never fabricated.</p>
  <nav class="filters">${filter('external','Non-bot / review')}${filter('manual','Proven manual')}${filter('unknown','Unknown')}${filter('bot','FCS bots')}${filter('all','All')}<a class="download" href="api/trades.csv?origin=${data.selection}&days=${data.days}&limit=500">Download CSV</a><a class="download" href="api/trades?origin=${data.selection}&days=${data.days}&limit=500">JSON</a></nav>
  <div class="meta"><span>Window: ${data.days} days</span><span>Recent-fill limit: ${data.limit}</span></div>
  <h2>All-time origin summary</h2><div class="panel"><table><thead><tr><th>Market</th><th>Origin</th><th>Fills</th><th>Orders</th><th>Symbols</th><th>Buy quote</th><th>Sell quote</th><th>Futures realized P&amp;L</th><th>Last fill</th></tr></thead><tbody>${summaryRows(data)}</tbody></table></div>
  <h2>${data.days}-day daily analytics — ${escapeHtml(data.selection)}</h2><div class="panel"><table><thead><tr><th>Day</th><th>Market</th><th>Origin</th><th>Symbol</th><th>Fills</th><th>Orders</th><th>Buy quote</th><th>Sell quote</th><th>Futures realized P&amp;L</th><th>Last fill</th></tr></thead><tbody>${dailyRows(data)}</tbody></table></div>
  <h2>Recent fills</h2><div class="panel"><table><thead><tr><th>Time (UTC)</th><th>Market</th><th>Symbol</th><th>Side</th><th>Price</th><th>Quantity</th><th>Quote quantity</th><th>Futures realized P&amp;L</th><th>Fee</th><th>Origin</th><th>Evidence</th></tr></thead><tbody>${fillRows(data)}</tbody></table></div>
  <h2>Importer health</h2><div class="panel"><table><thead><tr><th>Started</th><th>Status</th><th>Symbols</th><th>Fills seen</th><th>Pages</th><th>Errors</th><th>Detail</th></tr></thead><tbody>${runRows(data)}</tbody></table></div>
  <p class="muted">Fees remain denominated in their actual asset (BNB, USDT, BTC, etc.); unlike currencies are not added together without a timestamped conversion rate.</p>
  </main></body></html>`;
}

export async function handleTradeJournalRequest(request, env, url, kind = 'html') {
  if (request.method !== 'GET') return privateResponse('method not allowed', { status: 405, headers: { Allow: 'GET' } });
  if (!env?.TRADE_JOURNAL_TOKEN) return privateResponse('trade journal is not configured', { status: 503 });
  if (!await isTradeJournalRequestAuthorized(request, env)) {
    return privateResponse('authentication required', {
      status: 401, headers: { 'WWW-Authenticate': 'Basic realm="FCS Trade Journal", charset="UTF-8"' }
    });
  }
  try {
    const data = await loadTradeJournal(env, url);
    if (kind === 'json') return privateJson(data);
    if (kind === 'csv') return privateResponse(journalCsv(data), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="fcs-account-journal-${new Date().toISOString().slice(0, 10)}.csv"`
      }
    });
    return privateResponse(journalHtml(data), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
      }
    });
  } catch (error) {
    console.error('Trade journal request failed:', error.message);
    return privateJson({ error: 'trade journal query failed' }, 500);
  }
}

function alertBody(row) {
  const manual = Number(row.manual_count || 0);
  const unknown = Number(row.unknown_count || 0);
  const pnl = row.futures_realized_pnl == null ? null : Number(row.futures_realized_pnl);
  const symbols = String(row.symbols || '').split(',').filter(Boolean).slice(0, 12).join(', ');
  return [
    `${Number(row.fill_count || 0)} newly journaled fill(s) outside the proven FCS-bot set: ${manual} proven manual, ${unknown} awaiting provenance review.`,
    symbols ? `Assets: ${symbols}.` : '',
    pnl != null && Number.isFinite(pnl) ? `Futures realized P&L reported by Binance: ${pnl.toFixed(4)} (fees remain separate by asset).` : '',
    'Spot realized P&L is not supplied by Binance and was not estimated.',
    `Private analytics: ${JOURNAL_URL}`
  ].filter(Boolean).join(' ');
}

export async function dispatchTradeJournalAlerts(env) {
  if (!env?.FCS_DB || !env?.FCS_CACHE || !env?.NTFY_TOPIC) return 0;
  // A journal run deliberately gives every inserted fill the same ingested_at
  // timestamp. The Worker can fire while that run is still committing later
  // symbol pages, so a timestamp-only watermark could acknowledge the first
  // page and then skip subsequent rows with the identical timestamp. SQLite
  // rowid advances per newly inserted fill and conflict updates retain their
  // original rowid, making it the exact append watermark this alert needs.
  let afterRowid = 0;
  try {
    const raw = await env.FCS_CACHE.get(JOURNAL_STATE_KEY);
    const state = raw ? JSON.parse(raw) : null;
    const parsed = Number(state?.maxRowid);
    if (Number.isSafeInteger(parsed) && parsed >= 0) afterRowid = parsed;
  } catch { /* replay is preferable to silently skipping an alert */ }

  const rows = await all(env.FCS_DB, `SELECT
      COUNT(*) AS fill_count,
      SUM(CASE WHEN origin = 'manual' THEN 1 ELSE 0 END) AS manual_count,
      SUM(CASE WHEN origin = 'unknown' THEN 1 ELSE 0 END) AS unknown_count,
      CASE WHEN SUM(CASE WHEN market = 'futures' THEN 1 ELSE 0 END) > 0
        THEN SUM(CASE WHEN market = 'futures' THEN realized_pnl ELSE NULL END)
        ELSE NULL END AS futures_realized_pnl,
      GROUP_CONCAT(DISTINCT market || ':' || symbol) AS symbols,
      MAX(ingested_at) AS max_ingested_at,
      MAX(rowid) AS max_rowid
    FROM account_journal_fills
    WHERE origin IN ('manual','unknown') AND rowid > ?`, [afterRowid]);
  const activity = rows[0];
  const maxRowid = Number(activity?.max_rowid);
  if (!activity || Number(activity.fill_count || 0) === 0
      || !Number.isSafeInteger(maxRowid) || maxRowid <= afterRowid) return 0;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let response;
  try {
    response = await fetch(`https://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}`, {
      method: 'POST', signal: controller.signal,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        Title: `Account journal: ${Number(activity.fill_count)} new fill${Number(activity.fill_count) === 1 ? '' : 's'}`,
        Priority: 'default', Tags: 'ledger,chart_with_upwards_trend', Click: JOURNAL_URL
      },
      body: alertBody(activity)
    });
  } finally { clearTimeout(timer); }
  if (!response.ok) throw new Error(`account journal ntfy failed: HTTP ${response.status}`);
  await env.FCS_CACHE.put(JOURNAL_STATE_KEY, JSON.stringify({
    maxRowid, maxIngestedAt: activity.max_ingested_at, sentAt: new Date().toISOString()
  }));
  return Number(activity.fill_count);
}
