/* Test-only actual Renderer Driver request and canonical readback through a temp journal. */
'use strict';
const fs=require('fs'),vm=require('vm'),os=require('os'),path=require('path'),root=path.resolve(__dirname,'..');
const Router=require(process.env.WO012_ROUTER_PATH||root+'/desktop/local-intent-router'),Cache=require(root+'/desktop/canonical-lifecycle-cache'),Projection=require(root+'/desktop/strategy-state-projection');
const Store=require(root+'/desktop/critical-journal-store'),Client=require(root+'/desktop/critical-journal-client');
const src=fs.readFileSync(process.env.WO012_RENDERER_PATH||root+'/desktop/renderer.html','utf8'),input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const initial=input.initial||input,mode=input.mode||'command',text=input.text||'やっぱり10周';
const dir=input.journal_dir||fs.mkdtempSync(path.join(os.tmpdir(),'wo011-driver-')),store=Store.create(path.join(dir,'journal.json'));store.load();
const journal=Client.create({criticalJournalLoad:store.load,criticalJournalTransact:store.transact});
function extract(n){const m=src.match(new RegExp('(?:async )?function '+n+'\\([^]*?\\n\\}'));if(!m)throw Error(n);return m[0];}
const sent=[],spoken=[],display=[],trace=[],node={value:text,style:{},classList:{add(){},remove(){}}};let clock=0,uuid=0;
class MockDate extends Date{static now(){return 1700000000000+clock;}}
const cache=Cache.create({now:()=>clock}),g=cache.beginSocket();cache.hello(g,{type:'connected',schema_version:1,bridge_process_epoch:initial.bridge_process_epoch});if(!cache.receive(initial.canonical_lifecycle||initial,g))throw Error('invalid_initial');
const projection=Projection.create({canonical:cache,now:()=>clock});
const ctx={console,Date:MockDate,Math,Map,Set,performance:{now:()=>clock},crypto:{randomUUID:()=> 'wo011-request-'+(++uuid)},criticalJournal:journal,canonicalLifecycleCache:cache,strategyProjection:projection,
 lastTelemetry:initial,lastSessionNum:initial.session_num,lastTelemetryAt:Date.now(),irBridge:{readyState:1,send:x=>{const wire=JSON.parse(x);if(wire.cmd==='driver_plan_command'&&!journal.entries('driver_plan_command').some(e=>e.payload.command_id===wire.command_id))throw Error('send_before_persist');sent.push(wire);}},driverPlanCommandOutbox:new Map(),pendingDriverPlanFollowup:null,pendingCanonicalCommandReadbacks:new Map(),bridgeStrategyDecisions:new Map(),strategyResponseOutbox:new Map(),strategyDeliveryOutbox:new Map(),strategyPlaybookDecisionKeys:new Set(),
 document:{getElementById:()=>node},isBusy:false,sel:'LunaJP',selMode:'race',iracingLive:true,lastTrack:'Road Atlanta',lastCarClass:'GT3',lastCarModel:'Mercedes',
 addMsg:(who,text)=>{display.push(text);return null;},pushMsg(){},speak:text=>spoken.push(text),diagnosticLog:(event,data)=>trace.push({event,data}),isJapaneseEngineer:()=>true,nextUtteranceId:()=> 'wo011-utterance',
 captureConfirmedFuelCapacity(){},maybeQuietMode(){},prepareMemoryBrain(){},pendingConfirmationKinds:()=>[],bareConfirmationAnswer:()=>null,handleLunaSelfMemoryInput:()=>input.shadow?'memory shadow':null,handleTeamPlanUtterance:()=>{if(input.shadow){trace.push({event:'team_shadow'});return true;}return false;},handleRelativePaceQuestion:()=>!!input.shadow,isSessionEndingLifecycle:()=>false,turns:0,sessionMsgCount:0,usageCount(){},
 loadRaceHistory:()=>[],currentMemoryUserId:()=> 'test',currentMemoryIdentity:()=>({}),currentGapHeld:()=>null,SPEAK_PRIO:{P2_PROCEDURE:2,P3_INFO:3,P4_INFO:4},pendingDecisionDispute:null,fuelWindowWatch:{armed:false,sessionKey:'',announced:false},answerHistoricalWeatherLocally:()=>null,evidenceDebrief:null,pendingConversationMemoryCorrection:null,callAPI:async()=>{const reply=input.saved_reply||'その相談の対象と条件を確認する。';ctx.addMsg('ai',reply);ctx.speak(reply);},ensureMemoryIntro:()=>null,isManualReviewCommand:()=>false,isExplicitMemoryRequest:()=>false,memorySaveReceipt:""};
