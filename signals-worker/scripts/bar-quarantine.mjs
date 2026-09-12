// Detection and bookkeeping for corrupt rows in asset_daily_bars.
//
// The archive genuinely contains them, and they are not rare enough to ignore:
// 37 single-step moves above 300% in the crypto universe alone. The worst are
// unambiguous breakage rather than price — TIA printing 0.0105 -> 7149.42 in
// one day. They were found by the derivatives cost model, which held a broken
// name at full portfolio weight and booked a -4103%/period "return".
//
// Why every regression missed them: winsorise() clips the tails of each
// cross-section before fitting, so a fit never sees the bad value. That makes
// the corruption invisible to t-stats while remaining lethal to anything that
// SELECTS assets rather than regressing across them — portfolios, backtests,
// the surge scanner, crash-recovery episode detection, and the trading bot.
//
// Three distinct failure modes, which need different handling:
//
//   spike          One or two bars wildly off, series returns to its prior
//                  level. The BAR is wrong. Drop it.
//   level-shift    Price jumps orders of magnitude and STAYS. This is a
//                  supplier remapping the ticker to a different asset, so the
//                  history BEFORE the jump belongs to some other token. APE
//                  ran at 0.000713 until 2023-07-19 then sat at ~2.06 — real
//                  ApeCoin was ~$2, so the cheap era is the impostor.
//   stale          Identical close repeated for many days, usually a dead or
//                  unpriced feed. Returns computed across it are fake zeros.
//
// This module DETECTS and RECORDS. It does not delete: quarantine rows are
// advisory, consumers join against them, and a false positive is recoverable
// by deleting a quarantine row rather than by re-fetching lost history. Same
// principle as migration 0012's cross-class ticker quarantine.

// A single-bar move beyond this is a corruption candidate. Deliberately high:
// crypto microcaps really do print +200% days, and this must not quarantine a
// genuine move. Everything above it is still only a CANDIDATE — it is
// confirmed only by what the neighbouring bars do.
export const SPIKE_LOG_THRESHOLD = Math.log(4);     // 4x in one step

// For a jump to count as a level shift rather than a spike, the price has to
// HOLD the new level: the median of the window after differs from the median
// of the window before by at least this much.
//
// STRICTER than the spike threshold, and deliberately so. A spike is confirmed
// by its own reversion — the series tells you it was wrong. A level shift has
// no such confirmation, so the bar for calling one has to clear real market
// history. Tuned against a known true positive and a known false positive:
// DOGE 2021-01-28 rose 4.43x in a day in the GameStop episode and is REAL, so
// 4x quarantines genuine history; AAVE 2020-10-03 rose 90.6x on the LEND->AAVE
// 100:1 redenomination and is not a return anyone earned. 10x separates them,
// and a sweep found 37 / 30 / 25 / 22 / 20 flags at 4x / 8x / 10x / 15x / 25x
// — no cliff, so the choice rests on the DOGE/AAVE boundary rather than on a
// gap in the data.
export const LEVEL_SHIFT_LOG_THRESHOLD = Math.log(10);
export const LEVEL_WINDOW = 7;

// A spike must come back. If the move out reverses at least this fraction of
// the move in, it was a round trip, not a new level.
export const SPIKE_REVERSION_FRACTION = 0.6;

// Identical close for this many consecutive bars is a dead feed, not a market.
export const STALE_RUN_MIN = 10;

