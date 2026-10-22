'use strict';
const assert=require('assert'),vm=require('vm');
const {fixture,initialized}=require('./tests-canonical-lifecycle');
const {extract}=require('./tests-renderer-canonical-context');
const Memory=require('./desktop/session-memory'),Projection=require('./desktop/strategy-state-projection'),Router=require('./desktop/local-intent-router');
let checks=0;const check=(v,m)=>{assert(v,m);checks++;};
const storage=new Map(),identity={custId:315555,userId:null,track:'Monza Grand Prix',car:'Mercedes-AMG GT3',sessionType:'Race',raceFormat:'timed'};
const ctx={localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
 lastTrack:identity.track,lastCarModel:identity.car,lastCarClass:'GT3',lastSessionNum:1,lastSessionType:'Race',currentSessionCustId:315555,
 lastSessionAuthority:{},lastTelemetry:null,fuelLearningSignature:null,usageSessionId:'desktop-session',
 currentMemoryIdentity:()=>({...identity}),currentMemoryUserId:()=>null,localMemoryOwnerRef:()=>null,
 diagnosticLog:()=>{},saveMemory:()=>{},lastIrating:null,lastSr:null,validFinishPosition:()=>null,debriefOutcomeModule:()=>null,
 crypto:require('crypto'),Date,Math,console};
