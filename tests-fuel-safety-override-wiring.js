'use strict';
// WO-005 P1-11 / REVISE 1 R3-R4 wiring: a Bridge-attached `safety_override`
// on `fuel_strategy_warning`, tied to the SAME canonical active decision
// (ID + revision + the frame it was activated on) the renderer already
// trusts from `telemetry_live`, must bypass BOTH stages of the existing
// fuel-plan two-stage guard (`pit_timing_authority` check +
// `evaluateFuelPlanGuard`). Missing, mismatched, or unrelated overrides
// must fall through to the normal guard unchanged.
//
// Unlike the source-text-only version this file replaces, every check here
// either (a) calls the REAL pure verification function
// (`desktop/fuel-safety-override-guard.js`, required directly — no
// re-implementation), or (b) extracts the REAL `injectRadio()` /
// `evaluateFuelPlanGuard()` from `renderer.html` via the same VM-sandbox
// convention `tests-speak-async.js` / `tests-utterance-fanout-fixture.js`
// already use, and drives it with the REAL `fuel_strategy_warning` +
// `telemetry_live` shape `tests_bridge_fuel_safety_override_replay.py`
// captured from an actual `bridge.poll_iracing()` replay (fixtures/wo005-
// fuel-safety-override/fuel_safety_override_replay_v1.json) — closing the
// Bridge -> Renderer -> speak() loop end to end.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let pass = 0;
function check(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}: ${detail}`);
  pass++;
}

const renderer = fs.readFileSync(path.join(__dirname, 'desktop/renderer.html'), 'utf8');
const bridge = fs.readFileSync(path.join(__dirname, 'irsdk-bridge/bridge.py'), 'utf8');
const overrideGuard = require('./desktop/fuel-safety-override-guard.js');
// WO-019: a held fuel fact is spoken in the engineer's language as the same fact
// (fuel level + no pit instruction); English characters keep the Bridge wire text.
function heldText(sel, data) {
  const fuel = Number(data.fuel), authorityOnly = data.execution_hold === 'dedicated_box_authority_only';
  if (['Kanbe', 'Oishi', 'HajimeJP', 'LunaJP'].includes(sel) && Number.isFinite(fuel)) return `燃料残り${fuel}リットル。` + (authorityOnly ? '' : 'ピット指示は保留中。');
  if (sel === 'Matthias' && Number.isFinite(fuel)) return `Resttreibstoff ${fuel} Liter.` + (authorityOnly ? '' : ' Boxenanweisung zurückgehalten.');
  return data.message;
}
const noBoxDirective = text => !/ボックス|この周でピット|Box this lap|Boxenstopp nötig|リットル追加|Add \d/.test(String(text));

// ══════════════════════════════════════════════════════════════════════
// Part 1 — the pure verification function itself, called directly (no
// source-text guessing). Positive case plus every negative case R4 lists:
// frame mismatch, revision mismatch, decision mismatch, missing override,
// wrong diagnostic, unrelated trigger.
// ══════════════════════════════════════════════════════════════════════

const REF = { refDecisionId: 'dec-1', refRevision: 2, refActivatedSourceFrameSequence: 40 };
const GOOD_OVERRIDE = {
  diagnostic: 'authority_requires_new_decision', decision_id: 'dec-1', revision: 2,
  activated_source_frame_sequence: 40, override_reason: 'cannot_reach_selected_pit_window',
};

{
  const v = overrideGuard.verifyFuelSafetyOverride({
    trigger: 'fuel_strategy_warning', safetyOverride: GOOD_OVERRIDE, ...REF });
  check('matched decision/revision/frame verifies', v.verified === true, JSON.stringify(v));
}
{
  const v = overrideGuard.verifyFuelSafetyOverride({
    trigger: 'fuel_strategy_warning',
    safetyOverride: { ...GOOD_OVERRIDE, decision_id: 'dec-OTHER' }, ...REF });
  check('decision_id mismatch rejects', v.verified === false && v.reason === 'decision_id_mismatch');
}
{
  const v = overrideGuard.verifyFuelSafetyOverride({
    trigger: 'fuel_strategy_warning',
    safetyOverride: { ...GOOD_OVERRIDE, revision: 99 }, ...REF });
  check('revision mismatch rejects', v.verified === false && v.reason === 'revision_mismatch');
}
{
  const v = overrideGuard.verifyFuelSafetyOverride({
    trigger: 'fuel_strategy_warning',
    safetyOverride: { ...GOOD_OVERRIDE, activated_source_frame_sequence: 41 }, ...REF });
  check('activated_source_frame_sequence mismatch rejects',
    v.verified === false && v.reason === 'frame_mismatch');
}
{
  const v = overrideGuard.verifyFuelSafetyOverride({
    trigger: 'fuel_strategy_warning',
    safetyOverride: { ...GOOD_OVERRIDE, activated_source_frame_sequence: undefined }, ...REF });
  check('missing frame on either side is NOT silently skipped (fail-closed)',
    v.verified === false && v.reason === 'frame_not_comparable');
}
{
  const v = overrideGuard.verifyFuelSafetyOverride({
    trigger: 'fuel_strategy_warning', safetyOverride: undefined, ...REF });
  check('missing safety_override object rejects', v.verified === false && v.reason === 'no_override_object');
}
{
  const v = overrideGuard.verifyFuelSafetyOverride({
    trigger: 'fuel_strategy_warning',
    safetyOverride: { ...GOOD_OVERRIDE, diagnostic: 'unrelated_diagnostic' }, ...REF });
  check('wrong/unrelated diagnostic rejects', v.verified === false && v.reason === 'wrong_diagnostic');
}
{
  const v = overrideGuard.verifyFuelSafetyOverride({
    trigger: 'fuel_warning', safetyOverride: GOOD_OVERRIDE, ...REF });
  check('unrelated trigger (not fuel_strategy_warning) rejects',
    v.verified === false && v.reason === 'no_override_object');
}

// ══════════════════════════════════════════════════════════════════════
// Part 2 — the REAL Bridge production replay fixture, driven through the
// REAL renderer.html injectRadio()/evaluateFuelPlanGuard(), with speak()
// captured by a test observer.
// ══════════════════════════════════════════════════════════════════════

const fixturePath = path.join(__dirname, 'fixtures/wo005-fuel-safety-override',
  'fuel_safety_override_replay_v1.json');
check('production replay fixture exists (run tests_bridge_fuel_safety_override_replay.py first)',
  fs.existsSync(fixturePath), fixturePath);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const productionWarning = fixture.fuel_strategy_warning_broadcasts[0];
// Historical non-fact payload exercises the legacy guard; current wire is tested below.
const realWarning = {...productionWarning, fact_only:false};
check('fixture warning carries a real Bridge safety_override', !!(realWarning && realWarning.safety_override));
const realActivePlanFields = fixture.telemetry_live_active_plan_fields.find(
  t => t.active_plan_decision_id === realWarning.safety_override.decision_id);
check('fixture has a matching telemetry_live sample for the override\'s decision',
  !!realActivePlanFields);

function extractFunction(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found in renderer.html`);
  let i = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

