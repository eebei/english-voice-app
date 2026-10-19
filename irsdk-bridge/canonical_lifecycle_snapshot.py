"""WO009 immutable process-local lifecycle publication. No restoration implied."""
import math,uuid
from dataclasses import dataclass,fields,is_dataclass
from collections.abc import Mapping
import plan_lifecycle as pl
import driver_pit_event as pe
import bridge_plan_lifecycle_adapter as adapter

PROCESS_EPOCH=uuid.uuid4().hex
_sequence=0

def clean(value):
    if is_dataclass(value):return {f.name:clean(getattr(value,f.name)) for f in fields(value)}
    if isinstance(value,Mapping):return {str(k):clean(v) for k,v in value.items()}
    if isinstance(value,(tuple,list)):return [clean(v) for v in value]
    if isinstance(value,float) and not math.isfinite(value):return None
    return value

@dataclass(frozen=True)
class LifecycleSnapshot:
    data: Mapping
    def __post_init__(self):object.__setattr__(self,'data',pl._deep_freeze(clean(self.data)))
    def serialize(self):return pl._deep_thaw(self.data)

def record_view(record):
    if record is None:return None
    r=clean(record)
    # Heavy original options/basis are retained in the owner, not repeated in wire.
    r.pop('options_snapshot',None)
    basis=r.pop('plan_basis',None) or {}
    r['constraint']=basis.get('driver_target_constraint')
    r['record_ref']={'bridge_process_epoch':PROCESS_EPOCH,'race_instance_id':record.race_instance_id,
                     'session_num':record.session_num,'decision_id':record.decision_id,'revision':record.revision}
    r['terminal_event_ref']=({'bridge_process_epoch':PROCESS_EPOCH,'race_instance_id':record.race_instance_id,
       'session_num':record.session_num,'pit_event_id':record.terminal_pit_event_id,
       'driver_pit_sequence':record.resolved_pit_sequence} if record.terminal_pit_event_id else None)
    return r