if(input.dispute){const B=require(root+'/desktop/conversation-memory-box');ctx.PitwallConversationMemoryBox=B;ctx.PitwallDisputeDetector=require(root+'/desktop/dispute-detector');const box=B.emptyBox('test');B.addTurn(box,{who:'luna',text:'後ろとの差は3秒。',at:MockDate.now()});ctx.ensureConversationBox=()=>box;ctx.saveConversationBox=()=>{};}
ctx.window=ctx;ctx.globalThis=ctx;ctx.PitwallLocalIntentRouter=Router;ctx.PitwallStrategyPlaybook={};vm.createContext(ctx);
for(const n of ['currentCanonicalStrategyLive','ensureStrategyState','currentStrategyStateAPI','currentStrategyPlaybook','currentDriverPlanAuthority','newDriverPlanCommandId','flushDriverPlanCommandOutbox','queueDriverPlanCommand','sendDriverPlanReason','sendMsg','handleDriverPlanCommandAck','confirmCanonicalCommandReadbacks','maybeDeliverFuelWindowWatch'])vm.runInContext(extract(n),ctx);
for(const entry of journal.entries('driver_plan_command'))ctx.driverPlanCommandOutbox.set(entry.key,{envelope:entry.payload,attempts:0,nextSendAt:0});
(async()=>{
 if(mode==='probe'){
  const before=projection.state();
  for(const phrase of input.turns||[text]){if(typeof phrase==='object'){clock=phrase.at||clock;if(phrase.snapshot)cache.receive(phrase.snapshot);node.value=phrase.text;}else node.value=phrase;await ctx.sendMsg(input.source||'typed');}
  for(const step of input.monitor_steps||[]){clock=step.at; if(step.snapshot)cache.receive(step.snapshot);ctx.maybeDeliverFuelWindowWatch(initial);}

  process.stdout.write(JSON.stringify({sent,spoken,display,trace,journal_dir:dir,before,current:projection.state(),journal:journal.entries('driver_plan_command'),watch:ctx.fuelWindowWatch}));
 }else if(mode==='command'){
  const before=projection.state().pit_plan;await ctx.sendMsg('typed');
  if(sent.length!==1||sent[0].cmd!=='driver_plan_command')throw Error('actual_driver_request_missing');
  if(projection.state().pit_plan.lap!==before.lap||spoken.some(t=>/変更した|取り消した|合意した/.test(t)))throw Error('early_local_application');
  process.stdout.write(JSON.stringify({command:sent[0],journal_dir:dir,before_target:before.lap,early_success_speech:spoken.length,persisted:journal.entries('driver_plan_command').length}));
 }else{
  const command=input.command,ack=input.events.find(e=>e.type==='driver_plan_command_ack'&&e.command_id===command.command_id);
  if(!ack)throw Error('actual_ack_missing');
  ctx.handleDriverPlanCommandAck(ack);const beforeCanonical=spoken.length;
  if(ack.outcome==='applied'&&beforeCanonical!==0)throw Error('ack_alone_confirmed');
  for(const e of input.events){if(e.type==='canonical_lifecycle_snapshot'&&e.bridge_process_epoch===initial.bridge_process_epoch&&e.snapshot_sequence>(initial.canonical_lifecycle||initial).snapshot_sequence){cache.receive(e);ctx.confirmCanonicalCommandReadbacks();}else if(e.type==='driver_plan_command_ack'&&e.command_id===command.command_id)ctx.handleDriverPlanCommandAck(e);}
  const state=projection.state();process.stdout.write(JSON.stringify({before_canonical_speech:beforeCanonical,spoken,display,current_plan:state.pit_plan,terminals:state.terminals,receipts:journal.data?.receipts?.length??store.load().data.receipts.length,outbox:journal.entries('driver_plan_command').length,source_ref:projection.trace()}));
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
