"""Breakouts and breakdowns away from the market, for the 40 largest coins with
Binance perpetuals, and what came before them.

Asked 2026-09-28, after HBAR rose 31% (UTC day open to 17:00) while the other
large coins fell 4.4%: were
there signs, data, models or techniques that could have predicted it, and
for each big coin, what comes before it breaks out or down away from the
market trend?

Data (fetch_um.py): Binance USD-M hourly bars and 5-minute derivatives
metrics, 2024-09-01 to 2026-09-27. Everything is hourly and known at the
close of the hour it is stamped with.

  market     equal-weight log return of the other coins (the asset excluded)
  excess     the asset's log return less beta x market, beta from the
             trailing 30 days, re-estimated once a day
  event      the next 24 hours' excess move is at least 2.5 of the asset's
             own trailing 24-hour excess sd AND at least 5%: a breakout (up)
             or breakdown (down) away from the market

Early signs, all measured on hours before the one being forecast:
  exc_k      excess return over the last k hours (relative strength)
  mkt_k      the market's return over the last k hours
  vr_k       volume over the last k hours against its own 30-day norm, and
  vrx_k      the same less the median coin's (volume that is the coin's own)
  oi_k       change in open interest in CONTRACTS over k hours (not USD, which
             is mostly price: OI_MEASUREMENT_EVIDENCE.md), and oix_k the same
             less the median coin's
  taker_k    futures taker buy/sell volume ratio against its 30-day norm (z)
  tb_k       taker-buy share of volume against its 30-day norm
  lsacct / lspos / lsall   top-trader and all-account long/short ratios:
             24-hour change, and level against the 30-day norm
  ivol       excess volatility of the last 24 hours against the last 30 days
             (below 1 = a squeeze)
  corrgap    72-hour correlation with the market less the 30-day one
  hidist     distance from the 30-day high, less the median coin's
  peer_k     mean excess return of the asset's three closest peers (by
             excess-return correlation in the discovery year) over k hours
  hbar       the HBAR 2026-09-28 pattern as a rule: in the last 8 hours
             volume at least 2x its norm, open interest up at least 5% in
             contracts, the coin at least 1% ahead of the market while the
             market fell

Discovery: 2024-09-01 to 2025-08-31. Validation: 2025-09-01 to 2026-09-27.
Only relationships that hold in both, with day-clustered inference and
Benjamini-Hochberg across everything tested, are reported as real.
"""
import os, sys, json, math, collections
import numpy as np

DATA = os.environ.get('DC_DATA', '.')
OUT = os.environ.get('DC_OUT', DATA)
START = np.datetime64('2024-09-01T00:00', 'h')
SPLIT = np.datetime64('2025-09-01T00:00', 'h')
H_EVENT = 24
K_SIGMA, MIN_MOVE = 2.5, math.log(1.05)
WIN = 720                       # 30 days of hours


def load(sym):
    z = np.load(os.path.join(DATA, f'{sym}.npz'))
    return z['klines'], z['metrics']


