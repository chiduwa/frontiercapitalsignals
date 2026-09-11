// An explicit, uncalibrated trading rule. Technique agreement is a setup
// filter, not a win probability; these policy exits do not predict extrema.
import { config } from './config.mjs';
import { baselineExitPolicy, roiExitGeometry } from './trade-policy.mjs';

export const ACTIVE_LIMIT_SOURCE = 'active-limit-v1';

export function activePolicyCandidate(candidate) {
  if (candidate.authorized
      || candidate.source !== 'confluence-v7'
      || candidate.dataQuality !== 'model-ready'
      || !['BUY', 'SELL'].includes(candidate.screenSide)
      || candidate.abstentionReason === 'no-edge') return candidate;
  const { screenAgree: agree, screenTotal: total } = candidate;
  if (!Number.isInteger(agree) || !Number.isInteger(total)
      || agree < 3 || total < agree || !(total > 0)
      || agree / total < config.activeLimitAgreementFloor
      || !(candidate.dailyMoveSamples >= config.entryOffsetDailyMoveMinSamples)
      || !(candidate.medianAbsDailyMovePct > 0)) return candidate;
  const policy = baselineExitPolicy({ ...candidate, authorized: false }, 5);
  policy.maxHoldHours = config.activeLimitHoldHours;
  policy.holdHours = policy.maxHoldHours;
  if (!activeExitGeometry(candidate.screenSide, candidate.signalPrice, policy)) return candidate;
  return {
    ...candidate, source: ACTIVE_LIMIT_SOURCE, side: candidate.screenSide,
    executionPolicy: ACTIVE_LIMIT_SOURCE, activePolicy: policy,
    // Authorization, confidence and forecast fields retain their meaning.
    authorized: false, confidence: null, edge: null, holding: null,
    range: null, horizonHours: null,
    hypothesis: 'directional screen agreement plus discounted/premium LIMIT; unvalidated after costs'
  };
}

export function activeExecutionEligible(candidate) {
  return config.activeLimitMode && isActivePolicyCandidate(candidate);
}

export function isActivePolicyCandidate(candidate) {
  return candidate?.source === ACTIVE_LIMIT_SOURCE
    && candidate?.executionPolicy === ACTIVE_LIMIT_SOURCE
    && activeExitGeometry(candidate.side, candidate.signalPrice, candidate.activePolicy) != null;
}

export function activeExitGeometry(side, entryPrice, policy) {
  if (policy?.version === 'margin-roi-v1') return roiExitGeometry(side, entryPrice, policy);
  if (!['BUY', 'SELL'].includes(side) || !Number.isFinite(entryPrice) || entryPrice <= 0
      || policy?.version !== 1
      || !Number.isFinite(policy.stopPct) || !(policy.stopPct > 0 && policy.stopPct < 100)
      || !Number.isFinite(policy.targetPct) || !(policy.targetPct > 0 && policy.targetPct < 100)
      || !Number.isFinite(policy.holdHours) || !(policy.holdHours > 0 && policy.holdHours <= 24)) return null;
  const sign = side === 'BUY' ? 1 : -1;
  return {
    stop: entryPrice * (1 - sign * policy.stopPct / 100),
    target: entryPrice * (1 + sign * policy.targetPct / 100),
    timeExit: policy.holdHours * 3_600_000
  };
}
