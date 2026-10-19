"""WO-008 immutable BOX attempt identities/history, independently of Plan phases."""
from dataclasses import dataclass, replace
from collections.abc import Mapping
import plan_lifecycle as pl
import fixed_target_authority as fa

TTL_SECONDS=5.0
MAX_ATTEMPTS=3
RETRY_GAP_SECONDS=1.0
BINDINGS=('attempt_id','proof_id','race_instance_id','session_num','decision_id','plan_revision',
          'activation_frame','driver_pit_sequence','dispatch_sequence')
REPORT_OUTCOMES=frozenset(('audible_started','audible_completed','audible_interrupted','dropped_before_audible','suppressed_by_user','expired','revoked'))
CONFIRMED_DROP=frozenset(('dropped_before_audible','suppressed_by_user'))
# WO015: renderer-supplied trace identity (desktop/box-authority-transport.js
# attachUtterance), attached AFTER the attempt/proof are already issued. Not
# part of BINDINGS (identity never depends on them); None is the honest value
# for a report that fired before the renderer ever queued speech for this
# attempt (e.g. a synchronous dropped_before_audible from an already-invalid
# proof). Carried through the ack and the persisted report so the owner
# receipt is traceable back to an actual spoken utterance, not invented.
REPORT_METADATA=('utterance_id','text_hash')

@dataclass(frozen=True)
class BoxLedger:
    attempts: Mapping
    reports: Mapping
    sequence: int=0
    def __post_init__(self):
        object.__setattr__(self,'attempts',pl._deep_freeze(self.attempts))
        object.__setattr__(self,'reports',pl._deep_freeze(self.reports))


def new_ledger():return BoxLedger({}, {})

def _put(ledger,attempt):
    records=dict(ledger.attempts);records[attempt['attempt_id']]=attempt
    return replace(ledger,attempts=records)


def _transition(ledger,record,status,now,reason):
    r=pl._deep_thaw(record);r['status']=status
    r['history'].append({'status':status,'session_time_s':now,'reason':reason})
    return _put(ledger,r)


def bind_dispatch_ref(ledger,attempt_id,refs):
    attempt=ledger.attempts.get(attempt_id)
    if attempt is None or attempt.get('canonical_dispatch_ref') is not None:return ledger
    r=pl._deep_thaw(attempt);r['canonical_dispatch_ref']=dict(refs)
    return _put(ledger,r)

def _metadata_valid(report):
    return all(report.get(k) is None or isinstance(report.get(k),str) for k in REPORT_METADATA)

def apply_report(ledger,report):
    report=report if isinstance(report,dict) else {}
    ack={k:report.get(k) for k in BINDINGS}
    ack.update(type='box_delivery_ack',report_event_id=report.get('report_event_id'),outcome=report.get('outcome'),applied='rejected',
               **{k:report.get(k) for k in REPORT_METADATA})
    rid=report.get('report_event_id');aid=report.get('attempt_id')
    if not isinstance(aid,str) or not aid:return ledger,ack
    if not _metadata_valid(report):return ledger,ack
    attempt=ledger.attempts.get(aid)
    if (not isinstance(rid,str) or not rid or report.get('outcome') not in REPORT_OUTCOMES
            or attempt is None or any(report.get(k)!=attempt[k] or isinstance(report.get(k),bool) or type(report.get(k)) is not type(attempt[k]) for k in BINDINGS)):
        return ledger,ack
    dispatch_ref=attempt.get('canonical_dispatch_ref')
    if dispatch_ref and any(report.get(k)!=v or isinstance(report.get(k),bool) or type(report.get(k)) is not type(v) for k,v in dispatch_ref.items()):
        return ledger,ack
    content=pl._deep_freeze({k:report.get(k) for k in (*BINDINGS,'outcome',*REPORT_METADATA,*(dispatch_ref or {}))})
    if rid in ledger.reports:
        ack['applied']='retry_no_op' if ledger.reports[rid]==content else 'collision'
        return ledger,ack
    outcome=report['outcome'];r=pl._deep_thaw(attempt)
    if outcome in ('audible_started','audible_completed','audible_interrupted'):
        # Report order is not playback order. A late start/completion archives
        # actual fact, never reauthorizes a revoked attempt or starts another
        # attempt. Interruption is sticky: a late/duplicate completed report
        # never downgrades an already-confirmed interruption (WO015).
        r['confirmed_started']=True
        if outcome=='audible_completed':r['confirmed_completed']=True
        if outcome=='audible_interrupted':r['confirmed_interrupted']=True
        if r['status'] in ('created','dispatched','audible_started','audible_completed'):
            r['status']=('audible_interrupted' if r.get('confirmed_interrupted')
                         else 'audible_completed' if r.get('confirmed_completed')
                         else 'audible_started')
        r['history'].append({'status':outcome,'reason':'reported_actual_result',
                              'late':r['status'] not in ('audible_started','audible_completed','audible_interrupted')})
    elif not r.get('confirmed_started'):
        # A matching actual pre-audible drop is evidence, even after authority
        # revoked the old attempt. Keep its terminal status; only a NEW fresh
        # proof/attempt can use this evidence as bounded retry eligibility.
        if outcome in CONFIRMED_DROP:
            r['confirmed_not_started']=True
        if r['status'] in ('created','dispatched') or outcome in CONFIRMED_DROP and r['status']=='delivery_unknown':
            r['status']=outcome
        r['history'].append({'status':outcome,'reason':'reported_not_started'})
    reports=dict(ledger.reports);reports[rid]=content
    ledger=replace(_put(ledger,r),reports=reports);ack['applied']='applied'
    return ledger,ack


