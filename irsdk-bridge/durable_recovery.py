"""WO010: single-owner, atomic, strict complete strategy recovery bundles."""
import dataclasses, hashlib, json, math, os, tempfile, time, typing
import threading
from collections.abc import Mapping
from dataclasses import replace
import plan_lifecycle as pl
import driver_pit_event as pe
import driver_plan_command as pc
import box_authority_delivery as bd
import fixed_target_authority as fa
import fuel_reference_planning as fuel_reference

VERSION=1
MAX_BYTES=8*1024*1024
DOMAINS={'state','pit_store','pit_sequence','closed','collision','constraint','commands','box','visit','boundary','origins','archives','scope_archives'}
FUEL_INPUT_KEYS={'schema_version','race_instance_id','session_num','source_frame_sequence','session_time_s','current_lap','total_laps','lap_dist_pct','crossings_to_finish','finish_kind','fuel_level_l','avg_fuel_per_lap_l','clean_laps_sampled','reserve_l','effective_capacity_l','max_set_fuel_l','driver_pit_sequence','multi_stop'}
REFERENCE_FUEL_INPUT_KEYS=FUEL_INPUT_KEYS|{'provisional_history','time_remaining_s','black_flag','on_track','on_pit_road',
    'telemetry_available','source_available','scope_closed','collision','session_finished','race_format','configured_duration_s',
    'cust_id','car_model','track','track_raw','process_epoch','current_measured_rate_l_per_lap','current_measured_samples','current_measured_pace_s','current_measured_pace_samples','planning_pace_s'}


def fuel_input_schema(inputs,record):
    if not isinstance(inputs,Mapping):return False
    if inputs.get('finish_kind')!=fuel_reference.CONTRACT:return set(inputs)==FUEL_INPUT_KEYS
    ref=fuel_reference.reference_of(record)
    return (set(inputs)==REFERENCE_FUEL_INPUT_KEYS and ref is not None
        and fuel_reference.reference_valid(inputs.get('provisional_history'))
        and canonical(pack(ref))==canonical(pack(inputs['provisional_history'])))


CLASSES={c.__name__:c for mod in (pl,pe,pc,bd) for c in vars(mod).values() if isinstance(c,type) and dataclasses.is_dataclass(c)}
class RecoveryError(ValueError):pass

def integer(x):return type(x) is int and x>=0

def finite(x):return type(x) in (int,float) and math.isfinite(x)

def pack(v):
    if dataclasses.is_dataclass(v):return {'$type':type(v).__name__,'fields':{f.name:pack(getattr(v,f.name)) for f in dataclasses.fields(v)}}
    if isinstance(v,Mapping):return {k:pack(x) for k,x in v.items()}
    if isinstance(v,(list,tuple)):return [pack(x) for x in v]
    if v is None or type(v) in (str,bool,int) or type(v) is float and math.isfinite(v):return v
    raise RecoveryError('non_finite_or_non_json')

def typed(v,t):
    origin=typing.get_origin(t);args=typing.get_args(t)
    if t is typing.Any:return True
    if origin is typing.Union:return any(typed(v,a) for a in args)
    if t is type(None):return v is None
    if t is int:return type(v) is int
    if t is float:return finite(v)
    if t in (str,bool):return type(v) is t
    if origin in (tuple,typing.Tuple):return isinstance(v,(tuple,list)) and (all(typed(x,args[0]) for x in v) if args and args[-1] is Ellipsis else len(v)==len(args) and all(typed(x,a) for x,a in zip(v,args)))
    if origin in (dict,Mapping):return isinstance(v,Mapping) and (not args or all(typed(k,args[0]) and typed(x,args[1]) for k,x in v.items()))
    if t is Mapping:return isinstance(v,Mapping)
    if isinstance(t,type):return isinstance(v,t)
    return False

def unpack(v):
    if isinstance(v,list):return [unpack(x) for x in v]
    if isinstance(v,dict):
        if '$type' in v:
            if set(v)!={'$type','fields'} or v['$type'] not in CLASSES:raise RecoveryError('unknown_typed_domain')
            c=CLASSES[v['$type']];fs=dataclasses.fields(c);d=v['fields']
            if not isinstance(d,dict) or set(d)!={f.name for f in fs}:raise RecoveryError('missing_typed_field')
            d={k:unpack(x) for k,x in d.items()}
            for f in fs:
                # The legacy ledger annotation predates its structured reason receipts.
                field_type=typing.Mapping[str,typing.Any] if c is pc.DriverPlanCommandLedger and f.name=='reasons' else f.type
                if not typed(d[f.name],field_type):raise RecoveryError('invalid_type:'+c.__name__+'.'+f.name)
            try:return c(**d)
            except (TypeError,ValueError) as e:raise RecoveryError('invalid_domain:'+str(e)) from e
        return {k:unpack(x) for k,x in v.items()}
    if v is None or type(v) in (str,bool,int) or type(v) is float and math.isfinite(v):return v
    raise RecoveryError('invalid_json_scalar')

def strict_pairs(pairs):
    result={}
    for key,value in pairs:
        if key in result:raise RecoveryError('duplicate_json_key')
        result[key]=value
    return result

def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False)

def scope_archive_key(scope,epoch,revision):return hashlib.sha256(canonical(scope).encode()).hexdigest()+':'+epoch+':'+str(revision)

