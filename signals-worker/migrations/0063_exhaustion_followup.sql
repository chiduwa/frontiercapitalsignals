-- The +1h follow-up to a pushed exhaustion alert (2026-10-14,
-- scripts/exhaustion-followup.mjs, docs/EXHAUSTION_FOLLOW_THROUGH.md).
-- followup_at is set once per coin/bar when the follow-up is accepted, or when
-- it was too late to send (state 'late') or unreadable ('unreadable'), so no run
-- sends it twice. The state and the first hour's volume and move are kept so the
-- forward record of each state can be checked against the evidence it quotes.
-- ADD COLUMN only edits the schema: no table rewrite, no extra billed writes.
ALTER TABLE surge_signal_log ADD COLUMN followup_at TEXT;
ALTER TABLE surge_signal_log ADD COLUMN followup_state TEXT;
ALTER TABLE surge_signal_log ADD COLUMN followup_vol1 REAL;
ALTER TABLE surge_signal_log ADD COLUMN followup_move1_pct REAL;
