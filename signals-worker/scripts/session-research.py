#!/usr/bin/env python3
"""DST-aware hourly/session and stablecoin-flow research; never issues trade signals.
Frozen development <2026-01-01; later holdout, no holdout-selected hours or rules.
"""
import argparse, hashlib, importlib.util, json, math
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
import numpy as np

spec=importlib.util.spec_from_file_location('tracked',Path(__file__).with_name('tracked-research.py'))
model=importlib.util.module_from_spec(spec);spec.loader.exec_module(model)
VERSION='session-flow-v1'
SYMBOLS=['BTC','ETH','SOL','XLM','XRP','HYPE','HBAR']
SPLIT='2026-01-01'
UTC=timezone.utc
WINDOWS=[('NY midnight','America/New_York',0,2),('NY morning','America/New_York',8,10),
         ('NY afternoon','America/New_York',14,16),('NY evening','America/New_York',16,18),
         ('London morning','Europe/London',8,10),('Tokyo morning','Asia/Tokyo',9,11)]

def stamp(day,hour,zone='UTC'):
    return int(datetime.fromisoformat(day).replace(hour=hour,tzinfo=ZoneInfo(zone)).timestamp()*1000)

def daystr(t,zone='UTC'):
    return datetime.fromtimestamp(t/1000,ZoneInfo(zone)).date().isoformat()

def shift(day,n):return (datetime.fromisoformat(day)+timedelta(days=n)).date().isoformat()

def boundary(rows,t):
    # Exact last completed close, never the NEXT hour's closing price.
    r=rows.get(t-3600000)
    return r['close'] if r else None

def move(rows,start,end):
    if end<=start or any(t not in rows for t in range(start,end,3600000)):return None
    a,b=boundary(rows,start),boundary(rows,end)
    return 100*(b/a-1) if a and b else None

def interval(v,block=7):return model.block_interval(v,block)

def holm(tests):
    order=sorted(tests,key=lambda r:r['p']);last=0
    for i,r in enumerate(order):
        last=max(last,min(1.,r['p']*(len(order)-i)));r['adjustedP']=last

def fit_compare(records,extra,base=None):
    train=[r for r in records if r['endDate']<SPLIT]
    test=[r for r in records if r['date']>=SPLIT]
    if len(train)<120 or len(test)<40:return {'status':'insufficient-history','trainN':len(train),'testN':len(test)}
    base=base or ['distance','prior','vol']
    y=np.array([r['target'] for r in train]);yt=np.array([r['target'] for r in test]);up=(yt>0).astype(float)
    predictions={};magnitudes={}
    for name,fields in [('baseline',base),('augmented',base+extra)]:
        a,b=model.transform(model.matrix(train,fields),model.matrix(test,fields))
        predictions[name]=model.logistic(a,(y>0).astype(float),b)
        magnitudes[name]=np.maximum(0,model.ridge(a,abs(y),b))
    delta=(predictions['baseline']-up)**2-(predictions['augmented']-up)**2
    magdelta=abs(magnitudes['baseline']-abs(yt))-abs(magnitudes['augmented']-abs(yt))
    median=np.full(len(test),np.median(abs(y)))
    return {'status':'research-only','trainN':len(train),'testN':len(test),
        'brierBaseline':float(np.mean((predictions['baseline']-up)**2)),
        'brierAugmented':float(np.mean((predictions['augmented']-up)**2)),
        'directionEvidence':interval(delta),'magnitudeEvidence':interval(magdelta),
        'magnitudeMedianEvidence':interval(abs(median-abs(yt))-abs(magnitudes['augmented']-abs(yt))),
        'magnitudeMAEMedian':float(np.mean(abs(median-abs(yt)))),
        'magnitudeMAEBaseline':float(np.mean(abs(magnitudes['baseline']-abs(yt)))),
        'magnitudeMAEAugmented':float(np.mean(abs(magnitudes['augmented']-abs(yt))))}

