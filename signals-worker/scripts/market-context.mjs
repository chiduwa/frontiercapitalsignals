// Conservative market-cycle context archive.
//
// This module records a small, non-redundant subset of the cycle concepts the
// user supplied: MVRV (on-chain valuation), Mayer Multiple (a transparent
// price/200DMA control), altcoin-season breadth, and BTC dominance. None of
// them is granted a live vote here. They are immutable, point-in-time inputs
// for discovery.mjs, where multiple-testing, walk-forward, after-cost, and
// post-discovery gates decide whether a pattern exists at all.

import { createHash } from 'node:crypto';
import { d1 } from './d1-client.mjs';

const FETCH_TIMEOUT_MS = 15000;
const COINMETRICS_URL = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics';
const CMC_ALTSEASON_URL = 'https://pro-api.coinmarketcap.com/public-api/v1/altcoin-season-index/latest';
export const MARKET_CONTEXT_METHOD_VERSION = 'fcs-market-context-v1';

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'FrontierCapitalSignals/1.0 market-context-research' },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function finite(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function upperBound(sorted, value) {
  let low = 0, high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function lowerBound(sorted, value) {
  let low = 0, high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

// Percentiles are causal: the value for date t is ranked only against values
// dated before t. This is intentionally different from colouring an entire
// chart using percentiles calculated with its eventual future history.
export function attachCausalPercentiles(rows, priorValues = []) {
  const sortedPrior = priorValues.map(finite).filter((value) => value != null).sort((a, b) => a - b);
  return rows.slice().sort((a, b) => a.context_date.localeCompare(b.context_date)).map((row) => {
    const value = finite(row.value);
    const trainingN = sortedPrior.length;
    // Mid-rank ties. An upper-bound rank turns a constant series into a false
    // 100th-percentile extreme; its honest rank is the middle of the tie block.
    const percentile = value == null || trainingN === 0
      ? null
      : (lowerBound(sortedPrior, value) + upperBound(sortedPrior, value)) / (2 * trainingN);
    if (value != null) sortedPrior.splice(upperBound(sortedPrior, value), 0, value);
    return { ...row, training_percentile: percentile, training_n: trainingN };
  });
}

export function computeMayerSeries(bars, ingestedAt) {
  const currentUtcDate = ingestedAt.slice(0, 10);
  const sorted = (bars || [])
    // The archive fetches through "now". Today's candle is still forming and
    // must not be frozen as a completed daily close.
    .filter((bar) => bar && bar.date && bar.date < currentUtcDate && finite(bar.close) > 0)
    .map((bar) => ({ date: bar.date, close: Number(bar.close) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const output = [];
  let rolling = 0;
  for (let index = 0; index < sorted.length; index++) {
    rolling += sorted[index].close;
    if (index >= 200) rolling -= sorted[index - 200].close;
    if (index < 199) continue;
    const average = rolling / 200;
    const raw = { date: sorted[index].date, close: sorted[index].close, sma200: average };
    output.push({
      metric: 'btc_mayer_multiple',
      context_date: sorted[index].date,
      value: sorted[index].close / average,
      // A daily candle is treated as final at the next UTC boundary. known_at
      // below remains the stricter first-availability timestamp for backfills.
      source_timestamp: `${nextUtcDate(sorted[index].date)}T00:00:00.000Z`,
      known_at: ingestedAt,
      ingested_at: ingestedAt,
      provider: 'fcs-asset-daily-bars',
      method_version: MARKET_CONTEXT_METHOD_VERSION,
      raw_hash: stableHash(raw)
    });
  }
  return attachCausalPercentiles(output);
}

export function coinMetricsMvrvRows(payload, ingestedAt, priorValues = []) {
  const rows = [];
  for (const point of (payload && payload.data) || []) {
    const value = finite(point.CapMVRVCur);
    if (!point.time || value == null || value <= 0) continue;
    rows.push({
      metric: 'btc_mvrv',
      context_date: point.time.slice(0, 10),
      value,
      source_timestamp: point.time,
      // Historical values fetched for the first time today are known today,
      // not backdated. They may discover a provisional pattern but only later
      // prospectively archived observations can confirm it.
      known_at: ingestedAt,
      ingested_at: ingestedAt,
      provider: 'coinmetrics-community',
      method_version: MARKET_CONTEXT_METHOD_VERSION,
      raw_hash: stableHash(point)
    });
  }
  return attachCausalPercentiles(rows, priorValues);
}

export function currentContextRow(metric, value, sourceTimestamp, provider, ingestedAt, raw, priorValues = []) {
  const number = finite(value);
  if (number == null || !sourceTimestamp) return null;
  return attachCausalPercentiles([{
    metric,
    context_date: sourceTimestamp.slice(0, 10),
    value: number,
    source_timestamp: sourceTimestamp,
    known_at: ingestedAt,
    ingested_at: ingestedAt,
    provider,
    method_version: MARKET_CONTEXT_METHOD_VERSION,
    raw_hash: stableHash(raw)
  }], priorValues)[0];
}

async function existingContext(env) {
  const rows = await d1(env, `
    SELECT metric, context_date, value, provider, method_version
    FROM market_context_daily
    ORDER BY metric, context_date
  `);
  const out = {};
  for (const row of rows) {
    const key = `${row.metric}|${row.provider}|${row.method_version}`;
    const bucket = (out[key] ??= { maxDate: null, values: [] });
    bucket.maxDate = row.context_date;
    bucket.values.push(Number(row.value));
  }
  return out;
}

// JSON1 turns hundreds of rows into one bound parameter instead of consuming
// D1's bound-parameter limit nine columns at a time.
export async function insertMarketContextRows(env, rows, chunkSize = 300) {
  let attempted = 0;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const batch = rows.slice(index, index + chunkSize);
    await d1(env, `
      INSERT INTO market_context_daily
        (metric, context_date, value, source_timestamp, known_at, ingested_at,
         provider, method_version, raw_hash, training_percentile, training_n)
      SELECT
        json_extract(value, '$.metric'),
        json_extract(value, '$.context_date'),
        json_extract(value, '$.value'),
        json_extract(value, '$.source_timestamp'),
        json_extract(value, '$.known_at'),
        json_extract(value, '$.ingested_at'),
        json_extract(value, '$.provider'),
        json_extract(value, '$.method_version'),
        json_extract(value, '$.raw_hash'),
        json_extract(value, '$.training_percentile'),
        json_extract(value, '$.training_n')
      FROM json_each(?)
      WHERE 1
      ON CONFLICT(metric, provider, method_version, context_date) DO NOTHING
    `, [JSON.stringify(batch)]);
    attempted += batch.length;
  }
  return attempted;
}

async function fetchMvrv(startDate) {
  const query = new URLSearchParams({
    assets: 'btc', metrics: 'CapMVRVCur', frequency: '1d',
    start_time: startDate || '2010-01-01', page_size: '10000'
  });
  return fetchJson(`${COINMETRICS_URL}?${query}`);
}

function nextUtcDate(date) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

async function fetchAltcoinSeason() {
  const payload = await fetchJson(CMC_ALTSEASON_URL);
  const data = payload && payload.data;
  if (!data || finite(data.altcoin_index) == null || !data.snapshot_time) throw new Error('unexpected response shape');
  return { value: Number(data.altcoin_index), sourceTimestamp: data.snapshot_time, raw: data };
}

// Refreshes each leg independently. One unavailable provider never invents a
// substitute and never blocks the other context measurements.
export async function refreshMarketContext(env, { btcDominance = null, dominanceTimestamp = null } = {}) {
  const ingestedAt = new Date().toISOString();
  const existing = await existingContext(env);
  const rows = [];
  const status = {};

  try {
    const seriesKey = `btc_mvrv|coinmetrics-community|${MARKET_CONTEXT_METHOD_VERSION}`;
    const prior = existing[seriesKey] ? existing[seriesKey].values : [];
    const start = existing[seriesKey] && existing[seriesKey].maxDate ? nextUtcDate(existing[seriesKey].maxDate) : '2010-01-01';
    const payload = await fetchMvrv(start);
    const parsed = coinMetricsMvrvRows(payload, ingestedAt, prior)
      .filter((row) => !existing[seriesKey] || row.context_date > existing[seriesKey].maxDate);
    rows.push(...parsed);
    status.btc_mvrv = { ok: true, rows: parsed.length };
  } catch (error) {
    status.btc_mvrv = { ok: false, error: error.message };
  }

  try {
    const bars = await d1(env, `
      SELECT date, close FROM asset_daily_bars
      WHERE asset_class = 'crypto' AND symbol = 'BTC'
      ORDER BY date
    `);
    const seriesKey = `btc_mayer_multiple|fcs-asset-daily-bars|${MARKET_CONTEXT_METHOD_VERSION}`;
    const computed = computeMayerSeries(bars, ingestedAt)
      .filter((row) => !existing[seriesKey] || row.context_date > existing[seriesKey].maxDate);
    rows.push(...computed);
    status.btc_mayer_multiple = { ok: true, rows: computed.length };
  } catch (error) {
    status.btc_mayer_multiple = { ok: false, error: error.message };
  }

  try {
    const alt = await fetchAltcoinSeason();
    const row = currentContextRow(
      'altcoin_season_index', alt.value, alt.sourceTimestamp,
      'coinmarketcap-keyless', ingestedAt, alt.raw,
      existing[`altcoin_season_index|coinmarketcap-keyless|${MARKET_CONTEXT_METHOD_VERSION}`]
        ? existing[`altcoin_season_index|coinmarketcap-keyless|${MARKET_CONTEXT_METHOD_VERSION}`].values : []
    );
    const seriesKey = `altcoin_season_index|coinmarketcap-keyless|${MARKET_CONTEXT_METHOD_VERSION}`;
    if (row && (!existing[seriesKey] || row.context_date > existing[seriesKey].maxDate)) rows.push(row);
    status.altcoin_season_index = { ok: true, rows: row ? 1 : 0 };
  } catch (error) {
    status.altcoin_season_index = { ok: false, error: error.message };
  }

  const dominanceAt = dominanceTimestamp || ingestedAt;
  const dominanceRow = currentContextRow(
    'btc_dominance_pct', btcDominance, dominanceAt,
    'coingecko-global', ingestedAt, { btcDominance, dominanceTimestamp: dominanceAt },
    existing[`btc_dominance_pct|coingecko-global|${MARKET_CONTEXT_METHOD_VERSION}`]
      ? existing[`btc_dominance_pct|coingecko-global|${MARKET_CONTEXT_METHOD_VERSION}`].values : []
  );
  const dominanceSeriesKey = `btc_dominance_pct|coingecko-global|${MARKET_CONTEXT_METHOD_VERSION}`;
  if (dominanceRow && (!existing[dominanceSeriesKey] || dominanceRow.context_date > existing[dominanceSeriesKey].maxDate)) {
    rows.push(dominanceRow);
    status.btc_dominance_pct = { ok: true, rows: 1 };
  } else {
    status.btc_dominance_pct = { ok: dominanceRow != null, rows: 0, ...(dominanceRow ? {} : { error: 'missing value' }) };
  }

  const attempted = rows.length ? await insertMarketContextRows(env, rows) : 0;
  return { attempted, status };
}

export async function loadLatestMarketContext(env, nowIso = new Date().toISOString()) {
  const today = nowIso.slice(0, 10);
  const rows = await d1(env, `
    SELECT c.* FROM market_context_daily c
    JOIN (
      SELECT metric, provider, method_version, MAX(context_date) AS context_date
      FROM market_context_daily
      WHERE method_version = ? AND known_at <= ? AND source_timestamp <= ? AND context_date <= ?
      GROUP BY metric, provider, method_version
    ) latest ON latest.metric = c.metric AND latest.provider = c.provider
      AND latest.method_version = c.method_version AND latest.context_date = c.context_date
    WHERE c.method_version = ? AND c.known_at <= ? AND c.source_timestamp <= ? AND c.context_date <= ?
    ORDER BY c.metric
  `, [MARKET_CONTEXT_METHOD_VERSION, nowIso, nowIso, today, MARKET_CONTEXT_METHOD_VERSION, nowIso, nowIso, today]);
  const metrics = {};
  const now = new Date(nowIso).getTime();
  for (const row of rows) {
    const sourceMs = new Date(row.source_timestamp).getTime();
    const ageHours = Number.isFinite(sourceMs) && sourceMs <= now ? (now - sourceMs) / 3600000 : null;
    const freshnessHours = row.metric === 'altcoin_season_index' || row.metric === 'btc_dominance_pct' ? 48 : 72;
    metrics[row.metric] = {
      value: Number(row.value), date: row.context_date,
      sourceTimestamp: row.source_timestamp, knownAt: row.known_at,
      provider: row.provider, methodVersion: row.method_version,
      percentile: row.training_percentile == null ? null : Number(row.training_percentile),
      trainingN: Number(row.training_n || 0), ageHours,
      fresh: ageHours != null && ageHours <= freshnessHours
    };
  }
  return {
    status: 'shadow-research-only',
    liveVote: false,
    note: 'Market-cycle context is archived and tested prospectively; it does not alter a signal until independent after-cost evidence confirms it.',
    metrics
  };
}
