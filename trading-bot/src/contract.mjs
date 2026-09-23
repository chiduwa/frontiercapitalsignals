// The bot's binding to the signals engine's PUBLISHED contract
// (confluence-v7). Pure — no I/O, no config — so every gate here is
// testable without a network or a Binance key.
//
// The single most important rule in this file: **which board a row landed
// on is not a trade call.** `crypto.breakout` is a candidate screen that is
// allowed to be noisy; the engine says so itself. Before v7 this bot read
// board membership as direction and `conf.agree/conf.total` as confidence,
// which is exactly the correlated-evidence fallacy the engine's own audit
// removed (signals-worker/QUANT_SIGNAL_DIAGNOSIS.md). Direction now comes
// only from `row.dir`, and only when the engine authorized publishing it.
//
// The payload is already sanitized server-side
// (sanitizePayloadForPublication, worker.js): when a row is not authorized,
// `dir`/`horizon`/`range`/`confidence` are nulled together. So this file
// VERIFIES that invariant rather than re-deriving the engine's statistics.
// If any one of the four is missing, the row is not tradeable — no
// reconstructing a direction from `score`, `rangePos` or a driver list.

// Mirrors the engine's own published bars (worker.js). Duplicated as
// constants rather than imported because this process must not depend on
// the Worker source tree; the assertions in test.mjs pin them, so a drift
// shows up as a failing test instead of a silently laxer bot.
export const ENGINE = {
  minActionableEdge: 0.18,
  minReliabilitySamples: 20,
  minCalibrationSamples: 30,
  minRangeSamples: 30,
  requiredCalibrationSource: 'asset-class-direction-horizon',
  requiredAssetRecordScope: 'asset-direction-horizon'
};

// A class must have demonstrated skill over its OWN measured no-skill
// baseline before any row inside it can be traded. `proven` is the engine's
// verdict (Wilson lower bound on edge > 0 and significant); null means the
// evidence was reset or has not accumulated, which is a cold start, not a
// pass.
export function classAuthorized(classSkill, assetClass) {
  const skill = classSkill && classSkill[assetClass];
  if (!skill) return { ok: false, reason: 'class skill unavailable (cold start or evidence reset)' };
  if (skill.proven !== true) {
    const edge = Number.isFinite(skill.lowerEdge) ? (skill.lowerEdge * 100).toFixed(1) : '?';
    return { ok: false, reason: `asset class has not demonstrated an edge over its own baseline (conservative edge ${edge}pts)` };
  }
  return { ok: true };
}

