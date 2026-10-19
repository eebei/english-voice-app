"""WO008 actual poll + immutable pure delivery checks; seed writes temp isolated."""
import os,sys,json,unittest,copy,subprocess,tempfile,hashlib
from pathlib import Path
from unittest.mock import patch
import plan_lifecycle as pl
sys.path.insert(0,os.path.dirname(__file__))
import bridge,replay_harness as rh,tests_wo001_road_atlanta_fixture as road
import fixed_target_authority as fa,box_authority_delivery as bd


def wire_refs(message):return {k:message[k] for k in ('bridge_process_epoch','canonical_snapshot_id','canonical_snapshot_sequence')}

def inputs(**kw):
 d=dict(race_instance_id='r',session_num=0,source_frame_sequence=9,session_time_s=10.,current_lap=5,total_laps=25,lap_dist_pct=.2,fuel_level_l=48.4,avg_fuel_per_lap_l=2.9,clean_laps_sampled=3,effective_capacity_l=60.,driver_pit_sequence=0,is_lap_race=True)
 d.update(kw);return fa.build_inputs(**d)

class CoupledMath(unittest.TestCase):
 def test_future_target_consumed(self):
  v=fa.evaluate(inputs(),10);self.assertTrue(v['available']);self.assertEqual(13,v['set_fuel_l']);self.assertAlmostEqual(12.42,v['add_fuel_l'])
 def test_final_lap_crossings_one(self):
  i=inputs(current_lap=25,lap_dist_pct=.5,fuel_level_l=2)
  self.assertEqual(1,i['crossings_to_finish']);self.assertTrue(fa.evaluate(i,25,frozen_set=0)['available'])
 def test_boundary_unknown_and_capacity(self):
  for kw,reason in [({'lap_dist_pct':None},'unknown_single_stop_authority'),({'multi_stop':True},'unsupported_multi_stop'),({'is_lap_race':False},'unsupported_finish_authority'),({'fuel_level_l':5},'cannot_reach_requested_target'),({'effective_capacity_l':20,'fuel_level_l':20},'unsupported_multi_stop')]:
   with self.subTest(kw=kw):self.assertEqual(reason,fa.evaluate(inputs(**kw),10)['reason'])
 def test_coupled_geometry_all_entry_positions(self):
  i=inputs();v=fa.evaluate(i,10)
  for p in [0,.25,.5,.75,1]:
   entry=i['fuel_level_l']-2.9*(5+p-.2)
   need=2.9*(21-5-p)+.5
   self.assertGreaterEqual(entry,.5);self.assertGreaterEqual(min(60,entry+v['set_fuel_l']),need)

