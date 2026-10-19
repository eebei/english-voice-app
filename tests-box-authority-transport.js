#!/usr/bin/env node
'use strict';
const CF=require('./tests-canonical-lifecycle'),C=require('./desktop/canonical-lifecycle-cache');
const assert=require('assert'),fs=require('fs'),vm=require('vm'),T=require('./desktop/box-authority-transport');

// Synthetic WO008 queue fixtures explicitly gain a WO009 canonical authority envelope.
// Production wire cases below use the Bridge-produced canonical snapshot, never this adapter.
function prepareSynthetic(transport,canonical){let seq=0;
 const receive=transport.receiveSnapshot,accept=transport.accept;let latest=null,last=null;
 transport.receiveSnapshot=s=>{
  const sig=JSON.stringify(s);if(last===sig)return receive({...s,...CF.refs(latest)});
  const x=CF.fixture({seq:++seq,frame:s.source_frame_sequence,race:s.race_instance_id,session:s.session_num,decision:s.active_decision_id,lap:s.current_lap,pit:s.driver_pit_sequence,proof:s.allowed_proof_id,attempt:s.allowed_attempt_id,allowed:!s.closed&&!s.collision});
  x.current_facts.source_frame.session_time_s=s.session_time_s;x.source_frame.session_time_s=s.session_time_s;x.race_facts.source_frame.session_time_s=s.session_time_s;x.race_facts.black_flag.observed_session_time=s.session_time_s;x.box_delivery.valid_until_session_s=s.valid_until_session_s;
  if(x.lifecycle.active){x.lifecycle.active.revision=s.plan_revision;x.lifecycle.active.activated_source_frame_sequence=s.activation_frame;for(const a of x.box_delivery.attempts){a.plan_revision=s.plan_revision;a.activation_frame=s.activation_frame;}}
  x.execution={allowed:!s.closed&&!s.collision&&s.execution_gate===null,gate_reason:s.execution_gate,scope_closed:s.closed,collision:s.collision,visit_open:false};
  if(!x.execution.allowed){x.box_delivery.allowed_proof_id=null;x.box_delivery.allowed_attempt_id=null;}
  canonical.receive(x);latest=x;last=sig;return receive({...s,execution_gate:x.execution.allowed?s.execution_gate:(s.execution_gate||'execution_unavailable'),allowed_proof_id:x.box_delivery.allowed_proof_id,allowed_attempt_id:x.box_delivery.allowed_attempt_id,...CF.refs(x)});
 };
 transport.accept=d=>accept({...d,...(latest?CF.refs(latest):{})});return transport;
}
function syntheticTransport(opts){const canonical=C.create({now:opts.now}),g=canonical.beginSocket();canonical.hello(g,{type:'connected',schema_version:1,bridge_process_epoch:'epoch-a'});const t=T.create({...opts,canonical});t.setEpoch('epoch-a');return prepareSynthetic(t,canonical);}

