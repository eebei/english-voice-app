#!/usr/bin/env node
'use strict';

// No browser or paid API: this is the contract that makes a later real-run
// latency measurement auditable rather than a subjective "felt fast" claim.
const fs = require('fs');
const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');
let pass = 0, fail = 0;
function check(label, ok) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label);
  ok ? pass++ : fail++;
}

check('latency trace records queue-to-play timing without an external call',
  renderer.includes('function speechLatencyTrace(state, item, extra={})')
  && renderer.includes("diagnosticLog('SPEECH_LATENCY',JSON.stringify(payload))"));
check('all driver-facing outcomes are traceable',
  renderer.includes("speechLatencyTrace('queued',item)")
  && renderer.includes("speechLatencyTrace('discarded',item,{reason:'duplicate_dedupe_key'})")
  && renderer.includes("speechLatencyTrace('discarded',speakQueue[wi],{reason:'queue_overflow'})")
  && renderer.includes("speechLatencyTrace('tts_start',currentSpeakItem)")
  && renderer.includes("speechLatencyTrace('play_started',currentSpeakItem")
  && renderer.includes("if(typeof speechLatencyTrace==='function')"));
check('the measurement preserves priority and source instead of fabricating a single latency number',
  renderer.includes('prio:Number(item&&item.prio)')
  && renderer.includes('source:extra.source||null')
  && renderer.includes("source:ttsAudio?'cloud_tts':'webspeech_or_fallback'"));

console.log(`\nSpeech latency trace: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
