#!/usr/bin/env node
'use strict';

const fs=require('fs'), path=require('path'), vm=require('vm');
const Store=require('./desktop/critical-journal-store'),Client=require('./desktop/critical-journal-client'),os=require('os');
const store=Store.create(path.join(fs.mkdtempSync(path.join(os.tmpdir(),'pitwall-command-')),'journal.json'));store.load();
const criticalJournal=Client.create({criticalJournalLoad:store.load,criticalJournalTransact:store.transact});
const router=require('./desktop/local-intent-router.js');
const CF=require('./tests-canonical-lifecycle');
const canonicalSnapshot=CF.fixture({race:'race-1',session:0,decision:'plan-a',frame:50,pit:2});canonicalSnapshot.lifecycle.active.activated_source_frame_sequence=40;canonicalSnapshot.box_delivery.attempts[0].activation_frame=40;
canonicalSnapshot.continuity.stable_scope={race_instance_id:'race-1',session_num:0,driver_id:10101};
const commandRefs=CF.refs(canonicalSnapshot);
let pass=0, fail=0;
function check(name, value){ if(value){pass++;console.log('✅ '+name);}else{fail++;console.log('❌ '+name);} }
function extract(src,name){
  const start=src.indexOf('function '+name+'('); if(start<0) throw new Error(name+' missing');
  let i=src.indexOf('{',start), depth=0;
  for(;i<src.length;i++){ if(src[i]==='{')depth++; else if(src[i]==='}'&&--depth===0)return src.slice(start,i+1); }
  throw new Error(name+' unbalanced');
}

const live={lap:20,race_instance_id:'race-1',session_num:0,source_frame_sequence:50,
  driver_pit_sequence:2,active_plan_decision_id:'plan-a',active_plan_revision:0,
  active_plan_activated_source_frame_sequence:40};
const early=router.route({text:'ピット入るぞ',lang:'ja',live});
check('early pit is request-only, not fake applied', early.handled===true
  &&early.intent==='pit_execution_declaration'&&early.action.type==='driver_plan_command'
  &&early.action.operation==='early_pit'&&!('activePlanChange' in early.action));
check('explicit amend carries only validated lap request',
  router.route({text:'ピットを23周目に変更',lang:'ja',live}).action.requestedTargetLap===23);
check('explicit cancel is narrow command',
  router.route({text:'このプランを取り消す',lang:'ja',live}).action.operation==='cancel');
check('pit window remains outside WO-006 command classifier',
  router.driverPlanCommand('フューエルウィンドウ開いたらピット入る')===null);
check('standalone reason declaration creates a new request with reason',
  router.route({text:'前の25が遅いから先に入る',lang:'ja',live}).action.reasonText==='前の25が遅いから先に入る');
const linked=router.route({text:'前の25が遅いから先に入る',lang:'ja',live,
  pendingDriverPlanCommand:{commandId:'cmd-1',operation:'early_pit'}});
check('immediate reason requires supplied predecessor candidate', linked.handled===true
  &&linked.intent==='pit_execution_reason'&&linked.action.type==='driver_plan_reason');

const renderer=fs.readFileSync(path.join(__dirname,'desktop','renderer.html'),'utf8');
const names=['newDriverPlanCommandId','currentDriverPlanAuthority','flushDriverPlanCommandOutbox',
  'queueDriverPlanCommand','sendDriverPlanReason','handleDriverPlanCommandAck','confirmCanonicalCommandReadbacks'];
const sent=[], spoken=[];
const ctx={criticalJournal,performance:{now:()=>0},canonicalLifecycleCache:CF.initialized(()=>0,canonicalSnapshot),console,Date,Math,globalThis:null,lastTelemetry:{...live},lastSessionNum:0,
  irBridge:{readyState:0,send:s=>sent.push(JSON.parse(s))},driverPlanCommandOutbox:new Map(),
  pendingDriverPlanFollowup:null,pendingCanonicalCommandReadbacks:new Map(),diagnosticLog:()=>{},nextUtteranceId:()=> 'u1',
  bridgeStrategyDecisions:new Map([['b',{dispatchId:'d'}]]),strategyResponseOutbox:new Map(),
  strategyDeliveryOutbox:new Map(),strategyPlaybookDecisionKeys:new Set(['d']),
  isJapaneseEngineer:()=>true,addMsg:()=>{},pushMsg:()=>{},speak:m=>spoken.push(m),
  SPEAK_PRIO:{P2_PROCEDURE:2},ensureStrategyState:()=>({}),
  PitwallSessionStrategyState:{invalidatePendingProposal:()=>{}},crypto:{randomUUID:()=> 'cmd-1'}};
