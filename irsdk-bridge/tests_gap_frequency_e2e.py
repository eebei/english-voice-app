"""No forecast/provider double: SDK noise -> real Bridge -> all Renderer -> speech.
The faster-class target remains the same through one-tick track-data dropouts.
"""
import json,os,traceback
from pathlib import Path
import tests_wo019_road_atlanta_e2e as h
import replay_harness as rh
import tests_wo001_road_atlanta_fixture as road
ROOT=str(Path(__file__).resolve().parent.parent)
INFO=road.ROAD_ATLANTA_SESSION_INFO.replace('CarClassShortName: GT3','CarClassShortName: GT3\n   CarClassRelSpeed: 1')
start=INFO.index(' - CarIdx: 1');end=INFO.index(' - CarIdx: 2')
INFO=INFO[:start]+INFO[start:end].replace('CarClassID: 100','CarClassID: 200').replace('CarClassShortName: GT3','CarClassShortName: GTP').replace('CarClassRelSpeed: 1','CarClassRelSpeed: 2')+INFO[end:]
def frames():
 out=[]
 for i in range(145):
  gap=10. if i<45 else 6.2-.22*((i-45)%12) if i<95 else 2.8-.2*(i-95) if i<102 else -.5
  own=2.2+i/108;progress=[own,own-gap/108,own-.10];laps=[int(v) for v in progress];q=[v-int(v) for v in progress]
  surfaces=[3,2 if 45<=i<95 and (i-45)%12==11 else 3,3]
  out.append(rh.make_frame(SessionTime=1000+i,Lap=laps[0],LapDistPct=q[0],LapLastLapTime=0. if i<5 else 108.,FuelLevel=45-.02*i,CarLeftRight=2 if 75<=i<=76 else 0,PlayerCarPosition=2,PlayerCarClassPosition=1,
   CarIdxLap=laps,CarIdxLapCompleted=[l-1 for l in laps],CarIdxLapDistPct=q,CarIdxLastLapTime=[108.,100.,110.],CarIdxTrackSurface=surfaces,CarIdxClassPosition=[1,1,2],CarIdxPosition=[2,1,3],CarIdxOnPitRoad=[False]*3))
 return out

class CapturedThread(h.Thread):
 """Observe the socket bytes delivered to Renderer, after real admission gates."""
 def __init__(self,root):
  self.received=[]
  super().__init__(root)
 def deliver(self):
  if self.ws is None:return None
  self.wire.barrier()
  raws=self.ws.take_sent()
  self.received.extend({'frame':self.cursor,'event':json.loads(raw)} for raw in raws)
  r=self.desktop.send('ws_deliver',messages=raws,nowMs=self.now_ms())
  self.forward(r['outbound'])
  return r

def main():
 t=CapturedThread(ROOT)
 try:
  t.run(frames(),INFO);t.advance(12000);obs=t.observe(observability=True)
  spoken=[u for u in obs['utterances'] if u.get('kind')=='multiclass' and 'completed' in u.get('states',[])]
  mc=[x['event'] for x in t.received if x['event'].get('type')=='radio' and x['event'].get('trigger')=='multiclass']
  prep=[b for b in mc if b.get('stage')==1];urgent=[b for b in mc if b.get('stage')==2]
  checks={'single_preparation_despite_dropouts':len(prep)==1,'preparation_P4':bool(prep) and all(b.get('prio')==4 for b in prep),'imminent_P1_preserved':bool(urgent) and all(b.get('prio')==1 for b in urgent),
   'both_stages_completed':len(spoken)==2,'spotter_completed':any(u.get('kind')=='side_by_side' and 'completed' in u.get('states',[]) for u in obs['utterances']),'timer_errors0':not obs.get('timerErrors')}
  out={'checks':checks,'radio':mc,'received':t.received,'generated_candidates':t.result.broadcasts,'utterances':obs['utterances'],'logs':t.result.logs,'outbound':t.to_bridge}
  dest=Path(os.environ.get('GAP_FREQUENCY_E2E_OUTPUT','/tmp/gap-frequency-e2e.json'));dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(json.dumps(out,ensure_ascii=False,indent=2,default=str));print(json.dumps({'checks':checks,'output':str(dest)},indent=2));return 0 if all(checks.values()) else 1
 except Exception as exc:
  out={'received':t.received,'error':str(exc),'traceback':traceback.format_exc(),'logs':getattr(getattr(t,'result',None),'logs',[]),'broadcasts':getattr(getattr(t,'result',None),'broadcasts',[]),'outbound':getattr(t,'to_bridge',[])}
  dest=Path(os.environ.get('GAP_FREQUENCY_E2E_OUTPUT','/tmp/gap-frequency-e2e.json'));dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(json.dumps(out,ensure_ascii=False,indent=2,default=str));print(json.dumps({'error':str(exc),'output':str(dest)}));return 1
 finally:t.close()
if __name__=='__main__':raise SystemExit(main())
