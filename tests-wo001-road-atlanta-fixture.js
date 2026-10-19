#!/usr/bin/env node
'use strict';
// ══════════════════════════════════════════════════════════════════════
// WO-001 — Road Atlanta red-thread fixture / trace contract (JS + Bridge
// orchestration slice).
//
// review/PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md § "WO-001 — Road Atlanta
// Red-Thread Fixture / Trace Contract". This file does NOT change product
// behaviour (F01/F02/F03/F06 remain unfixed). It reproduces the exact shape
// of the Build 302 failure through REAL production code:
//
//   - desktop/local-intent-router.js `route()` (real, required directly),
//     wired to the real desktop/strategy-playbook.js `evaluateStrategies`
//     (no existing test in this repo exercised that wiring before this file
//     — see the research note at the bottom of this header).
//   - server.js's real `/api/chat` streaming route (spawned as a child
//     process, exactly like tests-chat-http.js already does), with only the
//     Anthropic SDK constructor replaced by a scripted-stream stub
//     (tests-wo001-anthropic-stream-stub-preload.js).
//   - desktop/renderer.html's real `stripProposalJudgeTag` /
//     `PW_JUDGE_TAG_RE`, extracted with the same balanced-brace VM technique
//     already used by tests-race-conversation-spa-fixture.js.
//   - irsdk-bridge/bridge.py's real `poll_iracing()`, driven by
//     irsdk-bridge/tests_wo001_road_atlanta_fixture.py via
//     irsdk-bridge/replay_harness.py (spawned as a python3 subprocess; its
//     own SCENARIO_TRACE lines are captured and merged into this file's
//     report rather than reimplemented here).
//
// WO-019: the two modes below are historical; only the current contract runs now
// (formerly "acceptance"; characterization retired). Kept for provenance:
// Two run modes, selected by WO001_MODE (default 'characterization'):
//
//   characterization (default) — current (buggy) HEAD behaviour, reproduced
//     through real code. Expected to PASS on unmodified HEAD.
//       $ node tests-wo001-road-atlanta-fixture.js
//
//   acceptance — target (fixed) behaviour. EXPECTED TO FAIL (exit 1) on
//     unmodified HEAD; that failure is this WO's required deliverable. Per
//     the program doc §6, this must NOT be added to preflight.sh (deferred
//     to WO-019) so main is not made permanently red by design.
//       $ WO001_MODE=acceptance node tests-wo001-road-atlanta-fixture.js
//
// Out of scope for this file (see program doc WO-001 §5/§4 item 11):
// reconnect, real TTS, memory, debrief. Their absence from this harness is
// asserted explicitly (see the "unexecuted scope" trace lines) rather than
// silently omitted.
// ══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
// WO-019: the characterization mode (pass while the Build 302 defects were still present) has
// served its purpose — F01/F02/F03/F06 are fixed — so it is retired. There is ONE regression mode,
// the current contract (formerly "acceptance"). WO001_MODE is accepted only for compatibility.
const REQUESTED_MODE = (process.env.WO001_MODE || '').trim();
const MODE = 'acceptance';
if (REQUESTED_MODE && REQUESTED_MODE !== 'acceptance' && REQUESTED_MODE !== 'characterization') {
  console.error("WO001_MODE must be unset, 'acceptance' or 'characterization' (retired), got " + JSON.stringify(REQUESTED_MODE));
  process.exit(2);
}

let pass = 0, fail = 0;
const failures = [];
function check(group, name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ [' + group + '] ' + name); return true; }
  fail++;
  const line = '[' + group + '] ' + name + (detail ? '\n       → ' + String(detail) : '');
  failures.push(line);
  console.log('  ❌ ' + line);
  return false;
}

function emitTrace(fields) {
  const f = Object.assign({
    scenario_id: 'road_atlanta_build302_red_thread_v1',
    event_id: '?', type: '?', source: '?', harness_correlation_id: '?',
    product_race_id: null, product_decision_id: null, product_pit_event_id: null,
    reachability: 'reached', harness_status: 'ok', finding: 'none',
    expected: '', actual: '',
  }, fields);
  console.log(
    'SCENARIO_TRACE scenario_id=' + f.scenario_id + ' event_id=' + f.event_id + ' type=' + f.type + '\n' +
    'source=' + f.source + '\n' +
    'harness_correlation_id=' + f.harness_correlation_id + '\n' +
    'product_race_id=' + f.product_race_id + ' product_decision_id=' + f.product_decision_id +
    ' product_pit_event_id=' + f.product_pit_event_id + '\n' +
    'reachability=' + f.reachability + ' harness_status=' + f.harness_status + '\n' +
    'finding=' + f.finding + '\n' +
    'expected=' + f.expected + ' actual=' + f.actual);
}

class HarnessError extends Error {}

// ══════════════════════════════════════════════════════════════════════
// §1 Fixture loading / schema validation (WO-001 §8 item 9)
// ══════════════════════════════════════════════════════════════════════

const FIXTURE_PATH = path.join(ROOT, 'fixtures', 'road-atlanta',
  'road_atlanta_build302_red_thread_v1.json');

// ★Codex REVISE #1, item 3: enumerate every payload leaf (recursing into
// arrays) so provenance completeness can be checked against ALL of them,
// not just whichever keys already happen to have a tag.
function leafPaths(value, prefix) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value).flatMap(k => leafPaths(value[k], prefix + '.' + k));
  }
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => leafPaths(v, prefix + '[' + i + ']'));
  }
  return [prefix];
}

// ── Fixture schema constants (Codex REVISE #2, item 4) ──────────────────
// Kept in lockstep with irsdk-bridge/tests_wo001_road_atlanta_fixture.py's
// EXPECTED_SCENARIO_ID / EXPECTED_EVENT_ID_ORDER / EXPECTED_TYPE_ORDER /
// HANDOFF_LAP21_EXPECTATION so both validators reject the same mutations.
const EXPECTED_SCENARIO_ID = 'road_atlanta_build302_red_thread_v1';
const EXPECTED_EVENT_ID_ORDER = Array.from({ length: 12 }, (_, i) => 'e' + String(i + 1).padStart(2, '0'));
const EXPECTED_TYPE_ORDER = [
  'telemetry', 'driver_utterance', 'driver_utterance', 'driver_utterance',
  'telemetry', 'pit_entry', 'pit_exit', 'flag', 'pit_exit', 'telemetry',
  'delivery', 'debrief',
];
const KNOWN_EVENT_TYPES = new Set([
  'telemetry', 'driver_utterance', 'pit_entry', 'pit_exit',
  'flag', 'delivery', 'speech', 'debrief',
]);
const HANDOFF_LAP21_EXPECTATION = { lap: 21, fuel_l: 18.14, required_fuel_l: 9.98, margin_l: 8.16 };

