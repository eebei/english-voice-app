'use strict';
const assert=require('assert'),vm=require('vm'),{extract}=require('./tests-renderer-canonical-context'),Memory=require('./desktop/session-memory');
let checks=0;const check=(v,m)=>{assert(v,m);checks++;};
const storage=new Map();const ctx={Date,Math,Number,String,JSON,crypto:require('crypto'),sel:'LunaJP',
 localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
 lastTelemetry:{race_instance_id:'new-race',session_num:2,cust_id:999,race_plan:{kind:'laps'},laps_total:99},
 lastTrack:'New track',lastCarModel:'New car',lastCarClass:'GT3',lastSessionType:'Race',lastSessionAuthority:{fuel_rule:'new-rule',tyre_rule:'new-rule'},
 lastIrating:null,lastSr:null,currentMemoryUserId:()=> 'new-account',localMemoryOwnerRef:()=> 'new-owner',
 saveMemory:()=>{},diagnosticLog:()=>{},debriefOutcomeModule:()=>null,
 evidenceCopy:()=>({classPos:'P',average:'平均',fuel:'燃費',incidents:'Incidents'}),fmtLap:n=>String(n),debriefOutcomeLines:()=>[]};
vm.createContext(ctx);vm.runInContext(['validFinishPosition','sanitizeSessionEvidence','evidenceLines','saveSessionSummary'].map(extract).join('\n'),ctx);
const source={race_instance_id:'old-race',session_num:1,cust_id:315555,track:'Monza Grand Prix',car_model:'Mercedes-AMG GT3',
 car_class:'GT3',event_type:'Race',completed_laps:9,recorded_lap_count:8,total_laps:8,laps_basis:'sdk_completed',
 measured_best_lap:114.548,strict_clean_best_lap:114.835,best_lap:114.835,best_lap_basis:'strict_clean_measurement',
 avg_lap:116,avg_lap_basis:'recorded_samples',strict_clean_avg_lap:115.8,avg_fuel_per_lap:3.75,
 strict_clean_laps_sampled:2,strict_clean_avg_fuel_per_lap:3.9,fuel_sample_basis:'pit_excluded_measured'};
const normalized=ctx.sanitizeSessionEvidence(source);check(normalized.total_laps===9&&normalized.recorded_lap_count===8,'SDK completion and recorded sample count remain separate');
const lines=ctx.evidenceLines(source).join(' ');check(lines.includes('9周完了')&&lines.includes('計測8周')&&lines.includes('クリーン最速 114.835')&&!lines.includes('114.548'),'Driver sees the correct definitions');
const measured=ctx.evidenceLines({...source,strict_clean_best_lap:null,best_lap:114.548,best_lap_basis:'measured_unverified'}).join(' ');
check(measured.includes('計測最速 114.548')&&!measured.includes('クリーン最速'),'unverified quickest is not called clean or official');
const declared=ctx.evidenceLines({...source,best_lap:115,best_lap_basis:'driver_declared'}).join(' ');
check(declared.includes('申告ベスト 115'),'driver correction is not promoted to measured/official evidence');
ctx.saveSessionSummary(source);
const saved=JSON.parse(storage.get('pw_raceHistory'))[0];
check(saved.totalLaps===9&&saved.completedLaps===9&&saved.recordedLapCount===8,'history persists both counts');
check(saved.bestLap===114.835&&saved.bestLapBasis==='strict_clean_measurement'&&saved.measuredBestLap===114.548,'history preserves both quickest sources');
check(saved.avgLap===116&&saved.avgLapBasis==='recorded_samples'&&saved.strictCleanAvgLap===115.8,'small clean set is not promoted to full-race pace');
check(saved.raceFormat===null&&saved.fuelRule===null&&saved.tyreRule===null&&saved.totalLapsRule===null&&saved.userId===null,'late old-race summary is not filled with new-race conditions or user');
for(const [fields,expected] of [
 [{race_format:'timed',configured_duration_s:1200,total_laps_rule:12,race_plan:{kind:'laps',configured_duration_s:999}},['timed',1200,12]],
 [{race_plan:{kind:'timed',configured_duration_s:1500},total_laps_rule:15},['timed',1500,15]],
 [{race_format:null,configured_duration_s:null,total_laps_rule:null,race_plan:{kind:'laps',configured_duration_s:999}},[null,null,null]]
]){
 ctx.saveSessionSummary({...source,...fields});
 const record=JSON.parse(storage.get('pw_raceHistory')).at(-1);
 check(record.raceFormat===expected[0]&&record.configuredDurationS===expected[1]&&record.totalLapsRule===expected[2],'explicit old-summary conditions survive a new current race and precede race_plan fallback');
}
check(saved.car==='Mercedes-AMG GT3'&&saved.carClass==='GT3','history stores exact model separately from class despite another current car');
ctx.saveSessionSummary({...source,car_model:undefined,car_class:undefined});
const anonymousCar=JSON.parse(storage.get('pw_raceHistory')).at(-1);
check(anonymousCar.car===''&&anonymousCar.carClass==='','late old-race summary never borrows the current model/class when its own are absent');
const ev=Memory.fuelPlanningEvidence([saved],{custId:315555,track:'Autodromo Nazionale Monza',car:'Mercedes-AMG GT3'});
check(ev.available&&ev.averageLapS===116,'next-session clock estimate retrieves labelled recorded pace');
const noCounter=ctx.evidenceLines({...source,completed_laps:null,total_laps:8}).join(' ');
check(noCounter.includes('計測8周')&&!noCounter.includes('周完了'),'unknown completion is not inferred from samples');
// The production prompt builder carries the limitation through both current
// race and post-race contexts; a missing current fact cannot rewrite history.
const {buildSystem}=require('./prompts');
for(const mode of ['race','debrief']){
 const built=buildSystem({character:'LunaJP',mode,userName:'Yuji',telemetry:'off',raceContextModern:true,raceContext:null});
 const prompt=built.prefix+built.suffix;
 check(prompt.includes('CURRENT UNAVAILABLE DOES NOT MEAN NEVER RECEIVED')&&prompt.includes('dated conversation observations')&&prompt.includes('Do not diagnose data-loss causes without supplied diagnostic evidence'),'postrace/current-unavailable inference prohibition reaches '+mode+' prompt');
}
console.log('Summary metric boundary '+checks+' checks PASS; actual Renderer storage/labels and prompt builder, paid API calls 0');
