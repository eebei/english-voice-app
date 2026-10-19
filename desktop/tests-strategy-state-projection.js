#!/usr/bin/env node
'use strict';
const assert=require('assert'),P=require('./strategy-state-projection'),C=require('./canonical-lifecycle-cache');
const {fixture}=require('../tests-canonical-lifecycle');
const copy=x=>JSON.parse(JSON.stringify(x));
let count=0;function check(x){assert(x);count++;}
function frame(input={}){const s=fixture(input);s.continuity.stable_scope={race_instance_id:s.race_instance_id,session_num:s.session_num,driver_id:10101};s.continuity.durable_commit=true;return s;}
let clock=0;const c=C.create({now:()=>clock}),g=c.beginSocket();c.hello(g,{type:'connected',schema_version:1,bridge_process_epoch:'epoch-a'});check(c.receive(frame()));
const p=P.create({canonical:c,now:()=>clock}),st=p.state(),original=JSON.stringify(c.current());
check(st.readonly_projection);check(Object.isFrozen(st));check(Object.isFrozen(st.active));check(p.api.pitPlan(st).lap===20);
check(p.api.agreePitPlan(st,{lap:99}).applied===false);check(p.api.amendPitPlan(st,{lap:99}).requested===true);check(p.api.cancelPitPlan(st,{}).applied===false);check(p.api.recordPitExecuted(st,{lap:10})===null);check(p.api.pitExecuted(st)===null);check(JSON.stringify(c.current())===original);
check(p.api.answerPitDecision(st).reply.includes('20周'));check(!p.api.answerFuel(st,{fuel_l:99,laps_remaining:1,per_lap_l:1}).reply.includes('99'));check(!p.api.answerPitDecision(st,{laps_remaining:1}).reply.includes('走り切'));
const b=p.binding({kind:'plan'});check(p.validBinding(b));clock=100;check(c.receive(frame({seq:2,frame:11})));check(p.validBinding(b));clock=5000;check(!p.validBinding(b));check(p.state().available===true);clock=5100;check(p.state().available===false);
clock=5200;const held=frame({seq:3,allowed:false,proof:null,attempt:null});held.execution.gate_reason='restart_continuity_unverified';check(c.receive(held));check(p.state().active.decision_id==='d');check(!p.state().execution_allowed);check(p.api.answerPitDecision().reply.includes('保留'));check(p.validBinding(p.binding('active')));
for(const change of [s=>delete s.continuity.stable_scope,s=>s.continuity.stable_scope.driver_id=true,s=>s.continuity.stable_scope.driver_id=0,s=>s.continuity.stable_scope.session_num=2,s=>s.continuity.durable_commit=false]){const s=frame({allowed:false,attempt:null,proof:null});change(s);const projection=P.create({canonical:{current:()=>s},now:()=>0});check(!projection.state().available);check(projection.api.pitPlan()===null);}
const waiting=frame({seq:4,decision:null,allowed:false,attempt:null,proof:null});const rec=copy(frame().lifecycle.active);rec.phase='awaiting_driver';waiting.lifecycle.awaiting=[rec];check(c.receive(waiting));check(p.api.proposePlan(null,{decision_id:'wrong',lap:20,plan_id:'A',audible:true})===null);check(p.api.proposePlan(null,{decision_id:'d',lap:20,plan_id:'A'})===null);
check(p.api.proposePlan(null,{decision_id:'d',lap:20,plan_id:'A',audible:true}));const pending=p.api.pendingProposal();check(pending.canonical_revision===0);check(p.api.pitPlan()===null);check(p.api.applyProposalClassification(null,{decision_id:'d',request_revision:pending.base_revision-1,classification:'confirm'}).applied===false);
p.api.markAwaitingJudgment();check(p.api.resolvePendingProposal(null,{accepted:true})===null);const current=p.api.pendingProposal();const result=p.api.applyProposalClassification(null,{decision_id:'d',request_revision:current.base_revision,classification:'confirm'});check(result.requested);check(result.resolved.accepted);check(result.resolved.applied===false);check(p.api.pitPlan()===null);check(c.current().lifecycle.awaiting.length===1);
check(p.api.proposePlan(null,{decision_id:'d',lap:20,plan_id:'A',audible:true}));clock+=90000;check(p.api.pendingProposal()===null);
// Pit exits are immutable ledger outcomes. Raw entry and local writes cannot manufacture them.
for(const relation of ['normal','early','penalty','unresolved']){const s=frame({decision:null,allowed:false,proof:null,attempt:null});s.pit_ledger.events=[{pit_event_id:'pit1',execution_relation:relation,entry:{lap:10},event_ref:{pit_event_id:'pit1'}}];const q=P.create({canonical:{current:()=>s},now:()=>0});check(q.api.pitExecuted().execution_relation===relation);const reply=q.api.answerPitDecision();check(reply.state===relation);check(!reply.reply.includes('走り切'));}
const recs=frame();recs.recommendations.strategy_options={value:{plan_b:{available:true,target_lap:14}},role:'recommendation_not_execution',calculation_source:{source_frame_sequence:5,session_time_s:80}};const q=P.create({canonical:{current:()=>recs},now:()=>0});check(q.readPlaybook().plans.A.target_lap===20);check(q.readPlaybook().plans.A.role==='canonical_active');check(q.readPlaybook().plans.B.role==='recommendation_not_execution');check(q.readPlaybook().plans.B.age_s===20);check(q.readPlaybook().plans.C===undefined);check(q.raceFactsNote().includes('driver 10101'));
let cur=frame();const owner={current:()=>cur,expiresAt:()=>5000},scopeP=P.create({canonical:owner,now:()=>0});const oldBinding=scopeP.binding();scopeP.api.restateDriverStrategy(null,{text:'旧本人の相談'});cur=frame();cur.continuity.stable_scope.driver_id=20202;check(!scopeP.validBinding(oldBinding));check(scopeP.state().driver_strategy===null);
const scopeBinding=scopeP.binding();cur=frame();cur.lifecycle.active.revision=1;cur.continuity.stable_scope.driver_id=20202;check(!scopeP.validBinding(scopeBinding));
// Losing the authority clears audible metadata even when an identical awaiting record returns.
let authority=copy(waiting);let time=0;const metadata=P.create({canonical:{current:()=>authority},now:()=>time});
check(metadata.api.proposePlan(null,{decision_id:'d',lap:20,plan_id:'A',audible:true}));const conversation=metadata.api.revision();authority=null;metadata.state();authority=copy(waiting);check(metadata.api.pendingProposal()===null);check(metadata.api.revision()>conversation);
check(metadata.api.proposePlan(null,{decision_id:'d',lap:20,plan_id:'A',audible:true}));const rejected=metadata.api.applyProposalClassification(null,{decision_id:'d',request_revision:null,classification:'confirm'});check(!rejected.applied);check(metadata.api.pitPlan()===null);
const fuelSource=frame();fuelSource.recommendations.fuel_strategy={value:{avg_fuel_per_lap:2},role:'recommendation_not_execution',calculation_source:{source_frame_sequence:9,session_time_s:99}};
const fuelProjection=P.create({canonical:{current:()=>fuelSource},now:()=>0});const answer=fuelProjection.api.answerFuel(null,{fuel_l:999,per_lap_l:.1});check(answer.shortfall_l===7);check(answer.calculation_age_s===1);check(answer.reply.includes('推定'));check(!answer.reply.includes('999'));
let recommended=copy(fuelSource);const recommender=P.create({canonical:{current:()=>recommended},now:()=>0});const recommendationBinding=recommender.binding('recommendation');check(recommender.validBinding(recommendationBinding));recommended.recommendations.fuel_strategy.value.avg_fuel_per_lap=3;check(!recommender.validBinding(recommendationBinding));
const late=P.create({canonical:{current:()=>frame(),expiresAt:()=>5000},now:()=>4999}),lateBinding=late.binding();check(lateBinding.deadline_ms===5000);
for(const badSource of [{source_frame_sequence:11,session_time_s:99},{source_frame_sequence:9,session_time_s:101},{source_frame_sequence:9,session_time_s:-1},{source_frame_sequence:true,session_time_s:99},{source_frame_sequence:9,session_time_s:99,race_instance_id:'foreign'}]){const bad=copy(fuelSource);bad.recommendations.fuel_strategy.calculation_source=badSource;const q=P.create({canonical:{current:()=>bad},now:()=>0});check(q.api.answerFuel().shortfall_l===null);check(q.api.answerFuel().laps_possible===null);check(q.strategyEvaluation().recommendations.fuel_strategy.source_valid===false);}
const mixed=copy(recs);mixed.recommendations.strategy_options.value.plan_a={pit_laps:[99],needed_fuel_l:99,first_pit_lap:99};const unmixed=P.create({canonical:{current:()=>mixed},now:()=>0});check(unmixed.readPlaybook().plans.A.pit_laps===undefined);check(unmixed.readPlaybook().plans.A.needed_fuel_l===undefined);
const nullTarget=frame();nullTarget.lifecycle.active.target_lap=null;const unknownTarget=P.create({canonical:{current:()=>nullTarget},now:()=>0});check(!unknownTarget.api.answerPitDecision().reply.includes('null'));check(unknownTarget.api.answerPitDecision().state==='planned_target_unknown');
const closed=copy(waiting);closed.execution.scope_closed=true;closed.lifecycle.terminal_records=[{decision_id:'terminal',phase:'cancelled',record_ref:{decision_id:'terminal'}}];closed.pit_ledger.events=[{pit_event_id:'history-pit',execution_relation:'penalty',event_ref:{pit_event_id:'history-pit'}}];const history=P.create({canonical:{current:()=>closed},now:()=>0});check(!history.state().available);check(history.state().history_available);check(history.state().pitEvents[0].event_ref.pit_event_id==='history-pit');check(history.state().pit_executed===null);check(history.raceFactsNote().includes('Historical canonical outcomes only'));
for(const [key,value] of [['target_lap',22],['add_fuel_l',99],['set_fuel_l',99],['activated_source_frame_sequence',6],['selected_plan','B']]){let snapshot=frame();const testProjection=P.create({canonical:{current:()=>snapshot},now:()=>0}),bound=testProjection.binding();snapshot=copy(snapshot);snapshot.lifecycle.active[key]=value;check(!testProjection.validBinding(bound));}
let factual=frame();const factualProjection=P.create({canonical:{current:()=>factual},now:()=>0}),factBound=factualProjection.binding('facts');factual=copy(factual);factual.source_frame.sequence++;factual.current_facts.source_frame.sequence++;check(factualProjection.validBinding(factBound));factual.current_facts.fuel_level_l=4;check(!factualProjection.validBinding(factBound));
let pitFacts=frame({decision:null,allowed:false,attempt:null,proof:null});pitFacts.pit_ledger.events=[{pit_event_id:'e1',execution_relation:'unresolved',event_ref:{pit_event_id:'e1'}}];const pitBindingProjection=P.create({canonical:{current:()=>pitFacts},now:()=>0}),oldPitBinding=pitBindingProjection.api.answerPitDecision().binding;pitFacts=copy(pitFacts);pitFacts.pit_ledger.events.push({pit_event_id:'e2',execution_relation:'penalty',event_ref:{pit_event_id:'e2'}});check(!pitBindingProjection.validBinding(oldPitBinding));check(pitBindingProjection.api.answerPitDecision().state==='penalty');
let noPlan=frame({decision:null,allowed:false,attempt:null,proof:null});const noPlanProjection=P.create({canonical:{current:()=>noPlan},now:()=>0}),noPlanBound=noPlanProjection.api.answerPitDecision().binding;noPlan=frame();check(!noPlanProjection.validBinding(noPlanBound));check(noPlanProjection.api.pitPlan().lap===20);

