#!/usr/bin/env node
'use strict';

const fs = require('fs');
const bridge = fs.readFileSync('irsdk-bridge/bridge.py', 'utf8');
const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');

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

check('0.35秒未満をSTTへ送らず診断',
  bridge.includes('if duration_seconds < 0.35:')
  && bridge.includes("'reason': 'too_short'"));
check('無音テイクをSTTへ送らず診断',
  bridge.includes('if peak < 200:')
  && bridge.includes("'reason': 'no_signal'"));
check('診断に時間・peak・deviceを記録',
  bridge.includes('PTT DIAG: too_short duration=')
  && bridge.includes('PTT DIAG: no_signal duration='));
check('busy中の即時録音を破棄',
  /if\(isBusy\)\{[\s\S]*?cmd:'ptt_abort'/.test(renderer)
  && /elif cmd == "ptt_abort":\s*abort_ptt_record\(\)/.test(bridge));
check('rendererは短音声と無音を区別表示',
  renderer.includes("if(data.type==='ptt_diagnostic')")
  && renderer.includes("reason==='too_short'"));
check('通信失敗を聞き取り失敗と区別',
  renderer.includes("if(data.type==='ptt_error')")
  && renderer.includes("t('hint_ptt_network')"));
check('STTを正常なElectron HTTPS経路へ統一',
  bridge.includes("broadcast({'type': 'ptt_audio'")
  && renderer.includes("if(data.type==='ptt_audio')")
  && renderer.includes("fetch(API_BASE+'/api/stt'"));
check('Electron STT経路も一時障害を3回まで再試行',
  renderer.includes('const retryDelays=[0,300,900]')
  && renderer.includes("err.retryable=(r.status===429||r.status>=500)")
  && renderer.includes('[PTT_STT_RETRY]'));
check('INACTIVE中もSTT結果・診断配送を許可',
  bridge.includes("'ptt', 'ptt_text', 'ptt_audio', 'ptt_error', 'ptt_diagnostic'"));

console.log(`\nPTT Immediate Capture: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
