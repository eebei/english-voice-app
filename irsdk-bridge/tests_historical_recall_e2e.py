"""Actual saved-summary/Renderer persistence, restart, historical speech and deletion.

Only SDK, clock, persistent-store I/O, DOM/audio and provider I/O are fixtures.
No canonical state, permission, historical selector or output formatter is patched.
"""
import json, os, traceback
from pathlib import Path
from datetime import datetime, timezone
import tests_wo019_road_atlanta_e2e as h
import tests_wo001_road_atlanta_fixture as road
import replay_harness as rh

ROOT=str(Path(__file__).resolve().parent.parent)
INFO=road.ROAD_ATLANTA_SESSION_INFO.replace('UserID: 10101','UserID: 315555')
DAY24=int(datetime(2026,10,24,11,tzinfo=timezone.utc).timestamp()*1000)
KEYS=['pw_raceHistory','pw_session_evidence','pw_session_evidence_deleted_v1']

def call(t,fn,*args):
 return t.desktop.send('call',fn=fn,args=list(args),nowMs=t.now_ms())['value']

def thread(steps,day=DAY24):
 t=h.Thread(ROOT,steps=steps);t.offset_ms=day-h.REPLAY_CLOCK_BASE_MS;return t

def storage(t,key,rows):
 return t.desktop.send('history_store_write',key=key,value=json.dumps(rows),nowMs=t.now_ms())

def quiet_frames(n=190):
 return [rh.make_frame(SessionTime=100+i,Lap=2,LapDistPct=.05+i*.002,FuelLevel=48-i*.01,
  LapLastLapTime=0,CarIdxLapCompleted=[1,0,0]) for i in range(n)]

def run_field_recall():
 questions=['昨日のレースのデータを教えて。','何週目にピットインした？','何回ピットで何位でゴールした？']
 def seed(t,cursor,frame,result):
  if cursor!=3:return False
  identity=call(t,'currentMemoryIdentity')
  row={'raceRecordId':'field:89577642','race_instance_id':'sub:89577642','sessionNum':2,
   'owner_ref':identity['ownerRef'],'userId':identity['userId'],'custId':315555,
   'recordedAt':'2026-10-23T10:00:00Z','date':'2026-10-23','sessionType':'Race',
   'track':'Circuit Gilles Villeneuve','car':'Mercedes-AMG GT3 2020','totalLaps':22,'finishPos':20,
   'pitEvents':[{'entry_lap':13,'fuel_added_l':10.19},{'entry_lap':20,'fuel_added_l':5.79}]}
  assert storage(t,'pw_raceHistory',[row])['ok'];t.notes['seed']=row;t.notes['answers']=[];return True
 def consult(t,cursor,frame,result):
  if cursor<25:return False
  obs=t.observe();speech=[u for u in obs['utterances'] if u.get('kind')=='local_historical_race_recall' and 'completed' in u.get('states',[])]
  if t.notes.get('pending'):
   if len(speech)<=len(t.notes['answers']):return False
   t.notes['answers'].append(speech[-1]);t.notes['pending']=False;t.notes['next']=cursor+3
  if cursor<t.notes.get('next',0):return False
  n=len(t.notes['answers'])
  if n==len(questions):return True
  t.say(questions[n],'history_'+str(n));t.notes['pending']=True;return False
 t=thread([seed,consult])
 try:
  t.run(quiet_frames(),INFO);obs=t.observe(observability=True,apiBodies=True)
  answers=t.notes.get('answers',[]);texts=[a['text'] for a in answers]
  checks={'three_completed':len(answers)==3,'same_saved_pit_laps':len(texts)>1 and '13・20周目' in texts[1],
   'saved_count_and_finish':len(texts)>2 and '2回' in texts[2] and 'P20' in texts[2],
   'no_present_fuel_substitution':all('48' not in x and 'Plan A' not in x for x in texts),
   'no_chat_needed':not any(a['route']=='/api/chat' for a in obs['apiRequests']),
   'no_timer_error':not obs['timerErrors'],
   'no_execution':not any(json.loads(x['raw']).get('cmd') in ('driver_plan_command','strategy_decision_response','fuel_reference_request') for x in t.to_bridge)}
  # Queue a historical answer, delete its actual source record, then reopen the driving window.
  t.notes['before_delete_count']=len(obs['utterances'])
  def queued(t,cursor,frame,result):
   if cursor!=5:return False
   t.say('昨日のレースは何周目にピット？','queued_deleted')
   t.say('昨日のレースの記憶を削除して。','delete_history');t.notes['delete_result']=not call(t,'loadRaceHistory');return True
  t.steps=[queued];fs=quiet_frames(40)
  for f in fs[:18]:f['SteeringWheelAngle']=.25
  t.run(fs,INFO);t.advance(15000);last=t.observe()
  removed=[u for u in last['utterances'][t.notes['before_delete_count']:] if u.get('kind')=='local_historical_race_recall']
  checks['deleted_queued_answer_never_played']=t.notes['delete_result'] and bool(removed) and all('play_started' not in u.get('states',[]) for u in removed)
  return {'checks':checks,'answers':answers,'deleted_queue':removed,'notes':t.notes,'desktop':last,'outbound':t.to_bridge}
 finally:t.close()

