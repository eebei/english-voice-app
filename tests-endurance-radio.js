#!/usr/bin/env node
'use strict';
// The WO011 execution contract deliberately treats multi-stop endurance as a
// dated reference, never as a BOX/service instruction. Exercise the real cache,
// projection and announcement caller; no core policy stub or paid provider IO.
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const H=require('./tests-renderer-canonical-context');
const bridge=fs.readFileSync(__dirname+'/irsdk-bridge/bridge.py','utf8');
let checks=0;const check=(label,ok)=>{assert(ok,label);checks++;};
const plan={available:true,multi_stop:true,next_fuel_stop_in_laps:1,future_stop_count:4,
 splash_forecast:{available:true,splash_candidate:true,projected_final_service_l:8.4,avoid_splash_save_l_per_lap:.14,avoid_splash_feasible:true}};
function harness(value,source={source_frame_sequence:10,session_time_s:100},cut=false){
 const spoken=[],traces=[];const context={lastSessionType:'Race',lastSessionNum:4,enduranceForecastAnnouncedKey:'',isSessionEndingLifecycle:()=>false,isJapaneseEngineer:()=>true,addMsg:()=>{},pushMsg:()=>{},speak:(text,meta)=>spoken.push({text,meta}),diagnosticLog:(...a)=>traces.push(a),SPEAK_PRIO:{P3_STRATEGY:3}};
 H.install(context,{session_num:4,lap:20},{fuel_strategy:{value:{endurance_plan:value},calculation_source:source}});
 let src=H.extract('maybeAnnounceEnduranceFuelForecast');
 if(cut){const m=src.replace('rec?.source_valid?rec.value?.endurance_plan:null','rec?.value?.endurance_plan');check('source validity cut anchor matched',m!==src);src=m;}
 vm.runInContext(src,context);return {context,spoken,traces};
}
const valid=harness(plan);valid.context.maybeAnnounceEnduranceFuelForecast({});valid.context.maybeAnnounceEnduranceFuelForecast({});
check('same canonical calculation is announced once',valid.spoken.length===1);
check('multi-stop stays an explicit dated reference',/0\.0秒前の参考計算/.test(valid.spoken[0].text));
check('no unsupported pit/fuel instruction is established',/ピットや給油指示は確定しない/.test(valid.spoken[0].text)&&!/次周ボックス|毎周0\.14Lセーブ/.test(valid.spoken[0].text));
check('reference uses strategy priority',valid.spoken[0].meta.prio===3);
check('reference carries the real recommendation binding',valid.spoken[0].meta.strategyBinding.kind==='recommendation'&&valid.spoken[0].meta.precheck());
const early=harness({...plan,next_fuel_stop_in_laps:22});early.context.maybeAnnounceEnduranceFuelForecast({});check('early stint does not create an immediate service command',early.spoken.length===1&&!/次周ボックス/.test(early.spoken[0].text));
const single=harness({...plan,multi_stop:false});single.context.maybeAnnounceEnduranceFuelForecast({});check('single-stop plan does not enter multi-stop reference',single.spoken.length===0);
const missing=harness(plan,null);missing.context.maybeAnnounceEnduranceFuelForecast({endurance_fuel_plan:plan});check('raw endurance echo cannot bypass missing calculation provenance',missing.spoken.length===0);
const future=harness(plan,{source_frame_sequence:11,session_time_s:101});future.context.maybeAnnounceEnduranceFuelForecast({});check('future calculation fails closed',future.spoken.length===0);
const mutant=harness(plan,{source_frame_sequence:11,session_time_s:101},true);mutant.context.maybeAnnounceEnduranceFuelForecast({});check('same future-source case goes RED when source_valid gate is removed',mutant.spoken.length===1);
check('Bridge imports endurance calculation module',bridge.includes('import endurance_fuel as endurance_fuel_mod'));
check('Bridge passes current-stint verdict to fuel calculation',bridge.includes('endurance_plan=_endurance_plan'));
check('Bridge exposes reference plan',bridge.includes("'endurance_fuel_plan': ("));
check('requested stop does not use whole-race total',bridge.includes('_warning_requested_add = max(')&&bridge.includes('session_effective_fuel_capacity_l or 0.0'));
console.log('✅ endurance reference/caller contract: '+checks+' checks');
