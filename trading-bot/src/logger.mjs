// Structured JSON-lines logging to both stdout (systemd/journald picks
// this up) and a local file — every decision this bot makes, including
// SKIPPED candidates and why, gets a record. An autonomous system moving
// real leveraged money needs a full audit trail, not just its trades.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.mjs';

mkdirSync(dirname(config.logFile), { recursive: true });

export function log(event, data = {}) {
  const record = { ts: new Date().toISOString(), event, ...data };
  console.log(JSON.stringify(record));
  try {
    appendFileSync(config.logFile, JSON.stringify(record) + '\n');
  } catch (e) {
    console.error('failed to write log file:', e.message);
  }
}
