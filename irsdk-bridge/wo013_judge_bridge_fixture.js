#!/usr/bin/env node
'use strict';
/* WO013 r7 — persistent actual-Renderer process for the single unbroken
 * Server->Renderer->Bridge->Renderer round trip (review/PITWALL_SHARED_
 * WORKING_LOG.md "WO013 r5全routefixture読取監査": REVISE 反証).
 *
 * This is NOT a one-shot CLI tool invoked separately per leg (that was r5's
 * defect: mode=resolve and mode=readback were two SEPARATE `node fixture.js`
 * subprocess invocations, each with its OWN fresh VM, so "readback" never
 * touched the same in-memory strategyResponseOutbox/bridgeStrategyDecisions
 * the resolve leg had actually mutated -- it only replayed a JSON dump of
 * them into a brand-new sandbox). Here the VM/sandbox is built exactly ONCE
 * at process startup and stays alive for the whole test, driven by a
 * persistent stdin/stdout JSON-line IPC protocol -- every command below
 * (`propose`, `resolve_start`/`resolve_await`, `bridge_ack`,
 * `canonical_receive`, ...) operates on the SAME sandbox/cache/projection.
 *
 * r5's second defect: `input.classification` was handed directly to the
 * real `applyProposalJudgeTag()` -- the classification never actually
 * passed through the real Server (`/api/chat` judge-transport NDJSON) or
 * the real extracted `callAPI()`. Here classification is injected ONLY
 * into the Anthropic SDK stub (`tests-wo001-anthropic-stream-stub-preload.
 * js`, via its `<<PW_JUDGE ...>>`-tagged scripted chunk) that the REAL
 * `server.js` child process (spawned on startup, same technique as
 * `tests-wo011-desktop-projection.js` scenario J) consumes -- the real
 * `callAPI()` is the only thing that ever calls `applyProposalJudgeTag()`,
 * exactly as it does for a genuine driver utterance.
 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const ROOT = path.resolve(__dirname, '..');
const os = require('os');
const Cache = require(path.join(ROOT, 'desktop/canonical-lifecycle-cache'));
const Projection = require(path.join(ROOT, 'desktop/strategy-state-projection'));
const RaceContextBuilder = require(path.join(ROOT, 'desktop/race-context-builder'));
const Box = require(path.join(ROOT, 'desktop/box-authority-transport'));
const GapFreshness = require(path.join(ROOT, 'desktop/gap-freshness'));
const JournalStore = require(path.join(ROOT, 'desktop/critical-journal-store'));
const JournalClient = require(path.join(ROOT, 'desktop/critical-journal-client'));
const stub = require(path.join(ROOT, 'tests-wo001-anthropic-stream-stub-preload.js'));
const mainSrc = fs.readFileSync(path.join(ROOT, 'desktop/main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'desktop/preload.js'), 'utf8');
const mainJournalEntry = mainSrc.match(/require\('\.\/critical-journal-store'\)\.setupIPC\([^;]+;/)[0];

// WO015: a real on-disk critical journal (same main.js/preload.js IPC wiring
// tests-critical-journal.js uses), one per persistent sandbox -- BOX candidate
// dispatch is required to go through the REAL durable journal, not a
// manufactured in-memory stand-in.
function buildCriticalJournalApi() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-wo013-journal-'));
  const handlers = new Map();
  const sender = { mainFrame: {} };
  const win = { isDestroyed: () => false, webContents: sender };
  vm.runInNewContext(mainJournalEntry, {
    require: () => JournalStore, ipcMain: { on: (n, f) => handlers.set(n, f) },
    app: { getPath: () => dir }, win,
  });
  let api;
  vm.runInNewContext(preloadSrc, {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_n, v) => { api = v; } },
      ipcRenderer: {
        sendSync: (name, op) => { const e = { sender, senderFrame: sender.mainFrame }; handlers.get(name)(e, op); return e.returnValue; },
        send: () => {}, invoke: () => {}, on: () => {},
      },
    }),
  });
  return api;
}
const html = fs.readFileSync(path.join(ROOT, 'desktop/renderer.html'), 'utf8');
const WO017Scope = require(path.join(ROOT, 'tests-wo017-memory-scope-harness.js'));
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const src = scripts.reduce((a, b) => (a.length > b.length ? a : b));

function extract(name) {
  const head = new RegExp('^(?:async )?function ' + name + '\\(', 'm');
  const m = head.exec(src);
  if (!m) throw new Error('本番コードに ' + name + ' が見つからない（実装が変わった可能性）');
  const rest = src.slice(m.index);
  const end = rest.slice(1).search(/\n(?:async function |function |const |let |\/\/ ──)/);
  return rest.slice(0, end > 0 ? end + 1 : rest.length);
}

// classification注入の唯一の入口：これらの本番関数は一切置き換えない。
// callAPI() が実NDJSON（/api/chat）を解析して applyProposalJudgeTag() を
// 呼ぶ経路そのものを、別プロセスの実server.js越しに毎回実行する。
const PRODUCTION_NAMES = [
  'handleStrategyPlanProposal', 'sendStrategyDecisionResponse', 'applyProposalJudgeTag',
  'bridgeProposalStillCurrent', 'sendStrategyDecisionDelivery', 'handleStrategyDecisionAck',
  'evaluateLiveStrategySwitch',
  'flushStrategyResponseOutbox', 'strategyResponseKey', 'currentProposalResponseBinding',
  'strategyOptionsSupportProposal', 'strategyDeliveryKey',
  'planConditionsFromOptions', 'sameProposalConditions',
  'flushStrategyDeliveryOutbox', 'handleStrategyDeliveryAck', 'strategyDeliveryReceiptFor',
  'ensureStrategyState', 'currentStrategyStateAPI', 'currentCanonicalStrategyLive',
  // WO015反例修復：speak()/speakReplyChunk()は無条件にderiveUtteranceSource()/
  // stableTextHash()を呼びitem.source/textHashを作るようになった（BOX/
  // proposal配送のutterance_id/text_hash同一性修復の一部）。未抽出だと
  // speak()呼出し全てがReferenceErrorで落ちる。
  // WO015 (independent review "speechLatencyTrace stillstub in
  // ownerfixture: all-state actualtrace not proven here"): real
  // speechLatencyTrace() is a thin wrapper over utteranceTrace() plus
  // diagnosticLog -- extract it for real, not the no-op stub, so this
  // fixture's trace actually exercises the full state-naming/queue_ms path.
  'deriveUtteranceSource', 'stableTextHash', 'utteranceTrace', 'utteranceTraceFor', 'speechLatencyTrace',
  'speak', 'speechMayStart', 'drainQueue', 'stopCurrentAudio', 'onUtteranceDone',
  'playWebSpeech', 'nextUtteranceId', 'finalizeUtterance', 'discardQueuedUtterances',
  'pushMsg', 'addMsg',
  // WO015: the actual BOX owner vertical (real accept()/attachUtterance()/
  // report() through real speak(), not a hand-built delivery) needs the real
  // production entry point itself.
  'handleStrategyPlanBoxCall',
  // WO015 (counterexample #1 "GAP finalauthority/drainQueue rewrites
  // item.text, textHash still candidate-time"): buildGapUtterance() is the
  // authority-confirm step inside drainQueue that rewrites item.text; needs
  // real extraction to exercise the REAL rebuild path, not a stand-in.
  'buildGapUtterance',
  // callAPI()自身とその直接依存（tests-wo011-desktop-projection.jsのscenario
  // A〜Jと同じ抽出セット。recordLunaTurn/convoLogは意図的に未抽出——callAPI
  // 側は`typeof X==='function'`guard越し、またはstubで安全にskipされる。
  'currentPlanReplyDependsOn', 'stripProposalJudgeTag', 'speakReplyChunk', 'callAPI',
  // WO015 regression repair: callAPI()'s per-chunk _replyBindingFor() now
  // calls strategyNumericFactBinding() unconditionally (WO015 "Plan質問時の
  // numeric facts shadow" fix replaced an `||` short-circuit with an
  // unconditional call ANDed via bindAll). Previously the OR meant a truthy
  // _replyDomainBinding (e.g. this same_topic/Plan-dependent scenario) never
  // actually reached strategyNumericFactBinding, so its absence from this
  // extraction list went unnoticed. Now it always runs — omitting it throws
  // a ReferenceError inside callAPI()'s try/catch, silently aborting the
  // judge-tag apply path (observed as kept_pending's base_revision failing
  // to advance). Must be extracted alongside callAPI's other real deps.
  // strategyNumericFactBinding() itself now calls the shared
  // _hasUnqualifiedCurrentNumericMention() sentence classifier (defined
  // immediately before it in renderer.html), and callAPI()'s chunk/final
  // fences now also call strategyReplyBindingValid() (which calls
  // captureVerifiedAuxBinding()/verifiedAuxFieldsStillFresh()) -- all pure
  // top-level helpers, all must be extracted alongside callAPI's other real
  // deps or every call throws ReferenceError.
  '_hasUnqualifiedCurrentNumericMention', 'strategyNumericFactBinding',
  'captureVerifiedAuxBinding', 'verifiedAuxFieldsStillFresh', 'strategyReplyBindingValid',
  // Independent finding (WO015 aux mid-implementation audit): confirm/decline
  // outcomes reach sendStrategyDecisionResponse() (already extracted above),
  // which now unconditionally calls strategyProposalAudibleCompletedAt() --
  // a separate WO015 "owner readback" addition this fixture never extracted.
  // Its absence meant every confirm/decline classification silently threw
  // inside callAPI()'s try/catch (observed as 4 ERRORs this fixture's own
  // same_topic cases never hit, since kept_pending never reaches
  // sendStrategyDecisionResponse). Not a Bridge decision-engine defect.
  'strategyProposalAudibleCompletedAt',
  // WO014 r7独立読取差戻し：callAPI()はraceContext:buildCurrentRaceContext()を
  // 本番と同じく毎回呼ぶ（WO014 single canonical builder）。この関数も未抽出
  // だとfetch前にReferenceErrorでcallAPI()自体が落ちる（実judge回帰0件の
  // 証明にならない、fixture入口故障）。
  'buildCurrentRaceContext',
  // WO016 REVISE (judge consumer / urgent command ACK, same VM): the real turn-owner,
  // admission, cancel consumer and Driver input entry (sendMsg) plus the real
  // driver_plan_command queue/ACK/canonical readback chain. Nothing here is a spy: the old
  // judgment is rejected (or not) by the real callAPI()/applyProposalJudgeTag() path.
  'currentDriverInputScopeKey', 'noteDriverInputIdentity', 'enforceDriverInputScope', 'interruptTurnSpeech',
  'isUrgentDriverInput', 'driverInputNotice', 'beginDriverTurn', 'driverTurnLive', 'timeoutDriverTurn',
  'finishDriverTurn', 'cancelDriverTurn', 'admitDriverInput', 'drainPendingDriverInputs', 'sendMsg', 'setHint',
  'newDriverPlanCommandId', 'currentDriverPlanAuthority', 'flushDriverPlanCommandOutbox', 'queueDriverPlanCommand',
  'handleDriverPlanCommandAck', 'confirmCanonicalCommandReadbacks',
];
const PRODUCTION = PRODUCTION_NAMES.map(extract).join('\n');
const JUDGE_CONSTS = 'const PW_JUDGE_TAG_START="<<PW_JUDGE";'
  + 'const PW_JUDGE_TAG_RE=/<<PW_JUDGE\\s+decision_id="([^"]*)"\\s+classification="(confirm|decline|same_topic|unrelated)"\\s*>>/;';

let fakeNow = 1_700_000_000_000;
let ttsResolve = null;
const audioInstances = [];
const wsSent = [];
const diagLog = [];

class FakeDate extends Date {
  constructor(...args) { if (!args.length) super(fakeNow); else super(...args); }
  static now() { return fakeNow; }
}

function buildSandbox(apiBase) {
  const cache = Cache.create({ now: () => fakeNow });
  const projection = Projection.create({ canonical: cache, now: () => fakeNow });
  const criticalJournal = JournalClient.create(buildCriticalJournalApi());
  let boxAuthorityTransport;
  const sandbox = {
    console, setTimeout, clearTimeout, Date: FakeDate, JSON, Math, Number, String,
    Array, Object, Set, Map, Boolean, RegExp, Promise, Error, isNaN, parseFloat, parseInt,
    TextDecoder, TextEncoder,
    performance: { now: () => fakeNow },
    speakQueue: [], draining: false, isSpeaking: false, speakWatchdog: null,
    ttsAudio: null, currentSpeakPrio: 9, speakGeneration: 0, speakFetchCtrl: null,
    currentSpeakItem: null, voiceOn: true, pwVolume: 1, ttsDisabledUntil: 0,
    autoMicActive: false, autoMicRec: null, jamesAutoMicEnabled: false, jamesMuted: false,
    startAutoMic: () => {}, MAX_RADIO_QUEUE: 2, MAX_SPEAK_QUEUE: 20,
    speakWindowOk: true, speakGateActive: false,
    IMMEDIATE_PIT_KINDS: new Set(['pit_entry', 'limiter_off', 'pit_box_here', 'pit_box_countdown']),
    SPEAK_DEFER_KINDS: new Set(['personal_best', 'session_best', 'first_lap']),
    SPEAK_DEFER_MAX: 1,
    SPEAK_PRIO: { P0_SAFETY: 0, P1_HAZARD: 1, P2_PROCEDURE: 2, P2_CRITICAL: 2, P3_STRATEGY: 3, P4_INFO: 4, P5_CHAT: 5 },
    CHARS: { LunaJP: { gVoice: 'ja-JP-x', gLang: 'ja-JP', gRate: 1, gPitch: 0, voiceLang: 'ja-JP', pitch: 1, rate: 1, voiceNames: [] } },
    sel: 'LunaJP', API_BASE: apiBase,
    isBusy: false, turns: 0, sessionMsgCount: 0, userName: 'Test Driver',
    selMode: 'race', iracingLive: true,
    lastTelemetry: null, lastTelemetryAt: fakeNow, lastTelemetryAuxRef: null,
    lastTrack: 'Monza', lastCarModel: 'fixture-car', lastCarClass: 'GT3',
    lastSessionType: 'Race', lastSessionNum: 0, lastSessionAuthority: null,
    lastIrating: null, lastSr: null, lastSectors: null,
    driverState: null, driverActivity: null,
    fuelWindowWatch: null,
    strategyPlaybookDecisionKeys: new Set(),
    bridgeStrategyDecisions: new Map(),
    strategyResponseOutbox: new Map(),
    strategyDeliveryOutbox: new Map(),
    strategyDeliveryReceipts: new Map(),
    liveStrategyValidation: null,
    canonicalLifecycleCache: cache, strategyProjection: projection,
    // WO015: real desktop/gap-freshness.js, for the real buildGapUtterance()
    // authority-rebuild path inside drainQueue (not re-implemented here).
    PitwallGapFreshness: GapFreshness,
    // WO014 single canonical builder (desktop/race-context-builder.js) — the
    // same module buildCurrentRaceContext() dereferences as
    // globalThis.PitwallRaceContextBuilder in production (renderer.html).
    PitwallRaceContextBuilder: RaceContextBuilder,
    messages: [], MAX_CLIENT_MESSAGES: 40, _msgSeq: 0,
    diagnosticLog: (tag, body) => { diagLog.push({ tag, body }); },
    // WO015: real utteranceTrace()/utteranceTraceFor() (extracted below),
    // not the no-op stub -- the owner vertical's output-to-source backtrack
    // proof reads this same bounded log. UTTERANCE_TRACE_MAX/utteranceTraceLog
    // are top-level `const`/`let` in renderer.html (not `function`, so
    // extract() cannot pull them) -- provided here as real mutable state.
    utteranceTraceLog: [], UTTERANCE_TRACE_MAX: 200,
    criticalJournal,
    isJapaneseEngineer: () => true,
    phonetify: t => t, normalizeLunaSpeech: t => t,
    stripMarkdown: t => t, stripParens: t => t, stripEmoji: t => t, pickVoice: () => null,
    costRecord: () => {}, costReplyId: () => 'cost-1',
    ttsFailLog: () => {}, ttsEventLog: () => {}, usageCount: () => {},
    irBridge: { readyState: 1, send: (raw) => { wsSent.push(JSON.parse(raw)); } },
    usageSessionId: 'wo013-full-route',
    AbortController,
    // /api/tts はfakeTTS（Google TTS未契約）、/api/chatは実childサーバーへ。
    fetch: (url, init) => {
      if (String(url).endsWith('/api/tts')) return new Promise((res) => { ttsResolve = res; });
      return fetch(url, init);
    },
    Audio: class {
      constructor(url) { this.src = url; this.volume = 1; this.onended = null; this.onerror = null; audioInstances.push(this); }
      async play() {}
      pause() { this.paused = true; }
    },
    speechSynthesis: { cancel() {}, speak() {} },
    SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
    // callAPI()の非strategy依存部分（profile/memory/rival等）はすべて中立stub。
    // 実経路の対象はjudgeTransport/NDJSON/applyProposalJudgeTagであり、これらは
    // プロンプト内容を変えるだけで判定ロジックには関与しない。
    hydrateLegacyStrategyObjective: () => null,
    loadProfile: () => ({}),
    buildProfileNote: () => '', buildCarTrackMemory: () => '', buildPracticeProfileNote: () => '',
    buildFuelAuthorityNote: () => '', buildWeekendAuthorityNote: () => '',
    buildCurrentSessionFactNote: () => '', buildSessionEvidenceNote: () => '',
    buildContractNote: () => '', buildActiveRaceFactsNote: () => '',
    buildMemoryStatusNote: () => '', currentMemoryBrainPrompt: () => '',
    buildRaceHistoryContext: () => '', buildNamedRivalNote: () => '',
    updateNamedRivalFromUser: () => {}, forwardDriverDamageReport: () => {},
    applyPitwallAccess: () => {}, hasTelemetryOwnedVehicleClaim: () => false,
    completeMemoryBrainTurn: () => {}, saveMemory: () => {},
    convoLog: () => {}, t: (key) => String(key || ''),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // WO015: real `desktop/box-authority-transport.js` (same module production
  // uses), not a hand-built BOX delivery -- `send`/`revoke` are the only
  // SDK/Audio/UI-boundary stubs (wsSent capture, real speakQueue/finalize
  // callbacks once PRODUCTION is evaluated below).
  boxAuthorityTransport = Box.create({
    canonical: cache, journal: criticalJournal, now: () => fakeNow,
    send: (r) => { wsSent.push(r); },
    revoke: (attemptId) => {
      const removed = sandbox.speakQueue.filter(q => q.boxAttemptId === attemptId);
      sandbox.speakQueue = sandbox.speakQueue.filter(q => q.boxAttemptId !== attemptId);
      removed.forEach(q => sandbox.finalizeUtterance(q, 'dropped_before_audible', null, 'box_authority_revoked'));
      if (sandbox.currentSpeakItem && sandbox.currentSpeakItem.boxAttemptId === attemptId) sandbox.stopCurrentAudio('box_authority_revoked');
    },
  });
  sandbox.boxAuthorityTransport = boxAuthorityTransport;
  sandbox._uttSeq = 0;
  sandbox._convoBox = null;
  sandbox.CONVO_BOX_KEY = 'pw_conversation_box_v1';
  const _store = {};
  sandbox.localStorage = {
    getItem: k => (k in _store ? _store[k] : null),
    setItem: (k, v) => { _store[k] = String(v); },
    removeItem: (k) => { delete _store[k]; },
  };
  sandbox.document = {
    getElementById: () => ({ value: '', style: {}, appendChild(){}, scrollTop:0, scrollHeight:0, classList:{add(){},remove(){},toggle(){}} }),
    createElement: () => ({ textContent:'', className:'', parentNode:null }),
    querySelector: () => null,
  };
  sandbox.pitwall = { overlayPush: () => {} };
  sandbox.__ovlSeq = 0;
  sandbox.mirrorToOverlay = () => 'L' + (++sandbox.__ovlSeq);
  sandbox.conversationSessionKey = () => 'wo013-full-route-session';
  // WO016: real Driver input arbiter + router + the renderer's module-level state they read.
  sandbox.driverInputArbiter = require(path.join(ROOT, 'desktop/driver-input-arbiter.js')).create();
  sandbox.PitwallLocalIntentRouter = require(path.join(ROOT, 'desktop/local-intent-router.js'));
  sandbox.driverInputIdentity = null; sandbox.lastFinishedDriverTurn = null;
  sandbox.lastAdmittedDriverInput = null; sandbox.pttCaptureId = null;
  sandbox.driverPlanCommandOutbox = new Map(); sandbox.pendingCanonicalCommandReadbacks = new Map();
  sandbox.pendingDriverPlanFollowup = null;
  sandbox.crypto = { randomUUID: () => require('crypto').randomUUID() };
  // sendMsg()'s unrelated earlier consumers stay neutral (they only decide whether a
  // different local feature claims the utterance first).
  Object.assign(sandbox, {
    captureConfirmedFuelCapacity() {}, maybeQuietMode() {}, prepareMemoryBrain: () => null,
    pendingConfirmationKinds: () => [], bareConfirmationAnswer: () => null, pendingDrivingStyleAdvice: null,
    handleLunaSelfMemoryInput: () => null, handleReflexDispute: () => false, handleTeamPlanUtterance: () => false,
    handleGapDispute: () => false, handleRelativePaceQuestion: () => false, ensureConversationBox: () => null,
    currentStrategyPlaybook: () => null, loadRaceHistory: () => [], currentMemoryUserId: () => 'wo013-driver',
    currentMemoryIdentity: () => ({}), currentGapHeld: () => null, pendingDecisionDispute: null,
    lastMemoryUtterance: null, recordSetupDeclaration: () => false, answerHistoricalWeatherLocally: () => null,
    evidenceDebrief: null, isManualReviewCommand: () => false, isExplicitMemoryRequest: () => false,
    memorySaveReceipt: '', canPersistMemory: () => false, setMicMeter() {},
  });

  // WO017：会話履歴は実際の本人・race scope helperで積み・取り出す（pushMsg/callAPIの実依存）。
  WO017Scope.install(sandbox);
  vm.createContext(sandbox);
  vm.runInContext(JUDGE_CONSTS, sandbox, { filename: 'renderer.html(consts)' });
  vm.runInContext(WO017Scope.source(src), sandbox, { filename: 'renderer.html(memory-scope)' });
  vm.runInContext(PRODUCTION, sandbox, { filename: 'renderer.html' });
  sandbox.__realApplyProposalJudgeTag = extract('applyProposalJudgeTag');
  sandbox.__realHandleStrategyDeliveryAck = extract('handleStrategyDeliveryAck');
  return { sandbox, cache, projection, boxAuthorityTransport, criticalJournal };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Resolves the mocked /api/tts fetch and lets real playWebSpeech()/Audio.play()
// run (the item becomes real production 'spoken'/audible_started), WITHOUT
// ending it -- the caller decides whether to finish normally or interrupt.
async function startCurrentUtterance(timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!ttsResolve && Date.now() < deadline) await sleep(5);
  if (ttsResolve) {
    ttsResolve({ status: 200, ok: true, json: async () => ({ audioContent: 'A' + audioInstances.length }) });
    ttsResolve = null;
    await sleep(10);
  }
}
async function finishCurrentUtterance(timeoutMs = 2000) {
  await startCurrentUtterance(timeoutMs);
  const audio = audioInstances[audioInstances.length - 1];
  if (audio && typeof audio.onended === 'function') { audio.onended(); await sleep(10); }
}

function spawnServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      ['-r', path.join(ROOT, 'tests-wo001-anthropic-stream-stub-preload.js'), path.join(ROOT, 'server.js')],
      { cwd: ROOT, env: { ...process.env, PORT: String(port), ANTHROPIC_API_KEY: 'sk-test-local-stub',
        DATABASE_URL: '', JWT_SECRET: '', STRIPE_SECRET_KEY: '' } });
    const timer = setTimeout(() => reject(new Error('actual server did not start in time')), 15000);
    child.stdout.on('data', d => { if (d.toString().includes('is running')) { clearTimeout(timer); resolve(child); } });
    child.stderr.on('data', d => process.stderr.write('[actual-server] ' + d));
    child.on('exit', code => { clearTimeout(timer); reject(new Error('actual server exited early: code=' + code)); });
  });
}

(async () => {
  const port = Number(process.argv[2] || 0);
  if (!port) throw new Error('usage: wo013_judge_bridge_fixture.js <serverPort>');
  const serverChild = await spawnServer(port);
  const built = buildSandbox('http://localhost:' + port);
  const { sandbox, cache, boxAuthorityTransport } = built;
  let socketGen = null;
  const inflight = new Map();
  let reqSeq = 0;

  function respond(id, payload) {
    process.stdout.write(JSON.stringify({ id, ...payload }) + '\n');
  }

  async function doResolve(classification, decisionId, holdGateDir) {
    const wsSentBefore = wsSent.length;
    const TAG = '<<PW_JUDGE decision_id="' + decisionId + '" classification="' + classification + '">>';
    const payload = { chunks: ['了解した。\n' + TAG] };
    // ★WO013 r7独立読取差戻し point3：holdGateDirが指定された時だけ、実
    //   server.js子プロセスが消費するstubが実HTTPレスポンスをファイル
    //   barrierで止める。呼び出し側(Python側resolve_start/resolve_await)が
    //   その間に本物のmark_awaiting_judgment／reconnect／canonical_receive
    //   mutationを挟み、releaseするまで本当にcallAPI()は戻らない。
    if (holdGateDir) payload.holdGateDir = holdGateDir;
    const scenario = Buffer.from(JSON.stringify(payload)).toString('base64');
    sandbox.messages = [{ role: 'user', content: 'その提案について判断して ' + stub.MARKER + scenario }];
    const beforeState = sandbox.ensureStrategyState();
    const beforeRevision = beforeState.pending_proposal ? beforeState.pending_proposal.base_revision : null;
    await sandbox.callAPI('typed');
    return {
      wsSentSinceStart: wsSent.slice(wsSentBefore),
      beforeRevision,
      afterState: sandbox.ensureStrategyState(),
      outboxSizeAfterApply: sandbox.strategyResponseOutbox.size,
    };
  }

  async function handleLine(line) {
    const msg = JSON.parse(line);
    const { id, cmd } = msg;
    switch (cmd) {
      case 'init': {
        socketGen = cache.beginSocket();
        cache.hello(socketGen, { type: 'connected', schema_version: 1, bridge_process_epoch: msg.canonicalSnapshot.bridge_process_epoch });
        const ok = cache.receive(msg.canonicalSnapshot, socketGen);
        if (!ok) { respond(id, { ok: false, error: 'invalid_canonical_snapshot' }); return; }
        sandbox.lastSessionNum = msg.canonicalSnapshot.session_num;
        sandbox.lastTelemetry = msg.lastTelemetry || { strategy_options: msg.canonicalSnapshot.recommendations && msg.canonicalSnapshot.recommendations.strategy_options };
        // Same real renderer.html wiring (line ~5156): a successful hello
        // arms the BOX transport for this epoch too, not just the proposal path.
        boxAuthorityTransport.setEpoch(msg.canonicalSnapshot.bridge_process_epoch);
        boxAuthorityTransport.setConnected(true);
        respond(id, { ok: true });
        break;
      }
      case 'box_receive_snapshot': {
        const ok = boxAuthorityTransport.receiveSnapshot(msg.snapshot);
        respond(id, { ok });
        break;
      }
      case 'box_call': {
        const before = wsSent.length;
        sandbox.handleStrategyPlanBoxCall(msg.candidate);
        await sleep(5);
        if (msg.interrupt) {
          // Real speak()/drainQueue()/playWebSpeech() path through to a real
          // 'spoken' item (same production 'audible_started' report as the
          // normal case), THEN a real mid-play interruption instead of a
          // normal onended -- not a hand-built onAudibleInterrupted call.
          await startCurrentUtterance();
          sandbox.stopCurrentAudio(msg.reason || 'test_interrupt');
          await sleep(10);
        } else {
          await finishCurrentUtterance();
        }
        const reports = wsSent.filter(w => w.cmd === 'box_delivery_report');
        respond(id, { ok: true, reportsSinceStart: wsSent.slice(before), reports, wsSent });
        break;
      }
      case 'box_ack_probe': {
        const before = boxAuthorityTransport.outbox.size;
        const epochForReceipt = msg.historical ? msg.ack.payload.bridge_process_epoch : msg.ack.bridge_process_epoch;
        const reportEventIdForReceipt = msg.historical ? msg.ack.payload.report_event_id : msg.ack.report_event_id;
        const applied = msg.historical ? boxAuthorityTransport.historicalAck(msg.ack) : boxAuthorityTransport.ack(msg.ack);
        respond(id, { ok: true, applied, outboxSizeBefore: before, outboxSizeAfter: boxAuthorityTransport.outbox.size,
          outbox: [...boxAuthorityTransport.outbox.values()], attempts: [...boxAuthorityTransport.attempts.values()],
          // Real on-disk journal retirement proof, not just the in-memory
          // transport outbox -- the SAME criticalJournal box_call() wrote
          // box_delivery_report entries into.
          journalPendingReports: sandbox.criticalJournal.entries('box_delivery_report'),
          // WO015 (independent review "BOX owner receipt frozen body/
          // source/role/firstconfirmedtime retention/getter after real ACK
          // SAME VM, not trace getter alone"): the real explicit
          // boxAuthorityTransport.receiptFor() getter, not a re-derivation.
          receipt: boxAuthorityTransport.receiptFor(epochForReceipt, reportEventIdForReceipt) });
        break;
      }
      case 'gap_rebuild_probe': {
        // WO015 (counterexample #1): queues a real self-initiated GAP radio
        // item (candidate gapIdentity), sets real `lastTelemetry` to a
        // DIFFERENT live gap value for the same car/direction (real
        // PitwallGapFreshness.evaluate() -> FATE_REBUILD), lets the real
        // drainQueue()/buildGapUtterance() authority-rebuild step run, and
        // reports the resulting item's actual final text/textHash -- proves
        // textHash tracks the authority-confirmed final body, not the
        // candidate-time one.
        sandbox.lastTelemetry = msg.liveTelemetry;
        sandbox.speak(msg.text, { kind: 'radio', gapIdentity: msg.gapIdentity });
        const item = sandbox.lastQueuedSpeakItem;
        await sleep(5);
        await finishCurrentUtterance();
        respond(id, {
          ok: true,
          finalText: item.text, finalTextHash: item.textHash, utteranceId: item.utteranceId,
          candidateTextHash: sandbox.stableTextHash(msg.text),
        });
        break;
      }
      case 'propose': {
        // WO015: real interrupted/suppressed owner-metadata coverage for the
        // PROPOSAL delivery path, same real speak()/drainQueue()/
        // stopCurrentAudio() production functions box_call already uses --
        // existing callers never pass `interrupt`/`voiceOff`, so the default
        // finishCurrentUtterance() path is unchanged. voiceOff must be set
        // BEFORE handleStrategyPlanProposal() calls speak().
        if (msg.voiceOff) sandbox.voiceOn = false;
        sandbox.handleStrategyPlanProposal(msg.proposal);
        await sleep(5);
        if (msg.voiceOff) {
          // speak()'s !voiceOn branch is synchronous -- no fetch to await.
        } else if (msg.interrupt) {
          await startCurrentUtterance();
          sandbox.stopCurrentAudio(msg.reason || 'test_interrupt');
          await sleep(10);
        } else {
          await finishCurrentUtterance();
        }
        const pendingBefore = sandbox.ensureStrategyState().pending_proposal;
        const audibleSent = wsSent.filter(m => m.cmd === 'strategy_decision_delivery' && m.outcome === 'audible'
          && m.decision_id === msg.proposal.decision_id);
        respond(id, { ok: true, pendingBefore, audibleSent, wsSent });
        break;
      }
      case 'resolve_start': {
        const reqId = 'r' + (++reqSeq);
        inflight.set(reqId, doResolve(msg.classification, msg.decisionId, msg.holdGateDir || null));
        respond(id, { ok: true, requestId: reqId });
        break;
      }
      case 'resolve_await': {
        const p = inflight.get(msg.requestId);
        inflight.delete(msg.requestId);
        if (!p) { respond(id, { ok: false, error: 'unknown_request_id' }); break; }
        const result = await p;
        respond(id, { ok: true, ...result });
        break;
      }
      case 'set_clock': {
        fakeNow = Number(msg.value);
        respond(id, { ok: true, fakeNow });
        break;
      }
      case 'set_voice_on': {
        // 実production変数voiceOnをそのまま切替える（別実装の再現ではない）。
        // speak()本体のif(!voiceOn||!text)分岐が、このitemを一度もaudibleに
        // せずdropped_before_audibleへ直行させる——同じ仕組みを使う。
        sandbox.voiceOn = !!msg.value;
        respond(id, { ok: true, voiceOn: sandbox.voiceOn });
        break;
      }
      case 'mark_awaiting_judgment': {
        // ★WO013 r7独立読取差戻し point1：same_topic入口を「callAPI直呼び」
        //   ではなく、実production経路（desktop/local-intent-router.jsの
        //   routeLegacy()がhandled:falseの発話で呼ぶのと同じ）実関数
        //   currentStrategyStateAPI().markAwaitingJudgment()で駆動する。
        const pending = sandbox.currentStrategyStateAPI().markAwaitingJudgment();
        respond(id, { ok: true, pending });
        break;
      }
      case 'reconnect': {
        // ★WO013 r7独立読取差戻し point3：Bridgeプロセスの再接続（別epoch）
        //   を、実canonicalLifecycleCache.beginSocket()/hello()/receive()の
        //   同じ3手順で再現する——'init'と同じ実関数、別途の手製再実装は
        //   行わない。以後のcanonical_receive/bridge_ackはこの新socketGenを
        //   使う（本物のBridge再接続後と同じクローズ下の状態になる）。
        socketGen = cache.beginSocket();
        const helloOk = cache.hello(socketGen,
          { type: 'connected', schema_version: 1, bridge_process_epoch: msg.snapshot.bridge_process_epoch });
        const receiveOk = helloOk && cache.receive(msg.snapshot, socketGen);
        if (helloOk) { boxAuthorityTransport.setEpoch(msg.snapshot.bridge_process_epoch); boxAuthorityTransport.setConnected(true); }
        respond(id, { ok: helloOk && receiveOk, state: sandbox.ensureStrategyState() });
        break;
      }
      case 'canonical_receive': {
        const ok = cache.receive(msg.snapshot, socketGen);
        respond(id, { ok, state: sandbox.ensureStrategyState() });
        break;
      }
      case 'bridge_ack': {
        const before = wsSent.length;
        sandbox.handleStrategyDecisionAck(msg.ack);
        respond(id, {
          ok: true,
          outboxSizeAfter: sandbox.strategyResponseOutbox.size,
          bridgeDecisionsHasAfter: sandbox.bridgeStrategyDecisions.has(msg.ack.decision_id),
          wsSentDuringAck: wsSent.slice(before),
        });
        break;
      }
      case 'drain_speak_queue': {
        // applyProposalJudgeTag's same_topic path defers doApply() until
        // the chat reply's OWN queued speech item is marked 'spoken' (its
        // onSpoken hook). Call explicitly, AFTER any mid-flight canonical/
        // clock mutations the caller wants baked in first, so ordering is
        // deterministic (not racing the real network await inside
        // resolve_start/resolve_await).
        const before = wsSent.length;
        for (let i = 0; i < 3 && (sandbox.speakQueue.length || sandbox.currentSpeakItem); i++) {
          await finishCurrentUtterance(500);
          await sleep(5);
        }
        respond(id, { ok: true, wsSentDuringDrain: wsSent.slice(before), state: sandbox.ensureStrategyState() });
        break;
      }
      case 'ensure_state': {
        respond(id, {
          ok: true, state: sandbox.ensureStrategyState(), wsSentCount: wsSent.length,
          outboxSize: sandbox.strategyResponseOutbox.size,
        });
        break;
      }
      case 'delivery_ack_probe': {
        // Real same-VM owner-ack readback for the PROPOSAL delivery path
        // (strategy_delivery_ack): the real handleStrategyDeliveryAck()
        // consumer, read back against the real bounded utteranceTrace and
        // the real strategyDeliveryOutbox/bridgeStrategyDecisions state --
        // not a hand-built ACK or a second process/sandbox.
        const pre = sandbox.strategyProposalAudibleCompletedAt(msg.ack.decision_id);
        sandbox.handleStrategyDeliveryAck(msg.ack);
        respond(id, {
          ok: true, pre, post: sandbox.strategyProposalAudibleCompletedAt(msg.ack.decision_id),
          trace: sandbox.utteranceTraceLog, tracked: sandbox.bridgeStrategyDecisions.get(msg.ack.decision_id),
          outbox: [...sandbox.strategyDeliveryOutbox.values()],
          // Bounded frozen original receipt (decisionId/sessionNum/
          // dispatchId/outcome/applied/utteranceId/textHash), via the real
          // explicit getter -- not a re-derivation from the ack we just sent.
          receipt: sandbox.strategyDeliveryReceiptFor(msg.ack.session_num, msg.ack.dispatch_id, msg.ack.outcome),
        });
        break;
      }
      case 'debug_diag': {
        respond(id, { ok: true, diagLog, wsSent });
        break;
      }
      case 'trace_probe': {
        // WO015 (independent review "speechLatencyTrace stillstub ...
        // all-state actualtrace not proven here"): real bounded
        // utteranceTraceFor(), now populated by the REAL speechLatencyTrace()
        // (extracted above, not the no-op stub), for the lifecycle-state
        // lookup/correlation proof.
        respond(id, { ok: true, trace: sandbox.utteranceTraceFor(msg.utteranceId) });
        break;
      }
      case 'isolate_target_delivery_precheck': {
        // ★WO014 GO再開差戻し「WO013後段証拠の途中設計照合」：対象delivery
        //   itemだけを局所隔離する。sandbox.lastQueuedSpeakItem は本物の
        //   speak()/speakReplyChunk()（desktop/renderer.html L3878/L4002/
        //   L4062、どちらも非strict topレベル代入でsandbox自身のプロパティに
        //   なる）がこのreply自身のために積んだ、実applyProposalJudgeTagが
        //   onSpokenを取り付けたのと同じ生きたitemオブジェクト。その1個の
        //   .precheck だけを true 固定へ書き換える——drainQueue／
        //   SPEAK_PRECHECKという仕組み自体・他のどのitemのprecheckも
        //   一切変更しない（上流を全callback/全globalで無効化しない）。
        //   doApply()内のjudgmentBinding再照合（本物のまま）へ実onSpoken
        //   経由で到達できるようにするためだけの、この1itemへの局所的な
        //   テストfixture操作。
        const target = sandbox.lastQueuedSpeakItem;
        if (!target) { respond(id, { ok: false, error: 'no_target_delivery_item' }); break; }
        const hadPrecheck = typeof target.precheck === 'function';
        const alreadyFinalized = target._finalized || null;
        target.precheck = () => true;
        respond(id, { ok: true, hadPrecheck, alreadyFinalized });
        break;
      }
      case 'mutate_cut_binding_check': {
        // Mutation RED/復元: applyProposalJudgeTag の doApply() が
        // judgmentBindingの再照合を一切しない退行版へ一時的に差し替える。
        const mutated = sandbox.__realApplyProposalJudgeTag
          .replace(
            "if(judgmentBinding!==undefined && typeof strategyProjection!=='undefined'\n      && typeof strategyProjection.validBinding==='function' && !strategyProjection.validBinding(judgmentBinding)){",
            "if(false){");
        if (mutated === sandbox.__realApplyProposalJudgeTag) { respond(id, { ok: false, error: 'mutation_pattern_not_found' }); break; }
        vm.runInContext(mutated, sandbox, { filename: 'renderer.html(mutated)' });
        respond(id, { ok: true });
        break;
      }
      case 'mutate_restore': {
        vm.runInContext(sandbox.__realApplyProposalJudgeTag, sandbox, { filename: 'renderer.html(restored)' });
        respond(id, { ok: true });
        break;
      }
      case 'mutate_cut_delivery_ack_metadata_check': {
        // WO015 isolated consumer-cut RED: regress handleStrategyDeliveryAck()
        // to the pre-fix behavior (unconditional _sameUtterance=true, same as
        // the original _bothHaveUtterance-both-sides bug) by replacing ONLY
        // this one line of the REAL extracted source -- not a hand-built
        // input tamper, an actual code-path mutation.
        const mutated = sandbox.__realHandleStrategyDeliveryAck
          .replace(
            'const _sameUtterance=_legacyNoId || (_localHasUtterance && _receipt.utteranceId===data.utterance_id && (_receipt.textHash||null)===(data.text_hash||null));',
            'const _sameUtterance=true;');
        if (mutated === sandbox.__realHandleStrategyDeliveryAck) { respond(id, { ok: false, error: 'mutation_pattern_not_found' }); break; }
        vm.runInContext(mutated, sandbox, { filename: 'renderer.html(mutated)' });
        respond(id, { ok: true });
        break;
      }
      case 'mutate_restore_delivery_ack': {
        vm.runInContext(sandbox.__realHandleStrategyDeliveryAck, sandbox, { filename: 'renderer.html(restored)' });
        respond(id, { ok: true });
        break;
      }
      case 'wo016_superseded_judge': {
        // A judge-carrying reply (real /api/chat judge transport) is in flight, held at the
        // real server via the SDK stub gate; the real WO016 cancel consumer supersedes it.
        // The old judgment must never reach the real applyProposalJudgeTag() consumer.
        const gate = msg.holdGateDir;
        let applyCalls = 0;
        const realApply = sandbox.applyProposalJudgeTag;
        sandbox.applyProposalJudgeTag = function () { applyCalls++; return realApply.apply(this, arguments); };
        const p = doResolve(msg.classification, msg.decisionId, gate);
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(path.join(gate, 'arrived')) && Date.now() < deadline) await sleep(5);
        const diagBefore = diagLog.length;
        const turn = sandbox.driverInputArbiter.currentTurn();
        const cancelled = sandbox.cancelDriverTurn('superseded_urgent');
        // Primary cancel = the turn controller abort, observed synchronously at the cancel call
        // (before any late frame can be read). This is what the 'abort' cut removes.
        const primaryAborted = !!(turn && turn.controller && turn.controller.signal.aborted);
        const isGuard = d => d.tag === 'DRIVER_TURN' && /stale_(chunk|response|completion)_after_cancel/.test(String(d.body));
        let guardIdx = null, abortIdx = null;
        for (let i = 0; i < 600; i++) {   // ≤3s
          if (guardIdx === null && diagLog.slice(diagBefore).some(isGuard)) guardIdx = i;
          if (abortIdx === null && fs.existsSync(path.join(gate, 'provider_aborted'))) abortIdx = i;
          if (abortIdx !== null) break;
          await sleep(5);
        }
        const abortedBeforeRelease = abortIdx !== null;
        fs.writeFileSync(path.join(gate, 'release'), '1');
        // Late frames may reach the Renderer after release too; the liveness guard discards them
        // and its own reader.cancel() may legitimately close the connection.
        const result = await p;
        sandbox.applyProposalJudgeTag = realApply;
        const turnDiag = diagLog.slice(diagBefore).filter(d => d.tag === 'DRIVER_TURN').map(d => String(d.body));
        respond(id, { ok: true, ...result, applyCalls, turnWasLive: !!turn, cancelledTurn: !!cancelled,
          primaryAborted, abortedBeforeRelease,
          // when the provider aborted, was a guard discard already recorded at that moment?
          guardPrecededProviderAbort: abortIdx === null ? null : (guardIdx !== null && guardIdx <= abortIdx),
          providerAborted: fs.existsSync(path.join(gate, 'provider_aborted')),
          guardDiscarded: turnDiag.some(b => /stale_(chunk|response|completion)_after_cancel/.test(b)),
          cancelledCatch: turnDiag.some(b => /^cancelled turn=/.test(b)), turnDiag, isBusy: sandbox.isBusy });
        break;
      }
      case 'wo016_urgent_command_while_busy': {
        // Ordinary Driver turn in flight (held at the real server); the urgent declaration goes
        // through the real sendMsg() → admission → real router → real queueDriverPlanCommand()
        // → real on-disk critical journal → WS envelope.
        const gate = msg.holdGateDir;
        const scenario = Buffer.from(JSON.stringify({ chunks: ['了解、', '継続する。'], holdGateDir: gate, holdAfterChunk: 0 })).toString('base64');
        const before = wsSent.length;
        const p = sandbox.sendMsg('typed', { text: '状況を教えて ' + stub.MARKER + scenario });
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(path.join(gate, 'arrived')) && Date.now() < deadline) await sleep(5);
        const busyBefore = sandbox.isBusy;
        await sandbox.sendMsg('typed', { text: msg.text });
        const abortDeadline = Date.now() + 3000;
        while (!fs.existsSync(path.join(gate, 'provider_aborted')) && Date.now() < abortDeadline) await sleep(5);
        fs.writeFileSync(path.join(gate, 'release'), '1');
        await p;
        const sent = wsSent.slice(before);
        respond(id, { ok: true, busyBefore, envelopes: sent.filter(m => m.cmd === 'driver_plan_command'),
          providerAborted: fs.existsSync(path.join(gate, 'provider_aborted')),
          outboxSize: sandbox.driverPlanCommandOutbox.size, journalHealthy: sandbox.criticalJournal.healthy(),
          oldBodyInHistory: sandbox.messages.some(m => m.role === 'assistant' && String(m.content).includes('継続する')) });
        break;
      }
      case 'wo016_mutate': {
        // Isolated cuts of the two WO016 layers protecting the judge consumer, in the SAME VM:
        //  'abort'  : cancel no longer aborts the turn controller (stream keeps flowing)
        //  'guards' : callAPI's turn-liveness guards always pass
        //  'restore': original product code
        const arbSrc = fs.readFileSync(path.join(ROOT, 'desktop/driver-input-arbiter.js'), 'utf8');
        const loadArb = (s) => { const m = { exports: {} }; vm.runInNewContext(s, { module: m, globalThis: {}, AbortController, Date }); return m.exports; };
        const modes = new Set(msg.modes || []);
        let applied = true;
        const arbCut = arbSrc.replace('try{turn.controller&&turn.controller.abort(turn.cancelReason);}catch(e){}', '');
        if (modes.has('abort') && arbCut === arbSrc) applied = false;
        sandbox.driverInputArbiter = loadArb(modes.has('abort') ? arbCut : arbSrc).create();
        const callSrc = extract('callAPI');
        const callCut = callSrc.replace('const _turnLive=()=>!_turn||driverTurnLive(_turn);', 'const _turnLive=()=>true;');
        if (modes.has('guards') && callCut === callSrc) applied = false;
        vm.runInContext(modes.has('guards') ? callCut : callSrc, sandbox);
        respond(id, { ok: true, applied });
        break;
      }
      case 'driver_plan_ack': {
        sandbox.handleDriverPlanCommandAck(msg.ack);
        respond(id, { ok: true, outboxSize: sandbox.driverPlanCommandOutbox.size,
          readbacksPending: sandbox.pendingCanonicalCommandReadbacks.size });
        break;
      }
      case 'canonical_receive_confirm': {
        // Same as renderer.html: a validated snapshot updates the cache, then canonical sync
        // runs confirmCanonicalCommandReadbacks() (syncCanonicalStrategyProjection tail).
        const okRecv = cache.receive(msg.snapshot, socketGen);
        const traceBefore = sandbox.utteranceTraceLog.length;
        if (okRecv) sandbox.confirmCanonicalCommandReadbacks();
        // one entry per utterance (the trace records several lifecycle states per uid)
        const seen = new Set();
        const spoken = sandbox.utteranceTraceLog.slice(traceBefore)
          .filter(e => e.text && e.state === 'generated' && !seen.has(e.uid) && seen.add(e.uid)).map(e => e.text);
        respond(id, { ok: true, received: okRecv, readbacksPending: sandbox.pendingCanonicalCommandReadbacks.size,
          spokenSince: spoken, assistant: sandbox.messages.filter(m => m.role === 'assistant').map(m => m.content) });
        break;
      }
      case 'shutdown': {
        respond(id, { ok: true });
        serverChild.kill('SIGTERM');
        process.exit(0);
        break;
      }
      default:
        respond(id, { ok: false, error: 'unknown_cmd:' + cmd });
    }
  }

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    handleLine(line).catch(e => {
      let id = null;
      try { id = JSON.parse(line).id; } catch (_e) { /* ignore */ }
      respond(id, { ok: false, error: String((e && e.stack) || e) });
    });
  });
  process.stdout.write(JSON.stringify({ ready: true }) + '\n');
})().catch(e => { console.error(e); process.exitCode = 1; });
