#!/usr/bin/env python3
"""Field305 same-input speech delivery through the real Bridge/server/all Renderer scripts.
Only SDK/clock/audio/provider IO are saved doubles. No model call or authority is mocked.
WO019_PRODUCT_ROOT selects the archived before tree; SPEECH_E2E_EXPECT=before requires
its field failure reproduction rather than accepting an arbitrary harness error.
"""
import json
import os
from pathlib import Path
import tests_wo019_road_atlanta_e2e as h
rh=h.rh

LAST_FAILURE={}
def capture_failure(t,error):
 LAST_FAILURE.update(error=repr(error),cursor=t.cursor,notes=t.notes,
    bridge_logs=t.result.logs if t.result else [],broadcasts=t.result.broadcasts if t.result else [])
 try:LAST_FAILURE['observation']=t.observe(observability=True,apiBodies=True,console=600)
 except Exception as observation_error:LAST_FAILURE['observation_error']=repr(observation_error)
 try:LAST_FAILURE['provider_requests']=t.desktop.llm_requests()
 except Exception as capture_error:LAST_FAILURE['capture_error']=repr(capture_error)

CASES=[
 ('u8','機能を走ったレース 覚えてる？一緒に走ったやつ。','前回2026-10-23のCircuit Gilles Villen。'),
 ('u10','昨日のレースのデータだ。','前回は2026-10-23のCircuit Gilles Ville。'),
 ('u12','昨日のレースのデータ。','わかった。昨日のレース、2026-10-24のデータだね。'),
 ('u17','全然 改善できてないね君','ごめん。昨日のレース、2026-10-23のデータね。'),
 ('u23','前が落ち着けよ。','あなたの質問、整理させて。'),
 ('u28','使い物にならない エンジニアですね。あなたはどう思いますか？','わたしは、あなたの質問に正しく答えられていない。それは事実だ。'),
]

def frames(n=65):
 return [rh.make_frame(SessionTime=100+i,SessionTimeRemain=1700-i,Lap=2,LapDistPct=.05+i*.002,
     FuelLevel=58-i*.015,LapLastLapTime=0,CarIdxLapCompleted=[1,0,0]) for i in range(n)]

def run_case(name,question,response):
 t=h.Thread(h.PRODUCT_ROOT,steps=[h.at(20,lambda t,f:t.say(question,name,llm=response))])
 try:
  fs=frames()
  if name in ('u8','u10'):
   for f in fs[19:28]:f['SteeringWheelAngle']=.25
  t.run(fs,h.road.ROAD_ATLANTA_SESSION_INFO)
  obs=t.observe(observability=True,apiBodies=True,console=600)
  spoken=[u for u in obs['utterances'] if u.get('kind') in ('reply','reply_chunk') or (u.get('kind','').startswith('local_historical') and u.get('at',0)>=h.REPLAY_CLOCK_BASE_MS+20000)]
  # Demand the actual requested response, so local routing/provider errors cannot pass.
  relevant=[u for u in spoken if u.get('text') and (u['text'].strip() in response or u.get('kind','').startswith('local_historical'))]
  checks={'response_reached_speech':bool(relevant),
          'saved_response_complete_if_model':all(u.get('kind','').startswith('local_historical') for u in relevant) or all(any(part.strip() in str(u.get('text','')) for u in relevant) for part in response.split('。') if part.strip()),
          'all_response_chunks_completed':bool(relevant) and all('completed' in u.get('states',[]) for u in relevant),
          'no_external_fetch':not obs.get('blockedFetches'), 'no_timer_error':not obs.get('timerErrors')}
  return {'name':name,'input':question,'saved_response':response,'checks':checks,'response_utterances':relevant,
      'observation':obs,'notes':t.notes,'provider_requests':t.desktop.llm_requests(),
      'bridge_logs':t.result.logs,'broadcasts':t.result.broadcasts}
 except Exception as error:
  capture_failure(t,error);raise
 finally:t.close()

