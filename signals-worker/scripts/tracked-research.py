#!/usr/bin/env python3
"""Deterministic per-asset nested chronological research. NumPy only; never trades.

Training -> purged validation -> later test. Selection uses validation only;
all fitted transforms use training only. Outer test windows contain disjoint
labels per asset/horizon. No randomized train/test split, no leaderboard promotion.
"""
import argparse, hashlib, json, math
from pathlib import Path
from collections import Counter
import numpy as np

VERSION = 'tracked-specialists-v1'
PV = ['return1','return5','return20','return60','trendGap','volRatio','volOfVol',
      'downsideShare','volumeRatio','volumeTrend','rangePosition','drawdownFromHigh',
      'dwellShare','dailyVol','intradayRange']
OI = ['oiChange1','oiChange7','oiPercentile','oiPriceDivergence','takerRatio',
      'accountLsChange','oiQuantityChange1','topTraderPosition']
FUNDING = ['fundingRank']
LIQ = ['bookImbalance','logDepth']
HAR = ['harDaily','harWeek','harMonth']


def matrix(rows, names):
    return np.array([[r['values'].get(n) if r['values'].get(n) is not None else np.nan
                      for n in names] for r in rows], dtype=float)


def transform(train, test):
    # Retain only fields measured at least 25 times in TRAIN; never fit future
    # medians or availability. Every retained field has its own missing indicator.
    keep = np.sum(np.isfinite(train), axis=0) >= 25
    train, test = train[:, keep], test[:, keep]
    med = np.nanmedian(np.where(np.isfinite(train), train, np.nan), axis=0)
    def fill(x):
        missing = ~np.isfinite(x)
        return np.c_[np.where(missing, med, x), missing.astype(float)]
    a, b = fill(train), fill(test)
    mu, sigma = np.mean(a, axis=0), np.std(a, axis=0)
    sigma = np.where(sigma > 1e-8, sigma, 1)
    return np.c_[np.ones(len(a)),np.clip((a-mu)/sigma,-8,8)], np.c_[np.ones(len(b)),np.clip((b-mu)/sigma,-8,8)]


def ridge(x, y, xt, penalty=20):
    reg=np.eye(x.shape[1])*penalty;reg[0,0]=0
    return xt @ np.linalg.solve(x.T@x+reg,x.T@y)


def sigmoid(x):
    return 1/(1+np.exp(-np.clip(x,-25,25)))


def logistic(x, y, xt, penalty=20):
    beta=np.zeros(x.shape[1]);reg=np.eye(x.shape[1])*penalty;reg[0,0]=0
    for _ in range(20):
        p=sigmoid(x@beta);w=np.maximum(p*(1-p),1e-5)
        step=np.linalg.solve((x.T*w)@x+reg+np.eye(x.shape[1])*1e-7, x.T@(y-p)-reg@beta)
        beta+=step
        if np.max(np.abs(step)) < 1e-6: break
    return sigmoid(xt@beta)


def candidates(train, test, symbol, symbols):
    y=np.array([r['target'] for r in train]);up=(y>0).astype(float)
    prob={ 'coin':np.full(len(test),.5), 'baseRate':np.full(len(test),(up.sum()+1)/(len(up)+2)) }
    mag={ 'zero':np.zeros(len(test)), 'medianAbs':np.full(len(test),np.median(abs(y))) }
    signed={ 'zero':np.zeros(len(test)) }
    sets={'pv':PV,'oi':PV+OI,'funding':PV+FUNDING,'liquidity':PV+LIQ,'all':PV+OI+FUNDING+LIQ}
    for leader in symbols:
        if leader!=symbol: sets['lead_'+leader]=PV+OI+[f'leader_{leader}_{lag}' for lag in (1,3)]
    for name,features in sets.items():
        x,xt=transform(matrix(train,features),matrix(test,features))
        pred=ridge(x,y,xt)
        signed['ridge_'+name]=pred
        prob['ridge_'+name]=sigmoid(pred/max(np.std(y),.01)*1.6)
        prob['logistic_'+name]=logistic(x,up,xt)
        if name in ('pv','oi','all'):
            mag['absoluteRidge_'+name]=np.maximum(0,ridge(x,abs(y),xt))
            mag['signedRidge_'+name]=abs(pred)
        if name=='all':
            k=min(50,max(15,int(math.sqrt(len(train)))))
            neighbors=np.argpartition(np.sum((xt[:,None,:]-x[None,:,:])**2,axis=2),k-1,axis=1)[:,:k]
            prob['knn_all']=(up[neighbors].sum(axis=1)+1)/(k+2)
            mag['knn_all']=np.median(abs(y)[neighbors],axis=1)
    x,xt=transform(matrix(train,HAR),matrix(test,HAR))
    mag['fittedHarProxy']=np.maximum(0,ridge(x,abs(y),xt))
    # Absolute close returns are volatility proxies, NOT intraday realized variance.
    for name,fs in [('trailing',['dailyVol']),('ewma',['ewmaVol']),('harBlend',HAR)]:
        a=np.mean(matrix(train,fs),axis=1); b=np.mean(matrix(test,fs),axis=1)
        good=np.isfinite(a)&(a>0)
        scale=np.median(abs(y[good])/a[good]) if good.any() else 0
        mag[name]=np.maximum(0,b*scale)
    for name,feature,sgn in [('momentum','return5',1),('reversal','return1',-1)]:
        z=matrix(test,[feature])[:,0]
        prob[name]=np.where(sgn*z>0,.55,.45)
    return prob,mag,signed