// ★WO014 round4 (audit-corrected): pit_executed.service (lane_total_s/
// stall_s/fuel_added_l) is never a raw Bridge-telemetry echo -- it is only
// trusted from the SAME canonical immutable pit_ledger event already bound
// to this exact race_instance_id/session_num (defense-in-depth cross-check,
// since canonical_lifecycle_snapshot.build() filters pit_store by scope
// server-side). A leftover event whose OWN identity does not match the
// current snapshot's scope must yield service:null, never the stale sample
// ("前session旧sample残留" negative case) -- lap/execution_relation (already
// pre-existing canonical fields) are unaffected either way.
let serviceMatch=frame({decision:null,allowed:false,attempt:null,proof:null});
serviceMatch.pit_ledger.events=[{pit_event_id:'svc1',execution_relation:'normal',entry:{lap:9},event_ref:{pit_event_id:'svc1'},
  race_instance_id:serviceMatch.race_instance_id,session_num:serviceMatch.session_num,
  service:{lane_total_s:41.2,stall_s:27.5,fuel_added_l:52.0}}];
const serviceMatchProjection=P.create({canonical:{current:()=>serviceMatch},now:()=>0});
check(serviceMatchProjection.api.pitExecuted().service.lane_total_s===41.2);
check(serviceMatchProjection.api.pitExecuted().service.fuel_added_l===52.0);

