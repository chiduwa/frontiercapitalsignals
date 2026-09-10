// Conservative resolver for dry/shadow LIMIT proposals. Hourly OHLC can
// prove that a limit was touched, but cannot prove intrabar ordering or an
// executable fill at a particular venue. The result is therefore used to
// evaluate offset reachability only—not as a trade or P&L observation.
export function assessLimitReachability(row) {
  const startMs = Date.parse(row?.signal_price_at);
  const expiresMs = Date.parse(row?.expires_at);
  const n = Number(row?.observation_count) || 0;
  const low = Number(row?.observed_low);
  const high = Number(row?.observed_high);
  const limit = Number(row?.limit_price);
  const signal = Number(row?.signal_price);
  const firstMs = Date.parse(row?.first_bar_at);
  const lastMs = Date.parse(row?.last_bar_at);
  if (!['BUY', 'SELL'].includes(row?.side) || !(limit > 0) || !(signal > 0)
      || !Number.isFinite(startMs) || !Number.isFinite(expiresMs)
      || expiresMs < startMs || n < 1 || !(low > 0) || !(high > 0)) {
    return { decision: 'awaiting-bars', complete: false, closestDistancePct: null };
  }
  const touched = row.side === 'BUY' ? low <= limit : high >= limit;
  const closestDistancePct = touched ? 0 : row.side === 'BUY'
    ? Math.max(0, (low - limit) / signal * 100)
    : Math.max(0, (limit - high) / signal * 100);
  if (touched) {
    return { decision: 'touched', complete: true, closestDistancePct };
  }
  const expectedBars = Math.max(1, Math.ceil((expiresMs - startMs) / 3_600_000));
  const enoughBars = n >= Math.max(1, Math.ceil(expectedBars * 0.75));
  // Two-hour boundary tolerance allows for bars stamped at their opening
  // instant and delayed daily ingestion, while refusing to call "not touched"
  // from a large hole in the observation window.
  const boundariesCovered = Number.isFinite(firstMs) && Number.isFinite(lastMs)
    && firstMs <= startMs + 2 * 3_600_000
    && lastMs >= expiresMs - 2 * 3_600_000;
  return enoughBars && boundariesCovered
    ? { decision: 'expired', complete: true, closestDistancePct }
    : { decision: 'awaiting-bars', complete: false, closestDistancePct };
}
