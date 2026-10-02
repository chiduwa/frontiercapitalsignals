"""Read-only: derivatives_daily (Binance USDT-perp OI, daily) from production D1, chunked by symbol."""
import json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rot_panel import WORK
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".."))
ENV = {k: v for k, v in os.environ.items() if k not in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID")}
def q(sql):
    out = subprocess.run(["npx", "--yes", "wrangler@4", "d1", "execute", "frontier-capital-signals-reliability", "--remote", "--json", "--command", sql],
                         capture_output=True, text=True, env=ENV, cwd=ROOT).stdout
    return json.loads(out[out.find("["):])[0]["results"]
syms = [r["symbol"] for r in q("SELECT symbol, COUNT(*) n FROM derivatives_daily GROUP BY symbol ORDER BY symbol")]
print(len(syms), flush=True)
rows = []
for i in range(0, len(syms), 12):
    chunk = syms[i:i + 12]
    lst = ",".join("'" + s.replace("'", "''") + "'" for s in chunk)
    r = q(f"SELECT symbol, date, oi_usd_close, oi_qty_close, taker_buy_sell_ratio, samples FROM derivatives_daily WHERE symbol IN ({lst})")
    rows += r; print(i, len(r), flush=True)
json.dump(rows, open(os.path.join(WORK, "derivatives_daily.json"), "w"))
print("rows", len(rows))
