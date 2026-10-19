"""Test-only fresh-process production poll runner; no canonical state injection."""
import json,sys,functools,subprocess,tempfile,asyncio,os
from unittest.mock import patch
import bridge
from pathlib import Path
import replay_harness as rh
import tests_bridge_actual_pit_lifecycle_wiring as actual
import tests_wo001_road_atlanta_fixture as road
import canonical_lifecycle_snapshot as cs
mode,path,exchange=sys.argv[1:4]
# WO015 concurrency-hazard fix: these were fixed /tmp paths shared across
# EVERY invocation of this runner. Two concurrent restart_vertical/
# restart_report_crash calls (confirmed reproducible: 4 concurrent runs ->
# 3/4 box_delivery_ack applied='rejected', each reading the OTHER's
# candidate/snapshot) raced on them. Derived from `exchange`'s own directory
# instead -- callers always pass a fresh tempfile.TemporaryDirectory(), and
# the two same-test restart_report_crash->restart_report calls that
# deliberately hand a report off between runs share the SAME `exchange`
# directory, so that intentional handoff still works.
WIRE_PATH=str(Path(exchange).parent/'wo010-restart-new-wire.json')
REPORT_PATH=str(Path(exchange).parent/'wo010-desktop-restart-report.json')
if os.environ.get('WO010_MUTATION')=='skip_restore':
    _original_init=bridge.recovery_mod.Store.__init__
    def mutated_init(self,path):
        _original_init(self,path);self.loaded=None
    bridge.recovery_mod.Store.__init__=mutated_init
if os.environ.get('WO010_MUTATION') in ('skip_commit','skip_before_send'):
    _real_commit=bridge.recovery_mod.Store.commit
    def skipped_commit(self,scope,epoch,domains):
        if os.environ['WO010_MUTATION']=='skip_commit' or any(a['status']=='created' for a in domains['box'].attempts.values()):return 'mutation-unwritten-checkpoint'
        return _real_commit(self,scope,epoch,domains)
    bridge.recovery_mod.Store.commit=skipped_commit
def receive(message):
    class Socket:
        def __init__(self):self.sent=[]
        async def send(self,data):self.sent.append(json.loads(data))
        def __aiter__(self):return self
        async def __anext__(self):
            if hasattr(self,'done'):raise StopAsyncIteration
            self.done=True;return json.dumps(message)
    socket=Socket()
    with patch.object(bridge,'log',lambda x:None),patch.object(bridge,'list_input_devices',lambda:[]):
        asyncio.run(bridge.handler(socket))
    return socket.sent

def desktop_command(live):
    with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as f:
        json.dump(live,f);f.flush()
        return json.loads(subprocess.check_output(['node',str(Path(__file__).parent/'wo008_desktop_command_fixture.js'),f.name]))

if mode in ('first_created','restart_report_crash'):
    _commit=bridge.recovery_mod.Store.commit
    def crash_after_created(self,scope,epoch,domains):
        result=_commit(self,scope,epoch,domains)
        if mode=='first_created' and any(a['status']=='created' for a in domains['box'].attempts.values()) or mode=='restart_report_crash' and domains['box'].reports:raise rh.ReplayComplete()
        return result
    bridge.recovery_mod.Store.commit=crash_after_created

