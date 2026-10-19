"""WO012 actual sendMsg + durable journal + actual Bridge poll paired evidence."""
import json,unittest,tempfile,os
from unittest.mock import patch
from pathlib import Path
import replay_harness as rh,tests_wo001_road_atlanta_fixture as road
from tests_wo011_projection_wiring import desktop,receive

class IntentWiring(unittest.TestCase):
 def run_probe(self,turns,source='typed',**options):
  state={}
  def hook(cursor,frame,result):
   live=[x for x in result.broadcasts if x.get('type')=='telemetry_live' and x.get('active_plan_decision_id')]
   if live and not state:
    state['initial']=live[-1];state['probe']=desktop({'mode':'probe','initial':live[-1],'turns':turns,'source':source,**options})
    for wire in state['probe']['sent']:receive(wire)
  result=rh.replay(road.clean_laps(8)[0],session_info=road.ROAD_ATLANTA_SESSION_INFO,on_frame_ready=hook)
  return result,state
 def test_protected_turns_wire_zero_actual_poll_plan_unchanged(self):
  evidence=[]
  for text in ['プランは14周で合ってる','先週のピットは14周だった','この周ピット入るつもりはない','この周ピットやめないで','この周ピット行かん','ピット入るとは言ってない','ピットやめるとは言ってない','not box this lap','no pit now','今周ピット入らない','この周ピット入っていい','前回はピット入るって言った','ペナルティでピット入るぞ','ピット入るぞではない','黒旗だからこの周ピット','燃料ウィンドウ前回開いてた？','I will not pit now','can I box this lap','if traffic slows I will pit now','ウィンドウが開いたら入る','ウィンドウが開いたら14周にピット変更']:
   with self.subTest(text=text):
    r,s=self.run_probe([text]);p=s['probe'];self.assertEqual([],p['sent']);self.assertEqual(p['before']['pit_plan'],p['current']['pit_plan']);self.assertTrue(p['spoken']);self.assertFalse(any(x.get('type')=='driver_plan_command_ack' for x in r.broadcasts));evidence.append({'text':text,'probe':p})
  Path('/tmp/wo012-after-protected-actual.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2))
 def test_new_declarations_journal_ack_canonical(self):
  for text in ['先に入る','前が遅いから今ピット入る','box this lap','pit now','次周ピット入る','ウィンドウはまだだけど今ピット入る','ウィンドウ閉じてるけど14周にピット変更','ウィンドウはまだだからこのプランを取り消す']:
   with self.subTest(text=text):
    r,s=self.run_probe([text],'ptt');p=s['probe'];self.assertEqual(1,len(p['sent']));self.assertEqual('driver_plan_command',p['sent'][0]['cmd']);self.assertEqual(p['before']['pit_plan'],p['current']['pit_plan']);self.assertEqual(1,len(p['journal']));acks=[x for x in r.broadcasts if x.get('type')=='driver_plan_command_ack'];self.assertTrue(acks);self.assertEqual('applied',acks[0]['outcome']);out=desktop({'mode':'readback','initial':s['initial'],'command':p['sent'][0],'journal_dir':p['journal_dir'],'events':r.broadcasts});self.assertEqual(0,out['before_canonical_speech']);self.assertTrue(out['spoken'])
 def test_dispute_ack_and_one_command_coexist(self):
  r,s=self.run_probe(['いや後ろ2秒だよ今ピット入る'],dispute=True);self.assertEqual(1,len(s['probe']['sent']));self.assertTrue(any(t.get('event')=='DISPUTE_ACK' for t in s['probe']['trace']))
 def test_prior_handlers_cannot_shadow_declaration(self):
  r,s=self.run_probe(['前が遅いから今ピット入る'],shadow=True);self.assertEqual(1,len(s['probe']['sent']));self.assertFalse(any(t.get('event')=='team_shadow' for t in s['probe']['trace']))
 def test_reason_expiry_and_intervening_turn(self):
  for turns in [['先に入る','今日は暑いね','前の25が遅いから先に入る'],['先に入る',{'at':16000,'text':'前の25が遅いから先に入る'}],['先に入る','14周にピット変更','前の25が遅いから先に入る']]:
   r,s=self.run_probe(turns);self.assertFalse(any(x['cmd']=='driver_plan_reason' for x in s['probe']['sent']))
 def test_same_product_assert_red_when_guards_removed(self):
  root=Path(__file__).resolve().parent.parent
  cases=[('negation','desktop/local-intent-router.js',"if(negated)return {kind:'negated',topic:'pit'};",'',{'turns':['今周ピット入らない']},'WO012_ROUTER_PATH'),('history','desktop/local-intent-router.js',"if(historical)return {kind:'historical',topic:'pit'};",'',{'turns':['前回はピット入るって言った']},'WO012_ROUTER_PATH'),('priority','desktop/renderer.html',"const priorityDriverIntent=driverIntent.priority===true;","const priorityDriverIntent=false;",{'turns':['先に入る'],'shadow':True},'WO012_RENDERER_PATH')]
  evidence=[]
  for label,file,old,new,args,env in cases:
   source=(root/file).read_text();self.assertIn(old,source)
   with tempfile.NamedTemporaryFile(mode='w',suffix='.js' if env.endswith('ROUTER_PATH') else '.html') as f:
    f.write(source.replace(old,new));f.flush()
    with patch.dict(os.environ,{env:f.name}):r,s=self.run_probe(**args)
   with self.assertRaises(AssertionError):
    if label=='priority':self.assertEqual(1,len(s['probe']['sent']))
    else:self.assertEqual(0,len(s['probe']['sent']))
   evidence.append({'guard':label,'same_assert':'RED','wire_count':len(s['probe']['sent'])})
  Path('/tmp/wo012-mutations.json').write_text(json.dumps(evidence,indent=2))
 def test_reason_boundary(self):
  for turns,expected in [(['前の25が遅いから先に入る'],['driver_plan_command']),(['先に入る','前の25が遅いから先に入る'],['driver_plan_command','driver_plan_reason']),(['先に入る','前の25が遅いから14周でピット入る'],['driver_plan_command','driver_plan_command'])]:
   r,s=self.run_probe(turns);self.assertEqual(expected,[x['cmd'] for x in s['probe']['sent']]);self.assertTrue(s['probe']['sent'][-1].get('reason_text'))

if __name__=='__main__':unittest.main()
