"""Is there a rhythm or cadence in how each asset moves that a swing trader
could use? Asked 2026-09-28: "look for some sort of rhythm or cadence in the
way each asset moves, on regular days, during pumps, breakdown, etc. if any
seem to have a cadence, we can use that to swing trade".

Every statistic is computed on the asset's real returns AND on S surrogates:
the same returns with their signs randomized around the mean. A surrogate
keeps everything about the SIZE of moves (fat tails, calm and wild spells,
quiet weekends, the busy US open) and removes everything about DIRECTION. A
random walk draws convincing swings and cycles; the surrogates draw exactly
those, so a rhythm counts only where the real asset beats its own surrogates.
Each result is a z-score against them, first period and second period
separately:

  hourly (38 largest coins, spot)  2024-09 to 2025-08, then 2025-09 to 2026-09
  daily (450 series)               2021-01 to 2023-12, then 2024-01 to 2026-09

Tests, per asset:
  serial     does the last h-move predict the next h-move? corr and the
             gross P&L of following it (momentum) or fading it (reversal)
  cycle      the strongest repeating period in volatility-scaled returns
             (Fisher's g), and whether the first period's dominant cycle is
             still there in the second
  swing      a zigzag at three sizes, read in real time (no hindsight):
               mom      does a swing in progress keep going?
               age      do old swings turn more than young ones (a cadence)?
               pullback does buying a deep pullback within a swing pay?
             and from completed swings: how regular their lengths are (CV),
             whether long and short swings alternate, and whether retracements
             cluster at the Fibonacci levels (0.382, 0.5, 0.618)
  calendar   hour of day and day of week (joint tests), turn of the month,
             and the monthly options-expiry week

usage: CAD_DATA=/data/cad [CAD_SURROGATES=200] python cadence_study.py [hourly|daily|all]
writes CAD_DATA/cadence_<res>.jsonl, one line per asset"""
import json, math, os, sys, zlib
from concurrent.futures import ProcessPoolExecutor
import numpy as np

CAD = os.environ.get('CAD_DATA', '.')
S = int(os.environ.get('CAD_SURROGATES', 200))
H_MS = 3600000
HOURLY_SPLIT = int(np.datetime64('2025-09-01T00:00', 'ms').astype(np.int64))
DAILY_SPLIT = np.datetime64('2024-01-01', 'D').astype(np.int64)
FIB = np.array([0.382, 0.5, 0.618])
# Not price series in any tradable sense: JPYC is pegged to the yen, and Binance's
# SUN pair jumped ~840x in a day when the token was swapped 1,000 to 1 (2021).
EXCLUDE = {'JPYC', 'SUN'}

CFG = {
    'hourly': dict(horizons=[1, 2, 4, 8, 12, 24, 48, 72, 168], band=(3, 336), ewma_hl=24, vol_win=720, per_day=24,
                   scales=[(0.5, 12), (1.0, 24), (2.0, 72)]),
    'daily': dict(horizons=[1, 2, 3, 5, 10, 20, 40, 60], band=(3, 120), ewma_hl=10, vol_win=30, per_day=1,
                  scales=[(1.0, 3), (2.0, 5), (4.0, 10)]),
}


def surrogate_paths(r, seed, signs=None):
    """Row 0 the real returns, rows 1..S sign-randomized around the mean. Pass
    `signs` (S x len(r), +-1) to share one sign draw across assets: flipping
    every asset the same way at the same time keeps their co-movement, which
    is the right null for a class-wide test."""
    rng = np.random.default_rng(seed)
    m = np.nanmean(r)
    out = np.empty((S + 1, len(r)))
    out[0] = r
    if signs is None:
        signs = rng.integers(0, 2, size=(S, len(r)), dtype=np.int8) * 2 - 1
        out[1:] = m + signs * np.abs(r - m)
    else:
        # Shared draws flip each asset's SIGNED move, so two assets that moved
        # together still move together and two that moved apart still do.
        # (Flipping |move| instead would make every asset move the same way at
        # the same time: a null far too wide. With independent draws the two
        # forms are the same in distribution.)
        out[1:] = m + signs * (r - m)
    out[:, ~np.isfinite(r)] = 0.0          # a missing bar is a flat bar, in every path
    return out