// ── F06 target contract (Codex REVISE #2, item 3) ────────────────────────
// Design placeholder for the not-yet-implemented pit-execution-declaration
// path, following the same caveat already recorded for F03's
// black_flag_evidence contract: the structural requirement — a concrete
// intent/action/state result showing the SAME active plan was changed, not
// merely `handled:true` on an unrelated route — is what matters here, not
// these exact field names. Since router.js does not implement this at all
// (WO-001 §5 excludes PlanLifecycleRecord/DriverPitEvent), both checks below
// are expected to stay red until a later WO implements the real contract.
const PIT_EXECUTION_INTENT = 'pit_execution_declaration';
const PIT_EXECUTION_REASON_INTENT = 'pit_execution_reason';
// Codex REVISE #3, item 3: the prior contract only checked
// activePlanChange.applied===true (e03) and linkedDeclarationIntent (e04)
// independently — it never checked that BOTH events actually reference the
// SAME plan/decision. isPitExecutionDeclaration() now also requires e03 to
// carry a non-empty canonical plan/decision id AND a concrete change result
// (not just applied===true), and isPitExecutionReason() requires e04 to
// carry a non-empty linkedPlanId. isSameCanonicalPlanReference() below is
// the separate, independent assert that the two ids actually match — an
// unrelated reason event attached to a DIFFERENT plan must not be treated
// as connected.
function isPitExecutionDeclaration(r) {
  return !!(r && r.handled === true && r.intent === PIT_EXECUTION_INTENT
    && r.action && r.action.type === 'driver_plan_command'
    && r.action.operation === 'early_pit'
    && !Object.prototype.hasOwnProperty.call(r.action, 'activePlanChange'));
}
function isPitExecutionReason(r) {
  return !!(r && r.handled === true && r.intent === PIT_EXECUTION_REASON_INTENT
    && r.action && r.action.type === 'driver_plan_reason'
    && r.action.linkedDeclarationIntent === PIT_EXECUTION_INTENT);
}
function isSameCanonicalPlanReference(declarationResult, reasonResult) {
  const da = declarationResult && declarationResult.action;
  const ra = reasonResult && reasonResult.action;
  return !!(da && ra && da.commandId && da.decisionId
    && da.commandId === ra.linkedCommandId && da.decisionId === ra.linkedDecisionId);
}

function readFixtureDoc() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

// Structural validation only, mirroring Python's validate_fixture(doc):
// takes an already-parsed doc so in-memory mutated copies can be checked
// without touching disk (Codex REVISE #2, item 4 negative-mutation tests).
function validateFixtureDoc(doc) {
  if (doc.scenario_id !== EXPECTED_SCENARIO_ID) {
    throw new HarnessError('fixture scenario_id ' + JSON.stringify(doc.scenario_id)
      + ' does not match expected ' + JSON.stringify(EXPECTED_SCENARIO_ID));
  }
  const events = doc.events;
  if (!Array.isArray(events) || !events.length) throw new HarnessError('fixture has no events');
  const seen = new Set();
  const seenCorrelationIds = new Set();
  // Codex REVISE #3, item 1: a non-null product_identity value legitimately
  // REAPPEARING across events (e.g. the same decision_id correlating e05's
  // Plan A commit to e10's BOX outcome) is the normal longitudinal
  // correlation this WO exists to prove, and must be ACCEPTED. Only a
  // CONTRADICTORY mapping — the same child identity value (decision_id,
  // pit_event_id) attributed to two different parent identity values
  // (race_instance_id, decision_id) in different events — is rejected.
  const identityMapping = {
    'decision_id->race_instance_id': new Map(),
    'pit_event_id->race_instance_id': new Map(),
    'pit_event_id->decision_id': new Map(),
  };
  const handoffExpectationEvents = [];
  for (const ev of events) {
    if (!ev.event_id || seen.has(ev.event_id)) throw new HarnessError('bad/duplicate event_id: ' + ev.event_id);
    seen.add(ev.event_id);
    if (typeof ev.harness_correlation_id !== 'string' || !ev.harness_correlation_id) {
      throw new HarnessError(ev.event_id + ' missing/empty harness_correlation_id');
    }
    if (seenCorrelationIds.has(ev.harness_correlation_id)) {
      throw new HarnessError(ev.event_id + ' duplicate harness_correlation_id '
        + JSON.stringify(ev.harness_correlation_id) + ' (already used by another event)');
    }
    seenCorrelationIds.add(ev.harness_correlation_id);
    if (!ev.product_identity || !('race_instance_id' in ev.product_identity)
        || !('decision_id' in ev.product_identity) || !('pit_event_id' in ev.product_identity)) {
      throw new HarnessError(ev.event_id + ' incomplete product_identity');
    }
    for (const key of ['race_instance_id', 'decision_id', 'pit_event_id']) {
      const val = ev.product_identity[key];
      if (val !== null && val !== undefined) {
        if (typeof val !== 'string' || !val) {
          throw new HarnessError(ev.event_id + ' product_identity.' + key
            + ' must be null or a non-empty string, got ' + JSON.stringify(val));
        }
      }
    }
    // Codex REVISE #3, item 1: reject only a CONTRADICTORY mapping, never a
    // repeated-but-consistent value.
    for (const [childKey, parentKey] of [
      ['decision_id', 'race_instance_id'],
      ['pit_event_id', 'race_instance_id'],
      ['pit_event_id', 'decision_id'],
    ]) {
      const childVal = ev.product_identity[childKey];
      const parentVal = ev.product_identity[parentKey];
      if (childVal !== null && childVal !== undefined && parentVal !== null && parentVal !== undefined) {
        const mapping = identityMapping[childKey + '->' + parentKey];
        const priorParent = mapping.get(childVal);
        if (priorParent !== undefined && priorParent !== parentVal) {
          throw new HarnessError(ev.event_id + ' contradictory product_identity mapping: ' + childKey + ' '
            + JSON.stringify(childVal) + ' was already mapped to ' + parentKey + ' ' + JSON.stringify(priorParent)
            + ' by an earlier event, but this event maps it to ' + parentKey + ' ' + JSON.stringify(parentVal));
        }
        mapping.set(childVal, parentVal);
      }
    }
    if (!KNOWN_EVENT_TYPES.has(ev.type)) {
      throw new HarnessError(ev.event_id + ' has unknown type ' + JSON.stringify(ev.type));
    }
    if (!ev.payload || typeof ev.payload !== 'object') throw new HarnessError(ev.event_id + ' missing payload object');
    if (!ev.provenance || typeof ev.provenance !== 'object') throw new HarnessError(ev.event_id + ' missing provenance');
    for (const [field, tag] of Object.entries(ev.provenance)) {
      if (!['repository_evidence', 'handoff_only', 'synthetic_reconstruction'].includes(tag.source_class)) {
        throw new HarnessError(ev.event_id + ' provenance ' + field + ' bad source_class: ' + tag.source_class);
      }
      if (!tag.reference) throw new HarnessError(ev.event_id + ' provenance ' + field + ' missing reference');
    }
    // Every payload leaf (incl. array elements) and every populated
    // top-level synthetic fact (source_frame_id/at) must carry EXACTLY one
    // provenance tag — neither missing nor unmatched/extra.
    const requiredTags = new Set(leafPaths(ev.payload, 'payload'));
    if (ev.source_frame_id !== null && ev.source_frame_id !== undefined) requiredTags.add('source_frame_id');
    if (ev.at !== null && ev.at !== undefined) requiredTags.add('at');
    const providedTags = new Set(Object.keys(ev.provenance));
    for (const tag of requiredTags) {
      if (!providedTags.has(tag)) throw new HarnessError(ev.event_id + ' provenance missing tag for ' + tag);
    }
    for (const tag of providedTags) {
      if (!requiredTags.has(tag)) throw new HarnessError(ev.event_id + ' provenance has extra/unmatched tag ' + tag);
    }
    if ('handoff_expectation' in ev) handoffExpectationEvents.push([ev.event_id, ev.handoff_expectation]);
  }
  // ★Codex REVISE #2, item 4: assert the FULL fixed event_id and type
  // order, not merely "pit_entry before flag".
  const idsInOrder = events.map(e => e.event_id);
  if (JSON.stringify(idsInOrder) !== JSON.stringify(EXPECTED_EVENT_ID_ORDER)) {
    throw new HarnessError('fixture event_id order ' + JSON.stringify(idsInOrder)
      + ' does not match expected ' + JSON.stringify(EXPECTED_EVENT_ID_ORDER));
  }
  const typesInOrder = events.map(e => e.type);
  if (JSON.stringify(typesInOrder) !== JSON.stringify(EXPECTED_TYPE_ORDER)) {
    throw new HarnessError('fixture type order ' + JSON.stringify(typesInOrder)
      + ' does not match expected ' + JSON.stringify(EXPECTED_TYPE_ORDER));
  }
  // ★Codex REVISE #2, item 1: the HANDOFF lap-21 expectation fact must be
  // present exactly once (on e10) and match HANDOFF.md's recorded numbers
  // verbatim.
  if (handoffExpectationEvents.length !== 1) {
    throw new HarnessError('expected exactly one event carrying handoff_expectation, got '
      + handoffExpectationEvents.length);
  }
  const [hxEventId, hx] = handoffExpectationEvents[0];
  if (hxEventId !== 'e10') throw new HarnessError('handoff_expectation must be carried by e10, found on ' + hxEventId);
  if (!hx || typeof hx !== 'object') throw new HarnessError(hxEventId + ' handoff_expectation must be an object');
  for (const [key, expected] of Object.entries(HANDOFF_LAP21_EXPECTATION)) {
    if (hx[key] !== expected) {
      throw new HarnessError(hxEventId + ' handoff_expectation.' + key + ' = ' + JSON.stringify(hx[key])
        + ' does not match HANDOFF.md-recorded ' + JSON.stringify(expected));
    }
  }
  if (hx.source_class !== 'handoff_only') {
    throw new HarnessError(hxEventId + ' handoff_expectation.source_class must be handoff_only, got '
      + JSON.stringify(hx.source_class));
  }
  if (!hx.reference) throw new HarnessError(hxEventId + ' handoff_expectation missing reference');
  return doc;
}

