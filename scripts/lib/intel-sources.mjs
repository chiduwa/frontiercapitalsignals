// Source selection for the daily intelligence run, kept free of network and
// model calls so scripts/tests/intel-sources.test.mjs can exercise it.

export const FOCUS_COUNTRIES = ["Ghana", "Nigeria", "Kenya", "Malawi", "Uganda"];

// The run used to work through the feeds in list order, five items each, until
// the Gemini quota ran out. With Ghana's two feeds dead and no Kenyan or Ugandan
// feed at all, Malawi's two feeds wrote 45-50% of every month's briefs and
// Ghana 1-4% (July-October 2026). Candidates are now taken one country at a
// time in turn, so the quota is shared, and no country passes its daily cap.
export function interleaveByCountry(candidates, { order = [...FOCUS_COUNTRIES, "Africa"], cap = Infinity, alreadyToday = {} } = {}) {
  const queues = new Map(order.map((c) => [c, []]));
  for (const c of candidates) {
    if (!queues.has(c.country)) queues.set(c.country, []);
    queues.get(c.country).push(c);
  }
  // Within a country, alternate between its feeds so one prolific feed cannot
  // fill the country's whole allowance.
  for (const [country, list] of queues) queues.set(country, alternateBySource(list));

  const taken = new Map([...queues.keys()].map((c) => [c, alreadyToday[c] ?? 0]));
  const out = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [country, list] of queues) {
      if (!list.length || taken.get(country) >= cap) continue;
      out.push(list.shift());
      taken.set(country, taken.get(country) + 1);
      progressed = true;
    }
  }
  return out;
}

function alternateBySource(list) {
  const bySource = new Map();
  for (const c of list) {
    const key = c.sourceName ?? "";
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(c);
  }
  const lanes = [...bySource.values()];
  const out = [];
  for (let i = 0; lanes.some((l) => i < l.length); i++) for (const l of lanes) if (i < l.length) out.push(l[i]);
  return out;
}

// Focus countries left with no working feed this run. A dead feed used to be
// one log line, which is how Ghana went without a source for months.
export function countriesWithoutFeed(feedResults, focus = FOCUS_COUNTRIES) {
  const working = new Set(feedResults.filter((r) => !r.error && r.itemCount > 0).map((r) => r.country));
  return focus.filter((c) => !working.has(c));
}
