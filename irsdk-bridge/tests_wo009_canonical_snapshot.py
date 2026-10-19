"""WO009 producer, real poll, epoch/ref and dispatch ordering assertions."""
import os,sys,json,unittest,copy,subprocess
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,os.path.dirname(__file__))
import bridge,replay_harness as rh,tests_wo001_road_atlanta_fixture as road
import canonical_lifecycle_snapshot as cs,box_authority_delivery as bd,plan_lifecycle as pl
from tests_wo008_fixed_target import inputs,ActualPoll,wire_refs

class PureSnapshot(unittest.TestCase):
 def make(self,**kw):
  st=pl.new_race_strategy_state('r',0)
  st,_=pl.register_plan(st,decision_id='d',race_instance_id='r',session_num=0,selected_plan='A',phase='active',current_driver_pit_sequence=0,created_source_frame_sequence=2,activation_source_frame_sequence=2,target_lap=10,add_fuel_l=13,set_fuel_l=13)
  facts=bridge.race_facts_mod.build_snapshot(race_instance_id='r',session_num=0,source_frame_sequence=9,session_time_s=10.,raw_session_flags=0,driver_pit_sequence=0)
  args=dict(state=st,facts=facts,inputs=inputs(),pit_store={},box_ledger=bd.new_ledger(),box_projection={},on_pit_road=False,on_track=True)
  args.update(kw);return cs.build(**args)
 def test_snapshot_deep_immutable_and_serializer_copy(self):
  s=self.make();a=s.serialize();a['lifecycle']['active']['target_lap']=999
  self.assertEqual(10,s.serialize()['lifecycle']['active']['target_lap'])
  with self.assertRaises(TypeError):s.data['lifecycle']['active']['target_lap']=999
  json.dumps(s.serialize(),allow_nan=False)
 def test_publication_is_process_monotonic(self):
  a=self.make().serialize();b=self.make().serialize();self.assertEqual(a['snapshot_sequence']+1,b['snapshot_sequence']);self.assertEqual(a['bridge_process_epoch'],b['bridge_process_epoch'])
 def test_current_final_lap_geometry_separate(self):
  s=self.make(inputs=inputs(current_lap=25)).serialize();self.assertEqual(0,s['finish']['remaining_after_current']);self.assertEqual(1,s['finish']['remaining_sf_crossings'])
 def test_no_active_never_fallback_to_recommendation(self):
  s=self.make(state=None,recommendations={'strategy_options':{'value':{'selected_plan':'A'}}})
  t=cs.project_telemetry(s,dict(strategy_plan={'action':'box','set_fuel_l':9},active_plan_decision_id='legacy'))
  self.assertIsNone(t['active_plan_decision_id']);self.assertEqual('hold',t['strategy_plan']['action']);self.assertIsNone(t['strategy_plan']['set_fuel_l'])
 def test_strict_unknown_normalization_and_independent_latches(self):
  i=inputs();i.update(fuel_level_l=True,current_lap=True,lap_dist_pct=float('nan'))
  s=self.make(inputs=i,gate_reason='visit_open',scope_closed=True,collision=True).serialize()
  self.assertIsNone(s['current_facts']['fuel_level_l']);self.assertIsNone(s['current_facts']['current_lap']);self.assertIsNone(s['current_facts']['lap_dist_pct'])
  self.assertTrue(s['execution']['scope_closed']);self.assertTrue(s['execution']['collision'])
 def test_producer_self_holds_inconsistent_refs_and_latches(self):
  for kw in [dict(scope_closed=True),dict(collision=True),dict(visit_open=True),dict(inputs=inputs(race_instance_id='foreign')),dict(inputs=inputs(source_frame_sequence=1))]:
   snap=self.make(**kw).serialize();self.assertFalse(snap['execution']['allowed']);self.assertIsNotNone(snap['current_facts']['fuel_level_l']);self.assertTrue(snap['diagnostics'])
 def valid_box_args(self):
  from tests_wo008_fixed_target import DeliveryLedger
  ledger,record,i,c=DeliveryLedger().setup_attempt()
  st=pl.new_race_strategy_state('r',0)
  st,_=pl.register_plan(st,decision_id='d',race_instance_id='r',session_num=0,selected_plan='A',phase='active',current_driver_pit_sequence=0,created_source_frame_sequence=2,activation_source_frame_sequence=2,target_lap=10,add_fuel_l=12.42,set_fuel_l=13)
  ledger,box,_=bd.advance(ledger,record,i,on_track=True)
  facts=bridge.race_facts_mod.build_snapshot(race_instance_id='r',session_num=0,source_frame_sequence=i['source_frame_sequence'],session_time_s=i['session_time_s'],raw_session_flags=0,driver_pit_sequence=0)
  return dict(state=st,facts=facts,inputs=i,pit_store={},box_ledger=ledger,box_projection=box,on_pit_road=False,on_track=True)
 def test_fresh_box_positive_and_projection_never_relabels_foreign_fields(self):
  args=self.valid_box_args();snapshot=cs.build(**args);s=snapshot.serialize();self.assertTrue(s['execution']['allowed'])
  bad={k:'foreign' for k in ('active_decision_id','active_phase','activation_frame','plan_revision','source_frame_sequence','driver_pit_sequence','race_instance_id','session_num','current_lap')};bad.update(closed=True,collision=True)
  box=cs.project_box(snapshot,bad)
  self.assertEqual('d',box['active_decision_id']);self.assertEqual('active',box['active_phase']);self.assertEqual(0,box['plan_revision']);self.assertEqual(2,box['activation_frame']);self.assertEqual(10,box['current_lap']);self.assertFalse(box['closed']);self.assertFalse(box['collision']);self.assertEqual(s['source_frame']['sequence'],box['source_frame_sequence'])
  self.assertEqual('box',cs.project_telemetry(snapshot,{})['strategy_plan']['action'])
 def test_fresh_verdict_holds_projection_setting_without_plan_mutation(self):
  for change in [dict(execution_gate='unsafe_frozen_setting'),dict(execution_gate='outside_target_window'),dict(allowed_attempt_id=None,allowed_proof_id=None)]:
   args=self.valid_box_args();args['box_projection'].update(change);s=cs.build(**args);wire=s.serialize();self.assertFalse(wire['execution']['allowed']);self.assertEqual(13,wire['lifecycle']['active']['set_fuel_l']);self.assertIsNone(cs.project_telemetry(s,{})['strategy_plan']['set_fuel_l']);self.assertEqual('hold',cs.project_telemetry(s,{})['strategy_plan']['action'])
 def test_box_reference_proof_activation_scope_pit_and_body_mismatches_self_hold(self):
  for change in [dict(plan_revision=False),dict(dispatch_sequence=1.0),dict(issued_session_time=None),dict(plan_revision=9),dict(activation_frame=1),dict(driver_pit_sequence=2),dict(proof_id='foreign'),dict(race_instance_id='foreign'),dict(authority_proof={'set_fuel_l':99})]:
   args=self.valid_box_args();a=args['box_ledger'].attempts[args['box_projection']['allowed_attempt_id']];mutated={**cs.clean(a),**change};ledger=bd._put(args['box_ledger'],mutated);args['box_ledger']=ledger
   s=cs.build(**args).serialize();self.assertFalse(s['execution']['allowed']);self.assertIsNone(s['box_delivery']['allowed_attempt_id']);self.assertIsNotNone(s['current_facts']['fuel_level_l'])
 def test_latches_black_and_input_origin_hold_with_fact_evidence_preserved(self):
  for change in [dict(scope_closed=True),dict(collision=True),dict(visit_open=True)]:
   args=self.valid_box_args();args.update(change);s=cs.build(**args).serialize();self.assertFalse(s['execution']['allowed']);self.assertIsNotNone(s['current_facts']['fuel_level_l'])
  args=self.valid_box_args();args['facts']=bridge.race_facts_mod.build_snapshot(race_instance_id='r',session_num=0,source_frame_sequence=9,session_time_s=10.,raw_session_flags=0x10000,driver_pit_sequence=0);s=cs.build(**args).serialize();self.assertFalse(s['execution']['allowed']);self.assertIsNotNone(s['current_facts']['fuel_level_l'])
  for change in [dict(race_instance_id='foreign'),dict(session_num=7),dict(source_frame_sequence=8),dict(session_time_s=9.)]:
   args=self.valid_box_args();args['inputs'].update(change);s=cs.build(**args).serialize();self.assertFalse(s['execution']['allowed']);self.assertFalse(s['current_facts']['available']);self.assertEqual(args['inputs']['source_frame_sequence'],s['current_facts']['source_frame']['sequence']);self.assertEqual(args['inputs']['race_instance_id'],s['current_facts']['scope_ref']['race_instance_id']);self.assertIsNotNone(s['current_facts']['fuel_level_l'])
 def test_unavailable_keeps_readonly_plan_but_not_old_flags_authority(self):
  s=self.make(telemetry_available=False).serialize()
  self.assertFalse(s['source_frame']['available']);self.assertFalse(s['execution']['allowed']);self.assertEqual('d',s['lifecycle']['active']['decision_id']);self.assertEqual('unknown',s['race_facts']['black_flag']['state'])
  self.assertFalse(s['continuity']['restored']);self.assertFalse(s['continuity']['resume_old_plan_allowed'])

