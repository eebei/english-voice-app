(function(root){'use strict';
const stable=v=>v&&typeof v==='object'?(Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}'):JSON.stringify(v);
const key=(kind,p)=>kind+'|'+p.bridge_process_epoch+'|'+(kind==='box_delivery_report'?'report:'+p.report_event_id:p.cmd==='driver_plan_reason'?'reason:'+p.reason_event_id:'command:'+p.command_id);
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function create(api,onFailure=()=>{}){let state={outbox:[],attempts:[],receipts:[]},healthy=false,error=null,revision=null;function apply(r){if(r?.ok===true&&(!Number.isInteger(r.revision)||r.revision<0||!r.data||Object.keys(r.data).sort().join(',')!=='attempts,outbox,receipts'||!['outbox','attempts','receipts'].every(k=>Array.isArray(r.data[k]))))r={ok:false,error:'journal_response_invalid'};if(!r||r.ok!==true){healthy=false;error=r?.error||'journal_unavailable';onFailure(error);return false;}state=freeze(r.data);revision=r.revision;healthy=true;return true;}
try{apply(api?.criticalJournalLoad?.());}catch(e){apply({error:String(e)});}
function operation(op){if(!healthy)return false;try{return apply(api.criticalJournalTransact({...op,expected_revision:revision}));}catch(e){return apply({error:String(e)});}}
return {healthy:()=>healthy,error:()=>error,entries:kind=>state.outbox.filter(e=>e.kind===kind),attempts:()=>state.attempts,put:(kind,payload)=>operation({action:'put',kind,payload}),retire:(kind,payload,ack)=>operation({action:'retire',key:key(kind,payload),payload,ack}),attempt:value=>operation({action:'attempt',value}),hasAttempt:(epoch,id)=>state.attempts.some(e=>e.bridge_process_epoch===epoch&&e.attempt.attempt_id===id),key,stable};}
const api={create,key,stable};if(typeof module==='object')module.exports=api;root.PitwallCriticalJournal=api;
})(typeof globalThis==='object'?globalThis:this);
