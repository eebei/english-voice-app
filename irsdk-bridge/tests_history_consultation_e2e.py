"""Personal history -> native proposal -> consent -> BOX -> outcome product replay.
Real Bridge/handler, all Renderer scripts and saved semantic provider response.
"""
import json
import os
import sys
import traceback
from pathlib import Path
import tests_wo019_road_atlanta_e2e as h
import replay_harness as rh
import tests_wo001_road_atlanta_fixture as road

ROOT=str(Path(__file__).resolve().parent.parent)
INFO=road.ROAD_ATLANTA_SESSION_INFO.replace('SessionLaps: 25','SessionLaps: unlimited').replace('SessionTime: unlimited','SessionTime: 1140.000 sec')


def seed(t, _frame):
    for i, rate in enumerate((3.6,3.8)):
        summary={'type':'session_summary','race_instance_id':'sub:personal-history-'+str(i),'session_num':0,
          'cust_id':10101,'track':'road atlanta','car_model':'Mercedes-AMG GT3 2020','event_type':'Race','session_type':'Race',
          'avg_fuel_per_lap':rate,'avg_lap':115,'total_laps':10}
        t.deliver_raw([json.dumps(summary)])
    t.notes['seed_history']=t.desktop.send('call',fn='loadRaceHistory',nowMs=t.now_ms())['value']
    t.notes['seed_identity']=t.observe().get('identity')


