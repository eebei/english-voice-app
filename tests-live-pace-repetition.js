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
check('live promotion has an explicit per-stint latch',
  /promotedToLive && strategyLivePromotionAnnounced/.test(renderer)
  && /strategyLivePromotionAnnounced=true/.test(renderer));

const start = renderer.indexOf('async function checkPaceJudgment(data){');
const end = renderer.indexOf('// ★2026-07-19 LLM判断コール', start);
check('production checkPaceJudgment extracted', start >= 0 && end > start);

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
    fetch: async () => {
      fetchCalls++;
      return { json: async () => ({ content: [{ text: nextReply }] }) };
    },
  };
  vm.createContext(context);
  vm.runInContext(renderer.slice(start, end), context);

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
