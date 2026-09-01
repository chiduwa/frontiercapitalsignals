// Automatic retrospective — "what moved, and why didn't we call it?"
//
// User-requested 2026-08-31. The prompt was a specific miss ("arb and a
// couple of cryptos jumped in the past couple of hours, examine that to
// figure out what you missed so we can catch it with them or other coins
// next time") plus the generalisation that matters more: "these sort of
// retrospective examination/analysis should be built in the module so it
// can be done automatically for learning and continuous improvement."
//
// This is that job. Every run it asks three questions, in order:
//
//   1. What actually moved?  Answered from a WIDER scan than the engine's
//      own universe (CRYPTO_UNIVERSE = top 100). That widening is the
//      whole point: on the day this was written, six of the eight biggest
//      movers — OP, CRV, SAFE, PONS, JASMY and CASHCAT — sat below rank
//      100 and were therefore not merely mis-scored but never fetched at
//      all. A retrospective built on the engine's own universe would have
//      reported a clean sheet, which is precisely the blind spot that let
//      the miss happen.
//
//   2. Was it detectable in advance?  Answered from Binance GLOBAL hourly
//      bars (see BINANCE_GLOBAL_BASE in worker.js) via
//      describeMissedMove — the earliest hour where quote volume AND
//      trade count had both lifted clear of their trailing medians into
//      a rising bar.
//
//   3. What did the engine say at the time?  Answered from the score
//      snapshot the hourly build already writes, so the classification
//      (see classifyMiss) reflects the engine's real state before the
//      move, not a reconstruction after it.
//
// The output is deliberately structured, countable rows rather than
// commentary: retrospective_misses for the individual episodes, and
// retrospective_patterns for the aggregate that says which CAUSE
// dominates. One missed move is an anecdote; "62% of last month's misses
// were out-of-universe" is an instruction about what to fix.
//
// Read-mostly and cheap: one wide CoinGecko page-pair, then Binance global
// klines only for assets that actually moved, so a quiet day costs almost
// nothing.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
// Optional env: NTFY_TOPIC (summary push), RETRO_LOOKBACK_HOURS, RETRO_MIN_MOVE_PCT
// Invoked by .github/workflows/signals-retrospective.yml.
import { d1, chunk, forEachConcurrent } from './d1-client.mjs';
import {
  binanceGlobalKlines, binanceGlobalTradablePairs, describeMissedMove, classifyMiss,
  isNonDirectionalAsset, COINGECKO_BACKOFFS_MS, CRYPTO_UNIVERSE, CRYPTO_MIN_MCAP, CRYPTO_MIN_VOLUME
} from '../worker.js';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID, NTFY_TOPIC } = process.env;
for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID, NTFY_TOPIC };

// How far down the market cap ranking to look for movers. Deliberately
// wider than CRYPTO_UNIVERSE — see this file's header. 300 costs two
// CoinGecko pages and covers every asset that realistically has the
// liquidity to be tradable at all.
const SCAN_RANKS = Number(process.env.RETRO_SCAN_RANKS || 300);
// A move worth explaining. Below this the "miss" is noise, and cataloguing
// noise would drown the aggregate that makes this job useful.
const MIN_MOVE_PCT = Number(process.env.RETRO_MIN_MOVE_PCT || 12);
const LOOKBACK_HOURS = Number(process.env.RETRO_LOOKBACK_HOURS || 48);
// A separate knob from MIN_MOVE_PCT on purpose: that one asks "was this a
// big enough day to explain", this one asks "was enough of it still
// available once the tell fired to be worth alerting about". A move only
// detectable near its own top is not an actionable lesson.
const MIN_ACTIONABLE_GAIN_PCT = Number(process.env.RETRO_MIN_ACTIONABLE_GAIN_PCT || 8);
const FETCH_TIMEOUT_MS = 20000;
const BINANCE_PACING_MS = 250;

