# The generator's own history screen on real input: shrunk calibration vs the
# per-asset calibration already in the grid, for the same source, per slot.
import os
SW = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))   # signals-worker/
import importlib.util, json, sys, time, statistics as st
sys.path.insert(0, SW)
spec = importlib.util.spec_from_file_location('mt', os.path.join(SW, 'scripts', 'model-tournament.py'))
mt = importlib.util.module_from_spec(spec); spec.loader.exec_module(mt)
data = json.load(open(os.path.join(os.environ.get('OVF_DATA', '.'), 'tourn-input.json')))
t = mt.Tournament(data, [], [], data['asOf'], '2026-09-27T00:00:00Z')
t0 = time.time()
syms = ['BTC', 'ETH', 'SOL', 'XRP', 'HBAR', 'ARB', 'XLM', 'NVDA', 'AAPL', 'JPM', 'XOM', 'TSLA']
for src in ('garchWeekday', 'trailing', 'ewma'):
    per = mt.make('magnitude', 'scale', source=src, calibrated=True)
    shr = mt.make('magnitude', 'scale', source=src, calibrated='shrunk')
    wins = 0; diffs = []
    for s in syms:
        for h in ((1, 7) if t.cls(s) == 'crypto' else (1, 5)):
            a = t.backtest(shr, s, 'magnitude', h); b = t.backtest(per, s, 'magnitude', h)
            common = [d for d in a if d in b]
            if not common: continue
            dm = st.mean(b[d] - a[d] for d in common)     # positive = shrunk has lower QLIKE
            diffs.append(dm); wins += dm > 0
    print(f'{src:13s} shrunk beats per-asset calibration on the last 360 days in {wins}/{len(diffs)} asset-slots; mean QLIKE gain {st.mean(diffs):+.4f}')
print(f'{time.time()-t0:.0f}s, pools cached: {len(t._pool)}')