def nonoverlap(rows):
    out=[]; until=''
    for r in sorted(rows,key=lambda r:r['date']):
        if r['date']>=until:
            out.append(r);until=r['targetDate']
    return out


def folds(rows, test_start, asof):
    horizon=rows[0]['horizon']; mintrain=90 if horizon==1 else 30
    valn=60 if horizon==1 else 20
    outer=nonoverlap([r for r in rows if test_start<=r['date'] and r['targetDate']<asof])
    step=28 if horizon==1 else 4
    for start in range(0,len(outer),step):
        test=outer[start:start+step]
        history=nonoverlap([r for r in rows if r['targetDate']<test[0]['date']])
        if len(history)<mintrain+valn: continue
        validation=history[-valn:]
        # Purge EVERY training label crossing validation's first anchor.
        train=[r for r in history[:-valn] if r['targetDate']<validation[0]['date']][-730:]
        if len(train)<mintrain: continue
        yield train,validation,test


def evaluate(rows,symbol,symbols,test_start,asof):
    records=[]; selections=[]
    for train,val,test in folds(rows,test_start,asof):
        vp,vm,_=candidates(train,val,symbol,symbols)
        vy=np.array([r['target'] for r in val]);vu=(vy>0).astype(float)
        dwin=min(vp,key=lambda k:np.mean((vp[k]-vu)**2))
        mwin=min(vm,key=lambda k:np.mean(abs(vm[k]-abs(vy))))
        # Refit chosen/candidate models only after validation outcomes mature.
        p,m,s=candidates(train+val,test,symbol,symbols)
        p['selected']=p[dwin];m['selected']=m[mwin]
        # Conservative specialist combination; calibrated probability is NOT
        # confidence in the signed return. Also score conditional-size variant.
        s['specialistProduct']=(2*p['selected']-1)*m['selected']
        ty=np.array([r['target'] for r in train+val]);
        pos=np.mean(ty[ty>0]) if np.any(ty>0) else 0
        neg=-np.mean(ty[ty<0]) if np.any(ty<0) else 0
        s['conditionalSizes']=p['selected']*pos-(1-p['selected'])*neg
        selections.append({'date':test[0]['date'],'trainedThrough':(train+val)[-1]['targetDate'],
                           'direction':dwin,'magnitude':mwin,'train':len(train),'validation':len(val)})
        for i,r in enumerate(test):
            records.append({**{k:r[k] for k in ['date','targetDate','target']},
                'prob':{k:float(v[i]) for k,v in p.items()},'mag':{k:float(v[i]) for k,v in m.items()},
                'signed':{k:float(v[i]) for k,v in s.items()}})
    return records,selections


def block_interval(values, block=7):
    """Paired circular moving-block bootstrap of the mean, fixed seed."""
    a=np.asarray(values);n=len(a)
    if n<20:return {'mean':float(np.mean(a)) if n else None,'low':None,'high':None,'p':1.}
    rng=np.random.default_rng(1977)
    starts=rng.integers(n,size=(20000,math.ceil(n/block)))
    idx=((starts[:,:,None]+np.arange(block))%n).reshape(20000,-1)[:,:n]
    means=np.mean(a[idx],axis=1)
    # Null-centered bootstrap tail, not a test on the uncentered distribution.
    p=(1+np.sum(means-a.mean()>=a.mean()))/20001
    return {'mean':float(a.mean()),'low':float(np.quantile(means,.025)),
            'high':float(np.quantile(means,.975)),'p':float(p)}