def run_control(mode):
 response='あなたの質問に正しく答えられていない理由を整理して問いの内容に沿って具体的に答える。' if mode!='old_number' else '現在の燃料は58リットル。'
 fired={'value':False}
 def turn(t,cursor,frame,result):
  if cursor==20:t.say('説明を聞かせて。',mode,llm=response)
  obs=t.observe()
  playing=[u for u in obs['utterances'] if u.get('kind') in ('reply','reply_chunk') and 'play_started' in u.get('states',[]) and 'completed' not in u.get('states',[]) and 'audible_interrupted' not in u.get('states',[])]
  if cursor>20 and playing and not fired['value']:
   fired['value']=True;t.notes['control_before']=obs
   if mode=='ptt':
    h.bridge._ptt_physical_edge(True);t.deliver();h.bridge._ptt_physical_edge(False);t.deliver()
   elif mode in ('sdk_gap','scope_change'):
    for f in fs[cursor+1:]:f['_inactive' if mode=='sdk_gap' else 'SessionNum']=True if mode=='sdk_gap' else 1
   elif mode=='urgent':
    stamp=t.now_ms()/1000
    t.deliver_raw([json.dumps({'type':'radio','trigger':trigger,'source_timestamp':stamp,'session_time':frame['SessionTime'],
      'stopped_timestamp':stamp,'flag_timestamp':stamp,'distance':30,'car_idx':1,'car_number':'7','track_side':'left'}) for trigger in ('yellow_flag','stopped_ahead')])
  return False
 fs=frames()
 if mode=='old_number':
  for f in fs:f['FuelLevel']=58 if f['SessionTime']<123 else 57
 t=h.Thread(h.PRODUCT_ROOT,steps=[turn])
 try:
  t.run(fs,h.road.ROAD_ATLANTA_SESSION_INFO)
  obs=t.observe(observability=True,apiBodies=True,console=600)
  response_ids={u['uid'] for u in t.notes.get(mode,{}).get('utterances',[]) if u.get('kind') in ('reply','reply_chunk')}
  replies=[u for u in obs['utterances'] if u['uid'] in response_ids]
  checks={'response_reached_speech':bool(replies),'stale_or_preempted_response_not_completed':bool(replies) and all('completed' not in u['states'] for u in replies)}
  if mode in ('ptt','urgent','sdk_gap','scope_change'):checks['control_applied']=fired['value']
  if mode!='old_number':checks['playing_response_interrupted']=any('play_started' in u['states'] and 'audible_interrupted' in u['states'] for u in replies)
  if mode=='old_number':
   streamed=[r for r in t.desktop.llm_requests() if r.get('stream') is True]
   actual=[u for u in obs['utterances'] if u.get('kind') in ('reply','reply_chunk')]
   guard_logs=[line for line in t.result.logs if 'TELEMETRY_TRUTH_GUARD' in line or 'telemetry_owned' in line or 'truth' in line.lower()]
   checks={'provider_turn_reached':bool(streamed),'saved_claim_explicitly_blocked':any('TELEMETRY_TRUTH_GATE' in line and response in line for line in guard_logs),'current_number_never_played':not any('58' in u.get('text','') and 'play_started' in u['states'] for u in actual),
      'explicit_fallback_completed':any(u.get('text')=='了解。' and 'completed' in u['states'] for u in actual)}
   t.notes['numeric_guard_logs']=guard_logs
  if mode=='urgent':checks['urgent_completed']=any(u.get('kind')=='reflex_hazard' and 'completed' in u['states'] for u in obs['utterances'])
  return {'name':mode,'checks':checks,'response_utterances':replies,'observation':obs,'notes':t.notes,
      'provider_requests':t.desktop.llm_requests(),'bridge_logs':t.result.logs,'broadcasts':t.result.broadcasts}
 except Exception as error:
  capture_failure(t,error);raise
 finally:t.close()

