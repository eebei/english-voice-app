'use strict';
// Build 265 (Codex 差戻し 5): Lap Readout の実イベント列テスト。
//
// Bridge が完了周ごとに radio を発行し、renderer の gate がポリシーどおりに
// 通す／落とすことを、実際のイベント列で検証する。
//
// シナリオ:
//   4 本のクリーン非 PB 周 + 4 本の dirty 周 (incident / pit_in / pit_out /
//   off_track) を time順で流し、
//   - Every 2 laps: クリーン 4 本のうち 2 本目・4 本目のみ発話。dirty は全部無音。
//   - Every clean lap: クリーン 4 本すべて発話。dirty は全部無音。
//   - Off: 全部無音（PB も含めた別テストで検証済み）。
//   - Best only: lap_time は全部無音（PB のみ通る別テストで検証済み）。

const fs = require('fs');
const vm = require('vm');

let pass = 0;
function check(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}: ${detail}`);
  pass++;
}

const html = fs.readFileSync(__dirname + '/desktop/renderer.html', 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const src = scripts.reduce((a, b) => (a.length > b.length ? a : b));

function extract(name, kind) {
  const head = kind === 'const' ? `const ${name} ` : (kind === 'let' ? `let ${name} ` : `function ${name}(`);
  const i = src.indexOf(head);
  if (i < 0) throw new Error('本番コードに ' + name + ' が見つからない');
  const rest = src.slice(i);
  const end = rest.search(/\n(?:async function |function |const |let |\/\/ ──)/);
  return rest.slice(0, end > 0 ? end : rest.length);
}

const parts = [
  extract('LAP_READOUT_KINDS', 'const'),
  extract('BEST_ONLY_KINDS',   'const'),
  extract('LAP_READOUT_POLICIES', 'const'),
  extract('lapReadoutCleanCount', 'let'),
  extract('lapReadoutLastCleanCountFromBridge', 'let'),
  extract('_hasCleanEvidenceFields', 'fn'),
  extract('_extractCleanEvidence', 'fn'),
  extract('_judgeCleanFromEvidence', 'fn'),
  extract('lapReadoutPolicyAllows', 'fn'),
  extract('resetLapReadoutCounter', 'fn'),
].join('\n');

function makeGate(policy) {
  const store = { getItem: k => (k === 'pw_contract'
    ? JSON.stringify({ signed: true, pace: { readout: policy } })
    : null) };
  const sandbox = { localStorage: store, console, Set, Array, Number, String, Math, JSON, lastTelemetry: null };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(parts
    + '\nglobalThis.gate = lapReadoutPolicyAllows;'
    + '\nglobalThis.reset = resetLapReadoutCounter;', ctx);
  return { gate: sandbox.gate, reset: sandbox.reset };
}

// Build the exact radio payload the bridge broadcasts for a lap-completion.
// clean_lap_candidate_count is what the bridge itself increments (only on
// clean laps).  dirty laps do NOT increment the counter — that is the
// contract we are testing end-to-end.
function makeLapTimeEvent({ lap, clean, pit_in = false, pit_out = false,
                            off_track = false, incidents = 0,
                            cleanCount }) {
  return {
    type: 'radio', trigger: 'lap_time',
    lap_number: lap,
    lap_valid_clean: clean,
    incidents_this_lap: incidents,
    pit_in_this_lap: pit_in,
    pit_out_this_lap: pit_out,
    off_track_this_lap: off_track,
    clean_lap_candidate_count: cleanCount, // bridge-authoritative
    time: '1:48.500', time_seconds: 108.5, diff: 0.3,
  };
}

// Simulate the exact bridge event sequence for Build 265 clean-lap semantics.
// Laps 3..10 in order:
//   3 clean (candidate #1)
//   4 clean (candidate #2)         ← Every 2 laps: speak
//   5 dirty (incident)             ← counter stays at 2
//   6 clean (candidate #3)
//   7 dirty (pit_in)               ← counter stays at 3
//   8 clean (candidate #4)         ← Every 2 laps: speak
//   9 dirty (pit_out)              ← counter stays at 4
//  10 dirty (off_track)            ← counter stays at 4
function generateSequence() {
  let cleanCount = 0;
  const events = [];
  const add = (opts) => {
    if (opts.clean) cleanCount += 1;
    events.push(makeLapTimeEvent({ ...opts, cleanCount }));
  };
  add({ lap: 3,  clean: true });                                // #1 clean
  add({ lap: 4,  clean: true });                                // #2 clean
  add({ lap: 5,  clean: false, incidents: 2 });                 // dirty
  add({ lap: 6,  clean: true });                                // #3 clean
  add({ lap: 7,  clean: false, pit_in: true });                 // dirty
  add({ lap: 8,  clean: true });                                // #4 clean
  add({ lap: 9,  clean: false, pit_out: true });                // dirty
  add({ lap: 10, clean: false, off_track: true });              // dirty
  return events;
}

// --- every_2_laps: only 2nd and 4th clean events speak. ---------------------
{
  const { gate, reset } = makeGate('every_2_laps');
  reset();
  const events = generateSequence();
  const spoken = [];
  const suppressed = [];
  for (const ev of events) {
    const r = gate(ev.trigger, ev, null);
    (r.allow ? spoken : suppressed).push({ lap: ev.lap_number, clean: ev.lap_valid_clean, policy: r.policy });
  }
  check('every_2_laps: exactly 2 events speak', spoken.length === 2, JSON.stringify(spoken));
  check('every_2_laps: the 2nd clean lap (lap 4) speaks',
    spoken.some(e => e.lap === 4), JSON.stringify(spoken));
  check('every_2_laps: the 4th clean lap (lap 8) speaks',
    spoken.some(e => e.lap === 8), JSON.stringify(spoken));
  check('every_2_laps: 1st clean lap (lap 3) is silent',
    !spoken.some(e => e.lap === 3), JSON.stringify(spoken));
  check('every_2_laps: 3rd clean lap (lap 6) is silent',
    !spoken.some(e => e.lap === 6), JSON.stringify(spoken));
  check('every_2_laps: EVERY dirty lap (5,7,9,10) is silent',
    ![5,7,9,10].some(l => spoken.some(e => e.lap === l)), JSON.stringify(spoken));
  // Every dirty event goes through the gate but is denied — never silently
  // discarded upstream.
  check('every_2_laps: all 4 dirty laps produce a suppressed verdict, not a skipped one',
    suppressed.filter(e => !e.clean).length === 4, JSON.stringify(suppressed));
}

// --- every_clean_lap: all 4 clean events speak; all dirty silent. -----------
{
  const { gate, reset } = makeGate('every_clean_lap');
  reset();
  const events = generateSequence();
  const spoken = events.filter(ev => gate(ev.trigger, ev, null).allow);
  check('every_clean_lap: exactly 4 events speak', spoken.length === 4,
    JSON.stringify(spoken.map(e => e.lap_number)));
  check('every_clean_lap: laps 3,4,6,8 speak in order',
    JSON.stringify(spoken.map(e => e.lap_number)) === JSON.stringify([3,4,6,8]));
  check('every_clean_lap: NO dirty lap speaks',
    !spoken.some(e => !e.lap_valid_clean));
}

// --- Off: nothing speaks (even the counter must not advance). ---------------
{
  const { gate, reset } = makeGate('off');
  reset();
  const events = generateSequence();
  const spoken = events.filter(ev => gate(ev.trigger, ev, null).allow);
  check('off: nothing speaks across the whole sequence', spoken.length === 0,
    JSON.stringify(spoken.map(e => e.lap_number)));
}

// --- Best only: no lap_time speaks (PB path is verified elsewhere). ---------
{
  const { gate, reset } = makeGate('best_only');
  reset();
  const events = generateSequence();
  const spoken = events.filter(ev => gate(ev.trigger, ev, null).allow);
  check('best_only: no lap_time event speaks', spoken.length === 0,
    JSON.stringify(spoken.map(e => e.lap_number)));
}

// --- every_2_laps + bridge counter missing: local fallback still 2nd/4th ---
// Simulate a bridge that forgets clean_lap_candidate_count.  The renderer's
// local counter must produce identical behaviour: laps 4 and 8 speak.
{
  const { gate, reset } = makeGate('every_2_laps');
  reset();
  const events = generateSequence().map(ev => {
    const { clean_lap_candidate_count, ...rest } = ev;
    return rest;
  });
  const spoken = events.filter(ev => gate(ev.trigger, ev, null).allow);
  check('every_2_laps (no bridge count): 2nd + 4th clean laps still speak',
    spoken.length === 2
    && spoken[0].lap_number === 4
    && spoken[1].lap_number === 8,
    JSON.stringify(spoken.map(e => e.lap_number)));
}

// --- Bridge wiring: lap_time broadcast exists only under _lap_valid_clean --
const bridgeSrc = fs.readFileSync(__dirname + '/irsdk-bridge/bridge.py', 'utf8');
check('bridge emits a lap_time radio candidate ONLY when the lap is valid clean',
  /if _lap_valid_clean:\s*\n\s*broadcast\(\{\s*'type': 'radio',\s*'trigger': 'lap_time'/.test(bridgeSrc),
  'lap_time broadcast must be gated on _lap_valid_clean=True');
check('bridge lap_time broadcast carries _clean_lap_evidence',
  /'trigger': 'lap_time'[\s\S]{0,400}\*\*_clean_lap_evidence/.test(bridgeSrc));
check('telemetry_live exposes lap_valid_clean explicitly',
  bridgeSrc.includes("'lap_valid_clean': _telemetry_lap_valid_clean"));
check('renderer UI hint acknowledges Off silences Best updates too',
  html.includes('Off はベスト更新も含めラップ読み上げを完全に止める'));

console.log(`✅ lap readout event sequence: ${pass} checks`);
