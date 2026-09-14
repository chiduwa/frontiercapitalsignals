// Daily observations are immutable once archived. Never freeze an unfinished
// session as its final close. A UTC-day delay also covers US early closes/DST
// without guessing an exchange holiday calendar.
export function completedDailyBars(bars, nowMs = Date.now()) {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  return bars.filter(b => typeof b.date === 'string' && b.date < today
    && Number.isFinite(b.close) && b.close > 0);
}

export function needsDailyRefresh(coverage, nowMs = Date.now(), needsOpen = false) {
  const yesterday = new Date(nowMs - 86400000).toISOString().slice(0, 10);
  return needsOpen || !coverage || coverage.count < 300 || coverage.maxDate < yesterday
    || new Date(nowMs).getUTCDay() === 0; // weekly deep-history/gap audit
}

// A bounded budget used to buy the OLDEST missing history first, starving the
// latest observations. Fill the current edge first, then deepen the archive.
// Re-offering interior dates repairs gaps safely through the existing upsert.
export function selectArchiveUpdates(bars, coverage, budget, { needsOpen = false, openBars = 1500, nowMs = Date.now() } = {}) {
  const completed = completedDailyBars(bars, nowMs);
  const stored = coverage?.existingDates ? new Set(coverage.existingDates) : null;
  const eligible = needsOpen ? completed.slice(-openBars) : completed.filter(b =>
    stored ? !stored.has(b.date) : !coverage || b.date < coverage.minDate || b.date > coverage.maxDate);
  return eligible.slice().sort((a, b) => {
    const aNew = !coverage || a.date > coverage.maxDate;
    const bNew = !coverage || b.date > coverage.maxDate;
    return Number(bNew) - Number(aNew) || b.date.localeCompare(a.date);
  }).slice(0, Math.max(0, Math.floor(budget)));
}