let serviceStaleSession=frame({decision:null,allowed:false,attempt:null,proof:null});
serviceStaleSession.pit_ledger.events=[{pit_event_id:'svc2',execution_relation:'normal',entry:{lap:9},event_ref:{pit_event_id:'svc2'},
  race_instance_id:serviceStaleSession.race_instance_id,session_num:serviceStaleSession.session_num+1,  // previous session's leftover event
  service:{lane_total_s:99.9,stall_s:88.8,fuel_added_l:77.7}}];
const serviceStaleSessionProjection=P.create({canonical:{current:()=>serviceStaleSession},now:()=>0});
check(serviceStaleSessionProjection.api.pitExecuted().service===null);
check(serviceStaleSessionProjection.api.pitExecuted().execution_relation==='normal'); // lap/execution_relation themselves are unaffected

let serviceStaleRace=frame({decision:null,allowed:false,attempt:null,proof:null});
serviceStaleRace.pit_ledger.events=[{pit_event_id:'svc3',execution_relation:'normal',entry:{lap:9},event_ref:{pit_event_id:'svc3'},
  race_instance_id:serviceStaleRace.race_instance_id+'-old',session_num:serviceStaleRace.session_num,  // previous race's leftover event
  service:{lane_total_s:99.9,stall_s:88.8,fuel_added_l:77.7}}];