// Verifies one board row carries a complete, engine-authorized call.
// Returns { ok: true, dir, side, horizonHours, range, confidence } or
// { ok: false, reason } with the engine's own abstention reason when it
// gave one, so the decision log says why the ENGINE withheld rather than
// inventing a bot-side explanation.
export function authorizeRow(row) {
  if (!row || typeof row !== 'object') return { ok: false, reason: 'malformed row' };
  if (row.abstained) {
    const measured = row.abstained.measured;
    const detail = measured && Number.isFinite(measured.accuracy)
      ? ` (measured ${measured.accuracy}% vs baseline ${measured.baseline}%, n=${measured.samples})`
      : '';
    return { ok: false, reason: `engine withheld: ${row.abstained.reason}${detail}` };
  }
  if (row.dir !== 1 && row.dir !== -1) return { ok: false, reason: 'no published direction' };
  // Horizon and range must both be empirical. `basis: 'historical'` is the
  // engine's marker that a matching-horizon record produced them; anything
  // else is a methodology assumption and must not become a trade.
  if (!row.horizon || row.horizon.basis !== 'historical' || !Number.isFinite(row.horizon.days)) {
    return { ok: false, reason: 'no empirical horizon' };
  }
  if (!row.range || row.range.basis !== 'historical'
    || !(Number(row.range.low) > 0) || !(Number(row.range.high) > Number(row.range.low))) {
    return { ok: false, reason: 'no qualified empirical range' };
  }
  const c = row.confidence;
  if (!c) return { ok: false, reason: 'no calibrated confidence' };
  // Pooled calibration is diagnostic only — it is not evidence for this
  // exact class + side + horizon, and must never authorize a position.
  if (c.calibration_source !== ENGINE.requiredCalibrationSource) {
    return { ok: false, reason: `calibration source '${c.calibration_source}' is diagnostic only` };
  }
  if (c.asset_record_scope !== ENGINE.requiredAssetRecordScope) {
    return { ok: false, reason: `asset record scope '${c.asset_record_scope}' is not this asset's own side/horizon record` };
  }
  if (!(Number(c.asset_effective_samples) >= ENGINE.minReliabilitySamples)) {
    return { ok: false, reason: `asset record too thin (${c.asset_effective_samples} independent, needs ${ENGINE.minReliabilitySamples})` };
  }
  if (!(Number(c.calibration_effective_samples) >= ENGINE.minCalibrationSamples)) {
    return { ok: false, reason: `calibration too thin (${c.calibration_effective_samples} independent, needs ${ENGINE.minCalibrationSamples})` };
  }
  if (c.range_calibrated !== true || !(Number(c.range_effective_samples) >= ENGINE.minRangeSamples)) {
    return { ok: false, reason: 'expected-move band is not calibrated for this asset/horizon' };
  }
  // The conservative edge is a Wilson lower bound already, so this reads as:
  // at 95% confidence, at least this much better than guessing in this class.
  // Scaled off the class baseline rather than a flat win rate, because a flat
  // threshold demands wildly different edges in different classes.
  if (!(Number(c.conservative_edge) >= ENGINE.minActionableEdge)) {
    return { ok: false, reason: `conservative edge ${(Number(c.conservative_edge) * 100).toFixed(1)}pts below the ${(ENGINE.minActionableEdge * 100).toFixed(0)}pt bar` };
  }
  return {
    ok: true,
    dir: row.dir,
    side: row.dir === 1 ? 'BUY' : 'SELL',
    horizonHours: row.horizon.days <= 4 ? 24 : 168,
    horizonDays: row.horizon.days,
    range: { low: Number(row.range.low), high: Number(row.range.high) },
    confidence: c
  };
}

// Second authorized source: a research finding that completed the engine's
// full discovery lifecycle. `confirmed` is deliberately the only state that
// may trade — it means family-corrected discovery, then purged walk-forward
// folds, then a POSITIVE after-cost 95% lower bound replicated on data that
// did not exist when the pattern was found. `provisional` has survived
// discovery but nothing post-discovery, and cannot open a position.
export function authorizeResearch(row) {
  if (!row || typeof row !== 'object') return { ok: false, reason: 'malformed research row' };
  if (row.decision !== 'confirmed') {
    return { ok: false, reason: `research lifecycle state '${row.decision}' may not trade (needs 'confirmed')` };
  }
  if (row.side !== 'long' && row.side !== 'short') {
    return { ok: false, reason: `research strategy has no tradeable direction ('${row.side}')` };
  }
  if (row.walkForward !== 'pass') {
    return { ok: false, reason: `walk-forward verdict '${row.walkForward}' is not a pass` };
  }
  // Redundant with `confirmed` by construction, but asserted here because it
  // is the one number that decides whether this is a trade or a curiosity:
  // expectancy AFTER the declared round-trip cost, at its lower bound.
  if (!(Number(row.netLower95Pct) > 0)) {
    return { ok: false, reason: `after-cost 95% lower bound ${row.netLower95Pct} is not positive` };
  }
  if (row.worstTradePct == null || !Number.isFinite(Number(row.worstTradePct))) {
    return { ok: false, reason: 'no measured worst trade to size a stop against' };
  }
  return {
    ok: true,
    side: row.side === 'long' ? 'BUY' : 'SELL',
    horizonDays: Number(row.horizonDays),
    netLower95Pct: Number(row.netLower95Pct),
    worstTradePct: Number(row.worstTradePct),
    maxDrawdownPct: Number(row.maxDrawdownPct),
    trades: Number(row.trades)
  };
}

