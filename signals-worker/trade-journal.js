const JOURNAL_STATE_KEY = 'signals:account-journal-alert-watermark-v1';
const JOURNAL_URL = 'https://frontiercapitalsignals.com/signals/trades';
const DAY_MS = 86_400_000;
const PAGE_SIZE_DEFAULT = 100;
const PAGE_SIZE_MAX = 500;
const PAGE_MAX = 10_000;
const ANALYTICS_ROW_LIMIT = 1000;
const ANALYTICS_QUERY_LIMIT = ANALYTICS_ROW_LIMIT + 1;
const PERIOD_DAYS = Object.freeze({ week: 7, month: 30, year: 365, all: null });
const SORT_COLUMNS = Object.freeze({
  time: 'event_time', symbol: 'symbol', market: 'market', origin: 'origin',
  side: 'side', price: 'price', quantity: 'quantity', quote: 'quote_quantity',
  pnl: 'realized_pnl', commission: 'commission'
});
const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  Vary: 'Authorization',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY'
};

class JournalQueryError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function enumParameter(value, allowed, fallback, name, normalize = (item) => item.toLowerCase()) {
  if (value == null || value === '') return fallback;
  const parsed = normalize(String(value));
  if (allowed.includes(parsed)) return parsed;
  throw new JournalQueryError(`invalid ${name}`);
}

function integerParameter(value, fallback, min, max, name) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed >= min && parsed <= max) return parsed;
  throw new JournalQueryError(`invalid ${name}`);
}

function finiteParameter(value, name) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  throw new JournalQueryError(`invalid ${name}`);
}