def profiles(rows):
    groups=defaultdict(list)
    # Exclude incomplete NY dates and normalize each hour against its own day's
    # average movement. Daily paired contrasts control changing volatility.
    days=defaultdict(list)
    for t,r in rows.items():days[daystr(t,'America/New_York')].append(r)
    for day,rs in sorted(days.items()):
        start=stamp(day,0,'America/New_York');end=stamp(shift(day,1),0,'America/New_York')
        if len(rs)!=(end-start)//3600000 or any(t not in rows for t in range(start,end,3600000)):continue
        denom=np.mean([abs(100*(r['close']/r['open']-1)) for r in rs])
        if denom<=0:continue
        weekend=datetime.fromisoformat(day).weekday()>=5
        for r in rs:
            hour=datetime.fromtimestamp(r['t']/1000,ZoneInfo('America/New_York')).hour
            ret=100*(r['close']/r['open']-1)
            value={'day':day,'hour':hour,'ret':ret,'abs':abs(ret),'range':100*(r['high']/r['low']-1),'ratio':abs(ret)/denom}
            groups['all'].append(value);groups['weekend' if weekend else 'weekday'].append(value)
    out={}
    for group,rs in groups.items():
        train=[r for r in rs if r['day']<SPLIT];test=[r for r in rs if r['day']>=SPLIT]
        if len(train)<24*100 or len(test)<24*30:continue
        means={h:np.mean([r['ratio'] for r in train if r['hour']==h]) for h in range(24)}
        chosen=sorted(means,key=means.get,reverse=True)[:3]
        contrasts=defaultdict(list)
        for r in test:
            if r['hour'] in chosen:contrasts[r['day']].append(r['ratio']-1)
        cells=[]
        for h in range(24):
            tr=[r for r in train if r['hour']==h];te=[r for r in test if r['hour']==h]
            sign=1 if np.mean([r['ret'] for r in tr])>0 else -1
            ev=interval([sign*r['ret'] for r in te])
            cells.append({'hourET':h,'trainN':len(tr),'testN':len(te),
                'trainAbsPct':float(np.mean([r['abs'] for r in tr])),
                'testAbsPct':float(np.mean([r['abs'] for r in te])),
                'testRangePct':float(np.mean([r['range'] for r in te])),
                'testMeanPct':float(np.mean([r['ret'] for r in te])),
                'trainSign':sign,'directionEvidence':ev})
        out[group]={'selectedHoursET':chosen,'cells':cells,
            'activityEvidence':interval([np.mean(v) for v in contrasts.values()]),
            'testDays':len(contrasts),'selection':'three highest development mean normalized absolute returns'}
    return out

def rules(rows):
    out=[]
    for title,zone,start_h,end_h in WINDOWS:
        days=sorted({daystr(t,zone) for t in rows})
        # All windows have a nonoverlapping +4h target; the requested NY 8-10
        # rule additionally measures the NY and UTC calendar closes and 16ET.
        targets=['next4h']+(['NY midnight','NY 16:00','UTC midnight'] if title=='NY morning' else [])
        for target in targets:
            records=[]
            for day in days:
                a,b=stamp(day,start_h,zone),stamp(day,end_h,zone)
                morning=move(rows,a,b)
                if morning is None:continue
                if target=='next4h': end=b+4*3600000;previous=b
                elif target=='NY midnight':end=stamp(shift(day,1),0,zone);previous=stamp(day,0,zone)
                elif target=='NY 16:00':end=stamp(day,16,zone);previous=stamp(shift(day,-1),16,zone)
                else:end=stamp(shift(day,1),0);previous=stamp(day,0)
                forward=move(rows,b,end);whole=move(rows,previous,end);distance=move(rows,previous,b) if previous<b else 0
                prior=move(rows,b-24*3600000,b)
                v=[move(rows,t,t+3600000) for t in range(b-24*3600000,b,3600000)]
                if any(x is None for x in [forward,whole,distance,prior]+v):continue
                records.append({'date':day,'endDate':daystr(end),'morning':morning,'target':whole,'forward':forward,
                    'values':{'distance':distance,'prior':prior,'vol':float(np.std(v)),'windowReturn':morning}})
            comparison=fit_compare(records,['windowReturn'])
            conditions=[]
            for sign in [1,-1]:
                train=[r for r in records if r['endDate']<SPLIT and sign*r['morning']>0]
                test=[r for r in records if r['date']>=SPLIT and sign*r['morning']>0]
                if not train or not test:continue
                # Raw conditional probabilities describe the close relation;
                # forward continuation is tested separately, after 20bp costs.
                conditions.append({'if':'up' if sign==1 else 'down','trainN':len(train),'testN':len(test),
                    'trainCloseSameDirection':float(np.mean([sign*r['target']>0 for r in train])),
                    'testCloseSameDirection':float(np.mean([sign*r['target']>0 for r in test])),
                    'testForwardSameDirection':float(np.mean([sign*r['forward']>0 for r in test])),
                    'testForwardMeanPct':float(np.mean([r['forward'] for r in test])),
                    'forwardNetEvidence':interval([sign*r['forward']-.20 for r in test])})
            out.append({'window':title,'timezone':zone,'start':start_h,'end':end_h,'target':target,
                        'comparison':comparison,'conditions':conditions})
    return out