const fnInjectRadio = extractFunction(renderer, 'injectRadio');
const fnEvaluateFuelPlanGuard = extractFunction(renderer, 'evaluateFuelPlanGuard');
check('extracted injectRadio from the real renderer.html', fnInjectRadio.length > 500);
check('extracted evaluateFuelPlanGuard from the real renderer.html', fnEvaluateFuelPlanGuard.length > 50);

function makeSandbox({ lastTelemetry, sel = 'James', activeStrategyPlaybook = { available: false } }) {
  const speakCalls = [];
  const diagnosticLogs = [];
  const sandbox = {
    console, JSON, Number, String, Math, Date,
    window: {
      PitwallFuelSafetyOverrideGuard: overrideGuard,
      PitwallFuelPlanGuard: require('./desktop/fuel-plan-guard.js'),
    },
    // Reflex path is out of scope here (already covered by
    // tests-reflex-events*.js); force it off so injectRadio proceeds
    // straight to the LAP_READOUT / fuel-safety-override guard sections.
    toReflexEvent: () => null,
    reflexLatestByKind: {}, reflexLastSpoken: null,
    recordReflexEvent: () => {}, reflexSpeakDecision: () => ({ speak: false }),
    reflexHazardLines: () => null,
    LAP_READOUT_KINDS: new Set(),
    lapReadoutPolicyAllows: () => ({ allow: true, policy: 'not_lap_readout' }),
    selMode: 'race',
    lastTelemetry,
    // Unit isolation: WO011's publication gate and projection are covered by
    // tests-wo011-desktop-projection.js (real cache, real poll snapshots).
    // These fixtures specifically exercise the pre-existing safety guard.
    canonicalLifecycleCache: {matches:()=>true},
    ensureStrategyState:()=>({available:true}),
    strategyProjection:{binding:()=>({kind:'guard-fixture'}),validBinding:()=>true},
    currentStrategyPlaybook:()=>activeStrategyPlaybook,
    activeRaceFacts: {},
    lastSessionNum: 0,
    sel,
    oishiRadio: () => null,
    matthiasRadio: () => null,
    sessionBestLapSeconds: null, sessionBestLapStr: null,
    finalLapNoticeSeen: false, checkerOutNoticeSeen: false,
    nextUtteranceId: (() => { let n = 0; return () => 'u' + (++n); })(),
    addMsg: () => ({}),
    pushMsg: () => {},
    SPEAK_PRIO: { P0_SAFETY: 0, P1_HAZARD: 1, P2_PROCEDURE: 2, P3_STRATEGY: 3, P4_INFO: 4, P5_CHAT: 5 },
    speak: (text, opts) => speakCalls.push({ text, opts }),
    diagnosticLog: (tag, text) => diagnosticLogs.push({ tag, text }),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${fnEvaluateFuelPlanGuard}\n${fnInjectRadio}`, sandbox);
  return { sandbox, speakCalls, diagnosticLogs };
}

function logsContaining(diagnosticLogs, tag) {
  return diagnosticLogs.filter(l => l.tag === tag);
}

console.log('\n━━ 実 injectRadio()/evaluateFuelPlanGuard() による safety_override 一貫性試験 ━━\n');

// Test A: verified override (real decision_id/revision/frame from the real
// Bridge replay) bypasses BOTH guard stages and speaks exactly once.
{
  const lastTelemetry = {
    active_plan_decision_id: realActivePlanFields.active_plan_decision_id,
    active_plan_revision: realActivePlanFields.active_plan_revision,
    active_plan_activated_source_frame_sequence:
      realActivePlanFields.active_plan_activated_source_frame_sequence,
  };
  const { sandbox, speakCalls, diagnosticLogs } = makeSandbox({ lastTelemetry });
  sandbox.injectRadio(realWarning);
  check('verified override: speak() called exactly once', speakCalls.length === 1, speakCalls.length);
  check('verified override: spoken text is the real Bridge warning message',
    speakCalls[0].text === realWarning.message, speakCalls[0].text);
  check('verified override: FUEL_SAFETY_OVERRIDE_VERIFIED logged',
    logsContaining(diagnosticLogs, 'FUEL_SAFETY_OVERRIDE_VERIFIED').length === 1);
  check('verified override: the second guard stage (FUEL_PLAN_GUARD) is BYPASSED, not just suppressed',
    logsContaining(diagnosticLogs, 'FUEL_PLAN_GUARD').length === 0);
  console.log('  ✓ verified override reaches speak() exactly once, both guard stages bypassed');
}

// Test B: decision_id mismatch — falls through to the real two-stage guard,
// and with a REAL reachable/safe playbook the real guard suppresses the
// speech (a genuine no-speak() proof, not just a log check).
{
  const lastTelemetry = {
    active_plan_decision_id: 'a-completely-different-decision',
    active_plan_revision: realActivePlanFields.active_plan_revision,
    active_plan_activated_source_frame_sequence:
      realActivePlanFields.active_plan_activated_source_frame_sequence,
    // Deliberately a SAFE fuel state (not the fixture's own shortfall
    // number) — this proves the real guard's own suppression logic runs
    // and reaches its normal "plan reachable" verdict once the override
    // is rejected, independent of what the fixture's warning happened to
    // carry.
    lap: 5, fuel: 50.0, fuel_strategy: { avg_fuel_per_lap: 2.9 },
  };
  const safePlaybook = {
    available: true, selected_plan: 'A',
    plans: { A: { available: true, first_pit_lap: 21,
      first_service: { estimated_add_l: 24.6, entry_fuel_l: 2.0, target_onboard_l: 26.6 } } },
  };
  const { sandbox, speakCalls, diagnosticLogs } = makeSandbox({
    lastTelemetry, activeStrategyPlaybook: safePlaybook });
  sandbox.injectRadio({ ...realWarning, fuel_band: 'critical' });
  check('decision_id mismatch: FUEL_SAFETY_OVERRIDE_REJECTED logged',
    logsContaining(diagnosticLogs, 'FUEL_SAFETY_OVERRIDE_REJECTED').length === 1);
  check('decision_id mismatch: falls through into the real second-stage guard (FUEL_PLAN_GUARD ran)',
    logsContaining(diagnosticLogs, 'FUEL_PLAN_GUARD').length === 1);
  check('decision_id mismatch: the real guard, with a reachable plan, actually suppresses speech',
    speakCalls.length === 0, speakCalls.length);
  console.log('  ✓ decision_id mismatch falls through to the normal guard, which suppresses (no speak())');
}

// Test C: revision mismatch — same shape, must also fall through.
{
  const lastTelemetry = {
    active_plan_decision_id: realActivePlanFields.active_plan_decision_id,
    active_plan_revision: 999,
    active_plan_activated_source_frame_sequence:
      realActivePlanFields.active_plan_activated_source_frame_sequence,
  };
  const run = makeSandbox({ lastTelemetry });
  run.sandbox.injectRadio(realWarning);
  check('revision mismatch: rejected, not verified',
    logsContaining(run.diagnosticLogs, 'FUEL_SAFETY_OVERRIDE_REJECTED').length === 1);
  check('revision mismatch: falls through to the second-stage guard',
    logsContaining(run.diagnosticLogs, 'FUEL_PLAN_GUARD').length === 1);
  console.log('  ✓ revision mismatch falls through to the normal guard');
}

// Test D: activated_source_frame_sequence mismatch — same shape.
{
  const lastTelemetry = {
    active_plan_decision_id: realActivePlanFields.active_plan_decision_id,
    active_plan_revision: realActivePlanFields.active_plan_revision,
    active_plan_activated_source_frame_sequence:
      realActivePlanFields.active_plan_activated_source_frame_sequence + 1,
  };
  const run = makeSandbox({ lastTelemetry });
  run.sandbox.injectRadio(realWarning);
  check('frame mismatch: rejected, not verified',
    logsContaining(run.diagnosticLogs, 'FUEL_SAFETY_OVERRIDE_REJECTED').length === 1);
  check('frame mismatch: falls through to the second-stage guard',
    logsContaining(run.diagnosticLogs, 'FUEL_PLAN_GUARD').length === 1);
  console.log('  ✓ activated_source_frame_sequence mismatch falls through to the normal guard');
}

// Test E: override entirely missing on an otherwise-identical warning.
{
  const lastTelemetry = {
    active_plan_decision_id: realActivePlanFields.active_plan_decision_id,
    active_plan_revision: realActivePlanFields.active_plan_revision,
    active_plan_activated_source_frame_sequence:
      realActivePlanFields.active_plan_activated_source_frame_sequence,
  };
  const { safety_override, ...warningWithoutOverride } = realWarning;
  const run = makeSandbox({ lastTelemetry });
  run.sandbox.injectRadio(warningWithoutOverride);
  check('missing override: rejected, not verified',
    logsContaining(run.diagnosticLogs, 'FUEL_SAFETY_OVERRIDE_REJECTED').length === 1);
  check('missing override: falls through to the second-stage guard',
    logsContaining(run.diagnosticLogs, 'FUEL_PLAN_GUARD').length === 1);
  console.log('  ✓ missing safety_override falls through to the normal guard');
}

// Test F: an unrelated warning (not fuel_strategy_warning) never touches
// either the override check or the fuel-plan guard, even carrying a
// (meaningless, for this trigger) safety_override key.
{
  const run = makeSandbox({ lastTelemetry: {} });
  run.sandbox.injectRadio({ trigger: 'gap_trend', message: 'unrelated', safety_override: GOOD_OVERRIDE });
  check('unrelated trigger: no FUEL_SAFETY_OVERRIDE_* diagnostic at all',
    logsContaining(run.diagnosticLogs, 'FUEL_SAFETY_OVERRIDE_VERIFIED').length === 0
    && logsContaining(run.diagnosticLogs, 'FUEL_SAFETY_OVERRIDE_REJECTED').length === 0);
  check('unrelated trigger: no FUEL_PLAN_GUARD either (this guard is fuel_strategy_warning-only)',
    logsContaining(run.diagnosticLogs, 'FUEL_PLAN_GUARD').length === 0);
  console.log('  ✓ unrelated trigger never engages the fuel-safety-override machinery');
}

// --- Renderer: wiring (script tag + single call-site, not duplicated logic) ---
check('renderer loads the pure fuel-safety-override-guard module',
  renderer.includes('<script src="fuel-safety-override-guard.js"></script>'));
check('renderer calls the shared pure verification function (no re-implemented comparison logic)',
  renderer.includes('window.PitwallFuelSafetyOverrideGuard.verifyFuelSafetyOverride({'));
check('the pit_timing_authority stage and evaluateFuelPlanGuard stage are the ' +
  'SAME `if` gated by !_verifiedFuelSafetyOverride (single bypass point)',
  /if\(data\.trigger==='fuel_strategy_warning' && window\.PitwallFuelPlanGuard && !_verifiedFuelSafetyOverride && !_heldFuelFact\)\{[\s\S]*?const _timing=lastTelemetry[\s\S]*?const guardVerdict = evaluateFuelPlanGuard\(data\);/
  .test(renderer));

// --- Bridge: safety_override is attached only from the frozen active -------
// Plan's own evaluate() verdict, never fabricates a new fuel amount / BOX
// call / Plan change (WO-005 §4.6 constraint), and carries the STABLE
// activated_source_frame_sequence (not the ever-incrementing live frame
// counter REVISE 1 rejected).
check("bridge computes the override only when evaluate() proves the ACTIVE " +
  "record's plan_id insufficient",
  bridge.includes("_plan_authority_verdict.get('plan_id')\n                        == _authority_active_record.selected_plan"));
check('bridge tags the override with the authority_requires_new_decision diagnostic',
  bridge.includes("'diagnostic': 'authority_requires_new_decision',"));
check('bridge carries canonical decision_id/revision on the override',
  bridge.includes("'decision_id': _authority_active_record.decision_id,")
  && bridge.includes("'revision': _authority_active_record.revision,"));
check('bridge carries the STABLE activated_source_frame_sequence (not the live per-frame counter)',
  bridge.includes("'activated_source_frame_sequence': (\n                            _authority_active_record.activated_source_frame_sequence),"));
check('bridge attaches safety_override to the fuel_strategy_warning broadcast',
  bridge.includes("'safety_override': _active_fuel_safety_override,"));
check('bridge never sets a new set_fuel_l/BOX field inside the override object',
  !/'safety_override':\s*\{[^}]*set_fuel_l/.test(bridge));

// --- Bridge: telemetry_live carries the reference decision_id/revision/frame ---
check('telemetry_live broadcasts active_plan_decision_id sourced from the Lifecycle active record',
  bridge.includes("'active_plan_decision_id': (\n                    _telemetry_active_record.decision_id"));
check('telemetry_live broadcasts active_plan_revision sourced from the Lifecycle active record',
  bridge.includes("'active_plan_revision': (\n                    _telemetry_active_record.revision"));
check('telemetry_live broadcasts the SAME stable active_plan_activated_source_frame_sequence',
  bridge.includes("'active_plan_activated_source_frame_sequence': (\n                    _telemetry_active_record.activated_source_frame_sequence"));

console.log(`\n✅ fuel safety override wiring: ${pass} checks`);

// WO-007 actual injectRadio -> speak: all characters bypass translations
// that could otherwise regenerate BOX from null fuel settings.
for (const sel of ['Luna', 'James', 'Hajime', 'Kanbe', 'Oishi', 'HajimeJP', 'LunaJP', 'Matthias']) {
  for (const trigger of ['fuel_strategy_warning', 'fuel_warning']) {
    const run = makeSandbox({ lastTelemetry: { fuel_strategy: { pit_timing_authority: { available: true, decision: 'wait' } } } });
    run.sandbox.sel = sel;
    run.sandbox.oishiRadio = () => { throw new Error('held fact reached JP BOX localization'); };
    run.sandbox.matthiasRadio = () => { throw new Error('held fact reached DE BOX localization'); };
    const data = { ...realWarning, trigger, fact_only: true, execution_hold: 'black_flag_true',
      set_fuel_l: null, safety_override: null, margin_l: -2, pit_required: false,
      message: 'Fuel short 2.0 liters. Execution held.' };
    run.sandbox.injectRadio(data);
    check(sel + ' ' + trigger + ' held fuel fact speaks once without BOX',
      run.speakCalls.length === 1 && run.speakCalls[0].text === heldText(sel, data) && noBoxDirective(run.speakCalls[0].text));
    check(sel + ' held fact does not set pitRequired', Object.keys(run.sandbox.activeRaceFacts).length===0);
  }
}
check('current actual Bridge wire always fact-only despite diagnostic', productionWarning.fact_only===true && productionWarning.set_fuel_l===null && productionWarning.pit_required===false && !!productionWarning.safety_override);
for(const sel of ['Luna','James','Hajime','Kanbe','Oishi','HajimeJP','LunaJP','Matthias']) {
  const run=makeSandbox({sel,lastTelemetry:{}});
  run.sandbox.oishiRadio=()=>{throw Error('actual diagnostic entered JP directive translator');};
  run.sandbox.matthiasRadio=()=>{throw Error('actual diagnostic entered DE directive translator');};
  run.sandbox.injectRadio(productionWarning);
  check(sel+' real diagnostic wire goes to speech as fact',run.speakCalls.length===1 && run.speakCalls[0].text===heldText(sel,productionWarning) && noBoxDirective(run.speakCalls[0].text) && Object.keys(run.sandbox.activeRaceFacts).length===0);
}
// A retained readonly diagnostic must never turn a held fact into a pit directive.
for (const sel of ['Luna','James','Hajime','Kanbe','Oishi','HajimeJP','LunaJP','Matthias']) {
  const run = makeSandbox({sel, lastTelemetry:{}});
  const data = {trigger:'fuel_strategy_warning', fact_only:true, execution_hold:'dedicated_box_authority_only',
    set_fuel_l:null, pit_required:false, fuel:4, margin_l:-2, message:'Fuel 4. Execution held.',
    safety_override:{decision_id:'diagnostic-only',revision:1,activated_source_frame_sequence:8}};
  run.sandbox.injectRadio(data);
  check(sel+' retained diagnostic stays fact only',run.speakCalls.length===1 && run.speakCalls[0].text===heldText(sel,data) && noBoxDirective(run.speakCalls[0].text) && Object.keys(run.sandbox.activeRaceFacts).length===0);
}
console.log('WO-007 held facts: all 8 characters x 2 triggers reach speak without BOX.');

for (const sel of ['Luna', 'James', 'Hajime', 'Kanbe', 'Oishi', 'HajimeJP', 'LunaJP', 'Matthias']) {
  const run = makeSandbox({ lastTelemetry: {}, sel });
  run.sandbox.oishiRadio = () => { throw new Error('missing margin reached JP localization'); };
  run.sandbox.matthiasRadio = () => { throw new Error('missing margin reached DE localization'); };
  const held = { trigger: 'fuel_warning', fuel: 4, margin_l: null, fact_only: true,
    execution_hold: 'black_flag_unknown', set_fuel_l: null, safety_override: null,
    pit_required: false, message: 'Fuel 4.0. Execution held.' };
  run.sandbox.injectRadio(held);
  check(sel + ' missing margin legacy held fact remains fact', run.speakCalls.length === 1 && run.speakCalls[0].text === heldText(sel, held) && noBoxDirective(run.speakCalls[0].text));
}
for (const bad of [{set_fuel_l:5}, {pit_required:true}, {safety_override:[]}]) {
  check('malformed held fact cannot bypass guard', !overrideGuard.isHeldFuelFact({
    ...realWarning, fact_only: true, execution_hold: 'black_flag_true', margin_l:-2,
    set_fuel_l:null, safety_override:null, ...bad }));
}

check('WO-007 actual Bridge payload artifact exists (run Python actual replay first)', fs.existsSync('/tmp/wo007-held-fuel-replay.json'));
if (fs.existsSync('/tmp/wo007-held-fuel-replay.json')) {
  const productionHeld = JSON.parse(fs.readFileSync('/tmp/wo007-held-fuel-replay.json', 'utf8'));
  for (const data of productionHeld) {
    for (const sel of ['James', 'Kanbe', 'Oishi', 'HajimeJP', 'LunaJP', 'Matthias']) {
      const run = makeSandbox({ lastTelemetry: {}, sel });
      run.sandbox.oishiRadio = () => { throw new Error('production held fact localized to BOX'); };
      run.sandbox.matthiasRadio = () => { throw new Error('production held fact localized to BOX'); };
      run.sandbox.injectRadio(data);
      check('actual production held ' + data.trigger + ' reaches ' + sel,
        run.speakCalls.length === 1 && run.speakCalls[0].text === heldText(sel, data) && noBoxDirective(run.speakCalls[0].text));
    }
  }
  console.log('Actual Bridge held-fuel payloads -> Renderer -> speak: PASS');
}

for (const bad of [{set_fuel_l:5}, {pit_required:true}, {safety_override:[]}]) {
  const run = makeSandbox({ lastTelemetry: { fuel_strategy: { pit_timing_authority: {available:true,decision:'wait'} } } });
  run.sandbox.injectRadio({ ...realWarning, fact_only:true, execution_hold:'black_flag_true',
    set_fuel_l:null, safety_override:null, margin_l:-2, ...bad });
  check('malformed held input falls through real timing guard', run.speakCalls.length===0);
}
console.log('fuel safety + WO-007 total checks: ' + pass);
