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
check('STT通信を3回まで再試行',
  bridge.includes('retry_delays = (0.0, 0.4, 1.2)')
  && bridge.includes('for attempt, delay in enumerate(retry_delays, start=1):')
  && bridge.includes('STT network failure after retries:'));
check('通信失敗を聞き取り失敗と区別',
  bridge.includes('broadcast({"type": "ptt_error", "reason": "network"})')
  && renderer.includes("if(data.type==='ptt_error')")
  && renderer.includes("t('hint_ptt_network')"));

console.log(`\nPTT Immediate Capture: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