function dateParameter(value, name) {
  if (value == null || value === '') return null;
  const raw = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new JournalQueryError(`invalid ${name}`);
  const time = Date.parse(`${raw}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== raw) {
    throw new JournalQueryError(`invalid ${name}`);
  }
  return raw;
}

function nextUtcDay(day) {
  const next = new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) throw new JournalQueryError('to date is outside the supported range');
  return next;
}

export function parseTradeJournalQuery(url, nowMs = Date.now()) {
  const requestedPeriod = url.searchParams.get('period');
  let period = enumParameter(requestedPeriod, [...Object.keys(PERIOD_DAYS), 'custom'], 'month', 'period');
  let from = dateParameter(url.searchParams.get('from'), 'from date');
  let to = dateParameter(url.searchParams.get('to'), 'to date');
  let rollingDays = PERIOD_DAYS[period];

  // Keep the original `days` API parameter as a bounded compatibility alias.
  // New callers should use the named presets or explicit UTC dates.
  const legacyDays = (requestedPeriod == null || requestedPeriod === 'custom') && url.searchParams.has('days')
    ? integerParameter(url.searchParams.get('days'), 30, 1, 365, 'days') : null;
  if (legacyDays != null && !from && !to) {
    rollingDays = legacyDays;
    period = Object.entries(PERIOD_DAYS).find(([, days]) => days === legacyDays)?.[0] || 'custom';
  }
  if (from || to) {
    period = 'custom';
    rollingDays = null;
  }
  if (period === 'custom' && rollingDays == null && !from && !to) {
    throw new JournalQueryError('custom period requires a from or to date');
  }
  if (from && to && from > to) throw new JournalQueryError('from date must not be after to date');

  const symbolValue = String(url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (symbolValue && !/^[A-Z0-9]{2,32}$/.test(symbolValue)) {
    throw new JournalQueryError('invalid symbol');
  }
  const market = enumParameter(url.searchParams.get('market'), ['all', 'spot', 'futures'], 'all', 'market');
  const origin = enumParameter(
    url.searchParams.get('origin'), ['external', 'manual', 'unknown', 'bot', 'all'], 'external', 'origin'
  );
  const side = enumParameter(
    url.searchParams.get('side'), ['all', 'BUY', 'SELL'], 'all', 'side', (item) => {
      const upper = item.toUpperCase();
      return upper === 'ALL' ? 'all' : upper;
    }
  );
  const pnl = enumParameter(
    url.searchParams.get('pnl'), ['all', 'reported', 'win', 'loss', 'breakeven'], 'all', 'pnl'
  );
  const minPnl = finiteParameter(url.searchParams.get('min_pnl'), 'minimum P&L');
  const maxPnl = finiteParameter(url.searchParams.get('max_pnl'), 'maximum P&L');
  if (minPnl != null && maxPnl != null && minPnl > maxPnl) {
    throw new JournalQueryError('minimum P&L must not exceed maximum P&L');
  }
  const sort = enumParameter(url.searchParams.get('sort'), Object.keys(SORT_COLUMNS), 'time', 'sort');
  const direction = enumParameter(
    url.searchParams.get('direction') ?? url.searchParams.get('order'), ['asc', 'desc'], 'desc', 'direction'
  );
  const legacyLimit = url.searchParams.get('limit');
  const pageSize = integerParameter(
    url.searchParams.get('page_size') ?? legacyLimit, PAGE_SIZE_DEFAULT, 1, PAGE_SIZE_MAX, 'page size'
  );
  const page = integerParameter(url.searchParams.get('page'), 1, 1, PAGE_MAX, 'page');

  const fromTime = from
    ? `${from}T00:00:00.000Z`
    : rollingDays == null ? null : new Date(nowMs - rollingDays * DAY_MS).toISOString();
  const toExclusive = to ? `${nextUtcDay(to)}T00:00:00.000Z` : null;
  return {
    period, rollingDays, from, to, fromTime, toExclusive, symbol: symbolValue,
    market, origin, side, pnl, minPnl, maxPnl, sort, direction, page, pageSize
  };
}

function originPredicate(selection) {
  if (selection === 'external') return { sql: "origin IN ('manual','unknown')", params: [] };
  if (selection === 'all') return { sql: '1 = 1', params: [] };
  return { sql: 'origin = ?', params: [selection] };
}

function journalPredicate(filters) {
  const origin = originPredicate(filters.origin);
  const clauses = [origin.sql];
  const params = [...origin.params];
  const add = (sql, value) => { clauses.push(sql); params.push(value); };

  if (filters.fromTime) add('event_time >= ?', filters.fromTime);
  if (filters.toExclusive) add('event_time < ?', filters.toExclusive);
  if (filters.symbol) add('symbol = ?', filters.symbol);
  if (filters.market !== 'all') add('market = ?', filters.market);
  if (filters.side !== 'all') add('side = ?', filters.side);
  const needsReportedPnl = filters.pnl !== 'all' || filters.minPnl != null || filters.maxPnl != null;
  if (needsReportedPnl) clauses.push("market = 'futures'", 'realized_pnl IS NOT NULL');
  if (filters.pnl !== 'all') {
    if (filters.pnl === 'win') clauses.push('realized_pnl > 0');
    else if (filters.pnl === 'loss') clauses.push('realized_pnl < 0');
    else if (filters.pnl === 'breakeven') clauses.push('realized_pnl = 0');
  }
  if (filters.minPnl != null) {
    add('realized_pnl >= ?', filters.minPnl);
  }
  if (filters.maxPnl != null) {
    add('realized_pnl <= ?', filters.maxPnl);
  }
  return { sql: clauses.join(' AND '), params };
}

function currentPositionPredicate(filters) {
  const origin = originPredicate(filters.origin);
  const clauses = [origin.sql];
  const params = [...origin.params];
  const add = (sql, value) => { clauses.push(sql); params.push(value); };
  if (filters.market === 'spot') clauses.push('1 = 0');
  if (filters.symbol) add('symbol = ?', filters.symbol);
  if (filters.side !== 'all') add('side = ?', filters.side);
  return { sql: clauses.join(' AND '), params };
}

function journalOrder(filters) {
  const column = SORT_COLUMNS[filters.sort];
  const direction = filters.direction.toUpperCase();
  if (column === 'event_time') {
    return `event_time ${direction}, market ASC, symbol ASC, trade_id ASC`;
  }
  return `${column} ${direction}, event_time DESC, market ASC, symbol ASC, trade_id ASC`;
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

export async function loadTradeJournal(env, url, nowMs = Date.now()) {
  if (!env?.FCS_DB) throw new Error('FCS_DB is not bound');
  const filters = parseTradeJournalQuery(url, nowMs);
  const predicate = journalPredicate(filters);
  const order = journalOrder(filters);
  const offset = (filters.page - 1) * filters.pageSize;
  // Resolve the count first so an out-of-range page cannot force a large
  // OFFSET scan. The second phase has exactly six concurrent D1 statements,
  // within the Worker per-invocation connection ceiling.
  const countRows = await all(env.FCS_DB, `SELECT COUNT(*) AS n FROM account_journal_fills
    WHERE ${predicate.sql}`, predicate.params);
  const totalRows = Number(countRows[0]?.n || 0);
  const totalPages = Math.max(1, Math.ceil(totalRows / filters.pageSize));
  if (filters.page > totalPages) throw new JournalQueryError(`page exceeds last page (${totalPages})`);

  // Keep the six-query fan-out below the Worker connection ceiling. Current
  // positions are small and read first; their own observed_at makes a delayed
  // journal sync visible rather than presenting stale marks as live.
  const currentPredicate = currentPositionPredicate(filters);
  const currentPositions = await all(env.FCS_DB, `SELECT symbol, position_side,
      side, position_amt, quantity, entry_price, break_even_price, mark_price,
      unrealized_pnl, liquidation_price, leverage, margin_type,
      isolated_margin, notional, origin, classification_method,
      classification_evidence, observed_at
    FROM account_journal_current_positions
    WHERE ${currentPredicate.sql}
    ORDER BY origin, symbol, position_side`, currentPredicate.params);

  const [origins, fills, dailyResult, feesResult, reviewRows, runs] = await Promise.all([
    all(env.FCS_DB, `SELECT market, origin,
        COUNT(*) AS fill_count,
        COUNT(DISTINCT symbol || ':' || order_id) AS order_count,
        COUNT(DISTINCT symbol) AS symbol_count,
        MIN(event_time) AS first_fill_at,
        MAX(event_time) AS last_fill_at,
        SUM(CASE WHEN side = 'BUY' THEN COALESCE(quote_quantity, 0) ELSE 0 END) AS buy_quote_quantity,
        SUM(CASE WHEN side = 'SELL' THEN COALESCE(quote_quantity, 0) ELSE 0 END) AS sell_quote_quantity,
        CASE WHEN market = 'futures' THEN SUM(realized_pnl) ELSE NULL END AS realized_pnl
      FROM account_journal_fills WHERE ${predicate.sql}
      GROUP BY market, origin ORDER BY market, origin`, predicate.params),
    all(env.FCS_DB, `SELECT market, symbol, trade_id, order_id, client_order_id,
        event_time, side, position_side, price, quantity, quote_quantity,
        realized_pnl, commission, commission_asset, is_maker, origin,
        classification_method, classification_evidence
      FROM account_journal_fills WHERE ${predicate.sql}
      ORDER BY ${order} LIMIT ? OFFSET ?`, [...predicate.params, filters.pageSize, offset]),
    all(env.FCS_DB, `SELECT substr(event_time, 1, 10) AS day, market, origin, symbol,
        COUNT(*) AS fill_count, COUNT(DISTINCT order_id) AS order_count,
        SUM(CASE WHEN side = 'BUY' THEN 1 ELSE 0 END) AS buy_fill_count,
        SUM(CASE WHEN side = 'SELL' THEN 1 ELSE 0 END) AS sell_fill_count,
        SUM(CASE WHEN side = 'BUY' THEN quantity ELSE 0 END) AS buy_quantity,
        SUM(CASE WHEN side = 'SELL' THEN quantity ELSE 0 END) AS sell_quantity,
        SUM(CASE WHEN side = 'BUY' THEN COALESCE(quote_quantity, 0) ELSE 0 END) AS buy_quote_quantity,
        SUM(CASE WHEN side = 'SELL' THEN COALESCE(quote_quantity, 0) ELSE 0 END) AS sell_quote_quantity,
        CASE WHEN market = 'futures' THEN SUM(realized_pnl) ELSE NULL END AS realized_pnl,
        MIN(event_time) AS first_fill_at, MAX(event_time) AS last_fill_at,
        MAX(ingested_at) AS refreshed_at
      FROM account_journal_fills WHERE ${predicate.sql}
      GROUP BY substr(event_time, 1, 10), market, origin, symbol
      ORDER BY day DESC, market, symbol LIMIT ?`, [...predicate.params, ANALYTICS_QUERY_LIMIT]),
    all(env.FCS_DB, `SELECT substr(event_time, 1, 10) AS day, market, origin, symbol,
        commission_asset, SUM(commission) AS commission_amount,
        MAX(ingested_at) AS refreshed_at
      FROM account_journal_fills WHERE ${predicate.sql}
        AND commission IS NOT NULL AND commission_asset IS NOT NULL
      GROUP BY substr(event_time, 1, 10), market, origin, symbol, commission_asset
      ORDER BY day DESC, market, symbol, commission_asset LIMIT ?`,
    [...predicate.params, ANALYTICS_QUERY_LIMIT]),
    all(env.FCS_DB, 'SELECT COUNT(*) AS n FROM account_journal_review_queue'),
    all(env.FCS_DB, `SELECT run_id, started_at, completed_at, status,
        markets_requested, symbols_requested, fills_seen, pages_read,
        error_count, error_summary
      FROM account_journal_runs ORDER BY started_at DESC LIMIT 10`)
  ]);
  const dailyTruncated = dailyResult.length > ANALYTICS_ROW_LIMIT;
  const feesTruncated = feesResult.length > ANALYTICS_ROW_LIMIT;
  const daily = dailyResult.slice(0, ANALYTICS_ROW_LIMIT);
  const fees = feesResult.slice(0, ANALYTICS_ROW_LIMIT);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    selection: filters.origin,
    days: filters.rollingDays,
    limit: filters.pageSize,
    filters,
    pagination: {
      page: filters.page, pageSize: filters.pageSize, totalRows, totalPages,
      hasPrevious: filters.page > 1,
      hasNext: filters.page < totalPages
    },
    coverage: {
      retentionPolicy: 'no-automatic-expiry',
      rawFillsDeletedByJournal: false,
      analyticsRowLimit: ANALYTICS_ROW_LIMIT,
      dailyTruncated,
      feesTruncated
    },
    definitions: {
      bot: 'Proven by an exact bot ledger/order ID or reserved FCS client-order prefix.',
      manual: 'Proven by an operator override or explicitly reserved manual client-order prefix.',
      unknown: 'Not attributable from documented exchange evidence; never presumed manual.',
      spotPnl: 'Binance spot fills do not supply realized P&L; quote flow and fees are reported without synthetic profit.',
      pnlFilter: 'Win, loss, breakeven, and P&L range filters use individual futures fills with Binance-reported realized P&L only; fees remain separate.'
    },
    reviewCount: Number(reviewRows[0]?.n || 0),
    currentPositions, origins, daily, fees, fills, runs
  };
}

function csvCell(value) {
  let text = value == null ? '' : String(value);
  // Prevent untrusted string fields (for example, exchange client-order IDs)
  // from becoming formulas when the CSV is opened in spreadsheet software.
  // Numeric database values remain numeric because their JS type is number.
  if (typeof value === 'string' && /^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
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

function currentPositionRows(data) {
  if (!data.currentPositions.length) {
    return '<tr><td colspan="13">No open futures positions in this selection.</td></tr>';
  }
  return data.currentPositions.map((row) => `<tr>
    <td>${escapeHtml(displayTime(row.observed_at))}</td><td>${escapeHtml(row.symbol)}</td>
    <td>${escapeHtml(row.side)}</td><td>${escapeHtml(row.position_side)}</td>
    <td>${displayNumber(row.quantity, 10)}</td><td>${displayNumber(row.entry_price, 10)}</td>
    <td>${displayNumber(row.break_even_price, 10)}</td><td>${displayNumber(row.mark_price, 10)}</td>
    <td>${displayNumber(row.unrealized_pnl, 4)}</td><td>${displayNumber(row.notional, 2)}</td>
    <td>${displayNumber(row.leverage, 0)}x</td><td>${displayNumber(row.liquidation_price, 10)}</td>
    <td><span class="pill ${escapeHtml(row.origin)}">${escapeHtml(row.origin)}</span><br><span title="${escapeHtml(row.classification_evidence)}">${escapeHtml(row.classification_method)}</span></td>
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

function queryString(data, overrides = {}) {
  const filters = { ...data.filters, ...overrides };
  const params = new URLSearchParams();
  if (filters.period === 'custom' && filters.rollingDays != null && !filters.from && !filters.to) {
    params.set('days', String(filters.rollingDays));
  } else {
    params.set('period', filters.period);
  }
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.symbol) params.set('symbol', filters.symbol);
  params.set('market', filters.market);
  params.set('origin', filters.origin);
  params.set('side', filters.side);
  params.set('pnl', filters.pnl);
  if (filters.minPnl != null) params.set('min_pnl', String(filters.minPnl));
  if (filters.maxPnl != null) params.set('max_pnl', String(filters.maxPnl));
  params.set('sort', filters.sort);
  params.set('direction', filters.direction);
  params.set('page', String(filters.page));
  params.set('page_size', String(filters.pageSize));
  return params.toString();
}

function selected(actual, expected) {
  return actual === expected ? ' selected' : '';
}

function windowLabel(data) {
  if (!data.filters.fromTime && !data.filters.toExclusive) return 'All retained history';
  const from = data.filters.fromTime ? displayTime(data.filters.fromTime) : 'first retained fill';
  const to = data.filters.to ? `${data.filters.to} 23:59:59 UTC` : 'now';
  return `${from} through ${to}`;
}

function journalHtml(data) {
  const originLink = (name, label) => `<a class="${data.selection === name ? 'active' : ''}" href="?${escapeHtml(queryString(data, {
    origin: name, page: 1
  }))}">${label}</a>`;
  const periodLink = (name, label) => `<a class="${data.filters.period === name ? 'active' : ''}" href="?${escapeHtml(queryString(data, {
    period: name, rollingDays: PERIOD_DAYS[name], from: null, to: null, page: 1
  }))}">${label}</a>`;
  const previous = data.pagination.hasPrevious
    ? `<a href="?${escapeHtml(queryString(data, { page: data.pagination.page - 1 }))}">Previous</a>` : '';
  const next = data.pagination.hasNext
    ? `<a href="?${escapeHtml(queryString(data, { page: data.pagination.page + 1 }))}">Next</a>` : '';
  const csvQuery = escapeHtml(queryString(data));
  const legacyDaysField = data.filters.period === 'custom' && data.filters.rollingDays != null
    ? `<input type="hidden" name="days" value="${displayNumber(data.filters.rollingDays, 0)}">` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>FCS Private Trade Journal</title><style>
  :root{color-scheme:dark;--bg:#07101d;--panel:#0d1a2a;--line:#24364a;--text:#e8f0fa;--muted:#9cafc4;--accent:#60d8b0}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif}main{max-width:1500px;margin:auto;padding:28px 18px 60px}h1{margin:0 0 6px;font-size:27px}h2{margin:28px 0 10px;font-size:18px}.muted{color:var(--muted);max-width:1000px}.warn{border-left:3px solid #f5c76b;padding:9px 12px;background:#1b1920}.filters,.filter-form,.pagination{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.filters a,.download,.pagination a,button{color:var(--text);text-decoration:none;border:1px solid var(--line);padding:7px 10px;border-radius:7px;background:transparent}.filters a.active{background:var(--accent);color:#06120e;border-color:var(--accent)}.filter-form label{display:flex;flex-direction:column;gap:4px;color:var(--muted);font-size:11px;text-transform:uppercase}.filter-form input,.filter-form select{min-height:35px;color:var(--text);background:#0a1422;border:1px solid var(--line);border-radius:6px;padding:6px}.filter-form button{align-self:end;cursor:pointer;background:var(--accent);color:#06120e}.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;overflow:auto}table{border-collapse:collapse;width:100%;white-space:nowrap}th,td{text-align:right;padding:9px 10px;border-bottom:1px solid var(--line)}th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}.pill{padding:2px 7px;border-radius:999px;background:#26384b}.pill.bot{background:#173b35;color:#83e6c4}.pill.manual{background:#29396b;color:#b9c9ff}.pill.unknown{background:#4a3820;color:#ffd996}.error{white-space:normal;max-width:420px;text-align:left;color:#ffc0c0}.meta{display:flex;gap:18px;flex-wrap:wrap;color:var(--muted)}code{color:#b8d9ff}</style></head><body><main>
  <h1>Private Binance account journal</h1>
  <p class="muted">Exchange fills kept separate from strategy predictions and bot outcome ledgers. Updated ${escapeHtml(displayTime(data.generatedAt))}.</p>
  <p class="warn"><strong>${displayNumber(data.reviewCount, 0)} fill(s) need provenance review.</strong> “Unknown” does not mean manual; it means Binance's documented records do not prove which client submitted the historical order. Spot realized P&amp;L is not supplied and is never fabricated.</p>
  <nav class="filters">${originLink('external','Non-bot / review')}${originLink('manual','Proven manual')}${originLink('unknown','Unknown')}${originLink('bot','FCS bots')}${originLink('all','All origins')}</nav>
  <nav class="filters">${periodLink('week','Week')}${periodLink('month','Month')}${periodLink('year','Year')}${periodLink('all','All retained')}</nav>
  <form class="filter-form" method="get">
    <label>Period<select name="period"><option value="week"${selected(data.filters.period,'week')}>Week</option><option value="month"${selected(data.filters.period,'month')}>Month</option><option value="year"${selected(data.filters.period,'year')}>Year</option><option value="all"${selected(data.filters.period,'all')}>All retained</option><option value="custom"${selected(data.filters.period,'custom')}>Custom dates</option></select></label>
    <label>From (UTC)<input type="date" name="from" value="${escapeHtml(data.filters.from || '')}"></label>
    <label>To (UTC)<input type="date" name="to" value="${escapeHtml(data.filters.to || '')}"></label>
    <label>Symbol<input name="symbol" maxlength="32" value="${escapeHtml(data.filters.symbol)}" placeholder="PEPEUSDT"></label>
    <label>Market<select name="market"><option value="all"${selected(data.filters.market,'all')}>All</option><option value="spot"${selected(data.filters.market,'spot')}>Spot</option><option value="futures"${selected(data.filters.market,'futures')}>Futures</option></select></label>
    <label>Origin<select name="origin"><option value="external"${selected(data.filters.origin,'external')}>Non-bot/review</option><option value="manual"${selected(data.filters.origin,'manual')}>Manual</option><option value="unknown"${selected(data.filters.origin,'unknown')}>Unknown</option><option value="bot"${selected(data.filters.origin,'bot')}>FCS bot</option><option value="all"${selected(data.filters.origin,'all')}>All</option></select></label>
    <label>Side<select name="side"><option value="all"${selected(data.filters.side,'all')}>All</option><option value="BUY"${selected(data.filters.side,'BUY')}>Buy</option><option value="SELL"${selected(data.filters.side,'SELL')}>Sell</option></select></label>
    <label>Reported P&amp;L<select name="pnl"><option value="all"${selected(data.filters.pnl,'all')}>All / unavailable</option><option value="reported"${selected(data.filters.pnl,'reported')}>Reported only</option><option value="win"${selected(data.filters.pnl,'win')}>Win (&gt; 0)</option><option value="loss"${selected(data.filters.pnl,'loss')}>Loss (&lt; 0)</option><option value="breakeven"${selected(data.filters.pnl,'breakeven')}>Breakeven (= 0)</option></select></label>
    <label>Min P&amp;L<input type="number" step="any" name="min_pnl" value="${escapeHtml(data.filters.minPnl ?? '')}"></label>
    <label>Max P&amp;L<input type="number" step="any" name="max_pnl" value="${escapeHtml(data.filters.maxPnl ?? '')}"></label>
    <label>Sort<select name="sort"><option value="time"${selected(data.filters.sort,'time')}>Time</option><option value="symbol"${selected(data.filters.sort,'symbol')}>Symbol</option><option value="market"${selected(data.filters.sort,'market')}>Market</option><option value="origin"${selected(data.filters.sort,'origin')}>Origin</option><option value="side"${selected(data.filters.sort,'side')}>Side</option><option value="price"${selected(data.filters.sort,'price')}>Price</option><option value="quantity"${selected(data.filters.sort,'quantity')}>Quantity</option><option value="quote"${selected(data.filters.sort,'quote')}>Quote quantity</option><option value="pnl"${selected(data.filters.sort,'pnl')}>Reported P&amp;L</option><option value="commission"${selected(data.filters.sort,'commission')}>Commission</option></select></label>
    <label>Direction<select name="direction"><option value="desc"${selected(data.filters.direction,'desc')}>Descending</option><option value="asc"${selected(data.filters.direction,'asc')}>Ascending</option></select></label>
    <label>Rows/page<select name="page_size"><option value="50"${selected(data.filters.pageSize,50)}>50</option><option value="100"${selected(data.filters.pageSize,100)}>100</option><option value="250"${selected(data.filters.pageSize,250)}>250</option><option value="500"${selected(data.filters.pageSize,500)}>500</option></select></label>
    ${legacyDaysField}<input type="hidden" name="page" value="1"><button type="submit">Apply filters</button>
  </form>
  <nav class="filters"><a class="download" href="api/trades.csv?${csvQuery}">Download this CSV page</a><a class="download" href="api/trades?${csvQuery}">JSON</a></nav>
  <div class="meta"><span>Window: ${escapeHtml(windowLabel(data))}</span><span>Rows: ${displayNumber(data.pagination.totalRows,0)}</span><span>Page ${displayNumber(data.pagination.page,0)} of ${displayNumber(data.pagination.totalPages,0)}</span><span>Sort: ${escapeHtml(data.filters.sort)} ${escapeHtml(data.filters.direction)}</span></div>
  <p class="muted">There is no journal retention cutoff; this service never deletes raw fills. Storage remains subject to the database's finite capacity. Win/loss and P&amp;L ranges use only exchange-reported futures fill P&amp;L. Spot P&amp;L remains unavailable. Daily and fee tables below are capped at ${ANALYTICS_ROW_LIMIT.toLocaleString('en-US')} grouped rows per response${data.coverage.dailyTruncated || data.coverage.feesTruncated ? ' and this response reached that cap' : ''}.</p>
  <h2>Currently open futures positions</h2><p class="muted">Read-only exchange snapshots from the latest successful journal sync. Symbol, side and origin filters apply; historical-period and realized-P&amp;L filters apply to fills below. An unmatched position stays “unknown”—it is never guessed to be manual.</p><div class="panel"><table><thead><tr><th>Observed (UTC)</th><th>Symbol</th><th>Side</th><th>Position side</th><th>Quantity</th><th>Entry</th><th>Break-even</th><th>Mark</th><th>Unrealized P&amp;L</th><th>Notional</th><th>Leverage</th><th>Liquidation</th><th>Origin / evidence</th></tr></thead><tbody>${currentPositionRows(data)}</tbody></table></div>
  <h2>Filtered origin summary</h2><div class="panel"><table><thead><tr><th>Market</th><th>Origin</th><th>Fills</th><th>Orders</th><th>Symbols</th><th>Buy quote</th><th>Sell quote</th><th>Futures realized P&amp;L</th><th>Last fill</th></tr></thead><tbody>${summaryRows(data)}</tbody></table></div>
  <h2>Filtered daily analytics</h2><div class="panel"><table><thead><tr><th>Day</th><th>Market</th><th>Origin</th><th>Symbol</th><th>Fills</th><th>Orders</th><th>Buy quote</th><th>Sell quote</th><th>Futures realized P&amp;L</th><th>Last fill</th></tr></thead><tbody>${dailyRows(data)}</tbody></table></div>
  <h2>Filtered fills</h2><div class="panel"><table><thead><tr><th>Time (UTC)</th><th>Market</th><th>Symbol</th><th>Side</th><th>Price</th><th>Quantity</th><th>Quote quantity</th><th>Futures realized P&amp;L</th><th>Fee</th><th>Origin</th><th>Evidence</th></tr></thead><tbody>${fillRows(data)}</tbody></table></div>
  <nav class="pagination">${previous}<span>Page ${displayNumber(data.pagination.page,0)} of ${displayNumber(data.pagination.totalPages,0)}</span>${next}</nav>
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
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
      }
    });
  } catch (error) {
    const status = error?.status === 400 ? 400 : 500;
    if (status === 500) console.error('Trade journal request failed:', error.message);
    return privateJson({ error: status === 400 ? error.message : 'trade journal query failed' }, status);
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
