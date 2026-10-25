'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const CF=require('./tests-canonical-lifecycle'),P=require('./desktop/strategy-state-projection');
const html=fs.readFileSync('desktop/renderer.html','utf8');
function grab(text,name){const start=text.indexOf('\nfunction '+name+'(');assert(start>=0,name);const end=text.indexOf('\n}\n',start);assert(end>=0,name);return text.slice(start+1,end+2);}
function frame(input){const s=CF.fixture(input);s.continuity.stable_scope={race_instance_id:s.race_instance_id,session_num:s.session_num,driver_id:10101};s.continuity.durable_commit=true;return s;}
let now=0,seq=1;
const cache=CF.initialized(()=>now,frame({seq,frame:seq}));
const projection=P.create({canonical:cache,now:()=>now});
function publish(extra={}){seq++;const s=frame({seq,frame:seq,...extra});assert(cache.receive(s));return s;}
projection.state();
const conversation=projection.binding('conversation_scope'),critical=projection.binding('critical_context'),facts=projection.binding('facts');
assert.equal(conversation.deadline_ms,30000);
now=6000;publish();assert(projection.validBinding(conversation));assert(!projection.validBinding(critical));assert(!projection.validBinding(facts));
now=11001;assert(!projection.validBinding(conversation),'cache gap must still revoke conversation');publish();assert(projection.validBinding(conversation));
now=30000;publish();assert(!projection.validBinding(conversation),'speech/queue lifetime is fixed, not renewed');
function classifier(input,domain=null){
 const critical=projection.binding('critical_context'),scope=projection.binding('conversation_scope');
 const context={strategyProjection:projection,_replyInputText:input,_replyDomainBinding:domain,_replyCriticalBinding:critical,_replyScopeBinding:scope,
   _replyFactsBindingAtRequest:projection.binding('facts'),_referenceJudgeBuffering:false,_judgePendingAtRequest:null,_replyMemoryRefAtRequest:null};
 vm.createContext(context);
 const start=html.indexOf('  const _isConcretelyNonCurrentText='),end=html.indexOf('  const telemetry =',start);
 vm.runInContext(['currentPlanReplyDependsOn','_hasUnqualifiedCurrentNumericMention','strategyNumericFactBinding'].map(n=>grab(html,n)).join('\n')+html.slice(start,end)+'\nglobalThis.bind=_replyBindingFor;',context);
 return context.bind;
}
const classify=classifier('少し説明を聞かせて。');
for(const text of ['あなたの質問、整理させて。','今の質問に正しく答えられていない。','昨日のレース、2026-10-23のデータね。','前回は3周目に24L給油した。','Last race we pitted on lap 3.']){
 assert.equal(classify(text).kind,'conversation_scope',text);
}
for(const text of ['現在の燃料は5L。','20周目。','前回は3周目に止まった。現在の燃料は5L。','Yesterday we pitted on lap 3. Position is third.']){
 assert.notEqual(classify(text).kind,'conversation_scope',text);
}
const fuelClassifier=classifier('燃料は足りる？',projection.binding('facts'));
assert.notEqual(fuelClassifier('足りる。').kind,'conversation_scope','implicit answer to fuel question keeps its source');
const scope=projection.binding('conversation_scope');publish({race:'another'});assert(!projection.validBinding(scope));
const resetScope=projection.binding('conversation_scope');cache.beginSocket();assert(!projection.validBinding(resetScope));
const formatCtx={};vm.createContext(formatCtx);vm.runInContext(grab(html,'oishiRadio')+';globalThis.format=oishiRadio;',formatCtx);
for(const trigger of ['initial_strategy_plans','strategy_plan_decision']){
 const reply=formatCtx.format({trigger,selected_plan:'A',strategy_options:{plan_a:{available:true,target_lap:17,target_in_laps:8,set_fuel_l:14},plan_b:{fuel_window_open:false}}});
 assert(reply.includes('17周目にピット')&&reply.includes('14リットル')&&reply.includes('基準案'),reply);
 const unknown=formatCtx.format({trigger,strategy_options:{plan_a:{available:true,target_lap:null,set_fuel_l:14}}});assert(unknown.includes('未確定'),unknown);
}
console.log('speech conversation scope: bounded lifetime, fresh cache, sentence dependencies, scope/socket revocation and explicit baseline target PASS');

let memoryRecords=[{raceRecordId:'saved',totalLaps:3}];
const memoryCtx={loadRaceHistory:()=>memoryRecords,window:{PitwallSessionMemory:require('./desktop/session-memory')}};vm.createContext(memoryCtx);vm.runInContext(grab(html,'raceMemorySpeechValid')+';globalThis.valid=raceMemorySpeechValid;',memoryCtx);
const ref={id:'saved',fingerprint:JSON.stringify(memoryCtx.window.PitwallSessionMemory.compactRaceRecord(memoryRecords[0]))};
assert(memoryCtx.valid(ref));memoryRecords[0].totalLaps=4;assert(!memoryCtx.valid(ref));
assert(memoryCtx.valid({id:'saved'}));memoryRecords[0].disputed=true;assert(!memoryCtx.valid({id:'saved'}));memoryRecords=[];assert(!memoryCtx.valid(ref));
console.log('saved race speech rejects deleted/disputed/changed source PASS');

