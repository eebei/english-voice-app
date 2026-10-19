#!/usr/bin/env node
'use strict';

// 2026-08-15 八木さん12h live regression:
// - an internal PACE_CHECK must not be classified as a driver PACE question;
// - the same pace direction is evaluated at most once per active stint;
// - an owned pit call suppresses the background pace call;
// - the three-clean-lap promotion is announced at most once per stint.
// No external API is called (internal simulation policy).

const fs = require('fs');
const vm = require('vm');
const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');

let pass = 0, fail = 0;
function check(label, ok) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label);
  ok ? pass++ : fail++;
}
check('internal paceCheck bypasses the conversation engineer card',
  /const _engineerRoute = \(mode === 'race' && !req\.body\.paceCheck\)/.test(server));
check('legacy repeated Plan B/C recalculation phrase is absent from runtime',
  !/当日クリーンラップ３周[^\n]{0,120}プランB\/Cを再計算/.test(renderer));
check('canonical plan briefing has a native record latch and validity fence',
  renderer.includes('const key=JSON.stringify(st.pit_plan.record_ref||st.pit_plan)')
  && renderer.includes('if(strategyPlaybookBriefedKey===key) return;')
  && renderer.includes('precheck:()=>strategyProjection.validBinding(binding)'));

const start = renderer.indexOf('async function checkPaceJudgment(data){');
const end = renderer.indexOf('// ★2026-07-19 LLM判断コール', start);
check('production checkPaceJudgment extracted', start >= 0 && end > start);
// WO015: checkPaceJudgment() now calls the real strategyNumericFactBinding()
// (a pure top-level helper, defined far above this slice) to fence stale
// numeric fuel/lap/position/gap claims the same way every other caller does.
// It is not part of this function's own source slice, so it must be
// extracted and injected alongside it or every call throws ReferenceError.
// WO015 residual ("verifiedaux GAP/position"): checkPaceJudgment() now also
// calls strategyReplyBindingValid() (which itself calls
// verifiedAuxFieldsStillFresh/captureVerifiedAuxBinding), and
// strategyNumericFactBinding() itself now calls the shared
// _hasUnqualifiedCurrentNumericMention() sentence classifier (defined
// BEFORE it). All of these are pure top-level helpers co-located
// contiguously from _hasUnqualifiedCurrentNumericMention through to (not
// including) `async function callAPI`, so the whole block is extracted
// together.
const numericFnStart = renderer.indexOf('function _hasUnqualifiedCurrentNumericMention(text,keywordRe){');
const numericFnEnd = renderer.indexOf('\nasync function callAPI', numericFnStart);
check('production _hasUnqualifiedCurrentNumericMention+strategyNumericFactBinding+captureVerifiedAuxBinding+verifiedAuxFieldsStillFresh+strategyReplyBindingValid extracted',
  numericFnStart >= 0 && numericFnEnd > numericFnStart);
const numericFactBindingSrc = renderer.slice(numericFnStart, numericFnEnd);

if (start >= 0 && end > start) {
  let fetchCalls = 0;
  const spoken = [];
  const traces = [];
  let nextReply = 'ペースキープ。';
  const context = {
    selMode: 'race', sel: 'LunaJP', userName: 'test', iracingLive: true,
    bridgeConnected: true, lastTelemetry: {}, lastSessionType: 'Race',
    lastSessionAuthority: {}, driverState: 'RACING', driverActivity: 'ACTIVE',
    usageSessionId: 'offline-test', API_BASE: 'http://local.invalid',
    paceJudgmentHandledDirections: new Set(),
    paceJudgmentPendingDirections: new Set(),
    localStorage: { getItem: () => '' },
    applyPitwallAccess: () => {}, usageCount: () => {},
    diagnosticLog: (kind, msg) => traces.push(kind + ' ' + msg),
    addMsg: () => {}, speak: (text, opts) => spoken.push({ text, opts }),
    SPEAK_PRIO: { P4_INFO: 4 }, AbortController, setTimeout, clearTimeout,
    // WO014: checkPaceJudgment()'s liveData/raceContext builders are not this
    // test's concern (pace-direction judgement only); no-op stubs preserve
    // the narrow scope, matching tests-callapi-stream-memory.js's pattern.
    currentCanonicalStrategyLive: (live) => live, buildCurrentRaceContext: () => null,
    // WO014 round2: the stale-binding discard fence itself is covered by the
    // real strategyProjection in tests-race-context-builder.js; here a no-op
    // stub keeps this suite's narrow pace-direction-judgement scope intact.
    // WO014 round4: binding() must return a non-null/non-unavailable object
    // for a no-op stub now that checkPaceJudgment discards unconditionally
    // on a null/unavailable binding (the same initial-unknown contract
    // briefingBinding already had) -- a bare `null` here would now (rightly,
    // in production) suppress every speak() this suite asserts on.
    // WO015: checkPaceJudgment() now also calls strategyProjection.bindAll()
    // (to AND the new numeric-fact binding with the existing critical_context
    // one). Mirror the real bindAll()'s trivial compose-or-passthrough
    // semantics (strategy-state-projection.js) rather than stubbing it out --
    // this suite's scope is pace-direction repetition, not numeric fencing,
    // so validBinding() staying a blanket `true` keeps that scope intact.
    strategyProjection: { binding: () => ({ kind: 'critical_context' }), validBinding: () => true,
      bindAll: (parts) => { const list = (Array.isArray(parts) ? parts : []).filter(Boolean);
        return list.length === 0 ? null : list.length === 1 ? list[0] : { kind: 'and', parts: list }; } },
    fetch: async () => {
      fetchCalls++;
      return { json: async () => ({ content: [{ text: nextReply }] }) };
    },
  };
  vm.createContext(context);
  vm.runInContext(numericFactBindingSrc + '\n' + renderer.slice(start, end), context);

  (async () => {
    await context.checkPaceJudgment({ direction: 'slower', fuel_strategy: {} });
    await context.checkPaceJudgment({ direction: 'slower', fuel_strategy: {} });
    check('same pace direction speaks once in one stint', fetchCalls === 1 && spoken.length === 1);
    check('pace call uses an explicit low-priority dedupe key',
      spoken[0] && spoken[0].opts.kind === 'pace_check'
      && spoken[0].opts.dedupeKey === 'stint|slower');
    check('second same-direction event is fate-traced as suppressed',
      traces.some((x) => /already_evaluated_this_stint/.test(x)));

    await context.checkPaceJudgment({ direction: 'faster', fuel_strategy: { pit_required: true } });
    check('owned pit call prevents a background pace request and speech',
      fetchCalls === 1 && spoken.length === 1
      && traces.some((x) => /pit_call_owned_elsewhere/.test(x)));

    nextReply = 'NO_CALL';
    await context.checkPaceJudgment({ direction: 'stable', fuel_strategy: {} });
    await context.checkPaceJudgment({ direction: 'stable', fuel_strategy: {} });
    check('NO_CALL direction is still evaluated only once per stint',
      fetchCalls === 2 && spoken.length === 1);

    console.log(`\nLive Pace Repetition: ${pass}/${pass + fail}`);
    if (fail) process.exit(1);
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
