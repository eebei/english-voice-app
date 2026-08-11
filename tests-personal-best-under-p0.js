'use strict';
// Build 265 fix E regression: a personal-best (P2) generated concurrent with
// a P0 fuel warning must be delivered once after the P0 completes, or
// deliberately expired with a trace reason.  It must never be silently
// dropped.  Priority for a genuine P0 must be preserved (PB is not elevated
// above safety).

const fs = require('fs');

let pass = 0;
function check(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}: ${detail}`);
  pass++;
}

const renderer = fs.readFileSync(__dirname + '/desktop/renderer.html', 'utf8');

// --- Ordering contract: P0 is 0 and P2 is 2, so priority sort delivers P0 first.
check('speak priority table places safety strictly above personal_best',
  /SPEAK_PRIO\s*=\s*\{[^}]*P0_SAFETY:0[^}]*P2_PROCEDURE:2/.test(renderer));
check('personal_best is broadcast at P2 in the bridge',
  fs.readFileSync(__dirname + '/irsdk-bridge/bridge.py', 'utf8')
    .includes("'personal_best': 2, 'session_best': 2"));

// --- Bounded-deferred queue for interrupted PB.
check('renderer declares the current speak item tracker',
  renderer.includes('let currentSpeakItem = null;'));
check('renderer declares the deferable-kind set including personal_best',
  renderer.includes("const SPEAK_DEFER_KINDS = new Set(['personal_best','session_best','first_lap']);"));
check('renderer caps how many times an item may be deferred',
  renderer.includes('const SPEAK_DEFER_MAX = 1;'));
check('renderer records the current speak item on splice from the queue',
  renderer.includes('currentSpeakItem = (typeof _it === \'object\') ? _it : null;'));
check('renderer clears the tracker after speech completes',
  renderer.includes('currentSpeakItem=null;'));

// --- Interrupt path: displaced PB is re-queued with a deferred key and trace.
check('interrupt path re-queues a displaced deferable item',
  renderer.includes('SPEAK_DEFER_KINDS.has(displaced.kind)')
  && renderer.includes('speakQueue.push(deferred);')
  && renderer.includes("dedupeKey:'deferred_'"));
check('interrupt path traces the deferral',
  renderer.includes("diagnosticLog('SPEAK_DEFERRED'"));
check('interrupt still calls stopCurrentAudio so P0 fires immediately',
  /speakQueue\.push\(deferred\);[\s\S]*?diagnosticLog\('SPEAK_DEFERRED'[\s\S]*?\}[\s\S]*?stopCurrentAudio\(\);/
  .test(renderer));
// ★Build 265 Codex 差戻し対応：defer cap 到達時は SPEAK_DEFER_DISCARDED を必ず trace。
check('renderer traces the discard when defer cap is reached',
  renderer.includes("diagnosticLog('SPEAK_DEFER_DISCARDED'")
  && renderer.includes('reason=defer_cap_reached'));

console.log(`✅ personal best under P0: ${pass} checks`);
