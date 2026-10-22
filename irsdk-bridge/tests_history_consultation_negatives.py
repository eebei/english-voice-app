"""Short real Bridge + all Renderer negative variants of the history entry."""
import json
import os
import traceback
from pathlib import Path
from unittest.mock import patch
import tests_history_consultation_e2e as core
import tests_wo019_road_atlanta_e2e as h
import durable_recovery as recovery

CASES=('ack_retry','delete_bare','delete_delayed','correct_delayed','current_sample','worsening','faster_pace','sdk_gap','driver_change','commit_failed')


def running(count=55,rate=3.68,pace=115):
    return [h.rh.make_frame(SessionTime=100+i,SessionTimeRemain=1140-i,SessionLapsTotal=32767,SessionLapsRemain=32767,
      Lap=1+i//pace,LapDistPct=.005+(i%pace)/pace,FuelLevel=19-rate*i/pace,
      LapLastLapTime=pace+(i//pace-1)*.01 if i>=pace else 0,CarIdxLapCompleted=[i//pace,0,0]) for i in range(count)]


def mutate(t,operation):
    rows=t.desktop.send('call',fn='loadRaceHistory',nowMs=t.now_ms())['value']
    target=next(r for r in rows if str(r.get('race_instance_id','')).startswith('sub:personal-history-'))
    changed=[dict(r,avgFuelPerLap=4.1) if r['raceRecordId']==target['raceRecordId'] else r for r in rows]
    if operation=='delete':changed=[r for r in rows if r['raceRecordId']!=target['raceRecordId']]
    t.desktop.send('history_store_write',key='pw_raceHistory',value=json.dumps(changed),nowMs=t.now_ms())
    t.notes['storage_changed_frame']=t.cursor


def run_case(case):
    def pre(t,cursor,frame,result):
        if case=='ack_retry' and cursor<17:
            t.wire.barrier()
            t.ws.sent[:]=[raw for raw in t.ws.sent if json.loads(raw).get('type')!='fuel_reference_ack']
        if case=='sdk_gap' and 25<=cursor<32:frame['_inactive']=True
        if case=='driver_change' and cursor>=25:
            h.bridge.reader.session_info=core.INFO.replace('UserID: 10101','UserID: 20202')
        return False
    def monitor(t,cursor,frame,result):
        obs=t.observe();p=obs.get('strategyState',{}).get('pending_proposal')
        complete=[u for u in obs.get('utterances',[]) if u.get('kind')=='bridge_strategy_proposal' and 'completed' in u.get('states',[])]
        if case=='ack_retry' and cursor==12:
            original=next(x['raw'] for x in t.to_bridge if json.loads(x['raw']).get('cmd')=='fuel_reference_request')
            t.ws.push([original]);t.notes['late_exact_retry_frame']=cursor
        if not t.notes.get('acted') and p and complete and (case!='ack_retry' or cursor>=20):
            t.notes.update(acted=True,proposal_id=p['decision_id'],proposal_lap=p['lap'])
            if case=='delete_bare':mutate(t,'delete');t.say('はい','bare_after_delete')
            elif case in ('delete_delayed','correct_delayed'):
                t.say_start('その案で行こう。給油24リッターね。','held_consent',
                  '確定、登録済み。\n<<PW_JUDGE decision_id="'+p['decision_id']+'" classification="confirm">>')
                t.notes['held_frame']=cursor
            else:t.say('はい','consent')
        if case in ('delete_delayed','correct_delayed') and t.notes.get('held_frame') is not None and cursor==t.notes['held_frame']+2:
            mutate(t,'delete' if case=='delete_delayed' else 'correct');t.say_finish('held_consent')
        return False
    t=h.Thread(core.ROOT,pre_steps=[pre],steps=[h.at(1,core.seed),h.at(2,lambda t,f:t.say('燃料は最後まで持つ？何リッター給油すればいい？','fuel_question')),monitor])
    count=240 if case=='faster_pace' else 350 if case in ('worsening','sdk_gap','driver_change') else 275 if case=='current_sample' else 55
    frames=running(count,4.2 if case=='worsening' else 3.68,90 if case=='faster_pace' else 115)
    original=recovery.Store.commit
    def commit(store,scope,epoch,domains):
        if case=='commit_failed' and domains['state'] is not None and domains['state'].plan_records:
            raise recovery.RecoveryError('injected_history_disk_failure')
        return original(store,scope,epoch,domains)
    error=None
    try:
        with patch.object(recovery.Store,'commit',commit):t.run(frames,core.INFO)
    except Exception:error=traceback.format_exc()
    finally:
        raw=list(getattr(t.result,'broadcasts',[]) or []);logs=list(getattr(t.result,'logs',[]) or []);obs=t.observe(observability=True,apiBodies=True,keys=['pw_fuel_history'])
        active=[b['lifecycle']['active'] for b in raw if b.get('type')=='canonical_lifecycle_snapshot' and b['lifecycle']['active']]
        accepted=[b for b in raw if b.get('type')=='strategy_decision_ack' and b.get('outcome')=='accepted']
        boxes=[b for b in raw if b.get('trigger')=='strategy_plan_box_call']
        props=[u for u in obs['utterances'] if u.get('kind')=='bridge_strategy_proposal' and 'completed' in u.get('states',[])]
        requests=[json.loads(x['raw']) for x in t.to_bridge if json.loads(x['raw']).get('cmd')=='fuel_reference_request']
        checks={'entry_requested':any(r.get('mode')=='propose' for r in requests),'no_exception':not error,'no_premature_success':not any('登録済み' in u.get('text','') for u in obs['utterances'])}
        if case=='ack_retry':
            registered=[b for b in raw if b.get('type')=='fuel_reference_ack' and b.get('outcome')=='registered']
            checks.update(late_exact_retry=t.notes.get('late_exact_retry_frame')==12,one_native_id=len({b['decision_id'] for b in registered})==1,
              one_proposal_audio=len(props)==1,one_acceptance=len(accepted)==1,one_active=len({r['decision_id'] for r in active})==1)
        elif case in ('delete_bare','delete_delayed','correct_delayed'):
            checks.update(consent_blocked=not accepted and not active,invalidation_sent=any(r.get('mode')=='invalidate' for r in requests),
              native_cancelled=any(b.get('type')=='fuel_reference_ack' and b.get('outcome')=='cancelled' for b in raw),no_box=not boxes)
        elif case=='current_sample':
            checks.update(accepted=bool(accepted),same_active=bool(active) and active[-1]['decision_id']==t.notes.get('proposal_id'),
              no_unrelated_invalidation=not any(r.get('mode')=='invalidate' for r in requests),
              actual_current_sample=any(r.get('race_instance_id')==active[-1]['race_instance_id'] and r.get('fuelSampleCount',0)>0
                and abs(r.get('avgFuelPerLap',0)-3.68)<.01 for r in json.loads(obs['storage'].get('pw_fuel_history') or '[]')) if active else False)
        elif case=='worsening':
            candidates=[r for b in raw if b.get('type')=='canonical_lifecycle_snapshot' for r in b['lifecycle']['awaiting']]
            checks.update(original_setting_frozen=bool(active) and all(r['set_fuel_l']==24 for r in active),
              new_candidate_requires_consent=any(r['set_fuel_l']>24 and r['decision_id']!=t.notes.get('proposal_id')
                and abs((r.get('provisional_history') or {}).get('planning_rate_l_per_lap',0)-4.2)<.01 for r in candidates),
              no_silent_activation=len({r['decision_id'] for r in active})==1,no_old_box=not boxes)
        elif case=='faster_pace':
            candidates=[r for b in raw if b.get('type')=='canonical_lifecycle_snapshot' for r in b['lifecycle']['awaiting']]
            checks.update(original_setting_frozen=bool(active) and all(r['set_fuel_l']==24 for r in active),
              faster_candidate_requires_consent=any(r['set_fuel_l']>=35 and r['decision_id']!=t.notes.get('proposal_id')
                and abs((r.get('provisional_history') or {}).get('planning_pace_s',0)-90)<.02 for r in candidates),
              no_silent_activation=len({r['decision_id'] for r in active})==1,no_old_box=not boxes)
        elif case in ('sdk_gap','driver_change'):
            checks.update(original_accepted=bool(accepted),old_box_denied=not any(b.get('decision_id')==t.notes.get('proposal_id') for b in boxes))
        elif case=='commit_failed':checks.update(no_registered_ack=not any(b.get('type')=='fuel_reference_ack' and b.get('outcome')=='registered' for b in raw),no_active=not active,no_box=not boxes)
        out={'case':case,'checks':checks,'error':error,'notes':t.notes,'raw_broadcasts':raw,'logs':logs,'desktop':obs,'provider_requests':t.desktop.llm_requests()}
        t.close()
    return out


def main():
    cases=os.environ.get('HISTORY_NEGATIVE_CASES',','.join(CASES)).split(',')
    results=[run_case(case) for case in cases]
    dest=Path(os.environ.get('HISTORY_NEGATIVE_OUTPUT','/tmp/history-consultation-negatives.json'))
    dest.parent.mkdir(parents=True,exist_ok=True)
    dest.write_text(json.dumps(results,ensure_ascii=False,indent=2,default=str))
    print(json.dumps({'results':[{'case':x['case'],'checks':x['checks'],'error':x['error']} for x in results],'output':str(dest)},ensure_ascii=False,indent=2))
    return 0 if all(all(x['checks'].values()) for x in results) else 1

if __name__=='__main__':raise SystemExit(main())