def frames(n=345):
    running=[rh.make_frame(SessionTime=100+i,SessionTimeRemain=1140-i,SessionLapsTotal=32767,SessionLapsRemain=32767,
        Lap=1+i//115,LapDistPct=.005+(i%115)/115,FuelLevel=19-.032*i,
        LapLastLapTime=115+(i//115-1)*.01 if i>=115 else 0,CarIdxLapCompleted=[i//115,0,0]) for i in range(n)]
    if n<345:return running
    pit,fuel,at,_=road.pit_visit(lap=3,fuel_before=running[-1]['FuelLevel'],fuel_added=24,start_time=100+n)
    for frame in pit:
        frame.update(SessionTimeRemain=1240-frame['SessionTime'],SessionLapsTotal=32767,SessionLapsRemain=32767,LapLastLapTime=115,CarIdxLapCompleted=[2,0,0])
    running+=pit
    for i in range(25):
        running.append(rh.make_frame(SessionTime=at+i,SessionTimeRemain=1240-at-i,Lap=4,LapDistPct=.005+i/115,
          FuelLevel=fuel-.032*i,LapLastLapTime=115,SessionLapsTotal=32767,SessionLapsRemain=32767,CarIdxLapCompleted=[3,0,0]))
    finish=h.wo018._finish_frames(running[-1])
    for frame in finish:frame.update(SessionTimeRemain=0,SessionLapsTotal=32767,CarIdxLapCompleted=[frame['Lap']-1,0,0])
    return running+finish


def consultation(t, cursor, frame, result):
    if cursor<3:return False
    obs=t.observe(observability=True)
    p=obs.get('strategyState',{}).get('pending_proposal')
    spoken=[u for u in obs.get('utterances',[]) if u.get('kind')=='bridge_strategy_proposal' and 'completed' in u.get('states',[])]
    phase=t.notes.get('consultation_phase','first_proposal')
    if phase=='first_proposal' and p and spoken:
        t.notes['first_proposal_observation']=obs
        t.say('やっぱり3周目に変えて。','target_correction')
        t.notes['consultation_phase']='corrected_proposal'
    elif phase=='corrected_proposal' and p and p.get('lap')==3 and len(spoken)>=2:
        t.notes['corrected_proposal_observation']=obs
        t.say_start('じゃあその3周目の案で行こう。給油は24リッターね。','natural_consent',
          '確定した。3周目にBOX、給油24リッターで登録済み。\n<<PW_JUDGE decision_id="'+p['decision_id']+'" classification="confirm">>')
        t.notes['consent_started_frame']=cursor
        t.notes['consultation_phase']='judge_wait'
    elif phase=='judge_wait' and cursor>=t.notes['consent_started_frame']+2:
        t.notes['during_consent_observation']=obs
        t.say_finish('natural_consent')
        t.notes['consultation_phase']='commit_wait'
    elif phase=='commit_wait' and obs.get('strategyState',{}).get('active'):
        t.notes['active_observation']=obs
        t.notes['consultation_phase']='active'
        return True
    return False


def debrief_and_next_race(t):
    t.advance(20000)
    t.notes['pre_debrief']=t.observe()
    t.say('3周目は予定どおりじゃなかった。','debrief_correction')
    for i in range(8):
        t.advance(12000)
        review=t.observe().get('evidenceDebrief')
        if not review or not review.get('active') or review.get('index',0)>=len(review.get('questions',[])):break
        t.say(('予定より早めて安全を優先した','給油後は最後まで走れた','次回も燃費の変化を確認して相談したい')[i%3],
          'debrief_answer_'+str(i),llm='振り返りの内容を受け取った。')
    t.advance(12000)
    if t.observe().get('evidenceDebrief'):t.click('confirmEvidenceMemory','confirm_debrief')
    t.notes['saved_debrief']=t.desktop.send('call',fn='loadEvidenceRecords',nowMs=t.now_ms())['value']
    first=h.collect(t,export=False)
    first['raw_broadcasts']=list(t.result.broadcasts)
    first['bridge_logs']=list(t.result.logs)
    t.first_race_capture=first
    t.steps=[h.at(15,lambda t,f:t.say(h.NEXT_Q,'next_race_question',llm='前回は3周目で24L補給。予定外との訂正あり。'))]
    t.marks=[];t.result=None
    t.run(frames(40),INFO.replace(str(road.ROAD_ATLANTA_SUB_SESSION_ID),str(road.ROAD_ATLANTA_SUB_SESSION_ID+1)))
    t.notes['next_race_evidence_note']=t.desktop.send('call',fn='buildSessionEvidenceNote',nowMs=t.now_ms())['value']
    first['next_race']=h.collect(t,export=False)
    return first


def save(t,first=None,error=None):
    raw=first.get('raw_broadcasts',[]) if first else list(getattr(t.result,'broadcasts',[]) or [])
    logs=first.get('bridge_logs',[]) if first else list(getattr(t.result,'logs',[]) or [])
    obs=t.observe(observability=True,apiBodies=True,console=400)
    proposals=[b for b in raw if b.get('trigger')=='strategy_plan_proposal']
    acks=[b for b in raw if b.get('type')=='fuel_reference_ack']
    speech=obs.get('utterances',[])
    saved=t.notes.get('saved_debrief',[])
    linked_actual=any(p.get('phase')=='executed' and p.get('set_fuel_l')==24
      and (p.get('provisional_history') or {}).get('record_count')==2
      and any(e.get('pit_event_id')==p.get('pit_event_id') and e.get('fuel_added_l')==24
        and (e.get('plan_ref') or {}).get('decision_id')==p.get('decision_id') for e in (r.get('race_outcome') or {}).get('pits',[]))
      for r in saved for p in (r.get('race_outcome') or {}).get('plans',[]))
    next_requests=[r for r in t.desktop.llm_requests() if h.NEXT_Q in json.dumps(r,ensure_ascii=False)]
    next_answer=' '.join(t.notes.get('next_race_question',{}).get('assistant') or [])
    checks={'active':t.notes.get('consultation_phase')=='active',
      'two_completed_proposals':sum(u.get('kind')=='bridge_strategy_proposal' and 'completed' in u.get('states',[]) for u in speech)==2,
      'no_premature_success':not any('登録済み' in u.get('text','') for u in speech),
      'native_accepted':any(b.get('type')=='strategy_decision_ack' and b.get('outcome')=='accepted' for b in raw),
      'native_box':any(b.get('trigger')=='strategy_plan_box_call' for b in raw),
      'ack_readback_completed':any(u.get('kind')=='fuel_reference_consent_ack' and 'completed' in u.get('states',[]) for u in speech),
      'box_audio_completed':any(u.get('kind')=='strategy_plan_box_call' and 'completed' in u.get('states',[]) for u in speech),
      'debrief_correction_saved':any(r.get('outcome_corrections') for r in t.notes.get('saved_debrief',[])),
      'saved_reference_and_actual':any(p.get('provisional_history') and p.get('phase')=='executed'
        for r in t.notes.get('saved_debrief',[]) for p in (r.get('race_outcome') or {}).get('plans',[])),
      'linked_actual_24l':linked_actual,
      'next_race_answer':'3周目' in next_answer and '24L' in next_answer and '訂正' in next_answer,
      'next_race_provider_evidence':any('履歴2件' in r.get('system','') and '実補給24.0L' in r.get('system','') and 'Driver訂正' in r.get('system','') for r in next_requests),
      'next_race_reference':'履歴2件' in t.notes.get('next_race_evidence_note',''),
      'next_race_real_provider':any(h.NEXT_Q in json.dumps(r,ensure_ascii=False) for r in t.desktop.llm_requests()),
      'judge_budget':any(r.get('max_tokens')==100 and 'じゃあその3周目の案で行こう' in json.dumps(r,ensure_ascii=False) for r in t.desktop.llm_requests())}
    result={'notes':t.notes,'checks':checks,'error':error,'proposals':proposals,'acks':acks,
      'raw_broadcasts':raw,'bridge_logs':logs,'desktop':obs,'first_race':first,'provider_requests':t.desktop.llm_requests()}
    dest=Path(os.environ.get('HISTORY_E2E_OUTPUT','/tmp/history-consultation-e2e.json'))
    dest.parent.mkdir(parents=True,exist_ok=True)
    dest.write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str))
    print(json.dumps({'phase':t.notes.get('consultation_phase'),'checks':checks,'proposal_count':len(proposals),'acks':acks,
      'utterances':[(u.get('text'),u.get('states')) for u in speech],'timer_errors':obs.get('timerErrors'),'output':str(dest)},ensure_ascii=False,indent=2))
    return all(checks.values())


def main():
    t=h.Thread(ROOT,steps=[h.at(1,seed),h.at(2,lambda t,f:t.say('燃料は最後まで持つ？何リッター給油すればいい？','fuel_question')),consultation,
      h.at(355,lambda t,f:t.say('給油後の残量で最後まで持つ？何周目？','postpit_question'))])
    first=None
    try:
        t.run(frames(),INFO)
        first=debrief_and_next_race(t)
        return 0 if save(t,first) else 1
    except Exception:
        save(t,first or getattr(t,'first_race_capture',None),error=traceback.format_exc())
        raise
    finally:t.close()

if __name__=='__main__':sys.exit(main())
