#!/usr/bin/env node
'use strict';

const fs=require('fs');
const renderer=fs.readFileSync('desktop/renderer.html','utf8');
const auth=fs.readFileSync('auth.js','utf8');
const server=fs.readFileSync('server.js','utf8');
const dashboard=fs.readFileSync('public/revenue.html','utf8');
const vm=require('vm');

let pass=0,fail=0;
function check(label,ok){(ok?console.log:console.error)((ok?'✅ ':'❌ ')+label);ok?pass++:fail++;}

check('利用者が選ぶモードはRace WeekendとPracticeの2つ',
  renderer.includes("selectMode('race_weekend')")
  && renderer.includes("selectMode('practice')")
  && !renderer.includes('id="mode-race"')
  && !renderer.includes('id="mode-debrief"'));
check('RaceとDebriefは内部自動フェーズとして残す',
  renderer.includes("switchMode('race')")&&renderer.includes("switchMode('debrief')"));
check('Practice振り返りは6周または15分',
  renderer.includes('PRACTICE_REVIEW_MIN_LAPS=6')
  && renderer.includes('PRACTICE_REVIEW_MIN_TRACK_MS=15*60*1000'));
check('ガレージ45秒とPractice明示目的の両方が必要',
  renderer.includes('PRACTICE_REVIEW_GARAGE_DELAY_MS=45*1000')
  && renderer.includes("sessionPurpose!=='practice'")
  && renderer.includes("driverState==='garage'"));
check('再出走で保留中の振り返りを取り消す',
  renderer.includes('if(practiceRun.offerTimer){clearTimeout(practiceRun.offerTimer);practiceRun.offerTimer=null;}')
  && renderer.includes('practiceRun.offered=false;'));
check('手動ボタンと音声コマンドの両方を持つ',
  renderer.includes('onclick="startManualRunReview()"')
  && renderer.includes('startManualRunReview();\n    return;'));
check('走行中は手動振り返りを開始しない',
  renderer.includes("if(driverState==='track'||driverState==='pit')"));
check('非Practice summaryはPractice振り返りへ入れない',
  renderer.includes('if(!isPracticeSummary(data)) return;')
  && renderer.includes('!isPracticeSummary(data)||!practiceReviewEligible()'));

function extractFunction(name){
  const start=renderer.indexOf(`function ${name}(`);if(start<0)throw new Error(`${name} not found`);
  const brace=renderer.indexOf('{',start);let depth=0,quote=null,escaped=false;
  for(let i=brace;i<renderer.length;i++){
    const ch=renderer[i];
    if(quote){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch===quote)quote=null;continue;}
    if(ch==='\''||ch==='"'||ch==='`'){quote=ch;continue;}
    if(ch==='{')depth++;else if(ch==='}'&&--depth===0)return renderer.slice(start,i+1);
  }
  throw new Error(`${name} unterminated`);
}
const reviewContext={};vm.createContext(reviewContext);
vm.runInContext(`${extractFunction('isManualReviewCommand')};this.testReview=isManualReviewCommand;`,reviewContext);
check('音声命令は明示命令だけを実行し否定文を誤発火しない',
  reviewContext.testReview('Luna、デブリーフしよう')
  && reviewContext.testReview("Let's review")
  && !reviewContext.testReview('デブリーフはまだ始めなくていい')
  && !reviewContext.testReview('振り返りについて考えよう'));

const metrics=['practice_review_eligible','practice_review_offered','practice_review_started',
  'practice_review_completed','practice_review_saved','practice_review_manual'];
check('Practice利用メトリクスをDesktopから送信',
  metrics.every(k=>renderer.includes(k)));
check('Practice利用メトリクスをDBへ累積',
  metrics.every(k=>auth.includes(k))&&auth.includes('VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)'));
check('API入力でPractice利用メトリクスを検証',
  ['practiceReviewEligible','practiceReviewOffered','practiceReviewStarted',
   'practiceReviewCompleted','practiceReviewSaved','practiceReviewManual'].every(k=>server.includes(k)));
check('Revenue Dashboardで提案/完了/保存を表示',
  dashboard.includes('練習振返（提案/完了/保存）')
  && dashboard.includes('practice_review_offered')
  && dashboard.includes('practice_review_completed')
  && dashboard.includes('practice_review_saved'));

console.log(`\nPractice mode: ${pass}/${pass+fail}`);
if(fail)process.exit(1);
