// One switch that stops every bot on this host from opening anything new.
//
//   sudo touch /etc/fcs-trading-halt    # halt: no new entries or buys
//   sudo rm /etc/fcs-trading-halt       # resume
//
// The futures bot, the flush executor and the spot bot all check it before an
// entry. It never touches what is already open: stops, take-profits and exits
// keep running, because a halt that also froze protection would turn "stop
// adding risk" into "abandon the risk already taken".
//
// A file, not an env var, so the operator can halt everything with one command
// without editing three env files or restarting anything. TRADING_HALT=true in
// an env file does the same for one bot. Owner decision 2026-10-21 (questions
// spike S1): every bot that can place real orders needs a single kill switch.
//
// No imports beyond node:fs, so the gate is testable without credentials.
import { existsSync } from 'node:fs';

export const DEFAULT_HALT_FILE = '/etc/fcs-trading-halt';

export function tradingHaltReason(envVars = process.env, exists = existsSync) {
  if (String(envVars.TRADING_HALT || '').toLowerCase() === 'true') return 'TRADING_HALT=true';
  const file = envVars.TRADING_HALT_FILE || DEFAULT_HALT_FILE;
  return exists(file) ? `halt file ${file} is present` : null;
}
