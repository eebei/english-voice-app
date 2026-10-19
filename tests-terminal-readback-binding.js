#!/usr/bin/env node
'use strict';
// The exact terminal record fences a readback; fuel/lap progression is unrelated.
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const CF=require('./tests-canonical-lifecycle'),C=require('./desktop/canonical-lifecycle-cache');
const original=fs.readFileSync(__dirname+'/desktop/strategy-state-projection.js','utf8');
const P=require('./desktop/strategy-state-projection');
const copy=x=>JSON.parse(JSON.stringify(x));
let count=0;const check=x=>{assert(x);count++;};
const base=CF.fixture({decision:'cancelled-plan',proof:null,attempt:null,allowed:false});
base.continuity.stable_scope={race_instance_id:base.race_instance_id,session_num:base.session_num,driver_id:1};
const record=base.lifecycle.active;record.phase='cancelled';record.revision=1;record.record_ref.revision=1;
base.lifecycle.active=null;base.lifecycle.active_plan_id=null;base.lifecycle.terminal_records=[record];
function run(module){let time=0,seq=base.snapshot_sequence;const cache=CF.initialized(()=>time,base);const projection=module.create({canonical:cache,now:()=>time});
 const publish=mutate=>{const s=copy(cache.current());s.snapshot_sequence=++seq;s.snapshot_id=s.bridge_process_epoch+':'+seq;mutate(s);check(cache.receive(s));};
 return {cache,projection,publish,setTime:t=>time=t};}
const normal=run(P),binding=normal.projection.binding({kind:'terminal',decision_id:record.decision_id});
check(binding.kind==='terminal'&&binding.revision===1&&binding.record_ref.decision_id===record.decision_id);check(normal.projection.validBinding(binding));
normal.publish(s=>{s.current_facts.current_lap++;s.current_facts.fuel_level_l-=.1;});check(normal.projection.validBinding(binding));
normal.publish(s=>{s.lifecycle.terminal_records[0].invalidated_reason='different';});check(!normal.projection.validBinding(binding));
for(const mutate of [s=>s.lifecycle.terminal_records=[],s=>{s.lifecycle.terminal_records[0].revision++;s.lifecycle.terminal_records[0].record_ref.revision++;},s=>s.lifecycle.terminal_records[0].phase='invalidated',s=>s.continuity.stable_scope.driver_id=2,s=>s.execution.scope_closed=true]){
 const r=run(P),b=r.projection.binding({kind:'terminal',decision_id:record.decision_id});
 r.publish(mutate);check(!r.projection.validBinding(b));
}
const disconnected=run(P),db=disconnected.projection.binding({kind:'terminal',decision_id:record.decision_id});disconnected.cache.disconnect();check(!disconnected.projection.validBinding(db));
const expired=run(P),eb=expired.projection.binding({kind:'terminal',decision_id:record.decision_id});expired.setTime(5000);check(!expired.projection.validBinding(eb));
const ep=run(P),epb=ep.projection.binding({kind:'terminal',decision_id:record.decision_id}),g=ep.cache.beginSocket();ep.cache.hello(g,{type:'connected',schema_version:1,bridge_process_epoch:'new-epoch'});check(!ep.projection.validBinding(epb));
check(normal.projection.binding({kind:'terminal',decision_id:'unknown'})===null);
// Recreate the former caller choice exactly. This fails after one ordinary frame;
// the same terminal-bound readback above stays valid. No fake authority is used.
const old=run(P),oldFacts=old.projection.binding()||old.projection.binding('facts');old.publish(s=>{s.current_facts.fuel_level_l-=.1;});check(!old.projection.validBinding(oldFacts));
// Real cache expires between state inspection and binding acquisition. The
// caller must retain the pending ACK and emit nothing, then retry once after
// a fresh real publication. Only the clock and UI/speech IO are controlled.
const H=require('./tests-renderer-canonical-context'),r=run(P),output=[];
const entry={envelope:{intent:'cancel',bridge_process_epoch:base.bridge_process_epoch,race_instance_id:base.race_instance_id,session_num:base.session_num,expected_decision_id:record.decision_id},ack:{lifecycle_phase:'cancelled',result_revision:1}};
const ctx={canonicalLifecycleCache:r.cache,strategyProjection:r.projection,
 pendingCanonicalCommandReadbacks:new Map([['real-command',entry]]),
 ensureStrategyState:()=>{const value=r.projection.state();r.setTime(5000);return value;},
 isJapaneseEngineer:()=>true,addMsg:(...a)=>output.push(['ui',...a]),pushMsg:(...a)=>output.push(['history',...a]),
 nextUtteranceId:()=> 'readback-id',speak:(...a)=>output.push(['speech',...a]),diagnosticLog:()=>{},SPEAK_PRIO:{P2_PROCEDURE:2}};
vm.createContext(ctx);vm.runInContext(H.extract('confirmCanonicalCommandReadbacks'),ctx);
ctx.confirmCanonicalCommandReadbacks();check(output.length===0);check(ctx.pendingCanonicalCommandReadbacks.size===1);
r.setTime(6000);const refreshed=copy(base);refreshed.snapshot_sequence++;refreshed.snapshot_id=base.bridge_process_epoch+':'+refreshed.snapshot_sequence;check(r.cache.receive(refreshed));ctx.ensureStrategyState=r.projection.state;
ctx.confirmCanonicalCommandReadbacks();check(output.filter(x=>x[0]==='speech').length===1);check(ctx.pendingCanonicalCommandReadbacks.size===0);ctx.confirmCanonicalCommandReadbacks();check(output.filter(x=>x[0]==='speech').length===1);
console.log('Terminal readback binding '+count+' checks PASS (native identity/content; scope/epoch/TTL unchanged)');