def daily(rows):
    out={}
    for day in sorted({daystr(t) for t in rows}):
        start,end=stamp(day,0),stamp(shift(day,1),0)
        if any(t not in rows for t in range(start,end,3600000)):continue
        rs=[rows[t] for t in range(start,end,3600000)]
        out[day]={'close':rs[-1]['close'],'volume':sum(r['quoteVolume'] for r in rs),
                  'ret':100*(rs[-1]['close']/rs[0]['open']-1)}
    return out

def flow_research(assets,context):
    ds={s:daily(rows) for s,rows in assets.items()}
    supply={r['date']:r['value'] for r in context.get('supply',[]) if r.get('value',0)>0}
    market={}
    for d in sorted(ds['BTC']):
        if all(d in ds[s] for s in ['BTC','ETH','SOL']):
            market[d]={'ret':np.mean([ds[s][d]['ret'] for s in ['BTC','ETH','SOL']]),'volume':sum(ds[s][d]['volume'] for s in ['BTC','ETH','SOL'])}
    # Index compounded equal-weight DAILY rebalanced returns, not an all-market index.
    price=100
    for d in market:price*=1+market[d]['ret']/100;market[d]['close']=price
    ds['BTC_ETH_SOL']=market
    out={}
    for symbol in SYMBOLS+['BTC_ETH_SOL']:
        data=ds[symbol];cases=defaultdict(list)
        for day,r in sorted(data.items()):
            if day not in market or day not in ds.get('USDC',{}):continue
            previous=shift(day,-1);history=[data.get(shift(day,-n)) for n in range(1,21)]
            if any(x is None for x in history) or market[day]['volume']<=0:continue
            ratio=ds['USDC'][day]['volume']/market[day]['volume']
            if ratio<=0:continue
            features={'distance':r['ret'],'prior':100*(r['close']/data[previous]['close']-1),
                      'vol':float(np.std([x['ret'] for x in history])),
                      'logStableRatio':math.log(ratio),'logMajorVolume':math.log(market[day]['volume']),
                      'logStableVolume':math.log(ds['USDC'][day]['volume'])}
            for lag in [1,7,30]:
                # Two-day publication lag; no historical first-seen vintages available.
                x,y=shift(day,-2),shift(day,-2-lag)
                features['supply'+str(lag)]=100*(supply[x]/supply[y]-1) if x in supply and y in supply else None
            for horizon in [1,7]:
                # Predictor day d is known only AFTER d closes. Wait one more
                # calendar day before entry: return close(d+1) -> close(d+1+h).
                entry,end=shift(day,1),shift(day,1+horizon)
                if any(shift(day,n) not in data for n in range(1,horizon+2)):continue
                record={'date':entry,'endDate':end,'target':100*(data[end]['close']/data[entry]['close']-1),'values':features,'sourceReturn':r['ret']}
                if horizon==7 and (datetime.fromisoformat(entry)-datetime(2023,1,1)).days%7:continue
                for name in ['ratio','components','supply']:cases[(horizon,name)].append(record)
        results=[]
        for (horizon,name),records in cases.items():
            extra={'ratio':['logStableRatio'],'components':['logMajorVolume','logStableVolume'],
                   'supply':['supply1','supply7','supply30']}[name]
            if name=='supply':records=[r for r in records if all(r['values'][k] is not None for k in extra)]
            result=fit_compare(records,extra)
            # Component-control ablation isolates stable volume beyond major volume.
            if name=='components':
                result=fit_compare(records,['logStableVolume'],base=['distance','prior','vol','logMajorVolume'])
            if name=='ratio':
                held=[r for r in records if r['date']>=SPLIT]
                if len(held)>=40:
                    x=[r['values']['logStableRatio'] for r in held]
                    result['descriptiveSpearman']={'contemporaneous':model.correlation(x,[r['sourceReturn'] for r in held]),
                        'futureReturn':model.correlation(x,[r['target'] for r in held]),
                        'futureAbsoluteReturn':model.correlation(x,[abs(r['target']) for r in held]),
                        'n':len(held),'inference':'descriptive only; no independent significance claim'}
            results.append({'horizonDays':horizon,'features':name,**result})
        out[symbol]=results
    obs=context.get('observations',[])
    return {'assets':out,'snapshotDays':len({r['obs_date'] for r in obs}),
            'proxy':'Binance USDC/USDT quote turnover divided by BTC+ETH+SOL USDT quote turnover; disjoint pairs, one venue',
            'marketProxy':'daily rebalanced equal-weight BTC/ETH/SOL, not the entire crypto market',
            'publicationLag':'one full day after predictor day close; supply an additional two days',
            'coverage':{s:{'days':len(d),'first':min(d) if d else None,'last':max(d) if d else None} for s,d in ds.items()}}

