'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const Router=require('./desktop/local-intent-router');
const matrix=[['今周ピット入らない','negated'],['この周ピット入っていい','consultation'],['前回はピット入るって言った','historical'],['ピット入るぞではない','negated'],['黒旗だからこの周ピット','penalty'],['この周ピット行かん','negated'],['プランは14周で合ってる','consultation'],['先週のピットは14周だった','historical'],['if traffic slows I will pit now','conditional'],['ウィンドウ開いてる','window_status'],['ウィンドウ開いたら教えて','window_watch'],['ウィンドウ開いても教えないで','window_cancel'],['先に入る','command'],['box this lap','command'],['ピット14周と18周に変更','ambiguous']];
for(const [text,kind] of matrix)assert.equal(Router.classifyDriverIntent(text).kind,kind,text);
const original=fs.readFileSync('tests-wo011-desktop-projection.js','utf8');
const harness=original.split('(async()=>{')[0]+original.slice(original.indexOf('function audioVM(s)'));
const sandbox={require,__dirname,console,process,Buffer,AbortController,setImmediate,TextDecoder,TextEncoder};vm.createContext(sandbox);vm.runInContext(harness+'\nglobalThis.testHarness={make,base,copy,extract,pitSnapshots,fullCallAPITests};',sandbox);
const {make,base,copy,extract,pitSnapshots}=sandbox.testHarness;
(async()=>{
 const r=make();r.connect();let seq=base.snapshot_sequence;
 const frame=open=>{const s=copy(base);s.snapshot_sequence=++seq;s.snapshot_id=s.bridge_process_epoch+':'+seq;s.recommendations.strategy_options={role:'recommendation_not_execution',calculation_source:{source_frame_sequence:s.source_frame.sequence,session_time_s:s.source_frame.session_time_s},value:{available:true,plan_b:{available:open,fuel_window_open:open}}};return s;};
 r.receive(frame(false));r.ctx.Date={now:()=>1700000000000+r.now};r.now=0;r.ctx.fuelWindowWatch={armed:false};r.ctx.isSessionEndingLifecycle=()=>false;vm.runInContext(extract('maybeDeliverFuelWindowWatch'),r.ctx);
 await r.ask('ウィンドウ開いたら教えて');assert(r.ctx.fuelWindowWatch.armed);
 r.now=30000;r.clock(30000);r.receive(frame(false));r.ctx.maybeDeliverFuelWindowWatch(r.ctx.lastTelemetry);assert(r.ctx.fuelWindowWatch.armed);assert(!r.ctx.fuelWindowWatch.announced);
 r.now=180000;r.clock(180000);r.receive(frame(true));r.ctx.maybeDeliverFuelWindowWatch(r.ctx.lastTelemetry);assert(r.ctx.fuelWindowWatch.announced);const calls=r.speech.filter(x=>x.o.kind==='fuel_window_watch');assert.equal(calls.length,1);assert(r.projection.validBinding(calls[0].o.strategyBinding));r.ctx.maybeDeliverFuelWindowWatch(r.ctx.lastTelemetry);assert.equal(r.speech.filter(x=>x.o.kind==='fuel_window_watch').length,1);
 await r.ask('ウィンドウ開いたら教えて');await r.ask('ウィンドウ開いても教えないで');r.ctx.maybeDeliverFuelWindowWatch(r.ctx.lastTelemetry);assert(!r.ctx.fuelWindowWatch.armed);assert(r.ctx.fuelWindowWatch.cancelled);
 await r.ask('ウィンドウ開いたら教えて');r.now=200000;r.clock(200000);r.ctx.maybeDeliverFuelWindowWatch(r.ctx.lastTelemetry);assert(!r.ctx.fuelWindowWatch.armed);
 const pending=make();pending.connect();const waiting=copy(base),awaiting=waiting.lifecycle.active;awaiting.phase='awaiting_driver';waiting.lifecycle.awaiting=[awaiting];waiting.lifecycle.active=null;waiting.lifecycle.active_plan_id=null;waiting.execution.allowed=false;waiting.box_delivery.allowed_attempt_id=null;waiting.box_delivery.allowed_proof_id=null;waiting.box_delivery.valid_until_session_s=null;pending.receive(waiting);assert(pending.projection.api.proposePlan(null,{decision_id:awaiting.decision_id,lap:awaiting.target_lap,plan_id:awaiting.selected_plan,audible:true}));
 await pending.ask('ウィンドウのコールを取り消して');assert(pending.projection.state().pending_proposal);await pending.ask('はい');assert(pending.sent.some(x=>x.cmd==='strategy_decision_response'&&x.decision_id===awaiting.decision_id));
 for(const state of ['true','false','unknown']){const pen=make();pen.connect();const s=copy(base);s.race_facts.black_flag.state=state;s.race_facts.black_flag.available=state!=='unknown';s.race_facts.black_flag.raw_value=state==='unknown'?null:state==='true'?65536:0;s.race_facts.session_flags.raw_value=s.race_facts.black_flag.raw_value;s.race_facts.session_flags.available=state!=='unknown';s.race_facts.black_flag.freshness=state==='unknown'?'unavailable':'fresh';s.execution.allowed=false;s.box_delivery.allowed_attempt_id=null;s.box_delivery.allowed_proof_id=null;s.box_delivery.valid_until_session_s=null;pen.receive(s);const reply=await pen.ask('黒旗だからこの周ピット');assert(reply.includes(state==='true'?'ON':state==='false'?'OFF':'確認できない'));assert(!pen.sent.some(x=>x.cmd==='driver_plan_command'));assert(!reply.includes('消化済み。'));}
 const official=make();official.connect(pitSnapshots.penalty.bridge_process_epoch);official.receive(pitSnapshots.penalty);assert((await official.ask('ペナルティでピット入るぞ')).includes('ペナルティのピット退出'));
 const rearm=make();rearm.connect();rearm.receive(frame(false));rearm.ctx.fuelWindowWatch={armed:false};rearm.ctx.isSessionEndingLifecycle=()=>false;vm.runInContext(extract('maybeDeliverFuelWindowWatch'),rearm.ctx);await rearm.ask('ウィンドウ開いたら教えて');await rearm.ask('ウィンドウ教えないで');await rearm.ask('ウィンドウ開いたら教えて');rearm.receive(frame(true));rearm.ctx.maybeDeliverFuelWindowWatch(rearm.ctx.lastTelemetry);assert.equal(rearm.speech.filter(x=>x.o.kind==='fuel_window_watch').length,1);

 // WO012 final-audit REVISE, permanent pin (previously only reproduced via /tmp-only
 // scripts): P1-B — arming the fuel-window watch before the driver's own canonical
 // scope is verifiable must not arm at all, so a later *different* driver's fresh
 // canonical can never fire this driver's watch.
 {
  const nullWatch=make();nullWatch.connect();nullWatch.ctx.fuelWindowWatch={armed:false};nullWatch.ctx.isSessionEndingLifecycle=()=>false;
  vm.runInContext(extract('maybeDeliverFuelWindowWatch'),nullWatch.ctx);
  await nullWatch.ask('ウィンドウ開いたら教えて');
  assert.equal(nullWatch.ctx.fuelWindowWatch.armed,false,'arming with no verified canonical scope must not arm');
  assert.equal(nullWatch.ctx.fuelWindowWatch.scopeBinding,null);
  const otherDriver=copy(base);otherDriver.continuity.stable_scope.driver_id++;
  otherDriver.recommendations.strategy_options={role:'recommendation_not_execution',
   calculation_source:{source_frame_sequence:otherDriver.source_frame.sequence,session_time_s:otherDriver.source_frame.session_time_s},
   value:{available:true,plan_b:{available:true,fuel_window_open:true}}};
  nullWatch.receive(otherDriver);
  nullWatch.ctx.maybeDeliverFuelWindowWatch(nullWatch.ctx.lastTelemetry);
  assert.equal(nullWatch.speech.filter(x=>x.o.kind==='fuel_window_watch').length,0,
   'a watch that never armed for a verified scope must not notify for a later different driver');
 }

 // P1-A — an explicit new declaration must not be silently absorbed into a stale
 // reason-only candidate that belongs to a different driver or bridge epoch. The
 // pre-classification candidate must be invalidated exactly like "no candidate
 // exists", so the declaration is classified as a fresh command attempt with a
 // non-empty reply, never zero output and never a wired reason event for the past
 // driver/epoch.
 for(const change of ['driver','epoch']){
  const scoped=make();scoped.connect();scoped.receive(base);
  const originalScope=JSON.stringify(scoped.cache.current().continuity.stable_scope);
  const changed=copy(base);changed.snapshot_sequence++;changed.snapshot_id=changed.bridge_process_epoch+':'+changed.snapshot_sequence;
  if(change==='driver')changed.continuity.stable_scope.driver_id++;
  else{changed.bridge_process_epoch+=':new';changed.snapshot_id=changed.bridge_process_epoch+':'+changed.snapshot_sequence;scoped.connect(changed.bridge_process_epoch);}
  scoped.receive(changed);
  scoped.ctx.pendingDriverPlanFollowup={commandId:'oldcommand',operation:'early_pit',scopeIdentity:originalScope,
   raceInstanceId:base.race_instance_id,sessionNum:base.session_num,bridgeProcessEpoch:base.bridge_process_epoch,expiresAt:Date.now()+15000};
  vm.runInContext(extract('sendDriverPlanReason'),scoped.ctx);
  let commandAttempts=0;scoped.ctx.queueDriverPlanCommand=()=>{commandAttempts++;return null;};
  const before=scoped.messages.length;
  await scoped.ask('前の25が遅いから先に入る');
  assert.equal(scoped.sent.filter(x=>x.cmd==='driver_plan_reason').length,0,
   'a stale '+change+' candidate must not wire a reason event for the earlier driver/epoch');
  assert(commandAttempts>=1,
   'an explicit declaration with a stale '+change+' candidate must be classified as a fresh command attempt, not absorbed as reason-only');
  assert(scoped.messages.slice(before).some(x=>x.who==='ai'&&x.text),
   'a stale '+change+' candidate must never produce zero output for an explicit declaration');
  // queueDriverPlanCommand is mocked above to isolate the classification boundary
  // (same grain as /tmp/wo012-scope-independent-repro.js); the real function's own
  // first statement clears pendingDriverPlanFollowup, so that is not re-asserted here.
 }

 // P1-A (reopened) — a valid, same-scope/same-epoch reason-only follow-up whose
 // *send* genuinely fails (journal write rejected, or socket already closed) must
 // not return with zero output either. It must say the reason link could not be
 // confirmed, without requeuing a new command and without fabricating success.
 for(const failure of ['journal_put_false','socket_closed']){
  const sendFail=make();sendFail.connect();sendFail.receive(base);
  sendFail.ctx.criticalJournal.put=()=>failure!=='journal_put_false';
  vm.runInContext(extract('newDriverPlanCommandId'),sendFail.ctx);
  vm.runInContext(extract('sendDriverPlanReason'),sendFail.ctx);
  if(failure==='socket_closed')sendFail.ctx.irBridge.readyState=3;
  sendFail.ctx.pendingDriverPlanFollowup={commandId:'original-early',operation:'early_pit',
   scopeIdentity:JSON.stringify(sendFail.cache.current().continuity.stable_scope),
   raceInstanceId:base.race_instance_id,sessionNum:base.session_num,bridgeProcessEpoch:base.bridge_process_epoch,
   canonicalSnapshotId:base.snapshot_id,canonicalSnapshotSequence:base.snapshot_sequence,
   decisionId:base.lifecycle.active.decision_id,revision:base.lifecycle.active.revision,expiresAt:Date.now()+15000};
  const begin=sendFail.messages.length;
  await sendFail.ask('前が遅いから');
  const aiReplies=sendFail.messages.slice(begin).filter(x=>x.who==='ai');
  assert(aiReplies.length>0&&aiReplies[0].text,
   'a reason-only candidate must not return with zero output when the send genuinely fails ('+failure+')');
  assert.equal(sendFail.sent.filter(x=>x.cmd==='driver_plan_reason').length,0,
   'a failed send must not fabricate a wired reason event ('+failure+')');
  assert.equal(sendFail.ctx.driverPlanCommandOutbox.size,0,
   'a failed reason send must not create a new command outbox entry ('+failure+')');
  assert.equal(sendFail.ctx.pendingDriverPlanFollowup,null,
   'the one-final-turn candidate consumption-before-transport-check contract must be unchanged');
 }

 let streamTest=sandbox.testHarness.fullCallAPITests.toString();
 // WO014 REVISE: the regex used to require "const cases=[...];\n for(const
 // scenario" with NO intervening lines, so round6's explanatory comment
 // block between the cases array and the for-loop (tests-wo011-desktop-
 // projection.js) made this .replace() a silent no-op -- the override cases
 // below never actually replaced the real ones, so this harness exercised
 // the WRONG scenarios while still reporting PASS. Tolerate any content
 // (including comments) between the ';' and 'for(const scenario' -- that
 // anchor text is unique in the source file, so this stays precise -- and
 // assert the substitution actually fired so future source-format drift
 // fails loudly instead of silently reverting to the real cases array.
 const beforeCasesReplace=streamTest;
 streamTest=streamTest.replace(/const cases=\[[^]*?;[^]*?for\(const scenario/,`const cases=[{text:'この周ピット入っていい',related:true,fresh:true},{text:'今周ピット入らない',related:true,fresh:true},{text:'前回はピット入るって言った',related:false,fresh:true}];\n for(const scenario`);
 assert.notEqual(streamTest,beforeCasesReplace,'fullCallAPITests cases/for-loop replace target not found (regex drift guard)');
 const beforePendingReplace=streamTest;
 streamTest=streamTest.replace("const pending=c.callAPI('typed');","Object.assign(c,{isManualReviewCommand:()=>false,isExplicitMemoryRequest:()=>false,memorySaveReceipt:'',evidenceDebrief:null,answerHistoricalWeatherLocally:()=>null});const pending=r.ask(scenario.text);");
 assert.notEqual(streamTest,beforePendingReplace,"fullCallAPITests callAPI('typed') replace target not found (regex drift guard)");
 vm.runInContext('globalThis.streamTest='+streamTest,sandbox);await sandbox.streamTest();
 console.log('WO012 semantic matrix + actual sendMsg/monitor future fresh/cancel/TTL PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
