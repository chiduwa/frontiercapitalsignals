// Consumes the SAME public JSON this project's own dashboard renders from
// (frontiercapitalsignals.com/signals/api/*) rather than re-implementing any
// scoring logic or reaching into D1 for signals — one source of truth, and
// the bot never needs the engine's own credentials to read a signal.
//
// All gate logic lives in contract.mjs (pure, unit-tested). This file is the
// I/O boundary plus the mapping from payload shapes to candidate objects.
import { config } from './config.mjs';
import { authorizeRow, authorizeResearch, classAuthorized, holdingFor, dayRangePosition } from './contract.mjs';
import { activePolicyCandidate, isActivePolicyCandidate } from './active-limit.mjs';

async function getJson(path) {
  const res = await fetch(`${config.signalsBase}${path}`);
  if (!res.ok) throw new Error(`${path} fetch failed: HTTP ${res.status}`);
  return res.json();
}

export const fetchSignals = () => getJson('/api/signals');

// Replaces fetchIntraday(). /api/intraday is now a deprecation stub: the
// directional intraday model was retired after backtesting at no usable
// edge, and the endpoint returns { deprecated: true } with no watchlist —
// so the old reversal-flag lookup silently resolved to "never" on every
// cycle. /api/scalp is its measurement-only successor.
export const fetchScalp = () => getJson('/api/scalp');

// Binance USDS-M futures are quoted against USDT; the signals engine speaks
// in bare asset symbols (BTC, UNI). Nothing in this bot mapped between them
// before, so any candidate that ever reached execution would have thrown
// `no exchange info for UNI` inside roundQuantity — invisible until now only
// because no candidate has ever cleared the gates. Mapping here, once, and
// the tradability check in index.mjs confirms the market actually exists.
export function toBinanceSymbol(symbol) {
  return `${String(symbol).toUpperCase()}USDT`;
}