if mode in ('first_finished' ,'first_active','first_open','first_constraint','first_box','first_created','first_sent'):

    original=rh.replay
    rh.replay=functools.partial(original,recovery_path=path)
    if mode=='first_finished':r,_=actual.ActualLifecyclePoll().run_pit(normal=True,finish=True)
    elif mode=='first_active':r=original(actual.base(),session_info=road.ROAD_ATLANTA_SESSION_INFO,recovery_path=path)
    elif mode in ('first_constraint','first_box','first_created','first_sent'):
        frames=road.clean_laps(12)[0];state={}
        def hook(cursor,frame,result):
            live=[x for x in result.broadcasts if x.get('type')=='telemetry_live' and x.get('active_plan_decision_id')]
            if live and not state:
                state['command']=desktop_command(live[-1]);receive(state['command'])
            acks=[x for x in result.broadcasts if x.get('type')=='driver_plan_command_ack' and x.get('outcome')=='applied']
            if acks and not state.get('reason'):
                ack=acks[-1]
                reason=dict(state['command'],cmd='driver_plan_reason',reason_event_id='wo010-reason',reason_text='Driver target stays ten')
                state['reason']=reason;receive(reason)
            reasonacks=[x for x in result.broadcasts if x.get('type')=='driver_plan_command_ack' and x.get('intent')=='reason']
            boxes=result.by_trigger('strategy_plan_box_call')
            if mode=='first_constraint' and reasonacks or mode=='first_box' and boxes:
                result.live_frames[cursor:]=[]
        def dispatch(event):
            if event.get('trigger')=='strategy_plan_box_call':
                # Product broadcast boundary, before mark_dispatch. Verify the
                # exact immutable proof and original dispatch refs are on disk.
                saved=bridge.recovery_mod.Store(path).loaded['decoded']
                assert event['box_attempt']['attempt_id'] in saved['box'].attempts,'candidate proof not committed before broadcast'
                attempt=saved['box'].attempts[event['box_attempt']['attempt_id']]
                assert attempt['authority_proof']['proof_id']==event['authority_proof']['proof_id']
                assert all(attempt['canonical_dispatch_ref'][k]==event[k] for k in ('bridge_process_epoch','canonical_snapshot_id','canonical_snapshot_sequence'))
                if mode in ('first_created','first_sent'):raise rh.ReplayComplete()
            return bridge.BROADCAST_DISPATCHED
        r=original(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO,on_frame_ready=hook,recovery_path=path,dispatch_result=dispatch)
    else:
        frames=actual.base();marked=[]
        def hook(cursor,frame,result):
            active=[x for x in result.broadcasts if x.get('type')=='canonical_lifecycle_snapshot' and x.get('lifecycle',{}).get('active')]
            if active and not marked:
                marked.append(True);record=active[-1]['lifecycle']['active']
                pit,_,_,_=road.pit_visit(lap=record['target_lap'],fuel_before=30,fuel_added=5,start_time=400)
                result.live_frames[cursor:]=pit[:4]
        r=original(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO,on_frame_ready=hook,recovery_path=path)

    frames=r.live_frames[-10:]
    if mode=='first_open':
        last=r.live_frames[-1];frames=[rh.make_frame(SessionTime=410+i,Lap=last['Lap'],OnPitRoad=None if i==0 else False,IsOnTrack=True,FuelLevel=35) for i in range(4)]
    Path(exchange).write_text(json.dumps({'frames':frames,'session_info':road.ROAD_ATLANTA_SESSION_INFO,'command':state.get('command') if mode in ('first_constraint','first_box','first_created','first_sent') else None,'candidate':r.by_trigger('strategy_plan_box_call')[-1] if r.by_trigger('strategy_plan_box_call') else None}))
