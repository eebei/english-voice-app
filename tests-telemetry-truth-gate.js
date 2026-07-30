#!/usr/bin/env node
'use strict';

const fs = require('fs');
const vm = require('vm');
const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');
const bridge = fs.readFileSync('irsdk-bridge/bridge.py', 'utf8');
const prompts = fs.readFileSync('prompts.js', 'utf8');

let pass = 0, fail = 0;
function check(label, ok) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label);
  ok ? pass++ : fail++;
}

const claimFn = renderer.match(/function hasTelemetryOwnedVehicleClaim\(text\)\{[\s\S]*?\n\}/);
check('車両状態claim検出関数を抽出', !!claimFn);
if(claimFn){
  const context={};
  vm.runInNewContext(claimFn[0], context);
  [
    'ボックスアウト。リミッターオフ。',
    'まだ中だね。給油中。',
    'Box here. Limiter on.',
    'Refuelling now.',
    'ピットまで100メートル。',
  ].forEach(text=>check('誤った状態遷移を遮断: '+text,
    context.hasTelemetryOwnedVehicleClaim(text)));
  [
    'うん、ボックス準備。',
    'この周ボックスね。',
    'あと30L必要。',
    'Box prepared.',
    '前方停止車まで100メートル。',
    'リミッターオフにはしないで。',
    'Pit exit is not yet active.',
  ].forEach(text=>check('作戦・準備発話は許可: '+text,
    !context.hasTelemetryOwnedVehicleClaim(text)));
}

const lapFn = renderer.match(/function lapTimeSpeechJP\(value\)\{[\s\S]*?\n\}/);
check('日本語ラップ発話関数を抽出', !!lapFn);
if(lapFn){
  const context={};
  vm.runInNewContext(lapFn[0], context);
  check('1:48.867を完全発話へ変換',
    context.lapTimeSpeechJP('1:48.867') === '1分48秒867');
  check('1:06.630の日付誤読を避ける',
    context.lapTimeSpeechJP('1:06.630') === '1分6秒630');
}

const speechFns = renderer.match(/function numberWordsEN\(n\)\{[\s\S]*?function phonetify\(text, lang\)\{[\s\S]*?\n\}/);
check('全言語TTSラップ変換関数を抽出', !!speechFns);
if(speechFns){
  const context={};
  vm.runInNewContext(speechFns[0], context);
  const cases=[
    ['ja-JP','ベスト 1:48.867','ベスト 1分48秒867'],
    ['en-GB','Best 1:48.867','Best one forty-eight point eight six seven'],
    ['de-DE','Bestzeit 1:48.867','Bestzeit eins achtundvierzig Komma acht sechs sieben'],
    ['pt-BR','Melhor 1:48.867','Melhor um quarenta e oito vírgula oito seis sete'],
  ];
  cases.forEach(([lang,input,expected])=>{
    const actual=context.phonetify(input,lang);
    check(`${lang} TTSからコロンを除去`, actual===expected && !actual.includes(':'));
  });
}

check('stream発話前にtruth gateを適用',
  renderer.includes("selMode==='race' && iracingLive && hasTelemetryOwnedVehicleClaim(full)")
  && renderer.includes("convoLog('driver', '[TELEMETRY_TRUTH_GATE]"));
check('bridgeがピット状態のSDK証拠を配信',
  bridge.includes("'on_pit_road': bool(onPit)")
  && bridge.includes("'player_track_surface': player_track_surface")
  && bridge.includes("'pit_service_status': pit_service_status"));
check('ラップ表示は完全なM:SS.mmm',
  bridge.includes('fmt_time(seconds) if seconds >= 60')
  && bridge.includes("'time_seconds': round(lapTime, 3)"));
check('プロンプトもSDK固定無線の権限境界を明記',
  prompts.includes('【車両状態の権限境界・最優先】')
  && prompts.includes('[VEHICLE-STATE AUTHORITY — HIGHEST PRIORITY]'));
check('Lunaの自然な一言と第二助言禁止',
  prompts.includes('「うん、」「そうね、」「その通りね、」')
  && prompts.includes('一般論・励まし・第二の助言を足すな'));

const {buildSystem}=require('./prompts');
const authority={track:'monza',car_model:'Mercedes-AMG GT3',session_type:'Race'};
const oishiSystem=buildSystem({character:'Oishi',mode:'race',telemetry:'live',
  sessionAuthority:authority,liveData:{best:108.867}});
const jamesSystem=buildSystem({character:'James',mode:'race',telemetry:'live',
  sessionAuthority:authority,liveData:{best:108.867}});
check('Oishi実生成promptから秒だけ規則を除去',
  !oishiSystem.prefix.includes('タイムは秒だけ言え')
  && oishiSystem.prefix.includes('タイムは完全な分:秒.ミリ秒'));
check('EN実生成promptは完全タイムへ一本化',
  jamesSystem.suffix.includes('[Preserve the complete lap time]')
  && !jamesSystem.suffix.includes('just the seconds')
  && !jamesSystem.suffix.includes('Never write a lap time with a colon'));
check('全キャラ相槌禁止を復元しLunaだけ例外',
  jamesSystem.prefix.includes('No acknowledgement fillers')
  && !jamesSystem.prefix.includes('No mechanical acknowledgement fillers'));
for(const character of ['James','Luna','Hajime','Kanbe','Oishi','HajimeJP','LunaJP','Matthias','Camila']){
  const system=buildSystem({character,mode:'race',telemetry:'live',
    sessionAuthority:authority,liveData:{best:108.867}});
  check(`${character}実生成promptに旧タイム/相槌規則なし`,
    !!system
    && !system.prefix.includes('タイムは秒だけ言え')
    && !system.prefix.includes('No mechanical acknowledgement fillers')
    && !system.suffix.includes('just the seconds')
    && !system.suffix.includes('Never write a lap time with a colon'));
}

console.log(`\nTelemetry Truth Gate: ${pass}/${pass + fail}`);
if(fail) process.exit(1);