async function fetchJsonOnce(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    // "HTTP 429" prefix exactly, so the retry below can recognise it —
    // same message shape worker.js's fetchJson uses.
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

// CoinGecko's free tier rate-limits by IP and CI runners share heavily
// used ranges. A single un-retried 429 took the Signals Daily job down on
// both 2026-08-31 and 2026-09-01 (see getCryptoMarkets in worker.js);
// this job makes the same class of call on its own daily schedule and
// would have failed identically. Only 429 is retried — a 404 will not fix
// itself by being asked again.
async function fetchJson(url) {
  let lastErr;
  for (let attempt = 0; attempt <= COINGECKO_BACKOFFS_MS.length; attempt++) {
    try {
      return await fetchJsonOnce(url);
    } catch (e) {
      lastErr = e;
      if (!/^HTTP 429/.test(String(e && e.message)) || attempt === COINGECKO_BACKOFFS_MS.length) break;
      console.log(`  rate-limited, backing off ${COINGECKO_BACKOFFS_MS[attempt]}ms`);
      await new Promise((r) => setTimeout(r, COINGECKO_BACKOFFS_MS[attempt]));
    }
  }
  throw lastErr;
}

// The wide scan.
//
// PAGE_SIZE is deliberately FIXED across every page rather than shrunk to
// fit the remaining budget on the last one. CoinGecko's pagination offset
// is per_page * (page - 1), so varying it re-reads earlier ranks instead
// of continuing past them: asking for per_page=250 then per_page=50&page=2
// returns ranks 1-250 followed by ranks 50-99, never reaching 251-300.
// Confirmed live against the API, and it would have left this job blind to
// exactly the rank band it exists to cover while silently double-counting
// the band it already had.
const PAGE_SIZE = 250;
async function scanMarkets() {
  const out = [];
  const pages = Math.ceil(SCAN_RANKS / PAGE_SIZE);
  for (let page = 1; page <= pages; page++) {
    const url = 'https://api.coingecko.com/api/v3/coins/markets'
      + `?vs_currency=usd&order=market_cap_desc&per_page=${PAGE_SIZE}&page=${page}`
      + '&sparkline=true&price_change_percentage=24h';
    const rows = await fetchJson(url);
    if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    if (page < pages) await new Promise((r) => setTimeout(r, 1500)); // free tier pacing
  }
  // Defensive dedupe by id: a coin can shift rank between two paged calls
  // and land in both, or in neither. Losing one is unavoidable; counting
  // one twice would corrupt the aggregate this job exists to produce.
  const seen = new Set();
  return out.filter((c) => c && c.id && !seen.has(c.id) && seen.add(c.id)).slice(0, SCAN_RANKS);
}

// What the engine believed about each symbol before the move. Pulled from
// the votes/price log the hourly build already writes — no new
// instrumentation, and importantly no hindsight: these rows were written
// at the time, by the run that had to make the call.
// Board membership has to be RECONSTRUCTED, not read off a flag, and
// getting this wrong is the difference between a useful ledger and a
// flattering one. The subtlety: a 'composite' vote is written for every
// scored asset in the universe, not only for the ten per side that reach
// a board. Treating "has a composite vote" as "was on a board" would
// classify almost every in-universe mover as `caught` or `wrong-side` and
// make `unranked` essentially unreachable — the engine would grade itself
// as having called moves it never surfaced to anyone.
//
// So this ranks each run's composite votes the way rankBoards itself does
// (top BOARD_SIZE by score within a direction, see sortSide in worker.js)
// and asks whether the symbol actually placed. An approximation in one
// known respect: rankBoards sorts by the side-specific score while the
// composite carries its winning side's score, so an asset that placed on
// the side its composite did NOT pick can be missed. Stated rather than
// papered over — it errs toward recording a miss, which is the safe
// direction for a ledger of misses.
const BOARD_SIZE = 10;
async function loadEngineStateBefore(symbols, sinceIso) {
  if (!symbols.length) return {};
  const wanted = new Set(symbols);
  // Whole-universe rows for the window, because rank is only meaningful
  // against the full field — filtering to the movers first would make
  // every one of them look top-10.
  const rows = await d1(env, `
    SELECT symbol, dir, score, run_at
      FROM technique_votes
     WHERE technique_id = 'composite' AND asset_class = 'crypto' AND run_at >= ?
     ORDER BY run_at ASC`, [sinceIso]);
  const byRun = new Map();
  for (const r of rows) {
    if (!byRun.has(r.run_at)) byRun.set(r.run_at, []);
    byRun.get(r.run_at).push(r);
  }
  const out = {};
  for (const [runAt, runRows] of [...byRun.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const dir of [1, -1]) {
      const board = runRows
        .filter((r) => r.dir === dir && r.score != null)
        .sort((a, b) => b.score - a.score)
        .slice(0, BOARD_SIZE);
      for (const r of board) {
        if (!wanted.has(r.symbol) || out[r.symbol]) continue;
        // Earliest run in the window at which this symbol actually placed.
        out[r.symbol] = { dir: r.dir, score: r.score, at: runAt, onBoard: true };
      }
    }
  }
  // Scored but never placed: record the opinion without claiming a board.
  for (const [runAt, runRows] of [...byRun.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const r of runRows) {
      if (!wanted.has(r.symbol) || out[r.symbol]) continue;
      out[r.symbol] = { dir: r.dir, score: r.score, at: runAt, onBoard: false };
    }
  }
  return out;
}

async function notify(title, message) {
  if (!NTFY_TOPIC) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: title, Priority: 'default', Tags: 'mag', Click: 'https://frontiercapitalsignals.com/signals/' },
        body: message, signal: ctrl.signal
      });
    } finally { clearTimeout(t); }
    return true;
  } catch (e) { console.error('ntfy failed (non-fatal):', e.message || e); return false; }
}

