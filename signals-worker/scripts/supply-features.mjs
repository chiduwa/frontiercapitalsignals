// Supply and dilution features over asset_supply_daily / asset_supply_snapshot
// (migration 0035). Pure functions, no I/O.
//
// The question these exist to answer: "more supply will be released soon" —
// is pending or realized dilution priced in, and does it predict forward
// returns? No price, volume or open-interest feature can see it.
//
// Two different kinds of number, deliberately kept apart because they support
// different comparisons:
//
//   realized dilution   How much circulating supply ACTUALLY grew, from
//                       asset_supply_daily. A true time series, so it can be
//                       compared to an asset's own past AND across assets.
//   pending overhang    (total - circulating) / circulating, from the
//                       snapshot. CoinGecko publishes no history for total
//                       supply, so this is a point-in-time reading. Usable
//                       CROSS-SECTIONALLY (is MON more dilutive than BTC
//                       today, 751% vs ~0%) but NOT as a time series, and the
//                       research harness must not difference it.
//
// Derivation noise: circulating supply is market_cap / price, both rounded by
// the supplier. Differences over a single day are mostly that rounding, which
// is why the shortest window here is 30 days.

export const SUPPLY_MIN_WINDOW_DAYS = 30;
export const SUPPLY_DATE_TOLERANCE_DAYS = 3;

const iso = (t) => new Date(t * 86400000).toISOString().slice(0, 10);
const dayNum = (d) => Date.parse(`${d}T00:00:00Z`) / 86400000;

export function lookbackSupply(series, date, days, tolerance = SUPPLY_DATE_TOLERANCE_DAYS) {
  const target = dayNum(date) - days;
  for (let k = 0; k <= tolerance; k++) {
    for (const sign of (k === 0 ? [0] : [-1, 1])) {
      const v = series.get(iso(target + sign * k));
      if (v > 0) return v;
    }
  }
  return null;
}

// Percent growth in circulating supply over `days`. Positive means dilution.
export function supplyGrowth(series, date, days) {
  const now = series.get(date);
  const then = lookbackSupply(series, date, days);
  if (!(now > 0) || !(then > 0)) return null;
  return ((now / then) - 1) * 100;
}

// `rows` is one symbol's asset_supply_daily rows, date-ascending.
// `snapshot` is its asset_supply_snapshot row (or null).
export function assetSupplyFeatures(rows, snapshot) {
  const series = new Map(rows.map((r) => [r.date, r.circulating_supply]));
  // Point-in-time, so it is the SAME value on every row. Stamped onto each
  // date only so the cross-sectional harness can read it per period; it must
  // never be differenced.
  const overhang = (snapshot && snapshot.total_supply > 0 && snapshot.circulating_supply > 0)
    ? ((snapshot.total_supply - snapshot.circulating_supply) / snapshot.circulating_supply) * 100 : null;
  const pctOfMax = (snapshot && snapshot.max_supply > 0 && snapshot.circulating_supply > 0)
    ? (snapshot.circulating_supply / snapshot.max_supply) * 100 : null;

  return rows.map((r) => {
    const g30 = supplyGrowth(series, r.date, 30);
    const g90 = supplyGrowth(series, r.date, 90);
    const g180 = supplyGrowth(series, r.date, 180);
    return {
      symbol: r.symbol, date: r.date,
      supply_growth_30d: g30,
      supply_growth_90d: g90,
      supply_growth_180d: g180,
      // Is dilution speeding up or slowing down? A 90-day rate annualises to
      // 4x the 30-day one when constant, so the comparison is rate-vs-rate.
      supply_accel: (g30 != null && g90 != null) ? g30 - (g90 / 3) : null,
      supply_overhang: overhang,
      supply_pct_of_max: pctOfMax,
      circulating_supply: r.circulating_supply
    };
  });
}

export const SUPPLY_FEATURE_FAMILY = [
  'supply_growth_30d', 'supply_growth_90d', 'supply_growth_180d',
  'supply_accel', 'supply_overhang', 'supply_pct_of_max'
];

// Features that are point-in-time snapshots rather than true series. The
// research harness uses this to refuse any test that would difference them.
export const SUPPLY_SNAPSHOT_FEATURES = new Set(['supply_overhang', 'supply_pct_of_max']);
