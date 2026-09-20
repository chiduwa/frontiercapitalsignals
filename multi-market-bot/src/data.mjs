import { readFile, stat } from 'node:fs/promises';
import { MARKETS, validateSeries } from './strategies.mjs';

export async function readDataset(path) {
  if (!path || (await stat(path)).size > 32 * 1024 * 1024) throw new Error('Supply a JSON dataset of at most 32 MiB');
  return JSON.parse(await readFile(path, 'utf8'));
}

const ny = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function session(at) {
  const p = Object.fromEntries(ny.formatToParts(at).map(p => [p.type, p.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}
function validOhlcv(b) {
  return ['open', 'high', 'low', 'close', 'volume'].every(k => Number.isFinite(b[k]))
    && b.low > 0 && b.low <= Math.min(b.open, b.close)
    && b.high >= Math.max(b.open, b.close) && b.volume >= 0;
}

// Whole regular sessions only. Reject shortened, partial, or incomplete days;
// never stretch a three-hour fragment across a missing observation.
export function normalizeYahoo(symbol, payload, asOf) {
  const r = payload?.chart?.result?.[0], spec = MARKETS[symbol];
  const ticker = symbol === 'BTC/USD' ? 'BTC-USD' : symbol;
  if (!spec || !r || r.meta?.symbol !== ticker || !Array.isArray(r.timestamp)
      || !r.indicators?.quote?.[0]) throw new Error(`Wrong or missing Yahoo instrument: ${symbol}`);
  const interval = spec.timeframe === '15m' ? 900_000 : 3_600_000;
  if (r.meta.dataGranularity !== (interval === 900_000 ? '15m' : '1h')) throw new Error('Provider changed interval');
  const q = r.indicators.quote[0];
  let rejectedBars = 0, omittedSessions = 0, discardedPrefixBars = 0;
  const raw = r.timestamp.map((t, i) => ({ at: t * 1000, end: t * 1000 + interval,
    open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close?.[i], volume: q.volume?.[i] }));
  if (new Set(raw.map(b => b.at)).size !== raw.length || raw.some((b, i) => i && b.at <= raw[i - 1].at)) throw new Error('Duplicate or unordered provider timestamps');
  let bars;
  if (symbol === 'BTC/USD') {
    bars = raw.filter(b => { const keep = b.end <= asOf && validOhlcv(b); if (!keep) rejectedBars++; return keep; });
  } else {
    if (r.meta.exchangeTimezoneName !== 'America/New_York') throw new Error('Unexpected equity timezone');
    const days = new Map();
    for (const b of raw) {
      const s = session(b.at);
      if (s.minute < 570 || s.minute >= 960) { rejectedBars++; continue; }
      if (!days.has(s.day)) days.set(s.day, []);
      days.get(s.day).push({ ...b, minute: s.minute });
    }
    bars = [];
    const count = interval === 900_000 ? 26 : 7;
    for (const entries of days.values()) {
      const sessionEnd = entries[0].at + (960 - entries[0].minute) * 60_000;
      if (entries.length !== count || sessionEnd > asOf
          || entries.some((b, i) => b.minute !== 570 + i * interval / 60_000 || !validOhlcv(b))) {
        omittedSessions++;
        // End evaluation coverage at a completed but unusable session, then
        // start a fresh history. No position is replayed across this known gap.
        if (sessionEnd <= asOf) { discardedPrefixBars += bars.length; bars = []; }
        continue;
      }
      if (count === 26) bars.push(...entries.map(({ minute, ...b }) => b));
      else for (const group of [entries.slice(0, 4), entries.slice(4)]) {
        bars.push({ at: group[0].at, end: Math.min(group.at(-1).end, sessionEnd),
          open: group[0].open, high: Math.max(...group.map(b => b.high)),
          low: Math.min(...group.map(b => b.low)), close: group.at(-1).close,
          volume: group.reduce((sum, b) => sum + b.volume, 0) });
      }
    }
  }
  const series = { symbol, timeframe: spec.timeframe, source: `Yahoo chart ${ticker}; research price proxy`, bars,
    dataQuality: { receivedBars: raw.length, rejectedBars, omittedSessions, discardedPrefixBars,
      coverageRule: 'Latest usable history after a known completed-session gap; selected without inspecting returns',
      exchangeCalendarVerified: false,
      sessionConvention: symbol === 'BTC/USD' ? 'UTC hourly, continuous' : countDescription(spec),
      executableQuotes: false, volumeVenueVerified: false } };
  validateSeries(series, asOf);
  return series;
}
const countDescription = spec => spec.timeframe === '15m'
  ? 'Complete 26-bar regular sessions only; shortened/incomplete days excluded'
  : 'Complete regular sessions: 09:30-13:30 and 13:30-16:00 New York; final bar is 2.5h; shortened/incomplete days excluded';

export async function collectMarkets(asOf = Date.now()) {
  const series = [];
  for (const [symbol, spec] of Object.entries(MARKETS)) {
    if (symbol === 'BTC/USD') { series.push(await collectCoinbase(asOf)); continue; }
    const ticker = symbol === 'BTC/USD' ? 'BTC-USD' : symbol;
    const days = spec.timeframe === '15m' ? 59 : 700;
    const interval = spec.timeframe === '15m' ? '15m' : '1h';
    const end = Math.floor(asOf / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${end - days * 86400}&period2=${end}&interval=${interval}&includePrePost=false`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(25_000) });
    if (!res.ok) throw new Error(`${symbol}: Yahoo HTTP ${res.status}`);
    const body = await res.text();
    if (body.length > 16 * 1024 * 1024) throw new Error('Provider response exceeds budget');
    const normalized = normalizeYahoo(symbol, JSON.parse(body), asOf);
    normalized.requestUrl = url;
    series.push(normalized);
  }
  return { version: 1, asOf, collectedAt: new Date().toISOString(), series };
}

async function collectCoinbase(asOf) {
  const end = Math.floor(asOf / 3_600_000) * 3_600_000;
  const start = end - 180 * 86_400_000;
  const bars = [], requestUrls = [];
  for (let at = start; at < end; at += 299 * 3_600_000) {
    const until = Math.min(end, at + 299 * 3_600_000);
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600&start=${new Date(at).toISOString()}&end=${new Date(until).toISOString()}`;
    requestUrls.push(url);
    const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
    if (!res.ok) throw new Error(`Coinbase HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length > 300) throw new Error('Unexpected Coinbase response');
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 6 || !row.every(Number.isFinite)) throw new Error('Malformed Coinbase candle');
      const [time, low, high, open, close, volume] = row;
      const stamp = time * 1000;
      if (stamp >= at && stamp < until) bars.push({ at: stamp, end: stamp + 3_600_000, low, high, open, close, volume });
    }
  }
  bars.sort((a, b) => a.at - b.at);
  const gaps = [];
  let latestStart = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].at <= bars[i - 1].at) throw new Error('Duplicate Coinbase candle');
    if (bars[i].at !== bars[i - 1].end) {
      gaps.push({ start: bars[i - 1].end, end: bars[i].at }); latestStart = i;
    }
  }
  const series = { symbol: 'BTC/USD', timeframe: '1h', source: 'Coinbase Exchange BTC-USD hourly OHLCV; proxy for Alpaca execution',
    requestUrls, bars: bars.slice(latestStart), dataQuality: { executableQuotes: false, volumeVenueVerified: true,
      volumeVenue: 'Coinbase Exchange, not Alpaca', omittedSessions: 0, rejectedBars: 0,
      requestedStart: start, requestedEnd: end, gaps, discardedPrefixBars: latestStart,
      coverageRule: 'Latest continuous segment only; data-availability selection, without inspecting returns' } };
  validateSeries(series, asOf);
  if (series.bars.at(-1).end !== end) throw new Error('Missing latest completed Coinbase candle');
  return series;
}
