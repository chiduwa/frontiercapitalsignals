import { d1 } from './d1-client.mjs';
export function sessionSummary(report) {
  if(report.version!=='session-flow-v1'||report.actionable!==false||!/^\d{4}-\d{2}-\d{2}$/.test(report.asOf)||!report.inputHash||!report.codeHash)throw new Error('Invalid session report');
  const assets={};
  for(const [symbol,a] of Object.entries(report.assets)){
    const profiles={};
    for(const [group,p] of Object.entries(a.profiles)) profiles[group]={hoursET:p.selectedHoursET,activityUplift:p.activityEvidence.mean,
      replicated:p.replicatedActivity,testDays:p.testDays,
      directions:p.cells.filter(c=>c.directionSupported).map(c=>({hourET:c.hourET,meanPct:c.testMeanPct,n:c.testN}))};
    const morning=a.rules.find(r=>r.window==='NY morning'&&r.target==='NY midnight');
    assets[symbol]={instrument:a.instrument,profiles,morning:morning?.conditions.map(c=>({if:c.if,n:c.testN,
      closeProbability:c.testCloseSameDirection,forwardProbability:c.testForwardSameDirection,supported:c.supported}))||[]};
  }
  return {version:report.version,asOf:report.asOf,inputHash:report.inputHash,codeHash:report.codeHash,actionable:false,
    assets,testFamilySize:report.testFamilySize,stablecoin:{snapshotDays:report.stablecoin.snapshotDays,
      proxy:report.stablecoin.proxy,assets:report.stablecoin.assets},limitations:report.limitations};
}
export async function persistSessionReport(env,report,query=d1){
  const summary=sessionSummary(report);
  await query(env,`INSERT OR IGNORE INTO session_flow_research(as_of,version,input_hash,code_hash,created_at,summary_json) VALUES(?,?,?,?,?,?)`,
    [summary.asOf,summary.version,summary.inputHash,summary.codeHash,new Date().toISOString(),JSON.stringify(summary)]);
  return summary;
}
export function researchSupplement(report){
  if(!['calendar-extremes-v1','stable-basket-v1'].includes(report.version)||report.actionable!==false||!/^\d{4}-\d{2}-\d{2}$/.test(report.asOf)||!report.inputHash||!report.codeHash)throw new Error('Invalid supplemental research report');
  if(report.version==='calendar-extremes-v1')return report;
  const assets={};
  for(const [symbol,a] of Object.entries(report.assets))assets[symbol]={status:a.status,testN:a.testN,
    baselineDownRate:a.baselineDownRate,baseRateBrier:a.baseRateBrier,medianMagnitudeMAE:a.medianMagnitudeMAE,
    basketModel:a.models?.basket8_lag0,selected:a.models?.selected,correlations:a.correlations,conditional:a.conditional,
    supported:Object.entries(a.models||{}).flatMap(([model,r])=>['directionEvidence','regressionEvidence','magnitudeEvidence']
      .filter(k=>r[k]?.adjustedP<.05&&r[k]?.low>0).map(metric=>({model,metric})))};
  return {...report,assets};
}
export async function persistResearchSupplement(env,report,query=d1){
  const summary=researchSupplement(report);
  await query(env,`INSERT OR IGNORE INTO session_flow_research(as_of,version,input_hash,code_hash,created_at,summary_json) VALUES(?,?,?,?,?,?)`,
    [summary.asOf,summary.version,summary.inputHash,summary.codeHash,new Date().toISOString(),JSON.stringify(summary)]);
  return summary;
}
export async function loadSessionHealth(env,nowMs=Date.now(),query=d1){
  const rows=await query(env,`SELECT version,as_of,summary_json FROM (
    SELECT version,as_of,summary_json,ROW_NUMBER() OVER (PARTITION BY version ORDER BY as_of DESC,created_at DESC,rowid DESC) rank
    FROM session_flow_research WHERE version IN (?,?,?) AND as_of<=?) WHERE rank=1`,
    ['session-flow-v1','calendar-extremes-v1','stable-basket-v1',new Date(nowMs).toISOString().slice(0,10)]);
  const get=version=>{
    const row=rows.find(r=>r.version===version);if(!row)return null;
    const value=JSON.parse(row.summary_json),ageDays=(nowMs-Date.parse(value.asOf+'T00:00:00Z'))/86400000;
    return {...value,status:ageDays>10?'stale':'research-only',ageDays,actionable:false};
  };
  return {...(get('session-flow-v1')||{status:'awaiting-first-run',actionable:false}),
    calendar:get('calendar-extremes-v1'),stableBasket:get('stable-basket-v1')};
}
