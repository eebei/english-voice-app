'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const renderer=fs.readFileSync('desktop/renderer.html','utf8');
function grab(name){const p=renderer.indexOf('\nfunction '+name+'(');assert(p>=0,name);const tail=renderer.slice(p+1),end=tail.indexOf('\n}\n');assert(end>=0,name);return tail.slice(0,end+2);}
const identity={custId:42,userId:'u',car:'GT3',track:'Monza Grand Prix'};
let rows=[];
const current={race_instance_id:'current',session_num:0,bridge_process_epoch:'epoch',snapshot_id:'epoch:1',snapshot_sequence:1,
  continuity:{durable_commit:true,custody_scope:{driver_id:42}}};
let puts=0;
const ctx={TextEncoder,Date,Map,Set,JSON,Number,Math,performance:{now:()=>100},
  currentMemoryIdentity:()=>identity,memoryTrackCandidates:()=>['Monza Grand Prix','monza'],
  loadFuelPlanningHistory:()=>rows,PitwallSessionMemory:require('./desktop/session-memory'),
  canonicalLifecycleCache:{current:()=>current},criticalJournal:{healthy:()=>true,put:()=>{puts++;return true;},key:()=>String(puts)},
  newDriverPlanCommandId:()=>`command${puts}`,fuelReferenceOutbox:new Map(),diagnosticLog:()=>{},flushFuelReferenceOutbox:()=>{}};
ctx.globalThis=ctx;vm.createContext(ctx);
vm.runInContext(['stableTextHash','personalFuelReferenceEvidence','queueFuelReferenceRequest'].map(grab).join('\n'),ctx);
const row=(n,extra={})=>({raceRecordId:'id'+n,race_instance_id:'past'+n,sessionNum:0,custId:42,userId:'u',car:'GT3',track:'monza',
  recordedAt:new Date(Date.now()-n*1000).toISOString(),avgFuelPerLap:3.7,avgLap:115,totalLaps:10,...extra});
rows=Array.from({length:501},(_,i)=>row(i));
const evidence=ctx.personalFuelReferenceEvidence(current);assert.equal(evidence.records.length,500);assert.equal(rows.length,501);
assert(!evidence.records.some(r=>r.race_instance_id==='past500'));
const version=evidence.version;rows.push(row(1000));assert.equal(ctx.personalFuelReferenceEvidence(current).version,version);
rows.push(row(0,{race_instance_id:'current'}),row(0,{race_instance_id:'other-user',userId:'foreign'}));
assert.equal(ctx.personalFuelReferenceEvidence(current).version,version);
assert(ctx.queueFuelReferenceRequest());assert.equal(puts,1);
rows=rows.filter(r=>r.race_instance_id!=='past0');assert.notEqual(ctx.personalFuelReferenceEvidence(current).version,version);
rows=Array.from({length:501},(_,i)=>row(i,{raceRecordId:'x'.repeat(512),fuelSampleBasis:'x'.repeat(512),date:'x'.repeat(512)}));
assert(new TextEncoder().encode(JSON.stringify(ctx.personalFuelReferenceEvidence(current).records)).length<480000);
assert(ctx.queueFuelReferenceRequest());assert.equal(puts,2);
rows=[row(0,{car:'x'.repeat(513)})];assert.equal(ctx.queueFuelReferenceRequest(),null);assert.equal(puts,2);
// A publication of the committed active record ends send authority, but the
// already-sent response receipt must survive until the matching ACK arrives.
let active={identity:'scope',bridge_process_epoch:'epoch',decision_id:'decision',revision:1};
let sends=0,spoken=[];
Object.assign(ctx,{strategyResponseOutbox:new Map(),bridgeStrategyDecisions:new Map(),
  strategyProjection:{binding:({kind}={kind:'active'})=>kind==='active'?active:null},irBridge:{readyState:1,send:()=>sends++},
  isJapaneseEngineer:()=>true,addMsg:()=>{},pushMsg:()=>{},speak:(msg,opts)=>spoken.push({msg,opts}),
  SPEAK_PRIO:{P2_PROCEDURE:2}});
const referenceVersion=ctx.personalFuelReferenceEvidence(current).version;
current.lifecycle={active:{decision_id:'decision',phase:'active',target_lap:3,set_fuel_l:24,
  provisional_history:{contract:'provisional_history_v1',command_id:'cmd',evidence_version:referenceVersion}}};
ctx.canonicalLifecycleCache.epochMatches=m=>m.bridge_process_epoch==='epoch';
vm.runInContext(['strategyResponseKey','referenceResponseReceiptPending','currentProposalResponseBinding','flushStrategyResponseOutbox','handleStrategyDecisionAck'].map(grab).join('\n'),ctx);
function entry(){return {decisionId:'decision',dispatchId:'decision#1',sessionNum:0,sentAt:1,metadataExpiresAt:1000,
  accepted:true,binding:{identity:'scope',bridge_process_epoch:'epoch',decision_id:'decision',revision:0},
  reference:{contract:'provisional_history_v1',command_id:'cmd',evidence_version:referenceVersion}};}
