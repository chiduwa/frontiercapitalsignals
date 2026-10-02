// One push per run instead of one per coin (2026-10-02, docs/DAY_ZONES_AND_BOXES.md).
//
// Counted on the phone topic over 11.5 hours of 2026-10-02: 46 pushes, 40 of
// them from two streams that sent one push per coin, in bursts (08:07 UTC: five
// gaming coins' volume exhaustion from one live scan; 08:15: five post-move
// spikes from one build). Those 40 came from 18 runs. A run's alerts now go
// out as one push, one line per coin, at the highest priority among them. A
// single alert goes out exactly as before. What each coin's record says
// (notification_log, the surge_signal_log.notified flag) is written per coin,
// as before.
const RANK = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };
// ntfy.sh turns a body over 4,096 bytes into an attachment the phone does not
// show inline.
export const NTFY_BODY_LIMIT = 4096;

/**
 * items: [{ symbol, line, push: { title, message, priority, tags, click } }]
 * Returns the push to send: the single item's own push, or the combined one.
 */
export function combinePushes(items, { noun, footer = '', limit = NTFY_BODY_LIMIT - 200 } = {}) {
  if (!items || !items.length) return null;
  if (items.length === 1) return items[0].push;
  const symbols = items.map(i => i.symbol);
  const title = `${noun}: ${symbols.slice(0, 4).join(', ')}${symbols.length > 4 ? ` +${symbols.length - 4}` : ''}`;
  const priority = items.map(i => i.push.priority || 'default').sort((a, b) => (RANK[b] || 3) - (RANK[a] || 3))[0];
  const tags = [...new Set(items.flatMap(i => i.push.tags || []))];
  const enc = new TextEncoder();
  let used = enc.encode(footer).length + 40;
  const lines = [];
  let dropped = 0;
  for (const i of items) {
    const n = enc.encode(i.line).length + 1;
    if (used + n > limit) { dropped++; continue; }
    lines.push(i.line);
    used += n;
  }
  if (dropped) lines.push(`+${dropped} more on the signals page.`);
  return { title, message: (footer ? [...lines, '', footer] : lines).join('\n'), priority, tags, click: items[0].push.click };
}
