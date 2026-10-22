"""Fallback AI race custody: durable same-process receipts, never restart identity."""
import copy,hashlib,json,os,re,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import durable_recovery as dr
import replay_harness as rh
import tests_wo001_road_atlanta_fixture as road
import bridge
HERE=Path(__file__).parent

def runner(mode,path,exchange):
    code="""import sys,re,runpy
sys.path.insert(0,sys.argv[1]);import tests_wo001_road_atlanta_fixture as road
road.ROAD_ATLANTA_SESSION_INFO=re.sub(r'(SubSessionID|SessionID):\\s*\\d+',r'\\1: 0',road.ROAD_ATLANTA_SESSION_INFO)
sys.argv=[sys.argv[1]+'/wo010_restart_runner.py']+sys.argv[2:]
runpy.run_path(sys.argv[0],run_name='__main__')
"""
    p=subprocess.run([sys.executable,'-c',code,str(HERE.resolve()),mode,str(path),str(exchange)],capture_output=True,text=True)
    if p.returncode:raise AssertionError(p.stderr[-6000:])
    return json.loads(p.stdout)

class ProcessCustody(unittest.TestCase):
    def test_contract_does_not_expand_stable_identity(self):
        self.assertIsNone(dr.stable_scope({'player_cust_id':10101},'fallback:race',0))
        scope=dr.custody_scope({'player_cust_id':10101},'fallback:race',0,'owner-a')
        self.assertTrue(dr.valid_scope(scope,'owner-a'));self.assertFalse(dr.valid_scope(scope,'owner-b'))
        self.assertIsNone(dr.custody_scope({'player_cust_id':0},'fallback:race',0,'owner-a'))

    def test_native_renderer_command_ack_box_committed_then_new_process_cannot_resume(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'cp.json';exchange=Path(td)/'exchange.json'
            first=runner('first_box',path,exchange)
            active=[s for s in first['snapshots'] if s['lifecycle']['active']]
            self.assertTrue(active)
            self.assertTrue(all(s['continuity']['stable_scope'] is None for s in first['snapshots']))
            self.assertTrue(all(s['continuity']['custody_scope']['process_epoch']==first['epoch'] for s in first['snapshots']))
            ack=[x for x in first['broadcasts'] if x.get('type')=='driver_plan_command_ack' and x.get('outcome')=='applied']
            self.assertTrue(ack);self.assertEqual(ack[0]['successor_target_lap'],10)
            boxes=[x for x in first['broadcasts'] if x.get('trigger')=='strategy_plan_box_call']
            self.assertEqual(len(boxes),1)
            old=boxes[0]['decision_id'];saved=dr.Store(str(path)).loaded
            self.assertEqual(saved['scope']['process_epoch'],first['epoch'])
            self.assertTrue(saved['decoded']['commands'].acknowledgements)
            second=runner('restart_history',path,exchange)
            self.assertNotEqual(second['epoch'],first['epoch'])
            self.assertFalse(any(s['continuity']['restored'] for s in second['snapshots']))
            self.assertTrue(all(s['continuity']['custody_scope']['process_epoch']==second['epoch'] for s in second['snapshots']))
            self.assertFalse(any(s['lifecycle']['active_plan_id']==old for s in second['snapshots']))
            self.assertFalse(any(x.get('decision_id')==old for x in second['broadcasts'] if x.get('trigger')=='strategy_plan_box_call'))
            self.assertFalse(any(x.get('type')=='driver_plan_command_ack' and x.get('outcome')=='applied' for x in second['broadcasts']))
            latest=dr.Store(str(path)).loaded
            self.assertFalse(latest['decoded']['commands'].commands)
            self.assertTrue(latest['decoded']['scope_archives'])
            # Even a recalculated valid digest cannot authorize a mismatched
            # checkpoint process scope.
            bad=json.loads(path.read_text());bad['scope']['process_epoch']='wrong-owner'
            bad['digest']=hashlib.sha256(dr.canonical({k:v for k,v in bad.items() if k!='digest'}).encode()).hexdigest()
            path.write_text(json.dumps(bad));self.assertIsNotNone(dr.Store(str(path)).error)

    def test_command_checkpoint_failure_never_publishes_ack_or_box(self):
        import tests_bridge_actual_pit_lifecycle_wiring as actual
        info=re.sub(r'(SubSessionID|SessionID):\s*\d+',r'\1: 0',road.ROAD_ATLANTA_SESSION_INFO)
        original=dr.Store.commit;sent=[]
        def commit(store,scope,epoch,domains):
            if domains['commands'].commands:raise dr.RecoveryError('injected_command_disk_failure')
            return original(store,scope,epoch,domains)
        def hook(cursor,frame,result):
            live=[x for x in result.broadcasts if x.get('type')=='telemetry_live' and x.get('active_plan_decision_id')]
            if live and not sent:
                cmd=actual.command(live[-1],'cancel');sent.append(cmd);bridge._queue_driver_plan_command(cmd)
        with patch.object(dr.Store,'commit',commit):
            r=rh.replay(road.clean_laps(7)[0],session_info=info,on_frame_ready=hook)
        self.assertTrue(sent)
        self.assertFalse(any(x.get('type')=='driver_plan_command_ack' for x in r.broadcasts))
        self.assertFalse(r.by_trigger('strategy_plan_box_call'))
        self.assertTrue(r.logs_containing('RECOVERY COMMIT FAILURE:'))

    def test_session_switch_never_carries_previous_agreement(self):
        info=re.sub(r'(SubSessionID|SessionID):\s*\d+',r'\1: 0',road.ROAD_ATLANTA_SESSION_INFO)
        frames=road.clean_laps(7)[0]
        last=frames[-1]
        frames += [rh.make_frame(SessionNum=1,SessionTime=last['SessionTime']+i+1,Lap=1,FuelLevel=19) for i in range(30)]
        r=rh.replay(frames,session_info=info)
        snapshots=[x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot']
        prior={x['lifecycle']['active_plan_id'] for x in snapshots if x['session_num']==0 and x['lifecycle']['active_plan_id']}
        new=[x for x in snapshots if x['session_num']==1]
        self.assertTrue(prior and new)
        self.assertTrue(all(x['lifecycle']['active_plan_id'] not in prior and x['race_facts']['driver_pit_sequence']==0 for x in new))
        self.assertTrue(all(x['continuity']['custody_scope']['session_num']==1 for x in new))

    def test_pit_excluded_measurements_are_not_labelled_strict_clean(self):
        frames=road.clean_laps(7)[0]
        for frame in frames:frame['PlayerTrackSurface']=0 if frame['Lap'] in (3,4,5) else 3
        r=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO)
        samples=[s['recommendations']['fuel_strategy']['value'] for s in r.broadcasts
          if s.get('type')=='canonical_lifecycle_snapshot' and s['current_facts']['current_lap']==7
          and (s['recommendations'].get('fuel_strategy',{}).get('value') or {}).get('evaluated_lap')==7]
        self.assertTrue(samples)
        self.assertTrue(all(s['measured_laps_sampled']==5 and s['clean_laps_sampled']==2 and s['strict_clean_laps_sampled']==2 for s in samples))
        self.assertTrue(all(s['fuel_sample_basis']=='pit_excluded_measured' and s['strict_clean_avg_fuel_per_lap']>0 for s in samples))

    def test_unknown_driver_gap_cannot_resume_same_drivers_old_plan(self):
        info=re.sub(r'(SubSessionID|SessionID):\s*\d+',r'\1: 0',road.ROAD_ATLANTA_SESSION_INFO)
        frames=road.clean_laps(7)[0]
        last=frames[-1]
        frames += [rh.make_frame(SessionTime=last['SessionTime']+i+1,Lap=8,FuelLevel=35) for i in range(230)]
        def hook(cursor,frame,result):
            cust=0 if 60<=cursor<150 else 10101
            bridge.reader.session_info=info.replace('UserID: 10101','UserID: '+str(cust))
        r=rh.replay(frames,session_info=info,on_frame_ready=hook)
        snapshots=[x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot']
        old={x['lifecycle']['active_plan_id'] for x in snapshots if x['source_frame']['sequence']<60 and x['lifecycle']['active_plan_id']}
        unknown=[x for x in snapshots if x['continuity']['recovery_status']=='identity_unsupported']
        after=[x for x in snapshots if x['source_frame']['sequence']>190 and (x['continuity'].get('custody_scope') or {}).get('driver_id')==10101]
        self.assertTrue(old and unknown and after)
        self.assertTrue(all(x['lifecycle']['active_plan_id'] not in old for x in after))
        self.assertFalse(any(x.get('decision_id') in old for x in r.by_trigger('strategy_plan_box_call')))

    def test_driver_swap_and_missing_driver_fail_closed(self):
        info=re.sub(r'(SubSessionID|SessionID):\s*\d+',r'\1: 0',road.ROAD_ATLANTA_SESSION_INFO)
        frames=[rh.make_frame(SessionTime=500+i,Lap=8,FuelLevel=35) for i in range(260)]
        def hook(cursor,frame,result):
            cust=10101 if cursor<70 else 20202 if cursor<150 else 0
            bridge.reader.session_info=info.replace('UserID: 10101','UserID: '+str(cust))
        r=rh.replay(frames,session_info=info,on_frame_ready=hook)
        snaps=[s for s in r.broadcasts if s.get('type')=='canonical_lifecycle_snapshot']
        own=[s for s in snaps if (s['continuity'].get('custody_scope') or {}).get('driver_id')==20202]
        unknown=[s for s in snaps if s['continuity']['recovery_status']=='identity_unsupported']
        self.assertTrue(own and unknown)
        self.assertTrue(all(s['race_facts']['driver_pit_sequence']==0 and not s['lifecycle']['terminal_records'] for s in own))
        self.assertTrue(all(not s['execution']['allowed'] and not s['continuity']['durable_commit'] for s in unknown))

if __name__=='__main__':unittest.main()
