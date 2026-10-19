#!/usr/bin/env node
'use strict';
// WO016 Revision1 — PTT interruption / Driver input non-discard.
//
// Actual-path vertical: the REAL renderer functions (sendMsg, WO016 admission/
// turn-owner helpers, callAPI, pttStart/pttStop, bridge PTT terminal handlers,
// transcribePttAudio, speak/drainQueue/finalizeUtterance/stopCurrentAudio,
// addMsg/pushMsg, queueDriverPlanCommand chain) are extracted from
// desktop/renderer.html and run against the REAL local-intent-router, the REAL
// canonical cache/strategy projection, the REAL driver-input-arbiter module and
// a REAL spawned server.js (/api/chat). Only external IO is stubbed: the
// Anthropic SDK (tests-wo001-anthropic-stream-stub-preload.js), /api/tts,
// /api/stt, Audio, and the Bridge WebSocket send. Zero external paid API calls.
//
// The same fixture is also run against the pre-WO016 renderer/server snapshot
// (/tmp/wo016-before-files) when present, to show before-RED / after-GREEN.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const ROOT = __dirname;
const Arbiter = require('./desktop/driver-input-arbiter');
const router = require('./desktop/local-intent-router.js');
const StrategyProjection = require('./desktop/strategy-state-projection');
const RaceContextBuilder = require('./desktop/race-context-builder');
const CF = require('./tests-canonical-lifecycle');
const Store = require('./desktop/critical-journal-store');
const Client = require('./desktop/critical-journal-client');
const stub = require('./tests-wo001-anthropic-stream-stub-preload.js');
const Recon = require('./tests-wo016-pre-reconstruction.js');
// Run-unique id for sibling temp server files (parallel runs never share or delete each other's files).
const RUN_ID = process.pid + '-' + require('crypto').randomBytes(4).toString('hex');
function loadArbiter(source) {
  const mod = { exports: {} };
  vm.runInNewContext(source, { module: mod, globalThis: {}, AbortController, Date });
  return mod.exports;
}

let pass = 0, fail = 0;
function check(label, ok, detail) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label + (ok ? '' : (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')));
  ok ? pass++ : fail++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) { if (Date.now() > deadline) return false; await sleep(5); }
  return true;
}

// ── 1. pure arbiter contract (real module) ─────────────────────────────────
(function arbiterUnit() {
  console.log('\n── arbiter contract ──');
  let t = 1000;
  const a = Arbiter.create({ now: () => t, maxPending: 2, pendingTtlMs: 100, captureLostMs: 50 });
  const t1 = a.beginTurn({ inputId: 'in-x' });
  check('turn owner exposes an abortable controller', !!t1.controller && t1.controller.signal.aborted === false);
  const c1 = a.cancelCurrent('superseded_urgent');
  check('cancel aborts the controller and releases ownership synchronously', c1 === t1 && t1.controller.signal.aborted && a.currentTurn() === null);
  check('superseded cancel is intentional (not a network failure)', a.isIntentionalCancel(t1));
  const t2 = a.beginTurn({ inputId: 'in-y' });
  check('old turn end is ignored and does NOT release the new owner', a.endTurn(t1) === false && a.currentTurn() === t2);
  a.timeoutTurn(t2);
  check('timeout aborts but is NOT an intentional cancel', t2.controller.signal.aborted && !a.isIntentionalCancel(t2) && t2.timedOut);
  check('only the owner can end its turn', a.endTurn(t2) === true && a.currentTurn() === null);
  const e1 = a.accept('typed', 'A', 'race-1|0'), e2 = a.accept('typed', 'B', 'race-1|0'), e3 = a.accept('typed', 'C', 'race-1|0');
  check('bounded pending: 2 accepted, 3rd overflows with explicit reason',
    a.enqueue(e1).ok && a.enqueue(e2).ok && a.enqueue(e3).reason === 'overflow');
  const r1 = a.shiftPending('race-1|1');
  check('scope change rejects pending inputs with a reason (not silent)', r1.entry === null && r1.rejected.length === 2 && r1.rejected.every(x => x.reason === 'scope_changed'));
  a.enqueue(a.accept('typed', 'D', 'race-1|0')); t += 500;
  const r2 = a.shiftPending('race-1|0');
  check('TTL expiry rejects with reason expired', r2.entry === null && r2.rejected[0].reason === 'expired');
  // scope: exact identity, no unknown→known exception; turns carry their scope
  check('scope compare is exact (none→known is a change)', a.scopeChanged('none', 'r|0|7|E1') && a.scopeChanged('r|0|7|E1', 'r|0|7|E2') && !a.scopeChanged('r|0|7|E1', 'r|0|7|E1'));
  const ts = a.beginTurn({ inputId: 'in-s', scopeKey: 'r|0|7|E1' });
  check('turn is live only inside its captured scope', a.isCurrent(ts, 'r|0|7|E1') && !a.isCurrent(ts, 'r2|1|7|E1') && a.turnScopeStale(ts, 'r2|1|7|E1'));
  a.endTurn(ts);
  // takes: exact Bridge capture_id; the reviewer's counterexamples
  const S = 'race-1|0|10101|epoch-a';
  const k1 = a.beginCapture(S, { captureId: 'E1:ptt:1', bridgeEpoch: 'E1' }); a.stopCapture(k1);
  check('terminal attaches by exact id', a.attachTerminal('audio', 'E1:ptt:1', 'E1').ok);
  const k2 = a.beginCapture(S, { captureId: 'E1:ptt:2', bridgeEpoch: 'E1' }); a.stopCapture(k2);
  const dupOld = a.attachTerminal('audio', 'E1:ptt:1', 'E1');
  check('COUNTEREXAMPLE duplicate old terminal while a later take is stopped is rejected, not given to the later take',
    !dupOld.ok && dupOld.reason === 'duplicate_terminal' && a.captureSnapshot().find(c => c.captureId === k2).state === 'stopped');
  check('terminal without capture_id is rejected (never FIFO-guessed)', a.attachTerminal('text', undefined, 'E1').reason === 'unidentified_terminal');
  check('terminal from another Bridge epoch is rejected', a.attachTerminal('text', 'E1:ptt:2', 'E2').reason === 'epoch_mismatch');
  check('terminal for an unknown take is rejected', a.attachTerminal('text', 'E1:ptt:99', 'E1').reason === 'unknown_capture');
  check('take 2 still attaches its own terminal', a.attachTerminal('audio', 'E1:ptt:2', 'E1').ok);
  const late = a.resolveCapture(k2, { kind: 'text', text: 'newer' }, S);
  check('newer STT result is held until the older take terminates', late.accepted && late.released.length === 0);
  const early = a.resolveCapture(k1, { kind: 'text', text: 'older' }, S);
  check('release is in press order (older, then newer)', early.released.map(r => r.text).join(',') === 'older,newer');
  check('duplicate terminal after release is rejected as such', a.attachTerminal('audio', 'E1:ptt:1', 'E1').reason === 'duplicate_after_release');
  const k3 = a.beginCapture(S, { captureId: 'E1:ptt:3', bridgeEpoch: 'E1' }); a.stopCapture(k3); t += 100;
  const k4 = a.beginCapture(S, { captureId: 'E1:ptt:4', bridgeEpoch: 'E1' }); a.stopCapture(k4);
  const lost = a.expireLostCaptures(S);
  check('take with no Bridge terminal closes explicitly as lost', lost.length === 1 && lost[0].captureId === k3 && lost[0].kind === 'lost');
  const lateOld = a.attachTerminal('text', 'E1:ptt:3', 'E1');
  check('COUNTEREXAMPLE late terminal after timeout is rejected, not given to the later take',
    !lateOld.ok && lateOld.reason === 'late_after_lost' && a.captureSnapshot().find(c => c.captureId === k4).state === 'stopped');
  const k5 = a.beginCapture(S, { captureId: 'E1:ptt:5', bridgeEpoch: 'E1' });
  check('COUNTEREXAMPLE terminal before up is accepted for its own take', a.attachTerminal('diagnostic', 'E1:ptt:5', 'E1').ok && a.stopCapture(k5) === false);
  const k6 = a.beginCapture(S, {}); a.stopCapture(k6);
  check('down without Bridge id opens an unidentified take that no terminal can claim', /^unidentified-/.test(k6) && a.attachTerminal('text', k6, null).reason === 'unidentified_take');
  const k7 = a.beginCapture(S, { captureId: 'E1:ptt:7', bridgeEpoch: 'E1' }); a.stopCapture(k7); a.attachTerminal('text', 'E1:ptt:7', 'E1');
  // drain the earlier unresolved takes so k7 is releasable
  a.resolveCapture(k4, { kind: 'error' }, S); a.resolveCapture(k5, { kind: 'diagnostic' }, S); t += 100; a.expireLostCaptures(S);
  const sc = a.resolveCapture(k7, { kind: 'text', text: 'old epoch' }, 'race-1|0|10101|epoch-b');
  check('scope/epoch switch before release turns text into scope_changed', sc.released.some(r => r.captureId === k7 && r.kind === 'scope_changed'));
})();