class ActualPoll(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  frames=road.clean_laps(12)[0];state={};bridge._pending_driver_plan_commands=[];bridge._pending_box_delivery_reports=[]
  def hook(cursor,frame,r):
   live=[b for b in r.broadcasts if b.get('type')=='telemetry_live' and b.get('active_plan_decision_id')]
   if live and not state:
    t=live[-1];state['old']=t['active_plan_decision_id']
    with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as wire:
     json.dump(t,wire);wire.flush()
     command=json.loads(subprocess.check_output(['node',os.path.join(os.path.dirname(__file__),'wo008_desktop_command_fixture.js'),wire.name]))
    state['desktop_command']=command
    bridge._queue_driver_plan_command(command)
   boxes=r.by_trigger('strategy_plan_box_call')
   if boxes and not state.get('reported'):
    b=boxes[-1];state['reported']=True
    bridge._queue_box_delivery_report(dict(b['box_attempt'],**wire_refs(b),report_event_id='report-started',outcome='audible_started'))
    pit,fuel,tm,_=road.pit_visit(lap=10,fuel_before=30,fuel_added=13,start_time=300)
    tail=[rh.make_frame(SessionTime=tm+i,Lap=10,FuelLevel=fuel) for i in range(8)]
    frames[cursor:]=pit+tail;r.live_frames[cursor:]=pit+tail
  seed=bridge.PIT_LOSS_PATH
  seed_before=Path(seed).read_bytes() if os.path.exists(seed) else None
  cls.result=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO,on_frame_ready=hook);cls.state=state
  cls.seed_unchanged=(Path(seed).read_bytes() if os.path.exists(seed) else None)==seed_before
 def test_success_ack_contains_canonical_successor(self):
  self.assertTrue(self.seed_unchanged)
  self.assertEqual('driver_plan_command',self.state['desktop_command']['cmd'])
  ack=[b for b in self.result.broadcasts if b.get('type')=='driver_plan_command_ack'][0]
  self.assertEqual('applied',ack['outcome']);self.assertEqual(10,ack['successor_target_lap']);self.assertEqual(13,ack['successor_set_fuel_l'])
  self.assertEqual(ack['successor_decision_id'],ack['authority_snapshot']['successor_decision_id'])
 def test_snapshot_before_candidate_and_one_target_box(self):
  boxes=self.result.by_trigger('strategy_plan_box_call');self.assertEqual(1,len(boxes))
  b=boxes[0];self.assertEqual(10,b['authority_proof']['target_lap']);self.assertEqual(10,b['authority_proof']['current_lap'])
  index=self.result.broadcasts.index(b);snap=self.result.broadcasts[index-1]
  self.assertEqual('box_authority_snapshot',snap['type']);self.assertEqual(b['authority_proof']['proof_id'],snap['allowed_proof_id'])
 def test_actual_started_ack_and_pit_executed(self):
  ack=[b for b in self.result.broadcasts if b.get('type')=='box_delivery_ack'];self.assertEqual('applied',ack[0]['applied'])
  traces=[json.loads(x.split(': ',1)[1]) for x in self.result.logs_containing('PLAN LIFECYCLE PIT:')]
  self.assertEqual('executed',traces[0]['records'][0]['phase'])
  self.assertIn('driver-amend:wo008-vertical',traces[0]['records'][0]['decision_id'])
 def test_export_real_wire_for_desktop(self):
  b=self.result.by_trigger('strategy_plan_box_call')[0];idx=self.result.broadcasts.index(b)
  a=[x for x in self.result.broadcasts if x.get('type')=='box_delivery_ack'][0]
  with open('/tmp/wo008-real-wire.json','w') as f:json.dump(dict(hello={'type':'connected','schema_version':1,'bridge_process_epoch':bridge.canonical_mod.PROCESS_EPOCH},canonical=next(x for x in self.result.broadcasts if x.get('snapshot_id')==b['canonical_snapshot_id']),snapshot=self.result.broadcasts[idx-1],candidate=b,ack=a,command_ack=[x for x in self.result.broadcasts if x.get('type')=='driver_plan_command_ack'][0]),f)

