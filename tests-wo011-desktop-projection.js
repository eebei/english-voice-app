#!/usr/bin/env node
'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm'),path=require('path'),os=require('os'),child=require('child_process');
const WO017Scope=require('./tests-wo017-memory-scope-harness');
const C=require('./desktop/canonical-lifecycle-cache'),P=require('./desktop/strategy-state-projection'),Router=require('./desktop/local-intent-router');
const renderer=fs.readFileSync(path.join(__dirname,'desktop/renderer.html'),'utf8');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wo011-projection-')),wire=path.join(temp,'producer.json');
child.execFileSync('python3',['-c',`import sys,json;sys.path.insert(0,'irsdk-bridge');import replay_harness as rh,tests_wo001_road_atlanta_fixture as road
r=rh.replay(road.clean_laps(8)[0],session_info=road.ROAD_ATLANTA_SESSION_INFO)
s=[x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot' and x.get('lifecycle',{}).get('active') and x['telemetry_available']]
assert len(s)>2
open(sys.argv[1],'w').write(json.dumps(s))`,wire],{cwd:__dirname,timeout:20000});
const pitWire=path.join(temp,'pit-producer.json');
child.execFileSync('python3',['-c',`import sys,json;sys.path.insert(0,'irsdk-bridge');from tests_bridge_actual_pit_lifecycle_wiring import ActualLifecyclePoll
x=ActualLifecyclePoll();out={}
for kind,args in [('normal',dict(normal=True)),('penalty',dict(normal=True,flags=0x10000)),('unresolved',dict(normal=True,flags=None))]:
 r,_=x.run_pit(**args)
 candidates=[s for s in r.broadcasts if s.get('type')=='canonical_lifecycle_snapshot' and s['pit_ledger']['events'] and s['pit_ledger']['events'][-1]['execution_relation']==kind]
 assert candidates,kind
 out[kind]=candidates[0]
open(sys.argv[1],'w').write(json.dumps(out))`,pitWire],{cwd:__dirname,timeout:20000});
const radioWire=path.join(temp,'radio-producer.json');
child.execFileSync('python3',['-c',`import sys,json;sys.path.insert(0,'irsdk-bridge');import replay_harness as rh;from tests_bridge_fuel_safety_override_replay import build_frames,SESSION_INFO
r=rh.replay(build_frames(),session_info=SESSION_INFO)
w=next(x for x in r.broadcasts if x.get('trigger')=='fuel_strategy_warning')
c=next(x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot' and x['snapshot_id']==w['canonical_snapshot_id'])
t=next(x for x in r.broadcasts if x.get('type')=='telemetry_live' and x.get('canonical_snapshot_id')==w['canonical_snapshot_id'])
open(sys.argv[1],'w').write(json.dumps(dict(snapshot=c,radio=w,telemetry=t)))`,radioWire],{cwd:__dirname,timeout:20000});
const radioProducer=JSON.parse(fs.readFileSync(radioWire,'utf8'));
const pitSnapshots=JSON.parse(fs.readFileSync(pitWire,'utf8'));
const snapshots=JSON.parse(fs.readFileSync(wire,'utf8'));const base=snapshots[0];assert(C.validate(base));
const copy=x=>JSON.parse(JSON.stringify(x));let checks=0;const check=x=>{assert(x);checks++;};
function extract(n){const m=renderer.match(new RegExp('(?:async )?function '+n+'\\([^]*?\\n\\}'));if(!m)throw Error('Missing '+n);return m[0];}
function make(){let clock=0,uuid=0;const storage=new Map();const sockets=[],messages=[],speech=[],sent=[],nodes=new Map();
const node=n=>{if(!nodes.has(n))nodes.set(n,{value:'',style:{},dataset:{},classList:{add(){},remove(){}},textContent:''});return nodes.get(n);};
const cache=C.create({now:()=>clock});const projection=P.create({canonical:cache,now:()=>clock});
const c={console,Date,Math,Map,Set,AbortController,performance:{now:()=>clock},canonicalLifecycleCache:cache,strategyProjection:projection,
 document:{getElementById:node},irBridge:null,bridgeConnected:false,boxAuthorityTransport:{setConnected(){},setEpoch(){},tick(){},flush(){}},
 DECISION_STORE_KEY:'pw_decisions',canonicalHistoryPending:new Map(),localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},decisionModule:()=>require('./desktop/decision-memory'),currentDecisionIdentity:()=>({userId:'10101',track:'Road Atlanta',carClass:'GT3',carModel:'Mercedes',raceFormat:'race'}),criticalJournal:{healthy:()=>true,key:(k,e)=>e.command_id,retire:()=>true},driverPlanCommandOutbox:new Map(),pendingCanonicalCommandReadbacks:new Map(),pendingDriverPlanFollowup:null,
 strategyPlaybookDecisionKeys:new Set(),bridgeStrategyDecisions:new Map(),strategyResponseOutbox:new Map(),strategyDeliveryOutbox:new Map(),speakQueue:[],currentSpeakItem:null,
 liveStrategyValidation:null,usageSessionId:'u',updateBridgeStatus(){},bridgeVoice(){},reportRuntimeModuleStatus(){},sendChiefEngineerSettings(){},flushDriverPlanCommandOutbox(){},flushStrategyResponseOutbox(){},flushStrategyDeliveryOutbox(){},
 buildCurrentRaceContext:()=>null,  // WO014: raceContext builder out of scope for this canonical-projection test
 WebSocket:class{constructor(){this.readyState=1;sockets.push(this);}send(x){sent.push(JSON.parse(x));}close(){this.readyState=3;}},
 setTimeout:()=>1,clearTimeout(){},diagnosticLog(){},isJapaneseEngineer:()=>true,confirmCanonicalCommandReadbacks(){},finalizeUtterance(){},stopCurrentAudio(){},
 isBusy:false,sel:'LunaJP',selMode:'race',iracingLive:true,lastSessionNum:base.session_num,lastTelemetryAt:Date.now(),lastTrack:'Road Atlanta',lastCarClass:'GT3',lastCarModel:'Mercedes',
 lastTelemetry:{race_instance_id:base.race_instance_id,session_num:base.session_num,lap:10,fuel:99,active_plan_lap:99,strategy_plan:{target_lap:99},on_pit_road:null},
 _strategyStateBox:{pit_plan:{lap:99},pit_executed:{lap:10}},activeStrategyPlaybook:{available:true,plans:{A:{first_pit_lap:99}}},activeRaceFacts:{pit_plan:{lap:99}},
 captureConfirmedFuelCapacity(){},maybeQuietMode(){},prepareMemoryBrain(){},pendingConfirmationKinds:()=>[],bareConfirmationAnswer:()=>null,handleLunaSelfMemoryInput:()=>null,
 turns:0,sessionMsgCount:0,usageCount(){},nextUtteranceId:()=> 'u'+(++uuid),pendingDecisionDispute:null,
 addMsg:(who,text)=>{messages.push({who,text});return null;},pushMsg:x=>messages.push(x),speak:(text,o)=>speech.push({text,o}),
 SPEAK_PRIO:{P0_SAFETY:0,P1_HAZARD:1,P2_PROCEDURE:2,P3_INFO:3,P4_INFO:4},loadRaceHistory:()=>[{pit_plan:{lap:99}}],currentMemoryUserId:()=> 'fake',currentMemoryIdentity:()=>({}),
 currentGapHeld:()=>null,queueDriverPlanCommand:()=>null,sendDriverPlanReason:()=>false,sendStrategyDecisionResponse:(id,accepted)=>sent.push({cmd:'strategy_decision_response',decision_id:id,accepted}),
};c.window=c;c.globalThis=c;c.PitwallLocalIntentRouter=Router;c.PitwallStrategyPlaybook={};vm.createContext(c);
for(const n of ['syncFuelReferenceEvidence','ensureStrategyState','currentStrategyStateAPI','currentStrategyPlaybook','currentCanonicalStrategyLive','buildActiveRaceFactsNote','observePitState','syncCanonicalStrategyProjection','connectBridge','sendMsg','handleDriverPlanCommandAck','confirmCanonicalCommandReadbacks','loadDecisions','saveDecisions','syncCanonicalDecisionHistory','recordDecisionStage',
 // WO017: real race-scope helpers the decision ledger now joins through (not stubbed)
 'decisionRaceScopeOf','currentMemoryRaceScope','knownOwnerGeneration'])vm.runInContext(extract(n),c);
