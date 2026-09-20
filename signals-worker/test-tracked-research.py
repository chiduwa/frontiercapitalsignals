import importlib.util
from pathlib import Path
import unittest
import numpy as np

spec=importlib.util.spec_from_file_location('research',Path(__file__).parent/'scripts/tracked-research.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class ResearchTests(unittest.TestCase):
    def test_purged_nonoverlapping_folds(self):
        rows=[]
        for i in range(600):
            d=np.datetime64('2023-01-01')+np.timedelta64(i,'D')
            rows.append({'date':str(d),'targetDate':str(d+np.timedelta64(7,'D')),'horizon':7})
        fs=list(m.folds(rows,'2024-01-01','2024-09-01'))
        self.assertTrue(fs)
        testdates=[]
        for train,val,test in fs:
            self.assertLess(max(r['targetDate'] for r in train),val[0]['date'])
            self.assertLess(max(r['targetDate'] for r in val),test[0]['date'])
            testdates+=test
        self.assertTrue(all(a['targetDate']<=b['date'] for a,b in zip(testdates,testdates[1:])))

    def test_train_transform_does_not_read_test_distribution(self):
        x=np.c_[np.arange(50),np.full(50,np.nan)]
        a,b=m.transform(x,np.array([[100,np.nan]]))
        c,d=m.transform(x,np.array([[100,np.nan],[1e20,1e20]]))
        np.testing.assert_array_equal(a,c);np.testing.assert_array_equal(b,d[:1])
        self.assertEqual(a.shape[1],3) # intercept, field, its missingness

    def test_logistic_recovers_direction_and_magnitude_ridge_is_separate(self):
        rng=np.random.default_rng(23);x=np.c_[np.ones(700),rng.normal(size=700)]
        y=(x[:,1]+rng.normal(size=700)*.25>0).astype(float)
        p=m.logistic(x[:500],y[:500],x[500:])
        self.assertGreater(np.mean((p>.5)==y[500:]),.85)
        mag=2+3*x[:,1]
        pred=m.ridge(x[:500],mag[:500],x[500:],penalty=.00001)
        self.assertLess(np.max(abs(pred-mag[500:])),1e-5)

    def test_future_outcomes_cannot_change_an_earlier_selection(self):
        rows=[]
        for i in range(260):
            date=np.datetime64('2024-01-01')+np.timedelta64(i,'D')
            values={k:float(np.sin(i*.23+j)) for j,k in enumerate(m.PV+m.OI+m.FUNDING+m.LIQ+m.HAR)}
            values.update({'dailyVol':.02,'ewmaVol':.021,'harDaily':.02,'harWeek':.021,'harMonth':.022})
            rows.append({'date':str(date),'targetDate':str(date+np.timedelta64(1,'D')),
                         'horizon':1,'target':float(np.sin(i*.27)),'values':values})
        a,sel=m.evaluate(rows,'BTC',['BTC'],'2024-07-01','2024-09-20')
        changed=[{**r,'target':1000 if r['date']>'2024-08-15' else r['target']} for r in rows]
        b,other=m.evaluate(changed,'BTC',['BTC'],'2024-07-01','2024-09-20')
        self.assertTrue(a)
        self.assertEqual([r for r in a if r['targetDate']<'2024-08-15'],[r for r in b if r['targetDate']<'2024-08-15'])
        self.assertEqual(sel[0],other[0])

    def test_bootstrap_and_tied_spearman(self):
        self.assertAlmostEqual(m.correlation([1,1,2,3],[2,2,4,6]),1)
        r=m.block_interval(np.ones(60)*.1)
        self.assertGreater(r['low'],0);self.assertLess(r['p'],.001)
        self.assertEqual(m.block_interval([0]*5)['p'],1)

if __name__=='__main__':unittest.main()