class DeliveryLedger(unittest.TestCase):
 def setup_attempt(self):
  import plan_lifecycle as pl
  st=pl.new_race_strategy_state('r',0)
  st,_=pl.register_plan(st,decision_id='d',race_instance_id='r',session_num=0,selected_plan='A',phase='active',current_driver_pit_sequence=0,created_source_frame_sequence=2,activation_source_frame_sequence=2,target_lap=10,add_fuel_l=12.42,set_fuel_l=13)
  rec=pl.active_plan_view(st);i=inputs(current_lap=10,fuel_level_l=33.9)
  ledger,snap,candidate=bd.advance(bd.new_ledger(),rec,i,on_track=True)
  self.assertIsNotNone(candidate)
  return bd.mark_dispatch(ledger,candidate['box_attempt']['attempt_id'],'DISPATCHED'),rec,i,candidate
 def report(self,candidate,outcome='audible_started',rid='r1'):
  return dict(candidate['box_attempt'],report_event_id=rid,outcome=outcome)
 def test_started_remains_allowed_and_no_second_candidate(self):
  led,rec,i,c=self.setup_attempt();led,ack=bd.apply_report(led,self.report(c));i.update(session_time_s=10.1,source_frame_sequence=10)
  led,snap,new=bd.advance(led,rec,i,on_track=True)
  self.assertEqual(c['box_attempt']['attempt_id'],snap['allowed_attempt_id']);self.assertIsNone(new)
 def test_timeout_unknown_never_retry(self):
  led,rec,i,c=self.setup_attempt();i.update(session_time_s=15.1,source_frame_sequence=12)
  led,snap,new=bd.advance(led,rec,i,on_track=True)
  self.assertEqual('delivery_unknown',led.attempts[c['box_attempt']['attempt_id']]['status']);self.assertIsNone(new)
  i['session_time_s']=20;led,snap,new=bd.advance(led,rec,i,on_track=True);self.assertIsNone(new)
 def test_late_start_archived_after_timeout_without_resurrection(self):
  led,rec,i,c=self.setup_attempt();i['session_time_s']=16;led,_,_=bd.advance(led,rec,i,on_track=True)
  led,ack=bd.apply_report(led,self.report(c));a=led.attempts[c['box_attempt']['attempt_id']]
  self.assertEqual('delivery_unknown',a['status']);self.assertTrue(a['confirmed_started'])
 def test_interrupt_first_then_start_idempotent(self):
  led,rec,i,c=self.setup_attempt();led,a=bd.apply_report(led,self.report(c,'audible_interrupted'))
  led,a=bd.apply_report(led,self.report(c,'audible_started','r2'));self.assertEqual('audible_interrupted',led.attempts[c['box_attempt']['attempt_id']]['status'])
  again,a=bd.apply_report(led,self.report(c,'audible_started','r2'));self.assertIs(again,led);self.assertEqual('retry_no_op',a['applied'])
 def test_report_identity_mismatch_no_mutation(self):
  led,rec,i,c=self.setup_attempt()
  for k in bd.BINDINGS:
   report=self.report(c);report[k]='wrong';after,ack=bd.apply_report(led,report);self.assertIs(led,after);self.assertEqual('rejected',ack['applied'])
 def test_material_change_revokes_even_if_safe(self):
  led,rec,i,c=self.setup_attempt();i['avg_fuel_per_lap_l']=2.8
  led,snap,new=bd.advance(led,rec,i,on_track=True);self.assertIsNone(snap['allowed_attempt_id']);self.assertIsNone(new);self.assertEqual('revoked',led.attempts[c['box_attempt']['attempt_id']]['status'])
 def test_fuel_progress_same_safe_frozen_setting_preserves_proof(self):
  led,rec,i,c=self.setup_attempt();i.update(fuel_level_l=33.8,lap_dist_pct=.3,session_time_s=10.1,source_frame_sequence=10)
  led,snap,new=bd.advance(led,rec,i,on_track=True);self.assertEqual(c['box_attempt']['proof_id'],snap['allowed_proof_id']);self.assertIsNone(new)
 def test_confirmed_drop_max_three_and_gap(self):
  led,rec,i,c=self.setup_attempt()
  for j in range(3):
   led,_=bd.apply_report(led,self.report(c,'dropped_before_audible','drop'+str(j)))
   i['session_time_s']+=1;led,snap,new=bd.advance(led,rec,i,on_track=True)
   if j<2:self.assertIsNotNone(new);c=new;led=bd.mark_dispatch(led,c['box_attempt']['attempt_id'],'DISPATCHED')
   else:self.assertIsNone(new)
  self.assertEqual(3,len(led.attempts))
 def test_revoked_matching_drop_retries_new_attempt_without_reviving_old(self):
  led,rec,i,c=self.setup_attempt();led,_,_=bd.advance(led,rec,i,execution_gate='black_flag',on_track=True)
  old=c['box_attempt']['attempt_id'];self.assertEqual('revoked',led.attempts[old]['status'])
  led,ack=bd.apply_report(led,self.report(c,'dropped_before_audible'));self.assertEqual('applied',ack['applied'])
  i.update(session_time_s=11.2,source_frame_sequence=10)
  led,snap,new=bd.advance(led,rec,i,on_track=True)
  self.assertIsNotNone(new);self.assertNotEqual(old,new['box_attempt']['attempt_id']);self.assertEqual('revoked',led.attempts[old]['status'])
  self.assertNotEqual(c['authority_proof']['proof_id'],new['authority_proof']['proof_id'])
 def test_revoked_drop_retry_gap_and_cap_remain_bounded(self):
  led,rec,i,c=self.setup_attempt()
  for j in range(3):
   led,_,_=bd.advance(led,rec,i,execution_gate='black_flag',on_track=True)
   led,_=bd.apply_report(led,self.report(c,'dropped_before_audible','revdrop'+str(j)))
   i['session_time_s']+=.5;led,_,too_early=bd.advance(led,rec,i,on_track=True);self.assertIsNone(too_early)
   i['session_time_s']+=.7;led,_,new=bd.advance(led,rec,i,on_track=True)
   if j<2:
    self.assertIsNotNone(new);c=new;led=bd.mark_dispatch(led,c['box_attempt']['attempt_id'],'DISPATCHED')
   else:self.assertIsNone(new)
  self.assertEqual(3,len(led.attempts))

 def test_revoke_or_expire_alone_never_proves_drop(self):
  for outcome in ('revoked','expired'):
   led,rec,i,c=self.setup_attempt();led,_,_=bd.advance(led,rec,i,execution_gate='black_flag',on_track=True)
   led,_=bd.apply_report(led,self.report(c,outcome));i.update(session_time_s=11.2,source_frame_sequence=10)
   led,snap,new=bd.advance(led,rec,i,on_track=True);self.assertIsNone(new)
 def test_late_started_overrides_pre_audible_drop_retry_eligibility(self):
  led,rec,i,c=self.setup_attempt();led,_,_=bd.advance(led,rec,i,execution_gate='black_flag',on_track=True)
  led,_=bd.apply_report(led,self.report(c,'dropped_before_audible','drop'))
  led,_=bd.apply_report(led,self.report(c,'audible_started','late'))
  i.update(session_time_s=11.2,source_frame_sequence=10)
  led,snap,new=bd.advance(led,rec,i,on_track=True);self.assertIsNone(new)

 def test_proof_immutable(self):
  led,rec,i,c=self.setup_attempt();p=led.attempts[c['box_attempt']['attempt_id']]['authority_proof']
  with self.assertRaises(TypeError):p['fuel_inputs']['fuel_level_l']=0

