/* WO016: Driver input ownership — turn owner, bounded pending inputs, PTT capture identity.
 *
 * Pure state (no DOM, no network). renderer.html owns the I/O and consumes the decisions:
 *  - Every Driver input gets an inputId/source/acceptedAt/scopeKey. The scope key is the exact
 *    canonical identity race_instance_id|session_num|driver_id|bridge_process_epoch supplied by
 *    the renderer (frame/snapshot progression is deliberately NOT part of it). Comparison is
 *    exact; there is no "unknown → known" exception.
 *  - One conversational turn (callAPI) = one owner with an externally abortable controller and
 *    the scope captured at turn start. Only the CURRENT owner, still in its own scope, is live;
 *    only the current owner may end the turn (an old catch/finally can never clear a new owner's
 *    busy state). Intentional cancellation (superseded/barge-in/scope change) is recorded
 *    separately from a network timeout so the renderer never speaks "connection error" for it.
 *  - Ordinary input while busy waits in a bounded FIFO; overflow / TTL / scope change are
 *    returned with explicit reasons so the caller can make them visible (never a silent drop).
 *  - PTT takes are identified by the Bridge capture_id minted at the physical down edge (it
 *    embeds the Bridge process epoch). Every terminal is matched by that exact id — never by
 *    arrival position. Terminals without an id, for an unknown/retired take, from another epoch,
 *    or repeated for the same take are rejected with an explicit reason. A terminal that arrives
 *    before the up edge is accepted for its own take. Results are released strictly in press
 *    order, so an old STT result can never overwrite a newer turn.
 */