def zscore(vals):
    """vals: (S+1,) or (S+1, k); z of row 0 against rows 1..S"""
    sur = vals[1:]
    mu = np.nanmean(sur, axis=0); sd = np.nanstd(sur, axis=0, ddof=1)
    with np.errstate(invalid='ignore', divide='ignore'):
        z = (vals[0] - mu) / sd
    return vals[0], mu, sd, z


def pack(real, mu, sd, z):
    f = lambda x: None if x is None or not np.isfinite(x) else round(float(x), 6)
    return {'real': f(real), 'mu': f(mu), 'sd': f(sd), 'z': f(z)}


# ---------------------------------------------------------------- serial
def serial_stats(R, period, h):
    """R: (P, T) returns. corr and mean sign(past)*future for h-bar blocks, per period."""
    P, T = R.shape
    c = np.concatenate([np.zeros((P, 1)), np.cumsum(R, axis=1)], axis=1)       # c[:, t] = sum r[:t]
    t = np.arange(h, T - h + 1)                                               # past = r[t-h:t], future = r[t:t+h]
    past = c[:, t] - c[:, t - h]; fut = c[:, t + h] - c[:, t]
    per_past = period[t - h]; per_fut = period[t + h - 1]
    out = {}
    for p in (0, 1):
        sel = (per_past == p) & (per_fut == p)
        if sel.sum() < 50: out[p] = (np.full(P, np.nan), np.full(P, np.nan)); continue
        x, y = past[:, sel], fut[:, sel]
        xm = x - x.mean(axis=1, keepdims=True); ym = y - y.mean(axis=1, keepdims=True)
        rho = (xm * ym).sum(axis=1) / np.sqrt((xm ** 2).sum(axis=1) * (ym ** 2).sum(axis=1))
        pnl = (np.sign(x) * y).mean(axis=1)
        out[p] = (rho, pnl)
    return out


# ---------------------------------------------------------------- cycle
def ewma_sd(a2, hl):
    lam = 0.5 ** (1 / hl)
    out = np.empty_like(a2); v = np.nanmean(a2[:min(len(a2), 5 * hl)])
    for i, x in enumerate(a2):
        out[i] = v                                        # known before bar i
        if np.isfinite(x): v = lam * v + (1 - lam) * x
    return np.sqrt(out)


def cycle_stats(R, period, sd, band):
    """Fisher's g within the band of periods (bars), the dominant period, and the
    first period's dominant cycle's power in the second period."""
    res = {}
    Z = R / sd[None, :]
    dom = {}
    for p in (0, 1):
        x = Z[:, period == p]
        x = x - x.mean(axis=1, keepdims=True)
        N = x.shape[1]
        I = np.abs(np.fft.rfft(x, axis=1)) ** 2
        k = np.arange(I.shape[1])
        with np.errstate(divide='ignore'):
            per = np.where(k > 0, N / np.maximum(k, 1), np.inf)
        inb = (per >= band[0]) & (per <= band[1])
        Ib = I[:, inb]
        g = Ib.max(axis=1) / Ib.sum(axis=1)
        dom[p] = (per[inb][Ib.argmax(axis=1)], I, per, inb)
        res[p] = g
    # does the first period's strongest cycle carry into the second?
    per0 = dom[0][0]                                           # (P,) dominant period of each path in period 1
    I1, per1, inb1 = dom[1][1], dom[1][2], dom[1][3]
    kk = np.array([np.argmin(np.abs(np.where(inb1, per1, np.inf) - pp)) for pp in per0])
    rel = I1[np.arange(I1.shape[0]), kk] / I1[:, inb1].mean(axis=1)
    return res, dom[0][0][0], dom[1][0][0], rel