def stable_scope(info,race_id,session_num):
    cust=info.get('player_cust_id') if isinstance(info,dict) else None
    if not integer(session_num) or not integer(cust) or cust<=0 or not isinstance(race_id,str) or not race_id.startswith(('sub:','sid:')):return None
    return {'race_instance_id':race_id,'session_num':session_num,'driver_id':cust}

def custody_scope(info,race_id,session_num,process_epoch):
    """Durable receipts for this owner only; never a restart identity."""
    stable=stable_scope(info,race_id,session_num)
    if stable is not None:return stable
    cust=info.get('player_cust_id') if isinstance(info,dict) else None
    if (not integer(session_num) or not integer(cust) or cust<=0
        or not isinstance(race_id,str) or not race_id.startswith('fallback:') or len(race_id)<=9
        or not isinstance(process_epoch,str) or not process_epoch):return None
    return {'race_instance_id':race_id,'session_num':session_num,'driver_id':cust,'process_epoch':process_epoch}

def valid_scope(scope,epoch=None):
    if not isinstance(scope,dict):return False
    if set(scope)=={'race_instance_id','session_num','driver_id'}:
        return stable_scope({'player_cust_id':scope['driver_id']},scope['race_instance_id'],scope['session_num'])==scope
    if set(scope)!={'race_instance_id','session_num','driver_id','process_epoch'}:return False
    return (custody_scope({'player_cust_id':scope['driver_id']},scope['race_instance_id'],scope['session_num'],scope['process_epoch'])==scope
            and (epoch is None or scope['process_epoch']==epoch))