class ActualNegative(unittest.TestCase):
 def run_command(self,change=None,frame_change=None,failure=False,retry=False,collision=False,second=False):
  frames=road.clean_laps(8)[0];captured={};bridge._pending_driver_plan_commands=[];bridge._pending_box_delivery_reports=[]
  real=pl.register_plan
  def register(st,**kw):
   if failure and 'driver-amend:' in kw['decision_id']:
    captured['failed_candidate']=st
    return st,pl.LifecycleOutcome(status='rejected',reason='injected_registration_failure')
   return real(st,**kw)
  def hook(cursor,frame,r):
   live=[x for x in r.broadcasts if x.get('type')=='telemetry_live' and x.get('active_plan_decision_id')]
   if live and not captured:
    t=live[-1];captured['old']=t['active_plan_decision_id'];captured['revision']=t['active_plan_revision']
    c=dict(command_id='negative',intent='amend',race_instance_id=t['race_instance_id'],session_num=t['session_num'],
     expected_decision_id=t['active_plan_decision_id'],expected_revision=t['active_plan_revision'],
     expected_activation_source_frame_sequence=t['active_plan_activated_source_frame_sequence'],source_frame_sequence=t['source_frame_sequence'],
     driver_pit_sequence=t['driver_pit_sequence'],requested_target_lap=10,**wire_refs(t))
    if change:change(c)
    if frame_change:frame_change(frame)
    bridge._queue_driver_plan_command(c)
    if retry:bridge._queue_driver_plan_command(dict(c))
    if collision:bridge._queue_driver_plan_command({**c,'requested_target_lap':11})
    if second:bridge._queue_driver_plan_command({**c,'command_id':'second','requested_target_lap':11})
  with patch.object(pl,'register_plan',side_effect=register):
   result=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO,on_frame_ready=hook)
  captured['acks']=[x for x in result.broadcasts if x.get('type')=='driver_plan_command_ack'];return result,captured
 def test_real_poll_rejected_identity_revision_sequence_target(self):
  cases=[('race_instance_id','foreign'),('expected_revision',999),('driver_pit_sequence',999),('expected_activation_source_frame_sequence',999),('source_frame_sequence',999999),('requested_target_lap',3),('requested_target_lap',100)]
  for key,value in cases:
   with self.subTest(key=key,value=value):
    r,s=self.run_command(change=lambda c:c.update({key:value}))
    self.assertNotEqual('applied',s['acks'][0]['outcome'])
    self.assertFalse(any(x.get('successor_decision_id') for x in s['acks']))
    self.assertFalse(any((x.get('active_plan_decision_id') or '').endswith('driver-amend:negative') for x in r.broadcasts))
 def test_real_poll_black_unknown_and_cannot_reach(self):
  for changes in ({'SessionFlags':0x10000},{'SessionFlags':None},{'FuelLevel':1.0},{'LapDistPct':None}):
   with self.subTest(changes=changes):
    r,s=self.run_command(frame_change=lambda f:f.update(changes))
    self.assertNotEqual('applied',s['acks'][0]['outcome']);self.assertIsNone(s['acks'][0].get('successor_decision_id'))
 def test_atomic_registration_failure_does_not_publish_terminal_old(self):
  r,s=self.run_command(failure=True)
  self.assertEqual('rejected',s['acks'][0]['outcome']);self.assertEqual('injected_registration_failure',s['acks'][0]['reason'])
  self.assertIn('failed_candidate',s)
  subsequent=[x for x in r.broadcasts if x.get('type')=='telemetry_live' and x.get('active_plan_decision_id')==s['old']]
  self.assertTrue(subsequent);self.assertTrue(all(x['active_plan_revision']==s['revision'] for x in subsequent))
  self.assertFalse(any((x.get('active_plan_decision_id') or '').endswith('driver-amend:negative') for x in r.broadcasts))
 def test_real_poll_same_content_retry_one_successor(self):
  r,s=self.run_command(retry=True)
  self.assertEqual(['applied','retry_no_op'],[x['outcome'] for x in s['acks']])
  self.assertEqual(s['acks'][0]['successor_decision_id'],s['acks'][1]['successor_decision_id'])

 def test_amend_same_id_collision_and_second_stale_cannot_replace_successor(self):
  for options,outcome in [(dict(collision=True),'collision'),(dict(second=True),'stale')]:
   with self.subTest(options=options):
    r,s=self.run_command(**options)
    self.assertEqual(['applied',outcome],[a['outcome'] for a in s['acks']])
    self.assertEqual(10,s['acks'][0]['successor_target_lap']);self.assertIsNone(s['acks'][1].get('successor_decision_id'))