def build(*,state,facts,inputs,pit_store,box_ledger,box_projection,gate_reason=None,
          telemetry_available=True,on_pit_road=None,on_track=None,recommendations=None,
          last_driver_action=None,scope_closed=False,collision=False,visit_open=False,continuity=None,origins=None):
    global _sequence
    _sequence+=1
    facts=clean(facts or {});inputs=clean(inputs or {});diagnostics=[]
    origins=origins or {'records':{},'events':{},'origin_epoch':PROCESS_EPOCH}
    def origin_record(record):
        view=record_view(record)
        if view is not None:
            origin=origins['records'].get(record.decision_id,PROCESS_EPOCH)
            view['origin_record_ref']=dict(view['record_ref'],**origin) if isinstance(origin,dict) else dict(view['record_ref'],bridge_process_epoch=origin)
            view['current_custody_ref']=dict(view['record_ref'])
        return view
    def numeric(v):return isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v)
    def integer(v):return isinstance(v,int) and not isinstance(v,bool) and v>=0
    for key in ('fuel_level_l','avg_fuel_per_lap_l','reserve_l','effective_capacity_l','session_time_s'):
        if not numeric(inputs.get(key)) or inputs[key]<0:inputs[key]=None
    for key in ('current_lap','total_laps','crossings_to_finish'):
        if not isinstance(inputs.get(key),int) or isinstance(inputs.get(key),bool):inputs[key]=None
    if not numeric(inputs.get('lap_dist_pct')) or not 0<=inputs['lap_dist_pct']<=1:inputs['lap_dist_pct']=None
    on_pit_road=on_pit_road if isinstance(on_pit_road,bool) else None
    on_track=on_track if isinstance(on_track,bool) else None
    active=pl.active_plan_view(state) if state is not None else None
    race_id=facts.get('race_instance_id');session_num=facts.get('session_num')
    source=facts.get('source_frame') or {}
    available=telemetry_available is True and isinstance(source.get('sequence'),int) and not isinstance(source.get('sequence'),bool)
    if state is not None and (state.race_instance_id!=race_id or state.session_num!=session_num):diagnostics.append('lifecycle_scope_mismatch')
    if state is not None and state.active_plan_id is not None and active is None:diagnostics.append('active_pointer_missing_record')
    if active is not None and (active.phase!='active' or state.active_plan_id!=active.decision_id):diagnostics.append('active_pointer_mismatch')
    if on_pit_road is None or on_track is None:diagnostics.append('unknown_raw_pit_track_state')
    if not available:
        gate_reason=gate_reason or 'telemetry_unavailable'
        facts['black_flag']={'state':'unknown','authority':'iRacing SessionFlags','raw_value':None,'observed_session_time':None,'source_frame_sequence':source.get('sequence'),'freshness':'unavailable','available':False,'reason':'currently_unread'}
        facts['session_flags']={'available':False,'raw_value':None,'reason':'currently_unread'}
    events=[pe.serialize_driver_pit_event(e) for e in (pit_store or {}).values() if e.race_instance_id==race_id and e.session_num==session_num]
    for e in events:e['event_ref']={'bridge_process_epoch':PROCESS_EPOCH,'race_instance_id':race_id,'session_num':session_num,'pit_event_id':e['pit_event_id'],'driver_pit_sequence':e['driver_pit_sequence']}
    for e in events:e['origin_event_ref']=dict(e['event_ref'],bridge_process_epoch=origins['events'].get(e['pit_event_id'],PROCESS_EPOCH))
    for eid in (state.applied_pit_events if state else {}):
        if eid not in (pit_store or {}):diagnostics.append('applied_pit_event_not_in_store:'+eid)
    box=clean(box_projection or {})
    if not integer(facts.get('driver_pit_sequence')) or not integer(session_num):diagnostics.append('malformed_fact_identity_sequence')
    if box.get('allowed_attempt_id'):
        attempt=box_ledger.attempts.get(box['allowed_attempt_id'])
        if (active is None or attempt is None or any(attempt.get(k)!=v for k,v in {
                'decision_id':active.decision_id if active else None,'plan_revision':active.revision if active else None,
                'race_instance_id':race_id,'session_num':session_num,
                'activation_frame':active.activated_source_frame_sequence if active else None,
                'driver_pit_sequence':facts.get('driver_pit_sequence'),'proof_id':box.get('allowed_proof_id')}.items())
                or not numeric(box.get('valid_until_session_s'))
                or not numeric(attempt.get('issued_session_time'))
                or box['valid_until_session_s']!=attempt['issued_session_time']+5.0):
            diagnostics.append('box_active_reference_mismatch')
    if available and any(inputs.get(k) is None for k in ('fuel_level_l','current_lap','lap_dist_pct','session_time_s')):
        diagnostics.append('unknown_raw_execution_inputs')
    if available and facts.get('black_flag',{}).get('state')=='unknown':
        diagnostics.append('unknown_raw_session_flags')
    if available and any(inputs.get(k)!=v for k,v in {
            'race_instance_id':race_id,'session_num':session_num,'source_frame_sequence':source.get('sequence'),
            'session_time_s':source.get('session_time_s'),'driver_pit_sequence':facts.get('driver_pit_sequence')}.items()):
        diagnostics.append('raw_inputs_fact_reference_mismatch')
    if scope_closed:diagnostics.append('scope_closed')
    if collision:diagnostics.append('pit_event_collision')
    if visit_open:diagnostics.append('visit_open')
    if facts.get('black_flag',{}).get('state')=='true':diagnostics.append('raw_black_flag')
    # This facet permits BOX execution, not merely an active Plan description.
    # WO008 owns the fresh verdict; compose its final outcome without inventing
    # another strategy calculation or publishing held settings as executable.
    box_reason=box.get('execution_gate')
    if box_reason:diagnostics.append('box_verdict:'+str(box_reason))
    if not box.get('allowed_attempt_id') or not box.get('allowed_proof_id'):
        diagnostics.append('box_authority_unavailable')
    elif active is not None:
        attempt=box_ledger.attempts.get(box['allowed_attempt_id']) or {}
        proof=clean(attempt.get('authority_proof') or {}) if attempt else {}
        expected={'proof_id':box.get('allowed_proof_id'),'race_instance_id':race_id,'session_num':session_num,
          'decision_id':active.decision_id,'plan_revision':active.revision,
          'activation_frame':active.activated_source_frame_sequence,'driver_pit_sequence':facts.get('driver_pit_sequence'),
          'expected_pit_sequence':active.expected_pit_sequence,'selected_plan':active.selected_plan,
          'target_lap':active.target_lap,'add_fuel_l':active.add_fuel_l,'set_fuel_l':active.set_fuel_l}
        if (any(proof.get(k)!=v for k,v in expected.items())
            or any(not integer(proof.get(k)) for k in ('session_num','plan_revision','activation_frame','driver_pit_sequence','expected_pit_sequence','target_lap'))
            or any(not integer(attempt.get(k)) for k in ('session_num','plan_revision','activation_frame','driver_pit_sequence','dispatch_sequence'))
            or not numeric(proof.get('add_fuel_l')) or proof['add_fuel_l']<0
            or not numeric(proof.get('set_fuel_l')) or proof['set_fuel_l']<0 or proof['set_fuel_l']!=int(proof['set_fuel_l'])
            or active.expected_pit_sequence!=facts.get('driver_pit_sequence',-1)+1
            or active.target_lap!=inputs.get('current_lap')
            or attempt.get('status') not in ('created','dispatched','audible_started')
            or not numeric(proof.get('issued_session_time')) or proof['issued_session_time']!=attempt.get('issued_session_time')
            or not numeric(source.get('session_time_s')) or not numeric(box.get('valid_until_session_s')) or not proof['issued_session_time']<=source['session_time_s']<box['valid_until_session_s']
            or not isinstance(proof.get('issued_source_frame'),int) or isinstance(proof.get('issued_source_frame'),bool)
            or proof['issued_source_frame']>source.get('sequence',-1)):
            diagnostics.append('box_proof_record_mismatch')
    event_lookup={e['pit_event_id']:e for e in events}
    for record in state.plan_records.values() if state else ():
        if record.terminal_pit_event_id:
            event=event_lookup.get(record.terminal_pit_event_id)
            if event is None or record.resolved_pit_sequence is not None and event['driver_pit_sequence']!=record.resolved_pit_sequence:
                diagnostics.append('terminal_event_reference_mismatch:'+record.decision_id)
    reason=gate_reason or (diagnostics[0] if diagnostics else None)
    can_execute=available and reason is None and active is not None and on_track is True and on_pit_road is False
    if not can_execute:
        box.update(allowed_attempt_id=None,allowed_proof_id=None,valid_until_session_s=None)
    records=list(state.plan_records.values()) if state else []
    terminal=[origin_record(r) for r in records if r.phase in ('executed','invalidated','cancelled')]
    terminal=terminal[-32:]
    for view in terminal:
        if view['terminal_pit_event_id'] in event_lookup:
            view['terminal_event_ref']=clean(event_lookup[view['terminal_pit_event_id']]['event_ref'])
            view['origin_terminal_event_ref']=clean(event_lookup[view['terminal_pit_event_id']]['origin_event_ref'])
    lap=inputs.get('current_lap');total=inputs.get('total_laps')
    lap_known=all(isinstance(x,int) and not isinstance(x,bool) for x in (lap,total)) and 1<=lap<=total<3000 and inputs.get('finish_kind')=='lap_race'
    attempts=[clean(a) for a in box_ledger.attempts.values() if a['race_instance_id']==race_id and a['session_num']==session_num]
    for a in attempts:a.pop('authority_proof',None);a.pop('material_key',None)
    payload=dict(type='canonical_lifecycle_snapshot',schema_version=1,bridge_process_epoch=PROCESS_EPOCH,
      snapshot_sequence=_sequence,snapshot_id=PROCESS_EPOCH+':'+str(_sequence),race_instance_id=race_id,session_num=session_num,
      source_frame={'sequence':source.get('sequence'),'session_time_s':source.get('session_time_s'),'available':available},
      telemetry_available=available,freshness={'status':'fresh' if available else 'unavailable'},
      unknowns=[k for k,v in inputs.items() if v is None],diagnostics=diagnostics,
      race_facts=facts,current_facts={'available':available and 'raw_inputs_fact_reference_mismatch' not in diagnostics,
       'reason':('raw_inputs_fact_reference_mismatch' if 'raw_inputs_fact_reference_mismatch' in diagnostics else None if available else 'telemetry_unavailable'),
       'source_frame':{'sequence':inputs.get('source_frame_sequence'),'session_time_s':inputs.get('session_time_s')},
       'scope_ref':{'race_instance_id':inputs.get('race_instance_id'),'session_num':inputs.get('session_num')},
       'fuel_level_l':inputs.get('fuel_level_l') if available else None,
       'current_lap':lap if available else None,'lap_dist_pct':inputs.get('lap_dist_pct') if available else None,
       'on_pit_road':on_pit_road if available else None,'on_track':on_track if available else None},
      finish={'kind':inputs.get('finish_kind'),'remaining_after_current':total-lap if lap_known and available else None,
       'remaining_sf_crossings':total-lap+1 if lap_known and available else None,'source_frame_sequence':source.get('sequence'),
       'available':lap_known and available},
      lifecycle={'active_plan_id':state.active_plan_id if state else None,'active':origin_record(active),
       'awaiting':[origin_record(r) for r in records if r.phase=='awaiting_driver'],'terminal_records':terminal,
       'terminal_summary_bounded':len([r for r in records if r.phase in ('executed','invalidated','cancelled')])>32},
      pit_ledger={'events':events,'last_event':events[-1] if events else None,'recorded_event_count':len(events),
       'process_observed_exit_count':facts.get('driver_pit_sequence'),'absolute_race_exit_count':None},
      execution={'allowed':can_execute,'gate_reason':reason,'scope_closed':scope_closed is True,
       'collision':collision is True,'visit_open':visit_open is True or on_pit_road is True,'box_verdict_reason':box.get('execution_gate')},
      box_delivery={'allowed_proof_id':box.get('allowed_proof_id'),'allowed_attempt_id':box.get('allowed_attempt_id'),
       'valid_until_session_s':box.get('valid_until_session_s'),'attempts':attempts[-16:],'summary_bounded':len(attempts)>16},
      last_driver_action={'available':last_driver_action is not None,'action':clean(last_driver_action)},recommendations=clean(recommendations or {}),
      continuity=continuity or {'restored':False,'prior_history_available':False,'resume_old_plan_allowed':False,
       'pit_sequence_origin':'process_observed','state_origin_epoch':PROCESS_EPOCH})
    return LifecycleSnapshot(payload)

