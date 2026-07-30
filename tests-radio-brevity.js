#!/usr/bin/env node
'use strict';

const fs = require('fs');
const vm = require('vm');
const { buildSystem } = require('./prompts');
const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');
const prompts = fs.readFileSync('prompts.js', 'utf8');

let pass = 0;
let fail = 0;
function check(label, ok) {
  if (ok) {
    console.log(`✅ ${label}`);
    pass++;
  } else {
    console.error(`❌ ${label}`);
    fail++;
  }
}

[
  '2周連続ペースダウン。集中しよう。',
  '${npfx}大丈夫？ 車は動く？',
  'インシデントが多い。集中しよう。',
  'P${pos}。1つ後退。',
  '制限ライン注意、リミッターオン。',
  'リミッターオフ。タイヤ冷えてる、慎重に。',
  '${npfx}挙動に異常ある？',
  '挙動に異常なければ継続。'
].forEach(text => check(`短い反射無線: ${text}`, renderer.includes(text)));

check('pit_exit の直後フォローを削除',
  !renderer.includes('コースイン。タイヤ注意。')
  && renderer.includes("if(data.trigger==='pit_exit') return;"));
check('マルチクラス無線から「譲ろう」を撤廃',
  !renderer.includes('譲ろう'));

[
  '一度深呼吸しよう。焦らず、まだ戦える。確実に持ち帰ろう。',
  'トーイングで戻ってきて、そこから立て直そう',
  '抜かれたけど、まだ取り返せる',
  'コース状況確認とタイヤ熱入れしていこう',
  'そこまで支障なければ続けよう'
].forEach(text => check(`旧長文を撤廃: ${text}`, !renderer.includes(text)));

check('日本語LLMはF1型短文ルールを持つ',
  prompts.includes('【F1型の短い無線・最重要】')
  && prompts.includes('原則1文・1用件')
  && prompts.includes('最大2文'));
check('英語LLMも同じ短文契約を持つ',
  prompts.includes('[F1-STYLE SHORT RADIO — CRITICAL]')
  && prompts.includes('12 English words or fewer')
  && prompts.includes('at most two sentences'));
check('戦略の理解に必要な数値と条件は保持',
  prompts.includes('理解に必要な数値と条件は削るな')
  && prompts.includes('Never remove a number or condition needed to understand the plan'));
check('詳細説明はbriefing/debriefに限定',
  prompts.includes('ブリーフィングとデブリーフだけは詳しくてよい')
  && prompts.includes('Briefing and debrief may be detailed'));
check('短文ルール挿入は明示ヘッダー基準',
  prompts.includes("engineeringHeader, engineeringHeader + shortRadioRule")
  && !prompts.includes("engRules.replace('\\n',"));

check('Lunaは自然な女性標準語・乱暴な呼称を明示禁止',
  prompts.includes('【重要・話し方＝自然な女性の標準語】')
  && prompts.includes('「あんた」「お前」「〜しようや」「〜やろうや」「申し訳ねぇ」等')
  && prompts.includes('━━ Luna話法契約（最優先）━━'));
check('Lunaは短い自然な相槌だけ許可し第二助言を禁止',
  prompts.includes('「うん、」「そうね、」「その通りね、」')
  && prompts.includes('一般論・励まし・第二の助言を足すな'));

const lunaStrategySystem = buildSystem({
  character:'LunaJP', mode:'strategy', telemetry:'live',
  sessionAuthority:{track:'roadamerica full',car_model:'Mercedes-AMG GT3 2020',session_type:'Race'}
});
check('Luna strategy実生成から旧MAXフランク契約を除外',
  !!lunaStrategySystem
  && !lunaStrategySystem.prefix.includes('話し方＝MAXフランク')
  && !lunaStrategySystem.prefix.includes('タメ口で話せ。敬語は使うな')
  && !lunaStrategySystem.prefix.includes('あんたはどれに近い')
  && !lunaStrategySystem.prefix.includes('Lunaはタメ口')
  && !lunaStrategySystem.prefix.includes('気の置けないタメ口')
  && lunaStrategySystem.prefix.includes('落ち着いた女性の標準語'));

const stripFn = renderer.match(/function stripMarkdown\(t\)\{[\s\S]*?\n\}/);
check('TTS Markdown除去関数を抽出できる', !!stripFn);
if(stripFn){
  const sandbox={}; vm.createContext(sandbox); vm.runInContext(stripFn[0], sandbox);
  check('閉じ記号ありの太字を記号なしで読む',
    sandbox.stripMarkdown('**第一の失敗**') === '第一の失敗');
  check('stream分割された未閉じ太字も記号なしで読む',
    sandbox.stripMarkdown('**第一の失敗') === '第一の失敗');
  check('見出し・箇条書き記号を音声から除く',
    sandbox.stripMarkdown('## 結論\n- 確認') === '結論\n確認');
}

check('ブリーフィングに同条件前回結果の構造化判定を配線',
  renderer.includes('function buildPreviousRaceBriefingNote()')
  && renderer.includes('褒めてよい根拠:')
  && renderer.includes('previousRaceBriefing = buildPreviousRaceBriefingNote()')
  && renderer.includes('根拠がない美辞麗句は禁止'));
check('コース未確定時は前回履歴を選ばない',
  renderer.includes("if(!track) return '現在コース未確定。前回記録を選ばず、過去結果を作るな。';"));

check('起動挨拶からレース／テスト質問を廃止',
  !renderer.includes('Race or test drive today?')
  && !renderer.includes('今日はレース？それともテストドライブ？')
  && !renderer.includes('今日はレースか？テストドライブか？')
  && prompts.includes('━━ セッション種別の質問禁止（最優先）━━')
  && prompts.includes('CURRENT SESSIONの権威データをこちらから宣言する'));

console.log(`\nRace Radio Brevity: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