class ActualLateDelivery(unittest.TestCase):
 def test_actual_poll_timeout_then_delayed_started_does_not_retry(self):
  frames=road.clean_laps(12)[0];state={};bridge._pending_driver_plan_commands=[];bridge._pending_box_delivery_reports=[]
  def hook(cursor,frame,r):
   live=[x for x in r.broadcasts if x.get('type')=='telemetry_live' and x.get('active_plan_decision_id')]
   if live and not state:
    t=live[-1];state['command']=True
    bridge._queue_driver_plan_command(dict(command_id='late',intent='amend',race_instance_id=t['race_instance_id'],session_num=t['session_num'],expected_decision_id=t['active_plan_decision_id'],expected_revision=t['active_plan_revision'],expected_activation_source_frame_sequence=t['active_plan_activated_source_frame_sequence'],source_frame_sequence=t['source_frame_sequence'],driver_pit_sequence=t['driver_pit_sequence'],requested_target_lap=10,**wire_refs(t)))
   boxes=r.by_trigger('strategy_plan_box_call')
   if boxes and 'box' not in state:
    b=boxes[0];state['box']=b;state['start']=b['authority_proof']['issued_session_time']
    tail=[rh.make_frame(SessionTime=state['start']+j,Lap=10,LapDistPct=.1+j*.01,FuelLevel=33.5-j*.029) for j in range(1,14)]
    frames[cursor:]=tail;r.live_frames[cursor:]=tail
   if state.get('box') and frame['SessionTime']>=state['start']+6 and not state.get('reported'):
    bridge._queue_box_delivery_report({**state['box']['box_attempt'],**wire_refs(state['box']),'report_event_id':'late-start','outcome':'audible_started'});state['reported']=True
  result=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO,on_frame_ready=hook)
  self.assertTrue(state.get('reported'));self.assertEqual(1,len(result.by_trigger('strategy_plan_box_call')))
  ack=[x for x in result.broadcasts if x.get('type')=='box_delivery_ack'];self.assertEqual('applied',ack[0]['applied'])
  later=[x for x in result.broadcasts if x.get('type')=='box_authority_snapshot' and x['session_time_s']>=state['start']+5]
  self.assertTrue(later);self.assertTrue(all(x['allowed_attempt_id'] is None for x in later))