ctx.globalThis=ctx;
ctx.strategyProjection=require('./desktop/strategy-state-projection').create({canonical:ctx.canonicalLifecycleCache,now:()=>0});
ctx.ensureStrategyState=ctx.strategyProjection.state;ctx.currentStrategyStateAPI=()=>ctx.strategyProjection.api;
vm.createContext(ctx);
vm.runInContext(names.map(n=>extract(renderer,n)).join('\n'),ctx);

const id=ctx.queueDriverPlanCommand({operation:'early_pit',requestedTargetLap:null},'ピット入るぞ','u1');
check('offline command remains in outbox and does not speak success', id==='cmd-1'
  &&ctx.driverPlanCommandOutbox.size===1&&spoken.length===0&&sent.length===0);
ctx.irBridge.readyState=1; ctx.flushDriverPlanCommandOutbox();
check('reconnect sends full command envelope', sent.length===1&&sent[0].cmd==='driver_plan_command'
  &&sent[0].race_instance_id==='race-1'&&sent[0].expected_decision_id==='plan-a'
  &&sent[0].source_frame_sequence===50&&sent[0].driver_pit_sequence===2);
ctx.handleDriverPlanCommandAck({...commandRefs,type:'driver_plan_command_ack',command_id:'cmd-1',
  race_instance_id:'wrong',session_num:0,decision_id:'plan-a',expected_revision:0,outcome:'applied'});
check('wrong identity ACK cannot remove outbox or speak',ctx.driverPlanCommandOutbox.size===1&&spoken.length===0);
ctx.handleDriverPlanCommandAck({...commandRefs,type:'driver_plan_command_ack',command_id:'cmd-1',
  race_instance_id:'race-1',session_num:0,decision_id:'plan-a',expected_revision:0,
  intent:'cancel',lifecycle_phase:'cancelled',result_revision:1,outcome:'applied'});
check('wrong intent ACK cannot remove outbox, speak, or clear transport',ctx.driverPlanCommandOutbox.size===1
  &&spoken.length===0&&ctx.bridgeStrategyDecisions.size===1);
ctx.handleDriverPlanCommandAck({...commandRefs,type:'driver_plan_command_ack',command_id:'cmd-1',
  race_instance_id:'race-1',session_num:0,decision_id:'plan-a',expected_revision:0,
  intent:'early_pit',lifecycle_phase:'cancelled',result_revision:1,outcome:'applied'});
check('wrong lifecycle phase ACK fails closed',ctx.driverPlanCommandOutbox.size===1
  &&spoken.length===0&&ctx.bridgeStrategyDecisions.size===1);
ctx.handleDriverPlanCommandAck({...commandRefs,type:'driver_plan_command_ack',command_id:'cmd-1',
  race_instance_id:'race-1',session_num:0,decision_id:'plan-a',expected_revision:0,
  intent:'early_pit',lifecycle_phase:'invalidated',result_revision:9,outcome:'applied'});
check('wrong result revision ACK fails closed',ctx.driverPlanCommandOutbox.size===1
  &&spoken.length===0&&ctx.bridgeStrategyDecisions.size===1);
ctx.handleDriverPlanCommandAck({...commandRefs,type:'driver_plan_command_ack',command_id:'cmd-1',
  race_instance_id:'race-1',session_num:0,decision_id:'plan-a',expected_revision:0,
  intent:'early_pit',lifecycle_phase:'active',result_revision:0,outcome:'rejected'});
check('malformed rejected ACK also fails closed',ctx.driverPlanCommandOutbox.size===1
  &&spoken.length===0&&ctx.bridgeStrategyDecisions.size===1);
ctx.handleDriverPlanCommandAck({...commandRefs,type:'driver_plan_command_ack',command_id:'cmd-1',
  race_instance_id:'race-1',session_num:0,decision_id:'plan-a',expected_revision:0,
  intent:'early_pit',lifecycle_phase:'invalidated',result_revision:1,outcome:'applied'});
