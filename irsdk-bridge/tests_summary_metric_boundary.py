"""Real SDK-frame replay: completion, recorded samples and clean fastest differ."""
import sys,unittest
import replay_harness as rh
import tests_wo001_road_atlanta_fixture as road

def finish_frames(delay=3,missing_counter=False,garage=False):
    frames=road.clean_laps(7)[0]
    for f in frames:
        f['CarIdxLapCompleted']=None if missing_counter else [f['Lap']-1,0,0]
        if f['LapLastLapTime']>0:
            f['LapLastLapTime']=114.835 if f['Lap']==2 else 114.548 if f['Lap']==3 else 114.835+f['Lap']*.01
        f['PlayerTrackSurface']=0 if f['Lap']==2 else 3
    last=frames[-1]
    for i in range(12):
        frames.append(rh.make_frame(SessionTime=last['SessionTime']+i+1,Lap=9,LapDistPct=.02,
            SessionState=5,SessionFlags=1,SessionLapsTotal=road.LAPS_TOTAL,CarIdxLapCompleted=None if missing_counter else [8,0,0],
            LapLastLapTime=last['LapLastLapTime'] if i<delay else 119.65,FuelLevel=5,
            IsOnTrack=not(garage and i>=1)))
    return frames

class SummaryMetricBoundary(unittest.TestCase):
    def replay_summary(self,**kwargs):
        r=rh.replay(finish_frames(**kwargs),session_info=road.ROAD_ATLANTA_SESSION_INFO)
        summaries=[s for s in r.broadcasts if s.get('type')=='session_summary']
        self.assertEqual(len(summaries),1)
        return summaries[0]
    def test_final_sample_late_and_completed_counter_are_both_preserved(self):
        s=self.replay_summary(delay=3)
        self.assertEqual(s['completed_laps'],8)
        self.assertEqual(s['recorded_lap_count'],8)
        self.assertEqual(s['laps'][-1]['time'],119.65)
        self.assertEqual(s['measured_best_lap'],114.548)
        self.assertEqual(s['strict_clean_best_lap'],114.835)
        self.assertEqual(s['laps_basis'],'sdk_completed')
        self.assertEqual(s['race_format'],'laps')
        self.assertIsNone(s['configured_duration_s'])
        self.assertEqual(s['total_laps_rule'],25)
    def test_missing_final_sample_is_bounded_and_does_not_forge_record(self):
        s=self.replay_summary(delay=99)
        self.assertEqual(s['completed_laps'],8)
        self.assertEqual(s['recorded_lap_count'],7)
        self.assertEqual(s['final_lap_sample_status'],'bounded_incomplete')
    def test_garage_during_settle_does_not_lose_finished_summary(self):
        self.assertEqual(self.replay_summary(delay=3,garage=True)['completed_laps'],8)
    def test_finish_then_sdk_gap_and_next_session_keeps_frozen_origin(self):
        frames=finish_frames(delay=99)
        prefix=frames[:29] # completed counter/finish observed; final time not yet updated
        frames=prefix+[rh.make_frame(_inactive=True) for _ in range(10)]
        frames += [rh.make_frame(SessionNum=1,SessionTime=999+i,Lap=1,FuelLevel=50) for i in range(8)]
        r=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO)
        summaries=[s for s in r.broadcasts if s.get('type')=='session_summary']
        self.assertEqual(len(summaries),1)
        self.assertEqual(summaries[0]['session_num'],0)
        self.assertEqual(summaries[0]['completed_laps'],8)
        self.assertEqual(summaries[0]['recorded_lap_count'],7)
        self.assertEqual(summaries[0]['final_lap_sample_status'],'bounded_incomplete')
        self.assertEqual(summaries[0]['race_format'],'laps')
        self.assertEqual(summaries[0]['total_laps_rule'],road.LAPS_TOTAL)
    def test_broadcast_retry_finishes_once_without_duplicate_normal_summary(self):
        offered=[];delivered=[]
        def dispatch(event):
            if event.get('type')=='session_summary':
                offered.append(event)
                if len(offered)<3:return 'HELD'
                delivered.append(event)
            return 'DISPATCHED'
        rh.replay(finish_frames(delay=99),session_info=road.ROAD_ATLANTA_SESSION_INFO,dispatch_result=dispatch)
        self.assertEqual(len(offered),3);self.assertEqual(len(delivered),1)
        self.assertTrue(all(s['session_num']==0 and s['completed_laps']==8 for s in offered))
    def test_completed_counter_late_updates_finish_outbox_without_new_lap(self):
        frames=finish_frames(delay=99)
        for i,frame in enumerate(frames[28:]):frame['CarIdxLapCompleted']=[7 if i<2 else 8,0,0]
        r=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO)
        summaries=[s for s in r.broadcasts if s.get('type')=='session_summary']
        self.assertEqual(len(summaries),1);self.assertEqual(summaries[0]['completed_laps'],8)
        self.assertEqual(summaries[0]['recorded_lap_count'],7)

    def test_final_time_precedes_completed_counter(self):
        frames=finish_frames(delay=0)
        for i,frame in enumerate(frames[28:]):frame['CarIdxLapCompleted']=[7 if i<2 else 8,0,0]
        r=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO)
        summaries=[s for s in r.broadcasts if s.get('type')=='session_summary']
        self.assertEqual(len(summaries),1)
        s=summaries[0]
        self.assertEqual(s['completed_laps'],8)
        self.assertEqual(s['recorded_lap_count'],8)
        self.assertEqual(s['laps'][-1]['time'],119.65)

    def test_non_finite_times_never_become_a_best(self):
        import driver_activity as a
        s=a.summary_metrics([{'time':float('inf')},{'time':float('nan')},{'time':114.835,'strict_clean':True}],9)
        self.assertEqual(s['recorded_lap_count'],1);self.assertEqual(s['best_lap'],114.835)

    def test_unknown_counter_does_not_claim_completed_count(self):
        s=self.replay_summary(delay=1,missing_counter=True)
        self.assertIsNone(s['completed_laps']);self.assertEqual(s['laps_basis'],'recorded_samples')

if __name__=='__main__':unittest.main()