function loadFixture() {
  return validateFixtureDoc(readFixtureDoc());
}

// Codex REVISE #2, item 4: dedicated negative-mutation checks proving the
// loader REJECTS an event-order swap, a duplicated harness_correlation_id,
// a changed scenario_id, and a duplicated product_identity value. Operates
// entirely on an in-memory deep copy; never writes to disk.
function runFixtureSchemaNegativeMutations() {
  const base = readFixtureDoc();
  const clone = () => JSON.parse(JSON.stringify(base));
  const rejects = (mutate) => {
    const doc = clone();
    mutate(doc);
    try { validateFixtureDoc(doc); return false; }
    catch (e) { return e instanceof HarnessError; }
  };
  const accepts = (mutate) => {
    const doc = clone();
    mutate(doc);
    try { validateFixtureDoc(doc); return true; }
    catch (e) { return false; }
  };
  check('fixture negative-mutation', 'event order swap is rejected',
    rejects(doc => { const [a, b] = doc.events; doc.events[0] = b; doc.events[1] = a; }));
  check('fixture negative-mutation', 'duplicate harness_correlation_id is rejected',
    rejects(doc => { doc.events[1].harness_correlation_id = doc.events[0].harness_correlation_id; }));
  check('fixture negative-mutation', 'empty harness_correlation_id is rejected',
    rejects(doc => { doc.events[0].harness_correlation_id = ''; }));
  check('fixture negative-mutation', 'scenario_id change is rejected',
    rejects(doc => { doc.scenario_id = 'some_other_scenario_id'; }));
  check('fixture negative-mutation', 'repeated product_identity value across events is accepted (normal longitudinal correlation, e.g. e05 decision -> e10 BOX outcome)',
    accepts(doc => {
      doc.events[4].product_identity.decision_id = 'decision-1';
      doc.events[4].product_identity.race_instance_id = 'race-1';
      doc.events[9].product_identity.decision_id = 'decision-1';
      doc.events[9].product_identity.race_instance_id = 'race-1';
    }));
  check('fixture negative-mutation', 'contradictory product_identity mapping (same decision_id, different race_instance_id) is rejected',
    rejects(doc => {
      doc.events[4].product_identity.decision_id = 'decision-1';
      doc.events[4].product_identity.race_instance_id = 'race-1';
      doc.events[9].product_identity.decision_id = 'decision-1';
      doc.events[9].product_identity.race_instance_id = 'race-2';
    }));
  check('fixture negative-mutation', 'non-string product_identity value is rejected',
    rejects(doc => { doc.events[5].product_identity.pit_event_id = 12345; }));
  check('fixture negative-mutation', 'unknown event type is rejected',
    rejects(doc => { doc.events[0].type = 'not_a_real_type'; }));
  check('fixture negative-mutation', 'missing handoff_expectation is rejected',
    rejects(doc => { delete doc.events.find(e => e.event_id === 'e10').handoff_expectation; }));
  check('fixture negative-mutation', 'changed handoff_expectation value is rejected',
    rejects(doc => { doc.events.find(e => e.event_id === 'e10').handoff_expectation.margin_l = 999; }));
  check('fixture negative-mutation', 'unmutated fixture still validates (sanity control)',
    (() => { try { validateFixtureDoc(clone()); return true; } catch (e) { return false; } })());
}

// Codex REVISE #3, item 3: direct positive/negative probes on the F06
// linkage predicate itself (isSameCanonicalPlanReference), proving it
// actually discriminates a genuine same-plan link from a same-shape but
// unrelated-plan reason event — not just that the real router currently
// fails both checks (which it does, for the unrelated reason that neither
// intent exists yet). Pure in-memory function calls; no fixture/router I/O.
function runF06PredicateContractProbes() {
  const declaration = (planId, commandId='command-1') => ({
    handled: true, intent: PIT_EXECUTION_INTENT,
    action: { type: 'driver_plan_command', operation:'early_pit', commandId, decisionId:planId },
  });
  const reason = (linkedPlanId, linkedCommandId='command-1') => ({
    handled: true, intent: PIT_EXECUTION_REASON_INTENT,
    action: { type: 'driver_plan_reason', linkedDeclarationIntent: PIT_EXECUTION_INTENT,
      linkedDecisionId:linkedPlanId, linkedCommandId },
  });
  check('F06 predicate contract', 'e03/e04 referencing the SAME plan id is accepted as linked',
    isSameCanonicalPlanReference(declaration('plan-1'), reason('plan-1')));
  check('F06 predicate contract', 'e03/e04 referencing DIFFERENT plan ids is rejected as unlinked (not a coincidental handled:true match)',
    !isSameCanonicalPlanReference(declaration('plan-1'), reason('plan-2')));
  check('F06 predicate contract', 'e04 with an empty/missing linkedPlanId is rejected even if both intents otherwise match',
    !isSameCanonicalPlanReference(declaration('plan-1'), reason(null)));
}

// ══════════════════════════════════════════════════════════════════════
// §2 Router slice (F06): real local-intent-router.js + real
//    strategy-playbook.js wiring, which no existing test in this repo
//    exercises together (strategyEvaluation was never injected elsewhere).
// ══════════════════════════════════════════════════════════════════════

const router = require(path.join(ROOT, 'desktop', 'local-intent-router.js'));
const playbookApi = require(path.join(ROOT, 'desktop', 'strategy-playbook.js'));

function buildRealPlaybookWiring() {
  const playbook = playbookApi.buildPlaybook({
    totalLaps: 30,
    historicalFuelPerLapL: 3.6,
    historicalFuelSamples: 5,
    effectiveCapacityL: 60,
    startingFuelL: 60,
    pitLaneS: 30,
  });
  if (!playbook || playbook.available !== true) {
    throw new HarnessError('real buildPlaybook() did not produce an available playbook: '
      + JSON.stringify(playbook));
  }
  return { playbook, api: playbookApi };
}

function routeDriverUtterance(text, live, strategyEvaluation) {
  return router.route({ text, lang: 'ja', live, strategyEvaluation });
}

