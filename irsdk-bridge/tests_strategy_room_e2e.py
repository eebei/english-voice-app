"""Real poll -> canonical comparison -> all Renderer scripts -> completed speech.
Only SDK/calibration persistence/DOM/audio/provider I/O are fixtures. Ranking is untouched.
"""
import json,os,re,tempfile,traceback
from pathlib import Path
import tests_wo019_road_atlanta_e2e as h
import tests_wo001_road_atlanta_fixture as road
import replay_harness as rh
import bridge
from pit_loss_calibrator import PitLossCalibrator
ROOT=str(Path(__file__).resolve().parent.parent)
QUESTIONS=[('normal','通常ピットの作戦を教えて。'),('under','アンダーカットで順位を上げられる？'),('over','オーバーカットで順位を上げられる？'),('compare','何週目に入ると順位アップできる？ピットインには？')]

def calibrate(path):
 c=PitLossCalibrator(str(path))
 for lane in (31.3,27.,33.3):
  c.add_pit_sample(dict(track='road atlanta',car_model='Mercedes-AMG GT3 2020',caution_state='green',pit_entry_pct=.9827,pit_exit_pct=.0576,lane_total_s=lane,classification='calibration',stall_s=7,fuel_added_l=13,tire_service='unknown',repair_s=0))
 for base in (100,200,300):
  prev=.97
  for pct,delta in ((.99,0),(.02,4),(.06,7.2)):
   c.observe_normal_tick(track='road atlanta',car_model='Mercedes-AMG GT3 2020',caution_state='green',session_time=base+delta,lap_dist_pct=pct,previous_lap_dist_pct=prev,on_pit_road=False,on_track=True,player_track_surface=3,session_num=0);prev=pct