const tagStart=html.indexOf('const _lapReadoutLapTag ='),tagEnd=html.indexOf(';',tagStart);
for(const telemetry of [null,{}, {lap:null},{lap:'4'},{lap:NaN},{lap:Infinity}]){const ctx={lastTelemetry:telemetry};vm.createContext(ctx);assert.equal(vm.runInContext(html.slice(tagStart,tagEnd+1)+'_lapReadoutLapTag',ctx),'');}
assert.equal(vm.runInNewContext(html.slice(tagStart,tagEnd+1)+'_lapReadoutLapTag',{lastTelemetry:{lap:4}}),' lap=4');
console.log('first radio without telemetry/null lap does not throw or fabricate lap zero PASS');
{
 let tick=0,serial=0;
 const snapshot=(mutate=()=>{})=>{const s=frame({seq:++serial,frame:serial});s.lifecycle.active.activated_source_frame_sequence=1;s.box_delivery.attempts[0].activation_frame=1;s.recommendations.strategy_options={value:{selected_plan:'A',plan_a:{available:true,target_lap:17,set_fuel_l:14},plan_b:{fuel_window_open:false},plan_b_evidence:{conditions_met:{rejoin_clear:true}},decision_evidence:{conditions_met:{rejoin_clear:true},conditions_failed:[]}}};mutate(s);return s;};
 const canonical=CF.initialized(()=>tick,snapshot()),p=P.create({canonical,now:()=>tick});
 const explain=p.binding('plan_explanation'),active=p.binding('active');assert.equal(explain.decision_id,'d');assert.equal(explain.record_ref.decision_id,'d');assert.equal(explain.scope.driver_id,10101);tick=8000;assert(canonical.receive(snapshot(s=>{s.current_facts.fuel_level_l=4.9;})));
 assert(p.validBinding(explain),'unchanged native plan explanation survives clock and normal burn');assert(!p.validBinding(active),'active authority retains original 5s deadline');
 for(const mutate of [s=>s.lifecycle.active.revision++,s=>{s.lifecycle.active.target_lap++;s.execution.allowed=false;},s=>s.lifecycle.active.set_fuel_l++,s=>s.execution.allowed=false,s=>s.recommendations.strategy_options.value.decision_evidence.conditions_met.rejoin_clear=false,s=>s.recommendations.strategy_options.value.plan_b_evidence.conditions_met.rejoin_clear=false,s=>s.lifecycle.active=null]){
  const before=p.binding('plan_explanation');const changed=snapshot(mutate);
  if(changed.lifecycle.active){changed.lifecycle.active.record_ref.revision=changed.lifecycle.active.revision;changed.box_delivery.attempts[0].plan_revision=changed.lifecycle.active.revision;}
  else {changed.lifecycle.active_plan_id=null;changed.execution.allowed=false;changed.box_delivery={allowed_proof_id:null,allowed_attempt_id:null,valid_until_session_s:105,attempts:[]};}
  if(!changed.execution.allowed)changed.box_delivery={allowed_proof_id:null,allowed_attempt_id:null,valid_until_session_s:105,attempts:[]};
  assert(canonical.receive(changed),JSON.stringify(changed));assert(!p.validBinding(before),'changed plan/phase/condition must revoke explanation');assert(canonical.receive(snapshot()));
 }
 tick=30000;assert(canonical.receive(snapshot()));assert(!p.validBinding(explain));
 console.log('plan explanation bound 30s, native/condition invalidation; active 5s unchanged PASS');
}
{
 let time=0,owner='one';const c=CF.initialized(()=>time,frame()),p=P.create({canonical:c,now:()=>time,conversationOwner:()=>owner});
 const live=p.binding('conversation_scope'),s=frame({seq:2,frame:11,allowed:false,proof:null,attempt:null});s.execution.scope_closed=true;assert(c.receive(s));assert(!p.validBinding(live));
 const debrief={...p.binding('scope_continuity'),deadline_ms:30000};assert(p.validBinding(debrief),'new closed-scope conversation may speak');
 owner='two';assert(!p.validBinding(debrief),'closed scope must not cross owners');owner='one';time=30000;assert(!p.validBinding(debrief),'unknown/closed conversation is bounded');
 const unknown=P.create({canonical:{current:()=>null,connectionGeneration:()=>1},conversationOwner:()=>owner,now:()=>time});
 const offline={...unknown.binding('scope_continuity'),deadline_ms:time+30000};assert(unknown.validBinding(offline));assert(!unknown.validBinding(unknown.binding('facts')));owner='two';assert(!unknown.validBinding(offline));
 console.log('new debrief/offline conversation works; old live/owner/30s/current facts remain fenced PASS');
}
{
 const memory=require('./desktop/session-memory');let reviews=[{review_id:'review-one',owner_ref:'driver-one',race_instance_id:'old-race',qa:[{answer:'late entry'}],conversation:[]}];
 const race={raceRecordId:'saved-race',totalLaps:22};const context={loadRaceHistory:()=>[race],loadEvidenceRecords:()=>reviews,window:{PitwallSessionMemory:memory}};vm.createContext(context);vm.runInContext(grab(html,'raceMemorySpeechValid')+';globalThis.valid=raceMemorySpeechValid;',context);
 const ref={id:race.raceRecordId,fingerprint:JSON.stringify(memory.compactRaceRecord(race)),review:{id:reviews[0].review_id,owner:reviews[0].owner_ref,fingerprint:memory.debriefFingerprint(reviews[0])}};
 assert(context.valid(ref));reviews[0].qa[0].answer='planned entry';assert(!context.valid(ref),'review correction revokes speech while race row survives');reviews=[];assert(!context.valid(ref),'review deletion revokes speech while race row survives');
 const missing={...ref,review:{missing:true,raceInstanceId:'old-race',owner:'driver-one'}};assert(context.valid(missing));reviews=[{review_id:'new',owner_ref:'driver-one',race_instance_id:'old-race',qa:[]}];assert(!context.valid(missing),'new review revokes a queued missing-review explanation');
 reviews=[{review_id:'review-one',owner_ref:'driver-one',race_instance_id:'old-race',qa:[{answer:'late entry'}],conversation:[]}];
 const queued={memoryRecordRef:ref},unrelated={text:'unrelated'},current={strategyBinding:{memory_record_ref:ref}},outcomes=[];
 Object.assign(context,{speakQueue:[queued,unrelated],currentSpeakItem:current,finalizeUtterance:(item,state,_x,reason)=>outcomes.push({item,state,reason}),stopCurrentAudio:reason=>outcomes.push({reason,stopped:true})});
 vm.runInContext(grab(html,'enforceMemorySpeechReferences')+';globalThis.enforce=enforceMemorySpeechReferences;',context);reviews=[];context.enforce();assert.deepEqual(context.speakQueue,[unrelated]);assert(outcomes.some(x=>x.item===queued&&x.reason==='memory_source_invalidated'));assert(outcomes.some(x=>x.stopped),'debrief deletion interrupts only speech referring to that review, even offline');
 const declaration=html.match(/const _replyMemoryRefAtRequest=.*?;/)[0];const brain={memoryRef:ref};const copied=vm.runInNewContext(declaration+'_replyMemoryRefAtRequest',{activeMemoryBrainTurn:brain,JSON});brain.memoryRef.review.fingerprint='new';assert.notEqual(copied.review.fingerprint,brain.memoryRef.review.fingerprint,'inflight source is fixed before request');
 console.log('review-only delete/correct/missing-to-present fence and immediate queue/current invalidation PASS');
}
(async()=>{
 const runtime=fs.readFileSync('irsdk-bridge/wo019_desktop_runtime.js','utf8');const start=runtime.indexOf('async function sandboxFetch('),end=runtime.indexOf('\n}',start);
 assert(start>=0&&end>=0);const source=runtime.slice(start,end+2);
 for(const [stream,status] of [[false,401],[true,401],[false,200],[true,200]]){
  const ctx={apiBase:'http://127.0.0.1:1234',apiRequests:[],now:123,inflight:0,heldInflight:0,holdNextChat:false,blockedFetches:[],Headers,Response,TransformStream,ReadableStream,JSON,String,fetch:async()=>new Response('{"test":"preserved"}',{status})};vm.createContext(ctx);vm.runInContext(source+';globalThis.fetchProduct=sandboxFetch;',ctx);
  const response=await ctx.fetchProduct(ctx.apiBase+'/api/chat',{method:'POST',body:JSON.stringify({stream})});assert.equal(response.status,status);
  if(!stream||status!==200)assert.equal(ctx.inflight,0,'header-only error consumer must not deadlock settle');else assert.equal(ctx.inflight,1,'actual streaming HTTP remains in flight until consumed');
  assert.equal(await response.text(),'{"test":"preserved"}');assert.equal(ctx.inflight,0);
 }
 const canceled={apiBase:'http://127.0.0.1:1234',apiRequests:[],now:123,inflight:0,heldInflight:0,holdNextChat:false,blockedFetches:[],Headers,Response,ReadableStream,JSON,String,fetch:async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('pending'));}}))};
 vm.createContext(canceled);vm.runInContext(source+';globalThis.fetchProduct=sandboxFetch;',canceled);
 const pending=await canceled.fetchProduct(canceled.apiBase+'/api/chat',{method:'POST',body:JSON.stringify({stream:true})});
 assert.equal(canceled.inflight,1);await pending.body.cancel('stale reply');assert.equal(canceled.inflight,0,'reader cancellation is terminal even without an upstream flush');
 console.log('real runtime fetch accounting preserves HTTP error/nonstream body, streaming lifetime and cancel PASS');
})().catch(error=>{console.error(error);process.exitCode=1;});
