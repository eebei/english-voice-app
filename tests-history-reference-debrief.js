'use strict';
const assert=require('assert');
const M=require('./desktop/debrief-outcome');
const ref={contract:'provisional_history_v1',command_id:'cmd',evidence_version:'version',source_snapshot_id:'epoch:2',
  rate_l_per_lap:3.7,pace_s:115,planning_pace_s:90,record_count:2,record_ids:['old1|0','old2|0'],record_ids_truncated:false,
  predicted_add_fuel_l:23.7,set_fuel_l:24};
const pit={schema_version:1,pit_event_id:'pit1',race_instance_id:'race1',session_num:0,driver_pit_sequence:1,
  entry_lap:3,execution_relation:'normal',service:{fuel_added_l:23.4},
  plan_reference:{decision_id:'decision1',selected_plan:'A',target_lap:3}};
const plan={decision_id:'decision1',race_instance_id:'race1',session_num:0,revision:2,selected_plan:'A',target_lap:3,
  phase:'executed',reason:'normal',terminal_pit_event_id:'pit1',execution_relation:'normal',resolved_pit_sequence:1,
  add_fuel_l:23.7,set_fuel_l:24,provisional_history:ref};
const summary={race_instance_id:'race1',session_num:0,pit_events:[pit],plan_outcomes:{available:true,records:[plan]}};
const out=M.fromSummary(summary),stored=M.storable(out),read=M.revalidate(JSON.parse(JSON.stringify(stored)));
assert.deepEqual(read.plans[0].provisional_history,ref);
assert.equal(read.plans[0].set_fuel_l,24);assert.equal(read.pits[0].fuel_added_l,23.4);
assert.match(M.lines(read,[],[],'ja').join('\n'),/履歴2件.*3.70L\/周.*予測追加23.7L.*設定24L.*実補給23.4L.*decision=decision1.*old1\|0/);
const record={owner_ref:'user:u',created_at:new Date().toISOString(),race_outcome:stored};
assert.match(M.historicalLine(record,{race_instance_id:'race2'},'user:u',Date.now(),'ja',[]),/実補給23.4L/);
assert.equal(M.historicalLine(record,{race_instance_id:'race2'},'user:other',Date.now(),'ja',[]),'');
assert(!M.historicalLine(record,{race_instance_id:'race2'},'user:u',Date.now(),'ja',[{decision_id:'decision1',status:'deleted'}]).includes('履歴2件'));
for(const bad of [{rate_l_per_lap:NaN},{record_ids:['foreign'],record_count:2},{command_id:''},{set_fuel_l:null},{pace_s:0},{planning_pace_s:130},{planning_pace_s:NaN},{record_ids:['x','x']},{contract:'unknown'}]){
  const s=JSON.parse(JSON.stringify(summary));s.plan_outcomes.records[0].provisional_history={...ref,...bad};
  assert.equal(M.fromSummary(s).plans[0].provisional_history,null);
}
const foreign=JSON.parse(JSON.stringify(summary));foreign.pit_events[0].plan_reference.decision_id='other';
assert(!M.lines(M.fromSummary(foreign),[],[],'ja').join('\n').includes('実補給23.4L'));
const correction={kind:'pit_relation',race_instance_id:'race1',session_num:0,pit_event_id:'pit1',entry_lap:3,
  canonical_relation:'normal',driver_claim:'not_planned',status:'driver_disputed',note:'予定どおりではなかった',at:new Date().toISOString()};
assert.match(M.lines(read,[correction],[],'ja').join('\n'),/Driver訂正/);
console.log('history reference debrief: subset, persistence, actual service, next race and negative boundaries PASS');
