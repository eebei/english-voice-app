'use strict';
const assert=require('assert'),M=require('./desktop/session-memory'),R=require('./desktop/local-intent-router');
const now=Date.parse('2026-10-24T12:00:00Z');
const id={userId:null,ownerRef:'access:self',custId:315555,track:'Circuit Gilles Villeneuve',car:'Mercedes-AMG GT3 2020'};
const row={raceRecordId:'race:yesterday',race_instance_id:'sub:89577642',sessionNum:2,custId:315555,userId:null,
  recordedAt:'2026-10-23T10:00:00Z',date:'2026-10-23',sessionType:'Race',track:id.track,car:id.car,
  pitEvents:[{entry_lap:13,fuel_added_l:10.19},{entry_lap:20,fuel_added_l:5.79}],totalLaps:22,finishPos:20};
let checks=0;const check=(x,m)=>{assert(x,m);checks++;};
const request=(q,p)=>M.historicalRequest(q,p,now);
const recall=(q,rows=[row],identity=id)=>M.recallRace(rows,identity,request(q),'ja',now);
let a=recall('昨日のレースは何週目にピットインした？何回で何位？');
check(a.reply.includes('13・20周目')&&a.reply.includes('2回')&&a.reply.includes('P20'),'all requested saved facts');
check(!a.reply.includes('48.0L'),'no present-fuel substitution');
const next=request('そうそう、それで何周目にピット？',a.request);
check(next.recordId===row.raceRecordId&&next.requestedDay==='2026-10-23','short follow-up retains exact race');
check(M.recallRace([row],id,next,'ja',now).reply.includes('13・20周目'),'follow-up consumes same record');
for(const q of ['今は何周目にピット？','今は燃料いくつ？','このレースは何周？','現在の燃料は？','昨日じゃなく今日の燃料は？','燃料は最後まで持つ？','次の周でピットに入る。'])
  check(!request(q,a.request),'explicit present/command clears history: '+q);
for(const q of ['昨日の路面温度は？','前回給油は？']) {
  const old=Date.now;Date.now=()=>now;
  try{const out=R.route({text:q,lang:'ja',live:{cust_id:315555,track:id.track,car_model:id.car},sessionMemory:M,raceHistory:[row],memoryIdentity:id});check(out.intent!=='historical_race_recall','specialist contract kept: '+q);}finally{Date.now=old;}
}
for(const change of [{custId:999},{userId:'another'},{owner_ref:'access:other'},{deleted:true},{disputed:true},
  {recordedAt:'2020-01-01T00:00:00Z'},{recordedAt:'2027-01-01T00:00:00Z'},{sessionType:'Qualify'},
  {date:'2026-10-22',recordedAt:'2026-10-22T10:00:00Z'},{raceRecordId:null}])check(!recall('昨日のレースのデータ',[{...row,...change}]).record,'reject foreign/stale/inapplicable '+JSON.stringify(change));
const undatedPast=request('前回のレースは何周目にピット？');
check(undatedPast.requestedDay===null,'expiry check has no requested-day mismatch');
const aged=days=>({...row,recordedAt:new Date(now-days*86400000).toISOString()});
check(!M.recallRace([aged(91)],id,undatedPast,'ja',now).record,'explicit past recall rejects 91-day record without a date filter');
check(M.recallRace([aged(89)],id,undatedPast,'ja',now).record?.raceRecordId===row.raceRecordId,'same identity/source within 90 days remains usable');
check(!recall('昨日のレースのデータ',[row],{...id,custId:null}).record,'unknown driver rejected');
check(recall('昨日のレースのデータ',[{...row,track:'Monza',car:'Other car'}]).record,'factual recall can name another track/car');
check(!recall('昨日このコースのレースのデータ',[{...row,track:'Monza'}]).record,'explicit same-track restriction');
check(!recall('前回のレースのデータ',[row],{...id,currentRaceInstanceId:row.race_instance_id}).record,'current race is not previous race');
const morning={...row,raceRecordId:'morning',recordedAt:'2026-10-24T23:00:00Z',date:'2026-10-24'};
const morningNow=Date.parse('2026-10-24T23:30:00Z');
if(new Date(morningNow).getHours()===8)check(M.recallRace([row,morning],id,M.historicalRequest('昨日のレースの結果は？',null,morningNow),'ja',morningNow).record?.raceRecordId!==morning.raceRecordId,'JST yesterday never selects this morning UTC-slice date');
check(!recall('昨日のレースのデータ',[]).reply.includes('Plan A'),'missing saved record is not a current strategy');
const review={owner_ref:id.ownerRef,custId:id.custId,race_instance_id:row.race_instance_id,session_num:2,
  qa:[{question:'反省点は？',answer:'後ろからの接触でコースアウトした。'}],
  conversation:[{role:'assistant',text:'次回は給油案を早めに相談しよう。'}]};
a=M.recallRace([row],id,request('昨日のレースの反省点と助言は？'),'ja',now,[review]);
check(a.reply.includes('Driver申告')&&a.reply.includes('接触'),'driver report retrieved with source role');
check(a.reply.includes('LUNAの助言（未検証）'),'old assistant advice is not measured truth');
check(!M.recallRace([row],id,request('昨日の反省点は？'),'ja',now,[{...review,owner_ref:'other'}]).reply.includes('接触'),'foreign debrief rejected');
const old=Date.now;Date.now=()=>now;
try{
 a=R.route({text:'昨日のレースは何週目にピットインした？何回で何位？',lang:'ja',live:{cust_id:315555,fuel:48},sessionMemory:M,raceHistory:[row],memoryIdentity:id});
 check(a.source==='race_history'&&a.bindingKind==='conversation_scope','stored race reaches historical speech contract');
 check(!a.action&&a.raceRecordId===row.raceRecordId&&!!a.memoryFingerprint,'reference retained without execution');
 check(!R.route({text:'会話が成立しないで君、全く。',lang:'ja',live:{cust_id:315555}}).handled,'conversation complaint is not a calm-down race comment');
}finally{Date.now=old;}
console.log('Historical race recall '+checks+' checks PASS; paid API calls 0');