const median = (a) => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// `bars` is one symbol's rows, date-ascending, each { date, close }.
// Returns [{ date, reason, detail }].
export function detectBadBars(bars, {
  spikeThreshold = SPIKE_LOG_THRESHOLD,
  levelThreshold = LEVEL_SHIFT_LOG_THRESHOLD,
  levelWindow = LEVEL_WINDOW,
  staleRunMin = STALE_RUN_MIN
} = {}) {
  const out = [];
  const closes = bars.map((b) => Number(b.close));
  const logs = closes.map((c) => (c > 0 ? Math.log(c) : null));
  const n = bars.length;
  if (n < 3) return out;

  // ---- spikes and level shifts ----
  for (let i = 1; i < n; i++) {
    if (logs[i] == null || logs[i - 1] == null) continue;
    const rIn = logs[i] - logs[i - 1];
    // Cheapest test first: below the SPIKE bar nothing can qualify as either.
    if (Math.abs(rIn) < Math.min(spikeThreshold, levelThreshold)) continue;

    // Robust level on each side, ignoring the candidate bar itself.
    const before = logs.slice(Math.max(0, i - levelWindow), i).filter((v) => v != null);
    const after = logs.slice(i + 1, Math.min(n, i + 1 + levelWindow)).filter((v) => v != null);
    const mBefore = median(before), mAfter = median(after);

    if (mBefore != null && mAfter != null && Math.abs(mAfter - mBefore) >= levelThreshold
        && Math.abs(rIn) >= levelThreshold) {
      // The new level held: the series changed identity here. Mark the FIRST
      // bar of the new regime so no consumer computes a return across the seam.
      out.push({
        date: bars[i].date, reason: 'level-shift',
        detail: `level ${Math.exp(mBefore).toPrecision(4)} -> ${Math.exp(mAfter).toPrecision(4)} `
          + `(${(Math.exp(mAfter - mBefore)).toPrecision(3)}x), held ${after.length} bars`
      });
      continue;
    }

    // Otherwise it is a spike if the move reverses.
    const rOut = (i + 1 < n && logs[i + 1] != null) ? logs[i + 1] - logs[i] : null;
    if (rOut != null && Math.abs(rIn) >= spikeThreshold
        && Math.sign(rOut) !== Math.sign(rIn)
        && Math.abs(rOut) >= Math.abs(rIn) * SPIKE_REVERSION_FRACTION) {
      out.push({
        date: bars[i].date, reason: 'spike',
        detail: `${closes[i - 1].toPrecision(4)} -> ${closes[i].toPrecision(4)} -> `
          + `${closes[i + 1].toPrecision(4)} (${Math.exp(rIn).toPrecision(3)}x then reverted)`
      });
      continue;
    }

    // A huge move that neither held nor reverted, at the very end of the
    // series where there is no "after" to judge by. Flag it rather than
    // guessing; a real +300% day is rare enough to be worth a human look.
    if (rOut == null && Math.abs(rIn) >= spikeThreshold) {
      out.push({
        date: bars[i].date, reason: 'spike',
        detail: `${closes[i - 1].toPrecision(4)} -> ${closes[i].toPrecision(4)} `
          + `(${Math.exp(rIn).toPrecision(3)}x, last bar, unverifiable)`
      });
    }
  }

  // ---- stale runs ----
  let runStart = 0;
  for (let i = 1; i <= n; i++) {
    if (i < n && closes[i] === closes[runStart]) continue;
    const runLength = i - runStart;
    if (runLength >= staleRunMin && closes[runStart] > 0) {
      for (let k = runStart; k < i; k++) {
        out.push({
          date: bars[k].date, reason: 'stale',
          detail: `close ${closes[runStart].toPrecision(4)} unchanged for ${runLength} bars`
        });
      }
    }
    runStart = i;
  }

  // One row per date; a level-shift boundary outranks a stale/spike label.
  const byDate = new Map();
  const rank = { 'level-shift': 3, spike: 2, stale: 1 };
  for (const r of out) {
    const prev = byDate.get(r.date);
    if (!prev || rank[r.reason] > rank[prev.reason]) byDate.set(r.date, r);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Consumer-side helpers. A quarantine set is { `${symbol}|${date}` } plus a
// per-symbol sorted list of level-shift boundary dates.
export function buildQuarantineIndex(rows) {
  const bad = new Set();
  const boundaries = new Map();
  for (const r of rows) {
    if (r.reason === 'level-shift') {
      // A boundary bar's own PRICE is fine — it is the first valid print of
      // the new asset. What is invalid is every bar before it and any return
      // computed across the seam. So it belongs in `boundaries`, NOT in `bad`:
      // putting it in both would delete the first day of the only trustworthy
      // segment the symbol has.
      if (!boundaries.has(r.symbol)) boundaries.set(r.symbol, []);
      boundaries.get(r.symbol).push(r.date);
      continue;
    }
    bad.add(`${r.symbol}|${r.date}`);
  }
  for (const list of boundaries.values()) list.sort();
  return { bad, boundaries };
}

export function isQuarantined(index, symbol, date) {
  return index.bad.has(`${symbol}|${date}`);
}

// True when a return from `from` to `to` would span a change of identity. The
// single most important check: even if both endpoint bars are individually
// fine, a return across a level shift is comparing two different assets.
export function spansIdentityChange(index, symbol, from, to) {
  const list = index.boundaries.get(symbol);
  if (!list || !list.length) return false;
  const lo = from < to ? from : to, hi = from < to ? to : from;
  // Boundary bar is the FIRST of the new regime, so a window starting exactly
  // on it is clean; one that starts before and ends on/after it is not.
  return list.some((b) => b > lo && b <= hi);
}

// Loads the persisted verdicts into a consumer-ready index.
//
// `hardOnly` is the default because the three reasons are not equally
// actionable: spike and level-shift mark bars that are WRONG, while stale
// marks bars that are merely uninformative. Dropping stale rows would quietly
// shrink the tradeable universe to liquid names only — a modelling decision,
// not a data correction — so a caller has to ask for it explicitly.
export async function loadBarQuarantine(d1Fn, env, { assetClass = null, hardOnly = true } = {}) {
  const where = [];
  const params = [];
  if (assetClass) { where.push('asset_class = ?'); params.push(assetClass); }
  if (hardOnly) where.push("reason IN ('spike', 'level-shift')");
  const rows = await d1Fn(env,
    `SELECT symbol, date, reason FROM asset_bar_quarantine${where.length ? ' WHERE ' + where.join(' AND ') : ''}`,
    params);
  return buildQuarantineIndex(rows);
}

// Removes quarantined bars from a per-symbol bar array and, at each
// level-shift boundary, DROPS EVERYTHING BEFORE IT. That second part is the
// one that matters: a remapped ticker's older history belongs to a different
// asset, so keeping it and merely skipping one return would leave every
// indicator (SMA200, range position, percentile) computed over two different
// tokens spliced together.
export function cleanBars(index, symbol, bars) {
  const boundaries = index.boundaries.get(symbol);
  let out = bars;
  if (boundaries && boundaries.length) {
    const lastBoundary = boundaries[boundaries.length - 1];
    out = out.filter((b) => b.date >= lastBoundary);
  }
  return out.filter((b) => !index.bad.has(`${symbol}|${b.date}`));
}