const serviceStaleRaceProjection=P.create({canonical:{current:()=>serviceStaleRace},now:()=>0});
check(serviceStaleRaceProjection.api.pitExecuted().service===null);

let serviceAbsent=frame({decision:null,allowed:false,attempt:null,proof:null});
serviceAbsent.pit_ledger.events=[{pit_event_id:'svc4',execution_relation:'normal',entry:{lap:9},event_ref:{pit_event_id:'svc4'},
  race_instance_id:serviceAbsent.race_instance_id,session_num:serviceAbsent.session_num}]; // no measured sample yet this visit
const serviceAbsentProjection=P.create({canonical:{current:()=>serviceAbsent},now:()=>0});
check(serviceAbsentProjection.api.pitExecuted().service===null);

// ★WO014 round3: binding('critical_context') is the raceContext reply fence
// for the 5 current-race LLM callers (sendMessage/followUp/paceCheck/
// judgeCall/autoBriefing). It MUST invalidate on a critical change (active
// plan/pit/penalty/pending-proposal revision) but MUST NOT invalidate on
// ordinary telemetry progression (fuel burning down, lap ticking up) --
// unlike binding('facts'), which legitimately tracks fuel/lap for
// answerFuel/answerPitDecision's own narrower purpose.
let critBase=frame();const critProjection=P.create({canonical:{current:()=>critBase},now:()=>0}),critBound=critProjection.binding('critical_context');
check(critProjection.validBinding(critBound));
critBase=copy(critBase);critBase.current_facts.fuel_level_l=1.2;critBase.current_facts.current_lap=critBase.current_facts.current_lap+1;
check(critProjection.validBinding(critBound));   // ordinary sequence: fuel/lap ticking alone must NOT invalidate
critBase=copy(critBase);critBase.race_facts.black_flag={...critBase.race_facts.black_flag,state:'true'};
check(!critProjection.validBinding(critBound));  // penalty (black_flag) change DOES invalidate
let critBase2=frame();const critProjection2=P.create({canonical:{current:()=>critBase2},now:()=>0}),critBound2=critProjection2.binding('critical_context');
critBase2=copy(critBase2);critBase2.lifecycle.active.revision=1;critBase2.lifecycle.active.record_ref.revision=1;
check(!critProjection2.validBinding(critBound2)); // critical Plan revision change DOES invalidate
let critBase3=frame({decision:null,allowed:false,attempt:null,proof:null});const critProjection3=P.create({canonical:{current:()=>critBase3},now:()=>0}),critBound3=critProjection3.binding('critical_context');
check(critProjection3.validBinding(critBound3));
critBase3=copy(critBase3);critBase3.lifecycle.awaiting=[{...frame().lifecycle.active,phase:'awaiting_driver'}];
check(!critProjection3.validBinding(critBound3)); // a NEW pending proposal appearing DOES invalidate (pendingrev)
let critBase4=frame({decision:null,allowed:false,attempt:null,proof:null});const critProjection4=P.create({canonical:{current:()=>critBase4},now:()=>0}),critBound4=critProjection4.binding('critical_context');
critBase4=copy(critBase4);critBase4.pit_ledger.events=[{pit_event_id:'e1',execution_relation:'unresolved',event_ref:{pit_event_id:'e1'}}];
check(!critProjection4.validBinding(critBound4)); // a new pit execution event DOES invalidate