(function(root){'use strict';
const INTENTIONAL=new Set(['superseded_urgent','ptt_barge_in','scope_changed']);
function create(opts){
  opts=opts||{};
  const now=typeof opts.now==='function'?opts.now:()=>Date.now();
  const maxPending=Number.isInteger(opts.maxPending)&&opts.maxPending>0?opts.maxPending:3;
  const pendingTtlMs=Number.isFinite(opts.pendingTtlMs)?opts.pendingTtlMs:60000;
  const captureLostMs=Number.isFinite(opts.captureLostMs)?opts.captureLostMs:20000;
  const traceMax=Number.isInteger(opts.traceMax)?opts.traceMax:100;
  const retiredMax=Number.isInteger(opts.retiredMax)?opts.retiredMax:100;
  let inputSeq=0,turnSeq=0,unidentifiedSeq=0,current=null;
  const pending=[],captures=[],trace=[],retired=new Map();
  function log(event,detail){trace.push(Object.assign({event,at:now()},detail||{}));while(trace.length>traceMax)trace.shift();}
  const key=k=>String(k||'none');
  const scopeChanged=(acceptedKey,currentKey)=>key(acceptedKey)!==key(currentKey);
  function accept(source,text,scopeKey,extra){
    const entry=Object.assign({inputId:'in-'+(++inputSeq),source:String(source||'typed'),text:String(text||''),
      acceptedAt:now(),scopeKey:key(scopeKey)},extra||{});
    log('accepted',{inputId:entry.inputId,source:entry.source,captureId:entry.captureId||null,scopeKey:entry.scopeKey});
    return entry;
  }
  // ── turn ownership ──
  function beginTurn(info){
    info=info||{};
    if(current&&!current.ended){
      // A new owner never starts on top of a live one without an explicit decision.
      cancelCurrent('superseded_urgent');
    }
    const Ctrl=opts.AbortController||(typeof AbortController==='function'?AbortController:null);
    const turn={turnId:'turn-'+(++turnSeq),inputId:info.inputId||null,source:info.source||null,scopeKey:key(info.scopeKey),
      controller:Ctrl?new Ctrl():null,cancelled:false,cancelReason:null,timedOut:false,ended:false,startedAt:now(),
      queuedItems:[],auxItems:[],bubble:null};
    current=turn;
    log('turn_begin',{turnId:turn.turnId,inputId:turn.inputId,scopeKey:turn.scopeKey});
    return turn;
  }
  // With currentScopeKey supplied, a turn whose captured scope differs is no longer live.
  const isCurrent=(turn,currentScopeKey)=>!!turn&&turn===current&&!turn.cancelled&&!turn.ended
    &&(currentScopeKey===undefined||!scopeChanged(turn.scopeKey,currentScopeKey));
  const turnScopeStale=(turn,currentScopeKey)=>!!turn&&scopeChanged(turn.scopeKey,currentScopeKey);
  function endTurn(turn){
    if(!turn)return false;
    turn.ended=true;
    if(turn!==current){log('turn_end_ignored_not_owner',{turnId:turn.turnId,owner:current&&current.turnId||null});return false;}
    current=null;
    log('turn_end',{turnId:turn.turnId,cancelled:turn.cancelled,timedOut:turn.timedOut});
    return true;
  }
  function cancelCurrent(reason){
    const turn=current;
    if(!turn||turn.ended||turn.cancelled)return null;
    turn.cancelled=true;turn.cancelReason=String(reason||'superseded_urgent');
    current=null;   // ownership is released synchronously; the old async path can no longer end a newer owner
    try{turn.controller&&turn.controller.abort(turn.cancelReason);}catch(e){}
    log('turn_cancelled',{turnId:turn.turnId,reason:turn.cancelReason});
    return turn;
  }
  function timeoutTurn(turn){
    if(!turn||turn.ended||turn.cancelled)return false;
    turn.timedOut=true;
    try{turn.controller&&turn.controller.abort('timeout');}catch(e){}
    log('turn_timeout',{turnId:turn.turnId});
    return true;
  }
  const isIntentionalCancel=turn=>!!turn&&turn.cancelled&&INTENTIONAL.has(turn.cancelReason);
  // ── bounded pending ordinary inputs ──
  function enqueue(entry){
    if(pending.length>=maxPending){log('pending_overflow',{inputId:entry.inputId,size:pending.length});return {ok:false,reason:'overflow',entry};}
    pending.push(entry);
    log('pending_enqueued',{inputId:entry.inputId,position:pending.length});
    return {ok:true,position:pending.length,entry};
  }
  function shiftPending(currentScopeKey){
    const rejected=[];
    while(pending.length){
      const entry=pending.shift();
      if(now()-entry.acceptedAt>pendingTtlMs){rejected.push({entry,reason:'expired'});log('pending_expired',{inputId:entry.inputId});continue;}
      if(scopeChanged(entry.scopeKey,currentScopeKey)){rejected.push({entry,reason:'scope_changed'});log('pending_scope_changed',{inputId:entry.inputId});continue;}
      log('pending_released',{inputId:entry.inputId});
      return {entry,rejected};
    }
    return {entry:null,rejected};
  }
  // ── PTT take identity ──
  function retire(c,kind){
    retired.set(c.captureId,kind);
    while(retired.size>retiredMax)retired.delete(retired.keys().next().value);
  }
  const find=id=>captures.find(c=>c.captureId===id)||null;
  function beginCapture(scopeKey,info){
    info=info||{};
    const bridgeId=typeof info.captureId==='string'&&info.captureId?info.captureId:null;
    if(bridgeId){
      const existing=find(bridgeId);
      if(existing){log('capture_begin_duplicate',{captureId:bridgeId});return bridgeId;}
      if(retired.has(bridgeId)){log('capture_begin_retired',{captureId:bridgeId});return null;}
    }
    // A down edge without a Bridge id (outdated Bridge) still opens a visible take, but no
    // terminal can ever be matched to it; it closes explicitly as lost.
    const c={captureId:bridgeId||('unidentified-'+(++unidentifiedSeq)),identified:!!bridgeId,
      bridgeEpoch:typeof info.bridgeEpoch==='string'?info.bridgeEpoch:null,scopeKey:key(scopeKey),
      state:'recording',startedAt:now(),stoppedAt:null,result:null};
    captures.push(c);
    log('capture_begin',{captureId:c.captureId,identified:c.identified,scopeKey:c.scopeKey});
    return c.captureId;
  }
  function stopCapture(id){
    const c=find(id);
    if(!c||c.state!=='recording')return false;
    c.state='stopped';c.stoppedAt=now();
    log('capture_stop',{captureId:id});
    return true;
  }
  function attachTerminal(kind,captureId,bridgeEpoch){
    const reject=reason=>{log('terminal_rejected',{kind,captureId:captureId||null,reason});return {ok:false,captureId:captureId||null,reason};};
    if(typeof captureId!=='string'||!captureId)return reject('unidentified_terminal');
    if(retired.has(captureId))return reject(retired.get(captureId)==='lost'?'late_after_lost':'duplicate_after_release');
    const c=find(captureId);
    if(!c)return reject('unknown_capture');
    if(!c.identified)return reject('unidentified_take');
    if(c.bridgeEpoch&&bridgeEpoch!==c.bridgeEpoch)return reject('epoch_mismatch');
    if(c.state!=='recording'&&c.state!=='stopped')return reject('duplicate_terminal');
    if(c.state==='recording'){c.stoppedAt=now();log('terminal_before_up',{captureId,kind});}
    c.state=kind==='audio'?'transcribing':'terminal';
    log('terminal_attached',{captureId,kind});
    return {ok:true,captureId,reason:null};
  }
  function release(currentScopeKey){
    const out=[];
    while(captures.length){
      const head=captures[0];
      if(head.state!=='resolved')break;
      captures.shift();
      const r=head.result;
      retire(head,r.kind);
      if(r.kind==='text'&&scopeChanged(head.scopeKey,currentScopeKey)){
        out.push({captureId:head.captureId,kind:'scope_changed',text:r.text});
        log('capture_released',{captureId:head.captureId,kind:'scope_changed'});
      }else{
        out.push({captureId:head.captureId,kind:r.kind,text:r.text||'',reason:r.reason||null});
        log('capture_released',{captureId:head.captureId,kind:r.kind});
      }
    }
    return out;
  }
  function resolveCapture(id,result,currentScopeKey){
    const c=find(id);
    if(!c||c.state==='resolved'||c.state==='recording'||c.state==='stopped'){
      log('capture_result_ignored',{captureId:id,reason:!c?(retired.has(id)?'duplicate_after_release':'unknown_capture'):c.state==='resolved'?'duplicate':'no_terminal_attached'});
      return {accepted:false,released:release(currentScopeKey)};
    }
    const kind=result&&['text','empty','error','diagnostic','lost'].includes(result.kind)?result.kind:'error';
    const text=kind==='text'?String(result.text||'').trim():'';
    c.state='resolved';c.result={kind:kind==='text'&&!text?'empty':kind,text,reason:result&&result.reason||null};
    log('capture_resolved',{captureId:id,kind:c.result.kind});
    return {accepted:true,released:release(currentScopeKey)};
  }
  // Owner-side terminal failure (e.g. the renderer could not send ptt_start): closes the take
  // explicitly as an error from any open state, so it can never block the press-order head.
  function failCapture(id,reason,currentScopeKey){
    const c=find(id);
    if(!c||c.state==='resolved'){
      log('capture_fail_ignored',{captureId:id,reason:!c?(retired.has(id)?'duplicate_after_release':'unknown_capture'):'duplicate'});
      return {accepted:false,released:release(currentScopeKey)};
    }
    c.stoppedAt=c.stoppedAt||now();
    c.state='resolved';c.result={kind:'error',text:'',reason:String(reason||'owner_error')};
    log('capture_failed',{captureId:id,reason:c.result.reason});
    return {accepted:true,released:release(currentScopeKey)};
  }
  function expireLostCaptures(currentScopeKey){
    const t=now();
    for(const c of captures){
      if(c.state==='stopped'&&t-c.stoppedAt>captureLostMs){
        c.state='resolved';c.result={kind:'lost',text:'',reason:c.identified?'no_bridge_terminal':'unidentified_bridge'};
        log('capture_lost',{captureId:c.captureId,identified:c.identified});
      }
    }
    return release(currentScopeKey);
  }
  return {accept,beginTurn,isCurrent,turnScopeStale,endTurn,cancelCurrent,timeoutTurn,isIntentionalCancel,
    currentTurn:()=>current,busy:()=>!!current,
    enqueue,shiftPending,pendingCount:()=>pending.length,pendingSnapshot:()=>pending.map(e=>({inputId:e.inputId,source:e.source,text:e.text})),
    beginCapture,stopCapture,attachTerminal,resolveCapture,failCapture,expireLostCaptures,
    captureSnapshot:()=>captures.map(c=>({captureId:c.captureId,state:c.state,identified:c.identified})),
    retiredSnapshot:()=>[...retired.entries()],
    trace:()=>trace.slice(),scopeChanged,maxPending};
}
const api={create,INTENTIONAL_CANCEL_REASONS:[...INTENTIONAL]};
if(typeof module==='object')module.exports=api;root.PitwallDriverInputArbiter=api;
})(typeof globalThis==='object'?globalThis:this);