def run_plan(mode):
 warm=[rh.make_frame(SessionTime=100+i,Lap=1,FuelLevel=38,LapDistPct=.01,LapLastLapTime=0) for i in range(28)]
 measured,fuel,at,lap=h.road.clean_laps(4,start_time=128,start_fuel=38)
 fs=warm+measured+[rh.make_frame(SessionTime=at+i,Lap=lap,FuelLevel=fuel-.01*i,LapDistPct=.01+i*.003,LapLastLapTime=h.road.LAP_S+.03) for i in range(30)]
 for f in fs:f.update(SessionLapsTotal=h.road.LAPS_TOTAL,SessionLapsRemain=h.road.LAPS_TOTAL-f['Lap'])
 acted={'value':False}
 def control(t,cursor,frame,result):
  obs=t.observe()
  playing=[u for u in obs['utterances'] if u.get('kind') in ('initial_strategy_plans','strategy_plan_decision') and 'play_started' in u['states'] and not any(x in u['states'] for x in ('completed','audible_interrupted'))]
  if not playing or acted['value']:return False
  acted['value']=True;t.notes['plan_before_control']=obs
  if mode=='ptt':
   h.bridge._ptt_physical_edge(True);t.deliver();h.bridge._ptt_physical_edge(False);t.deliver()
  elif mode in ('critical','scope'):
   for f in fs[cursor+1:]:f['SessionFlags' if mode=='critical' else 'SessionNum']=0x10000 if mode=='critical' else 1
  elif mode=='urgent':
   stamp=t.now_ms()/1000
   t.deliver_raw([json.dumps({'type':'radio','trigger':trigger,'source_timestamp':stamp,'session_time':frame['SessionTime'],
      'stopped_timestamp':stamp,'flag_timestamp':stamp,'distance':30,'car_idx':1,'car_number':'7','track_side':'left'}) for trigger in ('yellow_flag','stopped_ahead')])
  return False
 t=h.Thread(h.PRODUCT_ROOT,steps=[control])
 try:
  t.run(fs,h.road.ROAD_ATLANTA_SESSION_INFO)
  obs=t.observe(observability=True,apiBodies=True,console=600)
  candidates=[u for u in obs['utterances'] if u.get('kind') in ('initial_strategy_plans','strategy_plan_decision')]
  first=next((u for u in candidates if 'play_started' in u['states']),None)
  before=t.notes.get('plan_before_control',{});native=before.get('canonical',{}).get('active') or {}
  checks={'real_plan_started':bool(first),'native_positive_fuel':isinstance(native.get('set_fuel_l'),(int,float)) and native['set_fuel_l']>0,
    'native_quantity_spoken':bool(first) and (str(int(native.get('set_fuel_l') or 0))+'リットル') in first.get('text',''),'target_explicit':bool(first) and ('周目にピット' in first.get('text','') or '未確定' in first.get('text',''))}
  checks['completed' if mode=='normal' else 'preempted']=bool(first) and ('completed' in first['states'] if mode=='normal' else 'audible_interrupted' in first['states'])
  if mode=='urgent':checks['urgent_completed']=any(u.get('kind')=='reflex_hazard' and 'completed' in u['states'] for u in obs['utterances'])
  return {'name':'plan_'+mode,'checks':checks,'first_plan':first,'observation':obs,'notes':t.notes,'broadcasts':t.result.broadcasts,'bridge_logs':t.result.logs}
 except Exception as error:
  capture_failure(t,error);raise
 finally:t.close()

def run_offline_mode(purpose,numeric=False):
 t=h.Thread(h.PRODUCT_ROOT)
 try:
  t.clock_ms=h.REPLAY_CLOCK_BASE_MS;t.booted=True
  boot=t.desktop.send('boot',user=h.OWNER,nowMs=t.clock_ms,purpose=purpose)
  t.advance(15000)
  response='現在の燃料は58リットル。' if numeric else '問いの内容を整理して、次に役立つ形で会話を続ける。'
  t.say('会話の練習を続けたい。','offline',llm=response);t.advance(15000)
  obs=t.observe(observability=True,apiBodies=True,console=300)
  replies=[u for u in obs['utterances'] if u.get('kind') in ('reply','reply_chunk')]
  checks={'sdk_disconnected':obs.get('iracingLive') is False,'provider_reached':any(r.get('stream') for r in t.desktop.llm_requests())}
  if numeric:checks['unknown_scope_never_authorizes_number']=not any('58' in u.get('text','') and 'play_started' in u['states'] for u in replies)
  else:checks['all_response_chunks_completed']=bool(replies) and all('completed' in u['states'] for u in replies)
  return {'name':'offline_'+purpose+('_numeric' if numeric else ''),'checks':checks,'boot':boot,'observation':obs,'provider_requests':t.desktop.llm_requests(),'notes':t.notes}
 except Exception as error:
  capture_failure(t,error);raise
 finally:t.close()

