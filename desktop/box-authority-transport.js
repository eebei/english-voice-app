/* WO-008: BOX authority is independent of proposal delivery. */
(function(root){
'use strict';
const TTL_MS=5000;
const refs=['bridge_process_epoch','canonical_snapshot_id','canonical_snapshot_sequence'];
const bindings=[...refs,'attempt_id','proof_id','race_instance_id','session_num','decision_id','plan_revision','activation_frame','driver_pit_sequence','dispatch_sequence'];
// WO015: utterance_id/text_hash are not identity BINDINGS (Bridge's
// apply_report() does not gate attempt/report matching on them), but the
// owner ACK readback must still prove the Bridge echoed back the SAME
// metadata it received -- a scalar outcome/time match alone cannot catch a
// mismatched or dropped utterance_id/text_hash.
const metadataKeys=['utterance_id','text_hash'];
const integer=v=>typeof v==='number'&&Number.isInteger(v)&&v>=0;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const text=v=>typeof v==='string'&&v.length>0;
const copy=v=>JSON.parse(JSON.stringify(v));
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function fuelValid(p){
 const f=p.fuel_inputs,v=p.validity_contract,b=p.validation;
 return f&&v&&b&&b.available===true&&b.geometry_contract==='coupled_current_running_lap'
  &&b.target_lap===p.target_lap&&b.target_in_laps===0&&b.set_fuel_l===p.set_fuel_l
  &&v.ttl_seconds===5&&v.window==='same_target_lap'
  &&f.schema_version===1&&f.finish_kind==='lap_race'&&f.multi_stop===false
  &&['source_frame_sequence','current_lap','total_laps','crossings_to_finish','clean_laps_sampled','max_set_fuel_l'].every(k=>integer(f[k]))
  &&['session_time_s','lap_dist_pct','fuel_level_l','avg_fuel_per_lap_l','reserve_l','effective_capacity_l'].every(k=>finite(f[k]))
  &&f.race_instance_id===p.race_instance_id&&f.session_num===p.session_num
  &&f.source_frame_sequence===p.issued_source_frame&&f.session_time_s===p.issued_session_time
  &&f.driver_pit_sequence===p.driver_pit_sequence&&f.current_lap===p.target_lap&&f.current_lap>0&&f.total_laps<3000
  &&f.crossings_to_finish===f.total_laps-f.current_lap+1&&f.crossings_to_finish>0
  &&f.lap_dist_pct>=0&&f.lap_dist_pct<=1&&f.clean_laps_sampled>=3
  &&f.avg_fuel_per_lap_l>0&&f.reserve_l>=0&&f.effective_capacity_l>0&&f.fuel_level_l>=0&&f.fuel_level_l<=f.effective_capacity_l
  &&p.set_fuel_l<=f.max_set_fuel_l&&f.max_set_fuel_l<=Math.floor(f.effective_capacity_l)
  &&f.fuel_level_l-f.avg_fuel_per_lap_l*(1-f.lap_dist_pct)>=f.reserve_l
  &&f.avg_fuel_per_lap_l*(f.crossings_to_finish-f.lap_dist_pct)+f.reserve_l<=f.effective_capacity_l
  &&f.fuel_level_l+p.set_fuel_l>=f.avg_fuel_per_lap_l*(f.crossings_to_finish-f.lap_dist_pct)+f.reserve_l;
}
function create(opts){
 const now=opts.now, attempts=new Map(), outbox=new Map(), snapshots=new Map(), proofReceipts=new Map(); let snapshot=null, connected=false, latestFrame=-1, latestPublication=-1, epoch=null;
 // WO015 (independent review "BOX owner receipt frozen body/source/role/
 // firstconfirmedtime retention/getter after real ACK SAME VM, not trace
 // getter alone"): bodyReceipts captures text/kind/role/scope the moment
 // report() builds the wire entry (zero eviction risk -- never re-derived
 // later from a bounded trace that may have evicted it by the time a
 // delayed ACK arrives). receipts is the frozen post-ACK retention,
 // bounded the same way strategyDeliveryReceipts is. NEITHER is ever sent
 // over the wire -- `r` (the actual wire payload below) stays minimal
 // utterance_id/text_hash only, unchanged.
 const bodyReceipts=new Map(), receipts=new Map();
 if(opts.journal)for(const e of opts.journal.entries('box_delivery_report'))outbox.set(e.payload.bridge_process_epoch+'|'+e.payload.report_event_id,copy(e.payload));
 const retries=new Map();
 const attemptKey=a=>epoch+'|'+a.attempt_id;
 const scope=s=>s.race_instance_id+'|'+s.session_num;
 function flush(){if(!connected||opts.journal&&!opts.journal.healthy()||!opts.canonical?.current())return;for(const r of outbox.values()){
 const k=r.bridge_process_epoch+'|'+r.report_event_id, retry=retries.get(k)||{count:0,next:0};if(retry.count>=5){if(!retry.logged){opts.diagnostic?.('report_pending_unknown retry batch exhausted '+r.report_event_id);retry.logged=true;}continue;}if(now()<retry.next)continue;
 const wire=r.bridge_process_epoch===epoch?copy(r):{cmd:'historical_settlement',kind:'box_delivery_report',payload:copy(r)};
 try{opts.send(wire);retry.count++;retry.next=now()+Math.min(30000,1000*2**(retry.count-1));retries.set(k,retry);}catch(_){return;}}}

 function report(entry,outcome){
  if(entry.outcomes.has(outcome))return;
  entry.outcomes.add(outcome);
  // WO015: utterance_id/text_hash are renderer-supplied trace identity (see
  // attachUtterance), not part of BINDINGS -- apply_report() does not gate
  // attempt/report identity matching on them -- but they ARE validated,
  // echoed back on the ack, and persisted by apply_report()/durable_recovery
  // now, and ack()/historicalAck() below require the readback to match.
  const r={cmd:'box_delivery_report',...copy(entry.refs),...copy(entry.attempt),report_event_id:entry.attempt.attempt_id+':'+outcome,outcome,
   utterance_id:(entry.utterance&&entry.utterance.utterance_id)||null,
   text_hash:(entry.utterance&&entry.utterance.text_hash)||null};
  if(opts.journal&&!opts.journal.put('box_delivery_report',r)){revoke();return;}
  outbox.set(r.bridge_process_epoch+'|'+r.report_event_id,r);
  // Renderer-only body/role/scope retention, captured now (same moment the
  // wire-minimal `r` above is built) so a later delayed ACK's receipt
  // lookup never depends on the bounded utteranceTrace still holding this
  // uid. Metadata-less attempts (no attachUtterance call) get no entry
  // here -- honest unknown, never fabricated.
  if(entry.utterance){
   // ★独立root audit「BOX SOURCE PACKET missing」修復：text/kind/role/scope
   // （primitiveなlookup補助値）だけでなく、実speak()が使ったのと同じ
   // 凍結source packet（refs=publication/epoch、proof=proof_id/validity_
   // contract/plan identity、attempt=attempt_id/dispatch_sequence）も
   // そのまま保持する——ACK到達時にlive canonicalから再構築しない。
   bodyReceipts.set(r.bridge_process_epoch+'|'+r.report_event_id,freeze({
    utterance_id:entry.utterance.utterance_id,text_hash:entry.utterance.text_hash,
    text:entry.utterance.text||null,kind:entry.utterance.kind||null,
    role:entry.utterance.role||null,scope:entry.utterance.scope||null,
    source:entry.utterance.source||null}));
  }
  flush();
 }
 // WO015反例修復：以前はaccept()が返すattempt/proofだけがBridgeへ伝わり、
 // 実際にspeak()へ渡った凍結utterance_id/textHashは一切報告に乗らなかった
 // （出力からsourceへ逆追跡できなかった）。呼出し元がspeak()前に一度だけ
 // 紐付けられるようにする（一度結んだら上書きしない＝同じ本文の別attemptへ
 // 後から取り違えない）。
 function attachUtterance(attemptId,meta){
  const e=attempts.get(epoch+'|'+attemptId);
  if(!e||e.utterance)return false;
  // WO015残条件「BOX owner receipt body/role/scope retention」：既存の
  // utterance_id/text_hashと同じ契約へtext/kind/roleも追加する（呼出し元が
  // 既に手元で確定済みの値をそのまま転記するだけ、新しい発明は無い）。
  // ★独立root audit「BOX SOURCE PACKET missing」修復：呼出し元（speak()と
  // 同じ時点のhandleStrategyPlanBoxCall）が既に手元で確定済みのEXACT
  // source packet（refs/proof/attempt、speak()自身が使ったのと同一の
  // 凍結値）をsourceとして受け取り、新しいcanonical参照の発明はしない。
  e.utterance=freeze({utterance_id:(meta&&meta.utterance_id)||null,text_hash:(meta&&meta.text_hash)||null,
   text:(meta&&meta.text)||null,kind:(meta&&meta.kind)||null,role:(meta&&meta.role)||null,
   scope:(meta&&meta.scope)||null,source:(meta&&meta.source)||null});
  return true;
 }
 function valid(entry){
  const p=entry.proof,a=entry.attempt,s=snapshot,c=opts.canonical?.current();
  return (!opts.journal||opts.journal.healthy())&&connected&&c&&c.execution.allowed===true&&c.lifecycle.active?.decision_id===p.decision_id&&c.lifecycle.active?.revision===p.plan_revision&&c.box_delivery.allowed_proof_id===p.proof_id&&c.box_delivery.allowed_attempt_id===a.attempt_id&&s&&s.bridge_process_epoch===epoch&&entry.refs.bridge_process_epoch===epoch&&now()-s.receivedAt<TTL_MS&&now()-entry.receivedAt<TTL_MS
   &&s.race_instance_id===p.race_instance_id&&s.session_num===p.session_num
   &&s.active_decision_id===p.decision_id&&s.active_phase==='active'
   &&s.plan_revision===p.plan_revision&&s.activation_frame===p.activation_frame
   &&s.driver_pit_sequence===p.driver_pit_sequence&&s.current_lap===p.target_lap
   &&s.source_frame_sequence>=p.issued_source_frame&&s.session_time_s>=p.issued_session_time
   &&s.session_time_s<p.issued_session_time+5&&s.session_time_s<s.valid_until_session_s
   &&s.execution_gate===null&&s.closed===false&&s.collision===false
   &&s.allowed_proof_id===p.proof_id&&s.allowed_attempt_id===a.attempt_id;
 }
 function revoke(){for(const e of attempts.values()){if(!valid(e)&&!e.revoked){e.revoked=true;opts.revoke(e.attempt.attempt_id);}}}
 function receiveSnapshot(s){
  const current=opts.canonical?.current();
  if(s&&current&&(s.bridge_process_epoch!==current.bridge_process_epoch||integer(s.canonical_snapshot_sequence)&&s.canonical_snapshot_sequence<current.snapshot_sequence))return false;
  if(!opts.canonical||!opts.canonical.matches(s)){snapshot=null;revoke();return false;}
  const canonical=opts.canonical.current(), active=canonical.lifecycle.active;
  if(s.race_instance_id!==canonical.race_instance_id||s.session_num!==canonical.session_num||s.source_frame_sequence!==canonical.source_frame.sequence||s.session_time_s!==canonical.source_frame.session_time_s||s.closed!==canonical.execution.scope_closed||s.collision!==canonical.execution.collision||s.execution_gate!==(canonical.execution.allowed?(canonical.execution.box_verdict_reason??canonical.execution.gate_reason):(canonical.execution.gate_reason||'execution_unavailable'))||s.active_phase!==(active&&active.phase)||s.activation_frame!==(active&&active.activated_source_frame_sequence)||s.active_decision_id!==(active&&active.decision_id)||s.plan_revision!==(active&&active.revision)||s.driver_pit_sequence!==canonical.race_facts.driver_pit_sequence||s.current_lap!==canonical.current_facts.current_lap||s.allowed_proof_id!==canonical.box_delivery.allowed_proof_id||s.allowed_attempt_id!==canonical.box_delivery.allowed_attempt_id){snapshot=null;revoke();return false;}
  if(!s||!text(s.race_instance_id)||!integer(s.session_num)||!integer(s.source_frame_sequence)||!finite(s.session_time_s))return false;
  if(s.source_frame_sequence<latestFrame){snapshot=null;revoke();return false;}
  if(s.canonical_snapshot_sequence<latestPublication)return false;
  if(s.source_frame_sequence===latestFrame&&snapshot&&scope(s)!==scope(snapshot)){snapshot=null;revoke();return false;}
  const old=snapshots.get(scope(s));
  if(old&&(s.source_frame_sequence<old.source_frame_sequence||s.session_time_s<old.session_time_s)){snapshot=null;revoke();return false;}
  // Equal-frame retransmission must not extend heartbeat freshness or change authority.
  if(old&&s.canonical_snapshot_sequence===old.canonical_snapshot_sequence){
   const previous=copy(old);delete previous.receivedAt;
   if(globalThis.PitwallCanonicalLifecycleCache.stable(previous)!==globalThis.PitwallCanonicalLifecycleCache.stable(s)){snapshot=null;revoke();}
   return false;
  }
  latestFrame=s.source_frame_sequence;latestPublication=s.canonical_snapshot_sequence;
  snapshot={...copy(s),receivedAt:now()};snapshots.set(scope(s),snapshot);revoke();return true;
 }
 function accept(data){
  const p=data&&data.authority_proof,a=data&&data.box_attempt;
  if(!opts.canonical||!opts.canonical.matches(data)||!snapshot||!refs.every(k=>snapshot[k]===data[k]))return null;
  if(!p||!a||p.schema_version!==1||!text(p.proof_id)||!text(p.race_instance_id)||!text(p.decision_id)
   ||!['session_num','plan_revision','activation_frame','issued_source_frame','driver_pit_sequence','expected_pit_sequence','target_lap'].every(k=>integer(p[k]))
   ||!finite(p.issued_session_time)||!finite(p.add_fuel_l)||p.add_fuel_l<0||!integer(p.set_fuel_l)
   ||!['A','B','C'].includes(p.selected_plan)||!fuelValid(p)
   ||p.activation_frame>p.issued_source_frame||p.expected_pit_sequence!==p.driver_pit_sequence+1||!text(a.attempt_id)||!integer(a.dispatch_sequence)
   ||!['proof_id','race_instance_id','session_num','decision_id','plan_revision','activation_frame','driver_pit_sequence'].every(k=>a[k]===p[k]))return null;
  const active=opts.canonical.current()?.lifecycle.active;
  if(!active||p.selected_plan!==active.selected_plan||p.target_lap!==active.target_lap||p.add_fuel_l!==active.add_fuel_l||p.set_fuel_l!==active.set_fuel_l)return null;
  if(attempts.has(attemptKey(a))||opts.journal?.hasAttempt(epoch,a.attempt_id))return null;
  if(opts.journal&&!opts.journal.attempt({...Object.fromEntries(refs.map(k=>[k,data[k]])),attempt:copy(a),potentially_started:true})){revoke();return null;}
  if(!proofReceipts.has(p.proof_id))proofReceipts.set(p.proof_id,now());
  const e={refs:freeze(Object.fromEntries(refs.map(k=>[k,data[k]]))),proof:freeze(copy(p)),attempt:freeze(copy(a)),receivedAt:proofReceipts.get(p.proof_id),outcomes:new Set(),revoked:false};attempts.set(attemptKey(a),e);
  if(!valid(e)){report(e,'dropped_before_audible');return null;}
  // WO015残source修復：以前はaccept()がe.refs（bridge_process_epoch/
  // canonical_snapshot_id/canonical_snapshot_sequence）を返り値へ乗せて
  // いなかったため、呼出し元はdelivery.proofのdecision識別子しか使えず、
  // この配送がどのcanonical snapshotから出たかをsource側へ転記できな
  // かった。既にentry.refsとして保持済みの同一値を読み取り専用で渡す
  // だけで、新しい識別子・新しい検証は増やさない。
  return {proof:e.proof,attempt:e.attempt,refs:e.refs,precheck:()=>!e.revoked&&valid(e),
   onSpoken:()=>report(e,'audible_started'),onAudibleInterrupted:()=>report(e,'audible_interrupted'),
   // WO015: 'completed' is confirmatory evidence that a 'spoken' (started)
   // delivery also ran to a normal end. It is a distinct, additional report,
   // never a substitute for or downgrade of the existing audible_started fact.
   onDelivery:outcome=>{if(outcome==='spoken')report(e,'audible_started');else if(outcome==='completed')report(e,'audible_completed');else if(outcome==='audible_interrupted')report(e,outcome);else report(e,outcome==='suppressed_by_user'?outcome:'dropped_before_audible');},
   drop:()=>report(e,'dropped_before_audible')};
 }
 // WO015残条件「BOX owner receipt frozen body/source/role/firstconfirmedtime
 // retention/getter after real ACK SAME VM」：ack()/historicalAck()が
 // outboxから削除する直前、同じkeyでreceiptsへ確定事実を1回だけ freeze
 // する（genuine重複exact ACKはfirstConfirmedAtを上書きしない——既存
 // strategyDeliveryReceiptsと同じ規律）。bodyReceiptsに無い（attachUtterance
 // を一度も呼ばなかった本当のmetadata-less attempt）ならtext/kind/role/
 // scopeはhonestにnullのまま——存在しないsourceを発明しない。
 function _retainReceipt(key,r,applied){
  if(receipts.has(key))return;
  const body=bodyReceipts.get(key)||null;
  receipts.set(key,freeze({utterance_id:r.utterance_id,text_hash:r.text_hash,outcome:r.outcome,applied,
   text:body?body.text:null,kind:body?body.kind:null,role:body?body.role:null,scope:body?body.scope:null,
   source:body?body.source:null,
   firstConfirmedAt:now()}));
  if(receipts.size>50){const oldest=receipts.keys().next().value;receipts.delete(oldest);}
  // ★独立root audit「NEW MEMORY LEAK」修復：bodyReceiptsはreport()ごとに
  // .setされるが、従来.delete/.clearが一切無く無期限に増え続けていた
  // （receiptsの上限50はbodyReceiptsを束縛しない、別Map）。このpending
  // bodyはreceiptsへ確定転記した直後（実ACK成功後、ここだけ）で退役する
  // ——ACK前の早期損失ではなく、重複ACKで二重に退役することもない
  // （上のreceipts.has(key)早期returnにより、この行へは一度しか到達しない）。
  bodyReceipts.delete(key);
 }
 function ack(a){const key=a&&(a.bridge_process_epoch+'|'+a.report_event_id);const r=a&&outbox.get(key);if(!r||a.bridge_process_epoch!==epoch||!['applied','retry_no_op'].includes(a.applied)||a.outcome!==r.outcome||!bindings.every(k=>a[k]===r[k])||!metadataKeys.every(k=>a[k]===r[k]))return false;if(opts.journal&&!opts.journal.retire('box_delivery_report',r,a)){revoke();return false;}_retainReceipt(key,r,a.applied);outbox.delete(key);return true;}
 function historicalAck(a){const key=a&&a.payload&&(a.payload.bridge_process_epoch+'|'+a.payload.report_event_id);const r=a&&a.payload&&outbox.get(key);if(!r||a.kind!=='box_delivery_report'||a.historical_only!==true||a.current_bridge_process_epoch!==epoch||r.bridge_process_epoch===epoch||!['applied','retry_no_op'].includes(a.applied)||globalThis.PitwallCanonicalLifecycleCache.stable(a.payload)!==globalThis.PitwallCanonicalLifecycleCache.stable(r)||a.outcome!==r.outcome||!bindings.every(k=>a[k]===r[k])||!metadataKeys.every(k=>a[k]===r[k]))return false;if(opts.journal&&!opts.journal.retire('box_delivery_report',r,a)){revoke();return false;}_retainReceipt(key,r,a.applied);outbox.delete(key);return true;}
 function receiptFor(bridgeProcessEpoch,reportEventId){return receipts.get(bridgeProcessEpoch+'|'+reportEventId)||null;}
 function setEpoch(v){if(epoch!==v){epoch=v;snapshot=null;latestFrame=-1;latestPublication=-1;snapshots.clear();proofReceipts.clear();revoke();}}
 // bodyReceiptsは既存のoutbox/attemptsと同じ理由で生のMapとして公開する
 // （test専用の新規診断APIではない——既存の2つと同じ露出パターンを
 // pending body retentionの直接source auditにも揃えるだけ）。
 return {receiveSnapshot,accept,ack,historicalAck,flush,tick:revoke,setEpoch,setConnected:v=>{const next=v===true;if(next&&!connected)retries.clear();connected=next;revoke();if(connected)flush();},outbox,attempts,attachUtterance,receiptFor,bodyReceipts};
}
const api={TTL_MS,create};if(typeof module==='object')module.exports=api;root.PitwallBoxAuthorityTransport=api;
})(typeof globalThis==='object'?globalThis:this);