check('matching applied ACK retires receipt but waits for canonical readback',ctx.driverPlanCommandOutbox.size===0&&spoken.length===0&&ctx.pendingCanonicalCommandReadbacks.size===1);
const terminal=JSON.parse(JSON.stringify(canonicalSnapshot));terminal.snapshot_sequence=2;terminal.snapshot_id='epoch-a:2';terminal.lifecycle.terminal_records=[{...terminal.lifecycle.active,revision:1,phase:'invalidated',record_ref:{...terminal.lifecycle.active.record_ref,revision:1}}];terminal.lifecycle.active=null;terminal.lifecycle.active_plan_id=null;terminal.execution.allowed=false;terminal.box_delivery.allowed_proof_id=null;terminal.box_delivery.allowed_attempt_id=null;terminal.box_delivery.valid_until_session_s=null;terminal.box_delivery.attempts=[];ctx.canonicalLifecycleCache.receive(terminal);ctx.confirmCanonicalCommandReadbacks();check('matching canonical terminal causes one success readback',spoken.length===1&&ctx.pendingCanonicalCommandReadbacks.size===0);
check('matching applied ACK clears old proposal transport effects',ctx.bridgeStrategyDecisions.size===0
  &&ctx.strategyPlaybookDecisionKeys.size===0);

ctx.pendingDriverPlanFollowup={commandId:'cmd-r1',decisionId:'plan-a',raceInstanceId:'race-1',
  sessionNum:0,revision:0,bridgeProcessEpoch:commandRefs.bridge_process_epoch,canonicalSnapshotId:commandRefs.canonical_snapshot_id,canonicalSnapshotSequence:commandRefs.canonical_snapshot_sequence,expiresAt:Date.now()+15000};
ctx.irBridge.readyState=0;
check('closed socket consumes the one-turn reason candidate',ctx.sendDriverPlanReason({reasonText:'traffic'})===false
  &&ctx.pendingDriverPlanFollowup===null);
ctx.pendingDriverPlanFollowup={commandId:'cmd-r2',decisionId:'plan-a',raceInstanceId:'race-1',
  sessionNum:0,revision:0,bridgeProcessEpoch:commandRefs.bridge_process_epoch,canonicalSnapshotId:commandRefs.canonical_snapshot_id,canonicalSnapshotSequence:commandRefs.canonical_snapshot_sequence,expiresAt:Date.now()+15000};
ctx.irBridge={readyState:1,send:()=>{throw new Error('closed');}};
check('send throw consumes the one-turn reason candidate',ctx.sendDriverPlanReason({reasonText:'fuel'})===true
  &&ctx.pendingDriverPlanFollowup===null);
ctx.pendingDriverPlanFollowup={commandId:'cmd-r3',decisionId:'plan-a',raceInstanceId:'race-1',
  sessionNum:0,revision:0,bridgeProcessEpoch:commandRefs.bridge_process_epoch,canonicalSnapshotId:commandRefs.canonical_snapshot_id,canonicalSnapshotSequence:commandRefs.canonical_snapshot_sequence,expiresAt:Date.now()-1};
check('expired reason candidate is consumed',ctx.sendDriverPlanReason({reasonText:'traffic'})===false
  &&ctx.pendingDriverPlanFollowup===null);
check('a later reason turn cannot reuse a consumed candidate',
  router.route({text:'前が遅いから',lang:'ja',live,pendingDriverPlanCommand:ctx.pendingDriverPlanFollowup}).handled===false);