vm.createContext(ctx);
vm.runInContext(['sanitizeSessionEvidence','saveSessionSummary','rememberLiveFuelEvidence','loadRaceHistory','loadFuelPlanningHistory','currentCanonicalStrategyLive'].map(extract).join('\n'),ctx);
const yesterday=new Date(Date.now()-86400000).toISOString();
storage.set('pw_raceHistory',JSON.stringify([{...identity,raceRecordId:'old',recordedAt:yesterday,avgFuelPerLap:3.6,totalLaps:3,avgLap:114}]));
// Actual renderer persistence: clean-lap samples survive a process/session change.
ctx.rememberLiveFuelEvidence({race_instance_id:'fallback:previous',cust_id:315555,fuel_strategy:{clean_laps_sampled:3,avg_fuel_per_lap:3.8},driver_pace_median_s:116});
check(JSON.parse(storage.get('pw_fuel_history')).length===1,'live capture persisted');
ctx.rememberLiveFuelEvidence({race_instance_id:'fallback:previous',cust_id:315555,fuel_strategy:{clean_laps_sampled:3,avg_fuel_per_lap:3.8},driver_pace_median_s:116});
check(JSON.parse(storage.get('pw_fuel_history')).length===1,'same samples not double counted');
ctx.fuelLearningSignature=null;ctx.lastSessionNum=2;
const history=ctx.loadFuelPlanningHistory();check(history.filter(r=>!r.unverified_owner).length===2,'actual retrieval combines existing races and live samples');
const ev=Memory.fuelPlanningEvidence(history,identity,Date.now());check(ev.available&&ev.recordCount===2&&Math.abs(ev.avgFuelPerLap-3.7)<1e-9,'multiple records analysed');
check(Math.abs(ev.averageLapS-115)<1e-9,'historical pace analysed');
let clock=0;
const s=fixture({race:'fallback:current',session:2,decision:null,proof:null,attempt:null,allowed:false,lap:1});
s.continuity={...s.continuity,stable_scope:null,durable_commit:false,recovery_status:'identity_unsupported',gap_unknown:false,checkpoint_id:null,checkpoint_revision:null,error:null,origin_epoch:null};
s.current_facts.fuel_level_l=19;s.finish={...s.finish,kind:'time_race',available:false,remaining_after_current:null,remaining_sf_crossings:null};
ctx.canonicalLifecycleCache=initialized(()=>clock,s);ctx.strategyProjection=Projection.create({canonical:ctx.canonicalLifecycleCache,now:()=>clock});
function ask(live={},historyOverride=ctx.loadFuelPlanningHistory()){
 const mapped=ctx.currentCanonicalStrategyLive({cust_id:315555,track:identity.track,car_model:identity.car,on_track:true,
 race_plan:{kind:'timed',session_state:4},session_time_remaining_s:19*60,...live});
 return Router.route({text:'燃料これで最後まで持つ？',lang:'ja',live:mapped,memoryIdentity:identity,sessionMemory:Memory,
 raceHistory:historyOverride,fuelHistory:historyOverride,strategy:{state:ctx.strategyProjection.state(),api:ctx.strategyProjection.api}});
}
const start=ask();check(start.handled&&start.basis==='memory_analysis','real router uses history');
check(start.fuelEstimate.crossings===11,'19 minutes / 115 s pace + one safety lap');
check(Math.abs(start.fuelEstimate.required_l-42.7)<1e-6&&Math.abs(start.fuelEstimate.additional_l-23.7)<1e-6,'fuel requirement and reserve, not forged remaining fuel');
check(start.reply.includes('現在燃料19.0L')&&start.reply.includes('予備2L')&&start.reply.includes('23.7L'),'useful driver answer');
check(start.reply.includes('推奨')&&!start.action,'recommendation is not a pit command');
check(!ctx.strategyProjection.state().execution_allowed&&ctx.strategyProjection.api.pitPlan()===null,'fresh fallback facts never open execution');
// Three current clean laps replace previous consumption. After pit, recompute
// from current fuel and remaining crossings rather than the opening shortage.
const next=JSON.parse(JSON.stringify(s));next.snapshot_sequence++;next.snapshot_id=next.bridge_process_epoch+':'+next.snapshot_sequence;next.source_frame.sequence++;next.current_facts.source_frame.sequence++;next.race_facts.source_frame.sequence++;next.race_facts.black_flag.source_frame_sequence++;
next.current_facts.fuel_level_l=16;next.current_facts.current_lap=7;
next.finish={...next.finish,kind:'lap_race',available:true,remaining_sf_crossings:3,remaining_after_current:2,source_frame_sequence:next.source_frame.sequence};
next.recommendations.fuel_strategy={value:{avg_fuel_per_lap:3.5,clean_laps_sampled:3,strict_clean_laps_sampled:3,strict_clean_avg_fuel_per_lap:3.5,measured_laps_sampled:3,fuel_sample_basis:'pit_excluded_measured'},calculation_source:{source_frame_sequence:next.source_frame.sequence,session_time_s:next.source_frame.session_time_s}};
check(ctx.canonicalLifecycleCache.receive(next),'next canonical frame accepted');
const afterPit=ask();check(afterPit.basis==='current_clean_laps'&&afterPit.fuelEstimate.required_l===12.5&&afterPit.fuelEstimate.additional_l===0,'live measurements replace historical and post-pit old shortage');
check(afterPit.reply.includes('この推定では完走'),'after-pit answer');
// Identity and correction counterexamples.
for(const mutation of [{custId:999},{car:'Other car'},{track:'Spa'},{disputed:true},{deleted:true},{recordedAt:new Date(Date.now()+86400000).toISOString()}]){
 const rows=history.map(r=>({...r,...mutation}));check(!Memory.fuelPlanningEvidence(rows,identity).available,'reject '+JSON.stringify(mutation));
}
const older=history.map(r=>({...r,recordedAt:'2025-01-01T00:00:00Z',fuelRule:'different',seriesId:42}));
const oldEv=Memory.fuelPlanningEvidence(older,{...identity,fuelRule:'fixed',seriesId:1});
check(oldEv.available&&oldEv.confidence==='estimate_low'&&oldEv.warnings.includes('older_than_90_days')&&oldEv.warnings.includes('fuel_rule_mismatch'),'older/different conditions remain clearly labelled estimates');
const unknownOwner=[{...history[0],custId:null,userId:null}];check(!Memory.fuelPlanningEvidence(unknownOwner,identity).available,'legacy anonymous value is not attributed to this driver');
check(Memory.fuelPlanningEstimate({race_plan:{session_state:5},fuel:19},ev)===null,'finished race does not offer a new stop');
clock=6000;const stale=ask();check(!stale.fuelEstimate&&!stale.reply.includes('現在燃料16.0'),'expired canonical cannot reuse stale current data');
// A disputed session summary suppresses corresponding clean samples.
const liveRows=JSON.parse(storage.get('pw_fuel_history'));storage.set('pw_raceHistory',JSON.stringify([{...liveRows[0],disputed:true}]));
check(ctx.loadFuelPlanningHistory().every(r=>r.disputed),'disputed session cannot return via live cache');
// Preserve old race records through actual summary save, including > 10 rows.
storage.set('pw_raceHistory',JSON.stringify(Array.from({length:12},(_,i)=>({...history[0],raceRecordId:'kept'+i}))));
ctx.saveSessionSummary({track:identity.track,car_model:identity.car,cust_id:315555,total_laps:4,avg_fuel_per_lap:3.8});
check(JSON.parse(storage.get('pw_raceHistory')).length===13,'new summary does not erase older evidence');
// An existing agreed Plan is not falsely described as unregistered.
const agreedFrame=fixture({race:'sub:123',session:2});agreedFrame.continuity.stable_scope={race_instance_id:'sub:123',session_num:2,driver_id:315555};
agreedFrame.continuity.durable_commit=true;
const agreedProjection=Projection.create({canonical:initialized(()=>0,agreedFrame),now:()=>0});
const agreedReply=Router.route({text:'燃料足りる？',lang:'ja',live:{...plainFuelLive(),fuel:5,finish_crossings_authority:6},
 sessionMemory:Memory,memoryIdentity:identity,fuelHistory:history,raceHistory:history,
 strategy:{state:agreedProjection.state(),api:agreedProjection.api}});