def refs(snapshot):
    s=snapshot.data if isinstance(snapshot,LifecycleSnapshot) else snapshot
    return {'bridge_process_epoch':s['bridge_process_epoch'],'canonical_snapshot_id':s['snapshot_id'],
            'canonical_snapshot_sequence':s['snapshot_sequence']}

def project_box(snapshot,box):
    s=snapshot.serialize();p=clean(box);p.update(refs(snapshot))
    p.update(race_instance_id=s['race_instance_id'],session_num=s['session_num'],source_frame_sequence=s['source_frame']['sequence'],
      session_time_s=s['source_frame']['session_time_s'],active_decision_id=s['lifecycle']['active_plan_id'],
      active_phase=s['lifecycle']['active']['phase'] if s['lifecycle']['active'] else None,
      plan_revision=s['lifecycle']['active']['revision'] if s['lifecycle']['active'] else None,
      activation_frame=s['lifecycle']['active']['activated_source_frame_sequence'] if s['lifecycle']['active'] else None,
      driver_pit_sequence=s['race_facts'].get('driver_pit_sequence'),current_lap=s['current_facts']['current_lap'],
      closed=s['execution']['scope_closed'],collision=s['execution']['collision'],execution_gate=s['execution']['box_verdict_reason'],
      allowed_proof_id=s['box_delivery']['allowed_proof_id'],allowed_attempt_id=s['box_delivery']['allowed_attempt_id'],
      valid_until_session_s=s['box_delivery']['valid_until_session_s'])
    if not s['execution']['allowed']:p['execution_gate']=s['execution']['gate_reason'] or 'execution_unavailable'
    return p

def project_telemetry(snapshot,telemetry):
    s=snapshot.serialize();t=clean(telemetry);t.update(refs(snapshot));t['canonical_lifecycle']=s
    active=s['lifecycle']['active'];allowed=s['execution']['allowed']
    t.update(race_instance_id=s['race_instance_id'],session_num=s['session_num'],source_frame_sequence=s['source_frame']['sequence'],
      driver_pit_sequence=s['race_facts'].get('driver_pit_sequence'),active_plan_decision_id=active['decision_id'] if active else None,
      active_plan_revision=active['revision'] if active else None,
      active_plan_activated_source_frame_sequence=active['activated_source_frame_sequence'] if active else None)
    t['strategy_options_role']='recommendation_not_execution'
    t['strategy_plan']={'action':'box' if allowed and s['box_delivery']['allowed_attempt_id'] else 'hold',
     'set_fuel_l':active['set_fuel_l'] if allowed and active else None,'decision_id':active['decision_id'] if active else None,
     'target_lap':active['target_lap'] if active else None,'reason':s['execution']['gate_reason'] or 'canonical_projection'}
    return t
