#!/usr/bin/env python3
"""Realized daily extrema and weekday jump/dump research. No future peak calls."""
import argparse,hashlib,importlib.util,json
from collections import defaultdict
from datetime import datetime,timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
import numpy as np
spec=importlib.util.spec_from_file_location('session',Path(__file__).with_name('session-research.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
VERSION='calendar-extremes-v1'
DAYS=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']

def daily_extremes(rows,zone='America/New_York'):
    byday=defaultdict(list)
    for r in rows:byday[m.daystr(r['t'],zone)].append(r)
    data=[];index={r['t']:r for r in rows}
    for day,rs in sorted(byday.items()):
        start,end=m.stamp(day,0,zone),m.stamp(m.shift(day,1),0,zone)
        if len(rs)!=(end-start)//3600000 or any(t not in index for t in range(start,end,3600000)):continue
        rs=sorted(rs,key=lambda r:r['t']);hi=max(r['high'] for r in rs);lo=min(r['low'] for r in rs)
        def hits(field,extreme):
            selected=[r for r in rs if abs(r[field]-extreme)<=max(1e-12,abs(extreme)*1e-12)]
            return [(datetime.fromtimestamp(r['t']/1000,ZoneInfo(zone)).hour,1/len(selected)) for r in selected]
        ret=np.array([100*(r['close']/r['open']-1) for r in rs]);denom=float(np.mean(abs(ret)))
        data.append({'date':day,'weekday':datetime.fromisoformat(day).weekday(),
            'peak':hits('high',hi),'bottom':hits('low',lo),
            'return':100*(rs[-1]['close']/rs[0]['open']-1),
            'jump':100*(hi/rs[0]['open']-1),'dump':100*(1-lo/rs[0]['open']),
            'hours':[(datetime.fromtimestamp(r['t']/1000,ZoneInfo(zone)).hour,float(abs(v)/denom) if denom>0 else 0) for r,v in zip(rs,ret)]})
    return data

def hit(row,kind,window):return sum(w for h,w in row[kind] if h in window)

def best_window(train,kind):
    # Three adjacent hours within the same local day, chosen before holdout.
    return max(([h,h+1,h+2] for h in range(22)),key=lambda win:np.mean([hit(r,kind,win) for r in train]))

def probability(values):
    x=m.interval(values,2)
    return {k:x[k] for k in ['mean','low','high']}

def weekday_contrast(test,weekday,value):
    weeks=defaultdict(list)
    for r in test:
        week=(datetime.fromisoformat(r['date'])-timedelta(days=r['weekday'])).date().isoformat()
        weeks[week].append(r)
    contrast=[]
    for rs in weeks.values():
        if len(rs)!=7:continue
        target=[value(r) for r in rs if r['weekday']==weekday];other=[value(r) for r in rs if r['weekday']!=weekday]
        if len(target)==1 and len(other)==6:contrast.append(target[0]-np.mean(other))
    return m.interval(contrast,2)

def study(panel):
    report={'version':VERSION,'asOf':panel['asOf'],'actionable':False,'dayTimezone':'America/New_York',
      'developmentEnds':'2025-12-31','holdoutStarts':m.SPLIT,'assets':{},'limitations':[
        'Daily extremes are identified after the entire day; these are distributions, not forecasts of a known peak or bottom.',
        'Hours mark the containing hourly candle, not the exact minute. Three-hour windows were selected on development data only.',
        'Daily boundary effects can concentrate extrema near midnight without a tradable timing edge.',
        'Tied highs/lows split probability weight across tied candles; DST days require their actual 23 or 25 hours.',
        'Each weekday has about 37 holdout days; rare jump/dump counts carry substantial uncertainty.',
        'HYPE is a perpetual with shorter history. Weekdays mean local calendar days, including exchange holidays.',
        'Weekday specificity compares the selected day with the other six days within complete calendar weeks; all tests share Holm correction.']}
    tests=[]
    for symbol in m.SYMBOLS:
        data=daily_extremes([r for r in panel['assets'][symbol] if r['t']+3600000<=m.stamp(panel['asOf'],0)])
        train=[r for r in data if r['date']<m.SPLIT];test=[r for r in data if r['date']>=m.SPLIT]
        thresholds={kind:max(3.,float(np.quantile([r[kind] for r in train],.95))) for kind in ['jump','dump']}
        asset={'instrument':'perpetual' if symbol=='HYPE' else 'spot','trainDays':len(train),'testDays':len(test),'thresholdsPct':thresholds,'weekdays':[],'allDays':{}}
        for kind in ['peak','bottom']:
            window=best_window(train,kind);asset['allDays'][kind]={'hoursET':window,
                'trainProbability':float(np.mean([hit(r,kind,window) for r in train])),
                'holdoutProbability':probability([hit(r,kind,window) for r in test]),
                'boundaryShare':float(np.mean([hit(r,kind,[0,1,2,21,22,23]) for r in test]))}
        for weekday,name in enumerate(DAYS):
            tr=[r for r in train if r['weekday']==weekday];te=[r for r in test if r['weekday']==weekday]
            result={'day':name,'weekday':weekday,'trainN':len(tr),'testN':len(te),'extremes':{},'events':{}}
            if len(tr)<40 or len(te)<25:
                result['status']='insufficient-history';asset['weekdays'].append(result);continue
            result['status']='descriptive-only'
            for kind in ['peak','bottom']:
                window=best_window(tr,kind);ev=weekday_contrast(test,weekday,lambda r:hit(r,kind,window));tests.append(ev)
                result['extremes'][kind]={'hoursET':window,'trainProbability':float(np.mean([hit(r,kind,window) for r in tr])),
                    'holdoutProbability':probability([hit(r,kind,window) for r in te]),'weekdaySpecificity':ev}
            # Weekday-specific activity hours are separate from extrema hours.
            hourmeans={h:np.mean([v for r in tr for hour,v in r['hours'] if hour==h]) for h in range(24)}
            busy=sorted(hourmeans,key=hourmeans.get,reverse=True)[:3]
            activity=m.interval([np.mean([v-1 for h,v in r['hours'] if h in busy]) for r in te],2);tests.append(activity)
            result['activity']={'hoursET':busy,'evidence':activity}
            for kind in ['jump','dump']:
                threshold=thresholds[kind];ev=weekday_contrast(test,weekday,lambda r:float(r[kind]>=threshold));tests.append(ev)
                hits=[float(r[kind]>=threshold) for r in te]
                result['events'][kind]={'thresholdPct':threshold,'trainRate':float(np.mean([r[kind]>=threshold for r in tr])),
                    'testCount':int(sum(hits)),'holdoutRate':probability(hits),'weekdaySpecificity':ev}
            asset['weekdays'].append(result)
        report['assets'][symbol]=asset
    m.holm(tests);report['testFamilySize']=len(tests)
    for a in report['assets'].values():
        for day in a['weekdays']:
            for r in list(day['extremes'].values())+list(day['events'].values()):
                e=r['weekdaySpecificity'];r['weekdaySupported']=e['adjustedP']<.05 and e['low'] is not None and e['low']>0
    return report

def markdown(report):
    out=['# Daily peak/bottom hours and weekday jump/dump study',f"As of {report['asOf']}. New York calendar days; retrospective 2026 holdout. Research only.",'',
         '| Asset | All-days peak window ET | Holdout fraction | All-days bottom window ET | Holdout fraction |','|---|---|---|---|---|']
    def hours(hs):return f"{hs[0]:02}:00–{hs[-1]+1:02}:00"
    for sym,a in report['assets'].items():
        p,b=a['allDays']['peak'],a['allDays']['bottom'];out.append(f"| {sym} | {hours(p['hoursET'])} | {p['holdoutProbability']['mean']:.1%} | {hours(b['hoursET'])} | {b['holdoutProbability']['mean']:.1%} |")
    out+=['','A window containing 20% of daily peaks is not a claim that an asset usually peaks there. Daily boundary effects and uncertainty matter. No peak is known before the day ends.']
    for sym,a in report['assets'].items():
        out+=['',f'## {sym}',f"Large jump threshold: {a['thresholdsPct']['jump']:.2f}%; dump threshold: {a['thresholdsPct']['dump']:.2f}% from the opening price. Frozen development 95th percentile, minimum 3%.",'',
            '| Day | Holdout days | Peak window (fraction) | Bottom window (fraction) | Large jumps / dumps |','|---|---|---|---|---|']
        for d in a['weekdays']:
            if d['status']=='insufficient-history':out.append(f"| {d['day']} | {d['testN']} | Insufficient development history | — | — |");continue
            p,b=d['extremes']['peak'],d['extremes']['bottom'];out.append(f"| {d['day']} | {d['testN']} | {hours(p['hoursET'])} ({p['holdoutProbability']['mean']:.1%}) | {hours(b['hoursET'])} ({b['holdoutProbability']['mean']:.1%}) | {d['events']['jump']['testCount']} / {d['events']['dump']['testCount']} |")
    n=sum(r['weekdaySupported'] for a in report['assets'].values() for d in a['weekdays'] for r in list(d['extremes'].values())+list(d['events'].values()))
    out+=['',f"{n} weekday-specific extrema/event effects clear the {report['testFamilySize']}-test Holm family. Full JSON contains intervals, within-week comparisons and activity-hour results.",'']+['- '+s for s in report['limitations']]
    return '\n'.join(out)+'\n'
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--input',required=True);p.add_argument('--output',required=True);args=p.parse_args();raw=Path(args.input).read_bytes();r=study(json.loads(raw))
    r['inputHash']=hashlib.sha256(raw).hexdigest();r['codeHash']=hashlib.sha256(Path(__file__).read_bytes()+Path(__file__).with_name('session-research.py').read_bytes()+Path(__file__).with_name('tracked-research.py').read_bytes()).hexdigest()
    out=Path(args.output);out.mkdir(parents=True,exist_ok=True);(out/'calendar-report.json').write_text(json.dumps(r,indent=2,allow_nan=False));(out/'calendar-report.md').write_text(markdown(r));print(markdown(r))
