// Export point-in-time daily research rows; no D1 writes or production calls.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { featureRow, sanitizeBars } from './panel-features.mjs';
import { ewmaVol, harComponents } from './model-zoo.mjs';
import { timeSeriesPaths } from './time-series.mjs';

// Sequence window handed to the sequence models (tracked-sequence-research.py).
export const SEQUENCE_DAYS = 30;
export const TRACKED = ['BTC','ETH','SOL','XLM','XRP','HYPE','HBAR','ARB'];
// Horizons per asset class: calendar days for crypto (it trades every day),
// trading sessions for stocks (1 session, 1 week).
export const HORIZONS = { crypto: [1, 7], stock: [1, 5] };
const addSessions = (d, n) => {
  let t = Date.parse(d + 'T00:00:00Z');
  while (n > 0) { t += DAY; const w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) n--; }
  return new Date(t).toISOString().slice(0, 10);
};
const DAY = 86400000;
const offset = (d,n) => new Date(Date.parse(d+'T00:00:00Z')+n*DAY).toISOString().slice(0,10);
const logRatio = (a,b) => a > 0 && b > 0 ? Math.log(a/b) : null;

// `sequence` adds the 30-day return/volume window per row (~35 MB for the
// tracked panel); only the weekly sequence lane reads it.
// `tournament` (scripts/model-tournament.py) adds the plain-GARCH and
// seasonal-HAR scales and, for the newest dates, OPEN rows: features known at
// that close, target still unknown (target: null). Those are the rows a live
// forecast is issued from. Off by default so research inputs stay byte-stable.
// `assetClass: 'stock'` builds equity rows: session horizons (HORIZONS),
// SPY as benchmark and leader, no crypto derivatives or liquidity lanes.
// `leaders` names the series whose prior-day returns become leader_* inputs;
// by default the assets themselves, as the tracked lanes always did. For any
// other batch pass the always-tracked set, so an asset's inputs never depend
// on which coins happened to share its batch.
export function researchRows(panel, { symbols = TRACKED, sequence: withSequence = false, tournament = false,
  assetClass = 'crypto', leaders = null } = {}) {
  const isStock = assetClass === 'stock';
  const assets = panel.assets.filter(a => a.assetClass === assetClass && symbols.includes(a.symbol));
  const leaderList = leaders || (isStock ? ['SPY'] : symbols);
  const benchmark = isStock ? 'SPY' : 'BTC';
  const extra = panel.assets.filter(a => !assets.includes(a) && (a.symbol === benchmark || leaderList.includes(a.symbol))
    && (a.assetClass === assetClass || a.assetClass === 'benchmark'));
  const bars = new Map([...assets, ...extra].map(a => [a.symbol, sanitizeBars(a.bars, { asOf: panel.asOf })]));
  const byDate = new Map([...bars].map(([s,bs]) => [s,new Map(bs.map(b=>[b.date,b]))]));
  const sessionIndex = new Map([...bars].map(([s, bs]) => [s, { dates: bs.map(b => b.date), at: new Map(bs.map((b, k) => [b.date, k])) }]));
  const result = { asOf: panel.asOf, symbols, rows: [], coverage: {} };
  if (isStock) result.assetClass = 'stock';
  for (const asset of assets) {
    const symbol = asset.symbol, bs = bars.get(symbol);
    const deriv = panel.derivatives?.[symbol] || [], funding = panel.funding?.[symbol] || [];
    const dmap = new Map(deriv.map(r=>[r.date,r]));
    const liq = new Map((panel.liquidity || []).filter(r=>r.symbol===symbol).map(r=>[r.date,r]));
    const fsource = [...new Set(funding.map(r=>r.source))];
    const dates = bs.map(b=>b.date);
    const delay = rows => rows.map(r=>({...r,date:offset(r.date,1)}));
    const delayedDeriv=delay(deriv), delayedSupply=delay(panel.supply?.[symbol]||[]);
    const benchmarkByDate=new Map([...byDate.get(benchmark)||[]].map(([d,b])=>[d,b.close]));
    result.coverage[symbol] = { bars: bs.length, first: dates[0], last: dates.at(-1),
      ageDays: (Date.parse(panel.asOf)-Date.parse(dates.at(-1)))/DAY,
      priceSources: [...new Set(bs.map(b=>b.source))], quarantined: asset.quarantined,
      missingPriceDays: dates.slice(1).reduce((n,d,i)=>n+Math.max(0,(Date.parse(d)-Date.parse(dates[i]))/DAY-1),0),
      volumeMissing: bs.filter(b=>!(b.volume>0)).length,
      derivatives: deriv.length, derivativesLast: deriv.at(-1)?.date,
      funding: funding.length, fundingSources: fsource, fundingFirst: funding[0]?.date,
      settlementHistory: funding.filter(r=>r.source==='binance-fapi-direct').length,
      liquidity: liq.size, supply: (panel.supply?.[symbol]||[]).length,
      warnings: ['Date-only archives lack original availability timestamps; optional lanes delayed one UTC day.',
        ...(fsource.some(s=>s!=='binance-fapi-direct') ? ['Legacy funding provenance can be overwritten; this ablation is diagnostic until canonical settlement backfill.'] : [])] };
    // GARCH(1,1) with the weekday factor -- the magnitude model that beat the
    // production scale out of sample (docs/TIME_SERIES_EVIDENCE.md) -- as the
    // benchmark the sequence models' magnitude forecasts must clear.
    const garch = timeSeriesPaths({ symbol, assetClass, bars: bs }, { structural: false });
    const dailyLog = bs.map((x, j) => (j && bs[j - 1].close > 0 && x.close > 0 ? Math.log(x.close / bs[j - 1].close) : null));
    const logVolume = bs.map((x, j) => {
      const prior = bs.slice(Math.max(0, j - 20), j).map(y => y.volume).filter(v => v > 0);
      return x.volume > 0 && prior.length >= 10 ? Math.log(x.volume / (prior.reduce((a, v) => a + v, 0) / prior.length)) : null;
    });
    for (let i=60;i<bs.length;i++) {
      // A stock's "previous" is the previous session, not the previous day.
      const b=bs[i], date=b.date, previous=isStock ? bs[i-1].date : offset(date,-1);
      // Portal files and vendor snapshots do not prove same-close availability.
      // Shift optional lanes a full day before feeding the existing feature code.
      const f=featureRow(bs,i,{assetClass,benchmarkByDate,
        derivatives:delayedDeriv, supply:delayedSupply});
      if (!f) continue;
      const values={...f.raw};
      const returns=bs.slice(i-59,i+1).map((x,j)=>Math.log(x.close/bs[i-60+j].close));
      const har=harComponents(returns);
      values.harDaily=har.d;values.harWeek=har.w;values.harMonth=har.m;
      values.ewmaVol=ewmaVol(returns);values.dailyVol=f.dailyVol;
      values.intradayRange=b.high>0 && b.low>0 && b.high>=b.low ? Math.log(b.high/b.low) : null;
      const d=dmap.get(previous), d1=dmap.get(offset(previous,-1));
      // Quantity distinguishes actual contracts from USD OI's mechanical price effect.
      values.oiQuantityChange1=logRatio(d?.oi_qty_close,d1?.oi_qty_close);
      values.topTraderPosition=d?.toptrader_position_ls>0 ? Math.log(d.toptrader_position_ls):null;
      values.bookImbalance=liq.get(previous)?.book_imbalance_1pct ?? null;
      values.logDepth=liq.get(previous)?.depth_1pct_usd>0 ? Math.log(liq.get(previous).depth_1pct_usd):null;
      const fr=funding.find(r=>r.date===previous);
      const history=funding.filter(r=>r.date<=previous && r.source===fr?.source && Number.isFinite(r.funding_rate)).slice(-252);
      // Percentile is invariant to vendor rate units. No mixed-provider history.
      values.fundingRank=fr && history.length>=30 ? history.filter(r=>r.funding_rate<=fr.funding_rate).length/history.length-.5:null;
      // Sequence, time and momentum inputs (2026-09-23). All known at this
      // close: returns through today, the calendar, and trailing momentum.
      for (let k = 0; k < 10; k++) values[`returnLag${k}`] = dailyLog[i - k];
      values.weekday = new Date(Date.parse(date + 'T00:00:00Z')).getUTCDay();
      values.month = new Date(Date.parse(date + 'T00:00:00Z')).getUTCMonth() + 1;
      // return5/20/60 are already volatility-normalized z-scores (featureRow),
      // so acceleration is the short-horizon z less the 20-day one.
      values.momentumAcceleration = Number.isFinite(f.raw.return5) && Number.isFinite(f.raw.return20) ? f.raw.return5 - f.raw.return20 : null;
      const sequence = withSequence ? [] : undefined;
      if (withSequence) for (let k = i - SEQUENCE_DAYS + 1; k <= i; k++) sequence.push([dailyLog[k] ?? null, logVolume[k] ?? null]);
      for (const leader of leaderList) {
        if (leader===symbol) continue;
        const bm=byDate.get(leader);
        for (const lag of [1,3]) {
          // Strict prior-day predictor, never the follower's future interval.
          const si=sessionIndex.get(leader), k=si?.at.get(previous);
          const startDate=isStock ? (k>=lag ? si.dates[k-lag] : null) : offset(previous,-lag);
          const end=bm?.get(previous),start=startDate ? bm?.get(startDate) : null;
          values[`leader_${leader}_${lag}`]=logRatio(end?.close,start?.close);
        }
      }
      for (const horizon of HORIZONS[assetClass] || HORIZONS.crypto) {
        const end=bs[i+horizon];
        const pct=v=>Number.isFinite(v)?Math.expm1(v)*100:null;
        const paths=garch.get(date);
        const scales=tournament ? { garchPct:pct(paths?.garchVol?.[horizon]), harWeekdayPct:pct(paths?.harWeekdayVol?.[horizon]) } : {};
        // A session horizon may cross a weekend or a holiday, never a data hole.
        const reaches = end && (isStock ? (Date.parse(end.date)-Date.parse(date))/DAY <= Math.ceil(horizon*7/5)+4
          : end.date===offset(date,horizon));
        if (!reaches) {
          // Only the tail is open; a hole inside history is simply unusable.
          if (tournament && i+horizon>=bs.length) result.rows.push({symbol,date,targetDate:isStock ? addSessions(date,horizon) : offset(date,horizon),horizon,target:null,values,
            garchWeekdayPct:pct(paths?.garchWeekdayVol?.[horizon]),...scales});
          continue;
        }
        const target=Math.expm1(Math.log(end.close/b.close))*100;
        result.rows.push({symbol,date,targetDate:end.date,horizon,target,values,sequence,
          garchWeekdayPct:pct(paths?.garchWeekdayVol?.[horizon]),...scales});
      }
    }
  }
  for (const symbol of symbols) {
    const recent=result.rows.filter(r=>r.symbol===symbol && r.horizon===1 && r.target!==null && Date.parse(panel.asOf)-Date.parse(r.date)<=180*DAY);
    if (result.coverage[symbol]) result.coverage[symbol].recentFeatureCoverage=Object.fromEntries(
      [...new Set(recent.flatMap(r=>Object.keys(r.values)))].map(name=>[name,{measured:recent.filter(r=>Number.isFinite(r.values[name])).length,total:recent.length}]));
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  // node tracked-research-data.mjs <panel> <rows> [--sequence] [--tournament]
  //   [--symbols A,B] [--asset-class stock] [--leaders A,B]
  const args = process.argv.slice(2);
  const valueOf = flag => { const k = args.indexOf(flag); return k >= 0 ? args[k + 1] : null; };
  const valued = new Set(['--symbols', '--asset-class', '--leaders'].map(f => args.indexOf(f)).filter(k => k >= 0).map(k => k + 1));
  const [input, output] = args.filter((a, i) => !valued.has(i) && !a.startsWith('--'));
  const panel=JSON.parse(await readFile(input,'utf8'));
  const list = v => v ? v.split(',').filter(Boolean) : null;
  const assetClass = valueOf('--asset-class') || 'crypto';
  const symbols = list(valueOf('--symbols')) || (assetClass === 'crypto' ? TRACKED : panel.assets.filter(a => a.assetClass === assetClass).map(a => a.symbol));
  await writeFile(output,JSON.stringify(researchRows(panel, { symbols, assetClass, leaders: list(valueOf('--leaders')),
    sequence: args.includes('--sequence'), tournament: args.includes('--tournament') })));
}