// ★WO014 round4 residual ("execution/proof semantics"): the SAME Plan whose
// execution.allowed/gate_reason or box-authority proof identity materially
// changes was previously invisible to this fence (criticalContent only
// tracked active/pit_events/black_flag/awaiting).
let critBase6=frame();const critProjection6=P.create({canonical:{current:()=>critBase6},now:()=>0}),critBound6=critProjection6.binding('critical_context');
check(critProjection6.validBinding(critBound6));
critBase6=copy(critBase6);critBase6.execution.allowed=false;critBase6.execution.gate_reason='restart_continuity_unverified';
check(!critProjection6.validBinding(critBound6)); // execution newly HELD (allowed:true->false, gate_reason set) DOES invalidate

let critBase7=frame();const critProjection7=P.create({canonical:{current:()=>critBase7},now:()=>0}),critBound7=critProjection7.binding('critical_context');
check(critProjection7.validBinding(critBound7));
critBase7=copy(critBase7);critBase7.box_delivery.allowed_proof_id='a-different-proof';
check(!critProjection7.validBinding(critBound7)); // a DIFFERENT box-authority proof now authorized DOES invalidate

// ...but a per-frame-ish expiry clock ticking ALONE (same allowed/gate_
// reason/proof identity) must NOT discard the reply -- the same "stamp vs
// semantic change" discipline already proven for black_flag/source_frame
// above (round4 ordinary-frame fix) applies here too.
let critBase8=frame();const critProjection8=P.create({canonical:{current:()=>critBase8},now:()=>0}),critBound8=critProjection8.binding('critical_context');
check(critProjection8.validBinding(critBound8));
critBase8=copy(critBase8);critBase8.box_delivery.valid_until_session_s+=30;
check(critProjection8.validBinding(critBound8)); // valid_until_session_s alone ticking forward must NOT invalidate

// ★WO014 round4: race_facts.black_flag is RE-STAMPED every ordinary poll
// frame (observed_session_time/source_frame_sequence advance even when
// `state` never changes -- see authoritative_race_facts.build_snapshot()).
// A REAL next poll frame therefore advances source_frame.sequence/
// session_time_s, current_facts fuel/lap, AND black_flag's own stamps all
// TOGETHER -- the fence must still hold as long as no critical (Plan/pit/
// penalty/awaiting) fact actually changed. The earlier ordinary-sequence
// check above (line ~51) only varied current_facts, never black_flag's own
// per-frame stamps, so it could not have caught this.
let critBase5=frame();const critProjection5=P.create({canonical:{current:()=>critBase5},now:()=>0}),critBound5=critProjection5.binding('critical_context');
check(critProjection5.validBinding(critBound5));
critBase5=copy(critBase5);
critBase5.source_frame.sequence+=1;critBase5.source_frame.session_time_s+=1;
critBase5.race_facts.source_frame.sequence=critBase5.source_frame.sequence;critBase5.race_facts.source_frame.session_time_s=critBase5.source_frame.session_time_s;
critBase5.race_facts.black_flag.observed_session_time=critBase5.source_frame.session_time_s;critBase5.race_facts.black_flag.source_frame_sequence=critBase5.source_frame.sequence;
critBase5.current_facts.source_frame.sequence=critBase5.source_frame.sequence;critBase5.current_facts.source_frame.session_time_s=critBase5.source_frame.session_time_s;
critBase5.current_facts.fuel_level_l=4.2;critBase5.current_facts.current_lap=critBase5.current_facts.current_lap+1;
critBase5.finish.source_frame_sequence=critBase5.source_frame.sequence;
check(critProjection5.validBinding(critBound5)); // ordinary poll advance (frame+time+fuel+lap+bf stamps together) must NOT invalidate
critBase5=copy(critBase5);critBase5.race_facts.black_flag={...critBase5.race_facts.black_flag,state:'true'};
check(!critProjection5.validBinding(critBound5)); // ...but a genuine black_flag STATE change still does