# ---------------------------------------------------------------- swing
def zigzag(lp, theta, start):
    """Real-time zigzag on (P, T) log prices. theta: (T,) reversal size in log units.
    Returns per-bar state (direction, age in bars since the leg's first pivot,
    pullback from the running extreme in thetas) and each path's completed legs."""
    P, T = lp.shape
    d = np.ones(P, dtype=np.int8)
    lext = lp[:, start].copy(); text = np.full(P, start); tstart = np.full(P, start); lstart = lp[:, start].copy()
    D = np.zeros((P, T), dtype=np.int8); AGE = np.zeros((P, T), dtype=np.int32); PB = np.zeros((P, T), dtype=np.float32)
    legs = [[] for _ in range(P)]
    for t in range(start, T):
        x = lp[:, t]; th = theta[t]
        up = d == 1
        new = (up & (x > lext)) | (~up & (x < lext))
        lext = np.where(new, x, lext); text = np.where(new, t, text)
        rev = (up & (x <= lext - th)) | (~up & (x >= lext + th))
        if rev.any():
            for i in np.nonzero(rev)[0]:
                legs[i].append((int(tstart[i]), int(text[i]), float(lext[i] - lstart[i])))
            tstart = np.where(rev, text, tstart); lstart = np.where(rev, lext, lstart)
            d = np.where(rev, -d, d).astype(np.int8)
            lext = np.where(rev, x, lext); text = np.where(rev, t, text)
        D[:, t] = d; AGE[:, t] = t - tstart
        PB[:, t] = d * (lext - x) / th
    return D, AGE, PB, legs


def swing_stats(lp, theta, period, start, h, age_cuts=None):
    P, T = lp.shape
    D, AGE, PB, legs = zigzag(lp, theta, start)
    t = np.arange(start, T - h)
    F = D[:, t] * (lp[:, t + h] - lp[:, t])
    per_t = period[t]; per_f = period[t + h]
    age = AGE[:, t]; pb = PB[:, t]
    if age_cuts is None:
        sel0 = (per_t == 0) & (per_f == 0)
        age_cuts = (np.percentile(age[0, sel0], 25), np.percentile(age[0, sel0], 75))
    out = {}
    for p in (0, 1):
        sel = (per_t == p) & (per_f == p)
        f, a, b = F[:, sel], age[:, sel], pb[:, sel]
        def cmean(mask):
            n = mask.sum(axis=1)
            return np.where(n >= 20, (f * mask).sum(axis=1) / np.maximum(n, 1), np.nan)
        mom = f.mean(axis=1)
        age_slope = cmean(a >= age_cuts[1]) - cmean(a <= age_cuts[0])
        pb_slope = cmean(b >= 0.5) - cmean(b < 0.25)
        # completed legs ending in this period
        cv = np.full(P, np.nan); alt = np.full(P, np.nan); fib = np.full(P, np.nan); med = np.full(P, np.nan); nlegs = np.zeros(P)
        for i in range(P):
            L = [x for x in legs[i] if period[x[1]] == p]
            if len(L) < 12: continue
            dur = np.array([x[1] - x[0] for x in L], float); size = np.abs(np.array([x[2] for x in L]))
            nlegs[i] = len(L); cv[i] = dur.std() / dur.mean(); med[i] = np.median(dur)
            alt[i] = np.corrcoef(dur[:-1], dur[1:])[0, 1]
            ratio = size[1:] / np.maximum(size[:-1], 1e-12)
            fib[i] = np.mean(np.min(np.abs(ratio[:, None] - FIB[None, :]), axis=1) <= 0.03)
        out[p] = dict(mom=mom, age=age_slope, pullback=pb_slope, cv=cv, alt=alt, fib=fib, med=med, nlegs=nlegs)
    return out, age_cuts


# ---------------------------------------------------------------- calendar
def calendar_stats(R, period, cells, ncell):
    """Joint test of per-cell mean returns: Q = sum over cells of the cell mean's
    z against the surrogates; and the strongest cell."""
    res = {}
    for p in (0, 1):
        sel = period == p
        x = R[:, sel]; c = cells[sel]
        means = np.stack([x[:, c == k].mean(axis=1) if (c == k).sum() >= 10 else np.full(R.shape[0], np.nan) for k in range(ncell)], axis=1)
        mu = np.nanmean(means[1:], axis=0); sd = np.nanstd(means[1:], axis=0, ddof=1)
        zc = (means - mu) / sd
        Q = np.nansum(zc ** 2, axis=1)
        res[p] = (Q, zc[0], means[0] - np.nanmean(means[0]))
    return res


