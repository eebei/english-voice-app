'use strict';
// Build 265 fix B lifecycle wiring: no P3 strategy speech on final lap /
// checker out / PLAYER_FINISHED / debrief.

const fs = require('fs');

let pass = 0;
function check(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}: ${detail}`);
  pass++;
}

const renderer = fs.readFileSync(__dirname + '/desktop/renderer.html', 'utf8');

check('renderer declares final-lap latch',
  renderer.includes('let finalLapNoticeSeen = false'));
check('renderer declares checker-out latch',
  renderer.includes('let checkerOutNoticeSeen = false'));
check('renderer exposes isSessionEndingLifecycle helper',
  renderer.includes('function isSessionEndingLifecycle()'));
check('lifecycle helper checks the two latches, driver activity and debrief mode',
  /return\s+finalLapNoticeSeen \|\| checkerOutNoticeSeen[\s\S]*driverActivity==='FINISHED'[\s\S]*selMode==='debrief'/
  .test(renderer));

check('renderer sets final_lap_notice latch inside injectRadio',
  renderer.includes("if(data.trigger==='final_lap_notice') finalLapNoticeSeen = true"));
check('renderer sets checker_out_notice latch inside injectRadio',
  renderer.includes("if(data.trigger==='checker_out_notice') checkerOutNoticeSeen = true"));

check('session-num reset clears both latches',
  renderer.includes('finalLapNoticeSeen=false;')
  && renderer.includes('checkerOutNoticeSeen=false;'));

check('strategy live update returns silently when session is ending',
  /if\(isSessionEndingLifecycle\(\)\)\{[\s\S]*?STRATEGY_PLAYBOOK_UPDATE_SILENT[\s\S]*?reason:'session_ending'/
  .test(renderer));

check('operational followup refuses to arm during session-ending lifecycle',
  /armOperationalFollowUp[\s\S]*?if\(isSessionEndingLifecycle\(\)\)/.test(renderer));

console.log(`✅ strategy lifecycle suppression: ${pass} checks`);
