# Bracket-trade simulation on the replayed events: stop S% adverse, target T%
# favourable, time exit at H hours, 0.15% round-trip cost. When a bar touches
# both the stop and the target, the stop is assumed hit first (conservative).
import pickle, sys, statistics as st, math, collections
ev = pickle.load(open(sys.argv[1], "rb")) if __name__ == "__main__" else None
COST = 0.15
def trade(e, side, S, T, H):
    hi, lo, cl = e['path']
    for k in range(H):
        fav = (hi[k] if side > 0 else -lo[k]); adv = (-lo[k] if side > 0 else hi[k])
        if adv >= S: return -S - COST
        if fav >= T: return T - COST
    return side*cl[H-1] - COST
def report(label, sel, side_of):
    for S, T, H in [(5, 5, 4), (8, 8, 12), (10, 10, 24), (15, 15, 24), (8, 4, 12), (6, 12, 24), (100, 100, 4), (100, 100, 12), (100, 100, 24)]:
        rs = [(e['day'], trade(e, side_of(e), S, T, H)) for e in sel]
        g = collections.defaultdict(list)
        for d, r in rs: g[d].append(r)
        m = [st.mean(v) for v in g.values()]
        t = st.mean(m)/(st.stdev(m)/math.sqrt(len(m))) if len(m) > 4 else float('nan')
        days = sorted(g); half = days[len(days)//2]
        h1 = [r for d, r in rs if d < half]; h2 = [r for d, r in rs if d >= half]
        print(f"{label:34s} stop{S:>4} tgt{T:>4} {H:>2}h  n={len(rs):>4}  mean {st.mean(r for _, r in rs):6.2f}%  win {100*sum(r>0 for _, r in rs)/len(rs):3.0f}%  t(day) {t:5.2f}  halves {st.mean(h1):5.2f} / {st.mean(h2):5.2f}")
if __name__ == '__main__':
    for case in ['last-hour-turned', 'day-opposite-only', '3h-turned', 'aligned']:
        for d6, nm in ((1, 'pump'), (-1, 'dump')):
            sel = [e for e in ev if e['case'] == case and e['d6'] == d6 and len(e['path'][0]) == 48]
            if len(sel) < 30: continue
            report(f'FADE {case} {nm}', sel, lambda e: -e['d6'])
            print()
