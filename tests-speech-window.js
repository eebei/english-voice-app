#!/usr/bin/env node
'use strict';

const fs = require('fs');
const vm = require('vm');
const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');
const bridge = fs.readFileSync('irsdk-bridge/bridge.py', 'utf8');

let pass = 0, fail = 0;
function check(label, ok) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label);
  ok ? pass++ : fail++;
}

check('安全窓は舵角0.12rad未満かつブレーキ12%未満',
  bridge.includes('SPEAK_STEER_RAD = 0.12')
  && bridge.includes('SPEAK_BRAKE_TH  = 0.12')
  && bridge.includes('(_steer_abs < SPEAK_STEER_RAD)')
  && bridge.includes('(_brake_now < SPEAK_BRAKE_TH)')
  && bridge.includes('_speech_controls_known'));
check('bridgeは安全窓の変化をrendererへ通知',
  bridge.includes("'type': 'speak_gate'")
  && bridge.includes("'window_ok': bool(window_ok)")
  && bridge.includes("'active': bool(active)"));
check('INACTIVE_DRIVER中も安全窓メタデータは遮断しない',
  bridge.includes("'driver_state', 'driver_activity', 'speak_gate', 'lap_sectors'"));
check('renderer再接続時にも現在の安全窓を同期',
  bridge.includes("await websocket.send(json.dumps({'type': 'speak_gate'"));
check('即時ピット手順のホワイトリスト',
  renderer.includes("'pit_entry','limiter_off','pit_box_here','pit_box_countdown'")
  && !renderer.includes("'pit_entry','limiter_off','pit_box_here','pit_box_stop','pit_box_countdown'"));
check('P0/P1または期限付きピット手順だけimmediate',
  renderer.includes('immediate:(prio<=SPEAK_PRIO.P1_HAZARD || IMMEDIATE_PIT_KINDS.has(kind))'));
check('通常の会話継続チャンクはimmediateではない',
  renderer.includes("kind:'reply_chunk', ts:Date.now(), dedupeKey:null, immediate:false"));
check('閉窓中は開始可能な即時発話だけをキューから選ぶ',
  renderer.includes('nextIndex = speakQueue.findIndex(q=>speechMayStart(q));')
  && renderer.includes('if(nextIndex < 0) return;')
  && renderer.includes('speakQueue.splice(nextIndex,1)[0]'));
check('安全窓が開いたら保留キューを再開',
  renderer.includes('if(!speakGateActive || speakWindowOk) drainQueue();'));

const fn = renderer.match(/function speechMayStart\(item\)\{[\s\S]*?\n\}/);
check('speechMayStart本番関数を抽出できる', !!fn);
if (fn) {
  const context = {speakGateActive:true, speakWindowOk:false};
  vm.runInNewContext(fn[0], context);
  check('閉窓中の通常回答は保留', context.speechMayStart({immediate:false}) === false);
  check('閉窓中でも安全・期限付き手順は開始', context.speechMayStart({immediate:true}) === true);
  context.speakWindowOk = true;
  check('開窓で通常回答を開始', context.speechMayStart({immediate:false}) === true);
  context.speakWindowOk = false;
  context.speakGateActive = false;
  check('ガレージ／ピット外では通常回答を止めない', context.speechMayStart({immediate:false}) === true);
}

console.log(`\nSpeech Window: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
