# Research 2026-10-05: does the "now reversing" alert predict anything?

Findings are in `../PUMP_FADE_EVIDENCE.md`. This folder holds the scripts and
their raw output.

Run from a scratch directory (the scripts read and write relative paths):

1. `alerts.json`: export the live alerts:
   `wrangler d1 execute frontier-capital-signals-reliability --remote --json --command "SELECT n.symbol, n.title, n.message, n.sent_at, (SELECT asset_class FROM asset_price_log a WHERE a.symbol=n.symbol ORDER BY run_at DESC LIMIT 1) cls FROM notification_log n WHERE n.kind='suddenmove' ORDER BY n.sent_at" > alerts.json`
2. `python3 fetch_live.py && python3 analyse_live.py`: score the live alerts on Binance 5m bars.
3. `perps.json`: export `SELECT symbol, MAX(venue_symbol) venue, MAX(date) last FROM derivatives_daily WHERE date >= '<a week ago>' GROUP BY symbol` the same way and keep the `results` array.
4. `python3 fetch_hist.py`: hourly Binance spot bars into `h1/` (about 15 minutes, 16 threads).
5. `THR=10 WIN=6 LAG=0 python3 analyse_hist.py` (and `LAG=1`): replay the alert and score fade and follow by case.
6. `python3 sim.py ev_10.0_6_0.pkl`: stop, target and time-exit simulations.
7. `node xcheck.mjs`: confirm the production detector (`trading-bot/src/pump-fade-rules.mjs`) picks the same pumps as the replay.

`results/` holds the output of steps 2, 5 and 6 as run on 2026-10-05.