// ★WO014 round4: binding('critical_context') must not return null while
// canonical is unavailable (initial/identity-unknown) -- it must return an
// explicit `unavailable:true` sentinel, valid only for as long as canonical
// STAYS unavailable, so a caller answering a driver's question with "I
// cannot confirm that" is still fenced against the state becoming known
// mid-flight (see desktop/renderer.html callAPI/_replyStrategyBinding).
const unknownProjection=P.create({canonical:{current:()=>null},now:()=>0});
const unknownBound=unknownProjection.binding('critical_context');
check(!!unknownBound && unknownBound.unavailable===true);
check(unknownProjection.validBinding(unknownBound));           // still unknown: the "I don't know" reply it fenced is still valid
const sourceSwap={state:null};
const swapProjection=P.create({canonical:{current:()=>sourceSwap.state},now:()=>0});
const swapBound=swapProjection.binding('critical_context');
check(swapBound.unavailable===true && swapProjection.validBinding(swapBound));
sourceSwap.state=frame();
check(!swapProjection.validBinding(swapBound));                // identity/session attached since: the old unknown-state reply must NOT survive as current

// ★WO014 round4 (audit correction): identity:null alone is not enough --
// two DIFFERENT unknown periods (never once usable) must not be treated as
// the same captured scope just because !usable(source()) is true both
// times. A partial/malformed scope still carries race_instance_id/
// session_num/driver_id even while telemetry/current_facts aren't ready
// yet; switching to a genuinely different one while STAYING unknown must
// discard the old "I don't know" reply, not let it survive as current.
const scopeSwap={state:{...frame(),telemetry_available:false}}; // usable()=false: telemetry not ready, but a real scope exists
const scopeSwapProjection=P.create({canonical:{current:()=>scopeSwap.state},now:()=>0});
const scopeSwapBound=scopeSwapProjection.binding('critical_context');
check(scopeSwapBound.unavailable===true && scopeSwapProjection.validBinding(scopeSwapBound));
scopeSwap.state={...frame({race:'different-race'}),telemetry_available:false}; // still unknown, but now a DIFFERENT race_instance_id
check(!scopeSwapProjection.validBinding(scopeSwapBound));       // different scope while still unknown -> old reply must NOT survive

// ★WO014 round4 residual ("unknown fully-null scope"): canonical.current()
// stays null for EVERY reason (never connected / disconnected / TTL
// expired) -- a plain rawScopeSignature(null) degenerates to one constant,
// so a genuine reset/reconnect (desktop/canonical-lifecycle-cache.js
// beginSocket(), a real new WebSocket attempt) that happens while current()
// stays null throughout would be invisible. connectionGeneration() (round4-
// added, read-only accessor over the cache's own already-tracked counter)
// must be folded into the captured scope so this is still detected using
// the REAL cache (not a hand-rolled mock).
const realCacheNeverConnected=C.create({now:()=>0});
const realCacheProjection=P.create({canonical:realCacheNeverConnected,now:()=>0});
check(realCacheNeverConnected.current()===null);
const realCacheBound=realCacheProjection.binding('critical_context');
check(realCacheBound.unavailable===true && realCacheProjection.validBinding(realCacheBound));
realCacheNeverConnected.beginSocket();  // a genuine reconnect attempt -- current() is STILL null throughout
check(realCacheNeverConnected.current()===null);
check(!realCacheProjection.validBinding(realCacheBound));  // reconnect detected even though current() never once changed

const sameScopeStillUnknown={state:{...frame(),telemetry_available:false}};
const sameScopeProjection=P.create({canonical:{current:()=>sameScopeStillUnknown.state},now:()=>0});
const sameScopeBound=sameScopeProjection.binding('critical_context');
check(sameScopeProjection.validBinding(sameScopeBound));
sameScopeStillUnknown.state={...frame(),source_frame:{...frame().source_frame,sequence:99},telemetry_available:false}; // same identity, still unknown, unrelated field moved
check(sameScopeProjection.validBinding(sameScopeBound));        // SAME scope, still unknown -> reply stays valid (not over-eager discard)

console.log('WO011 strategy projection '+count+' checks PASS; no API calls');
