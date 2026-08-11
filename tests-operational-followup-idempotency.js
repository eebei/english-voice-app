'use strict';
// Build 265 fix C regression: a repeated unresolved question must not create
// parallel follow-ups.  A follow-up must be keyed by intent + session + lap.
// Session-ending lifecycle states must refuse both arm and deliver.

const fs = require('fs');

let pass = 0;
function check(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}: ${detail}`);
  pass++;
}

const renderer = fs.readFileSync(__dirname + '/desktop/renderer.html', 'utf8');

check('renderer defines the followup key from intent + session + lap',
  renderer.includes('function operationalFollowUpKey(intent, lap)')
  && renderer.includes("String(intent||'unresolved_operational')+'|'+String(lastSessionNum??'')+'|'+String(lap)"));

check('armOperationalFollowUp refuses to arm during session-ending lifecycle',
  renderer.includes("diagnosticLog('OPERATIONAL_FOLLOWUP','suppressed reason=session_ending intent='+intent)"));

check('armOperationalFollowUp refuses to overwrite an existing job with the same key',
  renderer.includes('pendingOperationalFollowUp.key===key')
  && renderer.includes("diagnosticLog('OPERATIONAL_FOLLOWUP','suppressed reason=duplicate_intent key='+key)"));

check('armOperationalFollowUp records the key on the job',
  renderer.includes('pendingOperationalFollowUp={intent:intent||')
  && renderer.includes('key, originalText:String(originalText||'));

check('session-num reset clears any pending follow-up',
  renderer.includes('pendingOperationalFollowUp=null;'));

// ★Build 265 Codex 差戻し対応：deliver path も session-ending でゲート。
check('deliverOperationalFollowUp refuses to deliver in session-ending lifecycle',
  /async function deliverOperationalFollowUp\(\)\{[\s\S]*?if\(isSessionEndingLifecycle\(\)\)\{[\s\S]*?expired reason=session_ending/
  .test(renderer));
check('maybeRunOperationalFollowUp expires job on session-ending lifecycle',
  /function maybeRunOperationalFollowUp\(data\)\{[\s\S]*?if\(isSessionEndingLifecycle\(\)\)\{[\s\S]*?expired reason=session_ending/
  .test(renderer));
check('followup timeout path traces an explicit expired reason',
  renderer.includes("diagnosticLog('OPERATIONAL_FOLLOWUP','expired reason=timeout_or_offline"));

console.log(`✅ operational follow-up idempotency: ${pass} checks`);