function plainFuelLive(){return {cust_id:315555,track:identity.track,car_model:identity.car,race_plan:{kind:'timed',session_state:4}};}
check(agreedReply.reply.includes('推奨')&&!agreedReply.reply.includes('未登録')&&agreedProjection.api.pitPlan().lap===20,'fuel estimate preserves and truthfully describes an already agreed Plan');
// Anonymous legacy data is a last-resort device reference, never personal.
const deviceRows=[{track:identity.track,car:identity.car,avgFuelPerLap:4,avgLap:115,unverified_owner:true}];
const device=Memory.fuelPlanningEvidence(deviceRows,identity);
check(device.available&&device.basis==='device_reference'&&device.warnings.includes('owner_unverified'),'anonymous same-car/track reference remains useful and labelled');
check(Memory.fuelPlanningEvidence(deviceRows.concat(history),identity).basis==='memory_analysis','known personal history takes precedence');
check(!Memory.fuelPlanningEvidence([{...deviceRows[0],custId:999}],identity).available,'known other driver is never anonymised');
const spread=Memory.fuelPlanningEvidence([{...history[0],raceRecordId:'high',avgFuelPerLap:5},{...history[0],raceRecordId:'low',avgFuelPerLap:3}],identity);
check(spread.planningFuelPerLap===5&&spread.warnings.includes('variable_burn_upper_bound'),'wide historical range uses labelled upper bound instead of low mean');
// A capped five-lap window still updates the scoped record when its average changes.
ctx.lastSessionNum=3;ctx.fuelLearningSignature=null;
ctx.rememberLiveFuelEvidence({race_instance_id:'fallback:rolling',cust_id:315555,fuel_strategy:{clean_laps_sampled:5,avg_fuel_per_lap:3.8},driver_pace_median_s:116});
ctx.rememberLiveFuelEvidence({race_instance_id:'fallback:rolling',cust_id:315555,fuel_strategy:{clean_laps_sampled:5,avg_fuel_per_lap:4.1},driver_pace_median_s:117});
check(JSON.parse(storage.get('pw_fuel_history')).find(r=>r.race_instance_id==='fallback:rolling').avgFuelPerLap===4.1,'rolling average saved after count cap');
// Real deletion removes a matching live record and suppresses the anonymous
// aggregate. New-session observations may be learned normally afterward.
const rolling=JSON.parse(storage.get('pw_fuel_history')).find(r=>r.race_instance_id==='fallback:rolling');
storage.set('pw_raceHistory',JSON.stringify([{...rolling,raceRecordId:'delete-me'}]));
ctx.RACE_DISPUTE_KEY='pw_raceHistory';vm.runInContext(extract('deleteRaceRecord'),ctx);
check(ctx.deleteRaceRecord('delete-me'),'actual delete succeeded');
check(!ctx.loadFuelPlanningHistory().some(r=>r.race_instance_id==='fallback:rolling'||r.unverified_owner),'deleted data cannot resurrect through live cache or anonymous aggregate');
// Forecast binding survives ordinary burn but closes every material boundary.
let boundFrame=JSON.parse(JSON.stringify(s)),version=1;
const boundProjection=Projection.create({canonical:{current:()=>boundFrame},now:()=>clock,fuelEvidenceVersion:()=>version});
clock=0;const bound=boundProjection.api.fuelEstimateBinding();check(boundProjection.validBinding(bound),'estimate initially valid');
boundFrame.current_facts.fuel_level_l-=0.3;boundFrame.source_frame.sequence++;boundFrame.finish.source_frame_sequence++;
check(boundProjection.validBinding(bound),'ordinary fuel burn and sequence do not erase the answer');
const steady=JSON.parse(JSON.stringify(boundFrame));
for(const change of [f=>f.current_facts.fuel_level_l=25,f=>f.current_facts.fuel_level_l=18.4,f=>f.current_facts.on_pit_road=true,f=>f.execution.scope_closed=true,f=>f.execution.collision=true,f=>f.session_num++,f=>f.bridge_process_epoch='new',f=>f.finish.remaining_sf_crossings=5,f=>f.race_facts.black_flag.state='true']){
 boundFrame=JSON.parse(JSON.stringify(steady));change(boundFrame);check(!boundProjection.validBinding(bound),'changed scope/pit/finish/refuel/flag invalidates forecast');
}
boundFrame=steady;version++;check(!boundProjection.validBinding(bound),'changed memory invalidates forecast');version--;
clock=30001;check(!boundProjection.validBinding(bound),'forecast has a bounded lifetime');
boundFrame=JSON.parse(JSON.stringify(s));boundFrame.current_facts.fuel_level_l=0.8;clock=0;
const urgentBound=boundProjection.api.fuelEstimateBinding({rate_l_per_lap:3.7});
boundFrame.current_facts.fuel_level_l=0.6;check(!boundProjection.validBinding(urgentBound),'critical low fuel invalidates after 0.1 L rather than waiting for 0.5 L drift');
// Approximate observed remaining fuel/lap has a bounded burn allowance; SDK
// provenance refreshes cannot interrupt a short answer already playing.
let observationFrame=fixture({race:'sub:observation',session:2,decision:null,proof:null,attempt:null,allowed:false,lap:7});
observationFrame.continuity={...observationFrame.continuity,stable_scope:{race_instance_id:'sub:observation',session_num:2,driver_id:315555},durable_commit:true,recovery_status:'fresh'};
observationFrame.current_facts.fuel_level_l=16;
observationFrame.recommendations=JSON.parse(JSON.stringify(next.recommendations));
clock=0;
const observationProjection=Projection.create({canonical:{current:()=>observationFrame},now:()=>clock});
const observationReply=Router.route({text:'燃料の残量教えて。あと周回数も。',lang:'ja',live:{fuel:16,lap:7,finish_crossings_authority:6},strategy:{state:observationProjection.state(),api:observationProjection.api}});
const observationBinding=observationReply.strategyBinding;
check(observationReply.reply.includes('観測時の残量は約16.0L')&&observationReply.reply.includes('7周目')&&observationBinding?.kind==='fuel_observation','actual compound router labels its approximate observation and selects its dedicated binding');
observationFrame.current_facts.fuel_level_l=null;
const unknownObservation=Router.route({text:'燃料の残量教えて。',lang:'ja',live:{fuel:null,lap:7},strategy:{state:observationProjection.state(),api:observationProjection.api}});
check(unknownObservation.confidence==='unavailable'&&unknownObservation.strategyBinding.kind==='facts'&&observationProjection.validBinding(unknownObservation.strategyBinding),'missing fuel retains a valid unavailable answer instead of an impossible numeric observation binding');
observationFrame.current_facts.fuel_level_l=16;
const observationBase=JSON.parse(JSON.stringify(observationFrame));
observationFrame.source_frame.sequence++;observationFrame.source_frame.session_time_s++;
observationFrame.race_facts.black_flag.source_frame_sequence++;observationFrame.race_facts.black_flag.observed_session_time++;
observationFrame.finish.source_frame_sequence++;
observationFrame.recommendations.fuel_strategy.calculation_source.source_frame_sequence++;
observationFrame.recommendations.fuel_strategy.calculation_source.session_time_s++;
clock=1000;
check(observationProjection.validBinding(observationBinding),'same quoted values survive per-frame calculation and flag provenance refresh');
for(const [name,mutate] of [
 ['excess burn',f=>f.current_facts.fuel_level_l-=0.251],['unknown fuel',f=>f.current_facts.fuel_level_l=null],['refuel',f=>f.current_facts.fuel_level_l+=0.001],
 ['lap',f=>f.current_facts.current_lap++],['finish',f=>f.finish.remaining_sf_crossings--],
 ['pit',f=>f.current_facts.on_pit_road=true],['off track',f=>f.current_facts.on_track=false],
 ['flag',f=>f.race_facts.black_flag.state='true'],['execution',f=>f.execution.allowed=true],
 ['plan',f=>f.lifecycle.awaiting=[{decision_id:'new'}]],['driver',f=>f.continuity.stable_scope.driver_id++],
 ['race',f=>f.race_instance_id='sub:other'],['session',f=>f.session_num++],
 ['epoch',f=>f.bridge_process_epoch='other'],['closure',f=>f.execution.scope_closed=true],
 ['collision',f=>f.execution.collision=true],['unavailable',f=>f.telemetry_available=false]
]){
 observationFrame=JSON.parse(JSON.stringify(observationBase));
 const isolatedProjection=Projection.create({canonical:{current:()=>observationFrame},now:()=>clock});
 const isolatedBinding=isolatedProjection.api.fuelObservationBinding();
 mutate(observationFrame);
 check(!isolatedProjection.validBinding(isolatedBinding),'bounded observation rejects '+name);
}
// Burn accumulates against the original snapshot: a sequence of small
// steps cannot keep renewing the allowance or its deadline.
observationFrame=JSON.parse(JSON.stringify(observationBase));
for(let tick=1;tick<=4;tick++){
 clock=tick*1000;observationFrame.current_facts.fuel_level_l=16-0.032*tick;
 observationFrame.recommendations.fuel_strategy.calculation_source.source_frame_sequence++;
 check(observationProjection.validBinding(observationBinding),'normal 0.032 L/s burn preserves an approximately quoted observation at tick '+tick);
}
observationFrame.current_facts.fuel_level_l=15.75;check(observationProjection.validBinding(observationBinding),'high-fuel cumulative burn boundary 0.25 L is inclusive');
observationFrame.current_facts.fuel_level_l=15.749;check(!observationProjection.validBinding(observationBinding),'cumulative burn above 0.25 L invalidates even after small steps');
observationFrame=JSON.parse(JSON.stringify(observationBase));observationFrame.current_facts.fuel_level_l=5.5;clock=0;
const lowObservation=observationProjection.api.fuelObservationBinding();
check(lowObservation.fuel_observation.max_burn_l===0.1,'one-lap fuel plus reserve (3.5+2 L) uses the stricter allowance');
observationFrame.current_facts.fuel_level_l=5.4;check(observationProjection.validBinding(lowObservation),'low-fuel cumulative boundary 0.1 L is inclusive');
observationFrame.current_facts.fuel_level_l=5.399;check(!observationProjection.validBinding(lowObservation),'low-fuel burn above 0.1 L invalidates');
observationFrame.current_facts.fuel_level_l=5.501;check(!observationProjection.validBinding(lowObservation),'low-fuel increase also invalidates');
observationFrame=JSON.parse(JSON.stringify(observationBase));observationFrame.recommendations={};observationFrame.current_facts.fuel_level_l=2;
const noRateObservation=observationProjection.api.fuelObservationBinding();
check(noRateObservation.fuel_observation.max_burn_l===0.1,'without a measured consumption rate the 2 L reserve still uses the stricter allowance');
observationFrame=null;check(!observationProjection.validBinding(observationBinding),'disconnection invalidates quoted observation');
observationFrame=JSON.parse(JSON.stringify(observationBase));clock=0;
const deadlineObservation=observationProjection.api.fuelObservationBinding();clock=4999;
check(observationProjection.validBinding(deadlineObservation),'quoted observation remains valid immediately before its five-second deadline');
clock=5000;check(!observationProjection.validBinding(deadlineObservation),'quoted observation expires at five seconds despite fresh source');
// A top-up below the original baseline is still a fuel increase. Detection
// belongs to the shared source observer, not just a binding validation read.
observationFrame=JSON.parse(JSON.stringify(observationBase));clock=0;
const increaseProjection=Projection.create({canonical:{current:()=>observationFrame},now:()=>clock});
const beforeIncrease=increaseProjection.api.fuelObservationBinding();
observationFrame.current_facts.fuel_level_l=15.9;observationFrame.snapshot_sequence++;observationFrame.snapshot_id+=':burn';
check(increaseProjection.validBinding(beforeIncrease),'ordinary burn before a top-up stays valid');
for(let read=0;read<3;read++)increaseProjection.state();
check(increaseProjection.validBinding(beforeIncrease),'repeated reads of the same snapshot do not invent refuelling');
observationFrame.current_facts.fuel_level_l=15.99;observationFrame.snapshot_sequence++;observationFrame.snapshot_id+=':topup';
increaseProjection.state();
check(!increaseProjection.validBinding(beforeIncrease),'16 to 15.9 to 15.99 rejects top-up despite remaining below the starting fuel');
const afterIncrease=increaseProjection.api.fuelObservationBinding();
check(increaseProjection.validBinding(afterIncrease),'a fresh answer may bind to the new post-refuel observation');
observationFrame.current_facts.fuel_level_l=15.98;observationFrame.snapshot_sequence++;observationFrame.snapshot_id+=':next';
check(increaseProjection.validBinding(afterIncrease),'burn after a new observation remains valid');
check(!increaseProjection.validBinding(beforeIncrease),'an old answer cannot revive when fuel burns down after a top-up');
observationFrame={...JSON.parse(JSON.stringify(observationBase)),race_instance_id:'sub:new-scope'};
observationFrame.continuity.stable_scope.race_instance_id=observationFrame.race_instance_id;
observationFrame.current_facts.fuel_level_l=40;
const otherScope=increaseProjection.api.fuelObservationBinding();
check(otherScope.fuel_observation.increase_generation===0&&increaseProjection.validBinding(otherScope),'new scope starts a fresh fuel observer without comparing another race');
observationFrame=JSON.parse(JSON.stringify(observationBase));
check(!increaseProjection.validBinding(beforeIncrease),'returning to the former race does not revive an old scope generation');
// Fresh readonly fallback context also reaches the server schema validator.
clock=0;boundFrame=JSON.parse(JSON.stringify(s));const RC=require('./desktop/race-context-builder');
const rc=RC.build({projectionView:boundProjection.current(),snapshot:boundFrame,evaluation:boundProjection.strategyEvaluation(),now:()=>Date.now()});
check(RC.validate(rc,Date.now()),'fallback readonly facts validate for server conversation');
boundFrame.last_driver_action={available:true,action:{command_id:'rejected-cmd',outcome:'rejected'}};
const readonlyAction=RC.build({projectionView:boundProjection.current(),snapshot:boundFrame,evaluation:boundProjection.strategyEvaluation(),now:()=>Date.now()});
check(readonlyAction.last_driver_action===null&&RC.validate(readonlyAction,Date.now()),'a rejected/raw action cannot invalidate readonly facts or imply execution');
const bad=JSON.parse(JSON.stringify(rc));bad.allowed_actions.execution_allowed=true;check(!RC.validate(bad,Date.now()),'unknown driver cannot authorize execution');
// Field-language neighbours use the correct target and preserve questions.
const plain={lang:'ja',live:{last:116,best:114.8,driver_pace_median_s:115.5,weather:{air_temp_c:21,track_temp_c:32,humidity:40},lap:8,fuel:12}};
for(const text of ['ルナ？走りはどう？','違うよ。俺の走りはどうなの？']){
 const r=Router.route({...plain,text});check(r.intent==='driving_assessment'&&r.reply.includes('直近')&&r.reply.includes('ベスト'),'driver pace question answered from measured laps');
}
const air=Router.route({...plain,text:'気温だけ教えて。'});check(air.reply==='気温21.0℃。','air-only correction is honoured');
const compound=Router.route({...plain,text:'燃料の残量教えて。あと周回数も。'});check(compound.reply.includes('8周目'),'fuel early return does not discard lap question');
check(Router.route({...plain,text:'ピットストップ？何周年ぐらいにするの？'}).intent==='pit_plan_question','pit stop is not a leader substring');
check(Router.route({...plain,text:'この週でピット入らないと燃料切れちゃうよ。'}).action?.type==='driver_plan_command','necessity reaches native command/ACK route');
check(!Router.route({...plain,text:'この周はピットに入らない。'}).action,'true negation never commands');
check(!Router.route({...plain,text:'全くもって改善されてないね。'}).handled,'product complaint is not a calming race acknowledgement');
const Dispute=require('./desktop/dispute-detector');
check(Dispute.detect('それはエンジニアの仕事じゃないね。',{lunaTurns:[{text:'現在燃料を確認できない。'}]})===null,'quality criticism does not retract a measured record');
const Card=require('./engineer-card');check(Card.classify('後方集団は一気にピットインしてる。')?.topic!=='traffic_status','pit movement observation is not nearest-car traffic status');
// The Monza counterexample: five pit-excluded measured laps are not five
// clean laps. Two actual clean laps keep history as the provisional basis.
const mixedLive={fuel:19,finish_crossings_authority:6,race_plan:{session_state:4},fuel_strategy:{avg_fuel_per_lap:3.75,
 measured_laps_sampled:5,clean_laps_sampled:2,strict_clean_laps_sampled:2,strict_clean_avg_fuel_per_lap:3.9,fuel_sample_basis:'pit_excluded_measured'}};