def run_closed_mode():
 fs=frames(45);fs+=h.wo018._finish_frames(fs[-1]);last=fs[-1]
 for i in range(55):
  f=dict(last);f['_arrays']={k:list(v) for k,v in last['_arrays'].items()};f['SessionTime']=last['SessionTime']+i+1;fs.append(f)
 response='あなたの質問に正しく答えられていない理由を整理して問いの内容に沿って具体的に答える。'
 def step(t,cursor,frame,result):
  if cursor==56:t.say('会話の説明を続けて。','before_closed',llm=response)
  if cursor==85:
   t.notes['closed_before_new_turn']=t.observe()
   closed=t.notes['closed_before_new_turn']
   if closed.get('selMode')=='debrief' and closed.get('evidenceDebrief'):
    t.notes['guide_button']={'selMode':'debrief','actual_auto_debrief':True}
   else:
    t.notes['guide_button']=t.desktop.send('debrief_guide_start',nowMs=t.now_ms());t.forward(t.notes['guide_button'].get('outbound'))
   t.click('discardEvidenceMemory')
   t.say('会話の説明を続けて。','after_closed',llm=response)
  return False
 t=h.Thread(h.PRODUCT_ROOT,steps=[step])
 try:
  t.run(fs,h.road.ROAD_ATLANTA_SESSION_INFO)
  obs=t.observe(observability=True,apiBodies=True,console=500)
  by_uid={u['uid']:u for u in obs['utterances']}
  old=[by_uid[u['uid']] for u in t.notes.get('before_closed',{}).get('utterances',[]) if u.get('kind') in ('reply','reply_chunk')]
  new=[by_uid[u['uid']] for u in t.notes.get('after_closed',{}).get('utterances',[]) if u.get('kind') in ('reply','reply_chunk')]
  checks={'closed_authority_observed':t.notes.get('closed_before_new_turn',{}).get('canonical',{}).get('execution',{}).get('scope_closed') is True,
    'old_live_turn_started':any('play_started' in u['states'] for u in old),
    'old_live_turn_stopped':bool(old) and all('completed' not in u['states'] for u in old),
    'real_guide_or_auto_entered_debrief':t.notes.get('guide_button',{}).get('selMode')=='debrief',
    'new_debrief_response_completed':bool(new) and all('completed' in u['states'] for u in new)}
  return {'name':'closed_debrief','checks':checks,'old_reply':old,'new_reply':new,'notes':t.notes,'observation':obs,'broadcasts':t.result.broadcasts,'bridge_logs':t.result.logs,'provider_requests':t.desktop.llm_requests()}
 except Exception as error:
  capture_failure(t,error);raise
 finally:t.close()

def main():
 result={'product_root':h.PRODUCT_ROOT,'io':'saved SDK/provider/TTS; real product speech guards','cases':[]}
 try:
  for case in CASES:result['cases'].append(run_case(*case))
  before=os.environ.get('SPEECH_E2E_EXPECT')=='before'
  result['controls']=[run_control(mode) for mode in ('ptt','urgent','old_number','sdk_gap','scope_change')]
  result['plan_controls']=[run_plan(mode) for mode in ('normal','critical','ptt','urgent','scope')]
  result['mode_controls']=[]
  for purpose,numeric in [('race_weekend',False),('practice',False),('race_weekend',True)]:result['mode_controls'].append(run_offline_mode(purpose,numeric))
  result['mode_controls'].append(run_closed_mode())
  failures=[x for x in result['cases'] if not (x['checks']['all_response_chunks_completed'] and x['checks']['saved_response_complete_if_model'])]
  result['checks']={'field_failure_reproduced':bool(failures)} if before else {
      'all_field_responses_completed':not failures,
      'no_harness_errors':all(x['checks']['no_timer_error'] and x['checks']['no_external_fetch'] for x in result['cases']),
      'safety_controls':all(all(x['checks'].values()) for x in result['controls']),
      'plan_delivery_and_safety':all(all(x['checks'].values()) for x in result['plan_controls']),
      'mode_continuity_and_fences':all(all(x['checks'].values()) for x in result['mode_controls'])}
  result['passed']=all(result['checks'].values())
 except Exception as exc:
  result['error']=repr(exc);result['failure_context']=LAST_FAILURE;result['passed']=False
  raise
 finally:
  path=Path(os.environ.get('SPEECH_E2E_OUTPUT','/tmp/speech-conversation-e2e.json'))
  path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str))
  print(json.dumps({'output':str(path),'passed':result.get('passed'),'checks':result.get('checks'),'error':result.get('error')},ensure_ascii=False))
 return 0 if result['passed'] else 1
if __name__=='__main__':raise SystemExit(main())
