"""Checks cadence_study.py on synthetic assets with known answers:
  - a random walk with fat tails and volatility clustering shows no rhythm
    (its z-scores behave like noise)
  - mean reversion, a planted cycle, a planted hour-of-day drift and a planted
    turn-of-month drift are each found
  - the zigzag reads nothing from the future
usage: CAD_SURROGATES=100 python test_cadence.py"""
import os, sys
os.environ.setdefault('CAD_SURROGATES', '100')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import cadence_study as cs

H = 3600000
fails = 0
def check(name, ok, detail=''):
    global fails
    print(('  PASS  ' if ok else '  FAIL  ') + name + ('' if ok else f'  {detail}'))
    fails += 0 if ok else 1

rng = np.random.default_rng(7)
def garch_returns(n, base=0.006):
    r = np.empty(n); v = base ** 2
    for i in range(n):
        v = base ** 2 * 0.05 + 0.9 * v + 0.05 * (r[i - 1] ** 2 if i else v)
        r[i] = np.sqrt(v) * rng.standard_t(4) / np.sqrt(2)
    return r

T0 = int(np.datetime64('2024-09-01T00:00', 'ms').astype(np.int64))
n = 18000
times = T0 + H * np.arange(n + 1, dtype=np.int64)
def hourly_job(r, name):
    return ('hourly', name, 'crypto', times[:len(r) + 1], 100 * np.exp(np.r_[0, np.cumsum(r)]), 11)

print('== a random walk has no rhythm ==')
zs = []
for k in range(3):
    out = cs.analyze(hourly_job(garch_returns(n), f'RW{k}'))
    for key, t in out['tests'].items():
        for p in ('disc', 'val'):
            if p in t and t[p]['z'] is not None and key != 'cycle_carry': zs.append(t[p]['z'])
zs = np.array(zs)
check(f'z-scores look like noise (share |z| > 2: {np.mean(np.abs(zs) > 2):.3f} of {len(zs)})', np.mean(np.abs(zs) > 2) < 0.1 and abs(np.mean(zs)) < 0.3,
      f'mean {np.mean(zs):.2f}')

print('== mean reversion is found ==')
e = garch_returns(n); r = np.empty(n); r[0] = e[0]
for i in range(1, n): r[i] = -0.2 * r[i - 1] + e[i]
out = cs.analyze(hourly_job(r, 'AR'))
z1 = out['tests']['serial_rho_1']
check('1-hour reversal: strongly negative z in both periods', z1['disc']['z'] < -5 and z1['val']['z'] < -5, str(z1))
check('fading the last hour pays (negative momentum P&L)', out['tests']['serial_pnl_1']['disc']['real'] < 0)

print('== a planted 4-day cycle is found ==')
t = np.arange(n + 1)
lp = np.cumsum(np.r_[0, garch_returns(n, 0.004)]) + 0.04 * np.sin(2 * np.pi * t / 96)
out = cs.analyze(('hourly', 'CYC', 'crypto', times, 100 * np.exp(lp), 11))
check('Fisher g far above its surrogates in both periods', out['tests']['cycle_g']['disc']['z'] > 5 and out['tests']['cycle_g']['val']['z'] > 5, str(out['tests']['cycle_g']))
check('the dominant period is about 96 hours in both', all(abs(p - 96) < 8 for p in out['info']['cycle_period']), str(out['info']['cycle_period']))
check('the first period\'s cycle carries into the second', out['tests']['cycle_carry']['val']['z'] > 5, str(out['tests']['cycle_carry']))
check('swing lengths are more regular than chance at some size (lower CV)', min(out['tests'][f'swing{k}_cv']['disc']['z'] for k in (0.5, 1.0, 2.0)) < -3,
      str({k: out['tests'][f'swing{k}_cv']['disc']['z'] for k in (0.5, 1.0, 2.0)}))