function runRouterSlice(fixtureDoc) {
  const wiring = buildRealPlaybookWiring();
  const utteranceEvents = fixtureDoc.events.filter(e => e.type === 'driver_utterance');
  const live = {
    lap: 14, fuel: 20.4, session_type: 'Race', on_track: true, on_pit_road: false,
    fuel_strategy: { estimated_crossings_to_finish: 3 },
    strategy_options: { available: true, snapshot_id: 'wo001:test:1',
      plan_a: { available: true, target_lap: 17, add_fuel_l: 44.9, set_fuel_l: 45 },
      plan_b: { available: true, target_lap: 15, fuel_window_open: true, add_fuel_l: 30, set_fuel_l: 34 },
    },
  };
  let priorExecution = null;
  const results = utteranceEvents.map(ev => {
    const r = router.route({ text:ev.payload.text, lang:'ja', live,
      strategyEvaluation:wiring, pendingDriverPlanCommand:priorExecution });
    if (r && r.action && r.action.type === 'driver_plan_command') {
      priorExecution = { commandId:'fixture-command-e03', decisionId:'fixture-plan-a' };
    } else if (r && r.action && r.action.type === 'driver_plan_reason') {
      priorExecution = null;
    }
    return { event: ev, result: r };
  });
  return { wiring, live, results };
}

// ══════════════════════════════════════════════════════════════════════
// §3 Server stream + Renderer judge-parser slice (F02).
// ══════════════════════════════════════════════════════════════════════

function extractFunction(src, name) {
  const marker = 'function ' + name + '(';
  const start = src.indexOf(marker);
  if (start === -1) throw new HarnessError('function ' + name + ' not found in renderer.html');
  let i = src.indexOf('{', start);
  if (i === -1) throw new HarnessError('function ' + name + ' body not found');
  let depth = 0, end = -1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new HarnessError('function ' + name + ' unbalanced braces');
  return src.slice(start, end);
}

function makeJudgeParserContext(rendererSrc) {
  const startDecl = (rendererSrc.match(/const PW_JUDGE_TAG_START = [\s\S]*?;/) || [''])[0];
  const reDecl = (rendererSrc.match(/const PW_JUDGE_TAG_RE = [\s\S]*?;/) || [''])[0];
  if (!startDecl || !reDecl) throw new HarnessError('PW_JUDGE_TAG_START/RE not found in renderer.html');
  const stripSrc = extractFunction(rendererSrc, 'stripProposalJudgeTag');
  const ctx = { console, globalThis: null };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(startDecl + '\n' + reDecl + '\n' + stripSrc
    + '\nglobalThis.__strip = stripProposalJudgeTag;', ctx);
  return ctx;
}

function probeRendererParserDependency(rendererSrc) {
  // Break PW_JUDGE_TAG_RE itself (in an in-memory copy) and confirm a
  // well-formed tag that previously parsed to a judgment now parses to
  // judgment:null — proving the F02 control-case assertion genuinely
  // depends on the real regex, not a coincidence of the fixture text.
  const reDecl = (rendererSrc.match(/const PW_JUDGE_TAG_RE = [\s\S]*?;/) || [''])[0];
  if (!reDecl) throw new HarnessError('PW_JUDGE_TAG_RE not found in renderer.html');
  const startDecl = (rendererSrc.match(/const PW_JUDGE_TAG_START = [\s\S]*?;/) || [''])[0];
  const stripSrc = extractFunction(rendererSrc, 'stripProposalJudgeTag');
  const wellFormed = 'text.\n<<PW_JUDGE decision_id="d1" classification="confirm">>\n';

  const originalCtx = makeJudgeParserContext(rendererSrc);
  const originalJudgment = originalCtx.__strip(wellFormed).judgment;

  const mutatedReDecl = reDecl.replace(
    /classification="\(confirm\|decline\|same_topic\|unrelated\)"/,
    'classification="(never_matches_anything)"');
  if (mutatedReDecl === reDecl) throw new HarnessError('reachability probe renderer-parser: classification alternation not found to mutate');
  const mutatedCtx = { console, globalThis: null };
  mutatedCtx.globalThis = mutatedCtx;
  vm.createContext(mutatedCtx);
  vm.runInContext(startDecl + '\n' + mutatedReDecl + '\n' + stripSrc
    + '\nglobalThis.__strip = stripProposalJudgeTag;', mutatedCtx);
  const mutatedJudgment = mutatedCtx.__strip(wellFormed).judgment;

  return { originalJudgment, mutatedJudgment };
}

function b64Chunks(chunks) {
  return Buffer.from(JSON.stringify({ chunks })).toString('base64');
}

// ★2026-10-08 WO013: encode a full scenario (chunks plus the SDK completion
// shape — stop_reason / whether message_stop fires / a mid-stream throw) for
// the extended stub, so the real server.js judgeTransport:'v1' completion
// gate can be driven through normal AND abnormal completions.
function b64Scenario(scenario) {
  return Buffer.from(JSON.stringify(scenario)).toString('base64');
}

function postStream(port, marker, extraBody = {}) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const body = JSON.stringify({
      stream: true, character: 'LunaJP',
      messages: [{ role: 'user', content: 'Tell me the plan. ' + marker }],
      ...extraBody,
    });
    const req = http.request({
      hostname: 'localhost', port, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ★2026-10-08 WO013: a test-side-only NDJSON decoder, written independently
// of desktop/renderer.html's own parsing (so this harness does not simply
// re-exercise the same code it is trying to verify). Mirrors the SHAPE the
// real server.js structured transport promises (text / judgment / end,
// newline-delimited), not its implementation.
function decodeJudgeNdjson(rawBody) {
  const lines = String(rawBody || '').split('\n').filter(l => l.length > 0);
  let text = '';
  let judgment = null;
  let ended = false;
  const frames = [];
  for (const line of lines) {
    let frame;
    try { frame = JSON.parse(line); } catch (e) { frames.push({ malformed: line }); continue; }
    frames.push(frame);
    if (typeof frame.text === 'string') text += frame.text;
    else if (frame.judgment) judgment = frame.judgment;
    else if (frame.end === true) ended = true;
  }
  return { text, judgment, ended, frames };
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new HarnessError('server did not start in time')), 15000);
    child.stdout.on('data', d => { if (d.toString().includes('is running')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', d => process.stderr.write('[server] ' + d));
    child.on('exit', code => { clearTimeout(timer); reject(new HarnessError('server exited early: code=' + code)); });
  });
}

async function withServer(port, fn) {
  const child = spawn(process.execPath,
    ['-r', './tests-wo001-anthropic-stream-stub-preload.js', 'server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), ANTHROPIC_API_KEY: 'sk-test-local-stub',
        DATABASE_URL: '', JWT_SECRET: '', STRIPE_SECRET_KEY: '' },
    });
  try { await waitForServer(child); return await fn(port); }
  finally { child.kill('SIGTERM'); }
}

