// Rates are dimensionless settlement fractions, never percentages or a live
// predicted rate. A sum is daily carry; a mean is only mean settlement rate.
const DAY = 86400000;
export function foldFundingToDaily(settlements, { nowMs = Date.now() } = {}) {
  const cutoff = Math.floor(nowMs / DAY) * DAY;
  const unique = new Map();
  for (const s of settlements) {
    if (!Number.isFinite(s.time) || s.time < 0 || s.time >= cutoff || !Number.isFinite(s.rate)) continue;
    if (unique.has(s.time) && unique.get(s.time) !== s.rate) throw new Error('Conflicting funding settlement');
    unique.set(s.time, s.rate);
  }
  const days = new Map();
  for (const [time, rate] of [...unique].sort((a, b) => a[0] - b[0])) {
    const date = new Date(time).toISOString().slice(0, 10);
    const row = days.get(date) || { date, funding_sum: 0, settlements: 0, first_time: time };
    row.funding_sum += rate;
    row.settlements++;
    row.last_time = time;
    days.set(date, row);
  }
  // Do not assume three settlements: venues change settlement intervals.
  return [...days.values()].map(r => ({ ...r, funding_rate: r.funding_sum / r.settlements }));
}

export function fundingResumeTime(lastDate, origin = Date.parse('2019-09-01T00:00:00Z'), fromDate = null) {
  if (fromDate != null) {
    const t = Date.parse(`${fromDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !Number.isFinite(t)
      || new Date(t).toISOString().slice(0,10) !== fromDate) throw new Error('Invalid COLLECT_FROM_DATE');
    return Math.max(origin,t);
  }
  // Re-read the watermark day. Older collectors wrote incomplete current days
  // and advanced past them forever; overlap also repairs pagination boundaries.
  return lastDate ? Math.max(origin, Date.parse(`${lastDate}T00:00:00Z`) - DAY) : origin;
}