class RealPoll(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.result=rh.replay(road.clean_laps(8)[0],session_info=road.ROAD_ATLANTA_SESSION_INFO)
  cls.snaps=[x for x in cls.result.broadcasts if x.get('type')=='canonical_lifecycle_snapshot']
 def test_snapshot_before_every_critical_event_and_projection(self):
  lookup={s['snapshot_id']:s for s in self.snaps}
  seen=set()
  for e in self.result.broadcasts:
   if e.get('type')=='canonical_lifecycle_snapshot':seen.add(e['snapshot_id'])
   if 'canonical_snapshot_id' in e:
    self.assertIn(e['canonical_snapshot_id'],seen)
    s=lookup[e['canonical_snapshot_id']];self.assertEqual(s['bridge_process_epoch'],e['bridge_process_epoch'])
    if e['type']=='telemetry_live':
     self.assertEqual(s,e['canonical_lifecycle']);self.assertEqual(s['lifecycle']['active_plan_id'],e['active_plan_decision_id'])
    if e['type']=='box_authority_snapshot':self.assertEqual(s['box_delivery']['allowed_attempt_id'],e['allowed_attempt_id'])
 def test_publication_cadence_and_cached_calculation_provenance(self):
  telemetry=[e for e in self.result.broadcasts if e.get('type')=='telemetry_live'];self.assertGreater(len(self.snaps),len(telemetry))
  self.assertTrue(any(s['recommendations']['fuel_strategy']['calculation_source'] and s['recommendations']['fuel_strategy']['calculation_source']['source_frame_sequence']<s['source_frame']['sequence'] for s in self.snaps))
 def test_final_decision_has_its_own_actual_dispatch_and_stale_initial_is_not_consumed(self):
  decision=self.result.by_trigger('strategy_plan_decision');self.assertTrue(decision)
  for e in decision:
   s=next(x for x in self.snaps if x['snapshot_id']==e['canonical_snapshot_id']);self.assertEqual(s['lifecycle']['active_plan_id'],e['origin_record_ref']['decision_id'])
  self.assertTrue(self.result.logs_containing('trigger=initial_strategy_plans result=DROPPED'))
  self.assertTrue(self.result.logs_containing('trigger=strategy_plan_decision result=DISPATCHED'))
 def test_immediate_inactive_publication_then_same_identity_fresh(self):
  frames=road.clean_laps(8)[0];frames[20:20]=[rh.make_frame(_inactive=True)]
  r=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO)
  snaps=[x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot'];unavailable=[s for s in snaps if not s['telemetry_available']];self.assertTrue(unavailable)
  u=unavailable[0];self.assertFalse(u['execution']['allowed']);self.assertFalse(u['source_frame']['available'])
  self.assertTrue(any(s['telemetry_available'] and s['snapshot_sequence']>u['snapshot_sequence'] for s in snaps));self.validate_desktop(snaps)
 def test_memory_map_open_failure_publishes_immediate_unavailable(self):
  armed=[];failed=[]
  original_open=rh.FakeReader.open;original_is_open=rh.FakeReader.is_open
  def hook(cursor,frame,r):
   if not armed and any(x.get('type')=='canonical_lifecycle_snapshot' and x['lifecycle']['active'] for x in r.broadcasts):armed.append(True)
  def is_open(reader):return False if armed and not failed else original_is_open(reader)
  def opening(reader):
   if armed and not failed:failed.append(True);return False
   return original_open(reader)
  with patch.object(rh.FakeReader,'is_open',is_open),patch.object(rh.FakeReader,'open',opening):r=rh.replay(road.clean_laps(8)[0],session_info=road.ROAD_ATLANTA_SESSION_INFO,on_frame_ready=hook)
  snaps=[x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot'];self.assertTrue(failed)
  inactive=[x for x in snaps if not x['telemetry_available']];self.assertEqual(1,len(inactive));self.assertFalse(inactive[0]['execution']['allowed']);self.validate_desktop(snaps)
 def test_malformed_ws_queue_payloads_do_not_stop_poll_or_clear_current_authority(self):
  sent=[]
  def hook(cursor,frame,r):
   if sent:return
   snaps=[x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot' and x['lifecycle']['active']]
   if not snaps:return
   snap=snaps[-1];a=snap['lifecycle']['active'];sent.append(snap['snapshot_sequence'])
   base=dict(command_id='malformed',intent='cancel',race_instance_id=snap['race_instance_id'],session_num=snap['session_num'],expected_decision_id=a['decision_id'],expected_revision=a['revision'],expected_activation_source_frame_sequence=a['activated_source_frame_sequence'],source_frame_sequence=snap['source_frame']['sequence'],driver_pit_sequence=snap['race_facts']['driver_pit_sequence'],**cs.refs(cs.LifecycleSnapshot(snap)))
   for idx,bad in enumerate([dict(canonical_snapshot_id=[]),dict(canonical_snapshot_id={}),dict(canonical_snapshot_sequence=True),dict(canonical_snapshot_sequence=1.0)]):bridge._queue_driver_plan_command({**base,'command_id':'malformed-'+str(idx),**bad})
   bridge._queue_driver_plan_command({**base,'_reason_only':True,'command_id':[],'reason_event_id':'reason'})
   bridge._queue_driver_plan_command({**base,'_reason_only':True,'reason_event_id':{}})
   bridge._queue_box_delivery_report(dict(attempt_id=[],report_event_id='malformed-box',bridge_process_epoch=cs.PROCESS_EPOCH))
  r=rh.replay(road.clean_laps(8)[0],session_info=road.ROAD_ATLANTA_SESSION_INFO,on_frame_ready=hook)
  self.assertTrue(sent);acks=[x for x in r.broadcasts if x.get('type')=='driver_plan_command_ack'];self.assertEqual(6,len(acks));self.assertTrue(all(x['outcome']=='rejected' for x in acks))
  snaps=[x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot'];self.validate_desktop(snaps);self.assertGreater(snaps[-1]['snapshot_sequence'],sent[0]);self.assertIsNotNone(snaps[-1]['lifecycle']['active'])
 def test_old_epoch_rejection_cannot_poison_current_publications(self):
  sent=[]
  def hook(cursor,frame,result):
   if sent:return
   snapshots=[x for x in result.broadcasts if x.get('type')=='canonical_lifecycle_snapshot' and x['lifecycle']['active']]
   if snapshots:
    snap=snapshots[-1];a=snap['lifecycle']['active'];sent.append(True)
    bridge._queue_driver_plan_command(dict(type='driver_plan_command',command_id='old-epoch',intent='cancel',decision_id=a['decision_id'],expected_revision=a['revision'],race_instance_id=snap['race_instance_id'],session_num=snap['session_num'],source_frame_sequence=snap['source_frame']['sequence'],driver_pit_sequence=snap['race_facts']['driver_pit_sequence'],bridge_process_epoch='old-epoch',canonical_snapshot_id=snap['snapshot_id'],canonical_snapshot_sequence=snap['snapshot_sequence']))
  r=rh.replay(road.clean_laps(8)[0],session_info=road.ROAD_ATLANTA_SESSION_INFO,on_frame_ready=hook)
  self.assertTrue(sent);acks=[x for x in r.broadcasts if x.get('type')=='driver_plan_command_ack'];self.assertEqual('rejected',acks[0]['outcome'])
  snaps=[x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot'];self.assertTrue(all(not x['last_driver_action']['available'] for x in snaps));self.validate_desktop(snaps)
 def validate_desktop(self,snaps):
  module=str(Path(__file__).resolve().parents[1]/'desktop/canonical-lifecycle-cache.js')
  p=subprocess.run(['node','-e',"const C=require(process.argv[1]);let x='';process.stdin.on('data',d=>x+=d);process.stdin.on('end',()=>{const a=JSON.parse(x);if(!a.every(C.validate))process.exit(1)});",module],input=json.dumps(snaps),text=True,capture_output=True)
  self.assertEqual(0,p.returncode,p.stderr)
 def test_raw_flags_bool_negative_and_time_nonfinite_hold_without_hiding_fuel(self):
  for flags,time in [(True,2),(-1,2),(0,float('inf'))]:
   frames=road.clean_laps(8)[0]
   frames[-1]['SessionFlags']=flags;frames[-1]['SessionTime']=time
   r=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO)
   snap=[x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot'][-1]
   self.assertFalse(snap['execution']['allowed']);self.assertIsNotNone(snap['current_facts']['fuel_level_l'])
   if flags is True or flags==-1:self.assertEqual('unknown',snap['race_facts']['black_flag']['state'])
 def test_decision_dropped_then_next_frame_real_dispatch_consumes_once(self):
  attempts=[]
  def dispatch(e):
   if e.get('trigger')=='strategy_plan_decision':
    attempts.append(e);return 'DROPPED' if len(attempts)==1 else 'DISPATCHED'
   return 'DISPATCHED'
  r=rh.replay(road.clean_laps(8)[0],session_info=road.ROAD_ATLANTA_SESSION_INFO,dispatch_result=dispatch)
  self.assertEqual(2,len(attempts));self.assertTrue(all(e['origin_record_ref']['decision_id']==next(s for s in r.broadcasts if s.get('type')=='canonical_lifecycle_snapshot' and s['snapshot_id']==e['canonical_snapshot_id'])['lifecycle']['active_plan_id'] for e in attempts))
  self.assertTrue(r.logs_containing('trigger=strategy_plan_decision result=DROPPED'));self.assertTrue(r.logs_containing('trigger=strategy_plan_decision result=DISPATCHED'))
 def test_fuel_warning_dropped_then_actual_dispatch_consumes_band_once(self):
  import tests_bridge_fuel_safety_override_replay as fuel_fixture
  frames=fuel_fixture.build_frames();last=frames[-1];tail,*_=fuel_fixture._clean_laps(3,start_lap=last['Lap'],start_fuel=last['FuelLevel'],start_time=last['SessionTime']+1,burn=6.5,lap_time=100.5);frames+=tail
  attempts=[]
  def dispatch(e):
   if e.get('trigger')=='fuel_strategy_warning':
    attempts.append(e);return 'DROPPED' if len(attempts)==1 else 'DISPATCHED'
   return 'DISPATCHED'
  r=rh.replay(frames,session_info=fuel_fixture.SESSION_INFO,dispatch_result=dispatch)
  self.assertEqual(2,len(attempts));self.assertTrue(r.logs_containing('trigger=fuel_strategy_warning result=DROPPED'));self.assertTrue(r.logs_containing('trigger=fuel_strategy_warning result=DISPATCHED'))
 def test_held_fuel_warning_keeps_diagnostic_not_executable_setting(self):
  import tests_bridge_fuel_safety_override_replay as fuel_fixture
  r=rh.replay(fuel_fixture.build_frames(),session_info=fuel_fixture.SESSION_INFO)
  warnings=r.by_trigger('fuel_strategy_warning');self.assertEqual(1,len(warnings));w=warnings[0]
  self.assertTrue(w['fact_only']);self.assertIsNone(w['set_fuel_l']);self.assertFalse(w['pit_required']);self.assertEqual('authority_requires_new_decision',w['safety_override']['diagnostic'])
  snap=next(s for s in r.broadcasts if s.get('type')=='canonical_lifecycle_snapshot' and s['snapshot_id']==w['canonical_snapshot_id']);self.assertFalse(snap['execution']['allowed']);self.assertEqual(snap['lifecycle']['active']['decision_id'],w['safety_override']['decision_id']);self.validate_desktop([snap])
 def test_stage_dropped_is_not_successful_proposal_or_fuel_consumption(self):
  r=rh.replay(road.clean_laps(8)[0],session_info=road.ROAD_ATLANTA_SESSION_INFO,dispatch_result='DROPPED')
  self.assertFalse(any('result=DISPATCHED' in l for l in r.logs_containing('CANONICAL EVENT DISPATCH')))

class CommandHistory(unittest.TestCase):
 def test_actual_pit_penalty_finish_collision_command_terminal_snapshots(self):
  from tests_bridge_actual_pit_lifecycle_wiring import ActualLifecyclePoll
  runner=ActualLifecyclePoll()
  for case in [dict(normal=True),dict(flags=0x10000),dict(flags=None),dict(finish=True),dict(collision=True),dict(command_edge='entry',intent='cancel'),dict(command_edge='entry',intent='early_pit')]:
   with self.subTest(case=case):
    r,_=runner.run_pit(**case);snaps=[x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot'];RealPoll().validate_desktop(snaps)
    self.assertTrue(any(s['lifecycle']['terminal_records'] for s in snaps))
    for snap in snaps:
     if snap['execution']['scope_closed'] or snap['execution']['collision']:self.assertFalse(snap['execution']['allowed']);self.assertIsNone(snap['box_delivery']['allowed_attempt_id'])
     for event in snap['pit_ledger']['events']:
      self.assertEqual(snap['race_instance_id'],event['event_ref']['race_instance_id']);self.assertEqual(snap['bridge_process_epoch'],event['event_ref']['bridge_process_epoch'])
     for record in snap['lifecycle']['terminal_records']:
      if record['terminal_pit_event_id']:
       event=next(e for e in snap['pit_ledger']['events'] if e['pit_event_id']==record['terminal_pit_event_id']);self.assertEqual(event['event_ref'],record['terminal_event_ref'])
 def test_malformed_command_refs_reject_without_state_or_ledger_change(self):
  st=pl.new_race_strategy_state('r',0);ledger=bridge.driver_plan_command_mod.new_ledger('r',0)
  for bad in [dict(canonical_snapshot_id=[]),dict(canonical_snapshot_id={}),dict(canonical_snapshot_sequence=True),dict(canonical_snapshot_sequence=1.0),dict(canonical_snapshot_id=None)]:
   cmd=dict(command_id='malformed',intent='cancel',bridge_process_epoch=cs.PROCESS_EPOCH,canonical_snapshot_id='x',canonical_snapshot_sequence=1);cmd.update(bad)
   after,l2,a,_=bridge.apply_driver_plan_command(st,ledger,cmd,race_facts_snapshot={},canonical_required=True)
   self.assertIs(st,after);self.assertIs(ledger,l2);self.assertEqual('malformed_canonical_reference',a['reason'])
 def test_candidate_bound_report_original_ref_after_registry_eviction_and_mutations(self):
  from tests_wo008_fixed_target import DeliveryLedger
  ledger,record,i,c=DeliveryLedger().setup_attempt()
  refs=dict(bridge_process_epoch=cs.PROCESS_EPOCH,canonical_snapshot_id='original',canonical_snapshot_sequence=5);ledger=bd.bind_dispatch_ref(ledger,c['box_attempt']['attempt_id'],refs);ledger=bd.mark_dispatch(ledger,c['box_attempt']['attempt_id'],'DISPATCHED')
  report={**c['box_attempt'],**refs,'report_event_id':'report','outcome':'audible_started'}
  for bad in [dict(canonical_snapshot_id='wrong'),dict(canonical_snapshot_sequence=True),dict(canonical_snapshot_sequence=5.0),dict(dispatch_sequence=float(report['dispatch_sequence']))]:
   after,a=bd.apply_report(ledger,{**report,**bad});self.assertIs(after,ledger);self.assertEqual('rejected',a['applied'])
  after,a=bd.apply_report(ledger,report);self.assertEqual('applied',a['applied']);self.assertTrue(after.attempts[report['attempt_id']]['confirmed_started'])

 def test_known_retry_after_registry_eviction_original_ack_and_reason_binding(self):
  ActualPoll.setUpClass();r=ActualPoll.result;command=ActualPoll.state['desktop_command'];ack=next(e for e in r.broadcasts if e.get('type')=='driver_plan_command_ack')
  # Rebuild the exact post-transaction owner from immutable record content.
  i=ack['authority_snapshot'];st=pl.new_race_strategy_state(command['race_instance_id'],command['session_num'])
  led=bridge.driver_plan_command_mod.new_ledger(command['race_instance_id'],command['session_num'])
  normalized,_,content=bridge.driver_plan_command_mod.classify_delivery(led,command);led=bridge.driver_plan_command_mod.record_ack(led,normalized,content,ack)
  old=dict(bridge._canonical_publications);bridge._canonical_publications.clear()
  try:
   after,l2,a,_=bridge.apply_driver_plan_command(st,led,command,race_facts_snapshot=dict(race_instance_id=command['race_instance_id'],session_num=command['session_num']),canonical_required=True)
   self.assertIs(after,st);self.assertEqual('retry_no_op',a['outcome']);self.assertEqual(ack['successor_decision_id'],a['successor_decision_id'])
   reason={**command,'_reason_only':True,'reason_event_id':'reason','reason_text':'traffic'}
   _,_,a,_=bridge.apply_driver_plan_command(st,led,reason,race_facts_snapshot=dict(race_instance_id=command['race_instance_id'],session_num=command['session_num']),canonical_required=True);self.assertEqual('linked',a['outcome'])
   bad={**command,'bridge_process_epoch':'old'}
   after,_,a,_=bridge.apply_driver_plan_command(st,led,bad,race_facts_snapshot={},canonical_required=True);self.assertIs(after,st);self.assertEqual('rejected',a['outcome'])
  finally:bridge._canonical_publications.update(old)

if __name__=='__main__':unittest.main()
