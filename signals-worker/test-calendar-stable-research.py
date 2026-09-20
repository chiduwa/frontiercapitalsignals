import copy,importlib.util,unittest
from pathlib import Path
import numpy as np

def load(name,file):
 spec=importlib.util.spec_from_file_location(name,Path(__file__).parent/'scripts'/file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
cal=load('calendar_study','calendar-research.py');stable=load('stable_study','stable-basket-research.py')
class CalendarStable(unittest.TestCase):
 def hours(self,day):
  start=cal.m.stamp(day,0,'America/New_York');end=cal.m.stamp(cal.m.shift(day,1),0,'America/New_York')
  return [{'t':t,'open':100,'close':101,'high':102,'low':99} for t in range(start,end,3600000)]
 def test_dst_complete_day_and_tied_extremes(self):
  for day,n in [('2026-03-08',23),('2026-11-01',25),('2026-09-01',24)]:
   rows=self.hours(day);self.assertEqual(len(rows),n);result=cal.daily_extremes(rows);self.assertEqual(len(result),1)
   self.assertAlmostEqual(sum(v for h,v in result[0]['peak']),1);self.assertAlmostEqual(sum(v for h,v in result[0]['bottom']),1)
   self.assertEqual(cal.daily_extremes(rows[:-1]),[])
 def test_extreme_window_does_not_wrap_to_another_day(self):
  rows=[{'peak':[(23,.5),(0,.5)]} for _ in range(50)]
  w=cal.best_window(rows,'peak');self.assertEqual(w,list(range(w[0],w[0]+3)));self.assertLessEqual(w[-1],23)
 def test_within_week_comparison_rejects_incomplete_weeks(self):
  rows=[{'date':'2026-09-07','weekday':0,'value':1}]
  r=cal.weekday_contrast(rows,0,lambda r:r['value']);self.assertIsNone(r['low']);self.assertEqual(r['p'],1)
 def fixture(self):
  day='2025-01-01';assets={};symbols=stable.STABLES+stable.TRACKED
  for j,s in enumerate(symbols):
   assets[s]=[{'t':stable.m.stamp(stable.m.shift(day,i),0),'date':stable.m.shift(day,i),'price':100*np.exp((j-10)*i/10000),'volume':10000+i*(j+1),'mcap':1e6+i,'assumedAvailableAt':stable.m.stamp(stable.m.shift(day,i),0)+600000} for i in range(80)]
  return {'asOf':stable.m.shift(day,80),'assets':assets,'cryptoIds':{s:s for s in stable.TRACKED}}
 def test_full_basket_missing_volume_not_treated_as_zero(self):
  p=self.fixture();r,c=stable.build_records(p,{},None);self.assertEqual(c['completeBasketDays'],80)
  p['assets']['USDG'][40]['volume']=None;r2,c2=stable.build_records(p,{},None);self.assertEqual(c2['completeBasketDays'],79)
  row=next(x for x in r2['BTC'] if x['featureDate']==p['assets']['USDG'][40]['date']);self.assertIsNone(row['values']['basket8_growth1_lag0'])
 def test_feature_embargo_and_future_invariance(self):
  p=self.fixture();r,_=stable.build_records(p,{},None);row=r['BTC'][10];day=row['featureDate']
  self.assertEqual(row['date'],stable.m.shift(day,1));self.assertEqual(row['targetDate'],stable.m.shift(day,2))
  q=copy.deepcopy(p)
  for rs in q['assets'].values():
   for x in rs:
    if x['date']>day:x['volume']*=100;x['price']*=2
  changed,_=stable.build_records(q,{},None);same=next(x for x in changed['BTC'] if x['featureDate']==day);self.assertEqual(row['values'],same['values'])
 def test_median_proxy_matches_majority_and_own_past_returns(self):
  p=self.fixture();r,_=stable.build_records(p,{},None);proxy=r['TRACKED_MEDIAN'][0];targets=[next(x for x in r[s] if x['date']==proxy['date'])['target'] for s in stable.TRACKED]
  self.assertEqual(proxy['target'],float(np.median(targets)));self.assertEqual(proxy['majorityDown'],sum(x<0 for x in targets)>=4)
  past=[next(x for x in r[s] if x['date']==proxy['date'])['values']['ret1'] for s in stable.TRACKED];self.assertEqual(proxy['values']['ret1'],float(np.median(past)))
 def test_nested_model_selection_uses_only_matured_labels(self):
  rows=[{'date':stable.m.shift('2025-01-01',i),'targetDate':stable.m.shift('2025-01-01',i+1),'target':(-1)**i,'values':{}} for i in range(330)]
  original=stable.predictions;calls=[]
  def checked(train,test,sets):
   self.assertLess(max(r['targetDate'] for r in train),min(r['date'] for r in test));calls.append(len(test));n=len(test)
   return {'baseline':np.full(n,.5),'baseRate':np.full(n,.5)},{'baseline':np.zeros(n),'zero':np.zeros(n)},{'baseline':np.ones(n),'median':np.ones(n)}
  stable.predictions=checked
  try:
   # Short outer window stays below report minimum, while exercising inner/outer fits.
   result,_=stable.evaluate(rows,'2026-03-01',{})
   self.assertTrue(calls)
  finally:stable.predictions=original
 def test_bootstrap_reproducible_and_holm_family_controls(self):
  a=np.tile([.01,-.01],(60,1));x=stable.bootstrap_many(a,draws=1000);y=stable.bootstrap_many(a,draws=1000);self.assertEqual(x,y)
  stable.m.holm(x);self.assertLess(x[0]['adjustedP'],.05);self.assertGreater(x[1]['adjustedP'],.05)
if __name__=='__main__':unittest.main()
