#!/usr/bin/env node
'use strict';

const fs = require('fs');
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
  'コースイン。タイヤ注意。',
  'リミッターオフ。タイヤ冷えてる、慎重に。',
  '${npfx}挙動に異常ある？',
  '挙動に異常なければ継続。'
].forEach(text => check(`短い反射無線: ${text}`, renderer.includes(text)));

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

console.log(`\nRace Radio Brevity: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
