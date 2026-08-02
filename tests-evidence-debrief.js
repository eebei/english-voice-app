#!/usr/bin/env node
'use strict';

const fs = require('fs');
const vm = require('vm');
const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');
const bridge = fs.readFileSync('irsdk-bridge/bridge.py', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');

let pass=0, fail=0;
function check(label, ok){
  (ok?console.log:console.error)((ok?'✅ ':'❌ ')+label);
  ok?pass++:fail++;
}

check('RaceのFINISHEDだけsummary欠落時も自動デブリーフへ到達',
  renderer.includes("driverActivity==='FINISHED' && String(lastSessionType||'').toLowerCase().includes('race')")
  && renderer.includes('scheduleAutoDebrief(buildFallbackSessionSummary())'));
check('SessionNum変更でセッション単位のデブリーフ状態を再武装',
  renderer.includes('function resetSessionScopedReviewState()')
  && renderer.includes('nextSessionNum!==lastSessionNum')
  && renderer.includes('autoDebriefStarted=false;'));
check('最終順位はconfirmedだけを表示しlive順位で補完しない',
  renderer.includes('clean.finish_pos_confirmed=clean.finish_pos_confirmed===true;')
  && renderer.includes('clean.finish_pos=clean.finish_pos_confirmed?validFinishPosition(clean.finish_pos):null;')
  && renderer.includes('finish_pos_confirmed:false'));
check('FINISHED後着summaryを完全データへ差し替える',
  renderer.includes('autoDebriefData=data;')
  && renderer.includes('data=sanitizeSessionEvidence(data);')
  && renderer.includes('const reviewData=autoDebriefData||data||buildFallbackSessionSummary();')
  && renderer.includes('function reconcileEvidenceSummary(data)'));
check('自動デブリーフは8秒後にdebriefへ切替',
  renderer.includes("switchMode('debrief')")
  && renderer.includes('},8000);'));
check('Practice/Qualifyは任意レビューカードを表示',
  renderer.includes('function offerSessionReview(data)')
  && renderer.includes('Practice / Qualifying evidence ready'));
check('必須Q&Aは一問ずつ回答を記録',
  renderer.includes('function recordEvidenceAnswer(text)')
  && renderer.includes('askEvidenceQuestion()'));
check('結果帯別の具体質問をローテーション',
  renderer.includes('raceTop:') && renderer.includes('raceMid:') && renderer.includes('raceLow:')
  && renderer.includes('pickRotatingQuestion(resultPool)')
  && renderer.includes("history.slice(-3).includes(q)"));
check('製品評価は低頻度で提示し回答有無だけ中央計測',
  renderer.includes('function shouldAskProductFeedback()')
  && renderer.includes('7*24*60*60*1000')
  && renderer.includes("usageCount('feedback_prompted')")
  && renderer.includes("usageCount('feedback_answered')"));
check('デブリーフ導線を提示・開始・完了・中断で計測',
  ['debrief_offered','debrief_started','debrief_completed','debrief_dismissed']
    .every(k=>renderer.includes(`usageCount('${k}')`)));
check('保存前に本人確認ボタンを要求',
  renderer.includes('confirmEvidenceMemory()')
  && renderer.includes("confidence:'confirmed_by_driver'"));
check('質問途中でも終了できRace復帰時はガイドを解除',
  renderer.includes('id="debrief-guide-cancel"')
  && renderer.includes("if(newMode==='race' && evidenceDebrief) dismissEvidenceDebrief();"));
check('guided PTT/typed回答も利用量を計測',
  renderer.includes("usageCount(inputSource==='ptt'?'ptt':'typed');\n    recordEvidenceAnswer(text);"));
check('rapid PTTは次質問の回答枠へ進めない',
  renderer.includes('evidenceDebrief.acceptAfter=Date.now()+1200;')
  && renderer.includes("kind:'debrief_question'")
  && renderer.includes("speakQueue.some(q=>q && q.kind==='debrief_question')")
  && renderer.includes('if(isSpeaking || questionPending || Date.now() < (evidenceDebrief.acceptAfter||0))'));
const recordFn = renderer.match(/function recordEvidenceAnswer\(text\)\{[\s\S]*?\n\}/);
if(recordFn){
  const rapidContext={
    evidenceDebrief:{active:true,index:0,acceptAfter:0,answers:[],questions:['Q1','Q2','Q3']},
    speakQueue:[{kind:'debrief_question'}],isSpeaking:false,Date,
    addMsg:()=>{},askEvidenceQuestion:()=>{},document:{getElementById:()=>({})},
    pushMsg:()=>{},speak:()=>{},evidenceCopy:()=>({wait:'wait'})
  };
  vm.runInNewContext(recordFn[0],rapidContext);
  rapidContext.recordEvidenceAnswer('連打回答');
  check('実コードで質問待機中の回答indexは進まない',rapidContext.evidenceDebrief.index===0);
}else{
  check('実コードで質問待機中の回答indexは進まない',false);
}
check('個人・コース・車両スコープを保持',
  renderer.includes('driver:userName')
  && renderer.includes('track:memoryTrack')
  && renderer.includes('car:memoryCar'));
check('保存側もdriver/track/car欠損をfail-closed',
  renderer.includes('if(!userName || !memoryTrack || !memoryCar)'));
check('破損localStorageは対象keyだけ自動復旧',
  renderer.includes('function loadEvidenceRecords()')
  && renderer.includes('localStorage.removeItem(key)'));
check('保存済み証拠を次回同条件のプロンプトへ配線',
  renderer.includes('buildSessionEvidenceNote()')
  && renderer.includes('Confirmed evidence from matching sessions')
  && renderer.includes('同条件の本人確認済みセッション証拠'));
check('ドライバー・コース・車両が未確定ならmemory参照をfail-closed',
  renderer.includes("if(!userName || !track || !car) return '';")
  && renderer.includes('if(r.driver!==userName) return false;')
  && renderer.includes('return rt===track && rc===car;'));
check('記憶は90日で失効し現在の結論として扱わない',
  renderer.includes('const maxAgeMs=90*24*60*60*1000;')
  && renderer.includes('現在も正しいという結論ではない')
  && renderer.includes('not proof that it is still true'));
check('停止・グリッドでは発話安全窓を無効化',
  bridge.includes('_speech_speed >= 5.0')
  && bridge.includes('_set_speak_gate(speak_window_ok, _speech_gate_active)'));
check('Speed/操作値欠損は走行中fail-safe',
  bridge.includes('_speech_speed is None or _speech_speed >= 5.0')
  && bridge.includes('_speech_controls_known'));
check('デブリーフ切替時に保留音声を解放',
  renderer.includes('speakGateActive=false; speakWindowOk=true; drainQueue();'));
check('モード切替では古い通常発話を捨て安全手順だけ保持',
  renderer.includes('q.prio<=SPEAK_PRIO.P1_HAZARD || q.immediate===true')
  && renderer.includes('currentSpeakPrio>SPEAK_PRIO.P1_HAZARD'));
check('完成文があれば次文を途中で切らない',
  server.includes('if (emittedText && unicodeLength(sentence) > remaining)'));
check('社外秘の内部名称をUI・実装へ露出しない',
  !renderer.includes(['PITWALL','Q&A','Memory'].join(' '))
  && !bridge.includes(['PITWALL','Q&A','Memory'].join(' ')));

console.log(`\nEvidence debrief: ${pass}/${pass+fail}`);
if(fail) process.exit(1);
