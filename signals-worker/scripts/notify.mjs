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
import { d1 } from './d1-client.mjs';
import { MIN_RELIABILITY_SAMPLES } from '../worker.js';

const NTFY_TIMEOUT_MS = 10000;

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
export async function checkAndNotifyReversals(env, nowIso, lookbackHours = 4) {
  if (!env.NTFY_TOPIC) return 0;
  const cutoff = new Date(new Date(nowIso).getTime() - lookbackHours * 3600 * 1000).toISOString();
  const rows = await d1(env, `
    SELECT symbol, asset_class, run_at, dir FROM technique_votes
    WHERE technique_id = 'reversal' AND run_at >= ? ORDER BY symbol, run_at
  `, [cutoff]);

  const bySymbol = {};
  for (const r of rows) (bySymbol[r.symbol] ??= { assetClass: r.asset_class, rows: [] }).rows.push(r);

  const fresh = [];
  for (const [symbol, { assetClass, rows: symRows }] of Object.entries(bySymbol)) {
    if (symRows.length < 2) continue;
    const prev = symRows[symRows.length - 2], cur = symRows[symRows.length - 1];
    if ((cur.dir === 1 || cur.dir === -1) && cur.dir !== prev.dir) {
      fresh.push({ symbol, assetClass, dir: cur.dir, runAt: cur.run_at });
    }
  }
  if (!fresh.length) return 0;

  const symbols = fresh.map((f) => f.symbol);
  const placeholders = symbols.map(() => '?').join(',');
  const priceNow = {};
  const priceRows = await d1(env, `SELECT symbol, price FROM asset_price_log WHERE symbol IN (${placeholders}) ORDER BY run_at DESC`, symbols);
  for (const r of priceRows) if (!(r.symbol in priceNow)) priceNow[r.symbol] = r.price;

  // This asset's OWN measured accuracy for the 'reversal' technique
  // specifically -- already computed and maintained by the existing
  // adaptive-weighting loop (technique_reliability, evaluateMatured), not
  // new data collection. Pooled across both scored horizons, same blended
  // shape loadReliability itself uses. Gated on the SAME
  // MIN_RELIABILITY_SAMPLES bar the live engine already requires before
  // trusting an asset-specific number anywhere else -- an alert still
  // fires below that bar (a new or thin-history asset shouldn't be
  // silenced), it just can't yet say how much to trust it.
  const relRows = await d1(env, `SELECT symbol, SUM(correct) as correct, SUM(total) as total FROM technique_reliability WHERE technique_id = 'reversal' AND symbol IN (${placeholders}) GROUP BY symbol`, symbols);
  const reliability = {};
  for (const r of relRows) reliability[r.symbol] = { correct: r.correct, total: r.total };

  let sent = 0;
  for (const f of fresh) {
    const price = priceNow[f.symbol];
    const label = f.dir === 1 ? 'bottomed' : 'peaked';
    const emoji = f.dir === 1 ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend';
    const rel = reliability[f.symbol];
    const trackRecord = rel && rel.total >= MIN_RELIABILITY_SAMPLES
      ? ` This asset's own reversal calls have been right ${Math.round((rel.correct / rel.total) * 100)}% of the time (${rel.total} prior calls).`
      : '';
    const notified = await notifyOnChange(env, 'reversal', f.symbol, `${f.dir}@${f.runAt}`, {
      title: `${f.symbol} ${label}`,
      message: `${f.symbol} (${f.assetClass}) flagged a ${label} reversal` + (price != null ? ` near ${price}` : '') + ` -- RSI turned, confirmed by an independent signal.${trackRecord}`,
      priority: 'default',
      tags: [emoji],
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
        title: dir === 1 ? 'Crypto market surging' : 'Crypto market dropping',
        message: `The tracked crypto market's median move is ${medianPct > 0 ? '+' : ''}${medianPct.toFixed(1)}% over the last ~${windowHours}h (${cryptoMoves.length} assets) -- broad, not one asset.`,
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
      title: `${m.symbol}: sudden ${dir === 1 ? 'spike' : 'drop'}`,
      message: `${m.symbol} (${m.assetClass}) moved ${m.pct > 0 ? '+' : ''}${m.pct.toFixed(1)}% in ~${windowHours}h -- abrupt enough that something likely just happened. Worth checking for news.`,
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
