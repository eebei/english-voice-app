'use strict';
const assert=require('assert'),C=require('./desktop/canonical-lifecycle-cache'),P=require('./desktop/strategy-state-projection'),RC=require('./desktop/race-context-builder');
const {fixture,initialized}=require('./tests-canonical-lifecycle');
const copy=x=>JSON.parse(JSON.stringify(x));let checks=0;const check=(v,m)=>{assert(v,m);checks++;};
const s=fixture({race:'fallback:ai-race'});
s.continuity={...s.continuity,stable_scope:null,custody_scope:{race_instance_id:s.race_instance_id,session_num:s.session_num,driver_id:10101,process_epoch:s.bridge_process_epoch},durable_commit:true,recovery_status:'fresh',gap_unknown:false,checkpoint_id:s.bridge_process_epoch+':checkpoint:1',checkpoint_revision:1,error:null,origin_epoch:null};
check(C.validate(s),'valid process-scoped custody snapshot');
const cache=initialized(()=>0,s),projection=P.create({canonical:cache,now:()=>0});
check(cache.authority()?.decisionId==='d','same-process native command authority');
check(projection.state().pit_plan?.lap===20&&projection.state().execution_allowed,'committed current process Plan remains usable');
check(projection.state().scope.process_epoch===s.bridge_process_epoch,'custody is explicit, not forged stable scope');
check(cache.current().continuity.stable_scope===null,'stable restart identity remains null');
const rc=RC.build({projectionView:projection.current(),snapshot:cache.current(),evaluation:projection.strategyEvaluation()});
check(RC.validate(rc),'full conversation context accepts current custody');
const bound=projection.binding();check(projection.validBinding(bound),'current Plan binding');
for(const change of [x=>x.continuity.custody_scope.process_epoch='old-epoch',x=>x.continuity.custody_scope.driver_id=0,x=>x.continuity.custody_scope.session_num++,x=>x.continuity.custody_scope.race_instance_id='foreign',x=>x.continuity.stable_scope={race_instance_id:x.race_instance_id,session_num:x.session_num,driver_id:10101}]){
 const bad=copy(s);change(bad);check(!C.validate(bad),'invalid or ambiguous custody rejected');
}
const next=copy(s);next.bridge_process_epoch='epoch-new';next.snapshot_id='epoch-new:1';
const newCache=C.create({now:()=>0}),g=newCache.beginSocket();newCache.hello(g,{type:'connected',schema_version:1,bridge_process_epoch:'epoch-new'});
check(!newCache.receive(s,g)&&!newCache.authority(),'old epoch snapshot cannot authorize a new owner');
const held=copy(s);held.execution.allowed=false;held.box_delivery.allowed_attempt_id=null;held.box_delivery.allowed_proof_id=null;held.continuity.durable_commit=false;
const uncommitted=P.create({canonical:initialized(()=>0,held),now:()=>0});
check(uncommitted.state().available&&!uncommitted.state().execution_allowed&&uncommitted.state().active===null,'uncommitted custody keeps facts, never an active Plan');
console.log('Process custody desktop '+checks+' checks PASS; no paid APIs');
