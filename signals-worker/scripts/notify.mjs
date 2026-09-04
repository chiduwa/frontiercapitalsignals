// Push notifications via ntfy.sh (https://ntfy.sh) -- a free, signup-free
// pub/sub notification service. The destination is just a topic name kept
// in the NTFY_TOPIC secret; the user subscribes to it via the ntfy app or
// a browser (https://ntfy.sh/<topic>). User-requested 2026-08-24: alert on
// a peak/bottom signal, and immediately on disruptive/extremely good news
// (hacks, major contracts/deals/policy).
//
// env.NTFY_TOPIC unset is treated as "notifications not yet configured" --
// every exported function here silently no-ops rather than throwing,
// matching this project's established pattern for an optional,
// user-provided credential (CMC_API_KEY, CRYPTOPANIC_API_TOKEN).
import { d1, chunk } from './d1-client.mjs';
import { MIN_RELIABILITY_SAMPLES, currentSignalConfidence, noSkillBaseline, skillOverBaseline } from '../worker.js';

const NTFY_TIMEOUT_MS = 10000;
const CONFIDENT_MOVE_ALERTS_PER_RUN = 5;
const REVERSAL_ALERT_COOLDOWN_HOURS = 6;

function fmtAlertPrice(v) {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) return Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 1) return Number(v).toFixed(2);
  if (abs >= 0.1) return Number(v).toFixed(4);
  return Number(v).toFixed(6);
}

async function sendNtfy(topic, { title, message, priority = 'default', tags = [], click }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), NTFY_TIMEOUT_MS);
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Title': title,
        'Priority': priority,
        ...(tags.length ? { Tags: tags.join(',') } : {}),
        ...(click ? { Click: click } : {})
      },
      body: message,
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
  } finally {
    clearTimeout(t);
  }
}

