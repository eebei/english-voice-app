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

const claimFn = renderer.match(/function hasTelemetryOwnedVehicleClaim\(text, includeStrategyNumbers=false\)\{[\s\S]*?\n\}/);
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
  check('戦略質問中の数値断定を遮断',
    context.hasTelemetryOwnedVehicleClaim('あと30L必要。', true));
  check('リッター表記の数値断定も遮断',
    context.hasTelemetryOwnedVehicleClaim('2リッター足りない。', true));
  check('自由会話が作った前方ギャップを遮断',
    context.hasTelemetryOwnedVehicleClaim('前0.6。詰まってきてる。', true));
  check('自由会話が作った順位を遮断',
    context.hasTelemetryOwnedVehicleClaim('現在P3。', true));
  check('自由会話が作ったラップタイムを遮断',
    context.hasTelemetryOwnedVehicleClaim('ベスト1:48.1。', true));
  check('通常会話の「1周目」は遮断しない',
    !context.hasTelemetryOwnedVehicleClaim('落ち着いて1周目を刻もう。'));
  [
    'うん、ボックス準備。',
    'この周ボックスね。',
    'Box prepared.',
    '前方停止車まで100メートル。',
    'リミッターオフにはしないで。',
    'Pit exit is not yet active.',
  ].forEach(text=>check('作戦・準備発話は許可: '+text,
    !context.hasTelemetryOwnedVehicleClaim(text)));
}

const truthFallbackFn = renderer.match(/function telemetryTruthFallback\(live, userText, isJP\)\{[\s\S]*?\n\}/);
check('Truth Gateの再計算fallbackを抽出', !!truthFallbackFn);
if(truthFallbackFn){
  const context={fmtDuration:()=>'',lastWeekendAuthority:null,sel:'LunaJP'};
  vm.runInNewContext(truthFallbackFn[0], context);
  const reply=context.telemetryTruthFallback({
    fuel:12.83,
    fuel_strategy:{required_fuel_l:13.613,margin_l:-0.783,estimated_crossings_to_finish:4},
  },'2リッター 足りないってこと？',true);
  check('遮断後は最新値で不足量と給油設定を言い直す',
    /2リットル不足という意味ではない.*現在12\.8リットル.*13\.6リットル必要.*0\.8リットル不足.*1リットル/.test(reply));
  check('完走目標をtruth-gateが否定しない',
    context.telemetryTruthFallback({}, '無事完走を目指す。', true)==='うん、完走しよう。インシデントゼロでいこう。');
  check('フロントのフィーリングをtruth-gateが否定しない',
    context.telemetryTruthFallback({}, 'フロントが食わないな。', true)==='了解。無理に押さず、次の確認でフロントの状態を見よう。');
}

const lapFn = renderer.match(/function lapTimeSpeechJP\(value\)\{[\s\S]*?\n\}/);
check('日本語ラップ発話関数を抽出', !!lapFn);
if(lapFn){
  const context={};
  vm.runInNewContext(lapFn[0], context);
  check('1分台も無線で分を保持',
    context.lapTimeSpeechJP('1:48.867') === '1分48秒867');
  check('1:06.630の日付誤読を避ける',
    context.lapTimeSpeechJP('1:06.630') === '1分6秒630');
  check('小数1桁もミリ秒へ正規化',
    context.lapTimeSpeechJP('1:48.1') === '1分48秒100');
  check('1:00.542は分を残す',
    context.lapTimeSpeechJP('1:00.542') === '1分0秒542');
  check('2分以上は分を残す',
    context.lapTimeSpeechJP('2:14.321') === '2分14秒321');
}

const speechFns = renderer.match(/function numberWordsEN\(n\)\{[\s\S]*?function phonetify\(text, lang\)\{[\s\S]*?\n\}/);
check('全言語TTSラップ変換関数を抽出', !!speechFns);
if(speechFns){
  const context={};
  vm.runInNewContext(speechFns[0], context);
  const cases=[
    ['ja-JP','ベスト 1:48.867','ベスト 1分48秒867'],
    ['ja-JP','ベスト 1:48.1','ベスト 1分48秒100'],
    ['ja-JP','ベスト 2:00.542','ベスト 2分0秒542'],
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
  renderer.includes("selMode==='race' && iracingLive && hasTelemetryOwnedVehicleClaim(full, true)")
  && renderer.includes("diagnosticLog('TELEMETRY_TRUTH_GATE'"));
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

// ★Build 266 Codex 差戻し⑤：質問と無関係な定型文("次のS/Fで燃料、残り、前後GAPを更新する")を
//   telemetryTruthFallback のデフォルト分岐から除去したことを確認する。
check('truth-gateデフォルト分岐から無関係な定型文が消えている',
  !renderer.includes('今は確認できる数値だけで答える。次のS/Fで燃料、残り、前後GAPを更新する。')
  && !renderer.includes('I will use only confirmed values and update fuel, remaining distance and gaps at the next S/F crossing.'));
check('truth-gateはドライバーの目標やフィーリングを否定しない',
  renderer.includes('うん、完走しよう。インシデントゼロでいこう。')
  && renderer.includes('了解。無理に押さず、次の確認でフロントの状態を見よう。')
  && renderer.includes('了解。いまは数値が揃った時だけコールする。'));

console.log(`\nTelemetry Truth Gate: ${pass}/${pass + fail}`);
if(fail) process.exit(1);