def run_automatic_restart():
 t=thread([])
 try:
  fs,_fuel,_at,_lap=road.clean_laps(4,start_fuel=35.)
  fs+=h.wo018._finish_frames(fs[-1]);t.run(fs,INFO);t.advance(18000)
  history=call(t,'loadRaceHistory');assert history,'real finish did not auto-save race'
  summary=t.observe()['lastSessionSummary'];assert summary,'real finish did not retain summary'
  # Use the real review flow; adoption/confirmation is deliberately never clicked.
  if not t.observe().get('evidenceDebrief'):t.desktop.send('debrief_guide_start',nowMs=t.now_ms())
  t.advance(18000);t.say('予定より早めて安全を優先した。','debrief_answer',llm='次回も給油案を早めに相談しよう。')
  t.advance(18000)
  history=call(t,'loadRaceHistory');reviews=call(t,'loadEvidenceRecords')
  captured={'history':history,'reviews':reviews,'desktop':t.observe(observability=True,keys=KEYS)}
  source=next(r for r in history if r.get('race_instance_id')==summary['race_instance_id'])
  notes=[r for r in reviews if r.get('race_instance_id')==summary['race_instance_id']]
  checks={'summary_saved_without_adoption':bool(source.get('compactSummary')),
   'debrief_saved_without_adoption':any('安全を優先' in json.dumps(r,ensure_ascii=False) for r in notes)}
 finally:t.close()
 def restore(t,cursor,frame,result):
  if cursor!=3:return False
  storage(t,'pw_raceHistory',history);storage(t,'pw_session_evidence',reviews);return True
 t=thread([restore,h.at(25,lambda t,f:t.say('昨日のレースの反省点を教えて。','recall_debrief'))],DAY24+86400000)
 try:
  t.run(quiet_frames(95),INFO.replace(str(road.ROAD_ATLANTA_SUB_SESSION_ID),str(road.ROAD_ATLANTA_SUB_SESSION_ID+1)))
  obs=t.observe(observability=True);speech=[u for u in obs['utterances'] if u.get('kind')=='local_historical_race_recall' and 'completed' in u.get('states',[])]
  checks['restart_retrieves_driver_report']=any('Driver申告' in u.get('text','') and '安全を優先' in u.get('text','') for u in speech)
  # Persistent-store correction/deletion while a real historical answer waits in the driving window.
  # Race facts stay present; only the referenced debrief changes.
  fences=[]
  for mode,playing,model in [('correct',False,False),('delete',False,False),('correct',True,False),('delete',True,False),('correct',False,True),('delete',False,True)]:
   label=mode+('_playing' if playing else '_queued')+('_model' if model else '')
   storage(t,'pw_session_evidence',reviews)
   start=len(t.observe()['utterances'])
   def mutate_review(t,cursor,frame,result):
    if cursor==20:
     if model:t.say('前回のピットどうだった？','review_fence_'+label,llm='当時のDriver申告では、安全を優先したと保存されている。その判断を次回の相談でも確認しよう。')
     else:t.say('昨日のレースの反省点を教えて。','review_fence_'+label)
    if playing:
     pending=[u for u in t.observe()['utterances'][start:] if u.get('kind')=='local_historical_race_recall']
     if not any('play_started' in u.get('states',[]) for u in pending):return False
    elif cursor!=22:return False
    altered=json.loads(json.dumps(reviews))
    if mode=='correct':
     for r in altered:
      if r.get('race_instance_id')==source['race_instance_id']:
       r['qa']=[{'question':'訂正','answer':'安全優先という申告は撤回。'}]
       r['conversation']=[{'role':'user','text':'安全優先という申告は撤回。'}]
    else:altered=[r for r in altered if r.get('race_instance_id')!=source['race_instance_id']]
    t.notes['prompt_'+label]=call(t,'currentMemoryBrainPrompt')
    storage(t,'pw_session_evidence',altered);return True
   t.steps=[mutate_review];frames=quiet_frames(65)
   if not playing:
    for f in frames[19:38]:f['SteeringWheelAngle']=.25
   t.run(frames,INFO.replace(str(road.ROAD_ATLANTA_SUB_SESSION_ID),str(road.ROAD_ATLANTA_SUB_SESSION_ID+1)))
   emitted=[u for u in t.observe()['utterances'][start:] if u.get('kind') in (('reply','reply_chunk') if model else ('local_historical_race_recall',))]
   fences.append({'mode':label,'utterances':emitted})
   checks['review_'+label+'_invalidates_answer']=bool(emitted) and all('memory_source_invalidated' in json.dumps(u) for u in emitted) and (
     any('play_started' in u.get('states',[]) and 'audible_interrupted' in u.get('states',[]) for u in emitted) if playing
     else all('play_started' not in u.get('states',[]) for u in emitted))
   checks['review_'+label+'_keeps_race']=any(r['raceRecordId']==source['raceRecordId'] for r in call(t,'loadRaceHistory'))
  storage(t,'pw_session_evidence',reviews)
  before_delete={'identity':call(t,'currentMemoryIdentity'),'history':call(t,'loadRaceHistory'),'now':t.now_ms()}
  delete_response=t.say('昨日のレースの記憶を削除して。','delete_saved_race')
  checks['delete_actual_record']=not any(r['raceRecordId']==source['raceRecordId'] for r in call(t,'loadRaceHistory'))
  checks['linked_debrief_removed']=not any(r.get('race_instance_id')==source['race_instance_id'] for r in call(t,'loadEvidenceRecords'))
  if notes:
   storage(t,'pw_session_evidence',reviews)
   checks['deleted_memory_cannot_return']=not any(r.get('race_instance_id')==source['race_instance_id'] for r in call(t,'loadEvidenceRecords'))
  checks['no_timer_error']=not obs['timerErrors']
  return {'checks':checks,'saved_before_restart':captured,'restored_desktop':obs,'recall_speech':speech,'review_fences':fences,'before_delete':before_delete,'delete_response':delete_response,'final_desktop':t.observe(observability=True,keys=KEYS)}
 finally:t.close()

def main():
 out={}
 try:
  out['field_recall']=run_field_recall();out['automatic_restart']=run_automatic_restart()
  out['passed']=all(all(r['checks'].values()) for r in out.values() if isinstance(r,dict) and 'checks' in r)
 except Exception:out['error']=traceback.format_exc();out['passed']=False
 dest=Path(os.environ.get('HISTORY_RECALL_OUTPUT','/tmp/history-recall-e2e.json'));dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(json.dumps(out,ensure_ascii=False,indent=2,default=str))
 print(json.dumps({'passed':out['passed'],'checks':{k:v.get('checks') for k,v in out.items() if isinstance(v,dict)},'error':out.get('error'),'output':str(dest)},ensure_ascii=False));return 0 if out['passed'] else 1
if __name__=='__main__':raise SystemExit(main())