async function runServerStreamSlice(judgeCtx) {
  const TAG = '<<PW_JUDGE decision_id="d1" classification="confirm">>';
  const sentence = '既定プラン継続。';
  // Legacy (no opt-in) scenarios: unchanged byte-for-byte plain-text path.
  // These characterize the ORIGINAL F02 bug and — per WO013 scope — stay a
  // bug for callers that never opt in (no pendingJudgment to classify
  // against, so there is nothing to protect by special-casing the marker
  // inside emitCompleteSentences for every plain client).
  const legacyScenarios = {
    no_punctuation_single_chunk: { chunks: [sentence + '\n' + TAG] },
    no_punctuation_multi_chunk: { chunks: (sentence + '\n' + TAG).split('') },
    trailing_newline_control_single_chunk: { chunks: [sentence + '\n' + TAG + '\n'] },
  };
  // judgeTransport:'v1' opted-in scenarios against the REAL server.js. Each
  // entry also declares the pendingJudgment this specific request body will
  // send, so the expected decision_id/request_id mismatch and multi/
  // malformed-tag fail-closed behaviour can be asserted against the live
  // response rather than a copy of the logic under test.
  const did = 'd1', rid = 'req-1';
  const jtScenarios = {
    normal_confirm_single_chunk: { chunks: [sentence + '\n' + TAG] },
    normal_confirm_multi_chunk: { chunks: (sentence + '\n' + TAG).split('') },
    decision_id_mismatch: { chunks: [sentence + '\n<<PW_JUDGE decision_id="other" classification="confirm">>'] },
    multiple_tags_same_generation: {
      chunks: [sentence + '\n' + TAG + '<<PW_JUDGE decision_id="' + did + '" classification="decline">>'],
    },
    trailing_garbage_after_tag: { chunks: [sentence + '\n' + TAG + ' extra'] },
    quoted_echo_tag: { chunks: ['ドライバーは"' + TAG + '"と書いた'] },
    malformed_classification: { chunks: [sentence + '\n<<PW_JUDGE decision_id="' + did + '" classification="maybe">>'] },
    max_tokens_truncated: { chunks: [sentence + '\n' + TAG], stopReason: 'max_tokens' },
    missing_message_stop: { chunks: [sentence + '\n' + TAG], omitMessageStop: true },
    abnormal_throw_mid_stream: { chunks: [sentence], throwMidStream: true },
    // ★2026-10-08 WO013 r3 (独立監査 repro): the tag is itself a perfectly
    // well-formed, exactly-matching machine line, but it is INLINE after an
    // introductory phrase on the SAME line ("引用形式これ: <<PW_JUDGE...>>")
    // rather than starting its own line — the prompt's own-line contract is
    // violated even though JT_TAG_RE's ^...$ match alone would accept it.
    inline_quoted_intro_single_chunk: { chunks: ['引用形式これ: ' + TAG] },
    inline_quoted_intro_multi_chunk: { chunks: ('引用形式これ: ' + TAG).split('') },
  };
  const out = {};
  const stubMod = require('./tests-wo001-anthropic-stream-stub-preload.js');
  await withServer(3999, async (port) => {
    for (const [name, def] of Object.entries(legacyScenarios)) {
      const marker = stubMod.MARKER + b64Chunks(def.chunks);
      const r = await postStream(port, marker);
      const parsed = judgeCtx.__strip(r.body);
      out[name] = { httpStatus: r.status, rawBody: r.body, parsed, judgeTransportHeader: r.headers['x-pitwall-judge-transport'] || null };
    }
    for (const [name, def] of Object.entries(jtScenarios)) {
      const marker = stubMod.MARKER + b64Scenario(def);
      const r = await postStream(port, marker, { judgeTransport: 'v1', pendingJudgment: { decision_id: did, request_id: rid } });
      const decoded = decodeJudgeNdjson(r.body);
      out[name] = { httpStatus: r.status, rawBody: r.body, decoded, judgeTransportHeader: r.headers['x-pitwall-judge-transport'] || null };
    }
    // Negative control: same decision_id/request_id opt-in, but the request
    // body omits request_id — the whole opt-in must degrade to the legacy
    // plain-text path (no NDJSON, no judgeTransport header), never a partial
    // structured response.
    {
      const marker = stubMod.MARKER + b64Chunks([sentence + '\n' + TAG]);
      const r = await postStream(port, marker, { judgeTransport: 'v1', pendingJudgment: { decision_id: did } });
      out.incomplete_optin_falls_back_to_legacy = { httpStatus: r.status, rawBody: r.body, judgeTransportHeader: r.headers['x-pitwall-judge-transport'] || null };
    }
  });
  return out;
}

// ★2026-10-08 WO013 reachability probe: mutate a REAL on-disk copy of
// server.js so the judgeTransport completion gate no longer requires a
// normal stop_reason, spawn a server from that mutated copy, and confirm
// the max_tokens-truncated scenario — which must withhold judgment/end on
// unmodified HEAD — now wrongly emits one. This proves the acceptance
// assertions below actually depend on that exact gate, not on fixture luck.
async function probeJudgeTransportCompletionGateDependency() {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const from = "const _judgeNormalCompletion = jtSawMessageStop\n            && (jtStopReason === 'end_turn' || jtStopReason === 'stop_sequence');";
  const count = serverSrc.split(from).length - 1;
  if (count !== 1) throw new HarnessError('reachability probe judge-completion-gate: from matched ' + count + ' times, expected 1');
  const mutated = serverSrc.split(from).join('const _judgeNormalCompletion = true; /* probe: gate disabled */');
  const tmpServerPath = path.join(ROOT, '.wo001-server-judge-probe.tmp.js');
  fs.writeFileSync(tmpServerPath, mutated);
  const stubMod = require('./tests-wo001-anthropic-stream-stub-preload.js');
  try {
    const child = spawn(process.execPath,
      ['-r', './tests-wo001-anthropic-stream-stub-preload.js', '.wo001-server-judge-probe.tmp.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: '3998', ANTHROPIC_API_KEY: 'sk-test-local-stub',
          DATABASE_URL: '', JWT_SECRET: '', STRIPE_SECRET_KEY: '' },
      });
    try {
      await waitForServer(child);
      const marker = stubMod.MARKER + b64Scenario({ chunks: ['既定プラン継続。\n<<PW_JUDGE decision_id="d1" classification="confirm">>'], stopReason: 'max_tokens' });
      const r = await postStream(3998, marker, { judgeTransport: 'v1', pendingJudgment: { decision_id: 'd1', request_id: 'req-1' } });
      return { mutatedOut: decodeJudgeNdjson(r.body) };
    } finally { child.kill('SIGTERM'); }
  } finally {
    try { fs.unlinkSync(tmpServerPath); } catch (e) { /* best effort */ }
  }
}

// ★2026-10-08 WO013 r3 reachability probe: mutate a REAL on-disk copy of
// server.js so the "tag must start its own line" guard never fires, spawn a
// server from that mutated copy, and confirm the inline-introduced-tag
// scenario — which must fail closed on unmodified HEAD — now wrongly emits
// a judgment. Proves the r3 own-line fix is load-bearing, not fixture luck.
async function probeJudgeTransportOwnLineGateDependency() {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const from = "if (precedingChar !== '' && precedingChar !== '\\n') {";
  const count = serverSrc.split(from).length - 1;
  if (count !== 1) throw new HarnessError('reachability probe judge-own-line-gate: from matched ' + count + ' times, expected 1');
  const mutated = serverSrc.split(from).join("if (false /* probe: own-line gate disabled */) {");
  const tmpServerPath = path.join(ROOT, '.wo001-server-ownline-probe.tmp.js');
  fs.writeFileSync(tmpServerPath, mutated);
  const stubMod = require('./tests-wo001-anthropic-stream-stub-preload.js');
  try {
    const child = spawn(process.execPath,
      ['-r', './tests-wo001-anthropic-stream-stub-preload.js', '.wo001-server-ownline-probe.tmp.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: '3997', ANTHROPIC_API_KEY: 'sk-test-local-stub',
          DATABASE_URL: '', JWT_SECRET: '', STRIPE_SECRET_KEY: '' },
      });
    try {
      await waitForServer(child);
      const marker = stubMod.MARKER + b64Scenario({ chunks: ['引用形式これ: <<PW_JUDGE decision_id="d1" classification="confirm">>'] });
      const r = await postStream(3997, marker, { judgeTransport: 'v1', pendingJudgment: { decision_id: 'd1', request_id: 'req-1' } });
      return { mutatedOut: decodeJudgeNdjson(r.body) };
    } finally { child.kill('SIGTERM'); }
  } finally {
    try { fs.unlinkSync(tmpServerPath); } catch (e) { /* best effort */ }
  }
}

