#!/usr/bin/env node
'use strict';
const fs=require('fs');
const B=require('./desktop/memory-brain.js');
let pass=0,fail=0;
function ck(name,ok,detail){(ok?console.log:console.error)((ok?'✅ ':'❌ ')+name+(ok?'':' -> '+JSON.stringify(detail)));ok?pass++:fail++;}
const identity={userId:77,custId:315555,track:'Circuit des 24 Heures du Mans',car:'Mercedes-AMG GT3 2020'};
const race={memory_id:'race|88462769|315555',userId:77,custId:315555,subsessionId:88462769,
  track:identity.track,car:identity.car,startPos:10,finishPos:8,startOverallPos:27,finishOverallPos:14,
  totalLaps:12,incidents:1,bestLap:'3:55.8245',iratingBefore:2027,iratingAfter:2077,sof:2018,
  planName:'A',planSuccess:true,pitEntryLap:6,pitExitLap:7,recordedAt:'2026-09-04T09:00:00Z'};
const debrief={memory_id:'debrief|88462769|315555',userId:77,custId:315555,track:identity.track,car:identity.car,
  driverStatement:'周囲が危険だったためレースをコントロールし、無理な追い抜きをしなかった。',recordedAt:'2026-09-04T09:10:00Z'};

const matches=B.search({raceHistory:[race],debriefRecords:[debrief]},identity);
const result=B.derive(matches);
ck('Le Mans固定session/userだけを取得',result.available&&matches.length===2,result);
ck('P10→P8・1x・+50・Plan Aを欠けずに統合',result.facts.start_class_pos===10&&result.facts.finish_class_pos===8
  &&result.facts.incidents===1&&result.facts.irating_delta===50&&result.facts.plan==='A'&&result.facts.plan_success===true,result.facts);
ck('本人説明と公式結果から「結果を持ち帰った走り」へ到達',result.assessment.controlled_risk&&result.assessment.brought_home_result,result.assessment);
ck('未計測のライン/メートル情報を生成しない',!/ライン|メートル/.test(JSON.stringify(result)));

// Required mutation oracles. Each broken link must lose a required outcome.
ck('変異: 検索を外すと利用不可',B.derive([]).available===false);
ck('変異: user identity変更で取得ゼロ',B.search({raceHistory:[race],debriefRecords:[debrief]},{...identity,userId:88}).length===0);
ck('変異: session owner(cust_id)変更で取得ゼロ',B.search({raceHistory:[race],debriefRecords:[debrief]},{...identity,custId:1}).length===0);
ck('変異: debrief削除で危険回避評価が成立しない',B.derive(B.search({raceHistory:[race]},identity)).assessment.brought_home_result===false);
const restarted=JSON.parse(JSON.stringify({raceHistory:[race],debriefRecords:[debrief]}));
ck('保存後の再起動相当でも再取得',B.derive(B.search(restarted,identity)).assessment.brought_home_result===true);
ck('Luna注入は使用memory IDと事実を含む',/race\|88462769/.test(B.promptBlock(result))&&/"positions_gained":2/.test(B.promptBlock(result)));
const evaluation=B.evaluationRecord(result,'危険を避けながらP10からP8、1xで+50を持ち帰った。判断は正しかった。',identity,Date.parse('2026-09-04T10:00:00Z'));
ck('実回答から使用memory IDへ逆引き',evaluation.source_memory_ids.includes(race.memory_id)&&evaluation.source_memory_ids.includes(debrief.memory_id),evaluation);
const next=B.search({raceHistory:[race],debriefRecords:[debrief],evaluations:JSON.parse(JSON.stringify([evaluation]))},identity);
ck('新評価を再保存し次ターンで再取得',next.some(x=>x.kind==='evaluation'&&x.memory_id===evaluation.memory_id));

const renderer=fs.readFileSync('./desktop/renderer.html','utf8');
const sendMsg=renderer.slice(renderer.indexOf('async function sendMsg('),renderer.indexOf('// ── Telemetry Truth Gate'));
ck('全質問の共通入口がintent分岐より前',sendMsg.indexOf('prepareMemoryBrain(text);')<sendMsg.indexOf('pendingConfirmationKinds()'));
ck('検索結果をcallAPIの実promptへ注入',renderer.includes('buildMemoryStatusNote(_isJP_pre, memoryStatus) + currentMemoryBrainPrompt()'));
ck('実回答出口で評価を再保存',renderer.includes('completeMemoryBrainTurn(display);'));
ck('local/定型回答も共通addMsg出口で評価を再保存',renderer.includes("type==='ai' && typeof completeMemoryBrainTurn==='function'"));
ck('実回答/TTS出口は従来どおり同じdisplayを使う',renderer.includes("recordLunaTurn(display, 'streamed_reply');")&&renderer.includes('if(bubble) bubble.textContent = display;'));
ck('使用memory IDの往路/復路traceがある',/phase:'search'/.test(renderer)&&/source_memory_ids:record.source_memory_ids/.test(renderer));
ck('完成asar対象としてruntime moduleを読む',renderer.includes('<script src="memory-brain.js"></script>'));

console.log(`\n[Memory Brain] 合格 ${pass}/${pass+fail}`);
process.exit(fail?1:0);
