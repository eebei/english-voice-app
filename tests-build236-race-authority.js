#!/usr/bin/env node
'use strict';

const fs = require('fs');
const vm = require('vm');
const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');
let pass = 0, fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('✅ ' + name); }
  else { fail++; console.error('❌ ' + name); }
}

check('FINISHEDは直前Qualify summaryでなくRace live fallbackを使う',
  renderer.includes("if(driverActivity==='FINISHED') scheduleAutoDebrief(buildFallbackSessionSummary());")
  && !renderer.includes("if(driverActivity==='FINISHED') scheduleAutoDebrief(lastSessionSummary||buildFallbackSessionSummary());"));

const fallback = renderer.match(/function buildFallbackSessionSummary\(\)\{[\s\S]*?\n\}/);
check('Race fallback lapはlive lap/lap_completedの最大値',
  !!fallback && fallback[0].includes('Math.max(') && fallback[0].includes('total_laps:liveLap'));

const normalize = renderer.match(/function normalizeLunaSpeech\(text\)\{[\s\S]*?\n\}/);
check('Luna最終話法・安全ゲートを抽出', !!normalize);
if (normalize) {
  const ctx = { sel:'LunaJP', userName:'Yuji' };
  vm.runInNewContext(normalize[0], ctx);
  const got = ctx.normalizeLunaSpeech('データ受け取った。リミッターオフ。全開でいい。');
  const claim = renderer.match(/function hasTelemetryOwnedVehicleClaim\(text\)\{[\s\S]*?\n\}/);
  if(claim) vm.runInNewContext(claim[0], ctx);
  check('機械的データ文言を整え、車両状態はtruth gateへ委譲',
    !/データ受け取った/.test(got)
    && /データ来たよ/.test(got)
    && !!claim
    && ctx.hasTelemetryOwnedVehicleClaim(got));
  const ordinary = ctx.normalizeLunaSpeech('データ受け取ったら確認するね。ピット済んだら教えて。');
  check('通常文の一部へregexを過剰適用しない',
    ordinary.includes('データ受け取ったら')
    && ordinary.includes('ピット済んだら'));
}

check('燃料実測前のピット周回捏造を禁止',
  renderer.includes('measured_avg_l_per_lapまたはauthoritative_laps_to_finishが無いレース開始前は、ピット周回を絶対に提示するな。'));
const bridge = fs.readFileSync('irsdk-bridge/bridge.py', 'utf8');
check('残量5L警告も計算器が不足判定なら今周ピット',
  bridge.includes("'pit_required': _fuel_pit_required")
  && renderer.includes('d.pit_required')
  && renderer.includes('今周ピット。'));
check('fallback順位は数値へ正規化してからsanitize',
  !!fallback && fallback[0].includes('const livePosition=Number(')
  && fallback[0].includes('finish_pos:livePosition'));
check('未完stream tailを完成文の後へ送らない',
  server.includes("if (boundary < 0 && final && emittedText)"));

console.log(`\nBuild 236 race authority remediation: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