def indicator_stats(R, period, ind):
    out = {}
    for p in (0, 1):
        sel = period == p
        x = R[:, sel]; m = ind[sel]
        out[p] = x[:, m].mean(axis=1) - x[:, ~m].mean(axis=1) if m.sum() >= 10 and (~m).sum() >= 10 else np.full(R.shape[0], np.nan)
    return out


# ---------------------------------------------------------------- one asset
def analyze(job):
    res_kind, sym, cls, times, close, seed = job
    cfg = CFG[res_kind]
    lc = np.log(close)
    r = np.diff(lc); tt = times[1:]
    period = (tt >= (HOURLY_SPLIT if res_kind == 'hourly' else DAILY_SPLIT)).astype(np.int8)
    if min((period == 0).sum(), (period == 1).sum()) < (2000 if res_kind == 'hourly' else 250):
        return None
    R = surrogate_paths(r, seed)
    m = np.nanmean(r); a2 = (np.where(np.isfinite(r), r, m) - m) ** 2
    out = {'symbol': sym, 'cls': cls, 'res': res_kind, 'n': [int((period == 0).sum()), int((period == 1).sum())], 'tests': {}, 'info': {}}
    T = out['tests']

    def put(key, arr0, arr1, extra=None):
        for p, arr in ((0, arr0), (1, arr1)):
            real, mu, sd, z = zscore(arr)
            T.setdefault(key, {})['disc' if p == 0 else 'val'] = pack(real, mu, sd, z)

    # serial dependence
    for h in cfg['horizons']:
        s = serial_stats(R, period, h)
        put(f'serial_rho_{h}', s[0][0], s[1][0]); put(f'serial_pnl_{h}', s[0][1], s[1][1])

    # cycles
    sd = ewma_sd(a2, cfg['ewma_hl'])
    g, dom0, dom1, carry = cycle_stats(R, period, sd, cfg['band'])
    put('cycle_g', g[0], g[1])
    real, mu, sdv, z = zscore(carry)
    T['cycle_carry'] = {'val': pack(real, mu, sdv, z)}
    out['info']['cycle_period'] = [round(float(dom0), 1), round(float(dom1), 1)]

    # swings at three sizes; theta from the trailing volatility (sign-free, so the same for every path)
    w = cfg['vol_win']
    csum = np.concatenate([[0.0], np.cumsum(a2)])
    idx = np.arange(len(r))
    lo = np.maximum(idx - w, 0)
    var = np.where(idx >= w, (csum[idx] - csum[lo]) / np.maximum(idx - lo, 1), np.nan)   # bars t-w .. t-1
    sig_day = np.sqrt(var * cfg['per_day'])
    LP = lc[0] + np.concatenate([np.zeros((R.shape[0], 1)), np.cumsum(R, axis=1)], axis=1)[:, 1:]   # log price after each return
    start = w
    for k, h in cfg['scales']:
        theta = k * sig_day
        st, cuts = swing_stats(LP, theta, period, start, h)
        for key in ('mom', 'age', 'pullback', 'cv', 'alt', 'fib'):
            put(f'swing{k}_{key}', st[0][key], st[1][key])
        out['info'][f'swing{k}'] = {'median_leg_bars': [float(np.round(st[p]['med'][0], 1)) if np.isfinite(st[p]['med'][0]) else None for p in (0, 1)],
                                   'legs': [int(st[p]['nlegs'][0]) for p in (0, 1)], 'age_cuts': [float(c) for c in cuts], 'horizon': h}

    # calendar
    if res_kind == 'hourly':
        hod = ((tt // H_MS) % 24).astype(int)
        dow = (((tt // (24 * H_MS)) + 3) % 7).astype(int)      # 1970-01-01 was a Thursday: 0 = Monday
        for name, cells, n in (('hour_of_day', hod, 24), ('weekday', dow, 7)):
            cs = calendar_stats(R, period, cells, n)
            put(f'cal_{name}', cs[0][0], cs[1][0])
            out['info'][f'cal_{name}_bps'] = [[round(float(x) * 1e4, 2) for x in cs[p][2]] for p in (0, 1)]
    else:
        days = tt.astype('datetime64[D]')
        dow = ((tt + 3) % 7).astype(int)                      # 0 = Monday
        ncell = 7 if cls != 'stock' else 5
        if cls == 'stock' or sym == 'SPY':
            dow = np.clip(dow, 0, 4)
        cs = calendar_stats(R, period, dow, ncell)
        put('cal_weekday', cs[0][0], cs[1][0])
        out['info']['cal_weekday_bps'] = [[round(float(x) * 1e4, 2) for x in cs[p][2]] for p in (0, 1)]
        # turn of the month: the last bar of a month and the first three of the next
        ym = days.astype('datetime64[M]')
        first = np.r_[True, ym[1:] != ym[:-1]]
        last = np.r_[ym[1:] != ym[:-1], False]
        rank_in_month = np.zeros(len(tt), int); cnt = 0
        for i in range(len(tt)):
            cnt = 0 if first[i] else cnt + 1; rank_in_month[i] = cnt
        tom = last | (rank_in_month <= 2)
        s = indicator_stats(R, period, tom); put('cal_turn_of_month', s[0], s[1])
        # options-expiry week: stocks the week of the third Friday; crypto the week
        # of the month's last Friday (Deribit). Each bar's week is named by its Friday.
        wd = ((tt + 3) % 7).astype(int)
        fri = days + (4 - wd).astype('timedelta64[D]')
        fri_dom = (fri - fri.astype('datetime64[M]').astype('datetime64[D]')).astype(int) + 1
        if cls == 'stock' or sym == 'SPY':
            opex = (fri_dom >= 15) & (fri_dom <= 21)
        else:
            opex = (fri + np.timedelta64(7, 'D')).astype('datetime64[M]') != fri.astype('datetime64[M]')
        s = indicator_stats(R, period, opex); put('cal_expiry_week', s[0], s[1])
    return out


def jobs(kind):
    if kind == 'hourly':
        z = np.load(os.path.join(CAD, 'hourly.npz'))
        t = z['t0'] + H_MS * np.arange(z['close'].shape[1], dtype=np.int64)
        for j, s in enumerate(z['syms']):
            c = z['close'][j]
            ok = np.isfinite(c)
            first = np.argmax(ok)
            c = c[first:].copy(); tt = t[first:]
            for i in range(1, len(c)):                       # a missing hour carries the last close
                if not np.isfinite(c[i]): c[i] = c[i - 1]
            yield ('hourly', str(s), 'crypto', tt, c, zlib.crc32(f'h|{s}'.encode()))
    else:
        z = np.load(os.path.join(CAD, 'daily.npz'))
        for s, c in zip(z['syms'], z['cls']):
            if str(s) in EXCLUDE: continue
            yield ('daily', str(s), str(c), z[f'{s}|date'], z[f'{s}|close'], zlib.crc32(f'd|{s}'.encode()))


if __name__ == '__main__':
    kinds = ['hourly', 'daily'] if len(sys.argv) < 2 or sys.argv[1] == 'all' else [sys.argv[1]]
    for kind in kinds:
        path = os.path.join(CAD, f'cadence_{kind}.jsonl')
        done = set()
        if os.path.exists(path):
            done = {json.loads(l)['symbol'] for l in open(path)}
        todo = [j for j in jobs(kind) if j[1] not in done]
        print(f'{kind}: {len(todo)} to run ({len(done)} done)', flush=True)
        with ProcessPoolExecutor(int(os.environ.get('CAD_WORKERS', 6))) as ex, open(path, 'a') as fo:
            for k, res in enumerate(ex.map(analyze, todo, chunksize=1)):
                if res: fo.write(json.dumps(res) + '\n'); fo.flush()
                if (k + 1) % 25 == 0: print(f'  {k + 1}/{len(todo)}', flush=True)