else:
    data=json.loads(Path(exchange).read_text())
    if mode=='restart_new':
        data['frames']=actual.base()
        for f in data['frames']:f['SessionTime']+=800
    if mode=='restart_pending':
        last=data['frames'][-1]
        data['frames']=[rh.make_frame(SessionTime=700+i,Lap=5,FuelLevel=last['FuelLevel']) for i in range(4)]
    if mode in ('restart_constraint','restart_proof','restart_vertical','restart_report_crash','restart_same_id'):
        data['frames']=road.clean_laps(12,start_time=800)[0]
    requests=[]
    if mode=='restart_history':
        requests=[{'cmd':'historical_settlement','kind':'driver_plan_command','payload':data['command']},
                  {'cmd':'historical_settlement','kind':'driver_plan_command','payload':data['command']},
                  {'cmd':'historical_settlement','kind':'driver_plan_command','payload':dict(data['command'],text='different')},
                  {'cmd':'historical_settlement','kind':'driver_plan_command','payload':dict(data['command'],command_id='unknown')}]
        if data.get('candidate'):
            box=data['candidate'];report=dict(box['box_attempt'],**{k:box[k] for k in ('bridge_process_epoch','canonical_snapshot_id','canonical_snapshot_sequence')},outcome='audible_started',report_event_id='late-start')
            requests.extend([{'cmd':'historical_settlement','kind':'box_delivery_report','payload':report}]*2)
    if mode=='restart_report':
        requests=[{'cmd':'historical_settlement','kind':'box_delivery_report','payload':json.loads(Path(REPORT_PATH).read_text())}]
    state={}
    def hook(cursor,frame,result):
        snapshots=[x for x in result.broadcasts if x.get('type')=='canonical_lifecycle_snapshot' and x.get('telemetry_available')]
        if snapshots and requests and not state:
            state['received']=True
            for request in requests:receive(request)
        if mode=='restart_same_id' and snapshots and snapshots[-1]['lifecycle']['active'] and not state:
            live=[x for x in result.broadcasts if x.get('type')=='telemetry_live' and x.get('active_plan_decision_id')]
            if live:
                state['command']=desktop_command(live[-1]);receive(state['command'])
        if mode=='restart_same_id' and state:
            acks=[x for x in result.broadcasts if x.get('type')=='driver_plan_command_ack' and x.get('outcome')=='applied']
            if acks:result.live_frames[cursor:]=[]
        boxes=result.by_trigger('strategy_plan_box_call')
        if mode in ('restart_proof','restart_vertical','restart_report_crash') and boxes and not state.get('desktop'):
            b=boxes[-1];idx=result.broadcasts.index(b)
            wire={'canonical':next(x for x in result.broadcasts if x.get('snapshot_id')==b['canonical_snapshot_id']),
                  'snapshot':result.broadcasts[idx-1],'candidate':b}
            Path(WIRE_PATH).write_text(json.dumps(wire))
            data['frames']=result.live_frames[max(0,cursor-1):cursor+3]
            Path(exchange).write_text(json.dumps(data))
            if mode in ('restart_vertical','restart_report_crash'):
                env=dict(os.environ,WO010_RESTART_WIRE=WIRE_PATH,WO010_RESTART_REPORT_OUT=REPORT_PATH)
                result_node=subprocess.run(['node',str(Path(__file__).parent.parent/'tests-critical-journal.js')],env=env,cwd=Path(__file__).parent.parent,capture_output=True,text=True)
                if result_node.returncode:raise AssertionError(result_node.stdout+result_node.stderr)
                state['desktop']=result_node.stdout
                receive(json.loads(Path(REPORT_PATH).read_text()))
            else:result.live_frames[cursor:]=[]
        if mode in ('restart_vertical','restart_report_crash') and state.get('desktop'):
            acks=[x for x in result.broadcasts if x.get('type')=='box_delivery_ack' and x.get('applied')=='applied']
            if acks:
                wire=json.loads(Path(WIRE_PATH).read_text());wire['ack']=acks[-1]
                Path(WIRE_PATH).write_text(json.dumps(wire))
                result.live_frames[cursor:]=[]
    r=rh.replay(data['frames'],session_info=data['session_info'],recovery_path=path,on_frame_ready=hook)
    if mode=='restart_report':
        # Same-process receipt retry uses the original dispatch reference after
        # Renderer play, with no restart between candidate and report in real use.
        pass
snaps=[b for b in r.broadcasts if b.get('type')=='canonical_lifecycle_snapshot' and b.get('telemetry_available')]
print(json.dumps({'epoch':cs.PROCESS_EPOCH,'snapshots':snaps,'broadcasts':r.broadcasts,'logs':r.logs},allow_nan=False))