def correlation(a,b):
    # Average ranks with ties, without scipy dependency.
    def ranks(x):
        order=np.argsort(x);out=np.empty(len(x));i=0
        while i<len(x):
            j=i+1
            while j<len(x) and x[order[j]]==x[order[i]]:j+=1
            out[order[i:j]]=(i+j-1)/2;i=j
        return out
    if len(a)<3 or np.std(a)==0 or np.std(b)==0:return None
    return float(np.corrcoef(ranks(a),ranks(b))[0,1])


def score(records,horizon):
    if not records:return {'observations':0,'status':'insufficient-history'}
    y=np.array([r['target'] for r in records]);u=(y>0).astype(float);block=7 if horizon==1 else 2
    out={'observations':len(y),'first':records[0]['date'],'last':records[-1]['date'],
         'direction':{},'magnitude':{},'signed':{}}
    base=np.array([r['prob']['baseRate'] for r in records]);baseline=(base-u)**2
    magbase=np.array([r['mag']['medianAbs'] for r in records]);magloss=abs(magbase-abs(y))
    for model in records[0]['prob']:
        p=np.clip([r['prob'][model] for r in records],1e-6,1-1e-6);d=np.where(p>.5,1,np.where(p<.5,-1,0))
        loss=(p-u)**2;active=d!=0
        net=np.where(active,d*y-.20,0) # Flat round trip; funding/borrow unknown.
        out['direction'][model]={'brier':float(np.mean(loss)),
          'accuracy':float(np.mean(d[active]==np.sign(y[active]))) if active.any() else None,
          'balancedAccuracy':float(np.mean([np.mean(d[y>0]==1),np.mean(d[y<0]==-1)])) if np.any(y>0) and np.any(y<0) else None,
          'logLoss':float(np.mean(-u*np.log(p)-(1-u)*np.log(1-p))),
          'active':int(active.sum()),'netPct':float(np.mean(net)),
          'brierImprovement':block_interval(baseline-loss,block),
          'netInterval':block_interval(net,block)}
    for model in records[0]['mag']:
        m=np.array([r['mag'][model] for r in records]);loss=abs(m-abs(y))
        out['magnitude'][model]={'maePct':float(np.mean(loss)), 'spearman':correlation(m,abs(y)),
          'medianBaselineImprovement':block_interval(magloss-loss,block)}
    for model in records[0]['signed']:
        p=np.array([r['signed'][model] for r in records])
        out['signed'][model]={'maePct':float(np.mean(abs(p-y))),
          'oosR2':float(1-np.sum((y-p)**2)/np.sum(y*y)) if np.sum(y*y)>0 else None}
    # Paired lead ablations on exactly the same rows as the own-asset OI control.
    out['leadLag']={}
    own=np.array([r['prob']['logistic_oi'] for r in records])
    for model in records[0]['prob']:
        if model.startswith('logistic_lead_'):
            p=np.array([r['prob'][model] for r in records])
            out['leadLag'][model.removeprefix('logistic_lead_')]=block_interval((own-u)**2-(p-u)**2,block)
    out['featureAblations']={}
    pv=np.array([r['prob']['logistic_pv'] for r in records])
    for lane in ('oi','funding','liquidity','all'):
        p=np.array([r['prob']['logistic_'+lane] for r in records])
        out['featureAblations'][lane]=block_interval((pv-u)**2-(p-u)**2,block)
    return out


def correct_family(results):
    tests=[]
    for asset in results.values():
        for r in asset.values():
            for m in r.get('direction',{}).values():tests.append(m['brierImprovement'])
            for m in r.get('magnitude',{}).values():tests.append(m['medianBaselineImprovement'])
            tests.extend(r.get('leadLag',{}).values())
            tests.extend(r.get('featureAblations',{}).values())
    # Holm family-wise error control, robust to dependence across assets/models.
    ordered=sorted(tests,key=lambda t:t['p']);prev=0
    for i,t in enumerate(ordered):
        prev=max(prev,min(1.,t['p']*(len(ordered)-i)));t['holmP']=prev
    for asset in results.values():
        for r in asset.values():
            r['actionable']=False
            r['promotion']='requires-unseen-forward-confirmation'


