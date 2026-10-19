"""WO010 genuine disk codec and fresh-process real-poll restart/crash proofs."""
import copy,json,os,subprocess,sys,tempfile,unittest,asyncio
import bridge,replay_harness as rh
import tests_bridge_actual_pit_lifecycle_wiring as actual
import tests_wo001_road_atlanta_fixture as road
from pathlib import Path
from unittest.mock import patch
import durable_recovery as dr
import plan_lifecycle as pl
import driver_plan_command as pc
import box_authority_delivery as bd
import canonical_lifecycle_snapshot as cs
HERE=Path(__file__).parent

def run(mode,path,exchange,mutation=None):
    p=subprocess.run([sys.executable,str(HERE/'wo010_restart_runner.py'),mode,str(path),str(exchange)],capture_output=True,text=True,env=dict(os.environ,**({'WO010_MUTATION':mutation} if mutation else {})))
    if p.returncode:raise AssertionError(p.stderr)
    return json.loads(p.stdout)

class ActualRestart(unittest.TestCase):
    def test_pending_driver_target_survives_two_restarts_then_real_renderer_durable_ack(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'recovery.json';e=Path(td)/'frames.json'
            a=run('first_constraint',path,e)
            original=a['snapshots'][-1]['lifecycle']['active']
            self.assertEqual(original['target_lap'],10)
            self.assertTrue(dr.Store(str(path)).loaded['decoded']['commands'].reasons)
            for _ in range(2):
                b=run('restart_pending',path,e)
                self.assertEqual(b['snapshots'][-1]['continuity']['constraint_status'],'pending_fresh_supported_calculation')
                self.assertEqual(dr.Store(str(path)).loaded['decoded']['constraint']['target_lap'],10)
                self.assertFalse(any(s['lifecycle']['active'] for s in b['snapshots']))
            b=run('restart_vertical',path,e)
            boxes=[x for x in b['broadcasts'] if x.get('trigger')=='strategy_plan_box_call']
            self.assertEqual(len(boxes),1);self.assertEqual(boxes[0]['authority_proof']['target_lap'],10)
            self.assertNotEqual(boxes[0]['decision_id'],original['decision_id'])
            ack=next(x for x in b['broadcasts'] if x.get('type')=='box_delivery_ack')
            self.assertEqual(ack['applied'],'applied')
            saved=dr.Store(str(path)).loaded['decoded']
            self.assertTrue(saved['box'].reports);self.assertTrue(next(iter(saved['box'].attempts.values()))['confirmed_started'])
            old=next(s for s in b['snapshots'][-1]['lifecycle']['terminal_records'] if s['decision_id']==original['decision_id'])
            self.assertLess(old['origin_record_ref']['revision'],old['current_custody_ref']['revision'])
            self.assertEqual(old['origin_record_ref']['bridge_process_epoch'],a['epoch'])

    def test_historical_ack_lost_and_late_started_have_zero_current_impact(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'recovery.json';e=Path(td)/'frames.json'
            first=run('first_box',path,e);self.assertIsNone(dr.Store(str(path)).error)
            second=run('restart_history',path,e)
            acks=[x for x in second['broadcasts'] if x.get('type')=='historical_settlement_ack']
            self.assertEqual([x['applied'] for x in acks],['retry_no_op','retry_no_op','collision','rejected','applied','retry_no_op'])
            self.assertTrue(all(x['historical_only'] and x['current_bridge_process_epoch']==second['epoch'] for x in acks))
            saved=dr.Store(str(path)).loaded['decoded'];archive=saved['archives'][first['epoch']]
            self.assertTrue(next(iter(archive['box'].attempts.values()))['confirmed_started'])
            self.assertFalse(saved['box'].reports);self.assertFalse(saved['commands'].commands)
            self.assertTrue(all(not a['confirmed_started'] and a['canonical_dispatch_ref']['bridge_process_epoch']==second['epoch'] for a in saved['box'].attempts.values()))
            self.assertTrue(all(x['decision_id']!=first['snapshots'][-1]['lifecycle']['active_plan_id'] for x in second['broadcasts'] if x.get('trigger')=='strategy_plan_box_call'))

    def test_finished_real_pit_and_finish_checkpoint_restored_fresh_process(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'recovery.json';e=Path(td)/'frames.json'
            a=run('first_finished',path,e);b=run('restart',path,e)
            self.assertNotEqual(a['epoch'],b['epoch']);self.assertTrue(path.exists())
            first=a['snapshots'][-1];second=b['snapshots'][-1]
            self.assertEqual(first['race_facts']['driver_pit_sequence'],1)
            self.assertEqual(second['race_facts']['driver_pit_sequence'],1)
            self.assertTrue(first['execution']['scope_closed']);self.assertTrue(second['execution']['scope_closed'])
            self.assertGreaterEqual(len(second['lifecycle']['terminal_records']),len(first['lifecycle']['terminal_records']))
            self.assertTrue(second['continuity']['restored']);self.assertTrue(second['continuity']['gap_unknown'])
            self.assertEqual([x for x in b['broadcasts'] if x.get('trigger')=='strategy_plan_box_call'],[])
            oldevent=first['pit_ledger']['events'][0];newevent=second['pit_ledger']['events'][0]
            self.assertEqual(newevent['origin_event_ref']['bridge_process_epoch'],a['epoch'])
            self.assertEqual(oldevent['pit_event_id'],newevent['pit_event_id'])
    def test_old_active_invalidated_and_terminal_never_reactivated(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'recovery.json';e=Path(td)/'frames.json'
            a=run('first_active',path,e);old=a['snapshots'][-1]['lifecycle']['active'];self.assertIsNotNone(old)
            b=run('restart',path,e)
            terminals=b['snapshots'][-1]['lifecycle']['terminal_records'];r=next(r for r in terminals if r['decision_id']==old['decision_id'])
            self.assertEqual(r['phase'],'invalidated');self.assertEqual(r['invalidated_reason'],'restart_continuity_unverified')
            self.assertEqual(r['origin_record_ref']['bridge_process_epoch'],a['epoch'])
            self.assertFalse(any(s['lifecycle']['active_plan_id']==old['decision_id'] for s in b['snapshots']))
    def test_fresh_supported_new_decision_after_restart_uses_new_generation(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'recovery.json';e=Path(td)/'frames.json'
            a=run('first_active',path,e);old=a['snapshots'][-1]['lifecycle']['active']['decision_id']
            b=run('restart_new',path,e)
            active=[s['lifecycle']['active'] for s in b['snapshots'] if s['lifecycle']['active']]
            self.assertTrue(active);self.assertTrue(all(r['decision_id']!=old for r in active))
            self.assertTrue(any(b['epoch'] in r['decision_id'] for r in active))
    def test_open_visit_is_actual_entry_checkpoint_and_resume_exit_unresolved_once(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'recovery.json';e=Path(td)/'frames.json'
            a=run('first_open',path,e);before=dr.Store(str(path)).loaded['decoded']
            self.assertIsNotNone(before['visit']['entry']);self.assertIs(before['boundary']['on_pit_road'],True)
            self.assertEqual(before['pit_sequence'],0)
            b=run('restart',path,e);snaps=b['snapshots']
            self.assertEqual(snaps[0]['race_facts']['driver_pit_sequence'],0)
            self.assertEqual(snaps[-1]['race_facts']['driver_pit_sequence'],1)
            event=snaps[-1]['pit_ledger']['events'][0]
            self.assertEqual(event['execution_relation'],'unresolved');self.assertEqual(event['penalty_evidence']['state'],'unknown')
            c=run('restart',path,e);self.assertEqual(c['snapshots'][-1]['race_facts']['driver_pit_sequence'],1)

    def test_strict_genuine_bundle_semantic_mutations_fail_decode(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'recovery.json';e=Path(td)/'frames.json';run('first_finished',path,e)
            original=json.loads(path.read_text())
            def record(w):return next(iter(w['domains']['state']['fields']['plan_records'].values()))['fields']
            cases=[('closed_bool',lambda w:w['domains'].__setitem__('closed',[w['scope']['race_instance_id'],False])),
              ('visit_frozen_bad',lambda w:w['domains']['visit'].__setitem__('plan_reference',{'wrong':1})),
              ('constraint_wrong_scope',lambda w:w['domains'].__setitem__('constraint',{'race_instance_id':'other','target_lap':True})),
              ('origin_empty',lambda w:w['domains']['origins'].__setitem__('origin_epoch','')),
              ('negative_time',lambda w:w['domains']['boundary'].__setitem__('session_time_s',-1))]
            for key in ['target_lap','set_fuel_l','add_fuel_l','registered_driver_pit_sequence','activated_source_frame_sequence','expected_pit_sequence']:
                cases.append((key,lambda w,k=key:record(w).__setitem__(k,-1)))
            for name,mutate in cases:
                with self.subTest(name=name):
                    w=copy.deepcopy(original);mutate(w);body={k:v for k,v in w.items() if k!='digest'}
                    import hashlib
                    w['digest']=hashlib.sha256(dr.canonical(body).encode()).hexdigest();path.write_text(json.dumps(w))
                    self.assertIsNotNone(dr.Store(str(path)).error)
            path.write_text(json.dumps(original));self.assertIsNone(dr.Store(str(path)).error)

    def test_restore_read_and_commit_removal_make_same_durable_assertions_red(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'cp.json';e=Path(td)/'e'
            first=run('first_finished',path,e)
            second=run('restart',path,e,mutation='skip_restore')
            with self.assertRaises(AssertionError):self.assertEqual(second['snapshots'][-1]['race_facts']['driver_pit_sequence'],first['snapshots'][-1]['race_facts']['driver_pit_sequence'])
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'cp.json';e=Path(td)/'e'
            with self.assertRaises(AssertionError) as failure:run('first_box',path,e,mutation='skip_before_send')
            self.assertIn('candidate proof not committed before broadcast',str(failure.exception))

    def test_created_before_send_and_sent_before_mark_crashes_never_replay_old_attempt(self):
        for mode in ('first_created','first_sent'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as td:
                path=Path(td)/'cp.json';e=Path(td)/'e'
                a=run(mode,path,e);saved=dr.Store(str(path)).loaded['decoded']
                self.assertEqual(len(saved['box'].attempts),1);old=next(iter(saved['box'].attempts.values()))
                self.assertEqual(old['status'],'created')
                candidates=[x for x in a['broadcasts'] if x.get('trigger')=='strategy_plan_box_call']
                self.assertEqual(len(candidates),0 if mode=='first_created' else 1)
                b=run('restart',path,e);saved=dr.Store(str(path)).loaded['decoded']
                archived=saved['archives'][a['epoch']]['box'].attempts[old['attempt_id']]
                self.assertEqual(archived['status'],'delivery_unknown')
                self.assertFalse([x for x in b['broadcasts'] if x.get('trigger')=='strategy_plan_box_call' and x['box_attempt']['attempt_id']==old['attempt_id']])

    def test_report_commit_ack_lost_then_fresh_process_returns_original_historical_receipt(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'cp.json';e=Path(td)/'e';run('first_constraint',path,e)
            first=run('restart_report_crash',path,e)
            self.assertFalse([x for x in first['broadcasts'] if x.get('type')=='box_delivery_ack'])
            saved=dr.Store(str(path)).loaded['decoded'];self.assertTrue(saved['box'].reports)
            aid=next(iter(saved['box'].attempts));self.assertTrue(saved['box'].attempts[aid]['confirmed_started'])
            second=run('restart_report',path,e)
            ack=next(x for x in second['broadcasts'] if x.get('type')=='historical_settlement_ack')
            self.assertEqual(ack['applied'],'retry_no_op');self.assertTrue(ack['historical_only'])
            saved=dr.Store(str(path)).loaded['decoded']
            self.assertTrue(saved['archives'][first['epoch']]['box'].attempts[aid]['confirmed_started'])
            self.assertFalse(saved['box'].reports)
            self.assertFalse([x for x in second['broadcasts'] if x.get('trigger')=='strategy_plan_box_call' and x['box_attempt']['attempt_id']==aid])

    def test_same_bare_command_id_in_new_epoch_is_independent_of_archived_receipt(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'cp.json';e=Path(td)/'e';first=run('first_constraint',path,e)
            second=run('restart_same_id',path,e)
            a=next(x for x in first['broadcasts'] if x.get('type')=='driver_plan_command_ack' and x.get('outcome')=='applied')
            b=next(x for x in second['broadcasts'] if x.get('type')=='driver_plan_command_ack' and x.get('outcome')=='applied')
            self.assertEqual(a['command_id'],b['command_id']);self.assertNotEqual(a['successor_decision_id'],b['successor_decision_id'])
            saved=dr.Store(str(path)).loaded['decoded']
            self.assertEqual(saved['archives'][first['epoch']]['commands'].acknowledgements[a['command_id']]['bridge_process_epoch'],first['epoch'])
            self.assertEqual(saved['commands'].acknowledgements[b['command_id']]['bridge_process_epoch'],second['epoch'])

    def test_atomic_write_failure_preserves_old_complete_bundle(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'recovery.json';e=Path(td)/'frames.json';run('first_active',path,e)
            before=path.read_bytes();store=dr.Store(str(path));w=store.loaded
            with patch.object(dr.os,'replace',side_effect=OSError('disk failure')):
                with self.assertRaises(dr.RecoveryError):store.commit(w['scope'],w['process_epoch'],w['decoded'])
            self.assertEqual(path.read_bytes(),before);self.assertIsNone(dr.Store(str(path)).error)
            self.assertEqual(store.metrics['failures'],1)
    def test_digest_corruption_is_explicit_fail_closed(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'recovery.json';e=Path(td)/'frames.json';run('first_active',path,e)
            d=json.loads(path.read_text());d['domains']['pit_sequence']=99;path.write_text(json.dumps(d))
            b=run('restart',path,e)
            self.assertTrue(all(not s['execution']['allowed'] for s in b['snapshots']))
            self.assertEqual(b['snapshots'][-1]['continuity']['recovery_status'],'restore_failed')
            self.assertIn('digest',b['snapshots'][-1]['continuity']['error'])

class ActualProcessContinuity(unittest.TestCase):
    def test_driver_scope_roundtrip_and_unknown_raw_isolation(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'recovery.json';e=Path(td)/'frames.json';run('first_finished',path,e)
            frames=[rh.make_frame(SessionTime=500+i,Lap=8,FuelLevel=35) for i in range(320)]
            def hook(cursor,frame,result):
                driver=10101 if cursor<70 or cursor>=230 else 0 if cursor>=160 else 20202
                bridge.reader.session_info=road.ROAD_ATLANTA_SESSION_INFO.replace('UserID: 10101','UserID: '+str(driver))
            r=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO,on_frame_ready=hook,recovery_path=str(path))
            snaps=[x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot' and x.get('telemetry_available')]
            first=[x for x in snaps if x['source_frame']['sequence']<50]
            middle=[x for x in snaps if (x['continuity'].get('stable_scope') or {}).get('driver_id')==20202]
            final=[x for x in snaps if x['source_frame']['sequence']>290]
            unknown=[x for x in snaps if x['continuity']['recovery_status']=='identity_unsupported']
            self.assertTrue(first and middle and final and unknown)
            self.assertTrue(first[-1]['execution']['scope_closed']);self.assertEqual(first[-1]['race_facts']['driver_pit_sequence'],1)
            self.assertTrue(all(not x['execution']['scope_closed'] and x['race_facts']['driver_pit_sequence']==0 and not x['lifecycle']['terminal_records'] for x in middle+final))
            self.assertTrue(all(not x['execution']['allowed'] and not x['continuity']['durable_commit'] for x in unknown))
            saved=dr.Store(str(path)).loaded;self.assertEqual(saved['scope']['driver_id'],10101)
            self.assertFalse(saved['decoded']['closed']);self.assertEqual(saved['decoded']['pit_sequence'],0)
            archives=list(saved['decoded']['scope_archives'].values())
            self.assertGreaterEqual(len(archives),2)
            self.assertTrue(any(a['scope']['driver_id']==10101 and a['domains']['closed'] and a['domains']['pit_sequence']==1 and a['domains']['state'].history for a in archives))

    def test_sdk_gap_and_raw_rollback_invalidate_old_authority_and_persist_gap(self):
        for kind in ('gap','rollback'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as td:
                path=Path(td)/'cp.json';state={};frames=actual.base()
                def hook(cursor,frame,result):
                    live=[x for x in result.broadcasts if x.get('type')=='telemetry_live' and x.get('active_plan_decision_id')]
                    if live and not state:
                        state['old']=live[-1]['active_plan_decision_id']
                        tm=0 if kind=='rollback' else 800
                        tail=[rh.make_frame(SessionTime=tm+i,Lap=5,FuelLevel=45) for i in range(6)]
                        if kind=='gap':tail.insert(0,dict(_inactive=True))
                        result.live_frames[cursor:]=tail
                r=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO,on_frame_ready=hook,recovery_path=str(path))
                s=[x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot'][-1]
                if kind=='rollback':
                    old=next(x for x in s['lifecycle']['terminal_records'] if x['decision_id']==state['old'])
                    self.assertEqual(old['phase'],'invalidated')
                else:
                    unavailable=next(x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot' and not x['telemetry_available'])
                    self.assertFalse(unavailable['execution']['allowed']);self.assertIsNotNone(unavailable['lifecycle']['active'])
                self.assertTrue(s['continuity']['gap_unknown']);self.assertFalse(s['execution']['allowed'])
                self.assertTrue(dr.Store(str(path)).loaded['decoded']['boundary']['gap_unknown'])

    def test_write_failure_never_publishes_applied_ack_box_or_plan_radio(self):
        with tempfile.TemporaryDirectory() as td:
            with patch.object(dr.Store,'commit',side_effect=dr.RecoveryError('injected_disk_failure')):
                r=rh.replay(actual.base(),session_info=road.ROAD_ATLANTA_SESSION_INFO,recovery_path=str(Path(td)/'cp.json'))
            self.assertFalse([x for x in r.broadcasts if x.get('type') in ('driver_plan_command_ack','box_delivery_ack') or x.get('trigger') in ('strategy_plan_box_call','initial_strategy_plans','strategy_plan_decision','strategy_plan_proposal')])
            snaps=[x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot']
            self.assertTrue(all(not x['execution']['allowed'] and not x['continuity']['durable_commit'] for x in snaps))

    def test_command_receipt_after_registry_eviction_replays_original_ack_once(self):
        frames=actual.base();last=frames[-1]
        frames += [rh.make_frame(SessionTime=last['SessionTime']+1+i,Lap=last['Lap'],FuelLevel=last['FuelLevel']) for i in range(180)]
        state={}
        def receive(msg):
            class Socket:
                async def send(self,data):pass
                def __aiter__(self):return self
                async def __anext__(self):
                    if hasattr(self,'done'):raise StopAsyncIteration
                    self.done=True;return json.dumps(msg)
            with patch.object(bridge,'list_input_devices',lambda:[]),patch.object(bridge,'log',lambda x:None):asyncio.run(bridge.handler(Socket()))
        def hook(cursor,frame,result):
            live=[x for x in result.broadcasts if x.get('type')=='telemetry_live' and x.get('active_plan_decision_id')]
            if live and not state:
                state['command']=dict(actual.command(live[-1],'cancel'),cmd='driver_plan_command')
                receive(state['command'])
            if state and cursor>160 and not state.get('retry'):
                self.assertNotIn(state['command']['canonical_snapshot_id'],bridge._canonical_publications)
                state['retry']=True;receive(state['command'])
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'cp.json';r=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO,on_frame_ready=hook,recovery_path=str(path))
            acks=[x for x in r.broadcasts if x.get('type')=='driver_plan_command_ack' and x.get('command_id')=='wo007-cancel']
            self.assertEqual([x['outcome'] for x in acks],['applied','retry_no_op'])
            self.assertEqual(acks[0]['result_revision'],acks[1]['result_revision']);self.assertEqual(acks[0]['canonical_snapshot_id'],acks[1]['canonical_snapshot_id'])
            saved=dr.Store(str(path)).loaded['decoded'];self.assertEqual(len(saved['commands'].commands),1)
            self.assertEqual(len([h for h in saved['state'].history if h.decision_id==state['command']['expected_decision_id'] and h.phase=='cancelled']),1)

    def test_receipt_idempotency_removal_makes_same_original_ack_assert_red(self):
        original=pc.classify_delivery
        def mutation(ledger,command):
            n,status,c=original(ledger,command)
            return n,'new' if status=='retry' else status,c
        with patch.object(pc,'classify_delivery',mutation):
            with self.assertRaises(AssertionError) as failure:self.test_command_receipt_after_registry_eviction_replays_original_ack_once()
        self.assertIn('retry_no_op',str(failure.exception))

    def test_multiple_writers_and_fsync_failure_preserve_current_complete_bundle(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'cp.json';e=Path(td)/'e';run('first_active',path,e)
            a=dr.Store(str(path));b=dr.Store(str(path));w=a.loaded
            a.commit(w['scope'],w['process_epoch'],w['decoded']);latest=path.read_bytes()
            with self.assertRaisesRegex(dr.RecoveryError,'writer_collision'):b.commit(w['scope'],w['process_epoch'],w['decoded'])
            self.assertEqual(path.read_bytes(),latest)
            if os.name!='nt':
                import fcntl
                lockfd=os.open(str(path)+'.lock',os.O_RDWR);fcntl.flock(lockfd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                try:
                    with self.assertRaises(dr.RecoveryError):a.commit(w['scope'],w['process_epoch'],w['decoded'])
                    self.assertEqual(path.read_bytes(),latest)
                finally:os.close(lockfd)
            with patch.object(dr.os,'fsync',side_effect=OSError('fsync failure')):
                with self.assertRaisesRegex(dr.RecoveryError,'fsync failure'):a.commit(w['scope'],w['process_epoch'],w['decoded'])
            self.assertEqual(path.read_bytes(),latest)
            with patch.object(dr,'MAX_BYTES',10):
                with self.assertRaises(dr.RecoveryError):a.commit(w['scope'],w['process_epoch'],w['decoded'])
            self.assertEqual(path.read_bytes(),latest)

    def test_semantic_ack_and_report_mutations_reject_even_with_valid_outer_digest(self):
        import hashlib
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'cp.json';e=Path(td)/'e';first=run('first_box',path,e);run('restart_history',path,e)
            original=json.loads(path.read_text());epoch=first['epoch']
            def ack(w):return next(iter(w['domains']['archives'][epoch]['commands']['fields']['acknowledgements'].values()))
            def report(w):return next(iter(w['domains']['archives'][epoch]['box']['fields']['reports'].values()))
            cases=[]
            for key,value in [('result_revision',0),('lifecycle_phase','executed'),('successor_revision',99),('successor_revision',False),('successor_add_fuel_l',999),('successor_activation_frame',999),('constraint_id','other')]:
                cases.append((key,lambda w,k=key,v=value:ack(w).__setitem__(k,v)))
            cases += [('huge_sequence',lambda w:w['domains'].__setitem__('pit_sequence',10**12)),('constraint_target',lambda w:next(r for r in w['domains']['state']['fields']['plan_records'].values() if isinstance(r['fields']['plan_basis'],dict) and r['fields']['plan_basis'].get('driver_target_constraint'))['fields']['plan_basis']['driver_target_constraint'].__setitem__('target_lap',11)),('authority_bool',lambda w:ack(w)['authority_snapshot'].__setitem__('session_num',False)),('report_bool',lambda w:report(w).__setitem__('session_num',False)),('report_revision_bool',lambda w:report(w).__setitem__('plan_revision',False)),('false_started_history',lambda w:report(w).__setitem__('outcome','dropped_before_audible'))]
            for name,mutation in cases:
                with self.subTest(name=name):
                    w=copy.deepcopy(original);mutation(w);w['digest']=hashlib.sha256(dr.canonical({k:v for k,v in w.items() if k!='digest'}).encode()).hexdigest();path.write_text(json.dumps(w))
                    self.assertIsNotNone(dr.Store(str(path)).error)

    def test_idle_ten_hz_checkpoint_writes_are_bounded_and_metrics_explicit(self):
        frames=[rh.make_frame(SessionTime=100+i/10,Lap=1,FuelLevel=60) for i in range(100)]
        with tempfile.TemporaryDirectory() as td:
            r=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO,recovery_path=str(Path(td)/'cp.json'),seconds_per_frame=.1)
            snapshots=[x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot']
            metrics=snapshots[-1]['continuity']['metrics']
            self.assertGreater(metrics['writes'],0);self.assertLessEqual(metrics['writes'],15)
            self.assertGreater(metrics['bytes'],0);self.assertGreaterEqual(metrics['write_ms'],0)

    def test_invalid_json_variants_fail_closed_without_poll_crash(self):
        variants=['{','{"schema_version":1,"schema_version":1}', '['*1100+'0'+']'*1100]
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'cp.json'
            for raw in variants:
                path.write_text(raw)
                r=rh.replay(actual.base(),session_info=road.ROAD_ATLANTA_SESSION_INFO,recovery_path=str(path))
                snaps=[x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot']
                self.assertTrue(snaps);self.assertTrue(all(x['continuity']['recovery_status']=='restore_failed' and not x['execution']['allowed'] for x in snaps))

if __name__=='__main__':unittest.main()
