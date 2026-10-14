// Import-safe notification and exact-bar delivery bookkeeping. Dependencies are
// injected so rejected requests, uncertain delivery, and fallback scans can be
// exercised without production credentials or real notifications.
export const PUSH_TIMEOUT_MS = 10_000;
export const PUSH_MAX_ATTEMPTS = 2;
export const PUSH_MAX_RETRY_DELAY_MS = 2_000;

export const surgeBarKey = (symbol, castAt) => JSON.stringify([symbol, castAt]);

export async function loadPushedBars(fired, { env, query }) {
  const ats = [...new Set(fired.map(hit => hit.features.at))];
  if (!ats.length) return new Set();
  const rows = await query(env, `SELECT DISTINCT symbol, cast_at FROM surge_signal_log
    WHERE notified = 1 AND cast_at IN (${ats.map(() => '?').join(',')})`, ats);
  return new Set(rows.map(row => surgeBarKey(row.symbol, row.cast_at)));
}

function retryDelay(response, nowMs) {
  const header = response.headers?.get('retry-after');
  if (header == null) return 1_000;
  const seconds = Number(header);
  const delay = header.trim() !== '' && Number.isFinite(seconds)
    ? seconds * 1_000 : Date.parse(header) - nowMs;
  // Never violate a longer Retry-After by shortening it to our local budget.
  return Number.isFinite(delay) && delay >= 0 && delay <= PUSH_MAX_RETRY_DELAY_MS
    ? delay : null;
}

// Two attempts at most, and only an explicit 429/503 response permits the second.
// A timeout/transport failure can happen after acceptance, so never retry it in
// this call. With the existing notified boolean, a later fallback scan can still
// retry unconfirmed delivery: this is not an exactly-once protocol. A 2xx response
// proves endpoint acceptance only, not that the phone displayed the notification.
export async function sendPush(push, {
  topic, fetchImpl = globalThis.fetch, timeoutMs = PUSH_TIMEOUT_MS,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, log = () => {}
} = {}) {
  if (!topic) return { accepted: false, outcome: 'disabled', attempts: 0, status: null };
  const { title, message, priority = 'default', tags = [] } = push;
  for (let attempt = 1; attempt <= PUSH_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8', Title: title, Priority: priority,
          ...(tags.length ? { Tags: tags.join(',') } : {}),
          Click: 'https://frontiercapitalsignals.com/signals/'
        },
        body: message, signal: controller.signal
      });
      // Do not parse a body after acceptance: a body-read failure must not turn
      // an accepted POST into a retry. Release any unread response stream.
      try { await response.body?.cancel(); } catch { /* status remains known */ }
    } catch {
      const result = { accepted: false, outcome: 'unconfirmed', attempts: attempt, status: null,
        reason: controller.signal.aborted ? 'timeout' : 'transport_error' };
      log(result); // never log the private topic, request body, or exception URL
      return result;
    } finally {
      clearTimeout(timeout);
    }
    const status = response.status;
    if (response.ok && status >= 200 && status < 300) {
      const result = { accepted: true, outcome: 'accepted', attempts: attempt, status };
      log(result);
      return result;
    }
    const delay = [429, 503].includes(status) && attempt < PUSH_MAX_ATTEMPTS
      ? retryDelay(response, now()) : null;
    log({ accepted: false, outcome: 'rejected', attempts: attempt, status,
      retryInMs: delay });
    if (delay == null) return { accepted: false, outcome: 'rejected', attempts: attempt, status };
    await sleep(delay);
  }
}

// A rejected/unconfirmed request must not consume the later scan's chance to
// notify. Keep persistence after acceptance, using the original exact config,
// symbol, and cast timestamp for every item included in the outgoing batch.
export async function deliverSurgeBatch(pending, push, { notify, env, query }) {
  if (!pending.length || !(await notify(push))) return 0;
  for (const item of pending) {
    await query(env, 'UPDATE surge_signal_log SET notified = 1 WHERE config_id = ? AND symbol = ? AND cast_at = ?',
      [item.cfg.id, item.h.symbol, item.h.features.at]);
  }
  return pending.length;
}