// Execute the actual production sendMsg branch with the actual router and
// command queue function.  All earlier unrelated handlers are inert stubs.
const sendMsgSrc=extract(renderer,'sendMsg');
const sentBySendMsg=[];
const input={value:'ピット入るぞ',style:{height:'x'}};
const ctx2={criticalJournal,performance:{now:()=>0},canonicalLifecycleCache:CF.initialized(()=>0,canonicalSnapshot),console,Date,Math,globalThis:null,window:null,document:{getElementById:()=>input},
  isBusy:false,addMsg:()=>{},captureConfirmedFuelCapacity:()=>{},maybeQuietMode:()=>{},pushMsg:()=>{},
  turns:0,sessionMsgCount:0,prepareMemoryBrain:()=>{},pendingConfirmationKinds:()=>[],
  bareConfirmationAnswer:()=>null,pendingDrivingStyleAdvice:null,handleLunaSelfMemoryInput:()=>null,
  handleReflexDispute:()=>false,handleTeamPlanUtterance:()=>false,handleGapDispute:()=>false,
  handleRelativePaceQuestion:()=>false,ensureConversationBox:()=>null,ensureStrategyState:()=>null,
  selMode:'race',iracingLive:true,lastTelemetry:{...live},lastTelemetryAt:Date.now(),
  lastTrack:null,lastCarClass:null,lastCarModel:null,lastSessionNum:0,sel:'Kanbe',
  currentCanonicalStrategyLive:x=>x,currentStrategyPlaybook:()=>null,pendingDriverPlanFollowup:null,driverPlanCommandOutbox:new Map(),
  irBridge:{readyState:1,send:s=>sentBySendMsg.push(JSON.parse(s))},diagnosticLog:()=>{},
  nextUtteranceId:()=> 'actual-sendmsg-u1',crypto:{randomUUID:()=> 'actual-sendmsg-cmd'},
  SPEAK_PRIO:{P2_PROCEDURE:2},speak:()=>{},bridgeStrategyDecisions:new Map(),
  strategyResponseOutbox:new Map(),strategyDeliveryOutbox:new Map(),strategyPlaybookDecisionKeys:new Set()};
ctx2.globalThis=ctx2;ctx2.window=ctx2;ctx2.PitwallLocalIntentRouter=router;
ctx2.currentMemoryUserId=()=>null;ctx2.lastTrackId=null;ctx2.lastSessionAuthority=null;ctx2.lastSessionType='RACE';
ctx2.PitwallRaceMemoryScope=require('./desktop/race-memory-scope');ctx2.localStorage={getItem:()=>null};
vm.createContext(ctx2);
vm.runInContext(['syncFuelReferenceEvidence','currentMemoryIdentity','localMemoryOwnerRef','memoryTrackCandidates'].map(n=>extract(renderer,n)).join('\n')+'\n'+names.slice(0,4).map(n=>extract(renderer,n)).join('\n')+'\nasync '+sendMsgSrc,ctx2);
ctx2.sendMsg('typed');
check('actual sendMsg final turn emits the production WS command envelope',sentBySendMsg.length===1
  &&sentBySendMsg[0].cmd==='driver_plan_command'&&sentBySendMsg[0].command_id==='actual-sendmsg-cmd'
  &&sentBySendMsg[0].expected_decision_id==='plan-a'&&sentBySendMsg[0].intent==='early_pit');

// Isolate the independent amend case from the still-unACK reason.
ctx.driverPlanCommandOutbox.clear();
const amendEnvelope={cmd:'driver_plan_command',expected_activation_source_frame_sequence:40,text:'amend',reason_text:null,utterance_id:null,...commandRefs,command_id:'amend-1',race_instance_id:'race-1',session_num:0,
 expected_decision_id:'plan-a',expected_revision:0,intent:'amend',source_frame_sequence:50,
 driver_pit_sequence:2,requested_target_lap:23};
criticalJournal.put('driver_plan_command',amendEnvelope);ctx.driverPlanCommandOutbox.set(criticalJournal.key('driver_plan_command',amendEnvelope),{envelope:amendEnvelope});
const amendAck={type:'driver_plan_command_ack',...amendEnvelope,decision_id:'plan-a',outcome:'applied',lifecycle_phase:'invalidated',result_revision:1,
 successor_decision_id:'new-a',successor_revision:0,successor_activation_frame:51,
 successor_target_lap:23,successor_add_fuel_l:12.2,successor_set_fuel_l:13,constraint_id:'constraint'};
const before=spoken.length;
ctx.handleDriverPlanCommandAck(amendAck);
check('amend ACK without canonical successor evidence fails closed',spoken.length===before&&ctx.driverPlanCommandOutbox.size===1);
amendAck.authority_snapshot={race_instance_id:'race-1',session_num:0,source_frame_sequence:51,
 driver_pit_sequence:2,successor_decision_id:'new-a',successor_revision:0,successor_activation_frame:51,
 target_lap:23,add_fuel_l:12.2,set_fuel_l:13,constraint_id:'constraint'};
