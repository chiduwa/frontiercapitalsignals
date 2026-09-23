#!/usr/bin/env python3
"""Eight named stablecoins: lagged explanatory regressions and nested forecasts.
Unsigned turnover cannot identify cashing out. CMC100 is the broad-market target.
"""
import argparse,hashlib,importlib.util,json,math
from collections import Counter,defaultdict
from datetime import datetime,timedelta
from pathlib import Path
import numpy as np
spec=importlib.util.spec_from_file_location('session',Path(__file__).with_name('session-research.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);model=m.model
VERSION='stable-basket-v1'
STABLES=['USDT','USDC','USDE','DAI','USD1','USDG','PYUSD','RLUSD']
TRACKED=m.SYMBOLS
BASE=['ret1','ret7','vol20','ownVolumeChange','majorVolumeChange1','majorVolumeChange7','netAggressiveSell']
BOOT={}

def bootstrap_many(differences,block=7,draws=50000):
    a=np.asarray(differences,dtype=float);n,k=a.shape
    if n<40:return [{'mean':float(a[:,j].mean()),'low':None,'high':None,'p':1.} for j in range(k)]
    key=(n,block,draws)
    if key not in BOOT:
        rng=np.random.default_rng(94109);starts=rng.integers(n,size=(draws,math.ceil(n/block)))
        idx=((starts[:,:,None]+np.arange(block))%n).reshape(draws,-1)[:,:n]
        weights=np.zeros((draws,n));np.add.at(weights,(np.arange(draws)[:,None],idx),1/n);BOOT[key]=weights
    sampled=BOOT[key]@a;means=a.mean(axis=0)
    return [{'mean':float(means[j]),'low':float(np.quantile(sampled[:,j],.025)),'high':float(np.quantile(sampled[:,j],.975)),
        'p':float((1+np.sum(sampled[:,j]-means[j]>=means[j]))/(draws+1))} for j in range(k)]

def groups():
    g={}
    for coin in STABLES+['basket8','core3']:
        for lag in [0,1,3,7]:g[f'{coin}_lag{lag}']=[f'{coin}_growth{window}_lag{lag}' for window in [1,3,7]]
    for kind in ['share','turnover']:
        for lag in [0,1,3,7]:g[f'basket8_{kind}_lag{lag}']=[f'basket8_{kind}_change{w}_lag{lag}' for w in [1,3,7]]
    g['allCoins']=[f'{c}_growth{w}_lag0' for c in STABLES for w in [1,7]]
    return g

def build_records(panel,cmc,hourly):
    data={s:{r['date']:r for r in rs if r['t']<m.stamp(panel['asOf'],0)} for s,rs in panel['assets'].items()}
    cm={r['date']:r for r in cmc.get('series',[])}
    flow={}
    if hourly:
        hours={s:{r['t']:r for r in hourly.get('assets',{}).get(s,[])} for s in ['BTC','ETH','SOL']}
        for day in data['BTC']:
            end=m.stamp(day,0);rs=[hours[s].get(t) for s in hours for t in range(end-86400000,end,3600000)]
            if all(r and r.get('quoteVolume',0)>0 and 0<=r.get('takerBuyQuote',-1)<=r['quoteVolume'] for r in rs):
                total=sum(r['quoteVolume'] for r in rs);flow[day]=(total-2*sum(r['takerBuyQuote'] for r in rs))/total
    crypto=list(panel['cryptoIds']);basket_members={**{s:[s] for s in STABLES},'basket8':STABLES,'core3':['USDT','USDC','DAI']}
    sums={};major={}
    for day in sorted(data['BTC']):
        if all(day in data[s] and data[s][day]['volume'] is not None and data[s][day]['volume']>0 for s in crypto):
            major[day]=sum(data[s][day]['volume'] for s in crypto)
    for group,members in basket_members.items():
        sums[group]={}
        for day in sorted(data['BTC']):
            if not all(day in data[s] and data[s][day]['volume'] is not None and data[s][day]['volume']>0 and data[s][day]['mcap'] is not None and data[s][day]['mcap']>0 for s in members):continue
            v=sum(data[s][day]['volume'] for s in members);cap=sum(data[s][day]['mcap'] for s in members)
            sums[group][day]={'volume':v,'turnover':v/cap,'share':v/major[day] if day in major else None}
    records=defaultdict(list);feature_days=[]
    for day in sorted(data['BTC']):
        common={}
        for group in sums:
            for lag in [0,1,3,7]:
                current=m.shift(day,-lag)
                for w in [1,3,7]:
                    previous=m.shift(current,-w);a,b=sums[group].get(current),sums[group].get(previous)
                    common[f'{group}_growth{w}_lag{lag}']=math.log(a['volume']/b['volume']) if a and b else None
                    if group=='basket8':
                        for kind in ['share','turnover']:
                            common[f'basket8_{kind}_change{w}_lag{lag}']=math.log(a[kind]/b[kind]) if a and b and a[kind] and b[kind] else None
        if any(common.get(f'basket8_growth{w}_lag7') is None for w in [1,3,7]):continue
        if any(m.shift(day,-n) not in major for n in [0,1,7]):continue
        common.update({'majorVolumeChange1':math.log(major[day]/major[m.shift(day,-1)]),
                       'majorVolumeChange7':math.log(major[day]/major[m.shift(day,-7)]),'netAggressiveSell':flow.get(day)})
        # Midnight t volumes are rolling snapshots of the preceding day.
        # Deliberate one-day availability embargo before entry, then 24h label.
        entry,end=m.shift(day,1),m.shift(day,2)
        if not all(entry in data[s] and end in data[s] for s in TRACKED):continue
        individual={s:100*(data[s][end]['price']/data[s][entry]['price']-1) for s in TRACKED}
        for symbol in TRACKED+['CMC100','TRACKED_MEDIAN']:
            prices=cm if symbol=='CMC100' else data['BTC'] if symbol=='TRACKED_MEDIAN' else data[symbol]
            if any(m.shift(day,-n) not in prices for n in range(21)) or entry not in prices or end not in prices:continue
            changes=[100*(prices[m.shift(day,-n)]['price']/prices[m.shift(day,-n-1)]['price']-1) for n in range(20)]
            target=float(np.median(list(individual.values()))) if symbol=='TRACKED_MEDIAN' else 100*(prices[end]['price']/prices[entry]['price']-1)
            ref=data['BTC'] if symbol in ['CMC100','TRACKED_MEDIAN'] else data[symbol]
            values={**common,'ret1':changes[0],'ret7':100*(prices[day]['price']/prices[m.shift(day,-7)]['price']-1),
                    'vol20':float(np.std(changes)),
                    'ownVolumeChange':math.log(ref[day]['volume']/ref[m.shift(day,-1)]['volume']) if ref[day]['volume'] and ref[m.shift(day,-1)]['volume'] else None}
            if symbol=='TRACKED_MEDIAN':
                values['ret1']=float(np.median([100*(data[s][day]['price']/data[s][m.shift(day,-1)]['price']-1) for s in TRACKED]))
                values['ret7']=float(np.median([100*(data[s][day]['price']/data[s][m.shift(day,-7)]['price']-1) for s in TRACKED]))
                values['vol20']=float(np.std([np.median([100*(data[s][m.shift(day,-n)]['price']/data[s][m.shift(day,-n-1)]['price']-1) for s in TRACKED]) for n in range(20)]))
            records[symbol].append({'date':entry,'featureDate':day,'targetDate':end,'target':target,
                'sameDayReturn':values['ret1'],'majorityDown':sum(v<0 for v in individual.values())>=4,'values':values})
        feature_days.append(day)
    return records,{'symbols':{s:{'n':len(rs),'first':min(rs) if rs else None,'last':max(rs) if rs else None} for s,rs in data.items()},
                    'completeBasketDays':len(sums['basket8']),'netFlowDays':len(flow),'featureDays':len(feature_days),
                    'CMC100Days':len(cm),'priceVolumeContract':'daily UTC midnight samples; volume is rolling 24h; one full-day embargo before entry'}

def predictions(train,test,sets):
    y=np.array([r['target'] for r in train]);prob={};signed={};mag={}
    for name,extra in {'baseline':[],**sets}.items():
        names=BASE+extra;a,b=model.transform(model.matrix(train,names),model.matrix(test,names))
        prob[name]=model.logistic(a,(y>0).astype(float),b)
        signed[name]=model.ridge(a,y,b)
        mag[name]=np.maximum(0,model.ridge(a,abs(y),b))
    prob['baseRate']=np.full(len(test),((y>0).sum()+1)/(len(y)+2));signed['zero']=np.zeros(len(test));mag['median']=np.full(len(test),np.median(abs(y)))
    return prob,signed,mag

def evaluate(rows,asof,sets):
    start=m.shift(asof,-120);outer=[r for r in rows if r['date']>=start and r['targetDate']<asof];out=[];selections=[]
    for k in range(0,len(outer),28):
        test=outer[k:k+28];history=[r for r in rows if r['targetDate']<test[0]['date']]
        if len(history)<192:continue
        val=history[-42:];train=[r for r in history[:-42] if r['targetDate']<val[0]['date']]
        if len(train)<140:continue
        vp,vs,vm=predictions(train,val,sets);y=np.array([r['target'] for r in val]);up=(y>0).astype(float)
        dwin=min(vp,key=lambda n:np.mean((vp[n]-up)**2));swin=min(vs,key=lambda n:np.mean((vs[n]-y)**2));mwin=min(vm,key=lambda n:np.mean(abs(vm[n]-abs(y))))
        p,s,mag=predictions(train+val,test,sets);p['selected']=p[dwin];s['selected']=s[swin];mag['selected']=mag[mwin]
        selections.append({'date':test[0]['date'],'trainN':len(train),'validationN':len(val),'lastMatured':history[-1]['targetDate'],'direction':dwin,'signedReturn':swin,'magnitude':mwin})
        for i,r in enumerate(test):out.append({**r,'prob':{n:float(v[i]) for n,v in p.items()},'signed':{n:float(v[i]) for n,v in s.items()},'mag':{n:float(v[i]) for n,v in mag.items()}})
    if len(out)<40:return {'status':'insufficient-history','testN':len(out),'selections':selections},out
    y=np.array([r['target'] for r in out]);up=(y>0).astype(float)
    bprob=np.array([r['prob']['baseline'] for r in out]);bsigned=np.array([r['signed']['baseline'] for r in out]);median=np.array([r['mag']['median'] for r in out])
    result={};diff=[];slots=[]
    for name in ['baseline',*sets,'selected']:
        p=np.array([r['prob'][name] for r in out]);s=np.array([r['signed'][name] for r in out]);mag=np.array([r['mag'][name] for r in out])
        result[name]={'brier':float(np.mean((p-up)**2)),'signedMSE':float(np.mean((s-y)**2)),
            'signedR2vsZero':float(1-np.sum((s-y)**2)/np.sum(y*y)),'magnitudeMAE':float(np.mean(abs(mag-abs(y))))}
        for metric,delta in [('directionEvidence',(bprob-up)**2-(p-up)**2),('regressionEvidence',(bsigned-y)**2-(s-y)**2),('magnitudeEvidence',abs(median-abs(y))-abs(mag-abs(y)))]:
            if name=='baseline' and metric!='magnitudeEvidence':continue
            diff.append(delta);slots.append((name,metric))
    for (name,metric),e in zip(slots,bootstrap_many(np.array(diff).T)):result[name][metric]=e
    conditions={};correlations={}
    for coin in STABLES+['basket8','core3']:
        vals=np.array([r['values'][coin+'_growth1_lag0'] for r in out])
        correlations[coin]={'futureReturn':model.correlation(vals,y),'futureMagnitude':model.correlation(vals,abs(y)),
            'contemporaneous':model.correlation(vals,[r['sameDayReturn'] for r in out]),'n':len(out),'inference':'descriptive only'}
        conditions[coin]={}
        for label,mask in [('volumeUp10pct',vals>=math.log(1.1)),('volumeDown10pct',vals<=math.log(.9))]:
            conditions[coin][label]={'n':int(mask.sum()),'downProbability':float(np.mean(y[mask]<0)) if mask.any() else None,
                                   'meanReturnPct':float(np.mean(y[mask])) if mask.any() else None}
    # Final available training coefficients are explanatory, not a held-out result.
    coefficients={};finalTrain=[r for r in rows if r['targetDate']<asof]
    for coin in STABLES+['basket8','core3']:
        names=BASE+sets[coin+'_lag0'];x,_=model.transform(model.matrix(finalTrain,names),model.matrix(finalTrain,names))
        reg=np.eye(x.shape[1])*20;reg[0,0]=0;beta=np.linalg.solve(x.T@x+reg,x.T@np.array([r['target'] for r in finalTrain]))
        keep=np.sum(np.isfinite(model.matrix(finalTrain,names)),axis=0)>=25;kept=[n for n,k in zip(names,keep) if k]
        coefficients[coin]={name:float(beta[i+1]) for i,name in enumerate(kept) if name.startswith(coin+'_')}
    return {'status':'research-only','testN':len(out),'first':out[0]['date'],'last':out[-1]['targetDate'],
      'baselineDownRate':float(np.mean(y<0)),'baseRateBrier':float(np.mean([(r['prob']['baseRate']-float(r['target']>0))**2 for r in out])),
      'medianMagnitudeMAE':float(np.mean(abs(median-abs(y)))),'models':result,'selections':selections,
      'correlations':correlations,'conditional':conditions,'explanatoryStandardizedCoefficients':coefficients},out

def study(panel,cmc,hourly):
    records,coverage=build_records(panel,cmc,hourly);sets=groups();report={'version':VERSION,'asOf':panel['asOf'],'actionable':False,
       'stablecoins':STABLES,'hypothesis':'An increase in stablecoin rolling volume precedes negative crypto returns; test the opposite when volume falls.',
       'coverage':coverage,'assets':{},'limitations':[
        'Unsigned volume does not identify investors selling crypto: each trade has a buyer and seller, and stablecoin/crypto volume attribution overlaps.',
        'Global stablecoin USD volume is distinct from disjoint venue pair turnover. No splicing with the earlier USDC/USDT study.',
        '364 midnight observations are retrospective revised history, not first-seen vintages. One full-day embargo reduces timing risk without solving revisions.',
        'CMC100 is a provider market index; TRACKED_MEDIAN tests the majority direction among the always-tracked assets, not every listed coin.',
        'Baseline controls own returns/volatility, major-crypto volume changes, and available Binance BTC/ETH/SOL net aggressive selling.',
        'Test candidates use volume growth over 1/3/7 days, additional lags 0/1/3/7, volume ratio and turnover controls; per-asset selection uses earlier validation only.',
        'Descriptive correlations and full-sample coefficients do not establish causal flows or forecasting value.',
        'All formal comparisons share one Holm family; 50,000 paired moving-block bootstrap draws, seven-day blocks, fixed seed.',
        'A 120-day retrospective outer window is short. Any candidate needs frozen prospective confirmation and stronger baselines before promotion.']}
    evidence=[];pred={}
    for symbol,rows in records.items():
        result,out=evaluate(rows,panel['asOf'],sets);report['assets'][symbol]=result;pred[symbol]=out
        for r in result.get('models',{}).values():evidence.extend(r[k] for k in ['directionEvidence','regressionEvidence','magnitudeEvidence'] if k in r)
    m.holm(evidence);report['testFamilySize']=len(evidence)
    return report,pred

def markdown(r):
    lines=['# Eight-stablecoin volume hypothesis',f"As of {r['asOf']}; coins: {', '.join(r['stablecoins'])}. Research only.",
       '', '| Target | Test days | Basket volume growth: direction gain | Signed-return regression gain | Selected model direction gain |',
       '|---|---|---|---|---|']
    for s,a in r['assets'].items():
        if not a.get('models'):lines.append(f"| {s} | {a['testN']} | Insufficient | — | — |");continue
        b=a['models']['basket8_lag0'];d=b['directionEvidence'];reg=b['regressionEvidence'];sel=a['models']['selected']['directionEvidence']
        lines.append(f"| {s} | {a['testN']} | {d['mean']:+.5f} (Holm p={d['adjustedP']:.3f}) | {reg['mean']:+.4f} (p={reg['adjustedP']:.3f}) | {sel['mean']:+.5f} (p={sel['adjustedP']:.3f}) |")
    lines+=['','Positive gains mean lower error than the price/volume/order-flow control; negative means worse. Brier measures direction probability error. Regression gain is reduction in squared percentage-return error.','',
       '## Broad market: individual stablecoins', '| Coin | Future return correlation | Same-period correlation | P(market down) after volume +10% | After volume −10% |','|---|---|---|---|---|']
    market=r['assets'].get('CMC100',{})
    for coin,c in market.get('correlations',{}).items():
        a,b=market['conditional'][coin]['volumeUp10pct'],market['conditional'][coin]['volumeDown10pct']
        def prob(x):return f"{x['downProbability']:.1%} (n={x['n']})" if x['n'] else 'insufficient'
        lines.append(f"| {coin} | {c['futureReturn']:+.3f} | {c['contemporaneous']:+.3f} | {prob(a)} | {prob(b)} |")
    if market.get('models'):lines+=['',f"Unconditional CMC100 down frequency in this holdout: {market['baselineDownRate']:.1%}. Conditional frequencies are descriptive; compare model controls and corrected tests before calling them leading indicators."]
    wins=[(s,name,key) for s,a in r['assets'].items() for name,c in a.get('models',{}).items() for key in ['directionEvidence','regressionEvidence','magnitudeEvidence'] if key in c and c[key].get('adjustedP',1)<.05 and (c[key].get('low') or -1)>0]
    lines+=['',f"{len(wins)} comparisons clear the {r['testFamilySize']}-test family; none is automatically promoted."]
    lines+=['- '+str(w) for w in wins]+['']+['- '+x for x in r['limitations']]
    return '\n'.join(lines)+'\n'
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--input',required=True);p.add_argument('--cmc',required=True);p.add_argument('--hourly');p.add_argument('--output',required=True);args=p.parse_args()
    paths=[Path(args.input),Path(args.cmc)]+([Path(args.hourly)] if args.hourly else []);raw=[p.read_bytes() for p in paths]
    report,pred=study(json.loads(raw[0]),json.loads(raw[1]),json.loads(raw[2]) if len(raw)>2 else {})
    report['inputHash']=hashlib.sha256(b'\n'.join(raw)).hexdigest();report['codeHash']=hashlib.sha256(Path(__file__).read_bytes()+Path(__file__).with_name('session-research.py').read_bytes()+Path(__file__).with_name('tracked-research.py').read_bytes()).hexdigest()
    out=Path(args.output);out.mkdir(parents=True,exist_ok=True);(out/'stable-basket-report.json').write_text(json.dumps(report,indent=2,allow_nan=False));(out/'stable-basket-report.md').write_text(markdown(report));(out/'stable-basket-predictions.json').write_text(json.dumps(pred,allow_nan=False));print(markdown(report))
