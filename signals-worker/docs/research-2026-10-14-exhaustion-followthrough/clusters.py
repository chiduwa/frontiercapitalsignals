"""E. Where do positions cluster, and do the implied liquidation bands tell where squeezes go?

Binance does not publish entry prices or liquidation levels; this estimates them the way
liquidation "heatmaps" do, from public 5-minute data only, at checkpoint Tc:
  * every 5m step from Tc-48h to Tc where open interest rose = new positions opened at that
    step's price (OI value / OI); a fall in OI closes positions pro rata (no FIFO is knowable)
  * each new contract has a long and a short; the short side is weighted by the share of
    accounts short at that moment (all-account long/short ratio), the long side likewise
  * liquidation: short opened at p -> p * (1 + 1/L - mm), long -> p * (1 - 1/L + mm), mm 1.3%
    (10x shorts then sit ~8.7% above entry, the distance the owner's NEAR/RED liquidations
    showed); positions whose level the 5m price path already crossed are removed
  * the map: surviving liquidation notional per 1% band of distance from the checkpoint price,
    as a share of current open interest notional

Tests, from the checkpoint close, spot hourly highs/lows for the next 24 hours:
  T1 magnet     P(price reaches band j) vs the fuel in band j, at the SAME distance (distance
                fixed effects, linear probability, clustered by alert day)
  T2 cascade    given band j is reached, P(price also reaches j+3%) vs fuel in band j
  T3 top        given band j is reached, P(the 24h high stops inside [j, j+2%)) vs fuel in j
  plus summary variables per alert (fuel above within 15%, share of shorts in profit/loss,
  short cost basis vs price) in the quintile format of rules.py
Output: RAW/clusters.parquet (per alert x checkpoint x band), RAW/cluster_feats.parquet
"""
import os, sys
import numpy as np, pandas as pd
import statsmodels.api as sm
sys.path.insert(0, os.path.dirname(__file__))
from common import load, RAW, pct
from paths import grid, G0, H

MM = 0.013
LEVS = (10, 20)
BANDS = np.arange(1, 31)            # 1% bands, 1..30% from the checkpoint price
KS = (1, 4, 12)
M5 = 300_000


def build_map(t, oi, px, gls, Tc, L, side):
    """Surviving liquidation notional by distance band from the price at Tc.
    side +1 = shorts (levels above), -1 = longs (levels below)."""
    i0, i1 = np.searchsorted(t, Tc - 48 * H), np.searchsorted(t, Tc, side='right')
    if i1 - i0 < 300:
        return None
    t_, oi_, px_, g_ = t[i0:i1], oi[i0:i1], px[i0:i1], gls[i0:i1]
    d = np.diff(oi_)
    # pro-rata survival: cumulative product of (OI after / OI before) over falling steps
    fac = np.where(d < 0, oi_[1:] / oi_[:-1], 1.0)
    S = np.concatenate([[1.0], np.cumprod(fac)])
    add = np.where(d > 0, d, 0.0)
    ent = np.flatnonzero(add > 0) + 1                       # step where the new OI first shows
    if len(ent) == 0:
        return None
    share = 1 / (1 + g_[ent]) if side == 1 else g_[ent] / (1 + g_[ent])
    share = np.where(np.isfinite(share), share, 0.5)
    mass = add[ent - 1] * (S[-1] / S[ent]) * share * px_[ent]          # notional, USDT
    lvl = px_[ent] * (1 + side * (1 / L - MM))
    # removed if the path after entry already crossed the level
    if side == 1:
        runmax = np.maximum.accumulate(px_[::-1])[::-1]                 # max from step i to now
        alive = runmax[np.minimum(ent + 1, len(px_) - 1)] < lvl
    else:
        runmin = np.minimum.accumulate(px_[::-1])[::-1]
        alive = runmin[np.minimum(ent + 1, len(px_) - 1)] > lvl
    P = px_[-1]
    dist = side * (lvl / P - 1) * 100                                  # % beyond the price
    oin = oi_[-1] * P
    out = np.zeros(len(BANDS))
    ok = alive & (dist > 0) & (dist < BANDS[-1])
    np.add.at(out, np.floor(dist[ok]).astype(int), mass[ok] / oin)
    # summary: share of surviving OI-build shorts (side=+1) or longs in loss; cost basis
    m_all = add[ent - 1] * (S[-1] / S[ent])
    basis = np.sum(m_all * px_[ent]) / np.sum(m_all) / P - 1
    in_loss = np.sum(m_all * (px_[ent] < P if side == 1 else px_[ent] > P)) / np.sum(m_all)
    built = np.sum(add) / oi_[-1]
    return out, basis, in_loss, built