vm.runInContext((renderer.match(/const DECISION_OWNER_GEN_KEY='[^']+';/)||[''])[0].replace('const ','var '),c);
c.PitwallRaceMemoryScope=require('./desktop/race-memory-scope');vm.runInContext((renderer.match(/const memoryRaceScope=[\s\S]*?:null;/)||[''])[0].replace('const memoryRaceScope','var memoryRaceScope'),c);
return {ctx:c,cache,projection,node,sockets,storage,sent,messages,speech,clock:n=>clock=n,connect:(epoch=base.bridge_process_epoch)=>{c.connectBridge();const socket=sockets.at(-1);socket.onopen();socket.onmessage({data:JSON.stringify({type:'connected',schema_version:1,bridge_process_epoch:epoch})});return socket;},receive:s=>sockets.at(-1).onmessage({data:JSON.stringify(s)}),ask:async text=>{node('chat-input').value=text;await c.sendMsg('typed');return messages.filter(x=>x.who==='ai').at(-1)?.text;}};
}
(async()=>{
 const r=make();r.connect();check(r.ctx.ensureStrategyState().pit_plan===null);r.ctx.observePitState({on_pit_road:null});r.ctx.observePitState({on_pit_road:true});check(r.ctx.ensureStrategyState().pit_executed===null);
 const paired=make();paired.connect();const legacy=require('./desktop/session-strategy-state');paired.ctx._strategyStateBox=legacy.create({session_key:'same-race'});legacy.agreePitPlan(paired.ctx._strategyStateBox,{lap:12,source:'driver',at:1});paired.ctx.observePitState({lap:10,on_pit_road:null});paired.ctx.observePitState({lap:10,on_pit_road:true});const pairedAfter=paired.ctx.ensureStrategyState(),pairedReply=paired.ctx.currentStrategyStateAPI().answerPitDecision(pairedAfter,{laps_remaining:9}).reply;check(pairedAfter.pit_executed===null);check(pairedAfter.pit_plan===null);check(!/ピット済み|走り切/.test(pairedReply));let requestAction;paired.ctx.queueDriverPlanCommand=action=>{requestAction=action;return null;};const amendReply=await paired.ask('やっぱり14周');check(requestAction.requestedTargetLap===14);check(paired.ctx.ensureStrategyState().pit_plan===null);check(!amendReply.includes('変更した'));
 fs.writeFileSync('/tmp/wo011-after-beforecomparison.json',JSON.stringify({canonical_snapshot_seen:false,bridge_ack_seen:false,seed_legacy_plan_lap:12,raw_pit_sequence:[null,true],raw_lap:10,after_local_unknown_to_true:pairedAfter,pit_answer:pairedReply,amend:{input:'やっぱり14周',request_action:requestAction,current_plan:paired.ctx.ensureStrategyState().pit_plan,reply:amendReply,command_wire_count:paired.sent.filter(x=>x.cmd==='driver_plan_command').length},comparison_scope:'actual Renderer helper/router/sendMsg paired local-before scenario; no canonical and no ACK; distinct from actual Bridge command vertical'},null,2));
 const absent=await r.ask('何周目にピット？');check(!/99|ピット済み|走り切/.test(absent||''));check(r.ctx.buildActiveRaceFactsNote(true).includes('unavailable'));
 r.receive(base);const active=base.lifecycle.active;check(r.ctx.ensureStrategyState().pit_plan.lap===active.target_lap);check(r.node('canonical-strategy-view').textContent.includes(String(active.target_lap)));check(r.node('canonical-strategy-view').dataset.canonicalRef.includes(base.snapshot_id));
 const historyRow=r.ctx.loadDecisions().find(x=>x.decision_id===active.decision_id);check(historyRow.authority_role==='historical_reference');check(historyRow.canonical_lifecycle.record_ref.decision_id===active.decision_id);const rowsBefore=r.ctx.loadDecisions().length;r.ctx.syncCanonicalDecisionHistory();check(r.ctx.loadDecisions().length===rowsBefore);
 const forged=r.ctx.loadDecisions();forged.push({...historyRow,decision_id:'old-forged',updated_at:Date.now()+999999,decision_plan:{target_lap:99},authority_role:'historical_reference'});r.ctx.saveDecisions(forged);r.ctx.recordDecisionStage('proposal',{decision_id:'old-forged',decision_plan:{target_lap:99}});check(r.ctx.ensureStrategyState().pit_plan.lap===active.target_lap);
 const answer=await r.ask('何周目にピット？');check(answer.includes(String(active.target_lap)));check(!answer.includes('99'));check(r.speech.at(-1).o.strategyBinding);check(r.ctx.buildActiveRaceFactsNote(true).includes(active.decision_id));check(r.ctx.currentStrategyPlaybook().active_record.decision_id===active.decision_id);
 r.ctx.observePitState({on_pit_road:true});check(r.ctx.ensureStrategyState().pit_executed===null);check(r.ctx.ensureStrategyState().pit_plan.lap===active.target_lap);
 const refs=r.projection.binding();const next=copy(base);next.snapshot_sequence+=1;next.snapshot_id=next.bridge_process_epoch+':'+next.snapshot_sequence;r.clock(100);r.receive(next);check(r.projection.validBinding(refs));
 r.clock(5000);check(!r.projection.validBinding(refs));r.clock(5100);r.ctx.syncCanonicalStrategyProjection();check(r.ctx.ensureStrategyState().pit_plan===null);check(r.node('canonical-strategy-view').textContent.includes('確認できない'));check(!r.ctx.buildActiveRaceFactsNote(true).includes(active.decision_id));
 // Reference candidates retain original calculation age and cannot become current agreement.
 const consult=make();consult.connect();const optionsFrame=copy(base);optionsFrame.recommendations.strategy_options={role:'recommendation_not_execution',calculation_source:{source_frame_sequence:Math.max(0,optionsFrame.source_frame.sequence-1),session_time_s:optionsFrame.source_frame.session_time_s-20},value:{available:true,selected_plan:'A',plan_a:{available:true,target_lap:active.target_lap},plan_b:{available:false,target_lap:99,reason:'no_undercut_room',conditions_required:['relative_pace_advantage','rejoin_clear']},plan_c:{available:false,target_lap:98,reason:'conditions_unproven',conditions_required:['fuel_save_on_target','rejoin_not_worse']}}};consult.receive(optionsFrame);
 const undercut=await consult.ask('アンダーカットいける？');check(undercut.includes('今は選べない'));check(undercut.includes('早入りできる余地がない'));check(undercut.includes('実測ペース優位'));check(undercut.includes('合意中はPlan '+active.selected_plan));check(undercut.includes('20.0秒前'));check(!undercut.includes('99周'));check(consult.ctx.ensureStrategyState().pit_plan.lap===active.target_lap);
 const overcut=await consult.ask('オーバーカットいける？');check(overcut.includes('今は選べない'));check(overcut.includes('燃費目標達成'));check(!overcut.includes('98周'));
 for(const badSource of [{source_frame_sequence:optionsFrame.source_frame.sequence+1,session_time_s:optionsFrame.source_frame.session_time_s},{source_frame_sequence:optionsFrame.source_frame.sequence,session_time_s:optionsFrame.source_frame.session_time_s+1}]){const bad=copy(optionsFrame);bad.snapshot_sequence=consult.cache.current().snapshot_sequence+1;bad.snapshot_id=bad.bridge_process_epoch+':'+bad.snapshot_sequence;bad.recommendations.strategy_options.calculation_source=badSource;consult.receive(bad);const heldAnswer=await consult.ask('アンダーカットいける？');check(heldAnswer.includes('計算根拠を確認できない'));check(!/99|今周ピット|比較条件は成立/.test(heldAnswer));}
 const windowRenderer=make();windowRenderer.connect();const windowFrame=copy(optionsFrame);windowFrame.recommendations.strategy_options.value.plan_b={available:true,fuel_window_open:true,target_lap:99,target_in_laps:4};windowRenderer.ctx.lastTelemetry.strategy_options={available:true,plan_b:{available:true,fuel_window_open:true,target_in_laps:4,target_lap:99}};windowRenderer.receive(windowFrame);
 windowRenderer.ctx.fuelWindowWatch={armed:true,sessionKey:String(base.session_num),announced:false};windowRenderer.ctx.isSessionEndingLifecycle=()=>false;vm.runInContext(extract('maybeDeliverFuelWindowWatch'),windowRenderer.ctx);windowRenderer.ctx.maybeDeliverFuelWindowWatch(windowRenderer.ctx.lastTelemetry);check(!windowRenderer.ctx.fuelWindowWatch.announced);
 const oldWindow=await windowRenderer.ask('燃料ウィンドウ開いてる？');check(oldWindow.includes('20.0秒前の比較計算'));check(!/あと4周|今周入れる|今周ピット/.test(oldWindow));
 const futureWindow=copy(windowFrame);futureWindow.snapshot_sequence++;futureWindow.snapshot_id=futureWindow.bridge_process_epoch+':'+futureWindow.snapshot_sequence;futureWindow.recommendations.strategy_options.calculation_source.session_time_s=futureWindow.source_frame.session_time_s+1;windowRenderer.receive(futureWindow);windowRenderer.ctx.maybeDeliverFuelWindowWatch(windowRenderer.ctx.lastTelemetry);check(!windowRenderer.ctx.fuelWindowWatch.announced);const unavailableWindow=await windowRenderer.ask('燃料ウィンドウ開いてる？');check(unavailableWindow.includes('計算根拠を確認できない'));check(!/あと4周|今周入れる|比較条件は成立/.test(unavailableWindow));
 const freshWindow=copy(futureWindow);freshWindow.snapshot_sequence++;freshWindow.snapshot_id=freshWindow.bridge_process_epoch+':'+freshWindow.snapshot_sequence;freshWindow.recommendations.strategy_options.calculation_source={source_frame_sequence:freshWindow.source_frame.sequence,session_time_s:freshWindow.source_frame.session_time_s};windowRenderer.receive(freshWindow);const currentWindow=await windowRenderer.ask('燃料ウィンドウ開いてる？');check(currentWindow.includes('比較条件は成立'));check(currentWindow.includes('現在合意中のPlan'));check(!/あと4周|今周入れる|今周ピット/.test(currentWindow));
 windowRenderer.ctx.fuelWindowWatch={armed:true,sessionKey:String(base.session_num),announced:false};windowRenderer.ctx.isSessionEndingLifecycle=()=>false;vm.runInContext(extract('maybeDeliverFuelWindowWatch'),windowRenderer.ctx);windowRenderer.ctx.maybeDeliverFuelWindowWatch(windowRenderer.ctx.lastTelemetry);check(windowRenderer.ctx.fuelWindowWatch.announced);check(windowRenderer.speech.at(-1).text.includes('比較候補'));check(windowRenderer.speech.at(-1).o.strategyBinding);
 const fuelMissing=make();fuelMissing.connect();const missingFuel=await fuelMissing.ask('燃料は足りる？');check(missingFuel.includes('現在燃料を確認できない'));check(!missingFuel.includes('99'));
 // Real scoped session-memory is a historical reference, not a replacement current fuel owner.
 const memoryRenderer=make();memoryRenderer.connect();const noRate=copy(base);noRate.recommendations.fuel_strategy={value:{avg_fuel_per_lap:null},role:'recommendation_not_execution',calculation_source:{source_frame_sequence:noRate.source_frame.sequence,session_time_s:noRate.source_frame.session_time_s}};memoryRenderer.receive(noRate);
 const memoryIdentity={userId:'driver-a',custId:String(base.continuity.stable_scope.driver_id),track:'Road Atlanta',car:'Mercedes',carClass:'GT3',sessionType:'race',raceFormat:'lap_race',seriesId:1,fuelRule:'fixed',tyreRule:'free',setupFingerprint:'current-setup',trackTempC:30};
 memoryRenderer.ctx.lastTelemetry.cust_id=memoryIdentity.custId;memoryRenderer.ctx.currentMemoryUserId=()=>memoryIdentity.userId;memoryRenderer.ctx.currentMemoryIdentity=()=>memoryIdentity;memoryRenderer.ctx.PitwallSessionMemory=require('./desktop/session-memory');let ownHistory=[{...memoryIdentity,recordedAt:new Date(Date.now()-86400000).toISOString(),date:'2026-10-06',avgFuelPerLap:4.28,totalLaps:20,setupFingerprint:'older-setup',trackTempC:15}];memoryRenderer.ctx.loadRaceHistory=()=>ownHistory;
 const historicalFuel=await memoryRenderer.ask('燃料足りる？');check(historicalFuel.includes('過去燃費からの暫定値'));check(historicalFuel.includes('予備2L'));check(historicalFuel.includes('必要約'));check(historicalFuel.includes('推奨'));check(historicalFuel.length<150);check(memoryRenderer.ctx.ensureStrategyState().pit_plan.lap===active.target_lap);check(memoryRenderer.ctx.currentStrategyStateAPI().answerFuel().laps_possible===null);
 ownHistory=[{...ownHistory[0],userId:'another-driver',custId:'999'}];const foreignFuel=await memoryRenderer.ask('燃料足りる？');check(!foreignFuel.includes('4.28'));check(!foreignFuel.includes('本人履歴'));check(memoryRenderer.ctx.ensureStrategyState().pit_plan.lap===active.target_lap);
 // Team consultation has an explicit reference role at its real display/radio outlet.
 vm.runInContext(renderer.match(/function teamPlanLang\([^]*?\n/)[0]+extract('teamPlanSay'),r.ctx);r.ctx.teamPlanSay('99周でPlan B。','team_plan_status');check(r.speech.at(-1).text.includes('チーム相談の参考Plan（Bridgeの現在合意とは別）'));check(r.ctx.ensureStrategyState().pit_plan===null);check(!r.ctx.buildActiveRaceFactsNote(true).includes('99'));
 const teamCurrent=make();teamCurrent.connect();teamCurrent.receive(base);vm.runInContext(renderer.match(/function teamPlanLang\([^]*?\n/)[0]+extract('teamPlanSay'),teamCurrent.ctx);teamCurrent.ctx.teamPlanSay('99周でPlan B。','team_plan_status');check(teamCurrent.speech.at(-1).text.includes('参考Plan'));check(teamCurrent.ctx.ensureStrategyState().pit_plan.lap===active.target_lap);check(teamCurrent.ctx.currentStrategyPlaybook().active_record.decision_id===active.decision_id);
 // Applied ACK is a transport receipt; the readback waits for matching canonical terminal.
 const ackRenderer=make();ackRenderer.connect();ackRenderer.receive(base);const e={cmd:'driver_plan_command',command_id:'command1',bridge_process_epoch:base.bridge_process_epoch,canonical_snapshot_id:base.snapshot_id,canonical_snapshot_sequence:base.snapshot_sequence,race_instance_id:base.race_instance_id,session_num:base.session_num,expected_decision_id:active.decision_id,expected_revision:active.revision,source_frame_sequence:base.source_frame.sequence,driver_pit_sequence:base.race_facts.driver_pit_sequence,intent:'cancel'};
 ackRenderer.ctx.driverPlanCommandOutbox.set(e.command_id,{envelope:e});const ack={...e,type:'driver_plan_command_ack',decision_id:e.expected_decision_id,outcome:'applied',lifecycle_phase:'cancelled',result_revision:e.expected_revision+1};ackRenderer.sockets.at(-1).onmessage({data:JSON.stringify(ack)});check(ackRenderer.ctx.pendingCanonicalCommandReadbacks.size===1);check(ackRenderer.speech.length===0);check(ackRenderer.ctx.ensureStrategyState().pit_plan.lap===active.target_lap);
 const terminal=copy(base);terminal.snapshot_sequence++;terminal.snapshot_id=terminal.bridge_process_epoch+':'+terminal.snapshot_sequence;const cancelled=terminal.lifecycle.active;cancelled.phase='cancelled';cancelled.revision++;cancelled.record_ref.revision++;if(cancelled.current_custody_ref)cancelled.current_custody_ref.revision++;terminal.lifecycle.terminal_records.push(cancelled);terminal.lifecycle.active=null;terminal.lifecycle.active_plan_id=null;terminal.execution.allowed=false;terminal.box_delivery.allowed_attempt_id=null;terminal.box_delivery.allowed_proof_id=null;terminal.box_delivery.valid_until_session_s=null;check(C.validate(terminal));ackRenderer.receive(terminal);check(ackRenderer.ctx.pendingCanonicalCommandReadbacks.size===0);check(ackRenderer.speech.length===1);check(ackRenderer.speech[0].text.includes('取り消した'));check(ackRenderer.ctx.loadDecisions().find(x=>x.decision_id===active.decision_id).canonical_lifecycle.phase==='cancelled');check(ackRenderer.ctx.loadDecisions().filter(x=>x.decision_id===active.decision_id).length===1);check(ackRenderer.ctx.ensureStrategyState().pit_plan===null);ackRenderer.sockets.at(-1).onmessage({data:JSON.stringify(ack)});check(ackRenderer.speech.length===1);
 // Same race/session with a different driver and no active record never revives local/history truth.
 const empty=copy(next);empty.snapshot_sequence++;empty.snapshot_id=empty.bridge_process_epoch+':'+empty.snapshot_sequence;empty.continuity.stable_scope.driver_id+=1;empty.lifecycle.active=null;empty.lifecycle.active_plan_id=null;empty.execution.allowed=false;empty.box_delivery.allowed_attempt_id=null;empty.box_delivery.allowed_proof_id=null;empty.box_delivery.valid_until_session_s=null;
 r.clock(5200);r.receive(empty);check(r.ctx.ensureStrategyState().pit_plan===null);check(r.ctx.ensureStrategyState().scope.driver_id===empty.continuity.stable_scope.driver_id);check(!r.projection.validBinding(refs));
 const freshEpoch=copy(empty);freshEpoch.bridge_process_epoch='wo011-new-process';freshEpoch.snapshot_sequence=1;freshEpoch.snapshot_id=freshEpoch.bridge_process_epoch+':1';freshEpoch.continuity.state_origin_epoch=freshEpoch.bridge_process_epoch;freshEpoch.lifecycle.awaiting=[];freshEpoch.lifecycle.terminal_records=[];freshEpoch.pit_ledger.events=[];freshEpoch.pit_ledger.last_event=null;freshEpoch.pit_ledger.recorded_event_count=0;freshEpoch.box_delivery.attempts=[];freshEpoch.last_driver_action={available:false,action:null};
 r.sockets.at(-1).readyState=3;r.connect(freshEpoch.bridge_process_epoch);check(r.ctx.ensureStrategyState().pit_plan===null);r.receive(freshEpoch);check(r.ctx.ensureStrategyState().pit_plan===null);check(r.ctx.ensureStrategyState().publication_ref.bridge_process_epoch==='wo011-new-process');
 // Actual poll-generated normal/penalty/unresolved visits reach the real history store.
 for(const [relation,snapshot] of Object.entries(pitSnapshots)){const eventRenderer=make();eventRenderer.connect(snapshot.bridge_process_epoch);check(C.validate(snapshot));eventRenderer.receive(snapshot);const state=eventRenderer.ctx.ensureStrategyState();check(state.pitEvents.at(-1).execution_relation===relation);check(state.pit_executed.execution_relation===relation);check(!eventRenderer.ctx.currentStrategyStateAPI().answerPitDecision(state).reply.includes('走り切'));
 const record=snapshot.lifecycle.terminal_records.find(x=>x.terminal_pit_event_id===snapshot.pit_ledger.events.at(-1).pit_event_id);check(!!record);const history=eventRenderer.ctx.loadDecisions().find(x=>x.decision_id===record.decision_id);check(history.authority_role==='historical_reference');check(history.canonical_pit_outcome.execution_relation===relation);check(history.canonical_pit_outcome.event_ref.pit_event_id===record.terminal_pit_event_id);const size=eventRenderer.ctx.loadDecisions().length;eventRenderer.ctx.syncCanonicalDecisionHistory();check(eventRenderer.ctx.loadDecisions().length===size);}
 // An additional pit result invalidates a queued answer even when fuel/lap facts are unchanged.
 const outcomeRenderer=make();const firstOutcome=copy(pitSnapshots.unresolved);firstOutcome.lifecycle.active=null;firstOutcome.lifecycle.active_plan_id=null;firstOutcome.execution.allowed=false;firstOutcome.box_delivery.allowed_attempt_id=null;firstOutcome.box_delivery.allowed_proof_id=null;firstOutcome.box_delivery.valid_until_session_s=null;outcomeRenderer.connect(firstOutcome.bridge_process_epoch);outcomeRenderer.receive(firstOutcome);const firstAnswer=outcomeRenderer.ctx.currentStrategyStateAPI().answerPitDecision();check(firstAnswer.state==='unresolved');check(outcomeRenderer.projection.validBinding(firstAnswer.binding));
 const secondOutcome=copy(firstOutcome);secondOutcome.snapshot_sequence++;secondOutcome.snapshot_id=secondOutcome.bridge_process_epoch+':'+secondOutcome.snapshot_sequence;const event2=copy(secondOutcome.pit_ledger.events.at(-1));event2.pit_event_id+=':second';event2.driver_pit_sequence++;event2.execution_relation='penalty';event2.classification_reason='authoritative_black_flag';event2.penalty_evidence.state='true';event2.event_ref.pit_event_id=event2.pit_event_id;event2.event_ref.driver_pit_sequence=event2.driver_pit_sequence;if(event2.origin_event_ref){event2.origin_event_ref.pit_event_id=event2.pit_event_id;event2.origin_event_ref.driver_pit_sequence=event2.driver_pit_sequence;}secondOutcome.pit_ledger.events.push(event2);secondOutcome.pit_ledger.last_event=event2;secondOutcome.pit_ledger.recorded_event_count++;secondOutcome.pit_ledger.process_observed_exit_count++;secondOutcome.race_facts.driver_pit_sequence++;check(C.validate(secondOutcome));outcomeRenderer.receive(secondOutcome);check(!outcomeRenderer.projection.validBinding(firstAnswer.binding));check(outcomeRenderer.ctx.currentStrategyStateAPI().answerPitDecision().state==='penalty');
 // Unsupported multi-stop raw projections cannot acquire current radio authority.
 const endurance=make();endurance.connect();endurance.ctx.lastSessionType='race';endurance.ctx.isSessionEndingLifecycle=()=>false;endurance.ctx.enduranceForecastAnnouncedKey='';vm.runInContext(extract('maybeAnnounceEnduranceFuelForecast'),endurance.ctx);const rawMulti={session_type:'race',fuel_strategy:{endurance_plan:{available:true,multi_stop:true,next_pit_lap:1}}};endurance.ctx.maybeAnnounceEnduranceFuelForecast(rawMulti);check(endurance.speech.length===0);
 const multiFrame=copy(base);multiFrame.recommendations.fuel_strategy={value:{endurance_plan:{available:true,multi_stop:true,next_pit_lap:1}},role:'recommendation_not_execution',calculation_source:{source_frame_sequence:multiFrame.source_frame.sequence,session_time_s:multiFrame.source_frame.session_time_s}};endurance.receive(multiFrame);endurance.ctx.maybeAnnounceEnduranceFuelForecast(rawMulti);check(endurance.speech.length===1);check(endurance.speech[0].text.includes('対応範囲外'));check(!/今周|1周|ボックス/.test(endurance.speech[0].text));check(endurance.speech[0].o.strategyBinding);endurance.clock(5000);endurance.ctx.enduranceForecastAnnouncedKey='';endurance.ctx.maybeAnnounceEnduranceFuelForecast(rawMulti);check(endurance.speech.length===1);
 const fuelContext=make();fuelContext.connect();fuelContext.receive(base);fuelContext.ctx.lastTelemetry.fuel=999;fuelContext.ctx.lastTelemetry.fuel_strategy={avg_fuel_per_lap:999,required_fuel_l:999};fuelContext.ctx.lastFuelCapacityContext=null;fuelContext.ctx.loadConfirmedFuelCapacity=()=>null;vm.runInContext(extract('buildFuelAuthorityNote'),fuelContext.ctx);check(!fuelContext.ctx.buildFuelAuthorityNote(true).includes('999'));fuelContext.clock(5000);check(!fuelContext.ctx.buildFuelAuthorityNote(true).includes('999'));check(fuelContext.ctx.buildFuelAuthorityNote(true).includes('no_authoritative_fuel_solution'));
 // Fuel-note fields distinguish current observations from dated calculation references.
 const notes=make();notes.connect();notes.ctx.lastFuelCapacityContext=null;notes.ctx.loadConfirmedFuelCapacity=()=>null;vm.runInContext(extract('buildFuelAuthorityNote'),notes.ctx);
 const datedFuel=copy(base);datedFuel.recommendations.fuel_strategy={value:{avg_fuel_per_lap:999,required_fuel_l:999,laps_of_fuel_left:999,estimated_crossings_to_finish:999,margin_l:999},role:'recommendation_not_execution',calculation_source:{source_frame_sequence:Math.max(0,datedFuel.source_frame.sequence-1),session_time_s:datedFuel.source_frame.session_time_s-20}};notes.receive(datedFuel);const oldNote=notes.ctx.buildFuelAuthorityNote(true);check(oldNote.includes('calculation_reference_avg_l_per_lap=999'));check(oldNote.includes('calculation_reference_required_fuel_to_finish_l=999'));check(oldNote.includes('calculation_age_s=20'));check(oldNote.includes('calculation_source_frame='+datedFuel.recommendations.fuel_strategy.calculation_source.source_frame_sequence));check(oldNote.includes('authoritative_laps_to_finish='+datedFuel.finish.remaining_sf_crossings));check(!oldNote.includes('authoritative_laps_to_finish=999'));
 const futureFuel=copy(datedFuel);futureFuel.snapshot_sequence++;futureFuel.snapshot_id=futureFuel.bridge_process_epoch+':'+futureFuel.snapshot_sequence;futureFuel.recommendations.fuel_strategy.calculation_source.session_time_s=futureFuel.source_frame.session_time_s+1;notes.receive(futureFuel);const futureNote=notes.ctx.buildFuelAuthorityNote(true);check(!futureNote.includes('=999'));check(futureNote.includes('current_fuel_l='+futureFuel.current_facts.fuel_level_l));check(!futureNote.includes('calculation_age_s='));
 const nullFuel=copy(futureFuel);nullFuel.snapshot_sequence++;nullFuel.snapshot_id=nullFuel.bridge_process_epoch+':'+nullFuel.snapshot_sequence;nullFuel.current_facts.fuel_level_l=null;nullFuel.recommendations.fuel_strategy.value={avg_fuel_per_lap:null,required_fuel_l:null,laps_of_fuel_left:null,margin_l:null};nullFuel.recommendations.fuel_strategy.calculation_source={source_frame_sequence:nullFuel.source_frame.sequence,session_time_s:nullFuel.source_frame.session_time_s};nullFuel.execution.allowed=false;nullFuel.box_delivery.allowed_attempt_id=null;nullFuel.box_delivery.allowed_proof_id=null;nullFuel.box_delivery.valid_until_session_s=null;check(C.validate(nullFuel));notes.receive(nullFuel);const nullNote=notes.ctx.buildFuelAuthorityNote(true);check(!nullNote.includes('current_fuel_l=0'));check(!nullNote.includes('calculation_reference_required_fuel_to_finish_l=0'));check(!nullNote.includes('calculation_reference_laps_of_fuel_left=0'));check(!nullNote.includes('calculation_reference_fuel_margin_l=0'));
 const truth=make();truth.connect();vm.runInContext(extract('telemetryTruthFallback')+extract('todayStrategyConditions'),truth.ctx);truth.ctx.lastTelemetry.fuel=999;truth.ctx.lastTelemetry.strategy_options={plan_b:{fuel_window_open:true,target_lap:99}};const absentTruth=truth.ctx.telemetryTruthFallback(truth.ctx.lastTelemetry,'燃料は足りる？',true);check(absentTruth.includes('現在燃料を確認できない'));check(!absentTruth.includes('999'));truth.receive(base);const planTruth=truth.ctx.telemetryTruthFallback(truth.ctx.lastTelemetry,'ピットの作戦は？',true);check(planTruth.includes(String(active.target_lap)));check(!planTruth.includes('99'));truth.clock(5000);check(truth.ctx.telemetryTruthFallback(truth.ctx.lastTelemetry,'ピットの作戦は？',true).includes('確認できない'));
 const conditions=make();conditions.connect();conditions.receive(windowFrame);conditions.ctx.lastTelemetry.strategy_options={plan_b:{fuel_window_open:true}};vm.runInContext(extract('todayStrategyConditions'),conditions.ctx);check(!conditions.ctx.todayStrategyConditions().fuelWindowOpen);conditions.receive(freshWindow);check(conditions.ctx.todayStrategyConditions().fuelWindowOpen);conditions.clock(5000);check(!conditions.ctx.todayStrategyConditions().fuelWindowOpen);
 await briefingTests();await fullCallAPITests();await judgeTransportTests();
 // Saved judge output uses the actual parser/classifier/response outbox. Agreement stays canonical-only.
 const judge=make();judge.connect();const waiting=copy(base),awaiting=waiting.lifecycle.active;awaiting.phase='awaiting_driver';waiting.lifecycle.awaiting=[awaiting];waiting.lifecycle.active=null;waiting.lifecycle.active_plan_id=null;waiting.execution.allowed=false;waiting.box_delivery.allowed_attempt_id=null;waiting.box_delivery.allowed_proof_id=null;waiting.box_delivery.valid_until_session_s=null;judge.receive(waiting);
 vm.runInContext('const PW_JUDGE_TAG_START = "<<PW_JUDGE"; const PW_JUDGE_TAG_RE = /<<PW_JUDGE\\s+decision_id="([^"]*)"\\s+classification="(confirm|decline|same_topic|unrelated)"\\s*>>/;',judge.ctx);
 for(const n of ['stripProposalJudgeTag','applyProposalJudgeTag','strategyResponseKey','flushStrategyResponseOutbox','sendStrategyDecisionResponse','currentProposalResponseBinding','strategyProposalAudibleCompletedAt'])vm.runInContext(extract(n),judge.ctx);
 const proposal=judge.projection.api.proposePlan(null,{decision_id:awaiting.decision_id,lap:awaiting.target_lap,plan_id:awaiting.selected_plan,audible:true});check(!!proposal);const proposalBinding=judge.projection.binding({kind:'proposal',decision_id:awaiting.decision_id});judge.ctx.bridgeStrategyDecisions.set(awaiting.decision_id,{sessionNum:waiting.session_num,dispatchId:'saved-proposal-dispatch',binding:proposalBinding,metadataExpiresAt:90000});
 judge.clock(10000);const awaitingFresh=copy(waiting);awaitingFresh.snapshot_sequence++;awaitingFresh.snapshot_id=awaitingFresh.bridge_process_epoch+':'+awaitingFresh.snapshot_sequence;judge.receive(awaitingFresh);check(!judge.projection.validBinding(proposalBinding));check(!!judge.ctx.currentProposalResponseBinding(judge.ctx.bridgeStrategyDecisions.get(awaiting.decision_id)));
 const saved='変更案を選ぶんだね。 <<PW_JUDGE decision_id="'+awaiting.decision_id+'" classification="confirm">>';const parsed=judge.ctx.stripProposalJudgeTag(saved);check(!parsed.text.includes('PW_JUDGE'));check(parsed.judgment.classification==='confirm');judge.ctx.applyProposalJudgeTag(parsed.judgment,proposal.base_revision-1);check(judge.sent.filter(x=>x.cmd==='strategy_decision_response').length===0);judge.ctx.applyProposalJudgeTag(parsed.judgment,proposal.base_revision);check(judge.sent.filter(x=>x.cmd==='strategy_decision_response').length===1);check(judge.ctx.strategyResponseOutbox.size===1);check(judge.ctx.ensureStrategyState().pit_plan===null);check(judge.cache.current().lifecycle.awaiting.length===1);judge.ctx.applyProposalJudgeTag(parsed.judgment,proposal.base_revision);check(judge.sent.filter(x=>x.cmd==='strategy_decision_response').length===1);
 // Remove production context wiring: the identical no-legacy-plan assertion must turn RED.
 const assertContext=()=>assert(!r.ctx.buildActiveRaceFactsNote(true).includes('99'));assertContext();vm.runInContext(extract('buildActiveRaceFactsNote').replace("return strategyProjection.raceFactsNote(isJP?'ja':'en');","return 'Current agreed plan lap '+activeRaceFacts.pit_plan.lap;"),r.ctx);check(assert.throws(assertContext)!==false);
 radioPublicationTests();await audioTests(base,firstOutcome,secondOutcome);console.log('WO011 actual Renderer '+checks+' checks PASS; temp actual Bridge replay, no external API');
})().catch(e=>{console.error(e);process.exitCode=1;});
function audioVM(s){let clock=0,fetchResolve,plays=0,fallbacks=0,fetches=0;const cache=C.create({now:()=>clock}),g=cache.beginSocket();cache.hello(g,{type:'connected',schema_version:1,bridge_process_epoch:s.bridge_process_epoch});assert(cache.receive(s,g));const projection=P.create({canonical:cache,now:()=>clock});
 const c={console,Date,Math,Map,Set,AbortController,performance:{now:()=>clock},canonicalLifecycleCache:cache,strategyProjection:projection,boxAuthorityTransport:{},selMode:'race',voiceOn:true,nextUtteranceId:()=> 'audio-u',speakQueue:[],lastQueuedSpeakItem:null,SPEAK_PRIO:{P0_SAFETY:0,P1_HAZARD:1,P2_PROCEDURE:2,P4_INFO:4},IMMEDIATE_PIT_KINDS:new Set(),MAX_RADIO_QUEUE:2,MAX_SPEAK_QUEUE:20,currentSpeakPrio:9,currentSpeakItem:null,isSpeaking:false,draining:false,speakGateActive:false,speakWindowOk:true,speakGeneration:0,CHARS:{x:{gVoice:'mock',gLang:'en',voiceLang:'en'}},sel:'x',autoMicActive:false,speechLatencyTrace(){},diagnosticLog(){},shouldDeferSpeak:()=>false,deferSpeakItem:()=>false,currentGapAuthority:()=>null,ttsAudio:null,speakFetchCtrl:null,speakWatchdog:null,ttsDisabledUntil:0,phonetify:x=>x,normalizeLunaSpeech:x=>x,stripMarkdown:x=>x,stripParens:x=>x,stripEmoji:x=>x,ttsFailLog(){},ttsEventLog(){},pwVolume:1,usageSessionId:'s',API_BASE:'mock',localStorage:{getItem:()=>null},getDeviceId:()=> 'test',setTimeout:()=>1,clearTimeout(){},finalizeUtterance(){},playWebSpeech:(text,char,gen,done,start)=>{fallbacks++;start();done();},onUtteranceDone:()=>{c.draining=false;c.isSpeaking=false;},Audio:class{constructor(){this.volume=1;}async play(){plays++;}},fetch:()=>{fetches++;return new Promise(r=>fetchResolve=r);},irBridge:null,utteranceTraceLog:[],UTTERANCE_TRACE_MAX:200};c.window=c;vm.createContext(c);for(const n of ['deriveUtteranceSource','stableTextHash','utteranceTrace','utteranceTraceFor','speak','drainQueue'])vm.runInContext(extract(n),c);
 return {ctx:c,cache,projection,clock:n=>clock=n,plays:()=>plays,fallbacks:()=>fallbacks,fetches:()=>fetches,resolve:r=>fetchResolve(r),queue:()=>{const b=projection.binding();c.speak('Box on the agreed lap.',{prio:2,kind:'reply',strategyBinding:b,precheck:()=>projection.validBinding(b)});}};
}
async function settle(){await new Promise(r=>setImmediate(r));}
async function audioTests(s,pitFirst,pitSecond){const a=audioVM(s);a.queue();check(a.fetches()===1);check(a.plays()===0);const changed=copy(s);changed.snapshot_sequence++;changed.snapshot_id=changed.bridge_process_epoch+':'+changed.snapshot_sequence;changed.lifecycle.active.revision++;changed.lifecycle.active.record_ref.revision++;if(changed.lifecycle.active.current_custody_ref)changed.lifecycle.active.current_custody_ref.revision++;
 changed.execution.allowed=false;changed.box_delivery.allowed_attempt_id=null;changed.box_delivery.allowed_proof_id=null;changed.box_delivery.valid_until_session_s=null;check(a.cache.receive(changed));a.resolve({ok:true,status:200,json:async()=>({audioContent:'fake'})});await settle();check(a.plays()===0);check(a.ctx.speakQueue.length===0);
 const b=audioVM(s);b.queue();const update=copy(s);update.snapshot_sequence++;update.snapshot_id=update.bridge_process_epoch+':'+update.snapshot_sequence;b.clock(100);check(b.cache.receive(update));b.resolve({ok:true,status:200,json:async()=>({audioContent:'fake'})});await settle();check(b.plays()===1);
 const sameRevision=audioVM(s);sameRevision.queue();const tampered=copy(s);tampered.snapshot_sequence++;tampered.snapshot_id=tampered.bridge_process_epoch+':'+tampered.snapshot_sequence;tampered.lifecycle.active.add_fuel_l+=1;tampered.execution.allowed=false;tampered.box_delivery.allowed_attempt_id=null;tampered.box_delivery.allowed_proof_id=null;tampered.box_delivery.valid_until_session_s=null;check(sameRevision.cache.receive(tampered));sameRevision.resolve({ok:true,status:200,json:async()=>({audioContent:'fake'})});await settle();check(sameRevision.plays()===0);
 const fallback=audioVM(s);fallback.ctx.SPEAK_PRIO.P1_HAZARD=2;fallback.queue();check(fallback.cache.receive(changed));fallback.resolve({ok:false,status:503});await settle();check(fallback.fallbacks()===0);
 const noneSnapshot=copy(s);noneSnapshot.lifecycle.active=null;noneSnapshot.lifecycle.active_plan_id=null;noneSnapshot.execution.allowed=false;noneSnapshot.box_delivery.allowed_attempt_id=null;noneSnapshot.box_delivery.allowed_proof_id=null;noneSnapshot.box_delivery.valid_until_session_s=null;const noneAudio=audioVM(noneSnapshot),noneAnswer=noneAudio.projection.api.answerPitDecision();noneAudio.ctx.speak(noneAnswer.reply,{prio:2,kind:'reply',strategyBinding:noneAnswer.binding,precheck:()=>noneAudio.projection.validBinding(noneAnswer.binding)});check(noneAudio.fetches()===1);const newAgreement=copy(s);newAgreement.snapshot_sequence++;newAgreement.snapshot_id=newAgreement.bridge_process_epoch+':'+newAgreement.snapshot_sequence;check(noneAudio.cache.receive(newAgreement));noneAudio.resolve({ok:true,status:200,json:async()=>({audioContent:'fake'})});await settle();check(noneAudio.plays()===0);check(noneAudio.projection.api.answerPitDecision().reply.includes(String(s.lifecycle.active.target_lap)));
 const pitAudio=audioVM(pitFirst);const pitBound=pitAudio.projection.api.answerPitDecision().binding;pitAudio.ctx.speak(pitAudio.projection.api.answerPitDecision().reply,{prio:2,kind:'reply',strategyBinding:pitBound,precheck:()=>pitAudio.projection.validBinding(pitBound)});check(pitAudio.fetches()===1);check(pitAudio.cache.receive(pitSecond));pitAudio.resolve({ok:true,status:200,json:async()=>({audioContent:'fake'})});await settle();check(pitAudio.plays()===0);
 for(const text of ['雑談しよう','セットアップの空力を相談したい','前回の戦略を振り返ろう']){const unrelated=audioVM(s);vm.runInContext(extract('currentPlanReplyDependsOn'),unrelated.ctx);check(!unrelated.ctx.currentPlanReplyDependsOn(text,null));unrelated.ctx.speak('Independent conversation reply.',{prio:2,kind:'reply'});unrelated.clock(6000);unrelated.resolve({ok:true,status:200,json:async()=>({audioContent:'fake'})});await settle();check(unrelated.plays()===1);}
 const dependent=audioVM(s);vm.runInContext(extract('currentPlanReplyDependsOn'),dependent.ctx);check(dependent.ctx.currentPlanReplyDependsOn('今のプランは何周？',null));dependent.queue();dependent.clock(6000);dependent.resolve({ok:true,status:200,json:async()=>({audioContent:'fake'})});await settle();check(dependent.plays()===0);
 // Remove only production post-fetch prechecks (keep initial queue guard) and run same stale assertion.
 const mutant=audioVM(s);const drain=extract('drainQueue').replace(/if\(_it && typeof _it\.precheck==='function' && !_it\.precheck\(\)\)/g,'if(false)');vm.runInContext(drain,mutant.ctx);mutant.queue();check(mutant.cache.receive(changed));mutant.resolve({ok:true,status:200,json:async()=>({audioContent:'fake'})});await settle();assert.throws(()=>assert.equal(mutant.plays(),0));checks++;
}

async function briefingTests(){
 for(const stale of [true,false]){const b=make();b.connect();b.receive(base);const c=b.ctx;let callback,resolve,request;
 Object.assign(c,{selMode:'strategy',API_BASE:'mock',userName:'Test Driver',lastSessionType:'race',lastSessionAuthority:null,driverState:null,driverActivity:null,
 loadProfile:()=>({}),buildPreviousRaceBriefingNote:()=>'',pullDecisionsFromServer:async()=>{},decisionBriefingSelection:()=>({available:false}),decisionPlanAdvice:()=>({reply:'',action:'none',fate:'unavailable'}),setupComparisonForBriefing:()=>({available:false}),buildProfileNote:()=>'',buildCarTrackMemory:()=>'',buildFuelAuthorityNote:()=>'',buildWeekendAuthorityNote:()=>'',buildContractNote:()=>'',buildRaceHistoryContext:()=>'',applyPitwallAccess:()=>{},setTimeout:(f,ms)=>{if(ms===6000)callback=f;return 1;},fetch:(url,opts)=>{request=JSON.parse(opts.body);return new Promise(r=>resolve=r);}});
 for(const name of ['_hasUnqualifiedCurrentNumericMention','strategyNumericFactBinding','captureVerifiedAuxBinding','verifiedAuxFieldsStillFresh','strategyReplyBindingValid'])vm.runInContext(extract(name),c);
 vm.runInContext(extract('scheduleAutoBriefing'),c);await c.scheduleAutoBriefing();const pending=callback();await settle();check(!!request);check(request.profileNote.includes(base.lifecycle.active.decision_id));check(!/lap 99|99周/.test(request.profileNote));
 if(stale)b.clock(6000);else {const fresh=copy(base);fresh.snapshot_sequence++;fresh.snapshot_id=fresh.bridge_process_epoch+':'+fresh.snapshot_sequence;b.clock(100);b.receive(fresh);}resolve({json:async()=>({content:[{text:'Planの説明を続けます。'}]})});await pending;check(b.speech.length===(stale?0:1));if(!stale)check(b.speech[0].o.precheck());
 }
}

async function fullCallAPITests(){
 const cases=[{text:'今のプランを説明して',related:true,change:false},{text:'セットアップの空力を相談したい',related:false,change:true},...['前回と違って今のプランは？','前回の燃料と比べて今足りる？','Compared with last race, what is the current pit plan?'].flatMap(text=>[{text,related:true,change:false},{text,related:true,change:true},{text,related:true,fresh:true}]),...['前回の戦略を振り返ろう','Explain the historical pit plan from last race.'].map(text=>({text,related:false,change:true}))];
 // ★WO014 round6 REVISE（監査差戻し「会話維持の回帰」修復、round3の全面
 // 無条件discardを訂正）：round3は related===false でも change===true なら
 // 無条件discardにしたが、これはPlan/fuelについて何も主張していない純過去・
 // setup発話の役割そのものを破壊する回帰だった（WO011の純過去/雑談維持契約、
 // /tmp/wo014-independent-history-probe.js等で反証）。round6は
 // _isConcretelyNonCurrentText()（質問がhistorical&&!current、またはsetup/
 // chat/weather語彙を明示的に含む時だけ）を緩和の入口にし、入口を通った後も
 // 配信する返信本文自身（このテストでは固定文言「空力の相談を続けよう。」
 // ——current/strategy語彙を含まない）を_chunkRequiresCriticalFence()で
 // 再判定する。related===false側のcaseは全て入口を通り返信も非current固定
 // 文言なので、changeのPlan revision+execution.allowed変化はscope_continuity
 // （identity/epoch/closure/TTLの境界のみ判定、内容変化は見ない）には影響
 // しない——discardされるのはTTL自体が尽きるfresh===undefined&&change===false
 // の経路（全kind共通のdeadline_ms超過、related不問）だけになる。
 // related===true側（Plan/fuel明示質問、または今/現在等で明示current比較）
 // は無変更：changeでPlan/execution/proofが変わればdomain AND critical
 // fenceが必ず無効化される。
 for(const scenario of cases){const {related}=scenario;const blocked=!scenario.fresh&&(scenario.change?!!related:true);const r=make();r.connect();r.receive(base);const c=r.ctx,a=audioVM(base);let deliver,cancelled=false,reads=0,chatBody,logged='';const errors=[];
 for(const name of ['voiceOn','speakQueue','lastQueuedSpeakItem','IMMEDIATE_PIT_KINDS','MAX_RADIO_QUEUE','MAX_SPEAK_QUEUE','currentSpeakPrio','currentSpeakItem','isSpeaking','draining','speakGateActive','speakWindowOk','speakGeneration','autoMicActive','speechLatencyTrace','shouldDeferSpeak','deferSpeakItem','currentGapAuthority','ttsAudio','speakFetchCtrl','speakWatchdog','ttsDisabledUntil','phonetify','normalizeLunaSpeech','stripMarkdown','stripParens','stripEmoji','ttsFailLog','ttsEventLog','pwVolume','getDeviceId','finalizeUtterance','playWebSpeech','Audio'])c[name]=a.ctx[name];
 // WO015 root cause (not a `t` stub papering over the symptom): the real
 // extracted utteranceTrace() now runs unconditionally from speak()'s new
 // 'generated' call and references the module-level utteranceTraceLog/
 // UTTERANCE_TRACE_MAX this fixture never provided -- that ReferenceError
 // was getting raised inside callAPI()'s try block, caught, and MASKED by
 // a second ReferenceError (`t` undefined) from the catch handler's own
 // addMsg('sys',t('sys_conn_error')) call. Provide the real dependency.
 // WO017: real owner/race scope helpers; history entries carry the real memoryTurnTag like pushMsg.
 c.currentMemoryUserId=c.currentMemoryUserId||(()=>'wo011-driver');WO017Scope.install(c);vm.runInContext(WO017Scope.source(renderer,{decls:false}),c);
 Object.assign(c,{utteranceTraceLog:[],UTTERANCE_TRACE_MAX:200,API_BASE:'mock',jamesAutoMicEnabled:false,jamesMuted:false,CHARS:{LunaJP:a.ctx.CHARS.x},TextDecoder,TextEncoder,messages:[{role:'user',content:scenario.text}],userName:'Test',lastSectors:null,lastSessionType:'race',lastSessionAuthority:null,driverState:null,driverActivity:null,
 hydrateLegacyStrategyObjective:()=>null,loadProfile:()=>({}),buildProfileNote:()=>'',buildCarTrackMemory:()=>'',buildPracticeProfileNote:()=>'',buildFuelAuthorityNote:()=>'',buildWeekendAuthorityNote:()=>'',buildCurrentSessionFactNote:()=>'',buildSessionEvidenceNote:()=>'',buildContractNote:()=>'',buildMemoryStatusNote:()=>'',currentMemoryBrainPrompt:()=>'',buildRaceHistoryContext:()=>'',updateNamedRivalFromUser:()=>{},forwardDriverDamageReport:()=>{},buildNamedRivalNote:()=>'',applyPitwallAccess:()=>{},hasTelemetryOwnedVehicleClaim:()=>false,completeMemoryBrainTurn:()=>{},convoLog:(who,text)=>logged=text,diagnosticLog:(kind,text)=>{if(kind==='CLIENT ERROR')errors.push(text);},onUtteranceDone:()=>{c.draining=false;c.isSpeaking=false;},fetch:async(url,opts)=>{if(url.endsWith('/api/tts'))return {ok:true,status:200,json:async()=>({audioContent:'fake'})};chatBody=JSON.parse(opts.body);return {ok:true,headers:{get:()=>null},body:{getReader:()=>({read:()=>++reads===1?new Promise(resolve=>deliver=resolve):Promise.resolve({done:true}),cancel:()=>cancelled=true})}};}});
 vm.runInContext('const PW_JUDGE_TAG_START="<<PW_JUDGE";const PW_JUDGE_TAG_RE=/<<PW_JUDGE\\s+decision_id="([^"]*)"\\s+classification="(confirm|decline|same_topic|unrelated)"\\s*>>/;',c);
 for(const name of ['currentPlanReplyDependsOn','_hasUnqualifiedCurrentNumericMention','strategyNumericFactBinding','captureVerifiedAuxBinding','verifiedAuxFieldsStillFresh','strategyReplyBindingValid','deriveUtteranceSource','stableTextHash','utteranceTrace','utteranceTraceFor','stripProposalJudgeTag','applyProposalJudgeTag','speak','speakReplyChunk','drainQueue','callAPI'])vm.runInContext(extract(name),c);
 const pending=c.callAPI('typed');await settle();check(!!deliver);check(chatBody.profileNote.includes(base.lifecycle.active.decision_id));check(chatBody.liveData.strategy_plan===null);check(chatBody.liveData.canonical_snapshot_id===base.snapshot_id);r.clock(scenario.fresh||scenario.change?100:6000);
 if(scenario.change){const fresh=copy(base);fresh.snapshot_sequence++;fresh.snapshot_id=fresh.bridge_process_epoch+':'+fresh.snapshot_sequence;fresh.lifecycle.active.revision++;fresh.lifecycle.active.record_ref.revision++;if(fresh.lifecycle.active.current_custody_ref)fresh.lifecycle.active.current_custody_ref.revision++;fresh.execution.allowed=false;fresh.box_delivery.allowed_attempt_id=null;fresh.box_delivery.allowed_proof_id=null;fresh.box_delivery.valid_until_session_s=null;r.receive(fresh);}
 deliver({done:false,value:new TextEncoder().encode(related?'現在のPlanを説明する。':'空力の相談を続けよう。')});await pending;await settle();assert.deepEqual(errors,[]);checks++;check(cancelled===blocked);check(a.plays()===(blocked?0:1));check(blocked?logged==='':logged===(related?'現在のPlanを説明する。':'空力の相談を続けよう。'));
 }
}

// ★2026-10-08 WO013途中レビュー差戻しの一括反証：実canonical awaiting→実
// strategyProjection.proposePlan→実callAPI()（opt-in送信）→mock fetch（実server.js
// のNDJSON契約を模した応答）→実stripProposalJudgeTag/applyProposalJudgeTag→
// 実applyProposalClassification/sendStrategyDecisionResponseまでの縦断。
// どの段も本番関数そのもの（vm抽出）を使う。
function makeAwaitingProposal(){
 const waiting=copy(base),awaiting=waiting.lifecycle.active;
 awaiting.phase='awaiting_driver';waiting.lifecycle.awaiting=[awaiting];waiting.lifecycle.active=null;waiting.lifecycle.active_plan_id=null;
 waiting.execution.allowed=false;waiting.box_delivery.allowed_attempt_id=null;waiting.box_delivery.allowed_proof_id=null;waiting.box_delivery.valid_until_session_s=null;
 const r=make();r.connect();r.receive(waiting);
 r.projection.api.proposePlan(null,{decision_id:awaiting.decision_id,lap:awaiting.target_lap,plan_id:awaiting.selected_plan,audible:true});
 return {r,awaiting,waiting};
}
function wireJudgeCallCtx(r,fetchImpl){
 const c=r.ctx,a=audioVM(base);
 for(const name of ['voiceOn','speakQueue','lastQueuedSpeakItem','IMMEDIATE_PIT_KINDS','MAX_RADIO_QUEUE','MAX_SPEAK_QUEUE','currentSpeakPrio','currentSpeakItem','isSpeaking','draining','speakGateActive','speakWindowOk','speakGeneration','autoMicActive','speechLatencyTrace','shouldDeferSpeak','deferSpeakItem','currentGapAuthority','ttsAudio','speakFetchCtrl','speakWatchdog','ttsDisabledUntil','phonetify','normalizeLunaSpeech','stripMarkdown','stripParens','stripEmoji','ttsFailLog','ttsEventLog','pwVolume','getDeviceId','finalizeUtterance','playWebSpeech','Audio','nextUtteranceId'])c[name]=a.ctx[name];
 const errors=[];let logged='';const diag=[];
 // WO015 root cause fix (see fullCallAPITests): real utteranceTrace() needs
 // the real module-level utteranceTraceLog/UTTERANCE_TRACE_MAX this fixture
 // never provided.
 // WO017: real owner/race scope helpers; history entries carry the real memoryTurnTag like pushMsg.
 c.currentMemoryUserId=c.currentMemoryUserId||(()=>'wo011-driver');WO017Scope.install(c);vm.runInContext(WO017Scope.source(renderer,{decls:false}),c);
 Object.assign(c,{utteranceTraceLog:[],UTTERANCE_TRACE_MAX:200,API_BASE:'mock',jamesAutoMicEnabled:false,jamesMuted:false,CHARS:{LunaJP:a.ctx.CHARS.x},TextDecoder,TextEncoder,messages:[{role:'user',content:'その提案に賛成だ'}],userName:'Test',lastSectors:null,lastSessionType:'race',lastSessionAuthority:null,driverState:null,driverActivity:null,
  hydrateLegacyStrategyObjective:()=>null,loadProfile:()=>({}),buildProfileNote:()=>'',buildCarTrackMemory:()=>'',buildPracticeProfileNote:()=>'',buildFuelAuthorityNote:()=>'',buildWeekendAuthorityNote:()=>'',buildCurrentSessionFactNote:()=>'',buildSessionEvidenceNote:()=>'',buildContractNote:()=>'',buildMemoryStatusNote:()=>'',currentMemoryBrainPrompt:()=>'',buildRaceHistoryContext:()=>'',updateNamedRivalFromUser:()=>{},forwardDriverDamageReport:()=>{},buildNamedRivalNote:()=>'',applyPitwallAccess:()=>{},hasTelemetryOwnedVehicleClaim:()=>false,completeMemoryBrainTurn:()=>{},convoLog:(who,text)=>logged=text,diagnosticLog:(kind,text)=>{diag.push({kind,text});if(kind==='CLIENT ERROR')errors.push(text);},onUtteranceDone:()=>{c.draining=false;c.isSpeaking=false;},
  fetch:fetchImpl});
 vm.runInContext('const PW_JUDGE_TAG_START="<<PW_JUDGE";const PW_JUDGE_TAG_RE=/<<PW_JUDGE\\s+decision_id="([^"]*)"\\s+classification="(confirm|decline|same_topic|unrelated)"\\s*>>/;',c);
 for(const name of ['currentPlanReplyDependsOn','_hasUnqualifiedCurrentNumericMention','strategyNumericFactBinding','captureVerifiedAuxBinding','verifiedAuxFieldsStillFresh','strategyReplyBindingValid','deriveUtteranceSource','stableTextHash','utteranceTrace','utteranceTraceFor','stripProposalJudgeTag','applyProposalJudgeTag','speak','speakReplyChunk','drainQueue','callAPI'])vm.runInContext(extract(name),c);
 return {c,a,errors,logged:()=>logged,diag};
}
async function judgeTransportTests(){
 // A) full round trip: real opt-in request -> response negotiated via header
 //    -> real NDJSON parse -> decision_id/request_id-matched judgment ->
 //    real applyProposalClassification. fetch here is a hand-written mock
 //    that imitates the real server.js NDJSON contract (verified
 //    independently against the REAL server.js in scenario J below and in
 //    tests-wo001-road-atlanta-fixture.js's F02 acceptance section) —
 //    this scenario's own value is proving the REAL extracted callAPI()/
 //    applyProposalJudgeTag consume that contract correctly.
 //    sendStrategyDecisionResponse is make()'s stub recorder
 //    (`sent.push(...)`), NOT the real renderer.html WS sender — this file
 //    has stubbed the WebSocket transport this way throughout (see make()'s
 //    `WebSocket:class{...send(x){sent.push(JSON.parse(x));}...}`), and the
 //    resulting envelope's actual delivery to Bridge/poll/ACK/canonical
 //    readback is what the separate, already-independently-verified Python
 //    Bridge replay suites (tests_bridge_driver_plan_command_wiring.py etc.)
 //    cover — this file does not re-prove that leg.
 {
  const {r,awaiting}=makeAwaitingProposal();let deliver,reads=0,chatBody;
  const {c,errors}=wireJudgeCallCtx(r,async(url,opts)=>{
   if(url.endsWith('/api/tts'))return {ok:true,status:200,json:async()=>({audioContent:'fake'})};
   chatBody=JSON.parse(opts.body);
   return {ok:true,headers:{get:h=>h==='X-Pitwall-Judge-Transport'?'v1':null},
    body:{getReader:()=>({read:()=>++reads===1?new Promise(resolve=>deliver=resolve):Promise.resolve({done:true}),cancel:()=>{}})}};
  });
  const pending=c.callAPI('typed');await settle();check(!!deliver);
  check(chatBody.judgeTransport==='v1');check(chatBody.pendingJudgment.decision_id===awaiting.decision_id);check(typeof chatBody.pendingJudgment.request_id==='string'&&!!chatBody.pendingJudgment.request_id);
  const ndjson=JSON.stringify({text:'了解した。'})+'\n'+JSON.stringify({judgment:{decision_id:chatBody.pendingJudgment.decision_id,classification:'confirm',request_id:chatBody.pendingJudgment.request_id}})+'\n'+JSON.stringify({end:true})+'\n';
  deliver({done:false,value:new TextEncoder().encode(ndjson)});await pending;await settle();
  assert.deepEqual(errors,[]);checks++;
  check(r.sent.filter(x=>x.cmd==='strategy_decision_response'&&x.decision_id===awaiting.decision_id&&x.accepted===true).length===1,JSON.stringify(r.sent));
  check(r.ctx.currentStrategyStateAPI().pendingProposal()===null);
 }
 // B) a judgment frame targeting a DIFFERENT decision_id than this request
 //    asked about must never apply, even though it is otherwise well-formed.
 {
  const {r,awaiting}=makeAwaitingProposal();let deliver,reads=0,chatBody;
  const {c,errors}=wireJudgeCallCtx(r,async(url,opts)=>{
   if(url.endsWith('/api/tts'))return {ok:true,status:200,json:async()=>({audioContent:'fake'})};
   chatBody=JSON.parse(opts.body);
   return {ok:true,headers:{get:h=>h==='X-Pitwall-Judge-Transport'?'v1':null},
    body:{getReader:()=>({read:()=>++reads===1?new Promise(resolve=>deliver=resolve):Promise.resolve({done:true}),cancel:()=>{}})}};
  });
  const pending=c.callAPI('typed');await settle();check(!!deliver);
  const ndjson=JSON.stringify({text:'了解した。'})+'\n'+JSON.stringify({judgment:{decision_id:'some-other-decision',classification:'confirm',request_id:chatBody.pendingJudgment.request_id}})+'\n'+JSON.stringify({end:true})+'\n';
  deliver({done:false,value:new TextEncoder().encode(ndjson)});await pending;await settle();
  assert.deepEqual(errors,[]);checks++;
  check(r.sent.filter(x=>x.cmd==='strategy_decision_response').length===0);
  check(r.ctx.currentStrategyStateAPI().pendingProposal()&&r.ctx.currentStrategyStateAPI().pendingProposal().decision_id===awaiting.decision_id);
 }
 // C) response negotiation: this request opted in, but the actual response
 //    never carries the judgeTransport header (deterministic guard / legacy
 //    server shape) — must fall back to legacy plain-text parsing, not try
 //    to JSON.parse plain prose as NDJSON and lose the reply.
 {
  const {r,awaiting}=makeAwaitingProposal();let deliver,reads=0,chatBody;
  const {c,errors,logged}=wireJudgeCallCtx(r,async(url,opts)=>{
   if(url.endsWith('/api/tts'))return {ok:true,status:200,json:async()=>({audioContent:'fake'})};
   chatBody=JSON.parse(opts.body);
   return {ok:true,headers:{get:()=>null},
    body:{getReader:()=>({read:()=>++reads===1?new Promise(resolve=>deliver=resolve):Promise.resolve({done:true}),cancel:()=>{}})}};
  });
  const pending=c.callAPI('typed');await settle();check(!!deliver);check(chatBody.judgeTransport==='v1');
  deliver({done:false,value:new TextEncoder().encode('まだ検討中。')});await pending;await settle();
  assert.deepEqual(errors,[]);checks++;
  check(logged()==='まだ検討中。',logged());
  check(r.sent.filter(x=>x.cmd==='strategy_decision_response').length===0);
  check(r.ctx.currentStrategyStateAPI().pendingProposal()&&r.ctx.currentStrategyStateAPI().pendingProposal().decision_id===awaiting.decision_id);
 }
 // E) the proposal-specific binding (scope/epoch/freshness) captured at
 //    request time must be revalidated before trusting a judgment that
 //    arrives late — a matching decision_id/request_id, and an otherwise
 //    still-pending, still content-identical proposal, are not enough once
 //    THIS SPECIFIC binding's own deadline has passed. A fresh higher-
 //    sequence snapshot (content-identical awaiting record) keeps the
 //    canonical cache's blanket 5s TTL from itself wiping the proposal, so
 //    this isolates the binding deadline check from that unrelated effect.
 {
  const {r,awaiting,waiting}=makeAwaitingProposal();let deliver,reads=0,chatBody;
  const {c,errors}=wireJudgeCallCtx(r,async(url,opts)=>{
   if(url.endsWith('/api/tts'))return {ok:true,status:200,json:async()=>({audioContent:'fake'})};
   chatBody=JSON.parse(opts.body);
   return {ok:true,headers:{get:h=>h==='X-Pitwall-Judge-Transport'?'v1':null},
    body:{getReader:()=>({read:()=>++reads===1?new Promise(resolve=>deliver=resolve):Promise.resolve({done:true}),cancel:()=>{}})}};
  });
  const pending=c.callAPI('typed');await settle();check(!!deliver);
  const refreshed=copy(waiting);refreshed.snapshot_sequence+=1;refreshed.snapshot_id=refreshed.bridge_process_epoch+':'+refreshed.snapshot_sequence;
  r.clock(4000);r.receive(refreshed);  // keeps canonical cache fresh (new receivedAt) with the SAME awaiting record content
  check(r.ctx.currentStrategyStateAPI().pendingProposal()&&r.ctx.currentStrategyStateAPI().pendingProposal().decision_id===awaiting.decision_id);  // proposal itself untouched by the refresh
  r.clock(5100);  // now only the ORIGINAL binding's own 5s deadline (captured at request time, clock=0) has elapsed
  check(r.ctx.currentStrategyStateAPI().pendingProposal()&&r.ctx.currentStrategyStateAPI().pendingProposal().decision_id===awaiting.decision_id);  // proposal still present — canonical cache itself did not expire (refreshed at clock=4000)
  const ndjson=JSON.stringify({text:'了解した。'})+'\n'+JSON.stringify({judgment:{decision_id:chatBody.pendingJudgment.decision_id,classification:'confirm',request_id:chatBody.pendingJudgment.request_id}})+'\n'+JSON.stringify({end:true})+'\n';
  deliver({done:false,value:new TextEncoder().encode(ndjson)});await pending;await settle();
  assert.deepEqual(errors,[]);checks++;
  check(r.sent.filter(x=>x.cmd==='strategy_decision_response').length===0);
 }
 // D) applyProposalJudgeTag's same_topic path must use the explicit
 //    deliveryItem argument, not whatever the shared global
 //    lastQueuedSpeakItem happens to hold — reproduces the exact defect
 //    shape (an unrelated, already-dropped global item) and confirms the
 //    explicitly-passed item is what actually gates application.
 {
  const {r,awaiting}=makeAwaitingProposal();
  const c=r.ctx;
  vm.runInContext('const PW_JUDGE_TAG_START="<<PW_JUDGE";const PW_JUDGE_TAG_RE=/<<PW_JUDGE\\s+decision_id="([^"]*)"\\s+classification="(confirm|decline|same_topic|unrelated)"\\s*>>/;',c);
  vm.runInContext(extract('applyProposalJudgeTag'),c);
  const beforeRevision=r.ctx.currentStrategyStateAPI().pendingProposal().base_revision;
  c.lastQueuedSpeakItem={_finalized:'dropped_before_audible'};  // unrelated item, already finalized as NOT spoken
  const ownItem={_finalized:null,onSpoken:null};
  const judgment={decision_id:awaiting.decision_id,classification:'same_topic'};
  c.applyProposalJudgeTag(judgment,beforeRevision,ownItem);
  check(typeof ownItem.onSpoken==='function',JSON.stringify(ownItem));  // attached to the explicit item, not the global dropped one
  // If the global dropped item had been used instead, applyProposalJudgeTag's
  // "no target" branch fires synchronously and the proposal is left exactly
  // as-is — same observable state as "correctly still waiting". The only way
  // to tell the two apart is that the CORRECT behaviour waits specifically
  // for ownItem.onSpoken(), which this assertion drives directly.
  check(r.ctx.currentStrategyStateAPI().pendingProposal().base_revision===beforeRevision,
    'doApply must not run before the explicit deliveryItem is marked spoken');
  ownItem._finalized='spoken';ownItem.onSpoken();
  check(r.ctx.currentStrategyStateAPI().pendingProposal()
    && r.ctx.currentStrategyStateAPI().pendingProposal().base_revision!==beforeRevision
    && r.ctx.currentStrategyStateAPI().pendingProposal().decision_id===awaiting.decision_id,
    'doApply must run once the explicit deliveryItem (not the global) is marked spoken');
 }
 // F) actual callAPI(), two separate reader.read() chunks with an unrelated
 //    speak() interleaved between them (the real shape of an auto-broadcast
 //    landing during the await window) — the reply's OWN queued item must
 //    stay the deliveryItem even though the final flush queues nothing new
 //    (empty tail) and the GLOBAL lastQueuedSpeakItem has moved on.
 {
  const {r,awaiting}=makeAwaitingProposal();const beforeRevision=r.ctx.currentStrategyStateAPI().pendingProposal().base_revision;
  let deliver1,deliver2,reads=0,chatBody;
  const {c,errors,diag}=wireJudgeCallCtx(r,async(url,opts)=>{
   if(url.endsWith('/api/tts'))return {ok:true,status:200,json:async()=>({audioContent:'fake'})};
   chatBody=JSON.parse(opts.body);
   return {ok:true,headers:{get:h=>h==='X-Pitwall-Judge-Transport'?'v1':null},
    body:{getReader:()=>({read:()=>{
      reads++;
      if(reads===1)return new Promise(resolve=>deliver1=resolve);
      if(reads===2)return new Promise(resolve=>deliver2=resolve);
      return Promise.resolve({done:true});
    },cancel:()=>{}})}};
  });
  const pending=c.callAPI('typed');await settle();check(!!deliver1);
  deliver1({done:false,value:new TextEncoder().encode(JSON.stringify({text:'了解した。'})+'\n')});
  await settle();
  const ownItemRef=c.lastQueuedSpeakItem;
  check(!!ownItemRef&&ownItemRef.text==='了解した。',JSON.stringify(ownItemRef));  // this reply's own first sentence was queued
  c.speak('自動ラジオ',{kind:'radio'});  // unrelated auto-broadcast interleaves during the await window
  check(c.lastQueuedSpeakItem.kind==='radio'&&c.lastQueuedSpeakItem!==ownItemRef);  // global has moved on; ownItemRef has not
  check(!!deliver2);
  const ndjson2=JSON.stringify({judgment:{decision_id:chatBody.pendingJudgment.decision_id,classification:'same_topic',request_id:chatBody.pendingJudgment.request_id}})+'\n'+JSON.stringify({end:true})+'\n';
  deliver2({done:false,value:new TextEncoder().encode(ndjson2)});await pending;await settle();  // final flush's tail is empty — queues nothing new
  assert.deepEqual(errors,[]);checks++;
  check(typeof ownItemRef.onSpoken==='function',JSON.stringify(ownItemRef));  // same_topic hook landed on THIS reply's own item
  check(typeof c.lastQueuedSpeakItem.onSpoken!=='function');  // NOT on the unrelated radio item that is now the global
  ownItemRef._finalized='spoken';ownItemRef.onSpoken();
  check(r.ctx.currentStrategyStateAPI().pendingProposal()
    && r.ctx.currentStrategyStateAPI().pendingProposal().base_revision!==beforeRevision,
    'doApply must fire from the own-reply item being marked spoken, independent of the global');
 }
 // G) EOF with an unterminated trailing line in the NDJSON buffer must be
 //    flagged as a violation (not silently treated as "just incomplete").
 {
  const {r,awaiting}=makeAwaitingProposal();let deliver,reads=0,chatBody;
  const {c,errors,diag}=wireJudgeCallCtx(r,async(url,opts)=>{
   if(url.endsWith('/api/tts'))return {ok:true,status:200,json:async()=>({audioContent:'fake'})};
   chatBody=JSON.parse(opts.body);
   return {ok:true,headers:{get:h=>h==='X-Pitwall-Judge-Transport'?'v1':null},
    body:{getReader:()=>({read:()=>++reads===1?new Promise(resolve=>deliver=resolve):Promise.resolve({done:true}),cancel:()=>{}})}};
  });
  const pending=c.callAPI('typed');await settle();check(!!deliver);
  // The judgment line is itself well-formed and newline-terminated, but the
  // END frame is missing its trailing newline — the connection ends with an
  // unterminated tail still sitting in the NDJSON line buffer.
  const ndjson=JSON.stringify({text:'了解した。'})+'\n'+JSON.stringify({judgment:{decision_id:chatBody.pendingJudgment.decision_id,classification:'confirm',request_id:chatBody.pendingJudgment.request_id}})+'\n'+'{"end":true}';
  deliver({done:false,value:new TextEncoder().encode(ndjson)});await pending;await settle();
  assert.deepEqual(errors,[]);checks++;
  check(diag.some(d=>d.text==='judge_transport_unterminated_tail_at_eof'),JSON.stringify(diag));
  check(r.sent.filter(x=>x.cmd==='strategy_decision_response').length===0);
 }
 // H) a text frame arriving AFTER the judgment frame (but before end) is an
 //    order violation — judgment must be the last content-bearing frame.
 {
  const {r,awaiting}=makeAwaitingProposal();let deliver,reads=0,chatBody;
  const {c,errors,diag}=wireJudgeCallCtx(r,async(url,opts)=>{
   if(url.endsWith('/api/tts'))return {ok:true,status:200,json:async()=>({audioContent:'fake'})};
   chatBody=JSON.parse(opts.body);
   return {ok:true,headers:{get:h=>h==='X-Pitwall-Judge-Transport'?'v1':null},
    body:{getReader:()=>({read:()=>++reads===1?new Promise(resolve=>deliver=resolve):Promise.resolve({done:true}),cancel:()=>{}})}};
  });
  const pending=c.callAPI('typed');await settle();check(!!deliver);
  const ndjson=JSON.stringify({text:'了解した。'})+'\n'+JSON.stringify({judgment:{decision_id:chatBody.pendingJudgment.decision_id,classification:'confirm',request_id:chatBody.pendingJudgment.request_id}})+'\n'+JSON.stringify({text:'おまけの文。'})+'\n'+JSON.stringify({end:true})+'\n';
  deliver({done:false,value:new TextEncoder().encode(ndjson)});await pending;await settle();
  assert.deepEqual(errors,[]);checks++;
  check(diag.some(d=>d.text==='judge_transport_text_after_judgment'),JSON.stringify(diag));
  check(r.sent.filter(x=>x.cmd==='strategy_decision_response').length===0);
 }
 // I) same_topic's deferred doApply must re-check the captured binding at
 //    the moment onSpoken actually fires, not only at computation time —
 //    staleness occurring DURING the queue-delay window (after a valid
 //    judgment was negotiated, before delivery) must still block it.
 {
  const {r,awaiting,waiting}=makeAwaitingProposal();let deliver,reads=0,chatBody;
  const {c,errors}=wireJudgeCallCtx(r,async(url,opts)=>{
   if(url.endsWith('/api/tts'))return {ok:true,status:200,json:async()=>({audioContent:'fake'})};
   chatBody=JSON.parse(opts.body);
   return {ok:true,headers:{get:h=>h==='X-Pitwall-Judge-Transport'?'v1':null},
    body:{getReader:()=>({read:()=>++reads===1?new Promise(resolve=>deliver=resolve):Promise.resolve({done:true}),cancel:()=>{}})}};
  });
  const beforeRevision=r.ctx.currentStrategyStateAPI().pendingProposal().base_revision;
  const pending=c.callAPI('typed');await settle();check(!!deliver);
  const ndjson=JSON.stringify({text:'了解した。'})+'\n'+JSON.stringify({judgment:{decision_id:chatBody.pendingJudgment.decision_id,classification:'same_topic',request_id:chatBody.pendingJudgment.request_id}})+'\n'+JSON.stringify({end:true})+'\n';
  deliver({done:false,value:new TextEncoder().encode(ndjson)});await pending;await settle();
  assert.deepEqual(errors,[]);checks++;
  const ownItemRef=c.lastQueuedSpeakItem;
  check(typeof ownItemRef.onSpoken==='function');  // judgment validated and deferred while the binding was still fresh
  // Now let the binding go stale WHILE still waiting for onSpoken (refresh
  // the canonical cache so the blanket 5s TTL does not itself wipe the
  // proposal, exactly as scenario E isolates the binding deadline alone).
  const refreshed=copy(waiting);refreshed.snapshot_sequence+=1;refreshed.snapshot_id=refreshed.bridge_process_epoch+':'+refreshed.snapshot_sequence;
  r.clock(4000);r.receive(refreshed);
  r.clock(5100);
  check(r.ctx.currentStrategyStateAPI().pendingProposal()&&r.ctx.currentStrategyStateAPI().pendingProposal().decision_id===awaiting.decision_id);  // proposal itself still present
  ownItemRef._finalized='spoken';ownItemRef.onSpoken();  // now (late) marked spoken
  check(r.ctx.currentStrategyStateAPI().pendingProposal()
    && r.ctx.currentStrategyStateAPI().pendingProposal().base_revision===beforeRevision,
    'doApply must re-check the binding at the actual apply moment and refuse once it has gone stale during the deferral');
 }
 // J) ★2026-10-08 WO013途中レビュー差戻し「全路証明の不足」：scenario A-I全てが
 //    fetchをhand-written mockにしていた（実server.jsの契約を模しただけ）。
 //    ここだけ実server.js（child_process、SDKはtests-wo001-anthropic-stream-
 //    stub-preloadでstub——実Anthropic呼出し0）をnetwork越しに叩き、実レスポンス
 //    （実X-Pitwall-Judge-Transportヘッダ・実NDJSON）を実extracted callAPI()へ
 //    そのまま渡す。これでServer→Renderer境界がmockの模倣ではなく実バイト列で
 //    繋がる。Renderer→Bridge WS送信以降は他スイート（Python実poll replay）が
 //    別途担当——本テストはそこを再証明しない。
 {
  const {spawn}=child;
  const serverPort=3996;
  const child2=spawn(process.execPath,
    ['-r','./tests-wo001-anthropic-stream-stub-preload.js','server.js'],
    {cwd:__dirname,env:{...process.env,PORT:String(serverPort),ANTHROPIC_API_KEY:'sk-test-local-stub',DATABASE_URL:'',JWT_SECRET:'',STRIPE_SECRET_KEY:''}});
  try{
   await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('actual server did not start in time')),15000);
    child2.stdout.on('data',d=>{if(d.toString().includes('is running')){clearTimeout(timer);resolve();}});
    child2.stderr.on('data',d=>process.stderr.write('[actual-server] '+d));
    child2.on('exit',code=>{clearTimeout(timer);reject(new Error('actual server exited early: code='+code));});
   });
   const {r,awaiting}=makeAwaitingProposal();
   const {c,errors}=wireJudgeCallCtx(r,fetch);  // the REAL global fetch, no mock
   const stub=require('./tests-wo001-anthropic-stream-stub-preload.js');
   const TAG='<<PW_JUDGE decision_id="'+awaiting.decision_id+'" classification="confirm">>';
   const scenario=Buffer.from(JSON.stringify({chunks:['了解した。\n'+TAG]})).toString('base64');
   c.API_BASE='http://localhost:'+serverPort;
   c.messages=[{role:'user',content:'その提案に賛成だ '+stub.MARKER+scenario}];
   await c.callAPI('typed');
   assert.deepEqual(errors,[]);checks++;
   check(r.sent.filter(x=>x.cmd==='strategy_decision_response'&&x.decision_id===awaiting.decision_id&&x.accepted===true).length===1,
     JSON.stringify(r.sent));  // confirmed via a REAL network round trip through the REAL server.js
   check(r.ctx.currentStrategyStateAPI().pendingProposal()===null);
  } finally { child2.kill('SIGTERM'); }
 }
}

function radioPublicationTests(){
 const r=make();r.connect(radioProducer.snapshot.bridge_process_epoch);r.receive(radioProducer.snapshot);const c=r.ctx;
 Object.assign(c,{sel:'James',lastTelemetry:radioProducer.telemetry,PitwallFuelSafetyOverrideGuard:require('./desktop/fuel-safety-override-guard'),PitwallFuelPlanGuard:require('./desktop/fuel-plan-guard'),toReflexEvent:()=>null,LAP_READOUT_KINDS:new Set()});
 vm.runInContext(extract('injectRadio'),c);
 c.injectRadio({...radioProducer.radio,canonical_snapshot_id:'old-publication'});check(r.speech.length===0);
 c.injectRadio(radioProducer.radio);check(r.speech.length===1);check(r.speech[0].o.precheck());check(r.speech[0].text===radioProducer.radio.message);
 r.clock(6000);check(!r.speech[0].o.precheck());c.injectRadio(radioProducer.radio);check(r.speech.length===1);
}