// ══════════════════════════════════════════════════════════════════════
// §4 Bridge slice orchestration: shell out to the real Python replay
//    (does not reimplement it — see irsdk-bridge/tests_wo001_road_atlanta_fixture.py).
// ══════════════════════════════════════════════════════════════════════

function runBridgeSlice(mode) {
  const r = spawnSync('python3', ['irsdk-bridge/tests_wo001_road_atlanta_fixture.py'], {
    cwd: ROOT, env: { ...process.env, WO001_MODE: mode }, encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ══════════════════════════════════════════════════════════════════════
// §5 Reachability probes on isolated in-memory copies (item 10). These
//    never touch the real files on disk — a from/to substitution is
//    applied to a STRING copy of the source before vm-loading it, mirroring
//    the discipline tools/mutate.js already enforces for on-disk mutation
//    (declared from/to, must match exactly once), without needing its
//    file-lock/journal machinery for a purely in-memory probe.
// ══════════════════════════════════════════════════════════════════════

function mutateOnce(src, from, to, label) {
  const count = src.split(from).length - 1;
  if (count !== 1) throw new HarnessError('reachability probe ' + label + ': from matched ' + count + ' times, expected 1');
  return src.split(from).join(to);
}

function probeRouterRegexDependency() {
  // Break the exact regex branch that F06 depends on ("入る|行く|どう..."
  // strategyCallKind 'recommendation' match) and confirm the
  // characterization result flips.
  const routerSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'local-intent-router.js'), 'utf8');
  const from = "    if(early)return {kind:'command',operation:'early_pit',";
  const to = "    if(false)return {kind:'command',operation:'early_pit',";
  const mutated = mutateOnce(routerSrc, from, to, 'driver-plan-command-classifier');
  const tmpPath = path.join(ROOT, '.wo001-router-probe.tmp.js');
  fs.writeFileSync(tmpPath, mutated);
  try {
    delete require.cache[require.resolve(tmpPath)];
    const mutatedRouter = require(tmpPath);
    const wiring = buildRealPlaybookWiring();
    const live = { lap: 14, fuel: 20.4, session_type: 'Race', on_track: true, on_pit_road: false,
      fuel_strategy: { estimated_crossings_to_finish: 3 },
      strategy_options: { available: true, snapshot_id: 'wo001:test:1',
        plan_a: { available: true, target_lap: 17 } } };
    const before = router.route({ text: 'ピット入るぞ', lang: 'ja', live, strategyEvaluation: wiring });
    const after = mutatedRouter.route({ text: 'ピット入るぞ', lang: 'ja', live, strategyEvaluation: wiring });
    const isCommand = r => !!(r && r.action && r.action.type === 'driver_plan_command');
    return {
      beforeIntent: before && before.intent, afterIntent: after && after.intent,
      beforeIsCommand: isCommand(before), afterIsCommand: isCommand(after),
    };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (e) { /* best effort */ }
    delete require.cache[require.resolve(tmpPath)] && void 0;
  }
}

function probeServerTruncationDependency(rendererSrc) {
  // Break the "drop unterminated tail" line in a private COPY of the
  // emitCompleteSentences source, run it standalone with fake chunks, and
  // confirm the PW_JUDGE tag survives once the drop is disabled — proving
  // the server-stream characterization result actually depends on that
  // exact line, not a coincidence of the fixture text.
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const marker = 'const emitCompleteSentences = (final = false) => {';
  const start = serverSrc.indexOf(marker);
  if (start < 0) throw new HarnessError('emitCompleteSentences not found in server.js');
  let i = serverSrc.indexOf('{', start), depth = 0, end = -1;
  for (; i < serverSrc.length; i++) {
    if (serverSrc[i] === '{') depth++;
    else if (serverSrc[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new HarnessError('emitCompleteSentences unbalanced braces');
  const fnSrc = serverSrc.slice(start, end);
  // Rebind the extracted `const emitCompleteSentences = (final=false)=>{...}`
  // onto `globalThis` (vm sandboxes only expose `var`/function-declaration
  // globals as sandbox properties, not `let`/`const` lexical bindings), and
  // rebind its captured `pendingText`/`emittedText`/`outputClosed` locals to
  // `var` so they too become reachable/resettable sandbox properties.
  const rebindable = fnSrc.replace(/^const emitCompleteSentences = /, 'globalThis.emitCompleteSentences = ');
  const from = "if (boundary < 0 && final && emittedText) {\n            pendingText = '';\n            outputClosed = true;\n            return;\n          }";
  const runVariant = (src, feedText) => {
    const ctx = { console, safeMaxChars: 500, limitReplyText: (s) => s, unicodeLength: (s) => s.length,
      pendingText: '', emittedText: '', outputClosed: false, clientClosed: false, __written: '' };
    ctx.globalThis = ctx;
    ctx.res = { write: (s) => { ctx.__written += s; }, flush: () => {} };
    vm.createContext(ctx);
    vm.runInContext(
      'var pendingText = globalThis.pendingText, emittedText = globalThis.emittedText, '
      + 'outputClosed = globalThis.outputClosed, clientClosed = globalThis.clientClosed;\n' + src, ctx);
    ctx.pendingText += feedText;
    ctx.emitCompleteSentences(true);
    return ctx.__written;
  };
  const TAG = '<<PW_JUDGE decision_id="d1" classification="confirm">>';
  const feedText = 'だから今がチャンス。\n' + TAG;
  const originalOut = runVariant(rebindable, feedText);

  const count = rebindable.split(from).length - 1;
  if (count !== 1) throw new HarnessError('reachability probe server-truncation: from matched ' + count + ' times');
  const mutatedSrc = rebindable.split(from).join('/* probe: drop disabled */');
  const mutatedOut = runVariant(mutatedSrc, feedText);
  return { originalOut, mutatedOut };
}

// ══════════════════════════════════════════════════════════════════════
// §6 Run
// ══════════════════════════════════════════════════════════════════════

async function main() {
  console.log('WO-001 road-atlanta fixture (JS + Bridge orchestration) — mode=' + MODE);

  let fixtureDoc;
  try {
    fixtureDoc = loadFixture();
    check('fixture', 'schema/order/identity/provenance valid', true);
  } catch (e) {
    console.log('HARNESS_ERROR (fixture load): ' + e.message);
    process.exit(1);
  }

  // Schema negative-mutation coverage is not mode-dependent product
  // behaviour; run it in both characterization and acceptance mode.
  try { runFixtureSchemaNegativeMutations(); }
  catch (e) { console.log('HARNESS_ERROR (fixture negative-mutation probe): ' + e.message); process.exit(1); }

  // F06 predicate contract probes: likewise not mode-dependent product
  // behaviour (they test the JS predicate functions themselves).
  runF06PredicateContractProbes();

  // — Router slice (F06) —
  let routerSlice;
  try { routerSlice = runRouterSlice(fixtureDoc); }
  catch (e) { console.log('HARNESS_ERROR (router slice): ' + e.message); process.exit(1); }

  const pitWindowResult = routerSlice.results.find(r => r.event.payload.text.includes('ピットウィンド'));
  const pitInResult = routerSlice.results.find(r => r.event.payload.text === 'ピット入るぞ');
  const reasonResult = routerSlice.results.find(r => r.event.payload.text.includes('#25') || r.event.payload.text.includes('25が遅い'));

  if (REQUESTED_MODE === 'characterization') console.log('note: characterization mode retired (WO019); running the current contract');
  check('F06', '"ピットウィンド湧いてる？" is answered by the local fuel-window authority (not unhandled)',
    pitWindowResult && pitWindowResult.result && pitWindowResult.result.handled === true
      && pitWindowResult.result.intent === 'fuel_window_status',
    JSON.stringify(pitWindowResult && pitWindowResult.result));
  check('F06', '"ピット入るぞ" must be recognized as a request-only pit-execution declaration, not a strategy consultation or fake applied result',
    isPitExecutionDeclaration(pitInResult && pitInResult.result),
    JSON.stringify(pitInResult && pitInResult.result));
  // e04 is a reason only RELATIVE to a pending declaration, which the renderer owns
  // (pendingDriverPlanFollowup). Prove it on the product path: real sendMsg declaration ->
  // real Bridge handler/poll applied ACK -> real sendMsg reason -> Bridge `linked` ACK ->
  // Desktop outbox retired (WO019 E2E M03/M04).
  const e2e = spawnSync('python3', ['irsdk-bridge/tests_wo019_road_atlanta_e2e.py', '--cases',
    'M03_declaration_real_command_ack_readback,M04_reason_linked_by_handler'], { cwd: ROOT, encoding: 'utf8', timeout: 900000 });
  if (e2e.status === 2) { console.log('HARNESS_ERROR (WO019 E2E for e03/e04): ' + (e2e.stdout || '').slice(-1500)); fail++; failures.push('e03/e04 E2E harness'); }
  else check('F06', '"前の25が遅いから先に入る" (e04) is linked to the e03 declaration by the real sender/handler (WO019 E2E M03/M04)',
    e2e.status === 0, (e2e.stdout || '').slice(-1500) + (e2e.stderr || '').slice(-500));
  emitTrace({ event_id: 'e04', type: 'driver_utterance', source: 'handoff_only',
    harness_correlation_id: 'fixture-race-a/event-004', finding: 'F06',
    expected: 'reason linked to the e03 command by the Bridge handler (linked ACK, outbox retired)',
    actual: 'wo019_e2e_exit=' + e2e.status });
  const wo006 = spawnSync('python3', ['irsdk-bridge/tests_bridge_driver_plan_command_wiring.py'],
    { cwd:ROOT, encoding:'utf8' });
  check('F06', 'e03/e04 same-command/decision linkage and applied Lifecycle ACK pass the real poll-loop replay',
    wo006.status === 0, (wo006.stdout||'') + (wo006.stderr||''));

  // — reachability probe: router regex dependency —
  try {
    const probe = probeRouterRegexDependency();
    check('reachability', 'router: disabling the WO-006 classifier removes the execution-command route',
      probe.beforeIsCommand === true && probe.afterIsCommand === false,
      JSON.stringify(probe));
  } catch (e) {
    console.log('HARNESS_ERROR (router reachability probe): ' + e.message);
    fail++; failures.push('router reachability probe: ' + e.message);
  }

  // — Server stream + Renderer judge parser slice (F02) —
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'renderer.html'), 'utf8');
  let judgeCtx;
  try { judgeCtx = makeJudgeParserContext(rendererSrc); }
  catch (e) { console.log('HARNESS_ERROR (judge parser extraction): ' + e.message); process.exit(1); }

  let streamOut;
  try { streamOut = await runServerStreamSlice(judgeCtx); }
  catch (e) { console.log('HARNESS_ERROR (server stream slice): ' + e.message); process.exit(1); }

  // ★2026-10-08 WO013: F02's legacy (no judgeTransport opt-in) characterization
  // is preserved UNCHANGED as historical record — it is still true, by design
  // (scope §: "旧plain clientとdeterministic guard応答を維持"). The fix is the
  // NEW opted-in structured transport, asserted in the acceptance branch below
  // against the REAL server.js, not a rewritten expectation of the old path.
  check('F02', 'no-punctuation single-chunk, no opt-in: judge tag never reaches the renderer parser (legacy path unchanged)',
    streamOut.no_punctuation_single_chunk.parsed.judgment === null
    && !streamOut.no_punctuation_single_chunk.rawBody.includes('PW_JUDGE'),
    JSON.stringify(streamOut.no_punctuation_single_chunk));
  check('F02', 'no-punctuation multi-chunk, no opt-in: same drop regardless of chunk boundaries (legacy path unchanged)',
    streamOut.no_punctuation_multi_chunk.parsed.judgment === null
    && !streamOut.no_punctuation_multi_chunk.rawBody.includes('PW_JUDGE'),
    JSON.stringify(streamOut.no_punctuation_multi_chunk));
  check('F02 control', 'trailing-newline control case, no opt-in: tag DOES reach the renderer parser (legacy path unchanged)',
    streamOut.trailing_newline_control_single_chunk.parsed.judgment
    && streamOut.trailing_newline_control_single_chunk.parsed.judgment.decision_id === 'd1'
    && streamOut.trailing_newline_control_single_chunk.parsed.judgment.classification === 'confirm',
    JSON.stringify(streamOut.trailing_newline_control_single_chunk));
  check('F02', 'legacy no-opt-in requests never negotiate the structured transport header',
    !streamOut.no_punctuation_single_chunk.judgeTransportHeader
    && !streamOut.trailing_newline_control_single_chunk.judgeTransportHeader,
    JSON.stringify({ a: streamOut.no_punctuation_single_chunk.judgeTransportHeader,
      b: streamOut.trailing_newline_control_single_chunk.judgeTransportHeader }));
  emitTrace({ event_id: 'e11', type: 'delivery', source: 'repository_evidence',
    harness_correlation_id: 'fixture-race-a/event-011', finding: 'F02',
    expected: 'legacy no-opt-in judge tag stays dropped; judgeTransport:\'v1\' opt-in is the real fix (asserted in acceptance mode)',
    actual: 'single-chunk judgment=' + JSON.stringify(streamOut.no_punctuation_single_chunk.parsed.judgment)
      + ' control-case judgment=' + JSON.stringify(streamOut.trailing_newline_control_single_chunk.parsed.judgment) });

  if (MODE === 'acceptance') {
    const jt = streamOut;
    check('F02 (acceptance)', 'opted-in normal_confirm single-chunk: structured judgment reaches the real server response, header negotiated',
      jt.normal_confirm_single_chunk.decoded.ended
      && jt.normal_confirm_single_chunk.decoded.judgment
      && jt.normal_confirm_single_chunk.decoded.judgment.decision_id === 'd1'
      && jt.normal_confirm_single_chunk.decoded.judgment.classification === 'confirm'
      && jt.normal_confirm_single_chunk.decoded.judgment.request_id === 'req-1'
      && jt.normal_confirm_single_chunk.decoded.text.includes('既定プラン継続')
      && !jt.normal_confirm_single_chunk.decoded.text.includes('PW_JUDGE')
      && jt.normal_confirm_single_chunk.judgeTransportHeader === 'v1',
      JSON.stringify(jt.normal_confirm_single_chunk));
    check('F02 (acceptance)', 'opted-in normal_confirm multi-chunk (char-by-char): same result regardless of chunk boundaries',
      jt.normal_confirm_multi_chunk.decoded.ended
      && jt.normal_confirm_multi_chunk.decoded.judgment
      && jt.normal_confirm_multi_chunk.decoded.judgment.classification === 'confirm'
      && !jt.normal_confirm_multi_chunk.decoded.text.includes('PW_JUDGE'),
      JSON.stringify(jt.normal_confirm_multi_chunk));
    check('F02 (acceptance)', 'decision_id mismatch: no judgment is ever forwarded (fail-closed), but text/end still complete normally',
      jt.decision_id_mismatch.decoded.judgment === null && jt.decision_id_mismatch.decoded.ended === true,
      JSON.stringify(jt.decision_id_mismatch));
    check('F02 (acceptance)', 'two tags in one generation: conflicting/multiple content never resolves to any judgment (no "adopt the first and just log")',
      jt.multiple_tags_same_generation.decoded.judgment === null,
      JSON.stringify(jt.multiple_tags_same_generation));
    check('F02 (acceptance)', 'trailing garbage after an otherwise well-formed tag: whole-tail-must-match-exactly rejects it',
      jt.trailing_garbage_after_tag.decoded.judgment === null,
      JSON.stringify(jt.trailing_garbage_after_tag));
    check('F02 (acceptance)', 'quoted echo of the tag text: fails closed, not treated as a real judgment',
      jt.quoted_echo_tag.decoded.judgment === null,
      JSON.stringify(jt.quoted_echo_tag));
    check('F02 (acceptance)', 'unknown classification value: fails closed',
      jt.malformed_classification.decoded.judgment === null,
      JSON.stringify(jt.malformed_classification));
    check('F02 (acceptance)', 'max_tokens truncation: normal completion is NOT assumed — no judgment AND no end frame',
      jt.max_tokens_truncated.decoded.judgment === null && jt.max_tokens_truncated.decoded.ended === false,
      JSON.stringify(jt.max_tokens_truncated));
    check('F02 (acceptance)', 'missing SDK message_stop event: withheld the same way as any other abnormal completion',
      jt.missing_message_stop.decoded.judgment === null && jt.missing_message_stop.decoded.ended === false,
      JSON.stringify(jt.missing_message_stop));
    check('F02 (acceptance)', 'thrown mid-stream error: no judgment/end frame leaks out of the error path',
      jt.abnormal_throw_mid_stream.decoded.judgment === null && jt.abnormal_throw_mid_stream.decoded.ended === false,
      JSON.stringify(jt.abnormal_throw_mid_stream));
    check('F02 (acceptance)', 'incomplete opt-in (missing request_id): degrades to the full legacy plain-text path, not a partial structured one',
      !jt.incomplete_optin_falls_back_to_legacy.judgeTransportHeader
      && jt.incomplete_optin_falls_back_to_legacy.rawBody.indexOf('{') !== 0,
      JSON.stringify(jt.incomplete_optin_falls_back_to_legacy));
    // ★2026-10-08 WO013 r3 (独立監査 repro): a structurally well-formed tag
    // that is NOT at the start of its own line (introduced inline on the
    // same line as other prose) must fail closed — the intro text itself
    // still reaches the client as ordinary text.
    check('F02 (acceptance)', 'inline-introduced tag (single-chunk, no newline before marker) fails closed; intro text still delivered',
      jt.inline_quoted_intro_single_chunk.decoded.judgment === null
      && jt.inline_quoted_intro_single_chunk.decoded.ended === true
      && jt.inline_quoted_intro_single_chunk.decoded.text === '引用形式これ:',
      JSON.stringify(jt.inline_quoted_intro_single_chunk));
    check('F02 (acceptance)', 'inline-introduced tag (char-by-char) fails closed the same way regardless of chunk boundaries',
      jt.inline_quoted_intro_multi_chunk.decoded.judgment === null
      && jt.inline_quoted_intro_multi_chunk.decoded.ended === true
      && jt.inline_quoted_intro_multi_chunk.decoded.text === '引用形式これ:',
      JSON.stringify(jt.inline_quoted_intro_multi_chunk));
  }

  // — reachability probe: server truncation dependency (legacy path) —
  try {
    const probe = probeServerTruncationDependency(rendererSrc);
    check('reachability', 'server.js: disabling the unterminated-tail drop flips the F02 characterization',
      !probe.originalOut.includes('PW_JUDGE') && probe.mutatedOut.includes('PW_JUDGE'),
      JSON.stringify(probe));
  } catch (e) {
    console.log('HARNESS_ERROR (server reachability probe): ' + e.message);
    fail++; failures.push('server reachability probe: ' + e.message);
  }

  // — reachability probe: judgeTransport completion-gate dependency —
  if (MODE === 'acceptance') {
    try {
      const probe = await probeJudgeTransportCompletionGateDependency();
      check('reachability', 'server.js: disabling the message_stop/stop_reason completion gate lets max_tokens truncation leak a judgment',
        probe.mutatedOut.judgment !== null && probe.mutatedOut.ended === true,
        JSON.stringify(probe));
    } catch (e) {
      console.log('HARNESS_ERROR (judge completion-gate reachability probe): ' + e.message);
      fail++; failures.push('judge completion-gate reachability probe: ' + e.message);
    }
    try {
      const probe = await probeJudgeTransportOwnLineGateDependency();
      check('reachability', 'server.js: disabling the own-line gate lets an inline-introduced tag leak a judgment',
        probe.mutatedOut.judgment !== null && probe.mutatedOut.judgment.classification === 'confirm',
        JSON.stringify(probe));
    } catch (e) {
      console.log('HARNESS_ERROR (judge own-line reachability probe): ' + e.message);
      fail++; failures.push('judge own-line reachability probe: ' + e.message);
    }
  }

  // — reachability probe: renderer judge-parser dependency —
  try {
    const probe = probeRendererParserDependency(rendererSrc);
    check('reachability', 'renderer: breaking PW_JUDGE_TAG_RE flips the control-case parse from a judgment to null',
      probe.originalJudgment && probe.originalJudgment.decision_id === 'd1' && probe.mutatedJudgment === null,
      JSON.stringify(probe));
  } catch (e) {
    console.log('HARNESS_ERROR (renderer reachability probe): ' + e.message);
    fail++; failures.push('renderer reachability probe: ' + e.message);
  }

  // — Bridge slice (F01/F03, via the real Python replay) —
  const bridge = runBridgeSlice(MODE);
  process.stdout.write(bridge.stdout);
  if (bridge.stderr) process.stderr.write(bridge.stderr);
  const bridgeOk = bridge.status === 0;
  // ★Codex REVISE #1, item 7: the check name used to hardcode "exited 0"
  // even when bridge.status was 1, so a real exit=1 showed as a name
  // claiming "exited 0" next to a contradicting "exit=1" detail. Fold the
  // actual value into the name itself so there is no expected/actual
  // mismatch to misread.
  check('bridge', 'irsdk-bridge/tests_wo001_road_atlanta_fixture.py (' + MODE
    + ') exit code: expected=0 actual=' + bridge.status,
    bridgeOk, 'exit=' + bridge.status);

  // — unexecuted-scope disclosure (WO-001 §10) —
  // e12 (reconnect/TTS/memory/debrief) is executed by the WO019 one-consultation E2E
  // (irsdk-bridge/tests_wo019_road_atlanta_e2e.py), registered in preflight separately.
  emitTrace({ event_id: 'e12', type: 'debrief', source: 'synthetic_reconstruction',
    harness_correlation_id: 'fixture-race-a/event-012',
    reachability: 'delegated', finding: 'none',
    expected: 'reconnect/TTS/memory/debrief on the product path',
    actual: 'covered by irsdk-bridge/tests_wo019_road_atlanta_e2e.py (M10-M16), not by this harness' });

  console.log('\nWO-001 road-atlanta fixture (current contract): pass=' + pass + ' fail=' + fail);
  process.exit((fail === 0 && bridgeOk) ? 0 : 1);
}

main().catch(e => {
  if (e instanceof HarnessError) console.error('HARNESS_ERROR: ' + e.message);
  else console.error('HARNESS_ERROR (unexpected): ' + (e && e.stack || e));
  process.exit(1);
});
