"""WO-008: deterministic coupled fuel prediction; no recommendation fallback."""
import math, hashlib, json
from collections.abc import Mapping
from dataclasses import dataclass
import plan_lifecycle as pl


def finite(x):
    return isinstance(x,(int,float)) and not isinstance(x,bool) and math.isfinite(x)


def integer(x):
    return isinstance(x,int) and not isinstance(x,bool)


def build_inputs(*, race_instance_id, session_num, source_frame_sequence,
                 session_time_s, current_lap, total_laps, lap_dist_pct,
                 fuel_level_l, avg_fuel_per_lap_l, clean_laps_sampled,
                 effective_capacity_l, driver_pit_sequence, is_lap_race,
                 reserve_l=0.5, multi_stop=None):
    # Support is derived from this same fresh geometry, never a cached endurance flag.
    if multi_stop is None:
        known=all(finite(x) for x in (fuel_level_l,avg_fuel_per_lap_l,lap_dist_pct,reserve_l,effective_capacity_l)) and integer(current_lap) and integer(total_laps)
        multi_stop=(max(0,avg_fuel_per_lap_l*(total_laps-current_lap+1-lap_dist_pct)+reserve_l-fuel_level_l)>effective_capacity_l) if known else None
    return dict(schema_version=1,race_instance_id=race_instance_id,session_num=session_num,
                source_frame_sequence=source_frame_sequence,session_time_s=session_time_s,
                current_lap=current_lap,total_laps=total_laps,lap_dist_pct=lap_dist_pct,
                crossings_to_finish=(total_laps-current_lap+1 if integer(total_laps) and integer(current_lap) else None),
                finish_kind='lap_race' if is_lap_race is True else 'unsupported_format',
                fuel_level_l=fuel_level_l,avg_fuel_per_lap_l=avg_fuel_per_lap_l,
                clean_laps_sampled=clean_laps_sampled,reserve_l=reserve_l,
                effective_capacity_l=effective_capacity_l,
                max_set_fuel_l=math.floor(effective_capacity_l) if finite(effective_capacity_l) and effective_capacity_l>0 else None,
                driver_pit_sequence=driver_pit_sequence,multi_stop=multi_stop)


def evaluate(inputs,target,*,frozen_set=None):
    i=inputs if isinstance(inputs,Mapping) else {}
    def fail(reason):return {'available':False,'reason':reason}
    if i.get('finish_kind')!='lap_race':return fail('unsupported_finish_authority')
    if i.get('multi_stop') is not False:return fail('unsupported_multi_stop' if i.get('multi_stop') is True else 'unknown_single_stop_authority')
    if not isinstance(i.get('race_instance_id'),str) or not i['race_instance_id'] or not all(integer(i.get(k)) and i[k]>=0 for k in ('session_num','source_frame_sequence','driver_pit_sequence')) or not finite(i.get('session_time_s')) or i['session_time_s']<0:return fail('invalid_scope_frame_authority')
    L,N,C=i.get('current_lap'),i.get('total_laps'),i.get('crossings_to_finish')
    if not all(integer(x) for x in (L,N,C,target)) or not (1<=L<=N<3000) or C!=N-L+1:return fail('invalid_lap_authority')
    q,F,mu,r,K,M=(i.get(x) for x in ('lap_dist_pct','fuel_level_l','avg_fuel_per_lap_l','reserve_l','effective_capacity_l','max_set_fuel_l'))
    if not all(finite(x) for x in (q,F,mu,r,K)) or not(0<=q<=1 and 0<=F<=K and mu>0 and r>=0 and K>0):return fail('invalid_fuel_authority')
    if not integer(M) or not(0<=M<=math.floor(K)):return fail('invalid_service_limit')
    if not integer(i.get('clean_laps_sampled')) or i['clean_laps_sampled']<3:return fail('insufficient_clean_laps')
    d=target-L
    if frozen_set is None:
        if not 0<d<C:return fail('invalid_requested_target_lap')
    else:
        if d<0:return fail('target_overdue')
        if d>=C:return fail('target_beyond_finish')
    E=F-mu*(d+1-q);Q=mu*(C-d)+r if d>0 else mu*(C-q)+r
    W=mu*(C-q)+r; A=max(0.0,W-F)
    S=math.ceil(A) if frozen_set is None else frozen_set
    if E+1e-9<r:return fail('cannot_reach_requested_target')
    if Q>K+1e-9:return fail('target_post_stop_capacity_insufficient')
    if not integer(S) or S<0 or S>M:return fail('service_setting_limit_exceeded')
    if F+S+1e-9<W:return fail('frozen_setting_insufficient')
    return dict(available=True,reason='fixed_target_safe',target_lap=target,
                target_in_laps=d,add_fuel_l=A,set_fuel_l=S,
                entry_fuel_lower_bound_l=E,post_stop_need_upper_bound_l=Q,
                total_need_l=W,current_lap=L,crossings_to_finish=C,
                geometry_contract='coupled_current_running_lap',
                authority_inputs=pl._deep_thaw(pl._deep_freeze(i)))


def constraint(record):
    basis=record.plan_basis if record is not None else None
    return basis.get('driver_target_constraint') if isinstance(basis,Mapping) else None


def material_key(record,inputs):
    return (record.decision_id,record.revision,record.activated_source_frame_sequence,
            record.target_lap,record.add_fuel_l,record.set_fuel_l,
            tuple(inputs.get(k) for k in ('avg_fuel_per_lap_l','reserve_l','effective_capacity_l','finish_kind','total_laps')),
            (constraint(record) or {}).get('constraint_id'))


@dataclass(frozen=True)
class AuthorityProof:
    data: Mapping
    def __post_init__(self):object.__setattr__(self,'data',pl._deep_freeze(self.data))
    def serialize(self):return pl._deep_thaw(self.data)


def issue_proof(record,inputs,validation):
    payload=dict(schema_version=1,race_instance_id=record.race_instance_id,session_num=record.session_num,
                 decision_id=record.decision_id,plan_revision=record.revision,
                 activation_frame=record.activated_source_frame_sequence,
                 issued_source_frame=inputs['source_frame_sequence'],issued_session_time=inputs['session_time_s'],
                 driver_pit_sequence=inputs['driver_pit_sequence'],expected_pit_sequence=record.expected_pit_sequence,
                 selected_plan=record.selected_plan,target_lap=record.target_lap,
                 current_lap=inputs['current_lap'],add_fuel_l=record.add_fuel_l,set_fuel_l=record.set_fuel_l,
                 constraint_id=(constraint(record) or {}).get('constraint_id'),fuel_inputs=dict(inputs),
                 validation=dict(validation),validity_contract={'ttl_seconds':5.0,'window':'same_target_lap'})
    digest=hashlib.sha256(json.dumps(payload,sort_keys=True,allow_nan=False).encode()).hexdigest()[:24]
    payload['proof_id']='box-proof:'+digest
    return AuthorityProof(payload)