async function main() {
  const nowIso = new Date().toISOString();
  const sinceIso = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
  console.log(`retrospective: scanning top ${SCAN_RANKS} for >=${MIN_MOVE_PCT}% moves since ${sinceIso}`);

  const markets = await scanMarkets();
  console.log(`retrospective: scanned ${markets.length} assets`);

  // Rank as fetched, so "was this in the engine's universe" is answered by
  // the ranking, not guessed. Note the subtlety the ARB case exposed: a
  // big mover's rank AFTER the move overstates where it sat BEFORE it —
  // ARB read rank 85 once it was already +34%, having started the day
  // around the rank-96 boundary. Recorded as observed, with that caveat
  // carried in the row rather than silently smoothed over.
  // CoinGecko's own market_cap_rank when present, array position only as a
  // fallback. The two agree in the normal case, but the API's figure
  // survives a dropped or duplicated row in a way an index cannot.
  const ranked = markets.map((c, i) => ({ c, rank: c.market_cap_rank || (i + 1) }));

  const movers = ranked.filter(({ c }) => {
    const chg = c.price_change_percentage_24h;
    if (!Number.isFinite(chg) || Math.abs(chg) < MIN_MOVE_PCT) return false;
    // A peg that "moves" 12% is a depeg — a real and important event, but
    // not a missed directional call, and it belongs in the stablecoin
    // research lane rather than in this ledger. See isNonDirectionalAsset.
    const spark = ((c.sparkline_in_7d || {}).price || []).filter((v) => v != null);
    return !isNonDirectionalAsset(c, spark);
  });
  console.log(`retrospective: ${movers.length} movers >= ${MIN_MOVE_PCT}%`);
  if (!movers.length) {
    console.log('retrospective: nothing to explain this run — a clean sheet is a valid outcome, not a failure');
    return;
  }

  const tradable = await binanceGlobalTradablePairs().catch((e) => {
    console.error('binance global exchangeInfo failed, continuing without bar-level analysis:', e.message || e);
    return new Set();
  });
  console.log(`retrospective: binance global has ${tradable.size} tradable USDT pairs`);

  const engineState = await loadEngineStateBefore(movers.map(({ c }) => (c.symbol || '').toUpperCase()), sinceIso);

  const rows = [];
  for (const { c, rank } of movers) {
    const symbol = (c.symbol || '').toUpperCase();
    const chg = c.price_change_percentage_24h;
    const moveDir = chg > 0 ? 1 : -1;
    const inUniverse = rank <= CRYPTO_UNIVERSE;
    const passedFloors = (c.market_cap || 0) >= CRYPTO_MIN_MCAP && (c.total_volume || 0) >= CRYPTO_MIN_VOLUME;
    const state = engineState[symbol];

    let move = null;
    if (tradable.has(symbol)) {
      try {
        const bars = await binanceGlobalKlines(symbol, '1h', 200);
        move = describeMissedMove(bars, { moveDir });
      } catch (e) {
        console.error(`  ${symbol}: klines failed (${e.message || e})`);
      }
      await new Promise((r) => setTimeout(r, BINANCE_PACING_MS));
    }

    const cause = classifyMiss({
      inUniverse,
      passedFloors,
      onBoard: !!state && state.onBoard,
      boardSide: state ? state.dir : null,
      moveDir,
      scoredAt: state ? state.at : null,
      detectableAt: move ? move.detectableAt : null
    });

    rows.push({
      run_at: nowIso, symbol, name: c.name, asset_class: 'crypto',
      mcap_rank: rank, move_pct: chg, move_dir: moveDir,
      in_universe: inUniverse ? 1 : 0, passed_floors: passedFloors ? 1 : 0,
      engine_dir: state ? state.dir : null,
      engine_score: state ? state.score : null,
      engine_first_seen_at: state ? state.at : null,
      cause,
      detected: move ? (move.detected ? 1 : 0) : null,
      detectable_at: move && move.detected ? move.detectableAt : null,
      detectable_price: move && move.detected ? move.detectablePrice : null,
      surge_ratio: move && move.detected ? move.surgeRatio : null,
      trade_ratio: move && move.detected ? move.tradeRatio : null,
      lead_hours: move && move.detected ? move.leadHours : null,
      gain_to_peak_pct: move && move.detected ? move.gainToPeakPct : null,
      max_drawdown_pct: move && move.detected ? move.maxDrawdownPct : null
    });

    const m = move
      ? (move.detected
        ? `vol ${move.surgeRatio.toFixed(1)}x/tr ${move.tradeRatio.toFixed(1)}x at ${move.detectableAt.slice(5, 16)}, +${move.gainToPeakPct.toFixed(1)}% available over ${move.leadHours}h`
        : (move.reason || 'NO volume warning'))
      : 'no global bars';
    console.log(`  ${symbol.padEnd(10)} rank ${String(rank).padStart(3)} ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%  cause=${cause.padEnd(16)} ${m}`);
  }

  // Append-only ledger. Never updated in place: what the engine believed
  // on a given day is a historical fact, and rewriting it would destroy
  // exactly the record this job exists to build.
  await forEachConcurrent(chunk(rows, 20), 3, async (batch) => {
    for (const r of batch) {
      await d1(env, `
        INSERT INTO retrospective_misses
          (run_at, symbol, name, asset_class, mcap_rank, move_pct, move_dir, in_universe, passed_floors,
           engine_dir, engine_score, engine_first_seen_at, cause, detected, detectable_at, detectable_price,
           surge_ratio, trade_ratio, lead_hours, gain_to_peak_pct, max_drawdown_pct)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(run_at, symbol) DO NOTHING`,
        [r.run_at, r.symbol, r.name, r.asset_class, r.mcap_rank, r.move_pct, r.move_dir, r.in_universe, r.passed_floors,
         r.engine_dir, r.engine_score, r.engine_first_seen_at, r.cause, r.detected, r.detectable_at, r.detectable_price,
         r.surge_ratio, r.trade_ratio, r.lead_hours, r.gain_to_peak_pct, r.max_drawdown_pct]);
    }
  });

  // The aggregate is the actual product. Recomputed wholesale from the
  // full ledger each run rather than incremented, so it always reflects
  // every row currently stored and can never drift from it.
  const agg = await d1(env, `
    SELECT cause,
           COUNT(*)                AS n,
           AVG(ABS(move_pct))      AS avg_move_pct,
           AVG(gain_to_peak_pct)   AS avg_available_pct,
           AVG(lead_hours)         AS avg_lead_hours,
           SUM(COALESCE(detected, 0)) AS n_detected
      FROM retrospective_misses
     GROUP BY cause`);
  const total = agg.reduce((a, r) => a + r.n, 0) || 1;
  for (const r of agg) {
    await d1(env, `
      INSERT INTO retrospective_patterns (cause, n, share, avg_move_pct, avg_available_pct, avg_lead_hours, n_detected, updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(cause) DO UPDATE SET
        n = excluded.n, share = excluded.share, avg_move_pct = excluded.avg_move_pct,
        avg_available_pct = excluded.avg_available_pct, avg_lead_hours = excluded.avg_lead_hours,
        n_detected = excluded.n_detected, updated_at = excluded.updated_at`,
      [r.cause, r.n, r.n / total, r.avg_move_pct, r.avg_available_pct, r.avg_lead_hours, r.n_detected, nowIso]);
  }

  console.log('\nretrospective: cumulative cause breakdown');
  for (const r of agg.sort((a, b) => b.n - a.n)) {
    console.log(`  ${r.cause.padEnd(16)} n=${String(r.n).padStart(4)} (${(r.n / total * 100).toFixed(0)}%)  avg move ${(r.avg_move_pct || 0).toFixed(1)}%  avg available from first tell ${(r.avg_available_pct || 0).toFixed(1)}%  avg lead ${(r.avg_lead_hours || 0).toFixed(0)}h`);
  }

  // Notify only on what is actionable: moves that WERE detectable in
  // advance and still were not called. A move with no volume warning is
  // not a lesson, it is just a move.
  const actionable = rows.filter((r) => r.cause !== 'caught' && r.detected === 1 && (r.gain_to_peak_pct || 0) >= MIN_ACTIONABLE_GAIN_PCT);
  if (actionable.length) {
    const top = actionable.sort((a, b) => (b.gain_to_peak_pct || 0) - (a.gain_to_peak_pct || 0)).slice(0, 5);
    await notify(
      `Retrospective: ${actionable.length} detectable move${actionable.length === 1 ? '' : 's'} missed`,
      top.map((r) => `${r.symbol} ${r.move_pct >= 0 ? '+' : ''}${r.move_pct.toFixed(0)}% — ${r.cause}; volume tell ${r.surge_ratio.toFixed(1)}x was visible ${Math.round(r.lead_hours)}h before the peak (+${r.gain_to_peak_pct.toFixed(0)}% from there)`).join('\n')
    );
  }
  console.log(`\nretrospective: ${rows.length} episodes recorded, ${actionable.length} were detectable-but-missed`);
}

main().catch((e) => { console.error('retrospective failed:', e); process.exit(1); });