class ActualRevokedDropRetry(unittest.TestCase):
 def test_black_drop_clear_issues_only_new_attempt_and_exports_wire(self):
  frames=road.clean_laps(12)[0];state={};bridge._pending_driver_plan_commands=[];bridge._pending_box_delivery_reports=[]
  def hook(cursor,frame,r):
   live=[x for x in r.broadcasts if x.get('type')=='telemetry_live' and x.get('active_plan_decision_id')]
   if live and not state:
    t=live[-1];state['queued']=True
    bridge._queue_driver_plan_command(dict(command_id='retry',intent='amend',race_instance_id=t['race_instance_id'],session_num=t['session_num'],expected_decision_id=t['active_plan_decision_id'],expected_revision=t['active_plan_revision'],expected_activation_source_frame_sequence=t['active_plan_activated_source_frame_sequence'],source_frame_sequence=t['source_frame_sequence'],driver_pit_sequence=t['driver_pit_sequence'],requested_target_lap=10,**wire_refs(t)))
   boxes=r.by_trigger('strategy_plan_box_call')
   if boxes and 'box' not in state:
    b=boxes[0];state.update(box=b,start=b['authority_proof']['issued_session_time'],stage=1)
    tail=[rh.make_frame(SessionTime=state['start']+j,Lap=10,LapDistPct=.1+j*.01,FuelLevel=33.5-j*.029,SessionFlags=0x10000 if j<=2 else 0) for j in range(1,12)]
    frames[cursor:]=tail;r.live_frames[cursor:]=tail
   elif state.get('stage')==1:
    a=state['box']['box_attempt'];bridge._queue_box_delivery_report({**a,**wire_refs(state['box']),'report_event_id':a['attempt_id']+':dropped_before_audible','outcome':'dropped_before_audible'});state['stage']=2
   elif len(boxes)==2 and not state.get('started'):
    a=boxes[1]['box_attempt'];bridge._queue_box_delivery_report({**a,**wire_refs(boxes[1]),'report_event_id':a['attempt_id']+':audible_started','outcome':'audible_started'});state['started']=True
  result=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO,on_frame_ready=hook)
  boxes=result.by_trigger('strategy_plan_box_call');self.assertEqual(2,len(boxes));self.assertTrue(state.get('started'))
  self.assertNotEqual(boxes[0]['box_attempt']['attempt_id'],boxes[1]['box_attempt']['attempt_id'])
  self.assertNotEqual(boxes[0]['authority_proof']['proof_id'],boxes[1]['authority_proof']['proof_id'])
  wires=[]
  for b in boxes:
   idx=result.broadcasts.index(b);wires.append(dict(canonical=next(x for x in result.broadcasts if x.get('snapshot_id')==b['canonical_snapshot_id']),snapshot=result.broadcasts[idx-1],candidate=b))
  revoke=[x for x in result.broadcasts if x.get('type')=='box_authority_snapshot' and x.get('execution_gate')=='black_flag_true'][0]
  acks=[x for x in result.broadcasts if x.get('type')=='box_delivery_ack'];self.assertEqual(['applied','applied'],[x['applied'] for x in acks])
  Path('/tmp/wo008-retry-wire.json').write_text(json.dumps(dict(hello={'type':'connected','schema_version':1,'bridge_process_epoch':bridge.canonical_mod.PROCESS_EPOCH},first=wires[0],revoke_canonical=next(x for x in result.broadcasts if x.get('snapshot_id')==revoke['canonical_snapshot_id']),revoke=revoke,second=wires[1],acks=acks)))