def run(data, test_days=180):
    asof=data['asOf'];test_start=str(np.datetime64(asof)-np.timedelta64(test_days,'D'))
    out={'version':VERSION,'asOf':asof,'testStart':test_start,'coverage':data['coverage'],
         'assets':{},'actionable':False,'limitations':[
             'Research test dates were chosen before this run, but are not a registered untouched live holdout.',
             'Seven current favorites are a selected surviving universe; not survivorship-free.',
             'Daily close-to-close labels; not executable issue-time quotes.',
             'Legacy funding source labels can be wrong after snapshot overwrite. Funding ablations remain diagnostic pending settlement backfill; no funding edge is established.',
             'Flat 20 bps round trip excludes funding, borrow and market impact; not a trading simulation.',
             'Daily 1/3-day leader lags cannot rule out relationships at intraday horizons.',
             'Magnitude means absolute close return, not intraday high-low range or interval coverage.',
             'Refit/selection every 28 days using only matured validation labels; no automatic promotion.']}
    predictions={}
    for symbol in data['symbols']:
        out['assets'][symbol]={}
        for h in (1,7):
            rows=[r for r in data['rows'] if r['symbol']==symbol and r['horizon']==h]
            if not rows:
                out['assets'][symbol][str(h)]={'observations':0,'status':'missing-data'};continue
            records,selections=evaluate(rows,symbol,data['symbols'],test_start,asof)
            metrics=score(records,h);metrics['selections']=selections
            out['assets'][symbol][str(h)]=metrics
            predictions[f'{symbol}|{h}']=records
            print(f'{symbol} {h}d: {len(records)} disjoint test outcomes',flush=True)
    correct_family(out['assets'])
    return out,predictions


def markdown(r):
    lines=['# Always-tracked asset research', '',f"As of {r['asOf']}; outer evaluation from {r['testStart']}. `{VERSION}`. Shadow only.",'',
           '| Asset / horizon | Test n | Selected direction Brier | Base-rate Brier | Direction hit | Selected magnitude MAE % | Median baseline MAE % | Signed combination R² |',
           '|---|---:|---:|---:|---:|---:|---:|---:|']
    for s,hs in r['assets'].items():
        for h,v in hs.items():
            if not v['observations']:
                lines.append(f'| {s} {h}d | 0 — insufficient history | — | — | — | — | — | — |');continue
            d=v['direction'];m=v['magnitude'];acc=d['selected']['accuracy']
            lines.append(f"| {s} {h}d | {v['observations']} | {d['selected']['brier']:.4f} | {d['baseRate']['brier']:.4f} | {acc:.1%} | {m['selected']['maePct']:.3f} | {m['medianAbs']['maePct']:.3f} | {v['signed']['specialistProduct']['oosR2']:.4f} |" if acc is not None else f'| {s} {h}d | {v["observations"]} | abstained | | | | | |')
    lines+=['','Selections below use earlier validation only; frequency is descriptive. Test winners are not promoted.','']
    for s,hs in r['assets'].items():
        for h,v in hs.items():
            if not v['observations']:continue
            counts=lambda key:dict(Counter(x[key] for x in v['selections']))
            lines.append(f"- **{s} {h}d**: direction {counts('direction')}; magnitude {counts('magnitude')}.")
    lines+=['','## Data coverage','', '| Asset | Price bars | Last close | OI days | Funding days | Binance-labeled days | Depth days |', '|---|---:|---|---:|---:|---:|---:|']
    for s,c in r['coverage'].items():lines.append(f"| {s} | {c['bars']} | {c['last']} | {c['derivatives']} | {c['funding']} | {c['settlementHistory']} | {c['liquidity']} |")
    lines+=['','## Limits','']+['- '+x for x in r['limitations']]
    return '\n'.join(lines)+'\n'


if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--input',required=True);ap.add_argument('--output',required=True);ap.add_argument('--test-days',type=int,default=180)
    args=ap.parse_args();raw=Path(args.input).read_bytes();data=json.loads(raw)
    report,predictions=run(data,args.test_days);report['inputHash']=hashlib.sha256(raw).hexdigest()
    report['numpyVersion']=np.__version__
    report['codeHash']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    dest=Path(args.output);dest.mkdir(parents=True,exist_ok=True)
    (dest/'report.json').write_text(json.dumps(report,indent=2,allow_nan=False))
    (dest/'predictions.json').write_text(json.dumps(predictions,allow_nan=False))
    (dest/'report.md').write_text(markdown(report))
