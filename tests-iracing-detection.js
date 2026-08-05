#!/usr/bin/env node
'use strict';

const fs = require('fs');
const bridge = fs.readFileSync('irsdk-bridge/bridge.py', 'utf8');
const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');

let pass=0, fail=0;
function check(label, ok){
  if(ok){ console.log('✅ '+label); pass++; }
  else { console.error('❌ '+label); fail++; }
}

check('共有メモリopen時に検出済みイベントを送る',
  bridge.includes("broadcast({'type': 'iracing_detected', 'telemetry_active': False})"));
check('Browser後着でも検出・Active状態を副作用なしsnapshot同期',
  bridge.includes("await websocket.send(json.dumps({'type': 'iracing_status'")
  && bridge.includes("'detected': bool(_iracing_mem_detected)")
  && bridge.includes("'telemetry_active': bool(_iracing_telemetry_active)")
  && renderer.includes("if(data.type==='iracing_status')"));
check('Active late joinも新鮮なsnapshot確認前は緑バーにしない',
  renderer.includes("iracingLive=data.telemetry_active===true && lastTelemetryAt>0")
  && renderer.includes('usageIracingLive=iracingLive;')
  && !bridge.includes("if _iracing_mem_detected and not _iracing_telemetry_active:"));
check('SDK非Activeを10秒周期でstatus/tick診断',
  bridge.includes('now_diag - inactive_diag_at >= 10.0')
  && bridge.includes('IRSDK WAIT: memory_open=1 status=%s tick=%s telemetry_active=0'));
check('瞬断復帰で内部Active状態を復元',
  /if active:\s+#[^\n]*\n\s+_iracing_telemetry_active = True\s+inactive_since = None/.test(bridge));
check('rendererにiRacing検出済みの独立状態がある',
  renderer.includes('bridgeConnected = false, iracingDetected = false, iracingLive = false')
  && renderer.includes("if(data.type==='iracing_detected')"));
check('検出済み表示は起動待ちと区別する',
  renderer.includes("status_detected:'🔵 iRacing検出済み · ライブテレメトリ開始待ち'")
  && renderer.includes("else if(iracingDetected){ bar.textContent=t('status_detected')"));
check('切断・WebSocket終了で検出状態をリセット',
  renderer.includes('usageTick(); iracingDetected=false; iracingLive=false;')
  && renderer.includes('bridgeConnected=false; iracingDetected=false; iracingLive=false;'));

console.log(`\niRacing Detection Diagnostics: ${pass}/${pass+fail}`);
if(fail) process.exit(1);