class ActualUnsafeConstraint(unittest.TestCase):
 def test_degraded_raw_fuel_holds_frozen_plan_and_keeps_fact_warning(self):
  frames=road.clean_laps(12)[0];state={};bridge._pending_driver_plan_commands=[];bridge._pending_box_delivery_reports=[]
  def hook(cursor,frame,r):
   live=[x for x in r.broadcasts if x.get('type')=='telemetry_live' and x.get('active_plan_decision_id')]
   if live and not state:
    t=live[-1];state['queued']=True
    bridge._queue_driver_plan_command(dict(command_id='unsafe',intent='amend',race_instance_id=t['race_instance_id'],session_num=t['session_num'],expected_decision_id=t['active_plan_decision_id'],expected_revision=t['active_plan_revision'],expected_activation_source_frame_sequence=t['active_plan_activated_source_frame_sequence'],source_frame_sequence=t['source_frame_sequence'],driver_pit_sequence=t['driver_pit_sequence'],requested_target_lap=10,**wire_refs(t)))
   ack=[x for x in r.broadcasts if x.get('type')=='driver_plan_command_ack' and x.get('outcome')=='applied']
   if ack:
    state['ack']=ack[0];frame.update(FuelLevel=1.0)
  result=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO,on_frame_ready=hook)
  self.assertIn('ack',state);self.assertEqual([],result.by_trigger('strategy_plan_box_call'))
  self.assertTrue(result.logs_containing('DRIVER TARGET AUTHORITY HOLD:'))
  warnings=result.by_trigger('fuel_strategy_warning')+result.by_trigger('fuel_warning')
  held=[x for x in warnings if x.get('fact_only')]
  self.assertTrue(held)
  self.assertTrue(all(x.get('safety_override') is None and x.get('set_fuel_l') is None for x in held))
  successor=state['ack']['successor_decision_id']
  active=[x for x in result.broadcasts if x.get('type')=='telemetry_live' and x.get('active_plan_decision_id')==successor]
  self.assertTrue(active);self.assertTrue(all(x['active_plan_revision']==state['ack']['successor_revision'] for x in active))

class AtomicRollback(unittest.TestCase):
 def test_active_and_awaiting_entire_state_identity_preserved_on_registration_failure(self):
  st=pl.new_race_strategy_state('r',0)
  st,_=pl.register_plan(st,decision_id='d',race_instance_id='r',session_num=0,selected_plan='A',phase='active',current_driver_pit_sequence=0,created_source_frame_sequence=2,activation_source_frame_sequence=2,target_lap=15,add_fuel_l=13,set_fuel_l=13)
  st,_=pl.register_plan(st,decision_id='b',race_instance_id='r',session_num=0,selected_plan='B',phase='awaiting_driver',current_driver_pit_sequence=0,created_source_frame_sequence=3,target_lap=16,add_fuel_l=13,set_fuel_l=13)
  intent=pl.DriverPlanIntent(command_id='rollback',operation='amend',race_instance_id='r',session_num=0,target_decision_id='d',expected_revision=0,expected_activation_source_frame_sequence=2,received_source_frame_sequence=9,driver_pit_sequence=0,requested_target_lap=10)
  with patch.object(pl,'register_plan',return_value=(st,pl.LifecycleOutcome(status='rejected',reason='registration_failure'))):
   result,outcome=pl.amend_active_plan(st,intent,calculation=fa.evaluate(inputs(),10),authority_inputs=inputs())
  self.assertIs(result,st);self.assertEqual('active',st.plan_records['d'].phase);self.assertEqual('awaiting_driver',st.plan_records['b'].phase)
  self.assertEqual('registration_failure',outcome.reason)

class DeliveryScopeGuards(unittest.TestCase):
 setup_attempt=DeliveryLedger.setup_attempt
 def test_foreign_scope_and_nonactive_cannot_issue(self):
  from dataclasses import replace
  for bad in ('foreign','cancelled'):
   led,rec,i,c=self.setup_attempt()
   if bad=='foreign':i['race_instance_id']='foreign'
   else:rec=replace(rec,phase='cancelled')
   led,snapshot,candidate=bd.advance(led,rec,i,on_track=True)
   self.assertIsNone(candidate);self.assertIsNone(snapshot['allowed_proof_id'])
   self.assertEqual('revoked',led.attempts[c['box_attempt']['attempt_id']]['status'])

if __name__=='__main__':unittest.main()