let count=0;function check(v){assert(v);count++;}
let clock=0,sent=[],revoked=[];
const t=syntheticTransport({now:()=>clock,send:r=>sent.push(r),revoke:id=>revoked.push(id)});t.setConnected(true);
const f={schema_version:1,race_instance_id:'r',session_num:1,source_frame_sequence:10,session_time_s:100,current_lap:20,total_laps:25,lap_dist_pct:.5,crossings_to_finish:6,finish_kind:'lap_race',fuel_level_l:5,avg_fuel_per_lap_l:2,clean_laps_sampled:3,reserve_l:1,effective_capacity_l:20,max_set_fuel_l:20,driver_pit_sequence:0,multi_stop:false};
const proof={schema_version:1,proof_id:'p',race_instance_id:'r',session_num:1,decision_id:'d',plan_revision:0,activation_frame:5,issued_source_frame:10,issued_session_time:100,driver_pit_sequence:0,expected_pit_sequence:1,selected_plan:'A',target_lap:20,add_fuel_l:7,set_fuel_l:7,constraint_id:'c',validation:{available:true,geometry_contract:'coupled_current_running_lap',target_lap:20,target_in_laps:0,set_fuel_l:7},fuel_inputs:f,validity_contract:{ttl_seconds:5,window:'same_target_lap'}};
const attempt={attempt_id:'a',proof_id:'p',race_instance_id:'r',session_num:1,decision_id:'d',plan_revision:0,activation_frame:5,driver_pit_sequence:0,dispatch_sequence:1};
const snapshot={type:'box_authority_snapshot',race_instance_id:'r',session_num:1,source_frame_sequence:10,session_time_s:100,active_decision_id:'d',active_phase:'active',plan_revision:0,activation_frame:5,driver_pit_sequence:0,current_lap:20,execution_gate:null,closed:false,collision:false,allowed_proof_id:'p',allowed_attempt_id:'a',valid_until_session_s:105};
const data={authority_proof:proof,box_attempt:attempt,trigger:'strategy_plan_box_call'};
check(t.accept({...data,authority_proof:null})===null);check(t.receiveSnapshot(snapshot));
const delivery=t.accept(data);check(delivery&&delivery.precheck());proof.fuel_inputs.fuel_level_l=0;check(delivery.proof.fuel_inputs.fuel_level_l===5);f.fuel_level_l=5;
check(t.accept(data)===null);
clock=4999;check(t.receiveSnapshot({...snapshot,source_frame_sequence:11,session_time_s:101}));check(delivery.precheck());clock=5000;check(!delivery.precheck());t.tick();check(revoked.includes('a'));
delivery.onSpoken();delivery.onSpoken();check(sent.filter(r=>r.outcome==='audible_started').length===1);
t.setConnected(false);delivery.onAudibleInterrupted();check(t.outbox.size===2);t.setConnected(true);check(sent.some(r=>r.outcome==='audible_interrupted'));
const r=sent.find(r=>r.outcome==='audible_started');check(!t.ack({...r,applied:'applied',attempt_id:'wrong'}));check(t.ack({...r,applied:'applied'}));check(t.outbox.size===1);
check(!t.receiveSnapshot(snapshot));
// Adversarial payloads and source-ordering, with fresh independent receivers.
for(const change of [p=>p.set_fuel_l=true,p=>p.fuel_inputs.lap_dist_pct=NaN,
 p=>p.fuel_inputs.effective_capacity_l=null,p=>p.expected_pit_sequence=5,
 p=>p.validation.available=false,p=>p.fuel_inputs.finish_kind='provisional',
 p=>p.fuel_inputs.fuel_level_l=21,p=>p.activation_frame=999]){
 const bad=JSON.parse(JSON.stringify(proof));change(bad);
 const x=syntheticTransport({now:()=>0,send:()=>{},revoke:()=>{}});x.setConnected(true);x.receiveSnapshot(snapshot);
 check(x.accept({authority_proof:bad,box_attempt:attempt})===null);
}
const order=syntheticTransport({now:()=>0,send:()=>{},revoke:()=>{}});order.setConnected(true);
order.receiveSnapshot({...snapshot,race_instance_id:'new',source_frame_sequence:99});
check(!order.receiveSnapshot({...snapshot,source_frame_sequence:98}));
check(order.accept(data)===null);
let throwSend=true;
const offline=syntheticTransport({now:()=>0,send:()=>{if(throwSend)throw Error('send');},revoke:()=>{}});
offline.setConnected(true);offline.receiveSnapshot(snapshot);const pending=offline.accept(data);pending.onSpoken();
check(offline.outbox.size===1);throwSend=false;offline.flush();check(offline.outbox.size===1);
// A different attempt cannot renew the same immutable proof's Desktop deadline.
let proofClock=0;
const ttl=syntheticTransport({now:()=>proofClock,send:()=>{},revoke:()=>{}});ttl.setConnected(true);ttl.receiveSnapshot(snapshot);check(!!ttl.accept(data));
proofClock=5000;ttl.receiveSnapshot({...snapshot,source_frame_sequence:11,session_time_s:101,allowed_attempt_id:'new-attempt'});
check(ttl.accept({...data,box_attempt:{...attempt,attempt_id:'new-attempt'}})===null);
// Real Renderer handler + real queue and real drainQueue with delayed cloud fetch.
const src=fs.readFileSync('desktop/renderer.html','utf8');
function extract(name){const re=new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}');const m=src.match(re);assert(m,name);return m[0];}
async function rendererCase(revokeDuringFetch,fallback,voiceOff=false,english=false,wireCase=null,missingPrepublication=false){
 let play=0,fetchResolve,spoken=0;
 let transport;const caseData=wireCase?wireCase.candidate:data,caseSnapshot=wireCase?wireCase.snapshot:snapshot;
 if(wireCase){const canonical=C.create({now:()=>0}),g=canonical.beginSocket();canonical.hello(g,wireCase.hello);if(!missingPrepublication)check(canonical.receive(wireCase.canonical));transport=T.create({canonical,now:()=>0,send:()=>{},revoke:()=>{}});transport.setEpoch(wireCase.canonical.bridge_process_epoch);}
 else transport=syntheticTransport({now:()=>0,send:()=>{},revoke:()=>{}});transport.setConnected(true);if(!missingPrepublication)transport.receiveSnapshot(caseSnapshot);
 const c={console,Date,Math,Map,Set,AbortController,performance:{now:()=>0},boxAuthorityTransport:transport,
 selMode:'race',voiceOn:!voiceOff,isJapaneseEngineer:()=>!english,addMsg:()=>null,nextUtteranceId:()=> 'u',
 speakQueue:[],lastQueuedSpeakItem:null,SPEAK_PRIO:{P0_SAFETY:0,P1_HAZARD:1,P2_PROCEDURE:2,P4_INFO:4},
 IMMEDIATE_PIT_KINDS:new Set(),MAX_RADIO_QUEUE:2,MAX_SPEAK_QUEUE:20,currentSpeakPrio:9,currentSpeakItem:null,
 isSpeaking:false,draining:false,speakGateActive:false,speakWindowOk:true,speakGeneration:0,
 CHARS:{x:{gVoice:'voice',gLang:'en',voiceLang:'en'}},sel:'x',autoMicActive:false,
 speechLatencyTrace:()=>{},diagnosticLog:()=>{},shouldDeferSpeak:()=>false,deferSpeakItem:()=>false,utteranceTrace:()=>{},
 currentGapAuthority:()=>null,ttsAudio:null,speakFetchCtrl:null,speakWatchdog:null,ttsDisabledUntil:0,
 phonetify:x=>x,normalizeLunaSpeech:x=>x,stripMarkdown:x=>x,stripParens:x=>x,stripEmoji:x=>x,
 ttsFailLog:()=>{},ttsEventLog:()=>{},pwVolume:1,usageSessionId:'s',API_BASE:'mock',
 localStorage:{getItem:()=>null},getDeviceId:()=> 'test',setTimeout:()=>1,clearTimeout:()=>{},
 playWebSpeech:(text,char,gen,done,start)=>{play++;start();done();},
 onUtteranceDone:()=>{c.draining=false;c.isSpeaking=false;},
 finalizeUtterance:(item,outcome)=>{item._finalized=outcome;if(outcome==='spoken'){spoken++;item.onSpoken?.();}item.onDelivery?.(outcome);},
 Audio:class{constructor(){this.volume=1;}async play(){play++;}},
 fetch:()=>new Promise(resolve=>{fetchResolve=resolve;})};
 vm.createContext(c);vm.runInContext(['deriveUtteranceSource','stableTextHash','speak','drainQueue','finalizeUtterance','handleStrategyPlanBoxCall'].map(extract).join('\n'),c);
 c.handleStrategyPlanBoxCall(caseData);
 if(missingPrepublication){check(!fetchResolve);check(play===0);assert.throws(()=>assert.strictEqual(play,1));count++;return;}
 if(voiceOff){check(!fetchResolve);check([...transport.outbox.values()].some(r=>r.outcome==='suppressed_by_user'));return;}
 if(english)check(c.currentSpeakItem.text==='Box, box. Add '+caseData.authority_proof.set_fuel_l+' litres.');
 check(!!fetchResolve);check(c.currentSpeakItem.text.includes(String(caseData.authority_proof.set_fuel_l)));check(c.currentSpeakItem.boxAttemptId===caseData.box_attempt.attempt_id);
 if(revokeDuringFetch)transport.receiveSnapshot({...snapshot,source_frame_sequence:11,session_time_s:101,execution_gate:'black_flag'});
 fetchResolve(fallback?{ok:false,status:500}:{ok:true,status:200,json:async()=>({audioContent:'fake'})});
 await new Promise(resolve=>setImmediate(resolve));
 check(play===(revokeDuringFetch?0:1));check(c.currentSpeakItem._finalized===(revokeDuringFetch?'dropped_before_audible':'spoken'));
 if(!revokeDuringFetch)check([...transport.outbox.values()].some(r=>r.outcome==='audible_started'));
 else check([...transport.outbox.values()].some(r=>r.outcome==='dropped_before_audible'));
 // WO015: wireCase.ack came from tests_wo008_fixed_target.py's hand-built
 // Python report (no real speak(), so utterance_id/text_hash are honestly
 // absent there), spliced via report_event_id onto the report THIS renderer
 // harness's OWN real speak() actually produced (which does carry a real
 // utterance_id/text_hash). This test's point is the Python-shaped ack's
 // BINDINGS/scope fields, not metadata identity -- also splice those two
 // fields from the real local report, same as report_event_id above.
 if(wireCase){const report=[...transport.outbox.values()].find(r=>r.outcome==='audible_started');check(transport.ack({...wireCase.ack,report_event_id:report.report_event_id,utterance_id:report.utterance_id,text_hash:report.text_hash}));check(transport.outbox.size===0);}
}
function actualRevoke(){
 let stopped=0;
 const c={criticalJournal:undefined,globalThis:null,performance:{now:()=>0},PitwallBoxAuthorityTransport:T,canonicalLifecycleCache:C.create({now:()=>0}),
  irBridge:{readyState:1,send:()=>{}},speakQueue:[],currentSpeakItem:null,
  finalizeUtterance:(q,outcome)=>{q._finalized=outcome;},
  stopCurrentAudio:()=>{stopped++;},setInterval:()=>1};c.globalThis=c;
 vm.createContext(c);
 const start=src.indexOf('const boxAuthorityTransport=');
 const end=src.indexOf('function handleStrategyPlanBoxCall(',start);
 vm.runInContext(src.slice(start,end)+'\nglobalThis.transport=boxAuthorityTransport;',c);
 const g=c.canonicalLifecycleCache.beginSocket();c.canonicalLifecycleCache.hello(g,{type:'connected',schema_version:1,bridge_process_epoch:'epoch-a'});c.transport.setEpoch('epoch-a');prepareSynthetic(c.transport,c.canonicalLifecycleCache);c.transport.setConnected(true);c.transport.receiveSnapshot(snapshot);const d=c.transport.accept(data);
 c.speakQueue=[{boxAttemptId:'a'},{kind:'unrelated'}];c.currentSpeakItem={kind:'unrelated'};
 c.transport.receiveSnapshot({...snapshot,source_frame_sequence:11,session_time_s:101,closed:true});
 check(c.speakQueue.length===1&&c.speakQueue[0].kind==='unrelated');check(stopped===0);
 const c2={...c,speakQueue:[],currentSpeakItem:{boxAttemptId:'b'}};
 c.currentSpeakItem={boxAttemptId:'b'};
 c.transport.receiveSnapshot({...snapshot,source_frame_sequence:12,session_time_s:102,allowed_attempt_id:'b',allowed_proof_id:'p2'});
 c.transport.accept({authority_proof:{...proof,proof_id:'p2',issued_source_frame:12,issued_session_time:102,fuel_inputs:{...f,source_frame_sequence:12,session_time_s:102}},box_attempt:{...attempt,attempt_id:'b',proof_id:'p2'}});
 c.transport.setConnected(false);check(stopped===1);
}
actualRevoke();
(async()=>{await rendererCase(false,false);await rendererCase(true,false);await rendererCase(true,true);await rendererCase(false,false,true);await rendererCase(false,false,false,true);await rendererCase(false,false,false,true,wire);await rendererCase(false,false,false,true,wire,true);console.log('BOX authority '+count+' checks PASS; mocked fetch, no paid API');})().catch(e=>{console.error(e);process.exitCode=1;});