// Third authorized source (2026-09-24, operator decision): a per-asset model
// that earned its place in the model tournament
// (signals-worker/docs/MODEL_TOURNAMENT.md). It was promoted only on forecasts
// it logged before their outcomes, under a test that stays valid however
// often it is read, and it is demoted the same way; the payload marks a slot
// actionable only while promoted and fresh.
//
// Only 7-day direction slots trade. The tournament publishes about 15.5 hours
// after the close its forecast is dated from: that leaves most of a 1-day
// window already spent, but about 6.3 of 7 days still ahead. The traded
// window is therefore the remainder of the validated one, never more.
export const TOURNAMENT_SOURCE = 'tournament-v1';
export const TOURNAMENT_HORIZONS = [7];
export function authorizeTournament(tournament, symbol, horizon, { minEdge = 0.03, nowMs = Date.now() } = {}) {
  if (!TOURNAMENT_HORIZONS.includes(horizon)) {
    return { ok: false, reason: `the tournament's ${horizon}-day window is mostly spent by the time it publishes` };
  }
  if (!tournament || tournament.status !== 'live') {
    return { ok: false, reason: `model tournament is ${tournament?.status || 'absent'}` };
  }
  const slots = tournament.assets?.[symbol];
  const slot = slots?.[`direction:${horizon}`];
  if (!slot) return { ok: false, reason: `no ${horizon}-day direction slot for ${symbol}` };
  if (slot.promoted !== true || slot.actionable !== true) {
    return { ok: false, reason: `no model promoted on forward evidence for ${symbol} ${horizon}d` };
  }
  const p = Number(slot.forecast?.pUp);
  if (!(p > 0 && p < 1)) return { ok: false, reason: 'the promoted model issued no forecast this run' };
  if (Math.abs(p - 0.5) < minEdge) {
    return { ok: false, reason: `P(up) ${p.toFixed(3)} is within ${minEdge} of even` };
  }
  // The window closes at the END of targetDate's UTC day.
  const end = Date.parse(`${slot.targetDate}T00:00:00Z`) + 86_400_000;
  const hoursLeft = (end - nowMs) / 3_600_000;
  if (!(hoursLeft >= 24)) {
    return { ok: false, reason: `the forecast window ends in ${Number.isFinite(hoursLeft) ? hoursLeft.toFixed(1) : '?'} h` };
  }
  const sigma = Number(slots[`magnitude:${horizon}`]?.forecast?.sigma);
  if (!(sigma > 0)) return { ok: false, reason: 'no move-size forecast to size the stop against' };
  return {
    ok: true, side: p > 0.5 ? 'BUY' : 'SELL', pUp: p, sigma,
    horizonHours: Math.floor(hoursLeft),
    model: slot.incumbent, label: slot.incumbentLabel || slot.incumbent
  };
}

// Measured path shape for this exact asset, side and horizon — the
// holdingEvidence section written by build-signals.mjs. Returns null rather
// than a partial record when the asset has not accumulated enough
// independent matured paths; every consumer must fall back rather than
// assume a shape.
export function holdingFor(holdingEvidence, assetClass, symbol, dir, horizonHours) {
  const rows = holdingEvidence && Array.isArray(holdingEvidence.rows) ? holdingEvidence.rows : [];
  const match = rows.find((r) => r
    && r.assetClass === assetClass && r.symbol === symbol
    && Number(r.dir) === Number(dir) && Number(r.horizonHours) === Number(horizonHours));
  if (!match) return null;
  if (!Number.isFinite(match.mfePct) || !Number.isFinite(match.hoursToPeak)) return null;
  return match;
}

// Day-range position from the measurement-only scalp surface, which replaced
// the retired /api/intraday model. The old bottomed/peaked flags came from
// that dead pipeline; posInDayRange is the same underlying idea (proximity to
// a real session extreme) but it is a measurement the engine still stands
// behind, and it carries no direction claim of its own.
export function dayRangePosition(scalp, symbol) {
  const assets = scalp && Array.isArray(scalp.assets) ? scalp.assets : [];
  const match = assets.find((a) => a && a.symbol === symbol);
  const pos = match && match.range ? Number(match.range.posInDayRange) : null;
  return Number.isFinite(pos) ? pos : null;
}