def to_grid(kl, me, n):
    """Hourly arrays on the common grid starting at START."""
    g = lambda: np.full(n, np.nan)
    close, qv, trades, tbq = g(), g(), g(), g()
    hi = ((kl[:, 0].astype('int64') // 3600000) - START.astype('int64')).astype(int)
    ok = (hi >= 0) & (hi < n)
    close[hi[ok]] = kl[ok, 4]; qv[hi[ok]] = kl[ok, 6]; trades[hi[ok]] = kl[ok, 7]; tbq[hi[ok]] = kl[ok, 9]
    # metrics: snapshot at create_time + 5 min belongs to the hour it closes
    oi, ls_acct, ls_pos, ls_all, taker = g(), g(), g(), g(), g()
    snap = me[:, 0].astype('int64') + 300000
    hs = (((snap - 1) // 3600000) - START.astype('int64')).astype(int)
    ok = (hs >= 0) & (hs < n)
    order = np.argsort(snap[ok], kind='stable')
    idx = hs[ok][order]; vals = me[ok][order]
    oi[idx] = vals[:, 1]; ls_acct[idx] = vals[:, 3]; ls_pos[idx] = vals[:, 4]; ls_all[idx] = vals[:, 5]   # last snapshot wins
    # taker ratio is a flow over the 5 minutes starting at create_time
    hf = ((me[:, 0].astype('int64') // 3600000) - START.astype('int64')).astype(int)
    ok = (hf >= 0) & (hf < n) & np.isfinite(me[:, 6]) & (me[:, 6] > 0)
    s = np.zeros(n); c = np.zeros(n)
    np.add.at(s, hf[ok], np.log(me[ok, 6])); np.add.at(c, hf[ok], 1)
    taker = np.where(c > 0, s / np.maximum(c, 1), np.nan)
    return dict(close=close, qv=qv, trades=trades, tbq=tbq, oi=oi, ls_acct=ls_acct, ls_pos=ls_pos, ls_all=ls_all, taker=taker)


def roll_sum(x, k):
    """Sum of the last k values ending at t (inclusive); NaN if any is NaN."""
    c = np.concatenate([[0.0], np.cumsum(np.nan_to_num(x))])
    bad = np.concatenate([[0], np.cumsum(~np.isfinite(x))])
    out = np.full(len(x), np.nan)
    out[k - 1:] = c[k:] - c[:-k]
    nb = np.full(len(x), 1); nb[k - 1:] = bad[k:] - bad[:-k]
    out[nb > 0] = np.nan
    return out


def roll_mean_std(x, k, lag=0):
    """Mean and sd of x over the window of k values ending at t - lag (NaNs skipped, needs k/2)."""
    v = np.where(np.isfinite(x), x, 0.0); m = np.isfinite(x).astype(float)
    c1 = np.concatenate([[0.0], np.cumsum(v)]); c2 = np.concatenate([[0.0], np.cumsum(v * v)]); cn = np.concatenate([[0.0], np.cumsum(m)])
    n = len(x); mean = np.full(n, np.nan); sd = np.full(n, np.nan)
    for t in range(k + lag - 1, n):
        e = t - lag + 1; b = e - k
        cnt = cn[e] - cn[b]
        if cnt >= k / 2:
            mu = (c1[e] - c1[b]) / cnt; var = max((c2[e] - c2[b]) / cnt - mu * mu, 0.0)
            mean[t] = mu; sd[t] = math.sqrt(var * cnt / max(cnt - 1, 1))
    return mean, sd


def build():
    syms = [f[:-4] for f in sorted(os.listdir(DATA)) if f.endswith('.npz')]
    n = int((np.datetime64('2026-09-28T00:00', 'h') - START).astype(int))
    A = {s: to_grid(*load(s), n) for s in syms}
    R = {s: np.concatenate([[np.nan], np.diff(np.log(A[s]['close']))]) for s in syms}
    Rm = np.vstack([R[s] for s in syms])
    tot = np.nansum(Rm, axis=0); cnt = np.sum(np.isfinite(Rm), axis=0)
    hours = START + np.arange(n).astype('timedelta64[h]')
    feats, meta = {}, {}
    for s in syms:
        r = R[s]; a = A[s]
        mkt = np.where(np.isfinite(r), (tot - r) / np.maximum(cnt - 1, 1), tot / np.maximum(cnt, 1))
        mkt = np.where(cnt >= 5, mkt, np.nan)
        # beta: trailing 30 days, refreshed at each day's first hour, applied that day
        beta = np.full(n, np.nan)
        for d0 in range(WIN, n, 24):
            x, y = mkt[d0 - WIN:d0], r[d0 - WIN:d0]; ok = np.isfinite(x) & np.isfinite(y)
            if ok.sum() > WIN / 2 and np.var(x[ok]) > 0:
                beta[d0:d0 + 24] = np.cov(x[ok], y[ok])[0, 1] / np.var(x[ok], ddof=1)
        e = r - beta * mkt
        _, sd_e = roll_mean_std(e, WIN, lag=1)
        f = {}
        for k in (1, 4, 8, 24, 72):
            f[f'exc_{k}'] = roll_sum(e, k)
            f[f'excz_{k}'] = f[f'exc_{k}'] / (sd_e * math.sqrt(k))
        for k in (8, 24):
            f[f'mkt_{k}'] = roll_sum(mkt, k)
        lq = np.log(np.where(a['qv'] > 0, a['qv'], np.nan))
        mq, _ = roll_mean_std(a['qv'], WIN, lag=24)
        for k in (1, 4, 8, 24):
            f[f'vr_{k}'] = np.log(roll_sum(a['qv'], k) / (k * mq))
        oi = np.log(np.where(a['oi'] > 0, a['oi'], np.nan))
        for k in (4, 8, 24, 72):
            f[f'oi_{k}'] = oi - np.concatenate([np.full(k, np.nan), oi[:-k]])
        tk = a['taker']; mt, st = roll_mean_std(tk, WIN, lag=24)
        for k in (4, 8, 24):
            f[f'taker_{k}'] = (roll_sum(tk, k) / k - mt) / st
        tb = a['tbq'] / a['qv']; mb, sb = roll_mean_std(tb, WIN, lag=24)
        for k in (4, 8):
            f[f'tb_{k}'] = (roll_sum(tb, k) / k - mb) / sb
        for name in ('ls_acct', 'ls_pos', 'ls_all'):
            l = np.log(np.where(a[name] > 0, a[name], np.nan))
            f[f'{name}_chg24'] = l - np.concatenate([np.full(24, np.nan), l[:-24]])
            ml, sl = roll_mean_std(l, WIN, lag=0)
            f[f'{name}_z'] = (l - ml) / sl
        v24 = np.sqrt(roll_sum(e * e, 24) / 24)
        f['ivol'] = np.log(v24 / sd_e)
        # correlation gap: 72h vs 30d
        def rcorr(x, y, k):
            xy = roll_sum(x * y, k); xx = roll_sum(x * x, k); yy = roll_sum(y * y, k)
            sx = roll_sum(x, k); sy = roll_sum(y, k)
            cov = xy / k - sx * sy / k ** 2; vx = xx / k - (sx / k) ** 2; vy = yy / k - (sy / k) ** 2
            return cov / np.sqrt(vx * vy)
        f['corrgap'] = rcorr(r, mkt, 72) - rcorr(r, mkt, WIN)
        lc = np.log(a['close'])
        hi30 = np.array([np.nanmax(lc[max(0, t - WIN):t + 1]) if t >= WIN / 2 else np.nan for t in range(n)])
        f['hidist'] = lc - hi30
        fe = roll_sum(e, H_EVENT)
        fwd = {H: np.concatenate([roll_sum(e, H)[H:], np.full(H, np.nan)]) for H in (8, 24, 48)}
        fwdm = np.concatenate([roll_sum(mkt, 24)[24:], np.full(24, np.nan)])
        thr = np.maximum(K_SIGMA * sd_e * math.sqrt(H_EVENT), MIN_MOVE)
        feats[s] = f
        meta[s] = dict(e=e, sd_e=sd_e, fwd=fwd, fwdm=fwdm, thr=thr, mkt=mkt, r=r, close=a['close'])
    # cross-sectional adjustments: volume, OI and high-distance relative to the median coin
    for key, base in (('vrx', 'vr'), ('oix', 'oi')):
        for k in ((1, 4, 8, 24) if base == 'vr' else (4, 8, 24, 72)):
            M = np.vstack([feats[s][f'{base}_{k}'] for s in syms]); med = np.nanmedian(M, axis=0)
            for s in syms: feats[s][f'{key}_{k}'] = feats[s][f'{base}_{k}'] - med
    M = np.vstack([feats[s]['hidist'] for s in syms]); med = np.nanmedian(M, axis=0)
    for s in syms: feats[s]['hidist'] = feats[s]['hidist'] - med
    # peers: three highest excess-return correlations in the discovery year only
    disc = hours < SPLIT
    E = {s: meta[s]['e'] for s in syms}
    peers = {}
    for s in syms:
        cs = []
        for o in syms:
            if o == s: continue
            x, y = E[s][disc], E[o][disc]; ok = np.isfinite(x) & np.isfinite(y)
            if ok.sum() > 2000: cs.append((np.corrcoef(x[ok], y[ok])[0, 1], o))
        peers[s] = [o for _, o in sorted(cs, reverse=True)[:3]]
        for k in (8, 24):
            # a coin too young for peers in the discovery year (HYPE) gets none
            feats[s][f'peer_{k}'] = (np.nanmean(np.vstack([feats[o][f'exc_{k}'] for o in peers[s]]), axis=0)
                                     if peers[s] else np.full(n, np.nan))
    # the HBAR 2026-09-28 pattern, as a rule
    for s in syms:
        f = feats[s]
        f['hbar'] = ((f['vr_8'] >= math.log(2)) & (f['oi_8'] >= math.log(1.05)) & (f['exc_8'] >= 0.01) & (f['mkt_8'] <= -0.01)).astype(float)
        f['hbar'][~np.isfinite(f['vr_8'] + f['oi_8'] + f['exc_8'] + f['mkt_8'])] = np.nan
    return syms, hours, feats, meta, peers


def day_clustered_mean(vals, days):
    """Mean and t-stat with one observation per day (the day's mean)."""
    by = collections.defaultdict(list)
    for v, d in zip(vals, days): by[d].append(v)
    m = np.array([np.mean(v) for v in by.values()])
    if len(m) < 10: return float(np.mean(vals)) if len(vals) else None, None, len(m)
    return float(m.mean()), float(m.mean() / (m.std(ddof=1) / math.sqrt(len(m)))) if m.std(ddof=1) > 0 else None, len(m)


def main():
    syms, hours, feats, meta, peers = build()
    days = hours.astype('datetime64[D]').astype(str)
    names = [k for k in feats[syms[0]] if k != 'hbar']
    halves = {'discovery': hours < SPLIT, 'validation': hours >= SPLIT}
    report = {'symbols': syms, 'peers': peers, 'split': str(SPLIT), 'eventRule': f'next {H_EVENT}h excess >= max({K_SIGMA} sd, 5%)',
              'events': {}, 'pooled': {}, 'perAsset': {}, 'rules': {}}
    # ---- the events themselves
    for s in syms:
        m = meta[s]; up = m['fwd'][24] >= m['thr']; dn = m['fwd'][24] <= -m['thr']; ok = np.isfinite(m['fwd'][24]) & np.isfinite(m['thr'])
        report['events'][s] = {h: {'hours': int((ok & halves[h]).sum()), 'upShare': float(np.mean(up[ok & halves[h]])),
                                   'downShare': float(np.mean(dn[ok & halves[h]]))} for h in halves}
    # ---- pooled univariate: decile lift for up / down events and mean forward excess
    def stack(name, half):
        X, U, D, F, DY, S = [], [], [], [], [], []
        for s in syms:
            m = meta[s]; x = feats[s][name]
            ok = halves[half] & np.isfinite(x) & np.isfinite(m['fwd'][24]) & np.isfinite(m['thr'])
            X.append(x[ok]); U.append(m['fwd'][24][ok] >= m['thr'][ok]); D.append(m['fwd'][24][ok] <= -m['thr'][ok])
            F.append(m['fwd'][24][ok]); DY.append(days[ok]); S.append(np.full(ok.sum(), s))
        return tuple(np.concatenate(v) for v in (X, U, D, F, DY, S))
    for name in names + ['hbar']:
        report['pooled'][name] = {}
        for half in halves:
            X, U, D, F, DY, S = stack(name, half)
            if len(X) < 1000: continue
            if name == 'hbar':
                top = X > 0.5; bot = np.zeros(len(X), bool)
            else:
                # deciles within each asset, so one volatile coin cannot fill the top decile
                top = np.zeros(len(X), bool); bot = np.zeros(len(X), bool)
                for s in syms:
                    k = S == s
                    if k.sum() < 200: continue
                    q1, q9 = np.quantile(X[k], [0.1, 0.9]); top[k] = X[k] >= q9; bot[k] = X[k] <= q1
            res = {'n': int(len(X)), 'upRate': float(U.mean()), 'downRate': float(D.mean())}
            for lab, sel in (('top', top), ('bottom', bot)):
                if sel.sum() < 30: continue
                mm, tt, nd = day_clustered_mean(F[sel], DY[sel])
                res[lab] = {'n': int(sel.sum()), 'days': nd, 'upLift': float(U[sel].mean() / U.mean()) if U.mean() else None,
                            'downLift': float(D[sel].mean() / D.mean()) if D.mean() else None,
                            'fwdExcessMean': mm, 'fwdExcessT': tt}
            report['pooled'][name][half] = res
    json.dump(report, open(os.path.join(OUT, 'decoupling_report.json'), 'w'), indent=1, default=float)
    np.savez_compressed(os.path.join(OUT, 'decoupling_panel.npz'), **{f'{s}|{k}': v for s in syms for k, v in feats[s].items()},
                        **{f'{s}|fwd24': meta[s]['fwd'][24] for s in syms}, **{f'{s}|thr': meta[s]['thr'] for s in syms},
                        **{f'{s}|fwd8': meta[s]['fwd'][8] for s in syms}, **{f'{s}|fwd48': meta[s]['fwd'][48] for s in syms},
                        **{f'{s}|fwdm24': meta[s]['fwdm'] for s in syms}, **{f'{s}|close': meta[s]['close'] for s in syms},
                        **{f'{s}|e': meta[s]['e'] for s in syms}, **{f'{s}|sd_e': meta[s]['sd_e'] for s in syms},
                        hours=hours.astype('int64'))
    print('saved', flush=True)


if __name__ == '__main__':
    main()