print('== a planted hour-of-day drift is found ==')
r = garch_returns(n)
hod = ((times[1:] // H) % 24)
r = r + np.where(hod == 14, 0.002, 0) - np.where(hod == 2, 0.002, 0)
out = cs.analyze(hourly_job(r, 'HOD'))
check('hour-of-day joint test far above surrogates', out['tests']['cal_hour_of_day']['disc']['z'] > 5, str(out['tests']['cal_hour_of_day']))
bps = out['info']['cal_hour_of_day_bps'][0]
check('and it names the right hours', int(np.argmax(bps)) == 14 and int(np.argmin(bps)) == 2, str(bps))

print('== a planted turn-of-month drift is found (daily) ==')
d0 = np.datetime64('2021-01-01', 'D').astype(np.int64)
nd = 2000
days = d0 + np.arange(nd + 1)
r = garch_returns(nd, 0.03)
ym = days[1:].astype('datetime64[D]').astype('datetime64[M]')
first = np.r_[True, ym[1:] != ym[:-1]]
r = r + np.where(first, 0.06, 0)
out = cs.analyze(('daily', 'TOM', 'crypto', days, 100 * np.exp(np.r_[0, np.cumsum(r)]), 5))
check('turn of the month found in both periods', out['tests']['cal_turn_of_month']['disc']['z'] > 3 and out['tests']['cal_turn_of_month']['val']['z'] > 3,
      str(out['tests']['cal_turn_of_month']))

print('== the zigzag reads nothing from the future ==')
lp = np.cumsum(garch_returns(3000))[None, :].repeat(2, axis=0)
theta = np.full(3000, 0.01)
D1, A1, P1, _ = cs.zigzag(lp, theta, 10)
D2, A2, P2, _ = cs.zigzag(lp[:, :2000], theta[:2000], 10)
check('states up to bar 2000 are identical with or without the later bars',
      np.array_equal(D1[:, :2000], D2) and np.array_equal(A1[:, :2000], A2) and np.allclose(P1[:, :2000], P2))

print('== pumps: no false drift on a random walk, and a planted one is found ==')
import cadence_episodes as ce
def ep_z(out, stat):
    names = ce.stat_names('hourly'); k = names.index(stat)
    zs = []
    for q in (0, 1):
        sm, ct = out[0, q, k, 0], out[0, q, k, 1]
        v = sm / np.maximum(ct, 1)
        zs.append((v[0] - v[1:].mean()) / v[1:].std(ddof=1))
    return zs
rw = [ce.episodes(hourly_job(garch_returns(n), f'E{k}'))[2] for k in range(2)]
zz = [z for o in rw for st in ('fwd_24', 'fwd_72', 'second', 'dip') for z in ep_z(o, st)]
check(f'random walk: pump statistics look like noise (max |z| {max(abs(z) for z in zz):.1f})', max(abs(z) for z in zz) < 3.5)
r = garch_returns(n); lp = np.r_[0, np.cumsum(r)]; out_r = r.copy()
sig = np.sqrt(np.convolve(r ** 2, np.ones(720) / 720, 'full')[:n] * 24)
i = 800
while i < n - 30:
    if lp[i + 1] - lp[max(0, i - 23)] >= 3 * sig[i]:
        out_r[i + 1:i + 25] += 0.004; lp = np.r_[0, np.cumsum(out_r)]; i += 72
    i += 1
o = ce.episodes(hourly_job(out_r, 'DRIFT'))[2]
z24 = ep_z(o, 'fwd_24')
check('a planted post-pump drift is found in both periods', min(z24) > 3, str(z24))

print('== class-wide tests: shared signs keep co-movement, stay calibrated, and still find a real class effect ==')
def class_z(A=20, T=1600, phi=0.0, seed=0):
    g = np.random.default_rng(seed)
    f = g.standard_t(4, T) * 0.02
    Rm = 0.8 * f[None, :] + g.standard_t(4, (A, T)) * 0.015
    if phi:
        for i in range(A):
            for t in range(1, T): Rm[i, t] += phi * Rm[i, t - 1]
    period = (np.arange(T) >= T // 2).astype(np.int8)
    signs = g.integers(0, 2, size=(cs.S, T), dtype=np.int8) * 2 - 1
    paths = [cs.surrogate_paths(Rm[i], i, signs) for i in range(A)]
    k0 = np.corrcoef(paths[0][1], paths[1][1])[0, 1]; k_real = np.corrcoef(Rm[0], Rm[1])[0, 1]
    v = np.mean([cs.serial_stats(P, period, 1)[0][1] for P in paths], axis=0)
    return (v[0] - v[1:].mean()) / v[1:].std(ddof=1), k0, k_real
null = [class_z(seed=s) for s in range(20)]
zs = np.array([x[0] for x in null])
check(f'surrogates keep the assets\' co-movement (corr {null[0][1]:.2f} vs real {null[0][2]:.2f})', abs(null[0][1] - null[0][2]) < 0.05)
check(f'no rhythm: class z behaves like noise (sd {zs.std():.2f}, max |z| {np.abs(zs).max():.1f})', 0.6 < zs.std() < 1.5 and np.abs(zs).max() < 3.5)
zp = [class_z(phi=-0.08, seed=100 + s)[0] for s in range(3)]
check(f'a small planted class-wide reversal is found (z {np.round(zp, 1).tolist()})', max(zp) < -2.5)

print('\nCADENCE TESTS ' + ('OK' if not fails else f'{fails} FAILED'))
sys.exit(1 if fails else 0)