// ── 2. renderer extraction ─────────────────────────────────────────────────
function scriptOf(html) {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  return scripts.reduce((a, b) => (a.length > b.length ? a : b));
}
function extract(src, name) {
  let start = src.indexOf('\nfunction ' + name + '(');
  let isAsync = false;
  if (start < 0) { start = src.indexOf('\nasync function ' + name + '('); isAsync = start >= 0; }
  if (start < 0) return null;
  start += 1;
  let i = src.indexOf('{', src.indexOf(')', start)), depth = 0;
  // skip default-param braces: find the body brace after the parameter list closes
  const paramOpen = src.indexOf('(', start);
  let p = paramOpen, pd = 0;
  for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')' && --pd === 0) break; }
  i = src.indexOf('{', p);
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  return null;
}
const RENDERER_FNS = [
  // WO016 helpers (absent in the pre-WO016 snapshot)
  'currentDriverInputScopeKey', 'isUrgentDriverInput', 'driverInputNotice', 'beginDriverTurn', 'driverTurnLive',
  'timeoutDriverTurn', 'finishDriverTurn', 'cancelDriverTurn', 'admitDriverInput', 'drainPendingDriverInputs',
  'noteDriverInputIdentity', 'onDriverInputCanonicalEvent', 'enforceDriverInputScope', 'interruptTurnSpeech', 'attachBridgePttTerminal',
  'handleBridgePttText', 'handleBridgePttAudio', 'handleBridgePttDiagnostic', 'handleBridgePttError', 'deliverReleasedCaptures',
  // product paths
  'sendMsg', 'callAPI', 'pttStart', 'pttStop', 'transcribePttAudio', 'setHint', 'isJapaneseEngineer',
  'currentCanonicalStrategyLive', 'buildCurrentRaceContext', 'stripProposalJudgeTag', 'currentPlanReplyDependsOn',
  'recordLunaTurn', 'ensureConversationBox', 'saveConversationBox', 'conversationSessionKey', 'addMsg', 'convoLog',
  'pushMsg', 'removeMessageById', 'speak', 'speakReplyChunk', 'drainQueue', 'finalizeUtterance', 'discardQueuedUtterances',
  'onUtteranceDone', 'stopCurrentAudio', 'deriveUtteranceSource', 'stableTextHash', 'utteranceTrace', 'utteranceTraceFor',
  'speechLatencyTrace', 'speechMayStart',
  'newDriverPlanCommandId', 'currentDriverPlanAuthority', 'flushDriverPlanCommandOutbox', 'queueDriverPlanCommand',
  // WO017: the canonical receive entry also feeds the real race-memory scope (conversation/decision memory boundary)
  'noteMemoryRaceScope', 'currentRaceConversation', 'memoryTurnTag', 'localMemoryOwnerRef', 'loadConversationBoxes',
];
function rendererProgram(html) {
  const src = scriptOf(html);
  const parts = [], missing = [];
  for (const n of RENDERER_FNS) { const s = extract(src, n); if (s) parts.push(s); else missing.push(n); }
  const auxStart = src.indexOf('function _hasUnqualifiedCurrentNumericMention(text,keywordRe){');
  const auxEnd = src.indexOf('\nasync function callAPI', auxStart);
  if (auxStart < 0 || auxEnd < 0) throw new Error('aux block missing');
  const decls = [/const PW_JUDGE_TAG_START = [\s\S]*?;/, /const PW_JUDGE_TAG_RE = [\s\S]*?;/, /const CONVO_BOX_KEY='[^']+';/, /let _convoBox=null;/,
    /const memoryRaceScope=[\s\S]*?:null;/, /const CONVO_BOX_SLOTS=\d+;/]
    .map(re => (src.match(re) || [''])[0]).join('\n');
  // helpers defined inside the aux block are reused verbatim; skip duplicates by
  // only appending functions NOT already inside the aux block text.
  const aux = src.slice(auxStart, auxEnd);
  const body = parts.filter(p => !aux.includes(p.slice(0, 60))).join('\n');
  return { code: decls + '\n' + aux + '\n' + body, missing };
}

// ── 3. canonical + harness ─────────────────────────────────────────────────
// One real canonical snapshot. Identity = race/session/driver/epoch; seq/frame/fuel are ordinary progression.
function snapFor(o) {
  o = Object.assign({ epoch: 'epoch-a', seq: 1, frame: 50, session: 0, driver: 10101, fuel: 5 }, o || {});
  const snap = CF.fixture({ epoch: o.epoch, seq: o.seq, race: 'race-1', session: o.session, decision: 'plan-a', frame: o.frame, pit: 2 });
  snap.lifecycle.active.activated_source_frame_sequence = 40;
  snap.box_delivery.attempts[0].activation_frame = 40;
  snap.current_facts.fuel_level_l = o.fuel;
  snap.continuity.stable_scope = { race_instance_id: 'race-1', session_num: o.session, driver_id: o.driver };
  return snap;
}
function canonical() {
  const snap = snapFor();
  const cache = CF.initialized(() => 0, snap);
  const projection = StrategyProjection.create({ canonical: cache, now: () => 0 });
  return { snap, cache, projection };
}

function makeEl(id) {
  const classes = new Set();
  return { id, value: '', style: {}, textContent: '', children: [], scrollTop: 0, scrollHeight: 0,
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle: (c, on) => (on === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : (on ? classes.add(c) : classes.delete(c))), contains: c => classes.has(c) },
    appendChild(el) { el.parentNode = this; this.children.push(el); },
    removeChild(el) { this.children = this.children.filter(x => x !== el); el.parentNode = null; } };
}

