/* WO011: Bridge truth is read-only; conversation metadata is a separate domain. */
(function(root){'use strict';
const integer=v=>typeof v==='number'&&Number.isInteger(v)&&v>=0;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const clone=v=>v===undefined?null:JSON.parse(JSON.stringify(v));
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
const immutable=v=>freeze(clone(v));
function stable(v){if(Array.isArray(v))return '['+v.map(stable).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';return JSON.stringify(v);}
function factContent(s){const f=s.current_facts;return stable({fuel_level_l:f.fuel_level_l,current_lap:f.current_lap,on_pit_road:f.on_pit_road,on_track:f.on_track,finish:{kind:s.finish.kind,available:s.finish.available,remaining_after_current:s.finish.remaining_after_current,remaining_sf_crossings:s.finish.remaining_sf_crossings},fuel_calculation:s.recommendations.fuel_strategy||null,pit_events:s.pit_ledger.events,active:s.lifecycle.active});}
// round4 (audit correction): the critical_context unavailable sentinel used
// to carry identity:null -- no scope signal at all -- so validBinding's
// `!usable(source())` check alone could not tell "still the SAME unknown"
// apart from "unknown again, but a completely different race/session/driver
// now". rawScopeSignature reads whatever partial scope IS present directly
// off the raw canonical snapshot (bypassing source()'s own usability gate,
// which already discards the snapshot entirely once unusable) so an
// initial-unknown reply can be told apart from a later unknown under a
// DIFFERENT identity, even while canonical never once became usable.
// round4 residual ("unknown fully-null scope"): if the raw snapshot itself
// is null (never connected / disconnected / TTL-expired), the signature
// above degenerates to a single constant, so two DIFFERENT null periods
// (e.g. a genuine reset/reconnect to another race/session, still not yet
// usable) would be indistinguishable. connGen is the canonical cache's own
// already-tracked connection-attempt counter (beginSocket(), round4-added
// connectionGeneration()) -- folded in here so a reconnect is detectable
// even while current() stays null throughout. Callers without that accessor
// (simpler test mocks) pass null, which degrades to the prior behavior.
function rawScopeSignature(s,connGen){const conn=typeof connGen==='number'?connGen:null;
 if(!s)return JSON.stringify(['disconnected',conn]);const scope=s.continuity&&s.continuity.stable_scope;
 return JSON.stringify([s.bridge_process_epoch??null,s.race_instance_id??null,s.session_num??null,(scope&&typeof scope==='object')?(scope.driver_id??null):null,conn]);}
function connectionGeneration(canonical){return typeof canonical.connectionGeneration==='function'?canonical.connectionGeneration():null;}
// WO014 round3: the 5 current-race LLM callers (sendMessage/followUp/
// paceCheck/judgeCall/autoBriefing) need a reply-freshness fence that
// invalidates on CRITICAL changes (Plan/pit/penalty/pending-proposal
// revision) but explicitly must NOT invalidate on ordinary telemetry
// progression (fuel burning down, lap ticking up mid-reply) -- round3's
// own "初期unknownとordinarysequence維持" requirement. factContent (used by
// answerFuel/answerPitDecision, where an EXACT fuel/lap match matters) is
// too strict for this: fuel_level_l/current_lap change on nearly every
// telemetry frame, so reusing it here would discard almost every reply in
// a live race, not just ones affected by a genuinely critical change. This
// is a separate, narrower content function for a separate binding kind.
// WO014 round4: race_facts.black_flag itself is NOT stable across ordinary
// polling -- authoritative_race_facts.build_snapshot() (bridge side)
// re-stamps observed_session_time/source_frame_sequence on it every single
// poll iteration even when the derived state never changes (classify_
// black_flag() only drives `state`; the frame/time stamps are carried on
// the SAME dict regardless). Including the whole black_flag object here
// made criticalContent() -- and therefore every binding('critical_context')
// reply fence -- change on every ordinary telemetry frame, discarding
// replies that were never affected by any pit/penalty/Plan change at all.
// Only `state`/`freshness` are the meaningful (non-observational) facts for
// this fence; `raw_value` can also flip on unrelated SessionFlags bits
// (e.g. caution) without changing the black-flag state itself.
// round4 residual ("execution/proof semantics"): criticalContent previously
// only tracked active/pit_events/black_flag/awaiting -- a SAME Plan whose
// execution.allowed/gate_reason or box-authority proof id materially
// changes (e.g. execution newly held, or a different proof/attempt now
// authorized) was invisible to this fence, so a reply built against the
// OLD execution/proof state could keep being treated as current. Only the
// semantic fields are included -- box_delivery.valid_until_session_s (a
// per-frame-ish expiry clock) is deliberately excluded, matching the SAME
// "observation stamp vs semantic change" discipline black_flag already
// uses above (round4 ordinary-frame fix): a reply must not be discarded
// just because a timer value ticked, only when the actual authorization
// state changed.
function criticalContent(s){const bf=s.race_facts.black_flag;
 return stable({active:s.lifecycle.active,pit_events:s.pit_ledger.events,black_flag:bf?{state:bf.state,freshness:bf.freshness}:null,awaiting:s.lifecycle.awaiting,
  execution:{allowed:s.execution.allowed,gate_reason:s.execution.gate_reason||null},
  proof:{allowed_proof_id:s.box_delivery.allowed_proof_id||null,allowed_attempt_id:s.box_delivery.allowed_attempt_id||null}});}
function create({canonical,now=()=>Date.now()}){
 let identity=null,generation=0,proposal=null,dispute=null,driverStrategy=null;
 const seen=new Map();
 function unavailable(){if(proposal||dispute){generation++;proposal=null;dispute=null;}return null;}
 function source(){
  const s=canonical.current(),scope=s?.continuity?.stable_scope;
  if(!s||!scope||scope.race_instance_id!==s.race_instance_id||scope.session_num!==s.session_num||!integer(scope.driver_id)||scope.driver_id===0
   ||!integer(scope.session_num)||typeof scope.race_instance_id!=='string'||!scope.race_instance_id)return unavailable();
  if(s.continuity.durable_commit===false||['restore_pending','restore_failed','identity_unsupported'].includes(s.continuity.recovery_status))return unavailable();
  const id=JSON.stringify([s.bridge_process_epoch,scope.race_instance_id,scope.session_num,scope.driver_id]);
  if(id!==identity){identity=id;generation++;proposal=null;dispute=null;driverStrategy=null;seen.clear();}
  if(s.telemetry_available!==true||s.source_frame.available!==true||s.current_facts.available!==true||s.execution.scope_closed||s.execution.collision)unavailable();
  if(!seen.has(s.snapshot_id)){seen.set(s.snapshot_id,now());if(seen.size>64)seen.delete(seen.keys().next().value);}
  return s;
 }
 function usable(s){return !!s&&s.telemetry_available===true&&s.source_frame.available===true&&s.current_facts.available===true&&!s.execution.scope_closed&&!s.execution.collision;}
 function pending(){const s=source();if(!usable(s)){unavailable();return null;}if(!proposal)return null;
  const r=s.lifecycle.awaiting.find(r=>r.decision_id===proposal.decision_id&&r.revision===proposal.canonical_revision&&r.target_lap===proposal.lap);
  if(!r||stable(r)!==proposal.canonical_record_content||now()>=proposal.expires_at||proposal.identity!==identity){proposal=null;return null;}return immutable(proposal);
 }
 function current(){const s=source(),available=usable(s),a=available?s.lifecycle.active:null;
  const events=s?s.pit_ledger.events:[],last=available?(events.at(-1)||null):null;
  // round4: last_pit_service (lane_total_s/stall_s/fuel_added_l) must never
  // be a raw Bridge-telemetry echo (the Bridge's own slim live.last_pit_
  // service local var is not scoped by session on its own) -- it is only
  // trusted here as `last.service`, the SAME canonical immutable pit_ledger
  // event already filtered server-side to this exact race_instance_id/
  // session_num (canonical_lifecycle_snapshot.build()). The identity
  // cross-check below is defense-in-depth: if `last` ever failed to match
  // THIS snapshot's own scope, service must fall to unknown, not leak a
  // previous-session sample ("前session旧sample残留" negative case).
  const lastServiceVerified=(last&&last.service&&s&&last.race_instance_id===s.race_instance_id&&last.session_num===s.session_num)
    ?{fuel_added_l:last.service.fuel_added_l,lane_total_s:last.service.lane_total_s,stall_s:last.service.stall_s}:null;
  const pitPlan=a?{lap:a.target_lap,plan_id:a.selected_plan,source:'bridge_canonical',decision_id:a.decision_id,revision:a.revision,record_ref:a.record_ref}:null;
  return immutable({readonly_projection:true,available,reason:!s?'canonical_unavailable':!available?'canonical_unavailable_or_closed':null,
   scope:s?s.continuity.stable_scope:null,publication_ref:s?{bridge_process_epoch:s.bridge_process_epoch,canonical_snapshot_id:s.snapshot_id,canonical_snapshot_sequence:s.snapshot_sequence}:null,
   canonical_revision:a?.revision??null,revision:generation,active:a,pending:available?s.lifecycle.awaiting:[],terminals:s?s.lifecycle.terminal_records:[],pitEvents:events,history_role:'canonical_observed_history',history_available:!!s,
   pit_plan:pitPlan,pit_executed:last?{lap:last.entry?.lap??last.entry?.current_lap??null,execution_relation:last.execution_relation,pit_event_id:last.pit_event_id,event_ref:last.event_ref,service:lastServiceVerified,source:'bridge_canonical'}:null,
   pending_proposal:pending(),driver_strategy:driverStrategy,laps_dispute:dispute,
   execution_allowed:available&&s.execution.allowed,execution_hold_reason:available&&!s.execution.allowed?(s.execution.gate_reason||s.execution.box_verdict_reason||'execution_held'):null,
   black_flag:available?s.race_facts.black_flag:null,current_facts:available?s.current_facts:null,finish:available?s.finish:null,continuity:s?.continuity??null});
 }
 function binding(kind='active',decisionId=null){if(kind&&typeof kind==='object'){decisionId=kind.decision_id??null;kind=kind.kind||'active';}if(kind==='plan')kind='active';if(kind==='proposal')kind='awaiting';const s=source();
  // WO014 round4: a caller that asks for the current-race reply fence while
  // canonical is unavailable (initial/identity-unknown) must still get a
  // binding object, not null -- otherwise the staleness fence downstream
  // (validBinding) is silently skipped entirely (null && X === false), so a
  // driver-facing "I cannot confirm that" reply built against this unknown
  // state could survive unguarded even after identity/session attaches and
  // the state stops being unknown. `unavailable:true` lets a caller that
  // must NEVER speak an initial-unknown reply (the auto/proactive callers)
  // still detect "there was nothing to bind to" explicitly.
  // round6 (会話維持の回帰修復): 'scope_continuity' is for a reply whose TEXT
  // was never about Plan/fuel/pit (pure past/setup/chit-chat -- the caller
  // already proved this via currentPlanReplyDependsOn()==false). It must
  // still fail closed on the SAME identity/epoch/closure/TTL boundary every
  // other kind enforces (handled by validBinding's common prefix below), but
  // must NOT be invalidated merely because criticalContent() (Plan revision/
  // pit_events/awaiting/execution/proof -- facts this reply never claimed
  // anything about) changed under the SAME identity. Shares critical_context's
  // unavailable sentinel mechanism so an initial-unknown chat reply is held
  // to the identical "same unknown scope" contract (round4) as every other kind.
  if(!usable(s))return ['critical_context','scope_continuity'].includes(kind)?immutable({kind,identity:null,unavailable:true,captured_scope:rawScopeSignature(canonical.current(),connectionGeneration(canonical))}):null;
  const r=kind==='awaiting'?s.lifecycle.awaiting.find(r=>!decisionId||r.decision_id===decisionId)
   :kind==='terminal'?s.lifecycle.terminal_records.find(r=>decisionId&&r.decision_id===decisionId):s.lifecycle.active;
  if(!r&&!['facts','recommendation','critical_context','scope_continuity'].includes(kind))return null;
  const deadline=typeof canonical.expiresAt==='function'?canonical.expiresAt():seen.get(s.snapshot_id)+5000;
  return immutable({kind,identity,bridge_process_epoch:s.bridge_process_epoch,canonical_snapshot_id:s.snapshot_id,canonical_snapshot_sequence:s.snapshot_sequence,
   deadline_ms:deadline,record_content:r?stable(r):null,fact_content:kind==='facts'?factContent(s):null,critical_context_content:kind==='critical_context'?criticalContent(s):null,recommendation_content:kind==='recommendation'?JSON.stringify(s.recommendations):null,scope:s.continuity.stable_scope,decision_id:r?.decision_id??null,revision:r?.revision??null,record_ref:r?.record_ref??null});
 }
 // round5 (main複合fence): a caller that must fence on BOTH a precise
 // domain binding (facts/plan/proposal -- the exact content the reply text
 // was actually built from) AND the unconditional critical_context binding
 // (penalty/exec-proof/pit/pending-proposal changes a domain binding does
 // not itself track -- see criticalContent() above) used to have no way to
 // express that without widening every downstream speak()/speakReplyChunk()/
 // queue-dequeue call site's single-binding precheck signature. bindAll()
 // composes N already-built bindings into ONE opaque binding object; the
 // EXISTING single-binding validBinding(binding) call at every one of those
 // sites (unchanged) now transparently ANDs all parts, so a reply fenced on
 // a domain binding no longer silently skips a critical_context change (or
 // vice versa) just because only one of the two was picked.
 function bindAll(parts){const list=(Array.isArray(parts)?parts:[]).filter(Boolean);
  if(list.length===0)return null;if(list.length===1)return list[0];
  return immutable({kind:'and',parts:list});}
 function validBinding(b){
  if(b&&b.kind==='and')return Array.isArray(b.parts)&&b.parts.length>0&&b.parts.every(validBinding);
  // The unavailable sentinel (see binding() above) is valid for exactly as
  // long as canonical STAYS unavailable -- the instant real data arrives
  // (even under the same identity), the initial-unknown reply it fenced
  // must not keep being treated as current.
  if(b&&['critical_context','scope_continuity'].includes(b.kind)&&b.unavailable===true)return !usable(source())&&rawScopeSignature(canonical.current(),connectionGeneration(canonical))===b.captured_scope;
  const s=source();if(!b||!usable(s)||now()>=b.deadline_ms||identity!==b.identity||s.bridge_process_epoch!==b.bridge_process_epoch)return false;
  // round6: scope_continuity stops here -- identity/epoch/closure(usable)/TTL
  // (the common prefix just above) are the ONLY boundary a topic-independent
  // reply is held to. It deliberately does NOT re-check criticalContent()/
  // factContent() equality (that is scope_continuity's entire purpose: a
  // reply that never claimed anything about Plan/pit/fuel must not be
  // discarded just because those facts changed under the SAME scope).
  if(b.kind==='scope_continuity')return true;
  if(b.kind==='facts')return factContent(s)===b.fact_content;
  if(b.kind==='critical_context')return criticalContent(s)===b.critical_context_content;
  if(b.kind==='recommendation'&&JSON.stringify(s.recommendations)!==b.recommendation_content)return false;
  if(b.kind==='recommendation'&&b.decision_id===null)return s.lifecycle.active===null;
  const r=b.kind==='awaiting'?s.lifecycle.awaiting.find(r=>r.decision_id===b.decision_id)
   :b.kind==='terminal'?s.lifecycle.terminal_records.find(r=>r.decision_id===b.decision_id):s.lifecycle.active;
  return !!r&&r.decision_id===b.decision_id&&r.revision===b.revision&&stable(r)===b.record_content;
 }
 function request(st,input,kind){const v=current();return immutable({requested:!!v.available,applied:false,kind,reason:v.available?'bridge_confirmation_required':'canonical_unavailable',lap:input?.lap??null,plan:v.pit_plan});}
 function proposePlan(st,i={}){const s=source();if(!usable(s))return null;
  const r=s.lifecycle.awaiting.find(r=>r.decision_id===i.decision_id&&r.target_lap===i.lap&&r.selected_plan===i.plan_id);
  const attempt=i.dispatch_id&&s.box_delivery.attempts.find(a=>a.dispatch_id===i.dispatch_id&&a.decision_id===i.decision_id);
  if(!r||!(i.audible===true||attempt?.status==='audible_started'))return null;
  generation++;proposal={plan_id:r.selected_plan,lap:r.target_lap,decision_id:r.decision_id,canonical_revision:r.revision,canonical_record_content:stable(r),base_revision:generation,identity,
   at:now(),expires_at:now()+90000,dispatch_id:i.dispatch_id??null,audible:true,awaiting_judgment:false,binding:binding('awaiting',r.decision_id)};return pending();
 }
 function resolvePendingProposal(st,i={}){const p=pending();if(!p||p.awaiting_judgment&&!i.bypassJudgmentGate)return null;
  generation++;proposal=null;return immutable({accepted:i.accepted===true,requested:true,applied:false,proposal:p,plan:{lap:p.lap,plan_id:p.plan_id,decision_id:p.decision_id},reason:'bridge_confirmation_required'});
 }
 function invalidatePendingProposal(st,i={}){const p=pending();if(!p||i.decision_id&&i.decision_id!==p.decision_id)return null;generation++;proposal=null;return immutable(p);}
 function markAwaitingJudgment(){const p=pending();if(!p)return null;generation++;proposal={...p,awaiting_judgment:true,base_revision:generation};return pending();}
 function applyProposalClassification(st,i={}){const p=pending();if(!p)return {applied:false,reason:'no_pending_proposal'};
  if(i.decision_id!==p.decision_id)return {applied:false,reason:'stale_classification_target_mismatch'};
  if(i.request_revision!==p.base_revision)return {applied:false,reason:'stale_request_generation'};
  if(['confirm','decline'].includes(i.classification))return {applied:true,requested:true,outcome:i.classification==='confirm'?'confirmed':'declined',resolved:resolvePendingProposal(st,{accepted:i.classification==='confirm',bypassJudgmentGate:true})};
  if(i.classification==='unrelated')return {applied:true,outcome:'invalidated',invalidated:invalidatePendingProposal(st,i)};
  if(i.classification==='same_topic'){generation++;proposal={...p,awaiting_judgment:false,base_revision:generation};return {applied:true,outcome:'kept_pending'};}return {applied:false,reason:'unknown_classification'};
 }
 function answerPitDecision(st,input={}){const v=current(),p=v.pit_plan,en=input.lang&&input.lang!=='ja';
  if(!v.available)return {reply:en?'I cannot confirm the current pit plan.':'現在のピット計画を確認できない。',state:'unavailable',revision:generation};
  if(p&&!integer(p.lap))return {reply:en?'The current plan exists, but its pit lap is not available.':'現在のPlanはあるが、ピット周はまだ確認できない。',state:'planned_target_unknown',revision:generation,binding:binding()};
  if(p){const ordinary=['box_authority_unavailable','target_lap_not_reached','not_target_lap','not_due','target_lap_mismatch'].includes(v.execution_hold_reason)||String(v.execution_hold_reason||'').includes('target_lap_not');
   const held=!v.execution_allowed&&!ordinary;
   return {reply:(en?`Box on lap ${p.lap}, Plan ${p.plan_id}.`:`${p.lap}周目でボックス、Plan ${p.plan_id}。`)+(held?(en?' Execution is held pending current evidence.':'現在の根拠を確認するまで実行は保留中。'):''),state:'planned',revision:generation,binding:binding(),execution_hold_reason:v.execution_hold_reason};}
  const event=v.pit_executed;
  if(event){const relation=event.execution_relation;return {reply:en?(relation==='penalty'?'A penalty pit exit is recorded; this is separate from the normal strategy.':relation==='unresolved'?'A pit exit is recorded; the strategy outcome is unresolved.':'A pit exit is recorded. I will check the remaining fuel plan.'):(relation==='penalty'?'ペナルティのピット退出を確認。通常作戦の実行とは区別している。':relation==='unresolved'?'ピット退出を確認したが、作戦の実行結果は未確定。':`ピット退出を確認。${relation==='early'?'予定より早いピットだった。':''}残りの燃料計画は改めて確認する。`),state:relation||'unresolved',revision:generation,binding:binding('facts')};}
  return {reply:en?'A pit lap has not been agreed.':'ピット周はまだ合意していない。',state:'none',revision:generation,binding:binding('facts')};
 }
 function answerFuel(st,input={}){const v=current(),fuel=v.current_facts?.fuel_level_l,en=input.lang&&input.lang!=='ja',s=source();
  const rec=s?.recommendations?.fuel_strategy,rate=rec?.value?.avg_fuel_per_lap,sourceFrame=rec?.calculation_source?.source_frame_sequence;
  const age=s?calculationAge(s,rec):null;
  const laps=v.finish?.available?v.finish.remaining_sf_crossings:null;
  let reply=finite(fuel)?(en?`Current fuel ${fuel.toFixed(1)} litres.`:`現在燃料${fuel.toFixed(1)}L。`):(en?'I cannot confirm current fuel.':'現在燃料を確認できない。');
  let shortfall=null,possible=null;
  if(finite(fuel)&&finite(rate)&&rate>0&&integer(sourceFrame)&&age!==null){possible=Math.round(fuel/rate*10)/10;
   const tag=en?`Using the Bridge calculation of ${rate.toFixed(2)} litres per lap (${age.toFixed(1)} seconds old), `:`Bridgeの燃費計算${rate.toFixed(2)}L/周（${age.toFixed(1)}秒前）を暫定根拠にすると、`;
   if(integer(laps)&&!dispute){const delta=rate*laps-fuel;shortfall=delta>0?Math.round(delta*10)/10:null;reply+=tag+(en?`for ${laps} finish-line crossings, ${delta>0?`${delta.toFixed(1)} litres short`:'fuel covers that estimate'}.`:`完走まで${laps}回のライン通過に対して${delta>0?`${delta.toFixed(1)}L不足する推定`:'この推定では足りる'}。`);}
   else reply+=tag+(en?`approximately ${Math.floor(possible)} laps are possible; the finish distance is unconfirmed.`:`約${Math.floor(possible)}周走行可能。完走距離は未確定。`);
  }else if(finite(fuel))reply+=en?' I will confirm the current fuel-burn calculation.':'完走までの必要量は最新の計算根拠を確認する。';
  return {reply,shortfall_l:shortfall,laps_possible:possible,fuel_basis:possible===null?'unavailable':'bridge_calculation_reference',calculation_age_s:age,revision:generation,binding:binding('facts')};
 }
 function disputeLapsRemaining(st,i={}){const s=source();if(!integer(i.driver_laps))return null;generation++;dispute={driver_laps:i.driver_laps,sdk_laps:s?.finish.remaining_after_current??null,observation_id:s?.snapshot_id??null};return immutable({held:true,...dispute});}
 function lapsRemainingStatus(){const s=source(),n=usable(s)&&s.finish.available?s.finish.remaining_after_current:null;
  if(dispute&&s?.snapshot_id!==dispute.observation_id&&n!==null){dispute=null;generation++;return {held:false,released:true,laps_remaining:n,sdk_laps:n,source:'bridge_canonical'};}
  return {held:!!dispute,laps_remaining:dispute?null:n,sdk_laps:n,driver_laps:dispute?.driver_laps??null,source:dispute?'held':n===null?'unavailable':'bridge_canonical'};
 }
 function restateDriverStrategy(st,i={}){source();const text=String(i.text||'').trim();if(!text)return {reply:'',stored:false};generation++;driverStrategy={text,at:now(),role:'driver_statement_reference'};return {reply:`「${text.slice(0,40)}」だね。現在のPlanと照合する。`,stored:true,revision:generation};}
 function calculationAge(s,r){const c=r?.calculation_source,t=c?.session_time_s,f=c?.source_frame_sequence;
  if(!finite(t)||t<0||!integer(f)||f>s.source_frame.sequence||!finite(s.source_frame.session_time_s)||t>s.source_frame.session_time_s
   ||c.race_instance_id!==undefined&&c.race_instance_id!==s.race_instance_id||c.session_num!==undefined&&c.session_num!==s.session_num)return null;
  return s.source_frame.session_time_s-t;
 }
 function recommendations(s){return Object.fromEntries(Object.entries(s.recommendations||{}).map(([k,r])=>{const age=calculationAge(s,r);return [k,{...clone(r),role:r.role||'reference',age_s:age,source_valid:age!==null,diagnostic:age===null?'calculation_source_unavailable_or_inconsistent':null}];}));}
 function readPlaybook(){const s=source();if(!usable(s))return null;const a=s.lifecycle.active,recs=recommendations(s),options=recs.strategy_options?.value;
  const plans={};for(const id of ['A','B','C']){const candidate=options?.plans?.[id]||options?.['plan_'+id.toLowerCase()]||options?.[id];if(candidate&&recs.strategy_options.source_valid)plans[id]={...clone(candidate),role:'recommendation_not_execution',source:recs.strategy_options.calculation_source,age_s:recs.strategy_options.age_s};}
  if(a)plans[a.selected_plan]={available:true,first_pit_lap:a.target_lap,target_lap:a.target_lap,add_fuel_l:a.add_fuel_l,set_fuel_l:a.set_fuel_l,role:'canonical_active',record_ref:a.record_ref};
  return immutable({available:!!a||Object.keys(plans).length>0,selected_plan:a?.selected_plan??null,active_record:a,plans,recommendations:recs,source:'bridge_canonical',execution_allowed:s.execution.allowed,hold_reason:s.execution.gate_reason});
 }
 function raceFactsNote(){const v=current();if(!v.available)return '[Current strategy unavailable: no fresh canonical authority]'+(v.history_available?' Historical canonical outcomes only: '+v.terminals.map(r=>r.decision_id+':'+r.phase).join(', ')+'; pit outcomes '+v.pitEvents.map(e=>e.pit_event_id+':'+e.execution_relation).join(', '):'');
  const a=v.active;return `[Bridge canonical ${v.publication_ref.canonical_snapshot_id}; driver ${v.scope.driver_id}] Current agreed plan: ${a?`Plan ${a.selected_plan}, lap ${a.target_lap}, decision ${a.decision_id}, revision ${a.revision}`:'none'}. Execution: ${v.execution_allowed?'allowed':'held '+v.execution_hold_reason}. Observed pit outcomes: ${v.pitEvents.map(e=>e.pit_event_id+':'+e.execution_relation).join(', ')||'none'}. Historical/recommendation data cannot establish a current agreement.`;
 }
 const api={revision:()=>{source();return generation;},pitPlan:()=>current().pit_plan,pitExecuted:()=>current().pit_executed,answerPitDecision,answerFuel,
  pendingProposal:()=>pending(),proposePlan,resolvePendingProposal,markAwaitingJudgment,invalidatePendingProposal,applyProposalClassification,
  agreePitPlan:(st,i)=>request(st,i,'agree'),amendPitPlan:(st,i)=>request(st,i,'amend'),cancelPitPlan:(st,i)=>request(st,i,'cancel'),recordPitExecuted:()=>null,
  disputeLapsRemaining,lapsRemainingStatus,restateDriverStrategy};
 return {current,state:current,api,readPlaybook,raceFactsNote,strategyEvaluation:()=>{const s=source();return usable(s)?immutable({source:'bridge_canonical',recommendations:recommendations(s),active:s.lifecycle.active}):null;},binding,validBinding,bindAll,trace:()=>current().publication_ref};
}
const api={create};if(typeof module==='object')module.exports=api;root.PitwallStrategyStateProjection=api;
})(typeof globalThis==='object'?globalThis:this);
