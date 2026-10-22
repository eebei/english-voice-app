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

check('Race FINISHEDは直前Qualify summaryでなくRace fallbackを使う',
  renderer.includes("driverActivity==='FINISHED' && String(lastSessionType||'').toLowerCase().includes('race')")
  && renderer.includes('scheduleAutoDebrief(buildFallbackSessionSummary());')
  && !renderer.includes("if(driverActivity==='FINISHED') scheduleAutoDebrief(lastSessionSummary||buildFallbackSessionSummary());"));

const fallback = renderer.match(/function buildFallbackSessionSummary\(\)\{[\s\S]*?\n\}/);
const sanitize = renderer.match(/function sanitizeSessionEvidence\(data\)\{[\s\S]*?\n\}/);
const fallbackContext={lastTelemetry:{lap:13,lap_completed:12},lastTrack:'Monza',lastCarClass:'GT3',
  lastCarModel:'Mercedes-AMG GT3',lastSessionType:'Race',sessionBestLapSeconds:114.835,
  validFinishPosition:()=>null,currentDebriefSourceIdentity:()=>({race_instance_id:'sub:current',session_num:2})};
if(fallback&&sanitize)vm.runInNewContext(sanitize[0]+'\n'+fallback[0],fallbackContext);
const provisional=fallbackContext.buildFallbackSessionSummary?.();
check('Race fallbackは走行中周を完了周・計測周に昇格しない（実関数）',
  !!provisional&&provisional.completed_laps===null&&provisional.recorded_lap_count===null&&provisional.total_laps===null
  &&provisional.race_instance_id==='sub:current'&&provisional.session_num===2);

const normalize = renderer.match(/function normalizeLunaSpeech\(text\)\{[\s\S]*?\n\}/);
check('Luna最終話法・安全ゲートを抽出', !!normalize);
if (normalize) {
  const ctx = { sel:'LunaJP', userName:'Yuji' };
  vm.runInNewContext(normalize[0], ctx);
  const got = ctx.normalizeLunaSpeech('データ受け取った。リミッターオフ。全開でいい。');
  const claim = renderer.match(/function hasTelemetryOwnedVehicleClaim\(text, includeStrategyNumbers=false\)\{[\s\S]*?\n\}/);
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
  ['measured_avg_l_per_lapまたはauthoritative_laps_to_finishが無い時、独自のピット周回を提示するな。',
    'canonical awaitingに既に登録されたprovisional_history_v1候補の説明と同意判定',
    'その同一decision IDの暫定案だけ', '変更はBridge再計算と再同意を要する',
    'ACK前に合意確定・登録済み・BOX実行を宣言するな',
    'The sole exception is explaining or judging consent for the exact provisional_history_v1 proposal already registered in canonical awaiting',
    'never announce acceptance, registration or BOX execution before its ACK'].every(s=>renderer.includes(s)));
const bridge = fs.readFileSync('irsdk-bridge/bridge.py', 'utf8');
check('残量5L警告も計算器が不足判定ならこの周でピット',
  bridge.includes("'pit_required': _fuel_pit_required")
  && renderer.includes('d.pit_required')
  && renderer.includes('この周でピット。'));
check('fallback順位は未確定としてfail-closed',
  !!fallback && !fallback[0].includes('const livePosition=Number(')
  && fallback[0].includes('finish_pos:null')
  && fallback[0].includes('finish_pos_confirmed:false'));
check('未完stream tailを完成文の後へ送らない',
  server.includes("if (boundary < 0 && final && emittedText)"));

console.log(`\nBuild 236 race authority remediation: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
