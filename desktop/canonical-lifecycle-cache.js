/* WO009: read-only canonical authority, pinned to the current WS generation. */
(function(root){'use strict';
const TTL_MS=5000, domains=['race_facts','current_facts','finish','lifecycle','pit_ledger','execution','box_delivery','last_driver_action','recommendations','continuity'];
const integer=v=>typeof v==='number'&&Number.isInteger(v)&&v>=0;
const text=v=>typeof v==='string'&&v.length>0;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function stable(v){if(Array.isArray(v))return '['+v.map(stable).join(',')+']';if(object(v))return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';return JSON.stringify(v);}
function finiteTree(v){if(typeof v==='number')return Number.isFinite(v);if(v&&typeof v==='object')return Object.values(v).every(finiteTree);return ['string','boolean','object'].includes(typeof v);}
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function validate(s){
 if(!object(s)||s.type!=='canonical_lifecycle_snapshot'||s.schema_version!==1||!text(s.bridge_process_epoch)
 ||!integer(s.snapshot_sequence)||s.snapshot_id!==s.bridge_process_epoch+':'+s.snapshot_sequence
 ||!text(s.race_instance_id)||!integer(s.session_num)||!object(s.source_frame)||!integer(s.source_frame.sequence)
 ||typeof s.source_frame.available!=='boolean'||!(s.source_frame.session_time_s===null||typeof s.source_frame.session_time_s==='number'&&Number.isFinite(s.source_frame.session_time_s))
 ||typeof s.telemetry_available!=='boolean'||!domains.every(k=>object(s[k]))||!finiteTree(s))return false;
 const scope=s.continuity.stable_scope;
 if(scope!==undefined&&scope!==null&&(!object(scope)||Object.keys(scope).sort().join(',')!=='driver_id,race_instance_id,session_num'
  ||scope.race_instance_id!==s.race_instance_id||scope.session_num!==s.session_num||!integer(scope.driver_id)||scope.driver_id===0))return false;
 const custody=s.continuity.custody_scope;
 if(custody!==undefined&&custody!==null&&(!object(custody)||scope!=null
  ||Object.keys(custody).sort().join(',')!=='driver_id,process_epoch,race_instance_id,session_num'
  ||!s.race_instance_id.startsWith('fallback:')||custody.race_instance_id!==s.race_instance_id
  ||custody.session_num!==s.session_num||custody.process_epoch!==s.bridge_process_epoch
  ||!integer(custody.driver_id)||custody.driver_id===0))return false;
 const a=s.lifecycle.active,e=s.execution,b=s.box_delivery,f=s.current_facts;
 const nullable=(v,test)=>v===null||test(v), finite=v=>typeof v==='number'&&Number.isFinite(v);
 const originMatches=(origin,ref,recordOrigin=false)=>origin===undefined||object(origin)&&text(origin.bridge_process_epoch)
  &&Object.keys(ref).every(k=>k==='bridge_process_epoch'||(recordOrigin&&k==='revision'?integer(origin[k])&&origin[k]<=ref[k]:origin[k]===ref[k]))
  &&Object.keys(origin).length===Object.keys(ref).length;
 const record=r=>object(r)&&text(r.decision_id)&&r.race_instance_id===s.race_instance_id&&r.session_num===s.session_num&&integer(r.revision)
  &&object(r.record_ref)&&r.record_ref.bridge_process_epoch===s.bridge_process_epoch&&r.record_ref.race_instance_id===s.race_instance_id&&r.record_ref.session_num===s.session_num&&r.record_ref.decision_id===r.decision_id&&r.record_ref.revision===r.revision
  &&originMatches(r.origin_record_ref,r.record_ref,true)&&(r.current_custody_ref===undefined||stable(r.current_custody_ref)===stable(r.record_ref))&&['A','B','C'].includes(r.selected_plan)&&nullable(r.target_lap,integer)&&nullable(r.add_fuel_l,v=>finite(v)&&v>=0)&&nullable(r.set_fuel_l,integer)
  &&nullable(r.expected_pit_sequence,integer)&&nullable(r.resolved_pit_sequence,integer)&&nullable(r.activated_source_frame_sequence,integer);
 if(!Array.isArray(s.lifecycle.awaiting)||!Array.isArray(s.lifecycle.terminal_records)||!s.lifecycle.awaiting.every(r=>record(r)&&r.phase==='awaiting_driver')||!s.lifecycle.terminal_records.every(r=>record(r)&&['executed','invalidated','cancelled'].includes(r.phase)))return false;
 if(a!==null&&(!record(a)||!integer(a.activated_source_frame_sequence)||!integer(a.expected_pit_sequence)||a.phase!=='active'))return false;
 if(s.lifecycle.active_plan_id!==(a?a.decision_id:null)||a&&s.source_frame.available&&a.activated_source_frame_sequence>s.source_frame.sequence)return false;
 if(!integer(s.race_facts.driver_pit_sequence)||typeof e.allowed!=='boolean'||typeof e.scope_closed!=='boolean'||typeof e.collision!=='boolean'||typeof e.visit_open!=='boolean'||!nullable(e.gate_reason,text))return false;
 if(typeof f.available!=='boolean'||!nullable(f.reason,text)||!object(f.source_frame)||!nullable(f.source_frame.sequence,integer)||!nullable(f.source_frame.session_time_s,finite)||!object(f.scope_ref)||!nullable(f.scope_ref.race_instance_id,text)||!nullable(f.scope_ref.session_num,integer))return false;
 if(f.available&&(f.source_frame.sequence!==s.source_frame.sequence||f.source_frame.session_time_s!==s.source_frame.session_time_s||f.scope_ref.race_instance_id!==s.race_instance_id||f.scope_ref.session_num!==s.session_num))return false;
 if(e.allowed&&!f.available)return false;
 if(!nullable(f.current_lap,integer)||!nullable(f.fuel_level_l,v=>finite(v)&&v>=0)||!nullable(f.lap_dist_pct,v=>finite(v)&&v>=0&&v<=1)||!nullable(f.on_pit_road,v=>typeof v==='boolean')||!nullable(f.on_track,v=>typeof v==='boolean'))return false;
 if(!['allowed_proof_id','allowed_attempt_id'].every(k=>b[k]===null||text(b[k]))||!nullable(b.valid_until_session_s,finite)||!!b.allowed_proof_id!==!!b.allowed_attempt_id||!Array.isArray(b.attempts))return false;
 if(e.allowed&&(!a||!s.telemetry_available||!s.source_frame.available||e.scope_closed||e.collision||e.visit_open||e.gate_reason!==null||f.on_track!==true||f.on_pit_road!==false))return false;
 if(b.allowed_attempt_id){const attempt=b.attempts.find(x=>x.attempt_id===b.allowed_attempt_id);
  if(!e.allowed||!a||f.current_lap!==a.target_lap||a.expected_pit_sequence!==s.race_facts.driver_pit_sequence+1||!finite(b.valid_until_session_s)||!attempt||attempt.proof_id!==b.allowed_proof_id||attempt.race_instance_id!==s.race_instance_id||attempt.session_num!==s.session_num||attempt.decision_id!==a.decision_id||attempt.plan_revision!==a.revision||attempt.activation_frame!==a.activated_source_frame_sequence||attempt.driver_pit_sequence!==s.race_facts.driver_pit_sequence)return false;}
 const rf=s.race_facts,finish=s.finish,pit=s.pit_ledger,last=s.last_driver_action;
 if(rf.race_instance_id!==s.race_instance_id||rf.session_num!==s.session_num||!object(rf.source_frame)||rf.source_frame.sequence!==s.source_frame.sequence||rf.source_frame.session_time_s!==s.source_frame.session_time_s)return false;
 if(!object(rf.session_flags)||typeof rf.session_flags.available!=='boolean'||!nullable(rf.session_flags.raw_value,integer)||rf.session_flags.available&&rf.session_flags.raw_value===null)return false;
 if(!object(rf.black_flag)||!['true','false','unknown'].includes(rf.black_flag.state)||!text(rf.black_flag.authority)||!nullable(rf.black_flag.raw_value,integer)||!nullable(rf.black_flag.observed_session_time,finite)||!nullable(rf.black_flag.source_frame_sequence,integer)||!text(rf.black_flag.freshness))return false;
 const flags=rf.session_flags,black=rf.black_flag;
 if(black.authority!=='iRacing SessionFlags'||black.raw_value!==flags.raw_value||black.source_frame_sequence!==s.source_frame.sequence)return false;
 if(flags.available){
  const expected=Math.floor(flags.raw_value/0x10000)%2===1?'true':'false';
  if(!s.telemetry_available||!s.source_frame.available||black.state!==expected||black.freshness!=='fresh'||black.observed_session_time!==s.source_frame.session_time_s)return false;
 }else if(flags.raw_value!==null||black.state!=='unknown'||black.freshness!=='unavailable'||black.observed_session_time!==(s.telemetry_available?s.source_frame.session_time_s:null))return false;
 if(e.allowed&&(rf.black_flag.state!=='false'||rf.black_flag.freshness!=='fresh'))return false;
 if(!nullable(finish.kind,text)||typeof finish.available!=='boolean'||!nullable(finish.remaining_after_current,integer)||!nullable(finish.remaining_sf_crossings,integer)||finish.source_frame_sequence!==s.source_frame.sequence)return false;
 if(finish.available&&(finish.kind!=='lap_race'||finish.remaining_after_current===null||finish.remaining_sf_crossings!==finish.remaining_after_current+1))return false;
 if(!Array.isArray(pit.events)||!integer(pit.recorded_event_count)||pit.recorded_event_count!==pit.events.length||pit.process_observed_exit_count!==rf.driver_pit_sequence||pit.absolute_race_exit_count!==null)return false;
 if(!pit.events.every(event=>object(event)&&event.schema_version===1&&text(event.pit_event_id)&&event.race_instance_id===s.race_instance_id&&event.session_num===s.session_num&&integer(event.driver_pit_sequence)&&event.driver_pit_sequence<=rf.driver_pit_sequence&&object(event.entry)&&object(event.exit)&&object(event.penalty_evidence)))return false;
 if(!pit.events.every(event=>object(event.event_ref)&&event.event_ref.bridge_process_epoch===s.bridge_process_epoch&&event.event_ref.race_instance_id===s.race_instance_id&&event.event_ref.session_num===s.session_num&&event.event_ref.pit_event_id===event.pit_event_id&&event.event_ref.driver_pit_sequence===event.driver_pit_sequence&&originMatches(event.origin_event_ref,event.event_ref)&&(event.current_custody_ref===undefined||stable(event.current_custody_ref)===stable(event.event_ref))))return false;
 if(!s.lifecycle.terminal_records.every(record=>!record.terminal_pit_event_id||pit.events.some(event=>event.pit_event_id===record.terminal_pit_event_id&&stable(record.terminal_event_ref)===stable(event.event_ref)&&originMatches(record.origin_terminal_event_ref,event.event_ref)&&(!record.origin_terminal_event_ref||stable(record.origin_terminal_event_ref)===stable(event.origin_event_ref)))))return false;
 if(pit.last_event===null?pit.events.length!==0:stable(pit.last_event)!==stable(pit.events.at(-1)))return false;
 if(typeof last.available!=='boolean'||(last.available?!object(last.action):last.action!==null))return false;
 if(last.available&&(!text(last.action.command_id)||!text(last.action.outcome)||last.action.bridge_process_epoch!==s.bridge_process_epoch||last.action.race_instance_id!==s.race_instance_id||last.action.session_num!==s.session_num||!text(last.action.canonical_snapshot_id)||!integer(last.action.canonical_snapshot_sequence)))return false;
 if(typeof s.continuity.prior_history_available!=='boolean'||!['process_observed','checkpoint_observed'].includes(s.continuity.pit_sequence_origin))return false;
 if(!object(s.freshness)||!Array.isArray(s.unknowns)||!Array.isArray(s.diagnostics)||s.continuity.state_origin_epoch!==s.bridge_process_epoch||typeof s.continuity.restored!=='boolean'||s.continuity.resume_old_plan_allowed!==false)return false;
 const continuity=s.continuity;
 if(continuity.restored&&(![...(a?[a]:[]),...s.lifecycle.awaiting,...s.lifecycle.terminal_records].every(r=>object(r.origin_record_ref)&&object(r.current_custody_ref))||!pit.events.every(event=>object(event.origin_event_ref))||!s.lifecycle.terminal_records.every(r=>!r.terminal_pit_event_id||object(r.origin_terminal_event_ref))))return false;
 if(continuity.durable_commit!==undefined&&(typeof continuity.durable_commit!=='boolean'||e.allowed&&!continuity.durable_commit))return false;
 if(continuity.recovery_status!==undefined){
  if(!['restore_pending','fresh','restored','restore_failed','identity_unsupported','archive_scope'].includes(continuity.recovery_status)||typeof continuity.gap_unknown!=='boolean'||typeof continuity.durable_commit!=='boolean'||!nullable(continuity.checkpoint_id,text)||!nullable(continuity.checkpoint_revision,integer)||!nullable(continuity.error,text)||!nullable(continuity.origin_epoch,text))return false;
  if(e.allowed&&(!continuity.durable_commit||['restore_pending','restore_failed','identity_unsupported'].includes(continuity.recovery_status)))return false;
 }
 return true;
}
function create(opts){
 const now=opts.now, floors=new Map(), contents=new Map(), retired=new Set();let generation=0,epoch=null,socketEpoch=null,connected=false,snapshot=null,receivedAt=0;
 const change=()=>opts.onChange?.();
 function beginSocket(){generation++;socketEpoch=null;connected=false;snapshot=null;change();return generation;}
 function hello(g,h){if(g===generation&&socketEpoch&&h&&h.bridge_process_epoch!==socketEpoch){connected=false;snapshot=null;change();return false;}if(g!==generation||!h||h.type!=='connected'||h.schema_version!==1||!text(h.bridge_process_epoch)||retired.has(h.bridge_process_epoch))return false;
  if(epoch&&epoch!==h.bridge_process_epoch){retired.add(epoch);contents.clear();}
  epoch=h.bridge_process_epoch;socketEpoch=epoch;connected=true;snapshot=null;change();return true;
 }
 function disconnect(g=generation){if(g!==generation)return false;connected=false;snapshot=null;change();return true;}
 function receive(s,g=generation){if(g!==generation||!connected||!s||s.bridge_process_epoch!==epoch)return false;
  const floor=floors.get(epoch)??-1;
  if(integer(s.snapshot_sequence)&&s.snapshot_sequence<floor)return false;
  if(!validate(s)){snapshot=null;change();return false;}
  const content=stable(s);
  if(s.snapshot_sequence===floor){if(contents.get(epoch)!==content){snapshot=null;change();}return false;}
  floors.set(epoch,s.snapshot_sequence);contents.set(epoch,content);snapshot=freeze(JSON.parse(JSON.stringify(s)));receivedAt=now();change();return true;
 }
 function current(){return connected&&snapshot&&now()-receivedAt<TTL_MS?snapshot:null;}
 function matches(m){const s=current();return !!s&&m&&m.bridge_process_epoch===epoch&&m.canonical_snapshot_id===s.snapshot_id&&m.canonical_snapshot_sequence===s.snapshot_sequence;}
 function epochMatches(m){return connected&&m&&m.bridge_process_epoch===epoch;}
 function authority(){const s=current(),a=s?.lifecycle.active;if(!s||!a||s.continuity.durable_commit===false||['restore_pending','restore_failed','identity_unsupported'].includes(s.continuity.recovery_status)||!s.telemetry_available||!s.source_frame.available||s.execution.scope_closed||s.execution.collision)return null;
  return {raceInstanceId:s.race_instance_id,sessionNum:s.session_num,decisionId:a.decision_id,revision:a.revision,activationFrame:a.activated_source_frame_sequence,sourceFrame:s.source_frame.sequence,pitSequence:s.race_facts.driver_pit_sequence,bridgeProcessEpoch:epoch,canonicalSnapshotId:s.snapshot_id,canonicalSnapshotSequence:s.snapshot_sequence};}
 return {beginSocket,hello,disconnect,invalidate:()=>{snapshot=null;change();},receive,current,matches,epochMatches,authority,isGeneration:g=>g===generation,getEpoch:()=>epoch,
  // round4 residual ("unknown fully-null scope"): current() returns null for
  // every reason (never connected, disconnected, TTL expired) with no way to
  // tell two DIFFERENT null periods apart. connectionGeneration() exposes the
  // ALREADY-tracked beginSocket() counter read-only, so a consumer (strategy-
  // state-projection.js binding('critical_context') unavailable sentinel) can
  // tell "still the SAME attempted connection, still unknown" apart from "a
  // genuine reset/reconnect happened, still unknown" even while current()
  // stays null the whole time.
  connectionGeneration:()=>generation,
  expiresAt:()=>receivedAt+TTL_MS,isConnected:()=>connected,peek:()=>snapshot};
}
const api={TTL_MS,validate,stable,create};if(typeof module==='object')module.exports=api;root.PitwallCanonicalLifecycleCache=api;
})(typeof globalThis==='object'?globalThis:this);
