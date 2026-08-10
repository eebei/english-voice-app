#!/usr/bin/env node
'use strict';

const fs = require('fs');
const vm = require('vm');
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

const explicitFnSource = renderer.match(
  /function isExplicitMemoryRequest\(text\)\{[\s\S]*?\n\}/)?.[0] || '';
const memorySandbox = {};
vm.runInNewContext(explicitFnSource, memorySandbox);
const isExplicit = memorySandbox.isExplicitMemoryRequest;

check('明示保存動詞だけを検出',
  isExplicit('Luna、これは覚えて') === true
  && isExplicit('この設定を記憶して') === true
  && isExplicit("Don't forget this") === true);
check('次回・今後という通常発話では過発火しない',
  isExplicit('次回から2周早くピットで') === false
  && isExplicit('今後は集中する') === false
  && isExplicit('From now on we pit earlier') === false);
check('明示保存はcallAPIを待たせない',
  /explicitMemorySave = saveMemory\(\{force:true, reason:'explicit_request'\}\);/.test(renderer)
  && !/await saveMemory\(\{force:true, reason:'explicit_request'\}\)/.test(renderer)
  && /await callAPI\(inputSource==='ptt'\?'ptt':'typed', memoryStatus\)/.test(renderer));
check('保存中ステータスをcall単位でLLMへ注入',
  /async function callAPI\(inputSource, memoryStatus=''\)/.test(renderer)
  && /buildMemoryStatusNote\(_isJP_pre, memoryStatus\)/.test(renderer)
  && renderer.includes('バックグラウンドで保存処理中')
  && !renderer.includes('pendingMemoryStatus'));
check('非同期の保存結果は次のcallで一度だけ消費',
  /let memoryStatus = memorySaveReceipt;\s*memorySaveReceipt = '';/.test(renderer)
  && /memorySaveReceipt = saved \? 'saved' : 'failed'/.test(renderer));
check('保存失敗時の虚偽記憶を禁止',
  prompts.includes('記憶の誠実さ・最重要')
  && prompts.includes('MEMORY HONESTY — CRITICAL'));
check('デブリーフ自動蒸留はセッション中1回＋終了時',
  /selMode==='debrief' && !memorySavedThisSession && sessionMsgCount>=4/.test(renderer)
  && /debrief_checkpoint/.test(renderer));
check('セッション終了時にも強制保存',
  /saveMemory\(\{force:true, reason:'session_end'\}\)/.test(renderer));
check('保存成功後のみスナップショットを確定',
  /if\(!saveProfileVerified\(nextProfile\)\)[\s\S]*?return false;[\s\S]*?memorySavedThisSession=true;[\s\S]*?lastMemorySignature=signature;/.test(renderer));
check('記憶API停止時は15秒で保存失敗を確定',
  /setTimeout\(\(\)=>ctrl\.abort\(\),15000\)/.test(renderer)
  && /signal:ctrl\.signal/.test(renderer));
check('INACTIVE中の会話は通常応答のみ・記憶保存しない',
  /function canPersistMemory\(\)/.test(renderer)
  && /iracingLive && driverActivity==='INACTIVE_DRIVER' && selMode!=='debrief'/.test(renderer)
  && /if\(!canPersistMemory\(\)\) return false/.test(renderer));
check('数値を含む本人申告ルールを蒸留可能',
  prompts.includes('安全マージン0.8L')
  && prompts.includes('driver-stated operating rule'));
check('次回プロンプトへ過去メモを注入',
  /const actionableNotes=\(profile\.notes\|\|\[\]\)\.filter/.test(renderer)
  && /memoryLayer\.isStaleUnavailableNote/.test(renderer)
  && /actionableNotes\.join/.test(renderer)
  && /buildProfileNote\(profile\)/.test(renderer));

console.log(`\nPersistent Memory Wiring: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
