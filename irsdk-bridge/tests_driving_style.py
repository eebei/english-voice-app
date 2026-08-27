import unittest
from driving_style import DrivingStyleAggregator


class DrivingStyleTests(unittest.TestCase):
    def feed(self, agg, lap, **kw):
        for i in range(30):
            agg.update(session_key=('s','t','c'), lap=lap, lap_dist_pct=i/30,
                speed_mps=40-i/10, brake=.5 if 5 <= i <= 10 else 0,
                throttle=1 if i >= 16 else 0, steering_rad=(-.2 if i==12 else .2),
                valid_clean=kw.get('clean', True), on_pit_road=kw.get('pit', False),
                yellow=kw.get('yellow', False), traffic=kw.get('traffic', False),
                fuel_l=30, tyre_temp_c=80, last_lap_time_s=90)

    def test_clean_lap_is_aggregated_without_raw_samples(self):
        a=DrivingStyleAggregator(); self.feed(a,1)
        out=a.update(session_key=('s','t','c'),lap=2,lap_dist_pct=0,speed_mps=40,
            brake=0,throttle=1,steering_rad=0,valid_clean=True,on_pit_road=False,
            yellow=False,traffic=False,fuel_l=27,tyre_temp_c=81,last_lap_time_s=89.5)
        self.assertTrue(out['available']); self.assertIn('minimum_speed_mps',out['features'])
        self.assertNotIn('samples',out); self.assertEqual(out['features']['lap_time_s'],89.5)

    def test_each_truth_exclusion_fails_closed(self):
        for key,reason in [('clean','invalid_lap'),('pit','pit_lap'),('yellow','yellow'),('traffic','traffic')]:
            a=DrivingStyleAggregator(); self.feed(a,1,**{key: False if key=='clean' else True})
            out=a.update(session_key=('s','t','c'),lap=2,lap_dist_pct=0,speed_mps=40,brake=0,
                throttle=1,steering_rad=0,valid_clean=True,on_pit_road=False,yellow=False,
                traffic=False,fuel_l=27,tyre_temp_c=81,last_lap_time_s=90)
            self.assertFalse(out['available']); self.assertIn(reason,out['excluded_reasons'])

    def test_session_identity_resets_history(self):
        a=DrivingStyleAggregator(); self.feed(a,1)
        a.update(session_key=('other','t','c'),lap=1,lap_dist_pct=0,speed_mps=1,brake=0,
            throttle=0,steering_rad=0,valid_clean=True,on_pit_road=False,yellow=False,
            traffic=False,fuel_l=1,tyre_temp_c=1)
        self.assertEqual(a.completed,[])

if __name__=='__main__': unittest.main()