def analyze(panel,context):
    cutoff=stamp(panel['asOf'],0)
    assets={s:{r['t']:r for r in rs if r['t']+3600000<=cutoff} for s,rs in panel['assets'].items()}
    result={'version':VERSION,'asOf':panel['asOf'],'developmentEnds':'2025-12-31','holdoutStarts':SPLIT,
            'actionable':False,'assets':{},'limitations':[
                'Retrospective holdout, not a prospectively registered experiment; no trading promotion.',
                'HYPE uses Binance perpetual prices; all other tracked assets use spot. HYPE has shorter history.',
                'Clock windows include exchange holidays; weekday means Monday-Friday, not an exchange trading calendar.',
                '8-10 ET includes part of the daily return: close association alone is not a forecast after 10 ET.',
                'Stable-to-stable turnover is not stablecoin issuance, net inflow, or global stablecoin trading volume. Venue fee promotions and USDC depegs can change turnover.',
                'Global stablecoin snapshots are too short for a reliable inference; supply history lacks first-seen vintages.',
                'Supply is all stablecoin pegs valued in USD; it is not restricted to USD-pegged coins. Weekly flow holdouts below 40 observations abstain.',
                'All significance tests are exploratory. Holm correction covers every reported direction, magnitude, activity and rule test.']}
    evidence=[]
    for symbol in SYMBOLS:
        rows=assets.get(symbol,{})
        p=profiles(rows);r=rules(rows)
        result['assets'][symbol]={'instrument':'perpetual' if symbol=='HYPE' else 'spot','hourlyBars':len(rows),
            'profiles':p,'rules':r}
        for group in p.values():
            evidence.append(group['activityEvidence']);evidence.extend(c['directionEvidence'] for c in group['cells'])
        for rule in r:
            evidence.extend(c['forwardNetEvidence'] for c in rule['conditions'])
            if 'directionEvidence' in rule['comparison']:
                evidence.extend(rule['comparison'][k] for k in ['directionEvidence','magnitudeEvidence','magnitudeMedianEvidence'])
    result['stablecoin']=flow_research(assets,context)
    for cases in result['stablecoin']['assets'].values():
        for case in cases:
            if 'directionEvidence' in case:evidence.extend(case[k] for k in ['directionEvidence','magnitudeEvidence','magnitudeMedianEvidence'])
    holm(evidence)
    result['testFamilySize']=len(evidence)
    for asset in result['assets'].values():
        for p in asset['profiles'].values():
            p['replicatedActivity']=p['activityEvidence']['adjustedP']<.05 and p['activityEvidence']['low']>0
            for c in p['cells']:
                e=c['directionEvidence'];c['directionSupported']=e['adjustedP']<.05 and e['low'] is not None and e['low']>.20
        for rule in asset['rules']:
            e=rule['comparison'].get('directionEvidence',{})
            for c in rule['conditions']:
                f=c['forwardNetEvidence'];c['supported']=e.get('adjustedP',1)<.05 and e.get('low',-1)>0 and f.get('adjustedP',1)<.05 and (f.get('low') or -1)>0
    return result