def validate_domains(d,scope,check_constraint_receipts=True):
    if not valid_scope(scope):raise RecoveryError('unstable_scope')
    if not isinstance(d,dict) or set(d)!=DOMAINS:raise RecoveryError('missing_domain')
    s=d['state'];pit=d['pit_store'];n=d['pit_sequence'];race=scope['race_instance_id'];sn=scope['session_num']
    if not isinstance(s,pl.RaceStrategyState) or (s.race_instance_id,s.session_num)!=(race,sn) or not isinstance(pit,dict) or not integer(n):raise RecoveryError('invalid_state_scope_sequence')
    if d['closed'] is not None and (not isinstance(d['closed'],list) or len(d['closed'])!=2 or not isinstance(d['closed'][0],str) or not integer(d['closed'][1]) or d['closed']!=[race,sn]):raise RecoveryError('closed_latch_scope')
    if d['collision'] is not None and (not isinstance(d['collision'],list) or len(d['collision'])!=3 or d['collision'][:2]!=[race,sn] or not integer(d['collision'][1]) or not integer(d['collision'][2])):raise RecoveryError('collision_latch_scope')
    for eid,e in pit.items():
        if not isinstance(e,pe.DriverPitEvent) or e.schema_version!=1 or eid!=e.pit_event_id or (e.race_instance_id,e.session_num)!=(race,sn) or not integer(e.driver_pit_sequence) or e.driver_pit_sequence<1 or e.driver_pit_sequence>n or eid!=pe.build_pit_event_id(race,sn,e.driver_pit_sequence) or e.penalty_evidence.state not in ('true','false','unknown') or e.execution_relation not in ('normal','early','penalty','unresolved'):raise RecoveryError('invalid_pit_event')
    for eid,e in s.applied_pit_events.items():
        if eid not in pit or e!=pit[eid]:raise RecoveryError('applied_event_reference')
    if n>MAX_BYTES:raise RecoveryError('pit_sequence_capacity')
    if d['collision'] is None and (n!=len(pit) or any(seq!=i for i,seq in enumerate(sorted(e.driver_pit_sequence for e in pit.values()),1))):raise RecoveryError('pit_sequence_completeness')
    for rid,r in s.plan_records.items():
        if rid!=r.decision_id or (r.race_instance_id,r.session_num)!=(race,sn) or not integer(r.revision) or r.selected_plan not in ('A','B','C') or not integer(r.created_source_frame_sequence):raise RecoveryError('record_reference')
        for k in ('created_source_frame_sequence','registered_driver_pit_sequence','revision'):
            if not integer(getattr(r,k)):raise RecoveryError('record_integer:'+k)
        if r.registered_driver_pit_sequence>n:raise RecoveryError('record_sequence')
        for k in ('target_lap','expected_pit_sequence','activated_source_frame_sequence','activation_record_revision'):
            x=getattr(r,k)
            if x is not None and (not integer(x) or k in ('target_lap','expected_pit_sequence') and x<1):raise RecoveryError('record_optional_integer:'+k)
        for k in ('add_fuel_l','set_fuel_l'):
            x=getattr(r,k)
            if x is not None and (not finite(x) or x<0 or k=='set_fuel_l' and x!=int(x)):raise RecoveryError('record_fuel:'+k)
        if r.expected_pit_sequence is not None and r.expected_pit_sequence>n+1:raise RecoveryError('record_future_pit_sequence')
        if r.activation_record_revision is not None and r.activation_record_revision>r.revision:raise RecoveryError('record_activation_revision')
        if r.activated_source_frame_sequence is not None and r.activated_source_frame_sequence<r.created_source_frame_sequence:raise RecoveryError('record_activation_before_creation')
        if r.phase in pl.TERMINAL_PHASES and not isinstance(r.invalidated_reason,str) and r.phase!='executed':raise RecoveryError('terminal_reason_missing')
        if r.terminal_pit_event_id and r.terminal_pit_event_id not in pit:raise RecoveryError('terminal_event_reference')
        if r.resolved_pit_sequence is not None and (not integer(r.resolved_pit_sequence) or r.resolved_pit_sequence>n):raise RecoveryError('resolved_sequence')
    for h in s.history:
        r=s.plan_records.get(h.decision_id)
        if r is None or (h.race_instance_id,h.session_num)!=(race,sn) or not integer(h.revision) or h.revision>r.revision or h.phase not in pl.NON_TERMINAL_PHASES+pl.TERMINAL_PHASES or not isinstance(h.reason,str) or not h.reason or h.pit_event_id is not None and h.pit_event_id not in pit:raise RecoveryError('history_reference')
    def validate_constraint(c):
        if c is None:return
        keys={'constraint_id','command_id','race_instance_id','session_num','predecessor_decision_id','predecessor_revision','predecessor_activation_frame','source_frame_sequence','driver_pit_sequence','target_lap'}
        if not isinstance(c,Mapping) or set(c)!=keys or (c['race_instance_id'],c['session_num'])!=(race,sn) or any(not isinstance(c[k],str) or not c[k] for k in ('constraint_id','command_id','race_instance_id','predecessor_decision_id')) or any(not integer(c[k]) for k in ('session_num','predecessor_revision','predecessor_activation_frame','source_frame_sequence','driver_pit_sequence','target_lap')) or c['target_lap']<1  or c['predecessor_decision_id'] not in s.plan_records:raise RecoveryError('constraint_scope_reference')
    validate_constraint(d['constraint'])
    if d['constraint'] is not None and not any(isinstance(r.plan_basis,Mapping) and r.plan_basis.get('driver_target_constraint')==d['constraint'] for r in s.plan_records.values()):raise RecoveryError('pending_constraint_record_missing')
    for r in s.plan_records.values():
        if isinstance(r.plan_basis,Mapping):validate_constraint(r.plan_basis.get('driver_target_constraint'))
    commands=d['commands'];box=d['box']
    if not isinstance(commands,pc.DriverPlanCommandLedger) or commands.race_instance_id not in (None,race) or commands.session_num not in (None,sn):raise RecoveryError('command_scope')
    if set(commands.commands)!=set(commands.acknowledgements):raise RecoveryError('command_receipt_missing')
    for cid,content in commands.commands.items():
        try:original=json.loads(content)
        except (ValueError,TypeError) as e:raise RecoveryError('command_content') from e
        norm,error=pc.validate_envelope(original);ack=commands.acknowledgements[cid]
        if not isinstance(ack,Mapping) or error or norm['command_id']!=cid or (norm['race_instance_id'],norm['session_num'])!=(race,sn) or json.dumps(norm,ensure_ascii=False,sort_keys=True,separators=(',',':'))!=content or ack.get('command_id')!=cid or ack.get('outcome') not in ('applied','rejected','scope_mismatch','collision','stale','no_active_plan','retry_no_op'):raise RecoveryError('command_receipt_binding')
        base_keys={'type','command_id','intent','race_instance_id','session_num','decision_id','expected_revision','result_revision','outcome','lifecycle_phase','reason','bridge_process_epoch','canonical_snapshot_id','canonical_snapshot_sequence'}
        amend_keys={'successor_decision_id','successor_revision','successor_activation_frame','successor_target_lap','successor_add_fuel_l','successor_set_fuel_l','constraint_id','authority_snapshot'} if ack['outcome']=='applied' and norm['intent']=='amend' else set()
        if set(ack)!=base_keys|amend_keys or ack['type']!='driver_plan_command_ack' or ack['reason'] is not None and not isinstance(ack['reason'],str):raise RecoveryError('command_ack_schema')
        if any(norm.get(k)!=ack.get(k) for k in ('bridge_process_epoch','canonical_snapshot_id','canonical_snapshot_sequence')):raise RecoveryError('command_origin_binding')
        if any(not integer(norm[k]) for k in ('session_num','expected_revision','expected_activation_source_frame_sequence','source_frame_sequence','driver_pit_sequence')) or not isinstance(norm.get('bridge_process_epoch'),str) or not norm['bridge_process_epoch'] or not integer(norm.get('canonical_snapshot_sequence')) or norm['canonical_snapshot_sequence']<1 or norm.get('canonical_snapshot_id')!=norm['bridge_process_epoch']+':'+str(norm['canonical_snapshot_sequence']):raise RecoveryError('command_scalar_reference')
        if any(ack.get(k)!=norm.get(v) or type(ack.get(k)) is not type(norm.get(v)) for k,v in (('race_instance_id','race_instance_id'),('session_num','session_num'),('decision_id','expected_decision_id'),('expected_revision','expected_revision'),('intent','intent'))):raise RecoveryError('command_ack_reference')
        if ack.get('result_revision') is not None and not integer(ack['result_revision']):raise RecoveryError('command_ack_result')
        if ack['outcome']=='applied':
            r=s.plan_records.get(norm['expected_decision_id'])
            expected_phase='cancelled' if norm['intent']=='cancel' else 'invalidated'
            if r is None or not integer(ack.get('result_revision')) or ack['result_revision']!=norm['expected_revision']+1 or ack['result_revision']>r.revision or ack.get('lifecycle_phase')!=expected_phase:raise RecoveryError('command_applied_record')
            if not any(h.decision_id==r.decision_id and h.revision==ack['result_revision'] and h.phase==expected_phase and h.reason==ack['reason'] for h in s.history):raise RecoveryError('command_transition_history')
            if norm['intent']=='amend':
                successor=s.plan_records.get(ack.get('successor_decision_id'))
                if successor is None or any(ack.get('successor_'+k)!=getattr(successor,k) or type(ack.get('successor_'+k)) is not type(getattr(successor,k)) for k in ('target_lap','add_fuel_l','set_fuel_l')) or not integer(ack.get('successor_revision')) or ack['successor_revision']!=0 or not integer(ack.get('successor_activation_frame')) or ack['successor_activation_frame']!=successor.activated_source_frame_sequence or successor.activation_record_revision!=0:raise RecoveryError('command_successor_reference')
                c=successor.plan_basis.get('driver_target_constraint') if isinstance(successor.plan_basis,Mapping) else None
                if not c or ack.get('constraint_id')!=c['constraint_id'] or c['command_id']!=cid or c['predecessor_decision_id']!=r.decision_id or c['predecessor_revision']!=norm['expected_revision']:raise RecoveryError('command_successor_constraint')
                authority=ack.get('authority_snapshot')
                inputs=successor.plan_basis.get('authority_inputs')
                if not isinstance(inputs,Mapping) or set(inputs)!=FUEL_INPUT_KEYS or type(inputs['schema_version']) is not int or inputs['schema_version']!=1 or not fa.evaluate(inputs,successor.target_lap).get('available'):raise RecoveryError('command_authority_inputs')
                expected=dict(pl._deep_thaw(successor.plan_basis['authority_inputs']),target_lap=successor.target_lap,add_fuel_l=successor.add_fuel_l,set_fuel_l=successor.set_fuel_l,successor_decision_id=successor.decision_id,successor_revision=0,successor_activation_frame=successor.activated_source_frame_sequence,constraint_id=c['constraint_id'])
                if not isinstance(authority,Mapping) or canonical(pack(authority))!=canonical(pack(expected)):raise RecoveryError('command_authority_snapshot')
    for cid,reason in commands.reasons.items():
        if cid not in commands.commands or not isinstance(reason,Mapping) or set(reason)!={'reason_event_id','content','reason_text'} or any(not isinstance(reason[k],str) or not reason[k] for k in reason):raise RecoveryError('reason_receipt')
        try:event=json.loads(reason['content'])
        except (ValueError,TypeError) as e:raise RecoveryError('reason_content') from e
        ack=commands.acknowledgements[cid]
        if not isinstance(event,dict) or set(event)!={'reason_event_id','command_id','race_instance_id','session_num','decision_id','expected_revision','reason_text'} or event['reason_event_id']!=reason['reason_event_id'] or event['command_id']!=cid or event['reason_text']!=reason['reason_text'] or (event['race_instance_id'],event['session_num'])!=(race,sn) or not integer(event['session_num']) or not integer(event['expected_revision']) or event['decision_id']!=ack.get('decision_id') or event['expected_revision']!=ack.get('expected_revision'):raise RecoveryError('reason_binding')
    if not isinstance(box,bd.BoxLedger) or not integer(box.sequence):raise RecoveryError('box_ledger')
    for aid,a in box.attempts.items():
        if not isinstance(a,Mapping):raise RecoveryError('box_attempt_schema')
        required=set(bd.BINDINGS)|{'status','history','confirmed_started','confirmed_completed','confirmed_interrupted','issued_session_time','material_key','authority_proof','canonical_dispatch_ref'}
        if not required<=set(a) or set(a)-required-{'confirmed_not_started','restored_history_only'}:raise RecoveryError('box_attempt_schema')
        statuses={'created','dispatched','audible_started','audible_completed','audible_interrupted','delivery_unknown','dropped_before_audible','suppressed_by_user','expired','revoked'}
        if a['status'] not in statuses or not isinstance(a['history'],(tuple,list)) or not a['history'] or any(not isinstance(h,Mapping) or h.get('status') not in statuses for h in a['history']):raise RecoveryError('box_attempt_history')
        if any(k in a and type(a[k]) is not bool for k in ('confirmed_not_started','restored_history_only')):raise RecoveryError('box_attempt_flag')
        if aid!=a.get('attempt_id') or (a.get('race_instance_id'),a.get('session_num'))!=(race,sn) or not integer(a.get('dispatch_sequence')) or a['dispatch_sequence']>box.sequence or any(not integer(a.get(k)) for k in ('session_num','activation_frame','driver_pit_sequence','plan_revision')) or a.get('decision_id') not in s.plan_records:raise RecoveryError('box_binding')
        if type(a.get('confirmed_started')) is not bool or type(a.get('confirmed_completed')) is not bool or type(a.get('confirmed_interrupted')) is not bool or not finite(a.get('issued_session_time')):raise RecoveryError('box_state')
        p=a.get('authority_proof');ref=a.get('canonical_dispatch_ref')
        if not isinstance(p,Mapping) or any(a.get(k)!=p.get(k) for k in ('proof_id','race_instance_id','session_num','decision_id','plan_revision','activation_frame','driver_pit_sequence')):raise RecoveryError('proof_binding')
        proof_keys={'schema_version','race_instance_id','session_num','decision_id','plan_revision','activation_frame','issued_source_frame','issued_session_time','driver_pit_sequence','expected_pit_sequence','selected_plan','target_lap','current_lap','add_fuel_l','set_fuel_l','constraint_id','fuel_inputs','validation','validity_contract','proof_id'}
        if set(p)!=proof_keys or type(p['schema_version']) is not int or p['schema_version']!=1 or any(not integer(p[k]) for k in ('session_num','plan_revision','activation_frame','driver_pit_sequence','issued_source_frame','expected_pit_sequence','target_lap','current_lap')) or any(not finite(p[k]) or p[k]<0 for k in ('issued_session_time','add_fuel_l','set_fuel_l')) or p['set_fuel_l']!=int(p['set_fuel_l']) or p['issued_session_time']!=a['issued_session_time']:raise RecoveryError('proof_schema')
        proof_body={k:pl._deep_thaw(v) for k,v in p.items() if k!='proof_id'}
        if p['proof_id']!='box-proof:'+hashlib.sha256(json.dumps(proof_body,sort_keys=True,allow_nan=False).encode()).hexdigest()[:24]:raise RecoveryError('proof_digest')
        if not fuel_input_schema(p['fuel_inputs'],s.plan_records[a['decision_id']]) or type(p['fuel_inputs']['schema_version']) is not int or p['fuel_inputs']['schema_version']!=1 or not isinstance(p['validation'],Mapping) or p['validity_contract']!={'ttl_seconds':5.0,'window':'same_target_lap'}:raise RecoveryError('proof_calculation_schema')
        verdict=fa.evaluate(p['fuel_inputs'],p['target_lap'],frozen_set=p['set_fuel_l'])
        if not verdict.get('available') or canonical(pack(verdict))!=canonical(pack(p['validation'])) or p['fuel_inputs'].get('source_frame_sequence')!=p['issued_source_frame'] or p['fuel_inputs'].get('session_time_s')!=p['issued_session_time']:raise RecoveryError('proof_calculation_content')
        r=s.plan_records[a['decision_id']]
        if a['plan_revision']>r.revision or any(p[k]!=getattr(r,k) for k in ('selected_plan','target_lap','add_fuel_l','set_fuel_l','expected_pit_sequence')):raise RecoveryError('proof_record_reference')
        if tuple(a['material_key'])!=fa.material_key(replace(r,revision=a['plan_revision']),p['fuel_inputs']):raise RecoveryError('attempt_material_reference')
        if not isinstance(ref,Mapping) or set(ref)!={'bridge_process_epoch','canonical_snapshot_id','canonical_snapshot_sequence'} or not isinstance(ref['bridge_process_epoch'],str) or not ref['bridge_process_epoch'] or not integer(ref['canonical_snapshot_sequence']) or ref['canonical_snapshot_sequence']<1 or ref['canonical_snapshot_id']!=ref['bridge_process_epoch']+':'+str(ref['canonical_snapshot_sequence']):raise RecoveryError('dispatch_reference')
    for rid,report in box.reports.items():
        if not isinstance(report,Mapping):raise RecoveryError('box_report_schema')
        aid=report.get('attempt_id');a=box.attempts.get(aid)
        if not isinstance(rid,str) or not rid or a is None or set(report)!=set(bd.BINDINGS)|{'outcome','bridge_process_epoch','canonical_snapshot_id','canonical_snapshot_sequence'}|set(bd.REPORT_METADATA) or report.get('outcome') not in bd.REPORT_OUTCOMES or any(report.get(k)!=a.get(k) or type(report.get(k)) is not type(a.get(k)) for k in bd.BINDINGS) or any(report.get(k)!=v or type(report.get(k)) is not type(v) for k,v in a['canonical_dispatch_ref'].items()) or any(report.get(k) is not None and not isinstance(report.get(k),str) for k in bd.REPORT_METADATA):raise RecoveryError('report_receipt_binding')
    for aid,a in box.attempts.items():
        reports=[r for r in box.reports.values() if r['attempt_id']==aid]
        if (a['confirmed_started']!=any(r['outcome'] in ('audible_started','audible_completed','audible_interrupted') for r in reports)
                or a['confirmed_completed']!=any(r['outcome']=='audible_completed' for r in reports)
                or a['confirmed_interrupted']!=any(r['outcome']=='audible_interrupted' for r in reports)):raise RecoveryError('report_started_fact')
        if (a['status'] in ('audible_started','audible_completed','audible_interrupted') and not a['confirmed_started']
                or a['status']=='audible_completed' and not a['confirmed_completed']
                or a['status']=='audible_interrupted' and not a['confirmed_interrupted']
                or a.get('confirmed_not_started') and not any(r['outcome'] in bd.CONFIRMED_DROP for r in reports)):raise RecoveryError('report_status_fact')
    visit=d['visit'];boundary=d['boundary'];origins=d['origins']
    if not isinstance(visit,dict) or set(visit)!={'entry','plan_reference','penalty','race_instance_id','session_num'}:raise RecoveryError('visit_domain')
    if visit['entry'] is not None and (not isinstance(visit['entry'],pe.PitBoundaryFact) or (visit['race_instance_id'],visit['session_num'])!=(race,sn) or not isinstance(visit['penalty'],dict)):raise RecoveryError('visit_reference')
    if visit['plan_reference'] is not None and (not isinstance(visit['plan_reference'],pe.FrozenPlanReference) or visit['plan_reference'].session_num!=sn or not integer(visit['plan_reference'].session_num) or visit['plan_reference'].decision_id not in s.plan_records):raise RecoveryError('visit_frozen_reference')
    if visit['plan_reference'] is not None:
        r=s.plan_records[visit['plan_reference'].decision_id]
        if any(getattr(visit['plan_reference'],k)!=getattr(r,k) for k in ('selected_plan','target_lap','evidence_snapshot_id')):raise RecoveryError('visit_frozen_content')
    if visit['penalty'] is not None:
        ps=visit['penalty']
        if not isinstance(ps,dict) or set(ps)!={'saw_true','saw_unknown','saw_false','true_evidence','false_evidence','unknown_evidence'} or any(type(ps[k]) is not bool for k in ('saw_true','saw_unknown','saw_false')):raise RecoveryError('visit_penalty_domain')
        for k in ('true','false','unknown'):
            e=ps[k+'_evidence']
            if ps['saw_'+k] and (not isinstance(e,dict) or e.get('state')!=k):raise RecoveryError('visit_penalty_reference')
    if visit['entry'] is None and any(visit[k] is not None for k in ('plan_reference','penalty','race_instance_id','session_num')):raise RecoveryError('visit_partial')
    boundary_facts=[visit['entry']] if visit['entry'] is not None else []
    for event in pit.values():
        boundary_facts.extend((event.entry,event.exit))
        if any(getattr(event.service,k) is not None and (not finite(getattr(event.service,k)) or getattr(event.service,k)<0) for k in ('fuel_added_l','lane_total_s','stall_s','repair_s')):raise RecoveryError('pit_service_scalar')
    for fact in boundary_facts:
            if any(getattr(fact,k) is not None and not integer(getattr(fact,k)) for k in ('lap','source_frame_sequence','class_position')) or any(getattr(fact,k) is not None and (not finite(getattr(fact,k)) or getattr(fact,k)<0) for k in ('session_time_s','fuel_l')):raise RecoveryError('pit_boundary_scalar')
            if fact.lap_dist_pct is not None and (not finite(fact.lap_dist_pct) or not 0<=fact.lap_dist_pct<=1):raise RecoveryError('pit_boundary_position')
    if not isinstance(boundary,dict) or set(boundary)!={'source_frame_sequence','session_time_s','on_pit_road','on_track','gap_unknown'} or type(boundary['gap_unknown']) is not bool or not integer(boundary['source_frame_sequence']) or not finite(boundary['session_time_s']) or boundary['session_time_s']<0 or any(boundary[k] is not None and type(boundary[k]) is not bool for k in ('on_pit_road','on_track')):raise RecoveryError('raw_boundary')
    if not isinstance(origins,dict) or set(origins)!={'records','events','origin_epoch'} or any(not isinstance(origins[k],dict) for k in ('records','events')) or not isinstance(origins['origin_epoch'],str) or not origins['origin_epoch']:raise RecoveryError('origin_domain')
    if set(origins['records'])!=set(s.plan_records) or set(origins['events'])!=set(pit) or any(not isinstance(v,str) or not v for v in origins['events'].values()):raise RecoveryError('origin_references')
    for rid,ref in origins['records'].items():
        if not isinstance(ref,dict) or set(ref)!={'bridge_process_epoch','revision'} or not isinstance(ref['bridge_process_epoch'],str) or not ref['bridge_process_epoch'] or not integer(ref['revision']) or ref['revision']>s.plan_records[rid].revision:raise RecoveryError('record_origin_reference')
    if not isinstance(d['archives'],dict):raise RecoveryError('archive_domain')
    for epoch,a in d['archives'].items():
        if not isinstance(epoch,str) or not epoch or not isinstance(a,dict) or set(a)!={'commands','box'}:raise RecoveryError('archive_schema')
        shadow=dict(d,commands=a['commands'],box=a['box'],archives={})
        validate_domains(shadow,scope,check_constraint_receipts=False)
        if any(ack.get('bridge_process_epoch')!=epoch for ack in a['commands'].acknowledgements.values()):raise RecoveryError('archive_epoch')
        if any(attempt['canonical_dispatch_ref']['bridge_process_epoch']!=epoch for attempt in a['box'].attempts.values()):raise RecoveryError('archive_epoch')
    ledgers=[commands]+[a['commands'] for a in d['archives'].values()]
    for r in s.plan_records.values():
        c=r.plan_basis.get('driver_target_constraint') if isinstance(r.plan_basis,Mapping) else None
        if c is None:continue
        if c['target_lap']!=r.target_lap:raise RecoveryError('constraint_record_target')
        found=False
        for ledger in ledgers:
            content=ledger.commands.get(c['command_id']);ack=ledger.acknowledgements.get(c['command_id'])
            if content is None or not isinstance(ack,Mapping):continue
            cmd=json.loads(content)
            if (cmd['intent']=='amend' and cmd['requested_target_lap']==c['target_lap'] and cmd['expected_decision_id']==c['predecessor_decision_id'] and cmd['expected_revision']==c['predecessor_revision'] and cmd['expected_activation_source_frame_sequence']==c['predecessor_activation_frame'] and cmd['driver_pit_sequence']==c['driver_pit_sequence'] and ack['outcome']=='applied' and ack.get('constraint_id')==c['constraint_id'] and cmd['source_frame_sequence']==c['source_frame_sequence']):found=True
        # Archive validation runs against a shadow current ledger; source
        # receipts may belong to a sibling archive. The complete owner check
        # is performed on the outer bundle below.
        if not found and check_constraint_receipts:raise RecoveryError('constraint_command_reference')
    if not isinstance(d['scope_archives'],dict):raise RecoveryError('scope_archive_domain')
    for key,a in d['scope_archives'].items():
        if not isinstance(a,dict) or set(a)!={'scope','process_epoch','revision','domains'} or not isinstance(a['process_epoch'],str) or not a['process_epoch'] or not integer(a['revision']) or not isinstance(a['scope'],dict):raise RecoveryError('scope_archive_schema')
        sc=a['scope']
        if not valid_scope(sc,a['process_epoch']) or key!=scope_archive_key(sc,a['process_epoch'],a['revision']):raise RecoveryError('scope_archive_binding')
        if not isinstance(a['domains'],dict) or set(a['domains'])!=DOMAINS-{'scope_archives'}:raise RecoveryError('scope_archive_domains')
        validate_domains(dict(a['domains'],scope_archives={}),sc)
    return d

