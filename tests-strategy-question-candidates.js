'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const R=require('./desktop/local-intent-router'),P=require('./desktop/strategy-state-projection');
const {fixture}=require('./tests-canonical-lifecycle');
let checks=0;const check=(x,m)=>{assert(x,m);checks++;};
const live={lap:12,fuel:18,session_time_remaining_s:995,gap_ahead:4.2,gap_behind:8,player_class_position:16,leaders:{player_class:{gap_s:61.7}}};
const route=(text,extra={})=>R.route({text,lang:'ja',live,...extra});
for(const text of ['何週目に入ると順位アップできる？ピットインには？','あと、何週でピットに入ったら順位が上がる。','順位を上げるならいつピット？']){
 const r=route(text);check(r.intent==='strategy_consultation_unavailable'&&!/残り16分|首位/.test(r.reply),text);check(!r.action?.type,text+' no operation');
}
for(const text of ['ピットのロスタイム何秒ぐらいで計算できる？','俺がピットインして何秒ぐらいロスすると思いますか？次のピット給油で。'])check(route(text).intent==='pit_loss_estimate',text);
check(route('アンダーカットとかオーバーカットって知ってる？君',{live:null}).intent==='strategy_definition','concept does not need telemetry');
check(route('今何位？').reply.includes('P16'),'current class position');
check(route('前と何秒？').intent==='nearest_gap','nearest not leader');
check(R.matchQuestionCandidate('前回のオーバーカットはどうだった？')===null,'past query stays past');
for(const text of ['アンダーカットしないで','オーバーカットをキャンセル。']){const r=route(text);check(r.intent==='strategy_request_clarification'&&!r.action?.type,'preference is not execution cancellation');}
check(R.classifyDriverIntent('ピットキャンセル。').kind==='command','execution parser preserved');
check(R.classifyDriverIntent('ピットキャンセルはしない。').kind==='negated','negation preserved');
for(const q of R.QUESTION_CANDIDATES){check(route(q.question).handled,'catalog primary '+q.id);for(const text of q.examples)check(route(text).handled,'catalog example '+text);}
check(R.matchQuestionCandidate('通常ピット、アンダーカット、オーバーカットで順位を上げるならどれ？').plan==='recommendation','all three compared');
const comparison={available:true,reason:'position_gain',selected_plan:'B',score_basis:'physical_rejoin_class_position',prediction_role:'predicted_at_each_candidate_exit_not_finish_or_cycle',common_horizon_elapsed_s:500,gain_kind:'same_horizon_constant_pace_model',race_instance_id:'r',session_num:1,source_frame_sequence:10,generated_at_session_s:100,valid_for_s:10,snapshot_id:'current',ranked_candidates:[{plan_id:'A',target_lap:15,expected_class_position:20},{plan_id:'B',target_lap:14,expected_class_position:18,eligible_for_recommendation:true,gain_vs_baseline:2}],unavailable_candidates:[{plan_id:'C',reason:'conditions_unproven'}]};
let clock=0,s=fixture();s.continuity.stable_scope={race_instance_id:'r',session_num:1,driver_id:10101};s.continuity.durable_commit=true;
s.recommendations.strategy_options={value:{available:true,position_comparison:comparison},calculation_source:{session_time_s:90,source_frame_sequence:9,race_instance_id:'r',session_num:1}};
const projection=P.create({canonical:{current:()=>s},now:()=>clock});
const ask=text=>route(text,{strategy:{state:projection.state(),api:projection.api},strategyEvaluation:{playbook:{},api:{evaluateStrategies:()=>projection.strategyEvaluation()}}});
let r=ask(R.QUESTION_CANDIDATES.find(x=>x.id==='compare').question);
check(r.intent==='strategy_position_comparison'&&r.reply.includes('P18予測')&&r.reply.includes('アンダーカットを優先'),'data-room ranking spoken');
check(r.reply.includes('最終順位の予測ではない')&&r.reply.includes('確定していない'),'prediction and execution roles preserved');
check(!r.action?.type&&projection.state().active.selected_plan==='A','recommendation never changes active plan');
const binding=projection.binding('strategy_comparison');check(projection.validBinding(binding),'fresh comparison speech binding');
s=JSON.parse(JSON.stringify(s));s.source_frame.session_time_s=103;s.source_frame.sequence=11;s.recommendations.strategy_options.value.position_comparison.generated_at_session_s=103;s.recommendations.strategy_options.value.position_comparison.source_frame_sequence=11;
s.recommendations.strategy_options.value.position_comparison.common_horizon_elapsed_s=497;
check(projection.validBinding(binding),'same result polling does not silence speech');
s.recommendations.strategy_options.value.position_comparison.plan_c_evidence={required_fuel_per_lap_l:2.851};
check(projection.validBinding(binding),'unspoken exact fuel evidence does not cut the same forecast');
s.recommendations.strategy_options.value.position_comparison.ranked_candidates[1].eligible_for_recommendation=false;
check(!projection.validBinding(binding),'changed feasibility invalidates the recommendation');
s.recommendations.strategy_options.value.position_comparison.ranked_candidates[1].eligible_for_recommendation=true;
s.recommendations.strategy_options.value.position_comparison.ranked_candidates[1].expected_class_position=22;
check(!projection.validBinding(binding),'changed prediction invalidates speech');
s.recommendations.strategy_options.value.position_comparison.generated_at_session_s=80;
r=ask('アンダーカットで順位を上げられる？');check(!r.reply.includes('P22')&&r.confidence==='unavailable','stale comparison no numeric forecast');
s.recommendations.strategy_options.value.position_comparison.generated_at_session_s=103;s.recommendations.strategy_options.value.position_comparison.session_num=2;
check(ask('アンダーカットで順位を上げられる？').confidence==='unavailable','foreign comparison rejected');
s.recommendations.strategy_options.value.position_comparison.session_num=1;s.recommendations.strategy_options.value.position_comparison.ranked_candidates=[];s.recommendations.strategy_options.value.position_comparison.available=false;
check(ask('通常ピットの作戦を教えて。').bindingKind==='strategy_explanation','missing forecast explanation survives ordinary data refresh');
s.recommendations.strategy_options.value.position_comparison.unavailable_candidates=['A','B','C'].map(plan_id=>({plan_id,reason:'calibration_geometry_unavailable'}));
check(ask('通常ピットの作戦を教えて。').reply.includes('ピット入口・出口の実測位置が未確認'),'invalid persisted calibration explained without guessing');
const missingBinding=projection.binding('strategy_explanation');clock=8000;check(projection.validBinding(missingBinding),'same unavailable explanation can finish after five seconds with a live cache');
s.recommendations.strategy_options.value.position_comparison.available=true;s.recommendations.strategy_options.value.position_comparison.ranked_candidates=[{plan_id:'A',target_lap:15,expected_class_position:20}];
check(!projection.validBinding(missingBinding),'new available forecast invalidates the old unavailable explanation');
// Run the actual Renderer UI function: a suggestion fills the composer and
// never sends a request or an operation on behalf of the Driver.
const html=fs.readFileSync('./desktop/renderer.html','utf8');const fn=html.match(/function renderRaceQuestionCandidates\([^]*?\n\}/)[0];
const input={value:'',focus(){this.focused=true;}},host={children:[],replaceChildren(){this.children=[];},appendChild(b){this.children.push(b);}};
const context={window:{PitwallLocalIntentRouter:R},document:{getElementById:id=>id==='chat-input'?input:host,createElement:()=>({})},autoResize(){}};
vm.runInNewContext(fn+';renderRaceQuestionCandidates();',context);check(host.children.length===8,'all catalog questions visible');
host.children[6].onclick();check(input.value.includes('通常ピット、アンダーカット、オーバーカット')&&input.focused,'click fills real comparison question');
console.log('Strategy question candidates '+checks+' checks PASS; no paid APIs');