def render(report):
    lines=['# Per-asset trading-time and stablecoin study',f"As of {report['asOf']}. Development through 2025; holdout from 2026-01-01. Research only.",
        '', '| Asset | Development-selected busiest hours ET | Holdout activity vs typical hour | 8–10 up: higher NY daily close | 8–10 down: lower NY daily close |',
        '|---|---|---|---|---|']
    for symbol,a in report['assets'].items():
        p=a['profiles'].get('all',{});ev=p.get('activityEvidence',{});rule=next((r for r in a['rules'] if r['window']=='NY morning' and r['target']=='NY midnight'),{})
        cs=rule.get('conditions',[])
        vals=[f"{100*c['testCloseSameDirection']:.1f}% (n={c['testN']}; subsequent move follows {100*c['testForwardSameDirection']:.1f}%)" for c in cs]
        lines.append(f"| {symbol}{' perp' if a['instrument']=='perpetual' else ''} | {', '.join(str(h)+':00' for h in p.get('selectedHoursET',[]))} | {100*ev.get('mean',0):+.1f}%; {'replicated' if p.get('replicatedActivity') else 'unconfirmed'} | {' | '.join(vals or ['insufficient','insufficient'])} |")
    lines+=['','Daily-close percentages include the morning movement. They do not establish a trade after 10 ET. Full JSON contains incremental distance-to-prior-close controls, future-only returns, costs, sample counts and corrected tests.',
        '',f"All {report['testFamilySize']} reported tests share one Holm family. No production model is promoted.",'','## Stablecoin tests',
        report['stablecoin']['proxy'],f"Existing global snapshots: {report['stablecoin']['snapshotDays']} completed days; insufficient.",
        '', '| Asset/proxy | Daily stable-ratio Brier change (positive = better) | Daily stable-ratio magnitude MAE change |','|---|---|---|']
    for s,cases in report['stablecoin']['assets'].items():
        c=next((c for c in cases if c['horizonDays']==1 and c['features']=='ratio'),{})
        d,m=c.get('directionEvidence',{}),c.get('magnitudeEvidence',{})
        lines.append(f"| {s} | {d.get('mean',float('nan')):+.5f} (Holm p={d.get('adjustedP',1):.3f}) | {m.get('mean',float('nan')):+.3f} pp (Holm p={m.get('adjustedP',1):.3f}) |")
    confirmed=sum(1 for cases in report['stablecoin']['assets'].values() for c in cases
        if c['horizonDays']==1 and c['features']=='ratio' and c.get('magnitudeEvidence',{}).get('adjustedP',1)<.05
        and c.get('magnitudeMedianEvidence',{}).get('adjustedP',1)<.05
        and c.get('magnitudeEvidence',{}).get('low',-1)>0 and c.get('magnitudeMedianEvidence',{}).get('low',-1)>0)
    lines+=['',f'Stable-ratio gains against a fitted regression also require comparison with a simpler median-size forecast. {confirmed} daily candidates beat both controls with corrected significance in this run. All remain research-only. Component-control results are in the JSON.','', '## Limits']+['- '+s for s in report['limitations']]
    return '\n'.join(lines)+'\n'

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--input',required=True);parser.add_argument('--context');parser.add_argument('--output',required=True);args=parser.parse_args()
    raw=Path(args.input).read_bytes();ctx=Path(args.context).read_bytes() if args.context else b'{}'
    report=analyze(json.loads(raw),json.loads(ctx));report['inputHash']=hashlib.sha256(raw+b'\n'+ctx).hexdigest();report['codeHash']=hashlib.sha256(Path(__file__).read_bytes()+Path(__file__).with_name('tracked-research.py').read_bytes()).hexdigest()
    out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
    (out/'session-report.json').write_text(json.dumps(report,indent=2,allow_nan=False));(out/'session-report.md').write_text(render(report));print(render(report))