function buildHarness(html, port, opts) {
  opts = opts || {};
  const { code, missing } = rendererProgram(html);
  const { snap, cache, projection } = canonical();
  const journalStore = Store.create(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-journal-')), 'journal.json')); journalStore.load();
  const criticalJournal = Client.create({ criticalJournalLoad: journalStore.load, criticalJournalTransact: journalStore.transact });
  const els = {};
  const el = id => (els[id] || (els[id] = makeEl(id)));
  const wsSent = [], diag = [], judgeCalls = [], audioInstances = [], sttRequests = [];
  let ttsResolve = null;
  const store = {};
  let seq = 0;
  const live = { lap: 20, race_instance_id: 'race-1', session_num: 0, source_frame_sequence: 50, driver_pit_sequence: 2,
    active_plan_decision_id: 'plan-a', active_plan_revision: 0, active_plan_activated_source_frame_sequence: 40 };
  const ctx = {
    TextDecoder, TextEncoder, AbortController, setTimeout, clearTimeout, Date, JSON, Math, String, Number, Error, RegExp,
    Promise, console, Map, Set, Buffer,
    performance: { now: () => 0 },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    document: { getElementById: el, createElement: () => ({ className: '', textContent: '' }) },
    // real modules
    PitwallLocalIntentRouter: router, PitwallConversationMemoryBox: require('./desktop/conversation-memory-box.js'),
    PitwallDisputeDetector: require('./desktop/dispute-detector.js'), PitwallReflexEvents: null,
    PitwallDriverInputArbiter: Arbiter, PitwallRaceContextBuilder: RaceContextBuilder,
    PitwallRaceMemoryScope: require('./desktop/race-memory-scope.js'),
    canonicalLifecycleCache: cache, strategyProjection: projection, criticalJournal,
    lastTelemetryAuxRef: { bridge_process_epoch: snap.bridge_process_epoch, canonical_snapshot_id: snap.snapshot_id,
      canonical_snapshot_sequence: snap.snapshot_sequence, race_instance_id: snap.race_instance_id,
      session_num: snap.session_num, source_frame_sequence: snap.source_frame.sequence },
    // neutral stubs for unrelated consumers
    usageCount() {}, applyPitwallAccess() {}, costApiCall() {}, costRecord() {}, mirrorToOverlay() {},
    diagnosticLog: (k, v) => diag.push(k + ' ' + v), t: k => String(k),
    forwardDriverDamageReport() {}, hydrateLegacyStrategyObjective: () => ({}), loadProfile: () => ({}),
    buildProfileNote: () => '', buildCarTrackMemory: () => '', buildPracticeProfileNote: () => '', buildFuelAuthorityNote: () => '',
    buildWeekendAuthorityNote: () => '', buildCurrentSessionFactNote: () => '', buildSessionEvidenceNote: () => '',
    buildContractNote: () => '', buildActiveRaceFactsNote: () => '', buildMemoryStatusNote: () => '',
    currentMemoryBrainPrompt: () => '', completeMemoryBrainTurn: () => null, prepareMemoryBrain: () => null,
    buildRaceHistoryContext: () => '', buildNamedRivalNote: () => '', updateNamedRivalFromUser: () => null,
    hasTelemetryOwnedVehicleClaim: () => false, normalizeLunaSpeech: x => x,
    applyProposalJudgeTag: (...a) => judgeCalls.push(a), currentStrategyStateAPI: () => null, ensureStrategyState: () => null,
    captureConfirmedFuelCapacity() {}, maybeQuietMode() {}, pendingConfirmationKinds: () => [], bareConfirmationAnswer: () => null,
    pendingDrivingStyleAdvice: null, handleLunaSelfMemoryInput: () => null, handleReflexDispute: () => false,
    handleTeamPlanUtterance: () => false, handleGapDispute: () => false, handleRelativePaceQuestion: () => false,
    currentStrategyPlaybook: () => null, loadRaceHistory: () => [], currentMemoryUserId: () => 'Yuji',
    currentMemoryIdentity: () => ({}), currentGapHeld: () => null, pendingDecisionDispute: null, lastMemoryUtterance: null,
    recordSetupDeclaration: () => false, answerHistoricalWeatherLocally: () => null, evidenceDebrief: null,
    isManualReviewCommand: () => false, isExplicitMemoryRequest: () => false, memorySaveReceipt: '', canPersistMemory: () => false,
    saveMemory: async () => true, memorySavedThisSession: true, pendingDriverPlanFollowup: null,
    driverPlanCommandOutbox: new Map(), pendingCanonicalCommandReadbacks: new Map(), bridgeStrategyDecisions: new Map(),
    strategyResponseOutbox: new Map(), strategyDeliveryOutbox: new Map(), strategyPlaybookDecisionKeys: new Set(),
    PitwallSessionStrategyState: { invalidatePendingProposal() {} }, crypto: { randomUUID: () => 'cmd-' + (++seq) },
    // renderer module state
    sel: 'LunaJP', selMode: 'race', userName: 'Yuji', messages: [], turns: 0, sessionMsgCount: 0, isBusy: false,
    iracingLive: true, bridgeConnected: true, lastTelemetry: Object.assign({}, live), lastTelemetryAt: Date.now(),
    lastSessionType: 'Race', lastSessionAuthority: null, lastCarClass: 'GT3', lastCarModel: 'AMG', lastTrack: 'Road Atlanta',
    lastSessionNum: 0, driverState: 'track', driverActivity: 'ACTIVE', lastSectors: null,
    API_BASE: '', usageSessionId: 's', jamesAutoMicEnabled: false, jamesMuted: false, pttHeld: false,
    pttCaptureId: null, lastAdmittedDriverInput: null, bridgePttCaptureArmedAt: 0,
    driverInputIdentity: null, lastFinishedDriverTurn: null, micTesting: false, setMicMeter() {},
    lastQueuedSpeakItem: null, currentSpeakItem: null, _msgSeq: 0, MAX_CLIENT_MESSAGES: 60,
    utteranceTraceLog: [], UTTERANCE_TRACE_MAX: 200,
    voiceOn: true, nextUtteranceId: () => 'wo016-u' + (++seq), speakQueue: [],
    CHARS: { LunaJP: { gVoice: 'ja-JP-x', gLang: 'ja-JP', gRate: 1, gPitch: 0, voiceLang: 'ja-JP', pitch: 1, rate: 1, voiceNames: [] } },
    IMMEDIATE_PIT_KINDS: new Set(), MAX_RADIO_QUEUE: 2, MAX_SPEAK_QUEUE: 20, currentSpeakPrio: 9, isSpeaking: false, draining: false,
    speakGateActive: false, speakWindowOk: true, speakGeneration: 0, autoMicActive: false, autoMicRec: null,
    shouldDeferSpeak: () => false, deferSpeakItem: () => false, currentGapAuthority: () => null,
    ttsAudio: null, speakFetchCtrl: null, speakWatchdog: null, ttsDisabledUntil: 0,
    phonetify: x => x, stripMarkdown: x => x, stripParens: x => x, stripEmoji: x => x,
    ttsFailLog() {}, ttsEventLog() {}, pwVolume: 1, getDeviceId: () => 'test',
    speechSynthesis: { cancel() {}, speak() {} },
    SPEAK_PRIO: { P0_SAFETY: 0, P1_HAZARD: 1, P2_PROCEDURE: 2, P3_INFO: 3, P3_STRATEGY: 3, P4_INFO: 4 },
    // WS send IO stub; failNextPttStart makes exactly the next ptt_start send throw (real failure point).
    irBridge: { readyState: 1, send: s => { const m = JSON.parse(s); if (m.cmd === 'ptt_start' && ctx.failNextPttStart) { ctx.failNextPttStart = false; throw new Error('socket send failed'); } wsSent.push(m); } },
    failNextPttStart: false,
    Audio: class { constructor(url) { this.src = url; this.onended = null; this.onerror = null; audioInstances.push(this); } async play() {} pause() { this.paused = true; } },
    fetch: (url, init) => {
      const u = String(url);
      if (u.endsWith('/api/tts')) return new Promise(r => { ttsResolve = r; });
      if (u.endsWith('/api/stt')) return new Promise((resolve, reject) => {
        const req = { payload: JSON.parse(init.body), resolve, reject };
        if (init.signal) init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
        sttRequests.push(req);
      });
      return fetch('http://localhost:' + port + u, init);
    },
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  // module-scope singletons exactly as renderer.html declares them
  if (vm.runInContext('typeof admitDriverInput', ctx) === 'function') {
    ctx.driverInputArbiter = (opts.arbiterModule || Arbiter).create(opts.arbiterOpts || {});
  }
  if (opts.mutate) opts.mutate(ctx);
  async function startCurrentUtterance() {
    await waitFor(() => !!ttsResolve, 3000);
    if (ttsResolve) { const r = ttsResolve; ttsResolve = null; r({ ok: true, status: 200, json: async () => ({ audioContent: 'A' }) }); await sleep(20); }
  }
  async function finishCurrentUtterance() {
    await startCurrentUtterance();
    const a = audioInstances[audioInstances.length - 1];
    if (a && typeof a.onended === 'function') { a.onended(); await sleep(20); }
  }
  function sttReply(i, body, status = 200) {
    const req = sttRequests[i];
    req.resolve({ ok: status < 400, status, json: async () => body });
  }
  const userTexts = () => ctx.messages.filter(m => m.role === 'user').map(m => String(m.content).split(stub.MARKER)[0].trim());
  const assistantTexts = () => ctx.messages.filter(m => m.role === 'assistant').map(m => m.content);
  const sysTexts = () => (els['chat-area'] ? els['chat-area'].children : []).filter(c => /sys/.test(c.className)).map(c => c.textContent);
  const spokenTraces = () => ctx.utteranceTraceLog.map(e => ({ state: e.state || e.event, text: e.text, reason: e.reason }));
  // Real canonical transitions, applied exactly as renderer.html's onmessage does after a
  // successful cache.hello()/cache.receive() (the hook statements are taken from the product
  // source text and executed verbatim, see HOOKS below).
  let gen = null;
  // A renderer without the WO016 hook (v1 baseline) simply has no hook to run.
  const hasHook = typeof ctx.onDriverInputCanonicalEvent === 'function';
  function canonicalReceive(o) {
    const s = snapFor(o);
    const ok = cache.receive(s, gen === null ? undefined : gen);
    if (ok && hasHook) ctx.onDriverInputCanonicalEvent('receive', s);
    return ok;
  }
  function canonicalHello(epoch) {
    gen = cache.beginSocket();
    const ok = cache.hello(gen, { type: 'connected', schema_version: 1, bridge_process_epoch: epoch });
    if (ok && hasHook) ctx.onDriverInputCanonicalEvent('hello', { type: 'connected', bridge_process_epoch: epoch });
    return ok;
  }
  // Bridge PTT events dispatched to the same product handlers renderer.html's onmessage uses.
  function feed(ev) {
    if (ev.type === 'ptt') return ev.state === 'down' ? ctx.pttStart(ev) : ctx.pttStop(ev);
    if (ev.type === 'ptt_text') return ctx.handleBridgePttText(ev);
    if (ev.type === 'ptt_audio') return ctx.handleBridgePttAudio(ev);
    if (ev.type === 'ptt_diagnostic') return ctx.handleBridgePttDiagnostic(ev);
    if (ev.type === 'ptt_error') return ctx.handleBridgePttError(ev);
    if (ev.type === 'mic_error' && ev.capture_id) return ctx.handleBridgePttError(Object.assign({}, ev, { reason: 'mic_error' }));
    return undefined;
  }
  return { ctx, el, els, wsSent, diag, judgeCalls, sttRequests, missing, startCurrentUtterance, finishCurrentUtterance, sttReply,
    userTexts, assistantTexts, sysTexts, spokenTraces, audioInstances, cache, canonicalReceive, canonicalHello, feed };
}

// renderer.html's onmessage calls the real onDriverInputCanonicalEvent() right after a successful
// cache.receive()/cache.hello(); the harness verifies that wiring in the product text and then
// calls the same real function at the same point.
const HOOKS = (() => {
  const src = scriptOf(fs.readFileSync(path.join(ROOT, 'desktop/renderer.html'), 'utf8'));
  return {
    receive: src.includes("if(canonicalLifecycleCache.receive(data,socketGeneration)){if(typeof onDriverInputCanonicalEvent==='function')onDriverInputCanonicalEvent('receive',data);"),
    hello: /if\(canonicalLifecycleCache\.hello\(socketGeneration,data\)\)\{[^\n]*\n[^\n]*onDriverInputCanonicalEvent\('hello',data\);\}/.test(src),
  };
})();

// Real Bridge PTT event stream (bridge._ptt_physical_edge / bridge._finish_ptt_capture).
function runBridge(steps) {
  const { spawnSync } = require('child_process');
  const r = spawnSync('python3', [path.join(ROOT, 'irsdk-bridge/wo016_ptt_transport_fixture.py'), JSON.stringify(steps)],
    { cwd: path.join(ROOT, 'irsdk-bridge'), encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error('bridge PTT fixture failed: status=' + r.status + ' stderr=' + String(r.stderr).slice(-2000));
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
async function replay(H, events, onMarker) {
  for (const ev of events) {
    if (ev.type === '__marker') { if (onMarker) await onMarker(ev.name); continue; }
    // do not await: ptt_audio's handler returns the in-flight STT promise (like onmessage, fire and continue)
    const p = H.feed(ev);
    if (p && typeof p.catch === 'function') p.catch(() => {});
    await sleep(5);
  }
}

function scenario(chunks, extra) {
  return Buffer.from(JSON.stringify(Object.assign({ chunks }, extra || {}))).toString('base64');
}
function chatText(prefix, chunks, extra) { return prefix + ' ' + stub.MARKER + scenario(chunks, extra); }

function spawnServer(port, serverFile) {
  return new Promise((resolve, reject) => {
    const out = [];
    const child = spawn(process.execPath, ['-r', path.join(ROOT, 'tests-wo001-anthropic-stream-stub-preload.js'), serverFile],
      { cwd: ROOT, env: { ...process.env, PORT: String(port), ANTHROPIC_API_KEY: 'sk-test-local-stub', DATABASE_URL: '', JWT_SECRET: '', STRIPE_SECRET_KEY: '' } });
    // Startup failures carry the child's own stdout/stderr so a cause can be identified.
    const timer = setTimeout(() => reject(new Error('server did not start: ' + serverFile + '\n' + out.join('').slice(-3000))), 15000);
    child.stdout.on('data', d => { out.push(String(d)); if (String(d).includes('is running')) { clearTimeout(timer); resolve({ child, out }); } });
    child.stderr.on('data', d => out.push(String(d)));
    child.on('exit', code => { clearTimeout(timer); reject(new Error('server exited early code=' + code + ' file=' + serverFile + '\n' + out.join('').slice(-3000))); });
  });
}
const exists = f => fs.existsSync(f);

// ── 4. scenarios (same fixture for before / after / cuts) ───────────────────
async function scenarioOrdinaryPending(H) {
  const gate = fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-gate-'));
  H.el('chat-input').value = chatText('状況を教えて', ['了解、', '継続する。'], { holdGateDir: gate, holdAfterChunk: 0 });
  const pA = H.ctx.sendMsg('typed');
  await waitFor(() => exists(path.join(gate, 'arrived')));
  H.el('chat-input').value = chatText('続けて様子を教えて', ['問題ない。']);
  await H.ctx.sendMsg('typed');
  const r = { queuedVisible: H.sysTexts().some(t => t.includes('前の応答の後に答える')), userBeforeRelease: H.userTexts().slice(),
    editorAfter: H.el('chat-input').value };
  fs.writeFileSync(path.join(gate, 'release'), '1');
  await pA;
  await waitFor(() => H.userTexts().length >= 2 && !H.ctx.isBusy, 4000);
  await sleep(50);
  r.users = H.userTexts(); r.assistants = H.assistantTexts();
  return r;
}

async function scenarioUrgentSupersedes(H, gateDir) {
  // A: reply's first sentence is queued/started, then the network is held.
  H.el('chat-input').value = chatText('状況を教えて', ['了解。', '旧応答の続きは古い。'], { holdGateDir: gateDir, holdAfterChunk: 0 });
  const pA = H.ctx.sendMsg('typed');
  await waitFor(() => exists(path.join(gateDir, 'arrived')));
  await H.startCurrentUtterance();   // old reply sentence 1 is audible (play started)
  const firstItem = H.ctx.currentSpeakItem;
  const r = { firstStarted: !!firstItem && firstItem._finalized === 'spoken' };
  // Urgent typed Driver declaration while busy, and a new ordinary owner C started in the
  // SAME synchronous section — before the old turn's abort rejection (a microtask) can run
  // its catch/finally. This makes the old-finally vs new-busy race deterministic.
  const gateC = fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-gateC-'));
  H.el('chat-input').value = 'ピット入るぞ';
  const pU = H.ctx.sendMsg('typed');
  r.commandEnvelopes = H.wsSent.filter(m => m.cmd === 'driver_plan_command' && m.intent === 'early_pit').length;
  // measured synchronously at cancel time, before any newer reply could preempt the audio itself
  r.firstOutcome = firstItem ? firstItem._finalized : null;
  H.el('chat-input').value = chatText('続けて様子を教えて', ['問題ない。'], { holdGateDir: gateC, holdAfterChunk: 0 });
  const pC = H.ctx.sendMsg('typed');
  r.busyRightAfterC = H.ctx.isBusy;
  await pU;
  await waitFor(() => exists(path.join(gateC, 'arrived')), 3000);
  r.providerAborted = await waitFor(() => exists(path.join(gateDir, 'provider_aborted')), 3000);
  await Promise.race([pA, sleep(1500)]);
  await sleep(100);
  r.busyAfterOldFinally = H.ctx.isBusy;
  r.ownerAfterOldFinally = H.ctx.driverInputArbiter ? !!H.ctx.driverInputArbiter.currentTurn() : null;
  r.oldTailSpoken = H.ctx.utteranceTraceLog.some(e => String(e.text || '').includes('旧応答の続き'));
  r.oldBodyInHistory = H.assistantTexts().some(t => String(t).includes('了解。'));
  r.connErrorShown = H.sysTexts().some(t => t.includes('sys_conn_error'));
  r.connErrorSpoken = H.ctx.utteranceTraceLog.some(e => /接続エラー/.test(String(e.text || '')));
  r.judgeCallsBeforeC = H.judgeCalls.length;
  fs.writeFileSync(path.join(gateC, 'release'), '1');
  await Promise.race([pC, sleep(3000)]);
  await sleep(50);
  r.cCompleted = H.assistantTexts().some(t => String(t).includes('問題ない'));
  r.busyEnd = H.ctx.isBusy;
  r.marker = H.assistantTexts().some(t => String(t).includes('割込みで応答を中断'));
  return r;
}

async function scenarioControl(H, gateDir) {
  H.el('chat-input').value = chatText('状況を教えて', ['了解。', '継続する。'], { holdGateDir: gateDir, holdAfterChunk: 0 });
  const pA = H.ctx.sendMsg('typed');
  await waitFor(() => exists(path.join(gateDir, 'arrived')));
  fs.writeFileSync(path.join(gateDir, 'release'), '1');
  await pA;
  await sleep(50);
  return { providerAborted: exists(path.join(gateDir, 'provider_aborted')), history: H.assistantTexts(), judgeCalls: H.judgeCalls.length, busy: H.ctx.isBusy };
}

async function scenarioPttBusy(H, gateDir) {
  H.el('chat-input').value = chatText('状況を教えて', ['了解、', '継続する。'], { holdGateDir: gateDir, holdAfterChunk: 0 });
  const pA = H.ctx.sendMsg('typed');
  await waitFor(() => exists(path.join(gateDir, 'arrived')));
  H.el('chat-input').value = 'draft-in-progress';
  // real Bridge: physical down/up, then the recording thread's terminal for that take
  const { events } = runBridge([{ op: 'down' }, { op: 'up' }, { op: 'finish', take: 1, seconds: 1.2 }]);
  const [down, up, audio] = events;
  await H.feed(down);
  const r = { pttStartSent: H.wsSent.some(m => m.cmd === 'ptt_start'), pttAbortSent: H.wsSent.some(m => m.cmd === 'ptt_abort'),
    startCarriesId: H.wsSent.some(m => m.cmd === 'ptt_start' && m.capture_id === down.capture_id) };
  H.feed(up);
  r.pttStopSent = H.wsSent.some(m => m.cmd === 'ptt_stop');
  r.providerAborted = await waitFor(() => exists(path.join(gateDir, 'provider_aborted')), 3000);
  await Promise.race([pA, sleep(1500)]);
  r.audioIdMatchesDown = audio.type === 'ptt_audio' && audio.capture_id === down.capture_id;
  H.feed(audio);
  r.sttStarted = await waitFor(() => H.sttRequests.length === 1, 1500);
  if (r.sttStarted) H.sttReply(0, { text: chatText('ガス残量の傾向は', ['安定している。']), confidence: 0.9 });
  await waitFor(() => H.assistantTexts().some(t => String(t).includes('安定している')), 4000);
  await sleep(50);
  r.pttReplied = H.assistantTexts().some(t => String(t).includes('安定している'));
  r.editorKept = H.el('chat-input').value === 'draft-in-progress';
  r.oldBodyInHistory = H.assistantTexts().some(t => String(t).includes('継続する'));
  return r;
}

async function scenarioSttOrdering(H) {
  const r = {};
  // Two real takes (Bridge ids), both deliver audio; STT #2 returns first.
  const two = runBridge([{ op: 'down' }, { op: 'up' }, { op: 'finish', take: 1 }, { op: 'down' }, { op: 'up' }, { op: 'finish', take: 2 }]).events;
  await replay(H, two);
  await waitFor(() => H.sttRequests.length === 2, 1500);
  H.sttReply(1, { text: chatText('二番目の発話', ['二了解。']) });
  await sleep(60);
  r.newerHeld = H.userTexts().length === 0;
  H.sttReply(0, { text: chatText('一番目の発話', ['一了解。']) });
  await waitFor(() => H.userTexts().length >= 2 && !H.ctx.isBusy, 5000);
  await sleep(60);
  r.order = H.userTexts();
  r.diagTail = H.diag.filter(d => /PTT|DRIVER|TURN|CLIENT/.test(d)).slice(-12);
  r.arbTrace = H.ctx.driverInputArbiter.trace().slice(-12).map(e => e.event + ':' + (e.captureId || e.inputId || '') + ':' + (e.reason || e.kind || ''));
  // terminal for an unknown take: rejected, nothing processed
  const before = H.userTexts().length;
  H.ctx.handleBridgePttText({ text: '重複', capture_id: 'nobody:ptt:1', bridge_process_epoch: 'nobody' });
  r.duplicateRejected = H.userTexts().length === before && H.diag.some(d => d.includes('rejected ptt_text without a recent physical PTT-down'));
  // a too-short take: identified diagnostic terminal, explicit hint, nothing processed
  const short = runBridge([{ op: 'down' }, { op: 'up' }, { op: 'finish', take: 1, seconds: 0.1 }]).events;
  await replay(H, short);
  r.emptyHint = H.el('hint-text').textContent.includes('一呼吸') && H.userTexts().length === before;
  // STT error on the OLDER take must not erase the NEWER one
  const err = runBridge([{ op: 'down' }, { op: 'up' }, { op: 'finish', take: 1 }, { op: 'down' }, { op: 'up' }, { op: 'finish', take: 2 }]).events;
  await replay(H, err);
  await waitFor(() => H.sttRequests.length === 4, 1500);
  H.sttReply(3, { text: chatText('エラー後の新しい発話', ['了解した。']) });
  await sleep(40);
  H.sttReply(2, { error: 'bad' }, 400);
  await waitFor(() => H.userTexts().includes('エラー後の新しい発話') && !H.ctx.isBusy, 5000);
  r.errorKeptNewer = H.userTexts().includes('エラー後の新しい発話');
  r.errorHint = H.diag.some(d => d.includes('PTT_CAPTURE') && d.includes('"kind":"error"'));
  // real canonical session switch between the take and its STT result
  const sc = runBridge([{ op: 'down' }, { op: 'up' }, { op: 'finish', take: 1 }]).events;
  await replay(H, sc);
  await waitFor(() => H.sttRequests.length === 5, 1500);
  r.sessionSwitchAccepted = H.canonicalReceive({ seq: 2, frame: 51, session: 1 });
  const usersBefore = H.userTexts().length;
  H.sttReply(4, { text: '前セッションの発話' });
  await sleep(60);
  r.scopeNotProcessed = H.userTexts().length === usersBefore;
  r.scopeNoticeVisible = H.sysTexts().some(t => t.includes('セッションが切り替わったため'));
  return r;
}

// Reviewer counterexamples on the REAL Bridge transport.
async function scenarioCaptureIdentity(H) {
  const r = {};
  // RT1: take 1 audio delivered, take 2 started; take 1's terminal is re-delivered.
  const rt1 = runBridge([{ op: 'down' }, { op: 'up' }, { op: 'finish', take: 1 }, { op: 'down' }, { op: 'up' },
    { op: 'redeliver', take: 1 }, { op: 'finish', take: 2, seconds: 1.3 }]).events;
  const cap1 = rt1[0].capture_id, cap2 = rt1[3].capture_id;
  const audio1 = rt1[2].audio, audio2 = rt1[6].audio;
  r.rt1DistinctIds = !!cap1 && !!cap2 && cap1 !== cap2 && audio1 !== audio2;
  await replay(H, rt1);
  await waitFor(() => H.sttRequests.length >= 2, 1500);
  await sleep(40);
  r.rt1SttCount = H.sttRequests.length;
  // whose audio did each STT request carry? (take 2 must transcribe take 2's audio)
  r.rt1SttAudio = H.sttRequests.slice(0, 2).map(q => q.payload.audio === audio1 ? 'take1' : q.payload.audio === audio2 ? 'take2' : '?');
  r.rt1DupRejected = H.diag.some(d => d.includes('terminal_rejected') && d.includes(cap1) && d.includes('duplicate_terminal'));
  r.rt1Take2Own = H.ctx.driverInputArbiter.captureSnapshot().some(c => c.captureId === cap2 && c.state === 'transcribing');
  H.sttReply(0, { text: chatText('テイク一', ['一。']) });
  H.sttReply(1, { text: chatText('テイク二', ['二。']) });
  await waitFor(() => H.userTexts().length >= 2 && !H.ctx.isBusy, 5000);
  r.rt1Order = H.userTexts().slice(0, 2);
  // RT2: take 1 times out (lost), take 2 starts, then take 1's late terminal arrives.
  const sttBefore = H.sttRequests.length;
  const rt2 = runBridge([{ op: 'down' }, { op: 'up' }, { op: 'marker', name: 'expire' }, { op: 'down' }, { op: 'up' },
    { op: 'finish', take: 1 }, { op: 'finish', take: 2 }]).events;
  const late1 = rt2[0].capture_id, live2 = rt2[3].capture_id;
  await replay(H, rt2, async () => { await sleep(80); H.ctx.deliverReleasedCaptures(H.ctx.driverInputArbiter.expireLostCaptures(H.ctx.currentDriverInputScopeKey())); });
  await sleep(40);
  r.rt2LostVisible = H.sysTexts().some(t => t.includes('PTTの音声を受け取れなかった'));
  r.rt2LateRejected = H.diag.some(d => d.includes('terminal_rejected') && d.includes(late1) && d.includes('late_after_lost'));
  r.rt2OnlyTake2 = H.sttRequests.length === sttBefore + 1;
  r.rt2Take2Own = H.ctx.driverInputArbiter.captureSnapshot().some(c => c.captureId === live2 && c.state === 'transcribing');
  H.sttReply(H.sttRequests.length - 1, { text: chatText('遅延後のテイク二', ['了解。']) });
  await waitFor(() => H.userTexts().includes('遅延後のテイク二') && !H.ctx.isBusy, 5000);
  r.rt2Take2Processed = H.userTexts().includes('遅延後のテイク二');
  // RT3: terminal before the up edge (Bridge closed the take first).
  const rt3 = runBridge([{ op: 'down' }, { op: 'finish', take: 1 }, { op: 'up' }]).events;
  const before3 = H.sttRequests.length;
  await replay(H, rt3);
  await waitFor(() => H.sttRequests.length === before3 + 1, 1500);
  r.rt3Accepted = H.sttRequests.length === before3 + 1;
  H.sttReply(H.sttRequests.length - 1, { text: chatText('押下中に閉じたテイク', ['了解。']) });
  await waitFor(() => H.userTexts().includes('押下中に閉じたテイク') && !H.ctx.isBusy, 5000);
  r.rt3Processed = H.userTexts().includes('押下中に閉じたテイク');
  // RT4: outdated Bridge (no capture_id on any event) → explicit rejection, never guessed.
  const rt4 = runBridge([{ op: 'down' }, { op: 'up' }, { op: 'finish', take: 1 }]).events
    .map(e => { const x = Object.assign({}, e); delete x.capture_id; delete x.bridge_process_epoch; return x; });
  const before4 = H.sttRequests.length;
  await replay(H, rt4);
  r.rt4Rejected = H.sttRequests.length === before4 && H.sysTexts().some(t => t.includes('識別子が無い'));
  // RT5: terminal claiming another Bridge epoch.
  const rt5 = runBridge([{ op: 'down' }, { op: 'up' }, { op: 'finish', take: 1 }]).events;
  rt5[2] = Object.assign({}, rt5[2], { bridge_process_epoch: 'other-process' });
  const before5 = H.sttRequests.length;
  await replay(H, rt5);
  r.rt5Rejected = H.sttRequests.length === before5 && H.diag.some(d => d.includes('epoch_mismatch'));
  return r;
}

// PTT start send failure: the failed take closes as an explicit owner error; later takes are not blocked.
async function scenarioStartSendFail(H) {
  const r = {};
  H.el('chat-input').value = 'draft-kept';
  const ev = runBridge([{ op: 'down' }, { op: 'up' }, { op: 'finish', take: 1 }, { op: 'down' }, { op: 'up' }, { op: 'finish', take: 2 }]).events;
  const cap1 = ev[0].capture_id, cap2 = ev[3].capture_id;
  H.ctx.failNextPttStart = true;
  await H.feed(ev[0]);                 // take 1 down: ptt_start send throws
  r.failVisible = H.sysTexts().some(t => t.includes('sys_ptt_start_fail'));
  r.failTraced = H.diag.some(d => d.includes('PTT_CAPTURE') && d.includes(cap1) && d.includes('ptt_start_send_failed'));
  r.take1Closed = !H.ctx.driverInputArbiter.captureSnapshot().some(c => c.captureId === cap1);
  r.notHeld = H.ctx.pttHeld === false;
  // the Bridge still recorded take 1 physically; its up + terminal arrive later and must not resurrect it
  H.feed(ev[1]); H.feed(ev[2]); await sleep(20);
  r.take1TerminalRejected = H.diag.some(d => d.includes('terminal_rejected') && d.includes(cap1) && d.includes('duplicate_after_release'));
  r.sttAfterTake1 = H.sttRequests.length;
  // take 2 works normally
  await replay(H, ev.slice(3));
  r.take2Stt = await waitFor(() => H.sttRequests.length === r.sttAfterTake1 + 1, 1500);
  if (r.take2Stt) H.sttReply(H.sttRequests.length - 1, { text: chatText('送信失敗の後のテイク', ['了解。']) });
  await waitFor(() => H.userTexts().includes('送信失敗の後のテイク') && !H.ctx.isBusy, 5000);
  r.take2Processed = H.userTexts().includes('送信失敗の後のテイク');
  r.take2Id = cap2;
  r.draftKept = H.el('chat-input').value === 'draft-kept';
  return r;
}

// Turn scope: a real session switch cancels the in-flight turn; ordinary frame/fuel progression does not.
async function scenarioTurnScope(H, gateDir, change) {
  H.el('chat-input').value = chatText('状況を教えて', ['了解、', '継続する。'], { holdGateDir: gateDir, holdAfterChunk: 0 });
  const pA = H.ctx.sendMsg('typed');
  await waitFor(() => exists(path.join(gateDir, 'arrived')));
  const r = { receiveOk: change === 'epoch' ? H.canonicalHello('epoch-b') : H.canonicalReceive(change === 'session'
    ? { seq: 2, frame: 51, session: 1 } : { seq: 2, frame: 51, fuel: 4.2 }) };
  r.providerAborted = await waitFor(() => exists(path.join(gateDir, 'provider_aborted')), change === 'ordinary' ? 300 : 3000);
  fs.writeFileSync(path.join(gateDir, 'release'), '1');
  await Promise.race([pA, sleep(3000)]);
  await sleep(50);
  r.replyInHistory = H.assistantTexts().some(t => String(t).includes('継続する'));
  r.scopeNotice = H.sysTexts().some(t => t.includes('セッションが切り替わったため前の応答を中断'));
  r.connError = H.sysTexts().some(t => t.includes('sys_conn_error'));
  r.busy = H.ctx.isBusy;
  return r;
}

// Urgent typed input while NOT busy but the previous reply is still being spoken.
async function scenarioUrgentAfterReply(H, gateDir) {
  H.el('chat-input').value = chatText('状況を教えて', ['了解。', '二文目はまだ流れていない。'], { holdGateDir: gateDir, holdAfterChunk: 1 });
  const pA = H.ctx.sendMsg('typed');
  await waitFor(() => exists(path.join(gateDir, 'arrived')));
  await H.startCurrentUtterance();
  const first = H.ctx.currentSpeakItem;
  fs.writeFileSync(path.join(gateDir, 'release'), '1');
  await pA; await sleep(30);
  const r = { notBusy: H.ctx.isBusy === false, firstStillPlaying: !!first && first._finalized === 'spoken' };
  H.el('chat-input').value = 'ピット入るぞ';
  await H.ctx.sendMsg('typed');
  r.firstOutcome = first ? first._finalized : null;
  r.secondDropped = H.ctx.utteranceTraceLog.some(e => String(e.text || '').includes('二文目') && /dropped/.test(String(e.state || e.event || '')));
  r.command = H.wsSent.filter(m => m.cmd === 'driver_plan_command').length;
  return r;
}

async function scenarioPendingBounds(H) {
  const gate = fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-gateB-'));
  H.el('chat-input').value = chatText('状況を教えて', ['了解、', '継続する。'], { holdGateDir: gate, holdAfterChunk: 0 });
  const pA = H.ctx.sendMsg('typed');
  await waitFor(() => exists(path.join(gate, 'arrived')));
  for (const s of ['一', '二', '三']) { H.el('chat-input').value = chatText('質問' + s, ['答え' + s + '。']); await H.ctx.sendMsg('typed'); }
  H.el('chat-input').value = '質問四';
  await H.ctx.sendMsg('typed');
  const r = { overflowVisible: H.sysTexts().some(t => t.includes('待機中の入力が多すぎる')), overflowEditorKept: H.el('chat-input').value === '質問四',
    pending: H.ctx.driverInputArbiter.pendingCount() };
  // real canonical session switch while waiting → turn stopped, waiting inputs rejected visibly
  r.switchOk = H.canonicalReceive({ seq: 2, frame: 51, session: 3 });
  fs.writeFileSync(path.join(gate, 'release'), '1');
  await Promise.race([pA, sleep(3000)]); await sleep(150);
  r.scopeRejectedVisible = H.sysTexts().filter(t => t.includes('セッションが切り替わったため処理しなかった')).length === 3;
  r.notProcessed = !H.userTexts().some(t => t.startsWith('質問'));
  return r;
}

// Wait contract for the timeout scenario (fixture only; the product's 30s fetch deadline is unchanged):
//   observer arrival deadline (10s)  <  scenario stub hold (20s)  <  product turn timeout (30s).
// The stub's default 5s auto-release is shorter than the observer deadline, so this scenario
// passes its own hold; every other scenario keeps the 5s default.
const TIMEOUT_OBSERVER_DEADLINE_MS = 10000;
const TIMEOUT_SCENARIO_HOLD_MS = 20000;
async function scenarioTimeout(H, gateDir, opts) {
  opts = opts || {};
  H.el('chat-input').value = chatText('状況を教えて', ['了解、', '継続する。'],
    { holdGateDir: gateDir, holdAfterChunk: 0, holdTimeoutMs: TIMEOUT_SCENARIO_HOLD_MS });
  const t0 = Date.now();
  const pA = H.ctx.sendMsg('typed');
  // 1) synchronize on the ACTUAL pending stream: the request is held inside the real server's
  //    SDK stub (first chunk has no sentence boundary, so nothing reached the client yet).
  const arrived = await waitFor(() => exists(path.join(gateDir, 'arrived')), TIMEOUT_OBSERVER_DEADLINE_MS);
  // slow-observer control: the observer acts late (still inside the hold), the turn must still be live
  if (opts.observerDelayMs) await sleep(opts.observerDelayMs);
  const tArrived = Date.now();   // observer action time (includes observerDelayMs)
  const turn = H.ctx.driverInputArbiter.currentTurn();
  const liveAtTimeout = !!turn && H.ctx.driverInputArbiter.isCurrent(turn) && H.ctx.isBusy === true;
  const replyBeforeTimeout = H.assistantTexts().length;
  // 2) the same function the product's 30s fetchTimer calls
  const accepted = H.ctx.timeoutDriverTurn(turn);
  const tTimeout = Date.now();
  const abortReason = turn && turn.controller ? turn.controller.signal.reason : null;
  // 3) wait for the turn itself to settle (not a fixed short race)
  const settled = await Promise.race([pA.then(() => 'settled'), sleep(5000).then(() => 'pending')]);
  const tSettled = Date.now();
  const serverSawClose = await waitFor(() => exists(path.join(gateDir, 'provider_aborted')), 3000);
  return { connErrorShown: H.sysTexts().some(t => t.includes('sys_conn_error')), busy: H.ctx.isBusy,
    // observation chain (reported before any assertion)
    arrived, hadTurn: !!turn, liveAtTimeout, replyBeforeTimeout, accepted, timedOut: !!(turn && turn.timedOut),
    cancelled: !!(turn && turn.cancelled), abortReason: abortReason === undefined ? null : String(abortReason),
    // serverSawClose: the held request (not an auto-released one) was closed by this client
    settled, serverSawClose,
    msToArrival: tArrived - t0, msArrivalToTimeout: tTimeout - tArrived, msTimeoutToSettled: tSettled - tTimeout,
    clientError: H.diag.filter(d => d.startsWith('CLIENT ERROR')), assistants: H.assistantTexts(),
    trace: H.ctx.driverInputArbiter.trace().map(e => e.event) };
}

// Timeout vs EOF race (deterministic): /api/chat IO only — the first read yields a complete
// sentence, the next read stays pending; the timeout is accepted; then that read resolves EOF
// normally (abort did not reject it). The accepted timeout must still end in the connection-error
// exit, never in reply success. withTimeout=false is the normal-completion control.
async function scenarioTimeoutEofRace(H, withTimeout) {
  let release = null, reads = 0;
  const realFetch = H.ctx.fetch;
  H.ctx.fetch = (u, init) => String(u).endsWith('/api/chat') ? Promise.resolve({
    ok: true, status: 200, headers: { get: () => null },
    body: { getReader: () => ({
      read: () => (++reads === 1 ? Promise.resolve({ done: false, value: new TextEncoder().encode('了解。継続する。') })
        : new Promise(r => { release = r; })),
      cancel() { return Promise.resolve(); } }) } }) : realFetch(u, init);
  H.el('chat-input').value = '状況を教えて';
  const p = H.ctx.sendMsg('typed');
  const pending = await waitFor(() => !!release, 3000);
  const turn = H.ctx.driverInputArbiter.currentTurn();
  const accepted = withTimeout ? H.ctx.timeoutDriverTurn(turn) : false;
  if (release) release({ done: true, value: undefined });
  await Promise.race([p, sleep(3000)]);
  await sleep(20);
  return { pending, accepted, timedOut: !!(turn && turn.timedOut), aborted: !!(turn && turn.controller.signal.aborted),
    connErrors: H.sysTexts().filter(t => t.includes('sys_conn_error')).length, busy: H.ctx.isBusy,
    assistants: H.assistantTexts(), clientError: H.diag.filter(d => d.startsWith('CLIENT ERROR')) };
}

// ── 5. main ────────────────────────────────────────────────────────────────
async function main() {
  const afterHtml = fs.readFileSync(path.join(ROOT, 'desktop/renderer.html'), 'utf8');
  const port = 36100 + Math.floor(Math.random() * 400);
  const srv = await spawnServer(port, path.join(ROOT, 'server.js'));
  const tmpServers = [];
  try {
    console.log('\n── after: ordinary input while busy is explicitly pending, then processed in order ──');
    {
      const H = buildHarness(afterHtml, port);
      check('all WO016 renderer functions extracted from the product file', H.missing.length === 0, H.missing);
      check('product onmessage calls onDriverInputCanonicalEvent right after successful canonical receive and hello', HOOKS.receive && HOOKS.hello, HOOKS);
      const r = await scenarioOrdinaryPending(H);
      check('busy ordinary input shows a visible pending notice', r.queuedVisible);
      check('pending input is not inserted into history ahead of the current reply', r.userBeforeRelease.length === 1);
      check('typed editor cleared once the input is explicitly accepted', r.editorAfter === '');
      check('pending input is processed after the current turn, in order', JSON.stringify(r.users) === JSON.stringify(['状況を教えて', '続けて様子を教えて']), r.users);
      check('history keeps user/assistant alternation (A reply before B)', r.assistants.length === 2 && r.assistants[0].includes('継続する') && r.assistants[1].includes('問題ない'), r.assistants);
    }
    console.log('\n── after: urgent typed declaration supersedes the in-flight reply ──');
    {
      const H = buildHarness(afterHtml, port);
      const r = await scenarioUrgentSupersedes(H, fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-gateU-')));
      check('urgent declaration reaches the real router → canonical command envelope exactly once', r.commandEnvelopes === 1, r);
      check('server observed client close and aborted the provider stream (SDK signal)', r.providerAborted);
      check('already-audible old sentence is interrupted (WO015 audible_interrupted), not completed', r.firstStarted && r.firstOutcome === 'audible_interrupted', r);
      check('old reply tail is never spoken', !r.oldTailSpoken);
      check('old reply body never enters assistant history', !r.oldBodyInHistory);
      check('intentional cancel is not reported as a connection error (UI/voice)', !r.connErrorShown && !r.connErrorSpoken);
      check('old reply never reaches the judge consumer', r.judgeCallsBeforeC === 0);
      check('race is real: new owner C was busy before the old turn settled', r.busyRightAfterC === true, r);
      check('old catch/finally does not clear the NEW owner busy state', r.busyAfterOldFinally === true && r.ownerAfterOldFinally === true, r);
      check('new owner completes normally and then releases busy', r.cCompleted && r.busyEnd === false, r);
      check('history alternation kept with an interruption marker (not old body)', r.marker);
      const log = srv.out.join('');
      check('server records the abort distinctly from a stream ERROR', log.includes('[/api/chat stream ABORTED] reason=client_closed') && !/stream ERROR\][^\n]*aborted/i.test(log));
    }
    console.log('\n── after: non-cancel control (upstream intact) ──');
    {
      const H = buildHarness(afterHtml, port);
      const r = await scenarioControl(H, fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-gateK-')));
      check('control: no provider abort without a client cancel', r.providerAborted === false);
      check('control: full reply reaches history and judge consumer once', r.history.some(t => t.includes('了解。継続する。')) && r.judgeCalls === 1, r);
      check('control: busy released by the owner', r.busy === false);
    }
    console.log('\n── after: physical PTT while busy keeps the capture ──');
    {
      const H = buildHarness(afterHtml, port);
      const r = await scenarioPttBusy(H, fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-gateP-')));
      check('PTT down while busy starts recording (ptt_start), never ptt_abort', r.pttStartSent && !r.pttAbortSent, r);
      check('real Bridge: down, ptt_start echo and the audio terminal all carry the same capture_id', r.startCarriesId && r.audioIdMatchesDown, r);
      check('PTT up stops recording normally', r.pttStopSent);
      check('PTT barge-in aborts the in-flight provider stream', r.providerAborted);
      check('the busy-time take is transcribed and answered through the normal turn', r.sttStarted && r.pttReplied, r);
      check('STT text never overwrites the typed draft in the editor', r.editorKept);
      check('barge-in old reply body never enters history', !r.oldBodyInHistory);
    }
    console.log('\n── after: STT ordering / duplicate / empty / error / scope ──');
    {
      const H = buildHarness(afterHtml, port);
      const r = await scenarioSttOrdering(H);
      check('newer STT result is held while the older capture is still transcribing', r.newerHeld);
      check('captures are processed in press order even when STT returns reversed', JSON.stringify(r.order.slice(0, 2)) === JSON.stringify(['一番目の発話', '二番目の発話']), r.order);
      check('duplicate/unattributed bridge terminal is rejected explicitly', r.duplicateRejected);
      check('empty take ends explicitly with a not-caught hint', r.emptyHint);
      check('STT failure on an older take does not erase the newer take', r.errorKeptNewer && r.errorHint, r);
      check('take from a previous session (real canonical switch) is not routed and is visibly reported', r.sessionSwitchAccepted && r.scopeNotProcessed && r.scopeNoticeVisible, r);
    }
    console.log('\n── after: PTT take identity on the real Bridge transport (reviewer counterexamples) ──');
    {
      const H = buildHarness(afterHtml, port, { arbiterOpts: { captureLostMs: 50 } });
      const r = await scenarioCaptureIdentity(H);
      check('RT1 re-delivered old terminal while a later take is live is rejected as duplicate (not given to take 2)',
        r.rt1DupRejected && r.rt1SttCount === 2 && r.rt1Take2Own && JSON.stringify(r.rt1SttAudio) === '["take1","take2"]', r);
      check('RT1 both takes processed once each, in press order', JSON.stringify(r.rt1Order) === JSON.stringify(['テイク一', 'テイク二']), r);
      check('RT2 timed-out take closes visibly; its late terminal is rejected, take 2 keeps its own', r.rt2LostVisible && r.rt2LateRejected && r.rt2OnlyTake2 && r.rt2Take2Own && r.rt2Take2Processed, r);
      check('RT3 terminal before the up edge is accepted for its own take and processed', r.rt3Accepted && r.rt3Processed, r);
      check('RT4 outdated Bridge without capture_id: rejected visibly, never FIFO-guessed', r.rt4Rejected, r);
      check('RT5 terminal claiming another Bridge epoch is rejected', r.rt5Rejected, r);
    }
    console.log('\n── after: PTT start send failure closes only its own take ──');
    {
      const H = buildHarness(afterHtml, port);
      const r = await scenarioStartSendFail(H);
      check('send failure: visible error and capture trace with the failed take id', r.failVisible && r.failTraced && r.notHeld, r);
      check('send failure: the failed take closes (not left stopped at the press-order head)', r.take1Closed, r);
      check('send failure: the failed take\'s later Bridge terminal is rejected, not resurrected', r.take1TerminalRejected && r.sttAfterTake1 === 0, r);
      check('send failure: the next take is transcribed and processed normally; draft untouched', r.take2Stt && r.take2Processed && r.draftKept, r);
    }
    console.log('\n── after: turn scope (real canonical transitions) with ordinary-frame control ──');
    {
      const H = buildHarness(afterHtml, port);
      const r = await scenarioTurnScope(H, fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-scopeS-')), 'session');
      check('session switch: in-flight turn cancelled (provider aborted), reported, no connection error, busy released',
        r.receiveOk && r.providerAborted && r.scopeNotice && !r.connError && r.busy === false && !r.replyInHistory, r);
    }
    {
      const H = buildHarness(afterHtml, port);
      const r = await scenarioTurnScope(H, fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-scopeE-')), 'epoch');
      check('Bridge epoch change (hello): in-flight turn cancelled before any new snapshot', r.receiveOk && r.providerAborted && r.scopeNotice && !r.replyInHistory, r);
    }
    {
      const H = buildHarness(afterHtml, port);
      const r = await scenarioTurnScope(H, fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-scopeO-')), 'ordinary');
      check('CONTROL ordinary frame/fuel progression: turn kept, reply delivered, no scope notice',
        r.receiveOk && !r.providerAborted && r.replyInHistory && !r.scopeNotice, r);
    }
    console.log('\n── after: urgent input while the previous reply is still speaking (not busy) ──');
    {
      const H = buildHarness(afterHtml, port);
      const r = await scenarioUrgentAfterReply(H, fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-urgA-')));
      check('urgent input interrupts the previous reply audio and drops its queued tail; command sent once',
        r.notBusy && r.firstStillPlaying && r.firstOutcome === 'audible_interrupted' && r.command === 1, r);
    }
    console.log('\n── after: pending bounds (overflow / scope) ──');
    {
      const H = buildHarness(afterHtml, port);
      const r = await scenarioPendingBounds(H);
      check('overflow beyond 3 waiting inputs is rejected visibly and the typed text kept', r.overflowVisible && r.overflowEditorKept && r.pending === 3, r);
      check('waiting inputs invalidated by a real session switch are reported, not processed', r.switchOk && r.scopeRejectedVisible && r.notProcessed, r);
    }
    console.log('\n── after: network timeout stays a connection error (distinct from intent) ──');
    {
      const H = buildHarness(afterHtml, port);
      const r = await scenarioTimeout(H, fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-gateT-')));
      console.log('   timeout-observation ' + JSON.stringify(r));
      // ordered chain: each link is its own check so a failure names the broken boundary
      check('timeout precondition: request held in the real server stub while the turn is live and no reply exists',
        r.arrived && r.hadTurn && r.liveAtTimeout && r.replyBeforeTimeout === 0, r);
      check('timeout accepted on the live turn; controller aborted with reason "timeout" (not an intentional cancel)',
        r.accepted && r.timedOut && !r.cancelled && r.abortReason === 'timeout', r);
      check('timeout closed the HELD request (server observed the client close before any auto-release)', r.serverSawClose, r);
      check('timeout → existing connection-error path, busy released', r.settled === 'settled' && r.connErrorShown && r.busy === false, r);
      check('the connection error is attributed to the turn timeout in the client log',
        r.clientError.length === 1 && /timeout/.test(r.clientError[0]) && /turn_timeout/.test(r.clientError[0]), r);
    }
    console.log('\n── after: slow observer (6s after arrival, inside the 20s scenario hold) still times out a live turn ──');
    {
      const H = buildHarness(afterHtml, port);
      const r = await scenarioTimeout(H, fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-gateTS-')), { observerDelayMs: 6000 });
      console.log('   slow-observer-timeout-observation ' + JSON.stringify(r));
      check('slow observer: wait contract holds (observer 10s < hold 20s < product 30s) and the turn is still live at 6s',
        TIMEOUT_OBSERVER_DEADLINE_MS < TIMEOUT_SCENARIO_HOLD_MS && TIMEOUT_SCENARIO_HOLD_MS < 30000
        && r.arrived && r.hadTurn && r.liveAtTimeout && r.replyBeforeTimeout === 0 && r.msToArrival >= 6000, r);
      check('slow observer: timeout accepted on the live turn → held request closed → connection error, busy released',
        r.accepted && r.timedOut && !r.cancelled && r.abortReason === 'timeout' && r.serverSawClose
        && r.settled === 'settled' && r.connErrorShown && r.busy === false, r);
    }
    console.log('\n── after: timeout accepted, then the pending read resolves EOF normally (deterministic race) ──');
    {
      const H = buildHarness(afterHtml, port);
      const r = await scenarioTimeoutEofRace(H, true);
      console.log('   timeout-eof-observation ' + JSON.stringify(r));
      check('EOF after accepted timeout: precondition (read pending, timeout accepted, controller aborted)', r.pending && r.accepted && r.timedOut && r.aborted, r);
      check('EOF after accepted timeout → one connection error, busy released', r.connErrors === 1 && r.busy === false, r);
      check('EOF after accepted timeout: the old reply body is NOT committed to history', !r.assistants.some(t => t.includes('継続する')) && r.assistants.length === 1, r);
      check('EOF after accepted timeout: error attributed to the turn timeout', r.clientError.length === 1 && /turn_timeout/.test(r.clientError[0]), r);
    }
    {
      const H = buildHarness(afterHtml, port);
      const r = await scenarioTimeoutEofRace(H, false);
      check('CONTROL same IO without timeout: normal completion commits the reply, no error', r.pending && r.connErrors === 0 && r.busy === false && r.assistants.some(t => t.includes('継続する')), r);
    }

    // ── isolated cuts: RED, with upstream intact control ──
    console.log('\n── cuts (RED expected) ──');
    {
      const H = buildHarness(afterHtml, port, { mutate: ctx => vm.runInContext(
        extract(scriptOf(afterHtml), 'finishDriverTurn').replace('if(turn&&!driverInputArbiter.endTurn(turn)) return false;', 'if(turn) driverInputArbiter.endTurn(turn);'), ctx) });
      const r = await scenarioUrgentSupersedes(H, fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-cut1-')));
      check('CUT input-owner guard: old finally clears the new owner busy (RED proves load-bearing)', r.busyAfterOldFinally === false, r);
      check('CUT input-owner guard: upstream intact (urgent command + provider abort still happen)', r.commandEnvelopes === 1 && r.providerAborted);
    }
    {
      const callSrc = extract(scriptOf(afterHtml), 'callAPI');
      const cut = callSrc.replace(/if\(_turn && _turn\.cancelled\)\{[\s\S]*?return;\n    \}/, '');
      const H = buildHarness(afterHtml, port, { mutate: ctx => vm.runInContext(cut, ctx) });
      const r = await scenarioUrgentSupersedes(H, fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-cut2-')));
      check('CUT response guard: setup removed the cancelled-catch guard', cut !== callSrc);
      check('CUT response guard: intentional cancel now surfaces as connection error (RED)', r.connErrorShown || r.connErrorSpoken, r);
      check('CUT response guard: upstream intact (provider abort + command)', r.providerAborted && r.commandEnvelopes === 1);
    }
    {
      const cancelSrc = extract(scriptOf(afterHtml), 'cancelDriverTurn');
      const cut = cancelSrc.replace('  interruptTurnSpeech(turn);\n', '');
      const H = buildHarness(afterHtml, port, { mutate: ctx => vm.runInContext(cut, ctx) });
      const r = await scenarioUrgentSupersedes(H, fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-cut3-')));
      check('CUT cancel consumer: setup removed the speech-item cancellation', cut !== cancelSrc);
      check('CUT cancel consumer: old audible sentence is NOT interrupted (RED)', r.firstOutcome !== 'audible_interrupted', r);
      check('CUT cancel consumer: upstream intact (turn still cancelled, no old body in history)', r.providerAborted && !r.oldBodyInHistory, r);
    }
    {
      // server cut: provider signal removed → client cancel no longer aborts the provider
      const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
      const cutSrc = serverSrc.replace('}, { signal: providerAbort.signal });', '});').replace('          if (clientClosed) break;\n', '');
      check('CUT server: setup removed the SDK signal wiring', cutSrc !== serverSrc);
      // run-unique sibling file (same directory so relative requires resolve; never shared across runs)
      const f = path.join(ROOT, '.wo016-cut-server.' + RUN_ID + '.tmp.js'); fs.writeFileSync(f, cutSrc); tmpServers.push(f);
      const p2 = port + 1000;
      const s2 = await spawnServer(p2, f);
      try {
        const H = buildHarness(afterHtml, p2);
        const gate = fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-cut4-'));
        const r = await scenarioUrgentSupersedes(H, gate);
        check('CUT server: provider stream is NOT aborted on client cancel (RED)', r.providerAborted === false, r);
        check('CUT server: upstream renderer cancel intact (no old body, no connection error)', !r.oldBodyInHistory && !r.connErrorShown);
        fs.writeFileSync(path.join(gate, 'release'), '1');
      } finally { s2.child.kill('SIGTERM'); }
    }
    {
      // capture-identity cut: exact-id attach replaced by "oldest stopped take" (FIFO)
      const arbSrc = fs.readFileSync(path.join(ROOT, 'desktop/driver-input-arbiter.js'), 'utf8');
      const cutSrc = arbSrc.replace("if(retired.has(captureId))return reject(retired.get(captureId)==='lost'?'late_after_lost':'duplicate_after_release');\n    const c=find(captureId);",
        "const c=captures.find(x=>x.state==='stopped');");
      check('CUT capture identity: setup replaced exact-id attach with FIFO', cutSrc !== arbSrc);
      const H = buildHarness(afterHtml, port, { arbiterModule: loadArbiter(cutSrc), arbiterOpts: { captureLostMs: 50 } });
      const r = await scenarioCaptureIdentity(H);
      check('CUT capture identity: take 2 transcribes take 1\'s re-delivered audio (RED)', !r.rt1DupRejected && JSON.stringify(r.rt1SttAudio) === '["take1","take1"]', r);
      check('CUT capture identity: upstream intact (real Bridge still emitted two distinct ids)', r.rt1DistinctIds, r);
    }
    {
      // timeout gate cut: the in-loop check after each read is removed
      const callSrc = extract(scriptOf(afterHtml), 'callAPI');
      const cut = callSrc.replace('      _turnTimeoutGate(reader);   // a chunk or EOF that resolves after an accepted timeout is not success\n', '')
        .replace('    _turnTimeoutGate(null);\n', '');
      check('CUT timeout gate: setup removed the post-read/completion timeout gate', cut !== callSrc);
      const H = buildHarness(afterHtml, port, { mutate: ctx => vm.runInContext(cut, ctx) });
      const r = await scenarioTimeoutEofRace(H, true);
      check('CUT timeout gate: accepted timeout ends silently as reply success, old body in history (RED)', r.connErrors === 0 && r.assistants.some(t => t.includes('継続する')), r);
      check('CUT timeout gate: upstream intact (timeout accepted, controller aborted)', r.accepted && r.timedOut && r.aborted, r);
    }
    {
      // send-failure cut: REVISE1 close sequence (stopCapture + resolveCapture) instead of failCapture
      const startSrc = extract(scriptOf(afterHtml), 'pttStart');
      const cut = startSrc.replace("deliverReleasedCaptures(driverInputArbiter.failCapture(failed,'ptt_start_send_failed',currentDriverInputScopeKey()).released);",
        "driverInputArbiter.stopCapture(failed);deliverReleasedCaptures(driverInputArbiter.resolveCapture(failed,{kind:'error',reason:'ptt_start_send_failed'},currentDriverInputScopeKey()).released);");
      check('CUT send-failure close: setup restored the REVISE1 stop+resolve sequence', cut !== startSrc);
      const H = buildHarness(afterHtml, port, { mutate: ctx => vm.runInContext(cut, ctx) });
      const r = await scenarioStartSendFail(H);
      check('CUT send-failure close: failed take stays at the head and the next take is never processed (RED)', !r.take1Closed && !r.take2Processed, r);
      check('CUT send-failure close: upstream intact (visible error still shown, take 2 STT still ran)', r.failVisible && r.take2Stt, r);
    }
    {
      // turn-scope cut: a live turn ignores its captured scope
      const arbSrc = fs.readFileSync(path.join(ROOT, 'desktop/driver-input-arbiter.js'), 'utf8');
      const cutSrc = arbSrc.replace('const turnScopeStale=(turn,currentScopeKey)=>!!turn&&scopeChanged(turn.scopeKey,currentScopeKey);', 'const turnScopeStale=()=>false;')
        .replace('    &&(currentScopeKey===undefined||!scopeChanged(turn.scopeKey,currentScopeKey));', ';');
      check('CUT turn scope: setup removed the turn scope check', cutSrc !== arbSrc);
      const H = buildHarness(afterHtml, port, { arbiterModule: loadArbiter(cutSrc) });
      const r = await scenarioTurnScope(H, fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-cutS-')), 'session');
      check('CUT turn scope: session switch no longer cancels the turn (provider not aborted, no notice) (RED)', !r.providerAborted && !r.scopeNotice, r);
      check('CUT turn scope: upstream canonical switch accepted; existing canonical body fence still keeps the stale reply out of history',
        r.receiveOk && !r.replyInHistory, r);
    }

    // ── before: pre-WO016 reconstructed with SHA provenance (see tests-wo016-pre-reconstruction.js) ──
    const V1_DIR = process.env.WO016_V1_DIR || '/tmp/wo016-oct16-before-files';
    const v1Html = fs.existsSync(path.join(V1_DIR, 'desktop/renderer.html')) ? fs.readFileSync(path.join(V1_DIR, 'desktop/renderer.html'), 'utf8') : null;
    const v1Server = fs.existsSync(path.join(V1_DIR, 'server.js')) ? fs.readFileSync(path.join(V1_DIR, 'server.js'), 'utf8') : null;
    const recon = (v1Html && v1Server) ? Recon.reconstruct(v1Html, v1Server) : null;
    if (recon && recon.ok) {
      console.log('\n── before (pre-WO016, reconstructed: renderer ' + recon.rendererSha.slice(0, 8) + ' / server ' + recon.serverSha.slice(0, 8) + ' = recorded pre-WO016 SHA) ──');
      const beforeHtml = recon.renderer;
      const f = path.join(ROOT, '.wo016-before-server.' + RUN_ID + '.tmp.js'); fs.writeFileSync(f, recon.server); tmpServers.push(f);
      const p3 = port + 2000;
      const s3 = await spawnServer(p3, f);
      try {
        {
          const H = buildHarness(beforeHtml, p3);
          check('before: snapshot lacks WO016 helpers (comparison is real)', H.missing.includes('admitDriverInput'));
          const gate = fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-b1-'));
          H.el('chat-input').value = chatText('状況を教えて', ['了解、', '継続する。'], { holdGateDir: gate, holdAfterChunk: 0 });
          const pA = H.ctx.sendMsg('typed');
          await waitFor(() => exists(path.join(gate, 'arrived')));
          H.el('chat-input').value = chatText('続けて様子を教えて', ['問題ない。']);
          await H.ctx.sendMsg('typed');
          const noticed = H.sysTexts().length > 0;
          fs.writeFileSync(path.join(gate, 'release'), '1'); await pA; await sleep(300);
          check('before RED: busy ordinary input silently not processed (no notice, never answered)', !noticed && !H.userTexts().includes('続けて様子を教えて'), H.userTexts());
        }
        {
          const H = buildHarness(beforeHtml, p3);
          const gate = fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-b2-'));
          H.el('chat-input').value = chatText('状況を教えて', ['了解。', '旧応答の続きは古い。'], { holdGateDir: gate, holdAfterChunk: 0 });
          const pA = H.ctx.sendMsg('typed');
          await waitFor(() => exists(path.join(gate, 'arrived')));
          H.el('chat-input').value = 'ピット入るぞ';
          await H.ctx.sendMsg('typed');
          const envelopes = H.wsSent.filter(m => m.cmd === 'driver_plan_command').length;
          await sleep(200);
          const aborted = exists(path.join(gate, 'provider_aborted'));
          fs.writeFileSync(path.join(gate, 'release'), '1'); await pA; await sleep(80);
          check('before RED: urgent declaration while busy dropped (no command envelope)', envelopes === 0);
          check('before RED: provider stream not aborted', !aborted);
          check('before RED: stale old reply body enters history', H.assistantTexts().some(t => t.includes('旧応答の続き')));
        }
        {
          const H = buildHarness(beforeHtml, p3);
          const gate = fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-b3-'));
          H.el('chat-input').value = chatText('状況を教えて', ['了解、', '継続する。'], { holdGateDir: gate, holdAfterChunk: 0 });
          const pA = H.ctx.sendMsg('typed');
          await waitFor(() => exists(path.join(gate, 'arrived')));
          await H.ctx.pttStart();
          check('before RED: PTT while busy discards the take (ptt_abort, no ptt_start)', H.wsSent.some(m => m.cmd === 'ptt_abort') && !H.wsSent.some(m => m.cmd === 'ptt_start'));
          fs.writeFileSync(path.join(gate, 'release'), '1'); await pA;
        }
      } finally { s3.child.kill('SIGTERM'); }
    } else {
      // Not a pass: the comparison is unavailable and is reported as such.
      console.log('\n(BEFORE COMPARISON UNAVAILABLE: pre-WO016 reconstruction not verified ' + JSON.stringify(recon
        ? { v1Verified: recon.v1Verified, misses: recon.misses, rendererSha: recon.rendererSha, serverSha: recon.serverSha } : { v1Present: false }) + ')');
    }
    // ── partial baseline: WO016 v1 (FIFO capture, scope without driver/epoch), same fixture ──
    if (v1Html && recon && recon.v1Verified && fs.existsSync(path.join(V1_DIR, 'desktop/driver-input-arbiter.js'))) {
      console.log('\n── partial baseline: WO016 v1 renderer+arbiter (NOT pre-WO016), same fixture ──');
      const v1Arb = loadArbiter(fs.readFileSync(path.join(V1_DIR, 'desktop/driver-input-arbiter.js'), 'utf8'));
      {
        // v1 attaches by arrival position: take 1's re-delivered terminal lands on take 2
        const H = buildHarness(v1Html, port, { arbiterModule: v1Arb });
        const rt1 = runBridge([{ op: 'down' }, { op: 'up' }, { op: 'finish', take: 1 }, { op: 'down' }, { op: 'up' },
          { op: 'redeliver', take: 1 }, { op: 'finish', take: 2, seconds: 1.3 }]).events;
        await replay(H, rt1);
        await sleep(60);
        const who = H.sttRequests.map(q => q.payload.audio === rt1[2].audio ? 'take1' : q.payload.audio === rt1[6].audio ? 'take2' : '?');
        check('v1 RED: FIFO gives take 1\'s re-delivered audio to take 2; take 2\'s own audio is never transcribed', JSON.stringify(who) === '["take1","take1"]', who);
      }
      {
        const H = buildHarness(v1Html, port, { arbiterModule: v1Arb });
        const r = await scenarioTurnScope(H, fs.mkdtempSync(path.join(os.tmpdir(), 'wo016-v1S-')), 'session');
        check('v1 RED: real session switch does not cancel the in-flight turn (no provider abort, no notice)', !r.providerAborted && !r.scopeNotice, r);
      }
    } else {
      console.log('\n(PARTIAL v1 BASELINE UNAVAILABLE)');
    }
  } finally {
    srv.child.kill('SIGTERM');
    for (const f of tmpServers) { try { fs.unlinkSync(f); } catch (e) {} }
  }
  console.log(`\n[tests-wo016-driver-input-ownership] 合格 ${pass} / 不合格 ${fail}。実renderer/router/canonical cache/projection/arbiter/実server.js、SDK・/api/tts・/api/stt・Audio・WS送信のみIO stub。外部有料API呼び出し0。`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