// Crypto and stocks become candidates, but execution still requires an exact
// live Binance USDS-M contract plus a close match between the immutable model
// reference and Binance mark. Most equity rows will therefore remain
// diagnostic; no ticker-name coincidence is enough to trade a contract.
//
// `signalSymbol` is kept alongside `symbol` because every lookup back into
// the payload (holding evidence, scalp measurements) is keyed by the
// engine's bare symbol, while every Binance call needs the USDT pair.
export function buildCandidates(signals, scalp) {
  const candidates = [];

  for (const [payloadKey, assetClass] of [['crypto', 'crypto'], ['stocks', 'stock']]) {
    const classGate = classAuthorized(signals.classSkill, assetClass);
    const board = signals[payloadKey] || {};
    const rows = [
      ...(board.breakout || []).map(row => ({ row, screenSide: 'BUY' })),
      ...(board.breakdown || []).map(row => ({ row, screenSide: 'SELL' }))
    ];
    for (const { row, screenSide } of rows) {
      const auth = authorizeRow(row);
      // A row the engine withheld is still surfaced, marked unauthorized, so
      // the decision log says why no trade was allowed.
      const holding = auth.ok
        ? holdingFor(signals.holdingEvidence, assetClass, row.symbol, auth.dir, auth.horizonHours)
        : null;
      const immutableReference = Number(row?.analysis?.reference_price);
      candidates.push(activePolicyCandidate({
        source: 'confluence-v7',
        assetClass,
        signalGeneratedAt: signals.generated_at ?? null,
        signalPriceAt: row?.analysis?.analyzed_at ?? null,
        signalSymbol: row.symbol,
        symbol: toBinanceSymbol(row.symbol),
        // Direction comes from the engine's published call, never from which
        // board the row was screened onto.
        side: auth.ok ? auth.side : (row.dir === -1 ? 'SELL' : row.dir === 1 ? 'BUY' : null),
        screenSide, screenAgree: row.conf?.agree, screenTotal: row.conf?.total,
        dataQuality: row.analysis?.data_quality,
        abstentionReason: row.abstained?.reason ?? null,
        authorized: auth.ok && classGate.ok,
        unauthorizedReason: !classGate.ok ? classGate.reason : (auth.ok ? null : auth.reason),
        price: row.price,
        signalPrice: Number.isFinite(immutableReference) && immutableReference > 0
          ? immutableReference : null,
        rangePos: row.rangePos,
        rangeBounds: row.rangeBounds || null,
        range: auth.ok ? auth.range : null,
        horizonHours: auth.ok ? auth.horizonHours : null,
        confidence: auth.ok ? auth.confidence : null,
        // Conservative edge over this class's own no-skill baseline. This, not
        // a raw win rate, is what sizing scales on — see risk.mjs.
        edge: auth.ok ? Number(auth.confidence.conservative_edge) : 0,
        holding,
        medianAbsDailyMovePct: Number(row?.dailyMoves?.medianAbsPct),
        dailyMoveSamples: Number(row?.dailyMoves?.samples),
        currentMovePct: Number(row?.chg24h),
        dayRangePos: dayRangePosition(scalp, row.symbol),
        funding: row.funding ?? null,
        drivers: row.drivers || []
      }));
    }
  }

  // Second authorized source: strategies that completed the research
  // lifecycle. Deliberately kept separate from the confluence path — their
  // evidence is an event study, not a calibrated per-asset forecast record,
  // so risk.mjs sizes them differently and index.mjs caps them separately.
  const research = signals.quantResearch && Array.isArray(signals.quantResearch.rows)
    ? signals.quantResearch.rows : [];
  for (const row of research) {
    if (row.assetClass !== 'crypto' || !row.symbol) continue;
    const auth = authorizeResearch(row);
    candidates.push({
      source: 'research-confirmed',
      assetClass: row.assetClass,
      signalGeneratedAt: signals.generated_at ?? null,
      signalPriceAt: null,
      signalSymbol: row.symbol,
      symbol: toBinanceSymbol(row.symbol),
      side: auth.ok ? auth.side : (row.side === 'short' ? 'SELL' : row.side === 'long' ? 'BUY' : null),
      authorized: auth.ok,
      unauthorizedReason: auth.ok ? null : auth.reason,
      hypothesis: row.hypothesis,
      family: row.family,
      price: null, // priced from the exchange at execution; research rows carry no reference price
      signalPrice: null,
      rangePos: null,
      rangeBounds: null,
      range: null,
      horizonHours: auth.ok ? Math.max(1, Math.round(auth.horizonDays * 24)) : null,
      confidence: null,
      edge: 0,
      // The measured worst single trade in the confirmed sample is a far
      // better stop than a guessed one — see stopLossPriceForResearch.
      worstTradePct: auth.ok ? auth.worstTradePct : null,
      netLower95Pct: auth.ok ? auth.netLower95Pct : null,
      holding: null,
      dayRangePos: dayRangePosition(scalp, row.symbol),
      funding: 0,
      drivers: auth.ok ? [`confirmed research: ${row.family}`] : []
    });
  }

  // One candidate per symbol. A symbol can sit on more than one board — seen
  // live 2026-09-05, where UNI, ZEC and ASTER each produced two identical
  // candidates and were evaluated twice. Harmless while everything is
  // withheld, but once calls are authorized a duplicate would be sized and
  // counted against exposure twice.
  //
  // Where two rows for the same symbol disagree on the published direction,
  // NEITHER trades: a screen that says both long and short about one asset at
  // one moment is not evidence for a side, it is a contradiction.
  return dedupeBySymbol(candidates);
}

export function dedupeBySymbol(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    if (!groups.has(candidate.symbol)) groups.set(candidate.symbol, []);
    groups.get(candidate.symbol).push(candidate);
  }

  const out = [];
  for (const rows of groups.values()) {
    const modelRows = rows.filter((r) => r.authorized);
    const policyRows = rows.filter(isActivePolicyCandidate);
    const authorized = modelRows.length ? modelRows : policyRows;
    const sides = new Set(authorized.map((r) => r.side));
    if (sides.size > 1) {
      out.push({
        ...authorized[0], authorized: false, source: 'conflict', executionPolicy: null,
        unauthorizedReason: `contradictory authorized directions across sources for this symbol (${[...sides].join(' and ')}) — abstaining`
      });
      continue;
    }
    // At most one decision may reach sizing/execution for an instrument. When
    // sources agree, prefer an authorized row; the existing source ordering
    // (confluence before research) remains the tie-breaker and does not change
    // valid signal frequency.
    out.push(authorized[0] || rows[0]);
  }
  return out;
}

export function getFearGreed(signals) {
  return signals.overview?.fear_greed?.value ?? null;
}
