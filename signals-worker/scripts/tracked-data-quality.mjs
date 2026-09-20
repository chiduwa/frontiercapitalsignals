// Read-only coverage checks, independent of model performance. A green HTTP
// request is not proof of a fresh, complete, consistently measured input.
import { alignDailyResearchBars } from './archive-policy.mjs';
export const ALWAYS_TRACKED = Object.freeze(['BTC','ETH','SOL','XLM','XRP','HYPE','HBAR']);
const DAY = 86400000;
const age = (asOf, date) => date ? (Date.parse(asOf)-Date.parse(date))/DAY : null;
export function assessTrackedPanel(panel, symbols = ALWAYS_TRACKED) {
  const assets = [];
  for (const symbol of symbols) {
    const asset = panel.assets?.find(a => a.assetClass === 'crypto' && a.symbol === symbol);
    const bars = alignDailyResearchBars(asset?.bars || []).filter(b => b.date < panel.asOf).sort((a,b)=>a.date.localeCompare(b.date));
    const derivatives = (panel.derivatives?.[symbol] || []).filter(r=>r.date<panel.asOf);
    const funding = (panel.funding?.[symbol] || []).filter(r=>r.date<panel.asOf);
    const settled = funding.filter(r=>r.source==='binance-fapi-direct');
    const latest = rows => rows.reduce((d,r)=>r.date>d?r.date:d,'') || null;
    const lastPrice = latest(bars), lastDerivatives=latest(derivatives), lastSettlement=latest(settled);
    const issues=[];
    if (!bars.length) issues.push('Price history missing');
    else if (age(panel.asOf,lastPrice)>1) issues.push('Latest completed daily close missing');
    if (bars.length<730) issues.push('Less than two years of daily prices');
    const invalid=bars.filter(b=>!Number.isFinite(b.close)||b.close<=0
      || (b.high!=null && b.low!=null && (b.high<b.low || b.close>b.high*1.001 || b.close<b.low*.999))).length;
    if (invalid) issues.push(`${invalid} invalid price or high/low rows`);
    if (bars.some(b=>!Number.isFinite(b.volume)||b.volume<=0)) issues.push('Missing or non-positive volume');
    if (!lastDerivatives || age(panel.asOf,lastDerivatives)>2) issues.push('Open-interest history missing or stale');
    if (settled.length<365) issues.push('Less than one year of settlement-rate history');
    if (!lastSettlement || age(panel.asOf,lastSettlement)>2) issues.push('Settlement-rate collection missing or stale');
    const recentFunding=funding.filter(r=>age(panel.asOf,r.date)<=30);
    const fundingSources=[...new Set(recentFunding.map(r=>r.source))];
    if (fundingSources.length>1) issues.push('Recent funding mixes settlement means and vendor snapshots');
    assets.push({symbol,priceBars:bars.length,lastPrice,derivativeDays:derivatives.length,lastDerivatives,
      settlementDays:settled.length,lastSettlement,fundingSources,invalidPriceRows:invalid,
      status:issues.length?'needs-review':'covered',issues});
  }
  return {asOf:panel.asOf,scope:'always-tracked-crypto',assets,
    needsAttention:assets.filter(a=>a.issues.length).length,
    status:assets.some(a=>a.issues.length)?'needs-review':'covered',
    // Even complete coverage is not evidence of predictive skill.
    actionable:false};
}
