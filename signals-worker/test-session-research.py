import importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('sessions',Path(__file__).parent/'scripts/session-research.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Sessions(unittest.TestCase):
 def test_dst_boundary(self):
  self.assertEqual(m.stamp('2026-03-08',10,'America/New_York')-m.stamp('2026-03-08',8,'America/New_York'),7200000)
  self.assertEqual(m.stamp('2026-03-09',0,'America/New_York')-m.stamp('2026-03-08',0,'America/New_York'),23*3600000)
  self.assertEqual(m.stamp('2026-11-02',0,'America/New_York')-m.stamp('2026-11-01',0,'America/New_York'),25*3600000)
 def test_cutoff_close_not_next_hour(self):
  t=m.stamp('2026-01-01',8);rows={t-3600000:{'close':100},t:{'close':101},t+3600000:{'close':102},t+7200000:{'close':900}}
  self.assertAlmostEqual(m.move(rows,t,t+7200000),2)
  del rows[t];self.assertIsNone(m.move(rows,t,t+7200000))
 def test_missing_hour_not_zero_volume(self):
  t=m.stamp('2026-01-01',0)
  rs={t+h*3600000:{'t':t+h*3600000,'open':100,'close':100,'quoteVolume':1} for h in range(24)}
  self.assertEqual(m.daily(rs)['2026-01-01']['volume'],24)
  del rs[t];self.assertEqual(m.daily(rs),{})
 def test_price_already_above_prior_is_separate_from_forward(self):
  t=m.stamp('2026-01-01',0);rows={t+h*3600000:{'close':100 if h<8 else 110 if h<10 else 105} for h in range(-1,24)}
  self.assertGreater(m.move(rows,t,t+24*3600000),0)
  self.assertLess(m.move(rows,t+10*3600000,t+24*3600000),0)
 def test_holm_controls_family(self):
  x=[{'p':.01},{'p':.03},{'p':.5}];m.holm(x);self.assertEqual([r['adjustedP'] for r in x],[.03,.06,.5])
 def test_outcome_crossing_holdout_is_purged(self):
  rs=[{'date':'2025-12-31','endDate':'2026-01-02','values':{},'target':3}]*150
  result=m.fit_compare(rs,['windowReturn']);self.assertEqual(result['trainN'],0)
if __name__=='__main__':unittest.main()