ctx.handleDriverPlanCommandAck({...amendAck,successor_target_lap:24});
check('different adopted target cannot confirm success',spoken.length===before);
ctx.handleDriverPlanCommandAck(amendAck);
check('matching successor ACK waits for currently adopted canonical target',spoken.length===before&&ctx.driverPlanCommandOutbox.size===0);
const successor=JSON.parse(JSON.stringify(canonicalSnapshot));successor.snapshot_sequence=3;successor.snapshot_id='epoch-a:3';successor.source_frame.sequence=51;successor.race_facts.source_frame.sequence=51;successor.race_facts.black_flag.source_frame_sequence=51;successor.current_facts.source_frame.sequence=51;successor.finish.source_frame_sequence=51;successor.lifecycle.active={...successor.lifecycle.active,decision_id:'new-a',revision:0,target_lap:23,add_fuel_l:12.2,set_fuel_l:13,activated_source_frame_sequence:51,record_ref:{...successor.lifecycle.active.record_ref,decision_id:'new-a'}};successor.lifecycle.active_plan_id='new-a';successor.execution.allowed=false;successor.box_delivery={allowed_proof_id:null,allowed_attempt_id:null,valid_until_session_s:null,attempts:[]};ctx.canonicalLifecycleCache.receive(successor);ctx.confirmCanonicalCommandReadbacks();check('matching canonical successor speaks adopted target once',spoken.length===before+1&&spoken.at(-1).includes('23'));
ctx.handleDriverPlanCommandAck({...amendAck,outcome:'retry_no_op'});
check('same command retry cannot speak twice',spoken.length===before+1);

// Canonical authority and epoch fences run through the real command consumer.
check('command carries the accepted canonical reference',sent[0].bridge_process_epoch===commandRefs.bridge_process_epoch&&sent[0].canonical_snapshot_id===commandRefs.canonical_snapshot_id);
const oldEnvelope={...amendEnvelope,command_id:'old-command'};criticalJournal.put('driver_plan_command',oldEnvelope);const oldKey=criticalJournal.key('driver_plan_command',oldEnvelope);ctx.driverPlanCommandOutbox.set(oldKey,{envelope:oldEnvelope,attempts:0});
const nextGeneration=ctx.canonicalLifecycleCache.beginSocket(),beforeSend=sent.length;
ctx.irBridge={readyState:1,send:s=>sent.push(JSON.parse(s))};ctx.flushDriverPlanCommandOutbox();
check('hello pending does not resend old commands',sent.length===beforeSend);
ctx.canonicalLifecycleCache.hello(nextGeneration,{type:'connected',schema_version:1,bridge_process_epoch:'epoch-b'});
const newCanonical=CF.fixture({epoch:'epoch-b',race:'race-1',session:0,decision:'new-process-plan',frame:1,pit:0});ctx.canonicalLifecycleCache.receive(newCanonical);
ctx.flushDriverPlanCommandOutbox();check('new epoch preserves old command and sends only historical route',sent.length===beforeSend+1&&sent.at(-1).cmd==='historical_settlement'&&sent.at(-1).payload.bridge_process_epoch===commandRefs.bridge_process_epoch);
ctx.handleDriverPlanCommandAck({...amendAck,command_id:'old-command'});check('old epoch ACK cannot retire orphan command',ctx.driverPlanCommandOutbox.has(oldKey));
ctx.lastTelemetry={...live,active_plan_decision_id:'old-legacy-plan'};
check('new process fresh decision uses small source frame and ignores old legacy plan',ctx.currentDriverPlanAuthority().decisionId==='new-process-plan'&&ctx.currentDriverPlanAuthority().sourceFrame===1);
ctx.canonicalLifecycleCache.disconnect();check('disconnect removes command authority without legacy fallback',ctx.currentDriverPlanAuthority()===null&&ctx.queueDriverPlanCommand({operation:'cancel'},'cancel')===null);

console.log(`\nDriver Plan Command wiring: ${pass}/${pass+fail}`);
process.exit(fail?1:0);
