#!/usr/bin/env node
'use strict';

const fs = require('fs');
const vm = require('vm');
const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');
const main = fs.readFileSync('desktop/main.js', 'utf8');
const bridge = fs.readFileSync('irsdk-bridge/bridge.py', 'utf8');
const prompts = fs.readFileSync('prompts.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');

let pass = 0, fail = 0;
function check(label, ok) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label);
  ok ? pass++ : fail++;
}

check('更新判定は旧Desktop名とNSIS Setup名の両方を認識',
  main.includes('(?:Desktop|Setup)-(\\d{8}-\\d{4})'));
check('ピット秒読みは100/50/20のみ',
  bridge.includes('for _mark in (100, 50, 20):')
  && !bridge.includes('for _mark in (150, 100, 50, 20):'));
check('停止後の余分なpit_box_stopを送らない',
  !bridge.includes("'trigger': 'pit_box_stop'"));
check('日本語の最終案内は「ボックスここ。」だけ',
  renderer.includes("case 'pit_box_here':   return `ボックスここ。`;")
  && renderer.includes("case 'pit_box_stop':   return ``;"));
check('不足解消後の燃料OK通知を配線',
  bridge.includes("'trigger': 'fuel_strategy_safe'")
  && bridge.includes("'critical_to_safe'")
  && renderer.includes("case 'fuel_strategy_safe':"));
check('レースとデブリーフの出力上限を縮小',
  renderer.includes("(selMode==='race' && isJP) ? 55")
  && renderer.includes("(selMode==='debrief' && isJP) ? 120"));
check('レース通常35字・戦略60字・デブリーフ70字を送信',
  renderer.includes("selMode==='race' ? (isStrategyQuestion ? 60 : 35)")
  && renderer.includes("selMode==='debrief' ? 70")
  && renderer.includes('max_chars:maxChars'));
check('サーバー側にもモード別文字数ハード上限',
  server.includes("mode === 'race' ? 60")
  && server.includes("mode === 'debrief' ? 70")
  && server.includes('limitReplyText(block.text, safeMaxChars)'));
check('ストリーミング本文も文単位で文字数制限',
  server.includes('emitCompleteSentences(false)')
  && server.includes('emitCompleteSentences(true)')
  && server.includes('safeMaxChars - unicodeLength(emittedText)'));
check('Lunaレースプロンプトにも35字・戦略60字を明記',
  prompts.includes('通常35文字以内。燃料・ピット・戦略への回答だけ60文字以内'));

const limiterFns = server.match(/function unicodeLength[\s\S]*?(?=\/\/ ── Chat proxy)/);
check('文字数ゲート関数を抽出', !!limiterFns);
if (limiterFns) {
  const limitCtx = {};
  vm.runInNewContext(limiterFns[0], limitCtx);
  const longReply = '現在のペースは安定しています。後方とのギャップも十分あります。タイヤも問題ありません。';
  const limited35 = limitCtx.limitReplyText(longReply, 35);
  check('35文字以内かつ文末で完結', Array.from(limited35).length <= 35 && /[。！？!?]$/.test(limited35));
  check('クライアントが大きな値を送ってもraceは60字',
    limitCtx.resolveReplyCharLimit({max_chars:999}, 'race') === 60);
  check('クライアント指定なしのraceは35字',
    limitCtx.resolveReplyCharLimit({}, 'race') === 35);
}
check('Lunaデブリーフは1〜2文・70文字以内',
  prompts.includes('返答は原則1〜2文・日本語70文字以内'));
check('通常会話の機械音フォールバックを抑止',
  renderer.includes('text-only; alien voice suppressed')
  && renderer.includes('emergencyFallback'));
check('Cloud TTSを短く再試行',
  renderer.includes('for(let attempt=1; attempt<=2; attempt++)')
  && renderer.includes("ttsEventLog('cloud_retry'"));
check('TTS成功ライフサイクルを診断ログへ記録',
  renderer.includes("ttsEventLog('cloud_ready'")
  && renderer.includes("ttsEventLog('cloud_playing'")
  && renderer.includes("ttsEventLog('cloud_ended'"));

const fn = renderer.match(/function normalizeLunaSpeech\(text\)\{[\s\S]*?\n\}/);
check('Luna最終話法ゲートを抽出', !!fn);
if (fn) {
  const ctx = {sel:'LunaJP', userName:'Yuji'};
  vm.runInNewContext(fn[0], ctx);
  const got = ctx.normalizeLunaSpeech('お前の敵はP4だった奴だ。バグかもしれん。');
  check('乱暴・男性的な語をTTS直前に除去',
    !/お前|奴|かもしれん|だ。/.test(got) && got.includes('Yuji'));
}

console.log(`\nBuild 232 hardening: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