const mixed=Memory.fuelPlanningEstimate(mixedLive,ev);
check(mixed.basis==='memory_analysis'&&mixed.strict_clean_laps===2&&Math.abs(mixed.rate_l_per_lap-3.7)<1e-9,'measured5/clean2 uses history provisionally');
const noHistoryMixed=Memory.fuelPlanningEstimate(mixedLive,null);
check(noHistoryMixed.basis==='current_clean_laps'&&noHistoryMixed.live_sample_laps===2&&noHistoryMixed.confidence==='estimate_low','two clean samples are labelled provisional when no history exists');
const noClean=Memory.fuelPlanningEstimate({...mixedLive,fuel_strategy:{...mixedLive.fuel_strategy,strict_clean_laps_sampled:0,strict_clean_avg_fuel_per_lap:null}},null);
check(noClean.basis==='current_measured_laps'&&noClean.live_sample_laps===5&&noClean.confidence==='estimate_low','dirty/unknown measured samples never become clean confirmations');
// The original raw arrival scope must not be rewritten to the newer
// canonical scope before pace/clock fields are consumed.
clock=0;
const current=ctx.canonicalLifecycleCache.current();
ctx.lastTelemetryAuxRef={bridge_process_epoch:current.bridge_process_epoch,race_instance_id:'old-race',session_num:current.session_num,cust_id:315555};
const poisoned=ctx.currentCanonicalStrategyLive({last:99,best:98,driver_pace_median_s:97,session_time_remaining_s:999,race_plan:{kind:'timed'},timed_finish_forecast:{driver_avg_lap_s:96}});
check(poisoned.last===null&&poisoned.best===null&&poisoned.driver_pace_median_s===null&&poisoned.session_time_remaining_s===null&&poisoned.race_plan===null&&poisoned.timed_finish_forecast===null,'new canonical cannot relabel previous-race pace/clock as current');
ctx.lastTelemetryAuxRef={...ctx.lastTelemetryAuxRef,race_instance_id:current.race_instance_id};
const sameScope=ctx.currentCanonicalStrategyLive({last:116,best:115,driver_pace_median_s:115.5,session_time_remaining_s:180,race_plan:{kind:'timed'}});
check(sameScope.last===116&&sameScope.session_time_remaining_s===180,'ordinary snapshot progress within same scope retains raw measurements');
for(const track of ['Autodromo Nazionale Monza','Monza Grand Prix','monza full']){
 check(Memory.fuelPlanningEvidence([{...history[0],track}],{...identity,track:'Autodromo Nazionale Monza'}).available,'verified full/GP/display track aliases retrieve the same layout');
}
for(const track of ['Monza Junior','Monza combined','Monza oval']){
 check(!Memory.fuelPlanningEvidence([{...history[0],track}],{...identity,track:'Autodromo Nazionale Monza'}).available,'different Monza layouts never merge');
}
console.log(JSON.stringify({checks,start:start.reply,afterPit:afterPit.reply,paidApiCalls:0},null,2));