const ack={decision_id:'decision',dispatch_id:'decision#1',session_num:0,bridge_process_epoch:'epoch',outcome:'accepted'};
ctx.strategyResponseOutbox.set('0|decision#1',entry());ctx.flushStrategyResponseOutbox();assert.equal(sends,0);assert.equal(ctx.strategyResponseOutbox.size,1);
ctx.handleStrategyDecisionAck({...ack,dispatch_id:'old'});assert.equal(spoken.length,0);assert.equal(ctx.strategyResponseOutbox.size,1);
ctx.handleStrategyDecisionAck(ack);assert.equal(spoken.length,1);assert.match(spoken[0].msg,/3周目.*24L.*確認/);
ctx.handleStrategyDecisionAck(ack);assert.equal(spoken.length,1);
ctx.strategyResponseOutbox.set('0|decision#1',entry());active={...active,identity:'other'};
ctx.flushStrategyResponseOutbox();assert.equal(ctx.strategyResponseOutbox.size,0);ctx.handleStrategyDecisionAck(ack);assert.equal(spoken.length,1);
console.log('history Renderer: bounded past cohort/version, journal prevalidation, sent receipt/ACK and scope negatives PASS');

vm.runInContext(grab('hasTelemetryOwnedVehicleClaim'),ctx);
assert(!ctx.hasTelemetryOwnedVehicleClaim('前回は3周目、実補給24Lだった。',true));
assert(ctx.hasTelemetryOwnedVehicleClaim('前回は3周目、実補給24Lだった。現在5Lある。',true));
assert(ctx.hasTelemetryOwnedVehicleClaim('Last race we added 24 L. Position is P3.',true));
assert(!ctx.hasTelemetryOwnedVehicleClaim('Last race we added 24 L.',true));
assert(ctx.hasTelemetryOwnedVehicleClaim('燃料は5Lある。',true));
// Execute the actual history BOX proof validator with current measured pace.
{
 const source=fs.readFileSync('desktop/box-authority-transport.js','utf8');
 const ctx={};vm.createContext(ctx);
 vm.runInContext('const integer=v=>Number.isInteger(v)&&v>=0;const finite=v=>typeof v==="number"&&Number.isFinite(v);const text=v=>typeof v==="string"&&v.length>0;'+source.slice(source.indexOf('function provisionalFuelValid('),source.indexOf('function fuelValid('))+';globalThis.validate=provisionalFuelValid;',ctx);
 const ref={contract:'provisional_history_v1',process_epoch:'epoch',command_id:'cmd',evidence_version:'v',identity:{cust_id:42,car_model:'GT3',track:'Monza'},evidence:{rate_l_per_lap:3.7,pace_s:115,record_ids:['old'],record_count:1}};
 const p={race_instance_id:'race',session_num:0,issued_source_frame:10,issued_session_time:100,driver_pit_sequence:0,target_lap:4,set_fuel_l:24,
  validity_contract:{ttl_seconds:5,window:'same_target_lap'},validation:{available:true,geometry_contract:'provisional_history_running_lap',target_lap:4,target_in_laps:0,set_fuel_l:24},
  fuel_inputs:{cust_id:42,car_model:'GT3',track:'Monza',provisional_history:ref,finish_kind:ref.contract,process_epoch:'epoch',race_instance_id:'race',session_num:0,source_frame_sequence:10,session_time_s:100,driver_pit_sequence:0,current_lap:4,crossings_to_finish:11,max_set_fuel_l:100,
   time_remaining_s:1140,configured_duration_s:1140,race_format:'timed',lap_dist_pct:0,fuel_level_l:19,avg_fuel_per_lap_l:3.7,reserve_l:2,effective_capacity_l:100,black_flag:'false',on_track:true,on_pit_road:false,telemetry_available:true,source_available:true,
   planning_pace_s:115,current_measured_pace_s:null,current_measured_pace_samples:0}};
 assert(ctx.validate(p));p.fuel_inputs.current_measured_pace_s=90;p.fuel_inputs.current_measured_pace_samples=1;
 assert(!ctx.validate(p));p.fuel_inputs.planning_pace_s=90;p.fuel_inputs.crossings_to_finish=14;
 assert(!ctx.validate(p));p.set_fuel_l=35;p.validation.set_fuel_l=35;assert(ctx.validate(p));
 p.fuel_inputs.effective_capacity_l=35;p.fuel_inputs.max_set_fuel_l=35;assert(!ctx.validate(p));
 p.fuel_inputs.effective_capacity_l=100;p.fuel_inputs.max_set_fuel_l=100;
 p.fuel_inputs.planning_pace_s=115;p.fuel_inputs.current_measured_pace_s=130;p.fuel_inputs.crossings_to_finish=11;assert(ctx.validate(p));
 p.fuel_inputs.planning_pace_s=130;assert(!ctx.validate(p));
 console.log('history proof measured pace/frozen quantity/capacity contract PASS');
}