// WO009 strict reference / process restart tests use unwrapped production transport.
const epochCanonical=CF.initialized(()=>clock,CF.fixture()),epochSent=[];
const epochTransport=T.create({canonical:epochCanonical,now:()=>clock,send:r=>epochSent.push(r),revoke:()=>{}});clock=0;epochTransport.setEpoch('epoch-a');epochTransport.setConnected(true);
const firstRefs=CF.refs(CF.fixture());check(epochTransport.receiveSnapshot({...snapshot,...firstRefs}));
check(epochTransport.accept({...data,...firstRefs,canonical_snapshot_id:'wrong'})===null);
for(const mutate of [p=>p.selected_plan='B',p=>p.add_fuel_l=6.9,p=>{p.set_fuel_l=8;p.validation.set_fuel_l=8;},p=>{p.target_lap=21;p.validation.target_lap=21;p.fuel_inputs.current_lap=21;p.fuel_inputs.crossings_to_finish=5;}]){
 const forged=JSON.parse(JSON.stringify(data));mutate(forged.authority_proof);check(epochTransport.accept({...forged,...firstRefs})===null);
}
const firstDelivery=epochTransport.accept({...data,...firstRefs});check(firstDelivery&&firstDelivery.precheck());firstDelivery.onSpoken();const oldReport=epochSent[0];
const generation=epochCanonical.beginSocket();epochTransport.setConnected(false);check(!firstDelivery.precheck());epochCanonical.hello(generation,{type:'connected',schema_version:1,bridge_process_epoch:'epoch-b'});epochTransport.setEpoch('epoch-b');epochTransport.setConnected(true);
check(epochSent.length===1&&epochTransport.outbox.size===1);check([...epochTransport.outbox.values()][0].bridge_process_epoch==='epoch-a');
const freshCanonical=CF.fixture({epoch:'epoch-b',frame:1});check(epochCanonical.receive(freshCanonical));const freshRefs=CF.refs(freshCanonical);
const freshBox={...snapshot,...freshRefs,source_frame_sequence:1,activation_frame:1};check(epochTransport.receiveSnapshot(freshBox));
const freshData={...data,...freshRefs,authority_proof:{...proof,activation_frame:1,issued_source_frame:1,fuel_inputs:{...f,source_frame_sequence:1}},box_attempt:{...attempt,activation_frame:1}};
const freshDelivery=epochTransport.accept(freshData);check(freshDelivery&&freshDelivery.precheck());freshDelivery.onSpoken();check(epochTransport.outbox.size===2);
check(!epochTransport.ack({...oldReport,applied:'applied'}));check(epochTransport.outbox.size===2);
check(epochTransport.ack({...epochSent.at(-1),applied:'applied'}));check(epochTransport.outbox.size===1);
check(!epochTransport.receiveSnapshot({...snapshot,...firstRefs}));check(freshDelivery.precheck());
const reorderedBox=Object.fromEntries(Object.entries(freshBox).reverse());check(!epochTransport.receiveSnapshot(reorderedBox));check(freshDelivery.precheck());
const priorFirst=freshDelivery.proof.issued_session_time;
clock=4999;const beat=CF.fixture({epoch:'epoch-b',seq:2,frame:2});beat.current_facts.source_frame.session_time_s=101;beat.source_frame.session_time_s=101;beat.race_facts.source_frame.session_time_s=101;beat.race_facts.black_flag.observed_session_time=101;beat.lifecycle.active.activated_source_frame_sequence=1;beat.box_delivery.attempts[0].activation_frame=1;check(epochCanonical.receive(beat));check(epochTransport.receiveSnapshot({...freshBox,...CF.refs(beat),source_frame_sequence:2,session_time_s:101}));check(freshDelivery.precheck());clock=5000;check(!freshDelivery.precheck());check(freshDelivery.proof.issued_session_time===priorFirst);
clock=0;