def main():
    D = load()
    A = D[(D.k == 0) & D['first'] & D.has_perp & D.period.isin(['disc', 'val'])][['symbol', 'ts', 'perp', 'period', 'day']]
    rows, feats = [], []
    for perp, g in A.groupby('perp'):
        fn = os.path.join(RAW, f'metrics5m/{perp}.parquet')
        if not os.path.exists(fn):
            continue
        m = pd.read_parquet(fn)
        if m.empty:
            continue
        m = m[(m.oi > 0) & np.isfinite(m.px)]
        t, oi, px, gls = m.t.values, m.oi.values, m.px.values, m.gls.values.astype(float)
        sym = g.symbol.iloc[0]
        G = grid(pd.read_parquet(os.path.join(RAW, f'spot1h/{sym}.parquet')))
        c, hi, lo = G['close'], G['high'], G['low']
        for r in g.itertuples():
            a = int((r.ts.value // 10**6 - G0) // H)
            T0 = r.ts.value // 10**6 + H
            for k in KS:
                b = a + k
                Tc = T0 + k * H
                if b + 24 >= len(c) or not (c[b] > 0):
                    continue
                # perp snapshot must be fresh at the checkpoint
                j = np.searchsorted(t, Tc, side='right') - 1
                if j < 0 or Tc - t[j] > 15 * 60_000:
                    continue
                hseg, lseg = hi[b + 1:b + 25], lo[b + 1:b + 25]
                if np.isnan(hseg).mean() > 0.2:
                    continue
                up24 = (np.nanmax(hseg) / c[b] - 1) * 100
                dn24 = (1 - np.nanmin(lseg) / c[b]) * 100
                f = {'symbol': sym, 'ts': r.ts, 'k': k, 'period': r.period, 'day': r.day, 'up24': up24, 'dn24': dn24}
                for L in LEVS:
                    S_ = build_map(t, oi, px, gls, Tc, L, +1)
                    Lg = build_map(t, oi, px, gls, Tc, L, -1)
                    if S_ is None or Lg is None:
                        continue
                    smap, basis, sh_loss, built = S_
                    lmap, _, lg_loss, _ = Lg
                    f.update({f'sfuel15_{L}': smap[:15].sum(), f'lfuel15_{L}': lmap[:15].sum(),
                              f'short_basis': basis, f'shorts_in_loss': sh_loss, f'longs_in_loss': lg_loss, 'oi_built48': built})
                    if smap.sum() > 0:
                        f[f'speak_{L}'] = int(np.argmax(smap)) + 1         # densest short-liq band, % above
                    if lmap.sum() > 0:
                        f[f'lpeak_{L}'] = int(np.argmax(lmap)) + 1
                    for jj, (sv, lv) in enumerate(zip(smap, lmap)):
                        rows.append((sym, r.ts, k, r.period, r.day, L, jj + 1, sv, lv, up24, dn24))
                feats.append(f)
    R = pd.DataFrame(rows, columns=['symbol', 'ts', 'k', 'period', 'day', 'L', 'band', 'sfuel', 'lfuel', 'up24', 'dn24'])
    R.to_parquet(os.path.join(RAW, 'clusters.parquet'), index=False)
    F = pd.DataFrame(feats)
    F.to_parquet(os.path.join(RAW, 'cluster_feats.parquet'), index=False)
    print(R.shape, F.shape)


if __name__ == '__main__':
    main()