// Sends a notification only if (kind, symbol)'s dedup value has genuinely
// changed since the last one sent for it -- so a state that just KEEPS
// holding (the same hack record seen again tomorrow, the same reversal
// direction still active next hour) doesn't re-notify every single run,
// only a real change does. `value` should be something that's guaranteed
// to differ between two genuinely distinct occurrences (a hack's own
// (date, description) key; a reversal transition's own run_at) and
// IDENTICAL between repeated observations of the exact same occurrence.
// Returns true only if a notification was actually sent.
//
// Also appends to notification_log -- a real, permanent history of every
// notification ever sent, distinct from notification_state's own
// current-value-only, no-history design (see that table's own docs).
// User-requested 2026-08-24: an RSS feed "on the side" for news/alerts,
// which needs an actual list to read from, not just the latest dedup
// state per (kind, symbol) — see the Worker's /api/feed route.
export async function notifyOnChange(env, kind, symbol, value, notification, nowIso) {
  if (!env.NTFY_TOPIC) return false;
  const existing = await d1(env, 'SELECT last_value FROM notification_state WHERE kind = ? AND symbol = ?', [kind, symbol]);
  if (existing.length && existing[0].last_value === value) return false;
  await sendNtfy(env.NTFY_TOPIC, notification);
  await d1(env, `
    INSERT INTO notification_state (kind, symbol, last_value, last_sent_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (kind, symbol) DO UPDATE SET last_value = excluded.last_value, last_sent_at = excluded.last_sent_at
  `, [kind, symbol, value, nowIso]);
  await d1(env, `
    INSERT INTO notification_log (kind, symbol, title, message, priority, click_url, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [kind, symbol, notification.title, notification.message, notification.priority || 'default', notification.click || null, nowIso]);
  return true;
}

async function setNotificationState(env, kind, symbol, value, nowIso) {
  await d1(env, `
    INSERT INTO notification_state (kind, symbol, last_value, last_sent_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (kind, symbol) DO UPDATE SET last_value = excluded.last_value, last_sent_at = excluded.last_sent_at
  `, [kind, symbol, value, nowIso]);
}

// Fresh reversal detection: technique_id='reversal' composite votes are
// already logged every hourly build (same technique_votes table every
// other technique uses, see logRun/evaluateMatured) -- this reads just
// the last couple of hours of them (NOT a deep rescan -- see
// detectAndLogCallFlips' own 200h-vs-8h lesson, 2026-08-22, for exactly
// why that would be a real, avoidable cost) and finds symbols whose
// LATEST vote is a fresh bottom/peak (dir 1 or -1) that the IMMEDIATELY
// PRECEDING vote wasn't already -- a transition, not a level. A symbol
// that returns to neutral and later bottoms again correctly re-alerts
// (there's no "already alerted this direction" memory beyond the
// adjacent pair), while a bottom that just keeps holding hour after hour
// does not spam. `lookbackHours` needs only to comfortably span 2-3 real
// build cycles.
// Chooses an exact-horizon, exact-direction reversal record only when its
// conservative lower bound clears that market's measured no-skill baseline.
// Rows come from forecast_outcomes, whose windows are non-overlapping; this is
// intentionally not compatible with the old pooled 24h+168h counter.
export function selectReliableReversalEvidence(rows, baselines, assetClass, symbol, dir) {
  const qualified = [];
  for (const row of rows || []) {
    if (row.asset_class !== assetClass || row.symbol !== symbol || Number(row.dir) !== Number(dir)) continue;
    if (!Number.isFinite(Number(row.correct)) || Number(row.total) < MIN_RELIABILITY_SAMPLES) continue;
    const horizonHours = Number(row.horizon_hours);
    const baseline = noSkillBaseline(baselines && baselines[`${assetClass}|${horizonHours}`], dir === 1 ? 1 : 0, dir === -1 ? 1 : 0);
    const skill = skillOverBaseline(Number(row.correct), Number(row.total), baseline);
    if (!skill || !skill.significant || skill.lowerEdge <= 0) continue;
    qualified.push({ ...row, horizon_hours: horizonHours, ...skill });
  }
  qualified.sort((a, b) => b.lowerEdge - a.lowerEdge || a.horizon_hours - b.horizon_hours);
  return qualified[0] || null;
}

export async function checkAndNotifyReversals(env, nowIso, lookbackHours = 6) {
  if (!env.NTFY_TOPIC) return 0;
  const cutoff = new Date(new Date(nowIso).getTime() - lookbackHours * 3600 * 1000).toISOString();
  const rows = await d1(env, `
    SELECT symbol, asset_class, run_at, dir FROM technique_votes
    WHERE technique_id = 'reversal' AND run_at >= ? ORDER BY symbol, run_at
  `, [cutoff]);

  const bySymbol = {};
  for (const r of rows) (bySymbol[`${r.asset_class}|${r.symbol}`] ??= { symbol: r.symbol, assetClass: r.asset_class, rows: [] }).rows.push(r);

  const fresh = [];
  for (const { symbol, assetClass, rows: symRows } of Object.values(bySymbol)) {
    if (symRows.length < 2) continue;
    const prev = symRows[symRows.length - 2], cur = symRows[symRows.length - 1];
    const beforePrev = symRows.length >= 3 ? symRows[symRows.length - 3] : null;
    // One full subsequent build must confirm the same side. This turns a
    // one-hour PEPE-style up/down whipsaw into an invalidated research event,
    // not a stream of categorical "bottomed / peaked" alerts.
    if ((cur.dir === 1 || cur.dir === -1) && cur.dir === prev.dir && (!beforePrev || beforePrev.dir !== cur.dir)) {
      fresh.push({ symbol, assetClass, dir: cur.dir, runAt: cur.run_at });
    }

  }
  if (!fresh.length) return 0;

  const symbols = fresh.map((f) => f.symbol);
  const placeholders = symbols.map(() => '?').join(',');
  const priceNow = {};
  const priceRows = await d1(env, `SELECT symbol, asset_class, price FROM asset_price_log WHERE symbol IN (${placeholders}) ORDER BY run_at DESC`, symbols);
  for (const r of priceRows) {
    const key = `${r.asset_class}|${r.symbol}`;
    if (!(key in priceNow)) priceNow[key] = r.price;
  }

  const relRows = await d1(env, `
    SELECT symbol, asset_class, dir, horizon_minutes / 60 AS horizon_hours,
           SUM(correct) AS correct, COUNT(*) AS total
    FROM forecast_outcomes
    WHERE series_kind = 'technique' AND series_key = 'reversal'
      AND aggregated = 1 AND symbol IN (${placeholders})
    GROUP BY symbol, asset_class, dir, horizon_minutes
  `, symbols);
  const baselineRows = await d1(env, 'SELECT asset_class, horizon_hours, n_up, n_flat, n_down FROM direction_baseline');
  const baselines = Object.fromEntries(baselineRows.map((row) => [`${row.asset_class}|${row.horizon_hours}`, row]));
  const stateRows = await d1(env, `SELECT symbol, last_sent_at FROM notification_state WHERE kind = 'reversal' AND symbol IN (${placeholders})`, symbols);
  const lastSent = Object.fromEntries(stateRows.map((row) => [row.symbol, Date.parse(row.last_sent_at)]));

  let sent = 0;
  for (const f of fresh) {
    if (Number.isFinite(lastSent[f.symbol]) && Date.parse(nowIso) - lastSent[f.symbol] < REVERSAL_ALERT_COOLDOWN_HOURS * 3600 * 1000) continue;
    const evidence = selectReliableReversalEvidence(relRows, baselines, f.assetClass, f.symbol, f.dir);
    if (!evidence) continue; // thin/unproven means wait and keep learning, not alert with an invented claim
    const price = priceNow[`${f.assetClass}|${f.symbol}`];
    const label = f.dir === 1 ? 'bottom' : 'top';
    const emoji = f.dir === 1 ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend';
    const horizonLabel = evidence.horizon_hours === 24 ? '24h' : `${Math.round(evidence.horizon_hours / 24)}d`;
    const checkpoint = new Date(Date.parse(f.runAt) + evidence.horizon_hours * 3600 * 1000).toISOString();
    const notified = await notifyOnChange(env, 'reversal', f.symbol, `${f.dir}@${f.runAt}`, {
      title: `${f.symbol}: possible ${label} reversal watch`,
      message: `${f.symbol} (${f.assetClass}) produced a two-build ${label}-reversal setup` + (price != null ? ` near ${fmtAlertPrice(price)}` : '') + `. Its same-direction ${horizonLabel} record is ${Math.round(evidence.accuracy * 100)}% across ${evidence.total} non-overlapping outcomes; the conservative lower estimate is ${Math.round((evidence.lowerEdge + evidence.baseline) * 100)}% versus a ${Math.round(evidence.baseline * 100)}% no-skill baseline. This does not identify the exact ${label}. Next evaluation checkpoint: ${checkpoint}. No validated target or invalidation level is available, so wait for price/volume confirmation rather than treating this as an entry.`,
      priority: 'default',
      tags: [emoji],
      click: 'https://frontiercapitalsignals.com/signals/'
    }, nowIso);
    if (notified) sent++;
  }
  return sent;
}

// Alert only on entry into a coiled state; dedup prevents hourly spam while
// the same consolidation remains active.
export async function checkAndNotifyConsolidations(env, nowIso, lookbackHours = 4) {
  if (!env.NTFY_TOPIC) return 0;
  const cutoff = new Date(new Date(nowIso).getTime() - lookbackHours * 3600 * 1000).toISOString();
  const rows = await d1(env, `SELECT symbol, asset_class, run_at, dir FROM technique_votes WHERE technique_id = 'accum' AND run_at >= ? ORDER BY symbol, run_at`, [cutoff]);
  const bySymbol = {};
  for (const r of rows) (bySymbol[r.symbol] ??= { assetClass: r.asset_class, rows: [] }).rows.push(r);
  let sent = 0;
  for (const [symbol, rec] of Object.entries(bySymbol)) {
    if (rec.rows.length < 2) continue;
    const prev = rec.rows[rec.rows.length - 2], cur = rec.rows[rec.rows.length - 1];
    if (![1, -1].includes(cur.dir) || cur.dir === prev.dir) continue;
    const direction = cur.dir === 1 ? 'upside' : 'downside';
    if (await notifyOnChange(env, 'consolidation', symbol, `${cur.dir}@${cur.run_at}`, {
      title: `${symbol}: consolidation detected`,
      message: `${symbol} (${rec.assetClass}) entered a coiled range with ${direction} volume bias. Watch for a confirmed break; this is not a trade recommendation.`,
      priority: 'default', tags: ['hourglass_flowing_sand'],
      click: 'https://frontiercapitalsignals.com/signals/'
    }, nowIso)) sent++;
  }
  return sent;
}

// Reads the per-asset composite record at each fixed maturity horizon after
// this run has evaluated due outcomes. Alerting deliberately does not reuse a
// broader presentation score: range containment and pivot accuracy are useful
// dashboard context but are not evidence that THIS directional composite call
// will be right.
async function loadCompositeRecordsForAlerts(env, signals) {
  const symbols = [...new Set(signals.map((s) => s.symbol).filter(Boolean))];
  const out = {};
  for (const batch of chunk(symbols, 80)) {
    const placeholders = batch.map(() => '?').join(',');
    const rows = await d1(env, `
      SELECT symbol, horizon_hours, correct, total
      FROM technique_reliability
      WHERE technique_id = 'composite'
        AND horizon_hours IN (24, 168)
        AND symbol IN (${placeholders})
    `, batch);
    for (const row of rows) out[`${row.symbol}|${row.horizon_hours}`] = row;
  }
  return out;
}

function alertHorizonHours(signal) {
  return signal && signal.horizon && Number.isFinite(signal.horizon.days)
    ? (signal.horizon.days <= 4 ? 24 : 168)
    : null;
}

// Transition-based alert when the current composite call clears a stricter
// confidence bar than the normal dashboard ranking alone: detailed
// score-calibration plus this asset's own matching-horizon composite history,
// with extra gates on agreement and historical horizon/range basis. State is
// explicitly reset to 'none' when a symbol falls out of this actionable set so
// a later re-entry can alert again without requiring the direction to change.
export async function checkAndNotifyConfidentMoves(env, nowIso, signals, calibration, baselines) {
  if (!env.NTFY_TOPIC || !Array.isArray(signals) || !signals.length) return 0;
  const compositeRecords = await loadCompositeRecordsForAlerts(env, signals);
  const ranked = signals
    .map((s) => {
      const horizonHours = alertHorizonHours(s);
      return {
        signal: s,
        confidence: currentSignalConfidence(s, calibration, horizonHours != null ? compositeRecords[`${s.symbol}|${horizonHours}`] : null, baselines)
      };
    })
    .filter((x) => x.confidence && x.confidence.actionable)
    .sort((a, b) => b.confidence.estimatedWinRate - a.confidence.estimatedWinRate || b.signal.score - a.signal.score || a.signal.symbol.localeCompare(b.signal.symbol));

  const actionable = new Map(ranked.map((x) => [x.signal.symbol, x]));
  const activeRows = await d1(env, 'SELECT symbol, last_value FROM notification_state WHERE kind = ?', ['confidentmove']);
  const priorState = new Map(activeRows.map((row) => [row.symbol, row.last_value]));
  for (const row of activeRows) {
    if (!actionable.has(row.symbol)) await setNotificationState(env, 'confidentmove', row.symbol, 'none', nowIso);
  }

  let sent = 0;
  for (const { signal, confidence } of ranked) {
    const stateValue = String(signal.dir);
    if (priorState.get(signal.symbol) === stateValue) continue;
    // On a cold start several symbols can qualify together. Record lower-ranked
    // entrants as active without sending them, rather than turning the next few
    // runs into a backlog of stale notifications.
    if (sent >= CONFIDENT_MOVE_ALERTS_PER_RUN) {
      await setNotificationState(env, 'confidentmove', signal.symbol, stateValue, nowIso);
      continue;
    }
    const dirLabel = signal.dir === 1 ? 'up' : 'down';
    const agreementPct = Math.round(confidence.agreementRatio * 100);
    const horizon = signal.horizon ? signal.horizon.label : 'next move';
    const calText = confidence.calibration
      ? ` ${confidence.calibration.source === 'asset-class-direction-horizon' ? 'Matching asset-class/direction/horizon' : 'Pooled'} score bucket ${confidence.bucket * 10}-${confidence.bucket * 10 + 9} has a ${Math.round(confidence.calibration.accuracy * 100)}% raw hit rate (${confidence.calibration.samples} calls; conservative lower estimate ${Math.round(confidence.calibration.lowerBound * 100)}%).`
      : '';
    const assetText = confidence.assetCompositeRecord
      ? ` ${signal.symbol}'s own ${confidence.horizonHours || 'matching'}h composite calls have a ${Math.round(confidence.assetCompositeRecord.accuracy * 100)}% raw hit rate over ${confidence.assetCompositeRecord.samples} outcomes (conservative lower estimate ${Math.round(confidence.assetCompositeRecord.lowerBound * 100)}%).`
      : '';
    const priceText = signal.price != null ? ` Current price: ${fmtAlertPrice(signal.price)}.` : '';
    const rangeText = signal.range ? ` Modeled range over ${horizon}: ${fmtAlertPrice(signal.range.low)} to ${fmtAlertPrice(signal.range.high)}.` : '';
    const notified = await notifyOnChange(env, 'confidentmove', signal.symbol, stateValue, {
      title: `${signal.symbol}: confident ${dirLabel} move setup`,
      message: `${signal.symbol} (${signal.asset_class}) has a high-confidence ${dirLabel} setup now: score ${signal.score}, ${signal.agree}/${signal.total} techniques aligned (${agreementPct}%). Conservative reliability estimate ${Math.round(confidence.estimatedWinRate * 100)}%.${priceText}${calText}${assetText}${rangeText} Mechanical model output only, not financial advice.`,
      priority: confidence.estimatedWinRate >= 0.75 ? 'high' : 'default',
      tags: [signal.dir === 1 ? 'rocket' : 'chart_with_downwards_trend'],
      click: 'https://frontiercapitalsignals.com/signals/'
    }, nowIso);
    if (notified) sent++;
  }
  return sent;
}

// User-requested 2026-08-24, broadening the original "hacked" ask: "any
// breach or negative news that usually disrupts an asset/the entire
// market" -- extremely good news is the flip side of the same request
// ("disruptive OR extremely good news"). DeFiLlama's hacks tracker only
// covers named, matched DeFi exploits (notifyOnNewHacks above); this
// catches the broader case with no news source at all -- a genuinely
// abrupt price move is itself evidence something just happened, whatever
// it is. Reads asset_price_log (already hourly-fresh, already flowing,
// no new fetch) over a short recent window per real tracked asset, and
// separately takes the MEDIAN of those same per-asset moves as a live,
// hourly-fresh market-wide read -- deliberately NOT the existing
// marketReturn/loadMarketReturn (MCAP:TOTAL/BROAD), which only updates
// once a day from the daily job and would describe yesterday's move, not
// "right now," failing this feature's whole point.
//
// Dedup is UTC-date-bucketed (not a true state-transition like
// checkAndNotifyReversals' adjacent-pair check) -- there's no discrete
// per-hour "vote" row here to anchor a precise transition timestamp to,
// only whatever this run happens to compute fresh each time. A date
// bucket means at most one alert per (symbol, direction) per UTC day:
// re-fires on a genuinely new day's move, doesn't spam every run an
// ongoing move keeps qualifying. Simpler than reconstructing a true
// state machine, and lines up with the user's own stated tolerance
// ("max a day or two old") for this alert family specifically.
export async function checkAndNotifySuddenMoves(env, nowIso, windowHours = 6, cryptoThresholdPct = 10, stockThresholdPct = 6, marketThresholdPct = 5) {
  if (!env.NTFY_TOPIC) return 0;
  const cutoff = new Date(new Date(nowIso).getTime() - (windowHours + 1) * 3600 * 1000).toISOString();
  const rows = await d1(env, `SELECT symbol, asset_class, run_at, price FROM asset_price_log WHERE run_at >= ? ORDER BY symbol, run_at`, [cutoff]);

  const bySymbol = {};
  for (const r of rows) (bySymbol[r.symbol] ??= { assetClass: r.asset_class, rows: [] }).rows.push(r);

  const moves = []; // { symbol, assetClass, pct }
  for (const [symbol, { assetClass, rows: symRows }] of Object.entries(bySymbol)) {
    if (symRows.length < 2) continue;
    const oldest = symRows[0], newest = symRows[symRows.length - 1];
    if (!oldest.price || !newest.price) continue;
    const hoursSpan = (new Date(newest.run_at) - new Date(oldest.run_at)) / 3600000;
    if (hoursSpan < windowHours * 0.5) continue; // not enough real elapsed time in this window yet to trust the move
    moves.push({ symbol, assetClass, pct: ((newest.price / oldest.price) - 1) * 100 });
  }
  if (!moves.length) return 0;

  const dateBucket = new Date(nowIso).toISOString().slice(0, 10);
  let sent = 0;

  const cryptoMoves = moves.filter((m) => m.assetClass === 'crypto');
  if (cryptoMoves.length >= 5) {
    const sortedPct = cryptoMoves.map((m) => m.pct).sort((a, b) => a - b);
    const medianPct = sortedPct[Math.floor(sortedPct.length / 2)];
    if (Math.abs(medianPct) >= marketThresholdPct) {
      const dir = medianPct > 0 ? 1 : -1;
      const notified = await notifyOnChange(env, 'marketmove', 'CRYPTO_MARKET', `${dir}@${dateBucket}`, {
        title: dir === 1 ? 'Post-move crypto surge detected' : 'Post-move crypto drop detected',
        message: `Observed after the move: the tracked crypto market's median changed ${medianPct > 0 ? '+' : ''}${medianPct.toFixed(1)}% over the prior ~${windowHours}h (${cryptoMoves.length} assets). This is an anomaly notice, not an advance prediction or entry/exit signal.`,
        priority: 'high',
        tags: [dir === 1 ? 'rocket' : 'chart_with_downwards_trend'],
        click: 'https://frontiercapitalsignals.com/signals/'
      }, nowIso);
      if (notified) sent++;
    }
  }

  for (const m of moves) {
    const threshold = m.assetClass === 'crypto' ? cryptoThresholdPct : stockThresholdPct;
    if (Math.abs(m.pct) < threshold) continue;
    const dir = m.pct > 0 ? 1 : -1;
    const notified = await notifyOnChange(env, 'suddenmove', m.symbol, `${dir}@${dateBucket}`, {
      title: `${m.symbol}: post-move ${dir === 1 ? 'spike' : 'drop'} detected`,
      message: `Observed after the move: ${m.symbol} (${m.assetClass}) changed ${m.pct > 0 ? '+' : ''}${m.pct.toFixed(1)}% over the prior ~${windowHours}h. This does not predict continuation or reversal and is not an entry/exit signal; check verified news, liquidity, spread, and volume before acting.`,
      priority: dir === 1 ? 'high' : 'urgent',
      tags: [dir === 1 ? 'rocket' : 'warning'],
      click: 'https://frontiercapitalsignals.com/signals/'
    }, nowIso);
    if (notified) sent++;
  }
  return sent;
}

// Immediate, high-priority alert for a NEWLY-matched hack/exploit against
// a tracked symbol. `matched`: matchHacksToUniverse's own output (this
// run's full DeFiLlama pull, symbol=null for anything not in the tracked
// universe) -- filtered here to real matches only. Dedup value is the
// hack's own (event_date, description) key, the SAME uniqueness
// asset_events itself already uses (see schema.sql) -- the full 600+
// history gets re-matched every daily run, so without this every already-
// known hack would re-alert daily forever.
//
// RECENCY_MAX_DAYS guards a real bug found live, 2026-08-24: dedup alone
// only stops an ALREADY-SEEN event from re-alerting -- it does nothing on
// a symbol's FIRST-ever pass, when notification_state has no row for it
// yet. Against DeFiLlama's full multi-year history, that meant the very
// first time this ran, every tracked symbol's oldest matched hack fired
// an alert regardless of whether it happened in 2026 or 2020. User's own
// framing: alerts should land "a few seconds to a few hours, max a day or
// two" after the real event -- so this is a hard filter on event_date
// BEFORE the dedup check ever runs, not a dedup problem to solve more
// cleverly. DeFiLlama's hack records carry only a date, not a precise
// timestamp, so the window is necessarily date-granular.
const HACK_ALERT_MAX_AGE_DAYS = 2;

export async function notifyOnNewHacks(env, matched, nowIso) {
  if (!env.NTFY_TOPIC) return 0;
  const cutoffDate = new Date(new Date(nowIso).getTime() - HACK_ALERT_MAX_AGE_DAYS * 86400000).toISOString().slice(0, 10);
  let sent = 0;
  for (const h of matched) {
    if (!h.symbol || h.date < cutoffDate) continue;
    const amountStr = h.amount ? `$${(h.amount / 1e6).toFixed(1)}M` : 'undisclosed amount';
    const notified = await notifyOnChange(env, 'hack', h.symbol, `${h.date}|${h.name}`, {
      title: `URGENT: ${h.symbol} hacked`,
      message: `${h.symbol}: "${h.name}" -- ${amountStr}${h.classification ? `, ${h.classification}` : ''}, ${h.date}.`,
      priority: 'urgent',
      tags: ['rotating_light', 'money_with_wings'],
      click: 'https://frontiercapitalsignals.com/signals/'
    }, nowIso);
    if (notified) sent++;
  }
  return sent;
}