// Actual Bridge wire payload and both successful ACK forms.
require('child_process').execFileSync('python3',['-c',"import sys;sys.path.insert(0,'irsdk-bridge');from tests_wo008_fixed_target import ActualPoll;ActualPoll.setUpClass();ActualPoll('test_export_real_wire_for_desktop').test_export_real_wire_for_desktop()"],{cwd:__dirname});
const wire=JSON.parse(require('fs').readFileSync('/tmp/wo008-real-wire.json','utf8'));
const realSent=[],realCanonical=CF.initialized(()=>0,wire.canonical);const real=T.create({canonical:realCanonical,now:()=>0,send:r=>realSent.push(r),revoke:()=>{}});real.setEpoch(wire.canonical.bridge_process_epoch);real.setConnected(true);check(real.receiveSnapshot(wire.snapshot));const realD=real.accept(wire.candidate);check(realD&&realD.precheck());realD.onSpoken();const realR=realSent[0];check(real.ack({...wire.ack,report_event_id:realR.report_event_id}));check(real.outbox.size===0);realD.onAudibleInterrupted();check(real.ack({...realSent[1],applied:'retry_no_op'}));check(real.outbox.size===0);
const equal=syntheticTransport({now:()=>0,send:()=>{},revoke:()=>{}});equal.setConnected(true);check(equal.receiveSnapshot(snapshot));check(!equal.receiveSnapshot({...snapshot,race_instance_id:'new-scope'}));check(equal.accept(data)===null);
console.log('Actual Python wire / applied+retry_no_op ACK / equal frame scope collision PASS');
// Real poll black -> matching dropped -> clear -> NEW proof/attempt, through Desktop outbox.
require('child_process').execFileSync('python3',['-c',"import sys;sys.path.insert(0,'irsdk-bridge');from tests_wo008_fixed_target import ActualRevokedDropRetry;ActualRevokedDropRetry('test_black_drop_clear_issues_only_new_attempt_and_exports_wire').test_black_drop_clear_issues_only_new_attempt_and_exports_wire()"],{cwd:__dirname});
const retryWire=JSON.parse(fs.readFileSync('/tmp/wo008-retry-wire.json','utf8'));
let dropHandle;const retrySent=[];
const retryCanonical=CF.initialized(()=>0,retryWire.first.canonical);const retryTransport=T.create({canonical:retryCanonical,now:()=>0,send:r=>retrySent.push(r),revoke:()=>dropHandle?.onDelivery('dropped_before_audible')});retryTransport.setEpoch(retryWire.first.canonical.bridge_process_epoch);
retryTransport.setConnected(true);check(retryTransport.receiveSnapshot(retryWire.first.snapshot));dropHandle=retryTransport.accept(retryWire.first.candidate);check(!!dropHandle);
check(retryCanonical.receive(retryWire.revoke_canonical));check(retryTransport.receiveSnapshot(retryWire.revoke));check(!dropHandle.precheck());check(retrySent[0].outcome==='dropped_before_audible');check(retryTransport.ack(retryWire.acks[0]));
check(retryCanonical.receive(retryWire.second.canonical));check(retryTransport.receiveSnapshot(retryWire.second.snapshot));const nextHandle=retryTransport.accept(retryWire.second.candidate);check(nextHandle&&nextHandle.precheck());check(!dropHandle.precheck());
nextHandle.onSpoken();check(retryTransport.ack(retryWire.acks[1]));check(retryTransport.outbox.size===0);
console.log('Actual black/drop/clear retry wire: new proof + new attempt, old never revived PASS');
