"""WO011 actual Renderer fallback -> temp journal -> actual WS -> poll -> canonical readback."""
import asyncio,json,os,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import bridge,replay_harness as rh,tests_wo001_road_atlanta_fixture as road
ROOT=Path(__file__).resolve().parent

def receive(message):
 class Socket:
  async def send(self,data):pass
  def __aiter__(self):return self
  async def __anext__(self):
   if hasattr(self,'done'):raise StopAsyncIteration
   self.done=True;return json.dumps(message)
 with patch.object(bridge,'log',lambda x:None),patch.object(bridge,'list_input_devices',lambda:[]):asyncio.run(bridge.handler(Socket()))

def desktop(data):
 with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as f:
  json.dump(data,f);f.flush()
  return json.loads(subprocess.check_output(['node',str(ROOT/'wo011_desktop_fixture.js'),f.name]))

class ActualProjection(unittest.TestCase):
 def run_route(self,text,invalid=False):
  state={};frames=road.clean_laps(8)[0];bridge._pending_driver_plan_commands=[]
  def hook(cursor,frame,result):
   live=[x for x in result.broadcasts if x.get('type')=='telemetry_live' and x.get('active_plan_decision_id')]
   if live and not state:
    state['initial']=live[-1];state['request']=desktop({'initial':live[-1],'text':text})
    receive(state['request']['command'])
    if invalid:frame['SessionFlags']=0x10000
  result=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO,on_frame_ready=hook)
  request=state['request'];readback=desktop({'mode':'readback','initial':state['initial'],'events':result.broadcasts,'command':request['command'],'journal_dir':request['journal_dir']})
  return result,state,readback
 def test_legacy_amend_actual_request_ack_then_canonical_readback(self):
  r,s,o=self.run_route('やっぱり10周');self.assertEqual('amend',s['request']['command']['intent']);self.assertEqual(1,s['request']['persisted']);self.assertEqual(0,s['request']['early_success_speech']);self.assertEqual(0,o['before_canonical_speech']);self.assertEqual(0,o['outbox']);self.assertEqual(1,len(o['spoken']));self.assertIn('10周目',o['spoken'][0]);self.assertEqual(10,o['current_plan']['lap']);self.assertEqual(1,o['receipts'])
 def test_cancel_actual_route_terminal_readback(self):
  r,s,o=self.run_route('このプランを取り消す');self.assertEqual('cancel',s['request']['command']['intent']);self.assertEqual(0,o['before_canonical_speech']);self.assertEqual(1,len(o['spoken']));self.assertIn('取り消した',o['spoken'][0]);self.assertTrue(any(t['phase']=='cancelled' for t in o['terminals']))
 def test_early_actual_route_invalidated_without_fake_pit_exit(self):
  r,s,o=self.run_route('この周でピットインだ');self.assertEqual('early_pit',s['request']['command']['intent']);self.assertEqual(0,o['before_canonical_speech']);self.assertEqual(1,len(o['spoken']));self.assertTrue(any(t['phase']=='invalidated' for t in o['terminals']));self.assertFalse(any(x.get('pit_ledger',{}).get('events') for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot'))
 def test_reject_keeps_canonical_plan_and_never_speaks_change(self):
  r,s,o=self.run_route('やっぱり10周',invalid=True);self.assertFalse(any('変更した' in t for t in o['spoken']));acks=[e for e in r.broadcasts if e.get('type')=='driver_plan_command_ack'];self.assertEqual('rejected',acks[0]['outcome']);self.assertNotIn('successor_decision_id',acks[0]);self.assertEqual(0,o['outbox'])

if __name__=='__main__':unittest.main()