def advance(ledger,record,inputs,*,execution_gate=None,on_track=False):
    """Every poll, BEFORE radio. Returns new ledger, coherent snapshot, candidate.
    Expiry is delivery_unknown after dispatch: lack of a report is not proof
    that playback never started, so it cannot authorize a retry.
    """
    now=inputs.get('session_time_s');frame=inputs.get('source_frame_sequence')
    reason=execution_gate
    if record is None:reason=reason or 'no_active_plan'
    elif record.phase!='active':reason=reason or 'non_active_plan'
    elif inputs.get('race_instance_id')!=record.race_instance_id or inputs.get('session_num')!=record.session_num:reason=reason or 'scope_mismatch'
    elif not on_track:reason=reason or 'not_on_track'
    elif inputs.get('driver_pit_sequence')!=record.expected_pit_sequence-1:reason=reason or 'pit_sequence_mismatch'
    verdict=fa.evaluate(inputs,record.target_lap,frozen_set=record.set_fuel_l) if record and not reason else {'available':False,'reason':reason}
    if not verdict.get('available'):reason=reason or verdict.get('reason')
    if record and not reason and inputs['current_lap']!=record.target_lap:reason='outside_target_window'
    same=[r for r in ledger.attempts.values() if record and r['decision_id']==record.decision_id
          and r['race_instance_id']==record.race_instance_id and r['session_num']==record.session_num]
    key=fa.material_key(record,inputs) if record else None
    allowed=None
    for old in list(ledger.attempts.values()):
        if old['status'] not in ('created','dispatched','audible_started'):continue
        identity_match=record and old['decision_id']==record.decision_id and old['material_key']==key
        expired=not fa.finite(now) or now<old['issued_session_time'] or now-old['issued_session_time']>=TTL_SECONDS
        if not identity_match or reason or expired:
            status='delivery_unknown' if old['status']=='dispatched' and expired and not reason and identity_match else 'revoked'
            ledger=_transition(ledger,old,status,now,reason or ('proof_expired' if expired else 'material_or_identity_changed'))
        elif old['status'] in ('created','dispatched','audible_started'):
            allowed=ledger.attempts[old['attempt_id']]
    same=[r for r in ledger.attempts.values() if record and r['decision_id']==record.decision_id
          and r['race_instance_id']==record.race_instance_id and r['session_num']==record.session_num]
    candidate=None
    if not reason and allowed is None and not any(r.get('confirmed_started') for r in same):
        latest=same[-1] if same else None
        can_retry=latest is None or ((latest['status'] in CONFIRMED_DROP or latest.get('confirmed_not_started')) and fa.finite(now)
                                     and now-latest['issued_session_time']>=RETRY_GAP_SECONDS and len(same)<MAX_ATTEMPTS)
        if can_retry:
            proof=fa.issue_proof(record,inputs,verdict).serialize()
            sequence=ledger.sequence+1
            attempt={k:proof[k] for k in ('proof_id','race_instance_id','session_num','decision_id','plan_revision','activation_frame','driver_pit_sequence')}
            attempt.update(attempt_id='box-attempt:%s:%s'%(proof['proof_id'],sequence),dispatch_sequence=sequence,
                           status='created',history=[{'status':'created','session_time_s':now}],
                           confirmed_started=False,confirmed_completed=False,confirmed_interrupted=False,
                           issued_session_time=now,material_key=key,authority_proof=proof)
            ledger=replace(_put(ledger,attempt),sequence=sequence);allowed=ledger.attempts[attempt['attempt_id']]
            candidate={'type':'radio','trigger':'strategy_plan_box_call','selected_plan':record.selected_plan,
                       'decision_id':record.decision_id,'authority_proof':proof,
                       'box_attempt':{k:attempt[k] for k in BINDINGS},
                       'message':'Box this lap. Set %s liters.'%record.set_fuel_l}
    snapshot=dict(type='box_authority_snapshot',schema_version=1,
                  race_instance_id=inputs.get('race_instance_id'),session_num=inputs.get('session_num'),
                  source_frame_sequence=frame,session_time_s=now,
                  active_decision_id=record.decision_id if record else None,active_phase=record.phase if record else None,
                  plan_revision=record.revision if record else None,
                  activation_frame=record.activated_source_frame_sequence if record else None,
                  driver_pit_sequence=inputs.get('driver_pit_sequence'),current_lap=inputs.get('current_lap'),
                  execution_gate=reason,closed=execution_gate=='scope_closed',collision=execution_gate=='pit_event_collision',
                  allowed_proof_id=allowed['proof_id'] if allowed and not reason else None,
                  allowed_attempt_id=allowed['attempt_id'] if allowed and not reason else None,
                  valid_until_session_s=allowed['issued_session_time']+TTL_SECONDS if allowed and not reason else None)
    return ledger,snapshot,candidate


def mark_dispatch(ledger,attempt_id,outcome):
    r=ledger.attempts[attempt_id]
    # HELD may be sent by Bridge flush later. Conservative unknown delivery;
    # never automatically send a second candidate while the first may play.
    status='dispatched' if outcome in (True,'DISPATCHED','HELD') else 'dropped_before_audible'
    return _transition(ledger,r,status,r['issued_session_time'],'bridge_dispatch_'+str(outcome))


def audible_for(ledger,decision_id):
    return any(r['decision_id']==decision_id and r.get('confirmed_started') for r in ledger.attempts.values())


def completed_for(ledger,decision_id):
    # WO015: distinct from audible_for (started). True only once a report has
    # confirmed the delivery ran to a normal end, never on start/ACK alone.
    return any(r['decision_id']==decision_id and r.get('confirmed_completed') for r in ledger.attempts.values())