def frames():
 rows=[]
 for i in range(580):
  lap=1+i//108;q=.005+(i%108)/108
  f=rh.make_frame(SessionTime=100+i,Lap=lap,LapDistPct=q,FuelLevel=23.5-2.9*i/108,LapLastLapTime=108+(i//108-1)*.01 if i>=108 else 0,CarIdxLapCompleted=[i//108,0,0],SessionLapsTotal=12,SessionLapsRemain=max(0,12-lap+1))
  progress=[1+.005+i/108,1+.035+i/108.3,1-.025+i/108.6]
  laps=[int(x) for x in progress];pcts=[x-int(x) for x in progress]
  ranks=[1+sum(y>x for y in progress) for x in progress]
  f['_arrays'].update(CarIdxLap=laps,CarIdxLapCompleted=[x-1 for x in laps],CarIdxLapDistPct=pcts,CarIdxLastLapTime=[108+(i//108-1)*.01 if i>=108 else 0,108.3,108.6],CarIdxClassPosition=ranks,CarIdxPosition=ranks,CarIdxOnPitRoad=[False]*3,CarIdxTrackSurface=[3]*3)
  f.update(PlayerCarPosition=ranks[0],PlayerCarClassPosition=ranks[0])
  reader=rh.FakeReader([f]);reader.cursor=0
  assert abs(f['LapDistPct']-reader.read_float_array('CarIdxLapDistPct')[0])<1e-9
  assert f['Lap']==reader.read_int_array('CarIdxLap')[0]
  assert f['Lap']-1==reader.read_int_array('CarIdxLapCompleted')[0]
  assert f['PlayerCarClassPosition']==reader.read_int_array('CarIdxClassPosition')[0]
  rows.append(f)
 return rows

def step(t,cursor,frame,result):
 if cursor<450:return False
 if cursor>570:raise AssertionError('bounded strategy-room speech timeout: '+str(t.notes.get('pending')))
 pending=t.notes.get('pending')
 if pending:
  obs=t.observe(observability=True)
  utter=[u for u in obs.get('utterances',[]) if u.get('kind')=='local_strategy_position_comparison' and 'completed' in u.get('states',[])]
  if len(utter)<=t.notes.get('completed_count',0):return False
  active=obs.get('canonical',{}).get('active')
  signature=lambda r:tuple((r or {}).get(k) for k in ('decision_id','target_lap','set_fuel_l'))
  assert signature(active)==signature(t.notes.get('question_active')),'question changed native agreement'
  t.notes['answers'].append({'question':pending,'utterance':utter[-1],'comparison':t.notes['question_comparison'],'native_before':t.notes.get('question_active'),'native_after':active})
  t.notes['completed_count']=len(utter);t.notes['pending']=None;t.notes['next_at']=cursor+2
 if cursor<t.notes.get('next_at',0):return False
 index=len(t.notes.get('answers',[]))
 if index>=1:return True
 snapshots=[b for b in result.broadcasts if b.get('type')=='canonical_lifecycle_snapshot']
 comp=((snapshots[-1].get('recommendations',{}).get('strategy_options') or {}).get('value') or {}).get('position_comparison') if snapshots else None
 if not comp:return False
 t.notes.setdefault('answers',[]);t.notes['question_comparison']=comp;t.notes['question_active']=snapshots[-1]['lifecycle']['active'];t.notes['pending']=t.notes['question'][0]
 t.say(t.notes['question'][1],t.notes['question'][0]);return False

def run(calibrated,question,invalid_geometry=False):
 with tempfile.TemporaryDirectory(prefix='strategy-room-e2e-') as td:
  path=Path(td)/'pit-loss.json'
  if calibrated:calibrate(path)
  if invalid_geometry:
   saved=json.loads(path.read_text())
   for record in saved['conditions'].values():record['pit_exit_pct']=None
   path.write_text(json.dumps(saved))
   summary=PitLossCalibrator(str(path)).get_summary('road atlanta','Mercedes-AMG GT3 2020','green')
   assert summary['prediction_ready'] is True and summary['pit_exit_pct'] is None
  old=bridge.PIT_LOSS_PATH;bridge.PIT_LOSS_PATH=str(path)
  t=h.Thread(ROOT,steps=[step]);t.notes['question']=question;t.notes['calibrated']=calibrated
  try:
   t.run(frames(),road.ROAD_ATLANTA_SESSION_INFO.replace('SessionLaps: 25','SessionLaps: 12'))
   obs=t.observe(observability=True);answers=t.notes.get('answers',[]);numeric=[]
   for a in answers:
    c=a['comparison'];text=a['utterance']['text'];ids={'normal':['A'],'under':['B'],'over':['C'],'compare':['A','B','C']}[a['question']]
    expected=[r for r in c.get('ranked_candidates',[]) if r['plan_id'] in ids]
    numeric.extend(expected)
    names={'A':'通常ピット','B':'アンダーカット','C':'オーバーカット'}
    assert all((names[r['plan_id']]+'は'+str(r['target_lap'])+'周目、復帰時点P'+str(r['expected_class_position'])+'予測') in text for r in expected),(a['question'],text,expected)
    if not calibrated or invalid_geometry:
     assert not re.search(r'復帰時点P\d+|\d+周目',text),'invented target or rank in unavailable answer'
   checks={'question_completed':len(answers)==1,'no_command_or_consent':not any(json.loads(x['raw']).get('cmd') in ('driver_plan_command','strategy_decision_response','fuel_reference_request') for x in t.to_bridge),'no_timer_errors':not obs.get('timerErrors'),'numeric_forecast_exists' if calibrated and not invalid_geometry else 'no_invented_forecast':len(numeric)==(3 if question[0]=='compare' else 1) if calibrated and not invalid_geometry else not numeric}
   if invalid_geometry:
    checks['persisted_null_reason_reaches_speech']=len(answers)==1 and answers[0]['comparison'].get('reason')=='calibration_geometry_unavailable' and 'ピット入口・出口の実測位置が未確認' in answers[0]['utterance']['text']
   return {'calibrated':calibrated,'invalid_geometry':invalid_geometry,'question':question[0],'checks':checks,'answers':answers,'outbound':t.to_bridge,'desktop':obs,'broadcasts':t.result.broadcasts}
  except Exception:
   return {'calibrated':calibrated,'invalid_geometry':invalid_geometry,'question':question[0],'checks':{'bounded_replay_completed':False},'error':traceback.format_exc(),'notes':t.notes,'desktop':t.observe(observability=True),'bridge_logs':list(t.result.logs) if t.result else []}
  finally:t.close();bridge.PIT_LOSS_PATH=old

def main():
 results=[]
 selected=QUESTIONS[-1:] if os.environ.get('STRATEGY_ROOM_COMPARISON_ONLY')=='1' else QUESTIONS
 cases=[(True,q,False) for q in selected]+[(False,QUESTIONS[-1],False)]
 if os.environ.get('STRATEGY_ROOM_COMPARISON_ONLY')!='1':cases.append((True,QUESTIONS[-1],True))
 for calibrated,question,invalid_geometry in cases:
  result=run(calibrated,question,invalid_geometry);results.append(result)
  print(json.dumps({'calibrated':calibrated,'question':question[0],'checks':result['checks']},ensure_ascii=False),flush=True)
 dest=Path(os.environ.get('STRATEGY_ROOM_E2E_OUTPUT','/tmp/strategy-room-e2e.json'));dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(json.dumps(results,ensure_ascii=False,indent=2,default=str))
 print(json.dumps({'checks':[r['checks'] for r in results],'output':str(dest)},indent=2));return 0 if all(all(r['checks'].values()) for r in results) else 1
if __name__=='__main__':raise SystemExit(main())