class Store:
    def __init__(self,path):
        self.path=path;self.revision=0;self.digest=None;self.loaded=None
        self._commit_lock=threading.Lock()
        self.metrics={'writes':0,'bytes':0,'failures':0,'write_ms':0.0};self.error=None
        try:
            if os.path.isfile(path):self.loaded=self.read();self.revision=self.loaded['revision'];self.digest=self.loaded['digest']
        except (OSError,RecoveryError,ValueError,TypeError,RecursionError) as e:self.error='checkpoint_unreadable:'+str(e)
    def read(self):
        with open(self.path,'rb') as f:raw=f.read(MAX_BYTES+1)
        if len(raw)>MAX_BYTES:raise RecoveryError('checkpoint_capacity')
        try:w=json.loads(raw,object_pairs_hook=strict_pairs,parse_constant=lambda x:(_ for _ in ()).throw(RecoveryError('non_finite')))
        except (ValueError,UnicodeDecodeError) as e:raise RecoveryError('checkpoint_json') from e
        if not isinstance(w,dict) or set(w)!={'schema_version','checkpoint_id','revision','scope','process_epoch','domains','digest'} or w['schema_version']!=VERSION or type(w['schema_version']) is not int or not integer(w['revision']) or w['revision']<1 or not isinstance(w['process_epoch'],str) or not w['process_epoch']:raise RecoveryError('checkpoint_schema')
        if not isinstance(w['digest'],str) or len(w['digest'])!=64 or any(c not in '0123456789abcdef' for c in w['digest']):raise RecoveryError('checkpoint_digest_schema')
        body={k:v for k,v in w.items() if k!='digest'}
        if hashlib.sha256(canonical(body).encode()).hexdigest()!=w['digest']:raise RecoveryError('checkpoint_digest')
        if w['checkpoint_id']!=w['process_epoch']+':checkpoint:'+str(w['revision']):raise RecoveryError('checkpoint_id')
        scope=w['scope']
        if not valid_scope(scope,w['process_epoch']):raise RecoveryError('unstable_scope')
        domains,legacy_migrated=migrate_legacy_domains(unpack(w['domains']))
        w['decoded']=validate_domains(domains,scope);w['legacy_migrated']=legacy_migrated;return w
    def commit(self,scope,epoch,domains):
        start=time.monotonic();path=None;lock_fd=None
        if not self._commit_lock.acquire(blocking=False):raise RecoveryError('checkpoint_writer_busy')
        try:
            os.makedirs(os.path.dirname(self.path),exist_ok=True)
            lock_fd=os.open(self.path+'.lock',os.O_CREAT|os.O_RDWR,0o600)
            if os.name=='nt':
                import msvcrt
                if os.fstat(lock_fd).st_size==0:os.write(lock_fd,b'0')
                os.lseek(lock_fd,0,os.SEEK_SET);msvcrt.locking(lock_fd,msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            # Atomic replace prevents torn writes; this expected-version check
            # also prevents a second Bridge owner overwriting a newer bundle.
            existing=self.read() if os.path.exists(self.path) else None
            if (existing is None)!=(self.digest is None) or existing and (existing['revision']!=self.revision or existing['digest']!=self.digest):raise RecoveryError('checkpoint_writer_collision')
            if not isinstance(epoch,str) or not epoch:raise RecoveryError('checkpoint_epoch')
            if not valid_scope(scope,epoch):raise RecoveryError('checkpoint_custody_epoch')
            encoded=pack(domains);decoded=unpack(encoded);validate_domains(decoded,scope)
            body={'schema_version':VERSION,'checkpoint_id':epoch+':checkpoint:'+str(self.revision+1),'revision':self.revision+1,'scope':scope,'process_epoch':epoch,'domains':encoded}
            digest=hashlib.sha256(canonical(body).encode()).hexdigest();raw=canonical(dict(body,digest=digest)).encode()
            if len(raw)>MAX_BYTES:raise RecoveryError('checkpoint_capacity')
            fd,path=tempfile.mkstemp(prefix='.recovery-',dir=os.path.dirname(self.path))
            with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
            os.replace(path,self.path);path=None
            if os.name!='nt':
                fd=os.open(os.path.dirname(self.path),os.O_RDONLY)
                try:os.fsync(fd)
                finally:os.close(fd)
            self.revision+=1;self.digest=digest;self.metrics['writes']+=1;self.metrics['bytes']+=len(raw);self.metrics['write_ms']+=1000*(time.monotonic()-start)
            self.loaded=dict(body,digest=digest,decoded=decoded)
            return body['checkpoint_id']
        except (OSError,RecoveryError,ValueError,TypeError) as e:
            self.metrics['failures']+=1;self.error='checkpoint_commit_failed:'+str(e);raise RecoveryError(self.error) from e
        finally:
            if lock_fd is not None:os.close(lock_fd)
            self._commit_lock.release()
            if path:
                try:os.unlink(path)
                except OSError:pass

LEGACY_BOX_ATTEMPT_FLAGS=('confirmed_started','confirmed_completed','confirmed_interrupted')

def _migrate_legacy_box_attempt(a,reports_by_attempt):
    """WO015 legacy checkpoint compat: a VERSION1 checkpoint written before
    these confirmation flags existed on a box attempt is missing one or more
    of them entirely (not `False` -- absent). Rejecting the whole bundle on
    that alone throws away everything else in it. Derive the missing flag(s)
    from the SAME report evidence `validate_domains()` itself cross-checks
    (lines below) -- this never fabricates a completion/interruption that
    the historical reports do not already contain, and the derived value is
    therefore guaranteed consistent with that cross-check. `restored_history_only`
    marks the attempt as reconstructed so no consumer treats it as a live,
    independently-reconfirmed attempt (same flag `restore_box()` already uses
    for restart continuity)."""
    missing=[k for k in LEGACY_BOX_ATTEMPT_FLAGS if k not in a]
    if not missing:return a,False
    a=dict(a);reports=reports_by_attempt.get(a.get('attempt_id'),())
    if 'confirmed_started' in missing:
        a['confirmed_started']=any(r.get('outcome') in ('audible_started','audible_completed','audible_interrupted') for r in reports)
    if 'confirmed_completed' in missing:
        a['confirmed_completed']=any(r.get('outcome')=='audible_completed' for r in reports)
    if 'confirmed_interrupted' in missing:
        a['confirmed_interrupted']=any(r.get('outcome')=='audible_interrupted' for r in reports)
    a['restored_history_only']=True
    return a,True

def _migrate_legacy_box_report(r):
    """WO015 legacy checkpoint compat: a VERSION1 checkpoint written before
    utterance_id/text_hash existed on a box delivery report is missing one or
    both keys entirely. `None` is the explicitly-legacy honest value here --
    the same value a report that genuinely fired before the renderer attached
    an utterance already uses -- never a fabricated/invented identifier."""
    missing=[k for k in bd.REPORT_METADATA if k not in r]
    if not missing:return r,False
    r=dict(r)
    for k in missing:r[k]=None
    return r,True

def _migrate_legacy_box_ledger(box):
    if not isinstance(box,bd.BoxLedger):return box,False
    reports_by_attempt={}
    for r in box.reports.values():
        reports_by_attempt.setdefault(r.get('attempt_id'),[]).append(r)
    attempts={};changed=False
    for aid,a in box.attempts.items():
        migrated,did=_migrate_legacy_box_attempt(pl._deep_thaw(a),reports_by_attempt)
        attempts[aid]=migrated;changed=changed or did
    reports={};report_changed=False
    for rid,r in box.reports.items():
        migrated,did=_migrate_legacy_box_report(pl._deep_thaw(r))
        reports[rid]=migrated;report_changed=report_changed or did
    if not changed and not report_changed:return box,False
    return bd.BoxLedger(attempts,reports if report_changed else box.reports,box.sequence),True

def migrate_legacy_domains(d):
    """Apply `_migrate_legacy_box_ledger()` to every `box` domain reachable
    from a loaded checkpoint bundle -- the top-level domain, every per-epoch
    archive, and every scope archive's nested domains -- so a pre-WO015
    bundle migrates uniformly instead of only at the top level."""
    if not isinstance(d,dict):return d,False
    out=dict(d);changed=False
    if 'box' in out:
        out['box'],m=_migrate_legacy_box_ledger(out['box']);changed=changed or m
    if isinstance(out.get('archives'),dict):
        archives={}
        for epoch,a in out['archives'].items():
            if isinstance(a,dict) and 'box' in a:
                new_box,m=_migrate_legacy_box_ledger(a['box'])
                archives[epoch]=dict(a,box=new_box) if m else a;changed=changed or m
            else:archives[epoch]=a
        out['archives']=archives
    if isinstance(out.get('scope_archives'),dict):
        scope_archives={}
        for key,a in out['scope_archives'].items():
            if isinstance(a,dict) and isinstance(a.get('domains'),dict):
                inner,m=migrate_legacy_domains(a['domains'])
                scope_archives[key]=dict(a,domains=inner) if m else a;changed=changed or m
            else:scope_archives[key]=a
        out['scope_archives']=scope_archives
    return out,changed

def invalidate_restored(state,reason='restart_continuity_unverified'):
    working=state
    for rid,r in state.plan_records.items():
        if r.phase in pl.NON_TERMINAL_PHASES:
            updated,history=pl._bump_record(r,phase='invalidated',reason=reason,invalidated_reason=reason)
            working=pl._store_record(working,updated,history,clear_active=True)
    return working

def restore_box(ledger):
    attempts={}
    for aid,a in ledger.attempts.items():
        a=pl._deep_thaw(a);a['restored_history_only']=True
        if a['status'] in ('created','dispatched','audible_started'):a['status']='delivery_unknown';a['history'].append({'status':'delivery_unknown','reason':'restart_continuity_unverified'})
        attempts[aid]=a
    return bd.BoxLedger(attempts,ledger.reports,ledger.sequence)
