'use strict';
const assert=require('assert'),fs=require('fs'),layer=require('./desktop/luna-self-memory');
let pass=0;
function check(name,fn){try{fn();console.log('✅ '+name);pass++;}catch(e){console.error('❌ '+name+' -> '+e.message);process.exitCode=1;}}
const identity={userId:7,track:'Red Bull Ring',car:'Mercedes-AMG GT3 2020'};
const now=Date.parse('2026-08-26T08:00:00Z');
const observeTwice=(text1='次回からGAPは最新値を使って。',text2='GAP精度をもっと正確にして。')=>{
  const one=layer.observe([],text1,{...identity,sessionKey:'race-1'},now);
  return layer.observe(one.store,text2,{...identity,sessionKey:'race-2'},now+1);
};
check('assistant-authored reflection is never an input',()=>assert.strictEqual(layer.correctionFromDriver('前回の反省：GAP精度が不安定だった。'),null));
check('explicit driver correction is classified deterministically',()=>assert.strictEqual(layer.correctionFromDriver('次回からGAPは最新値を使って。').tag,'gap_accuracy'));
check('one observation remains inactive',()=>{const out=layer.observe([],'次回からGAPは最新値を使って。',identity,now);assert.strictEqual(out.reason,'candidate_observed');assert.strictEqual(layer.latest(out.store,identity,now+1),null);});
check('two observations require confirmation and remain inactive',()=>{const two=observeTwice();assert(two.proposal);assert.strictEqual(two.proposal.observed_count,2);assert.strictEqual(layer.latest(two.store,identity,now+2),null);});
check('rapid repeats in one session do not satisfy the threshold',()=>{const one=layer.observe([],'次回からGAPは最新値を使って。',{...identity,sessionKey:'race-1'},now);const two=layer.observe(one.store,'GAP精度をもっと正確にして。',{...identity,sessionKey:'race-1'},now+1000);assert.strictEqual(two.reason,'observation_too_close');assert.strictEqual(two.record.observed_count,1);});
check('driver confirmation is the only activation path',()=>{const two=observeTwice('次回から給油ウィンドウは先に伝えて。','給油ウィンドウをもっと早く伝えて。');const out=layer.confirm(two.store,two.proposal.memory_id,true,now+2);assert.strictEqual(out.reason,'activated');assert(layer.latest(out.store,identity,now+3));});
check('driver rejection prevents use',()=>{const two=observeTwice();const out=layer.confirm(two.store,two.proposal.memory_id,false,now+2);assert.strictEqual(out.reason,'rejected');assert.strictEqual(layer.latest(out.store,identity,now+3),null);});
check('rejected lesson is not proposed again',()=>{const two=observeTwice();const rejected=layer.confirm(two.store,two.proposal.memory_id,false,now+2);assert.strictEqual(layer.observe(rejected.store,'次回からGAPは最新値を使って。',identity,now+3).reason,'previously_rejected');});
check('legacy assistant-authored active record is never usable',()=>{const legacy={version:1,memory_id:'old',userId:7,track:identity.track,car:identity.car,text:'反省',tags:['gap_accuracy'],source:'assistant_debrief_reflection',recordedAt:new Date(now).toISOString(),status:'active',deleted:false};assert.strictEqual(layer.latest([legacy],identity,now+1),null);});
check('missing identity fails closed',()=>assert.strictEqual(layer.observe([],'次回からGAPは最新値を使って。',{userId:null,track:'RBR',car:'GT3'},now).reason,'identity_unavailable'));
check('different identity, stale and future records are rejected',()=>{const two=observeTwice();const rows=layer.confirm(two.store,two.proposal.memory_id,true,now+2).store;assert.strictEqual(layer.latest(rows,{...identity,track:'Suzuka'},now+3),null);assert.strictEqual(layer.latest(rows,identity,now+91*24*60*60*1000),null);assert.strictEqual(layer.latest(rows,identity,now-1),null);});
check('active correction can be deleted',()=>{const two=observeTwice();const active=layer.confirm(two.store,two.proposal.memory_id,true,now+2);const out=layer.remove(active.store,two.proposal.memory_id);assert(out.removed);assert.strictEqual(layer.latest(out.store,identity,now+3),null);});
check('candidate eviction preserves an older active correction',()=>{const two=observeTwice();let rows=layer.confirm(two.store,two.proposal.memory_id,true,now+2).store;for(let i=0;i<24;i++){const id={userId:7,track:'Track '+i,car:'Car '+i,sessionKey:'s'+i};rows=layer.observe(rows,'次回からGAPは最新値を使って。',id,now+100+i).store;}assert(layer.latest(rows,identity,now+1000));});
check('briefing is concise and operational',()=>assert.strictEqual(layer.briefingLine({text:'x',tags:['gap_accuracy']},'ja'),'前回の反省：GAP精度に課題があった。今回は最新値だけで判断する。'));
check('lapped-car briefing never echoes driver numbers or free text',()=>assert.strictEqual(layer.briefingLine({text:'次回から0.5秒以内で説明して',tags:['lapped_car_clarity']},'ja'),'前回の訂正：周回遅れと同一周回の車を明確に区別して伝える。'));
check('renderer wires capture, confirmation, deletion and output',()=>{const src=fs.readFileSync('desktop/renderer.html','utf8');assert(src.includes('handleLunaSelfMemoryInput(text)'));assert(src.includes("phase:'confirmation'"));assert(src.includes("phase:'delete'"));assert(src.includes("kind:'luna_self_memory'"));assert(!src.includes('saveLunaSelfReflection'));});
check('renderer disambiguates simultaneous self-memory and decision confirmations',()=>{const src=fs.readFileSync('desktop/renderer.html','utf8');assert(src.includes('pendingLunaSelfMemoryConfirmation&&pendingDecisionDispute&&(yes||no)'));assert(src.includes('confirmDecisionCorrection'));});
check('fuel-window correction arms deterministic watch',()=>assert(fs.readFileSync('desktop/renderer.html','utf8').includes('armed source=luna_self_memory')));
console.log(`\n${pass} checks passed`);
