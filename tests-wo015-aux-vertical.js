#!/usr/bin/env node
'use strict';
// WO015 残条件「verifiedaux GAP/position」完成単位 — point C：代表main
// 実callAPI→実ServerSDKstub→realcanonical cache/projection/builder→実
// speakReplyChunk/speak/drainQueue/finalizeUtterance（AudioIOだけneutral
// stub）の縦断を常設する。tests-wo014-actual-vertical.jsのmakeCallApiContext
// （callAPI/buildCurrentRaceContext等の実extraction、real server spawn）と
// tests-wo015-speech-lifecycle.jsのactualAudio（speak/drainQueue/
// finalizeUtterance/onUtteranceDone/stopCurrentAudioの実extraction、Audio
// classだけneutral stub）を一つのcontextへ合成する——どちらの既存fixtureも
// 単独では「実HTTP pre-body gate」と「実queue/Audio完了判定」を同時に
// 持たない。/api/ttsはGoogleTTS未契約のためlocalだけで解決し、/api/chat
// だけが実spawnしたserver.jsへ届く（外部有料API呼び出し0）。
const fs = require('fs');
const WO017Scope = require('./tests-wo017-memory-scope-harness');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const ROOT = __dirname;
const CanonicalCache = require('./desktop/canonical-lifecycle-cache');
const StrategyProjection = require('./desktop/strategy-state-projection');
const RaceContextBuilder = require('./desktop/race-context-builder');
const { fixture: canonicalFixture } = require('./tests-canonical-lifecycle');
const stub = require('./tests-wo001-anthropic-stream-stub-preload.js');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label + (ok ? '' : (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')));
  ok ? pass++ : fail++;
}

const renderer = fs.readFileSync(path.join(ROOT, 'desktop/renderer.html'), 'utf8');
const scripts = [...renderer.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const src = scripts.reduce((a, b) => (a.length > b.length ? a : b));

function grabFn(name, isAsync) {
  const kw = isAsync ? 'async function ' : 'function ';
  const i = src.indexOf(kw + name + '(');
  if (i < 0) return null;
  const rest = src.slice(i);
  const end = rest.slice(1).search(/\n(?:async function |function |const |let |\/\/ ──)/);
  return end < 0 ? null : rest.slice(0, end + 1);
}

function spawnServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      ['-r', path.join(ROOT, 'tests-wo001-anthropic-stream-stub-preload.js'), path.join(ROOT, 'server.js')],
      { cwd: ROOT, env: { ...process.env, PORT: String(port), ANTHROPIC_API_KEY: 'sk-test-local-stub',
        DATABASE_URL: '', JWT_SECRET: '', STRIPE_SECRET_KEY: '' } });
    const timer = setTimeout(() => reject(new Error('actual server did not start in time')), 15000);
    child.stdout.on('data', d => { if (d.toString().includes('is running')) { clearTimeout(timer); resolve(child); } });
    child.stderr.on('data', () => {});
    child.on('exit', code => { clearTimeout(timer); reject(new Error('actual server exited early: code=' + code)); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitForFile(file, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + file);
    await sleep(10);
  }
}

// 実canonical plumbing: fuel 5L/lap 20のPlan A activeは不変のまま、GAP/position
// だけが request時点(2.4/1.2/9/3)から待機中に正当に動き得る値として渡される。
function buildScenario(auxRaw) {
  const snap = canonicalFixture({ frame: 10, decision: 'd-active', lap: 20 });
  snap.continuity.stable_scope = { race_instance_id: snap.race_instance_id, session_num: snap.session_num, driver_id: 7 };
  const cache = CanonicalCache.create({ now: () => 0 });
  const g = cache.beginSocket();
  cache.hello(g, { type: 'connected', schema_version: 1, bridge_process_epoch: snap.bridge_process_epoch });
  if (!cache.receive(snap, g)) throw new Error('fixture rejected');
  const projection = StrategyProjection.create({ canonical: cache, now: () => 0 });
  const auxSourceRef = { bridge_process_epoch: snap.bridge_process_epoch, canonical_snapshot_id: snap.snapshot_id,
    canonical_snapshot_sequence: snap.snapshot_sequence, race_instance_id: snap.race_instance_id,
    session_num: snap.session_num, source_frame_sequence: snap.source_frame.sequence };
  return { snap, cache, g, projection, auxSourceRef };
}

// ── 実main caller (callAPI) + 実speak/drainQueue/finalizeUtterance縦断、
//    AudioIOだけneutral stub。tests-wo014-actual-vertical.jsのmakeCallApi
//    Contextと同じ実extraction/real server port、tests-wo015-speech-
//    lifecycle.jsのactualAudioと同じ実speak/drainQueue/finalizeUtterance/
//    onUtteranceDone/stopCurrentAudio抽出を合成する。────────────────────
function makeAudioCallApiContext(cache, projection, port, auxSourceRef, auxRaw) {
  const box = require('./desktop/conversation-memory-box.js');
  const det = require('./desktop/dispute-detector.js');
  const callApiSrc = grabFn('callAPI', true);
  const liveSrc = grabFn('currentCanonicalStrategyLive', false);
  const buildCtxSrc = grabFn('buildCurrentRaceContext', false);
  const memSrc = ['recordLunaTurn', 'ensureConversationBox', 'saveConversationBox',
    'conversationSessionKey', 'addMsg', 'convoLog'].map(n => grabFn(n, false));
  const judgeTagSrc = grabFn('stripProposalJudgeTag', false);
  const planDependsSrc = grabFn('currentPlanReplyDependsOn', false);
  const auxBlockStart = src.indexOf('function _hasUnqualifiedCurrentNumericMention(text,keywordRe){');
  const auxBlockEnd = src.indexOf('\nasync function callAPI', auxBlockStart);
  const auxBlockSrc = (auxBlockStart >= 0 && auxBlockEnd > auxBlockStart) ? src.slice(auxBlockStart, auxBlockEnd) : null;
  // 実音声縦断（tests-wo015-speech-lifecycle.jsのactualAudioと同じ4関数）。
  const speakSrc = grabFn('speak', false);
  // ★独立review「main実streamed2文がspeak+speakReplyChunk実経路でdistinct
  //   UID/body/hashを持つか未証明」：2文目以降のchunkが通る実speakReplyChunk
  //   も抽出する（従来はspeak/drainQueueのみでspeakReplyChunkは未配線）。
  const speakReplyChunkSrc = grabFn('speakReplyChunk', false);
  const drainQueueSrc = grabFn('drainQueue', true);
  const finalizeSrc = grabFn('finalizeUtterance', false);
  const onDoneSrc = grabFn('onUtteranceDone', false);
  const stopSrc = grabFn('stopCurrentAudio', false);
  // ★IDtrace残条件修復検証：speak()/finalizeUtterance()はID/source/hash/
  //   bounded trace用の実helperを無条件に呼ぶ。
  const deriveSourceSrc = grabFn('deriveUtteranceSource', false);
  const textHashSrc = grabFn('stableTextHash', false);
  const uttTraceSrc = grabFn('utteranceTrace', false);
  const uttTraceForSrc = grabFn('utteranceTraceFor', false);
  // ★WO015残条件「queued/技術started/local audible proxy等の中間stateが
  //   bounded traceへ残らない」修復：以前はspeechLatencyTraceがctx側で
  //   speechLatencyTrace(){}というno-opへ置き換えられており、speak()/
  //   drainQueue()が'queued'/'tts_start'/'play_started'/'discarded'で呼ぶ
  //   実utteranceTrace()畳み込み（renderer.html内のspeechLatencyTrace本体が
  //   自分でutteranceTrace()を呼ぶ）が一度も実行されなかった——'generated'/
  //   'suppressed'以外の状態がこの常設fixtureでは検査不能だった。実
  //   speechLatencyTraceを抽出し、no-op stubをやめる。
  const speechLatencyTraceSrc = grabFn('speechLatencyTrace', false);
  // ★IDtrace残条件修復検証：finalizeUtterance()のdropped_before_audible経路は
  //   item.messageId経由でremoveMessageById()を呼ぶ（desktop/renderer.html
  //   ~1278）。pushMsg()自身もこのテストのcustom stubではなく実関数を使い、
  //   同じ_mid契約・同じmessages配列操作であることを保証する。
  const pushMsgSrc = grabFn('pushMsg', false);
  const removeMsgSrc = grabFn('removeMessageById', false);
  const need = { callApiSrc, liveSrc, buildCtxSrc, memSrc: memSrc.every(Boolean), judgeTagSrc, planDependsSrc,
    auxBlockSrc, speakSrc, speakReplyChunkSrc, drainQueueSrc, finalizeSrc, onDoneSrc, stopSrc, pushMsgSrc, removeMsgSrc,
    deriveSourceSrc, textHashSrc, uttTraceSrc, uttTraceForSrc, speechLatencyTraceSrc };
  if (Object.values(need).some(v => !v)) throw new Error('extraction failed: ' + JSON.stringify(need));
  const judgeConstDecl = (src.match(/const PW_JUDGE_TAG_START = [\s\S]*?;/) || [''])[0]
    + '\n' + (src.match(/const PW_JUDGE_TAG_RE = [\s\S]*?;/) || [''])[0];
  const decls = (src.match(/const CONVO_BOX_KEY='[^']+';/) || [''])[0]
    + '\n' + (src.match(/let _convoBox=null;/) || [''])[0];
  const store = {};
  const costs = [];
  const audioInstances = [];
  let ttsResolve = null;
  const ctx = {
    TextDecoder, TextEncoder, AbortController, setTimeout, clearTimeout,
    Date, JSON, Math, String, Number, Error, RegExp, Promise, console, Map, Set,
    performance: { now: () => Date.now() },
    window: { PitwallConversationMemoryBox: box, PitwallDisputeDetector: det, PitwallReflexEvents: null },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: { getElementById: () => ({ value: '', style: {}, appendChild(){}, scrollTop:0, scrollHeight:0, classList:{add(){},remove(){},toggle(){}} }),
      createElement: () => ({ className: '', textContent: '' }) },
    usageCount(){}, applyPitwallAccess(){}, costApiCall(){},
    costRecord: (outcome, detail) => costs.push({ outcome, detail }),
    diagnosticLog(){}, mirrorToOverlay(){}, flushSentences(){}, t: (k) => String(k),
    forwardDriverDamageReport(){}, hydrateLegacyStrategyObjective: () => ({}),
    loadProfile: () => ({}), buildProfileNote: () => '', buildCarTrackMemory: () => '',
    buildPracticeProfileNote: () => '', buildFuelAuthorityNote: () => '',
    buildWeekendAuthorityNote: () => '', buildCurrentSessionFactNote: () => '',
    buildSessionEvidenceNote: () => '', buildContractNote: () => '',
    buildActiveRaceFactsNote: () => '', buildMemoryStatusNote: () => '',
    currentMemoryBrainPrompt: () => '', completeMemoryBrainTurn: () => null,
    buildRaceHistoryContext: () => '', buildNamedRivalNote: () => '',
    hasTelemetryOwnedVehicleClaim: () => false, normalizeLunaSpeech: (t) => t,
    applyProposalJudgeTag: () => {}, currentStrategyStateAPI: () => null,
    canonicalLifecycleCache: cache, strategyProjection: projection,
    lastTelemetryAuxRef: auxSourceRef, lastTelemetry: Object.assign({}, auxRaw),
    PitwallRaceContextBuilder: RaceContextBuilder,
    lastQueuedSpeakItem: null, currentSpeakItem: null, _msgSeq: 0, MAX_CLIENT_MESSAGES: 60,
    utteranceTraceLog: [], UTTERANCE_TRACE_MAX: 200,
    sel: 'LunaJP', selMode: 'race', userName: 'Yuji', messages: [],
    turns: 0, sessionMsgCount: 0, isBusy: false,
    iracingLive: true, bridgeConnected: true, lastTelemetryAt: Date.now(),
    lastSessionType: 'Race', lastSessionAuthority: null, lastCarClass: 'GT3',
    lastCarModel: 'AMG', lastTrack: 'Le Mans', lastSessionNum: 9,
    driverState: 'track', driverActivity: 'ACTIVE',
    API_BASE: '', usageBuild: 'test', usageSessionId: 's',
    currentMemoryUserId: () => 'Yuji', memorySavedThisSession: true, evidenceDebrief: null,
    responseIntent: null, responseAuthority: 'llm',
    SPEAK_PRIO: { P0_SAFETY: 0, P1_HAZARD: 1, P2_PROCEDURE: 2, P3_STRATEGY: 3, P4_INFO: 4 },
    jamesAutoMicEnabled: false, jamesMuted: false, updateNamedRivalFromUser: () => null, lastSectors: () => null,
    // ── 実speak/drainQueue/finalizeUtterance/onUtteranceDone/stopCurrentAudio
    //    が読み書きするmodule変数（本物のrenderer.html同様、全てtopレベル）。
    voiceOn: true, nextUtteranceId: () => 'wo015v-' + (++ctx._msgSeq), speakQueue: [],
    CHARS: { LunaJP: { gVoice: 'ja-JP-x', gLang: 'ja-JP', gRate: 1, gPitch: 0, voiceLang: 'ja-JP', pitch: 1, rate: 1, voiceNames: [] } },
    IMMEDIATE_PIT_KINDS: new Set(), MAX_RADIO_QUEUE: 2, MAX_SPEAK_QUEUE: 20,
    currentSpeakPrio: 9, isSpeaking: false, draining: false,
    speakGateActive: false, speakWindowOk: true, speakGeneration: 0, autoMicActive: false, autoMicRec: null,
    shouldDeferSpeak: () => false, deferSpeakItem: () => false,
    currentGapAuthority: () => null, ttsAudio: null, speakFetchCtrl: null, speakWatchdog: null, ttsDisabledUntil: 0,
    phonetify: x => x, stripMarkdown: x => x, stripParens: x => x, stripEmoji: x => x,
    ttsFailLog(){}, ttsEventLog(){}, pwVolume: 1, getDeviceId: () => 'test',
    speechSynthesis: { cancel(){}, speak(){} }, irBridge: null,
    // AudioIOだけがneutral stub——play()/onendedを手動制御する（実音声品質の
    // 証明ではない、既存WO015 G1/G2と同じ機械proxy粒度）。
    Audio: class { constructor(url) { this.src = url; this.volume = 1; this.onended = null; this.onerror = null; audioInstances.push(this); ctx.testAudio = this; } async play() {} pause() { this.paused = true; } },
    // /api/ttsはGoogleTTS未契約のためlocalだけで解決（外部有料API呼び出し0）、
    // /api/chatだけ実spawnしたserver.jsへ届く。
    fetch: (url, init) => {
      if (String(url).endsWith('/api/tts')) return new Promise(r => { ttsResolve = r; });
      return fetch('http://localhost:' + port + url, init);
    },
  };
  ctx.globalThis = ctx; ctx.window.localStorage = ctx.localStorage;
  WO017Scope.install(ctx); vm.createContext(ctx);
  vm.runInContext(decls + '\n' + judgeConstDecl + '\n' + judgeTagSrc + '\n' + planDependsSrc + '\n' + auxBlockSrc
    + '\n' + speechLatencyTraceSrc
    + '\n' + liveSrc + '\n' + buildCtxSrc + '\n' + WO017Scope.source(src) + memSrc.join('\n') + '\n' + pushMsgSrc + '\n' + removeMsgSrc + '\n' + callApiSrc
    + '\n' + deriveSourceSrc + '\n' + textHashSrc + '\n' + uttTraceSrc + '\n' + uttTraceForSrc
    + '\n' + speakSrc + '\n' + speakReplyChunkSrc + '\n' + drainQueueSrc + '\n' + finalizeSrc + '\n' + onDoneSrc + '\n' + stopSrc
    + '\nthis.callAPI = callAPI; this.speak = speak; this.speakReplyChunk = speakReplyChunk; this.drainQueue = drainQueue;', ctx);
  async function finishCurrentUtterance(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!ttsResolve && Date.now() < deadline) await sleep(5);
    if (ttsResolve) {
      ttsResolve({ ok: true, status: 200, json: async () => ({ audioContent: 'A' + audioInstances.length }) });
      ttsResolve = null;
      await sleep(15);
    }
    const audio = audioInstances[audioInstances.length - 1];
    if (audio && typeof audio.onended === 'function') { audio.onended(); await sleep(15); }
  }
  return { ctx, costs, audioInstances, finishCurrentUtterance };
}

// ── 実auto代表 (scheduleAutoBriefing) + 実speak/drainQueue/finalizeUtterance
//    縦断、AudioIOだけneutral stub。makeBriefingContext（tests-wo014-actual-
//    vertical.js）と同じ実extraction/real server port、実queue縦断はmakeAudio
//    CallApiContextと同じ4関数を合成する。────────────────────────────────
function makeAudioBriefingContext(cache, projection, port, auxSourceRef, auxRaw) {
  const briefingSrc = (renderer.match(/async function scheduleAutoBriefing\(\)\{[\s\S]*?\n\}/) || [null])[0];
  const liveSrc = grabFn('currentCanonicalStrategyLive', false);
  const buildCtxSrc = grabFn('buildCurrentRaceContext', false);
  const auxBlockStart = src.indexOf('function _hasUnqualifiedCurrentNumericMention(text,keywordRe){');
  const auxBlockEnd = src.indexOf('\nasync function callAPI', auxBlockStart);
  const auxBlockSrc = (auxBlockStart >= 0 && auxBlockEnd > auxBlockStart) ? src.slice(auxBlockStart, auxBlockEnd) : null;
  const speakSrc = grabFn('speak', false);
  const drainQueueSrc = grabFn('drainQueue', true);
  const finalizeSrc = grabFn('finalizeUtterance', false);
  const onDoneSrc = grabFn('onUtteranceDone', false);
  const stopSrc = grabFn('stopCurrentAudio', false);
  const deriveSourceSrc = grabFn('deriveUtteranceSource', false);
  const textHashSrc = grabFn('stableTextHash', false);
  const uttTraceSrc = grabFn('utteranceTrace', false);
  const uttTraceForSrc = grabFn('utteranceTraceFor', false);
  // ★WO015残条件（item4「auto代表もspeechLatencyTrace noopでは中間state
  //   を検査できない」）：makeAudioCallApiContextと同じ修復をauto代表側にも
  //   適用する。
  const speechLatencyTraceSrc = grabFn('speechLatencyTrace', false);
  const need = { briefingSrc, liveSrc, buildCtxSrc, auxBlockSrc, speakSrc, drainQueueSrc, finalizeSrc, onDoneSrc, stopSrc,
    deriveSourceSrc, textHashSrc, uttTraceSrc, uttTraceForSrc, speechLatencyTraceSrc };
  if (Object.values(need).some(v => !v)) throw new Error('extraction failed: ' + JSON.stringify(need));
  const costs = [];
  const audioInstances = [];
  let ttsResolve = null;
  const ctx = {
    selMode: 'strategy', sel: 'LunaJP', userName: 'Yuji', iracingLive: true, bridgeConnected: true,
    lastTelemetryAuxRef: auxSourceRef, lastTelemetry: Object.assign({}, auxRaw), lastSessionType: 'Race', lastSessionAuthority: null,
    driverState: 'track', driverActivity: 'driving', lastCarClass: 'GT3', lastCarModel: 'AMG', usageSessionId: 'u1',
    localStorage: { getItem: () => null }, applyPitwallAccess: () => {}, usageCount: () => {},
    diagnosticLog: () => {}, addMsg: (who, text) => { ctx.messages.push({ role: who === 'ai' ? 'assistant' : 'user', content: text }); }, pushMsg: () => null,
    messages: [],
    SPEAK_PRIO: { P0_SAFETY: 0, P1_HAZARD: 1, P2_PROCEDURE: 2, P3_STRATEGY: 3, P4_INFO: 4 }, AbortController, API_BASE: '',
    setTimeout: (fn, delay) => {
      if (delay === 6000) { ctx._briefingDone = fn(); return 0; }
      return global.setTimeout(fn, delay);
    },
    clearTimeout: (id) => global.clearTimeout(id),
    canonicalLifecycleCache: cache,
    PitwallRaceContextBuilder: RaceContextBuilder,
    strategyProjection: projection,
    loadProfile: () => ({}), buildPreviousRaceBriefingNote: () => '',
    currentMemoryIdentity: () => ({}), loadRaceHistory: () => [], noteMemoryUtterance: () => {},
    pullDecisionsFromServer: async () => {}, decisionBriefingSelection: () => ({ available: false }),
    decisionPlanAdvice: () => ({ action: 'none', fate: 'skip', reply: null }),
    setupComparisonForBriefing: () => ({ available: false }), driverAddressName: () => 'Driver',
    buildProfileNote: () => '', buildCarTrackMemory: () => '', buildFuelAuthorityNote: () => '',
    buildWeekendAuthorityNote: () => '', buildContractNote: () => '', buildActiveRaceFactsNote: () => '',
    buildRaceHistoryContext: () => '',
    TextDecoder, TextEncoder, Date, JSON, Math, String, Number, Error, RegExp, Promise, console, Map, Set,
    performance: { now: () => Date.now() },
    costRecord: (outcome, detail) => costs.push({ outcome, detail }),
    voiceOn: true, nextUtteranceId: () => 'wo015av-b-' + Math.random(), speakQueue: [], lastQueuedSpeakItem: null, currentSpeakItem: null,
    utteranceTraceLog: [], UTTERANCE_TRACE_MAX: 200,
    jamesAutoMicEnabled: false, jamesMuted: false,
    CHARS: { LunaJP: { gVoice: 'ja-JP-x', gLang: 'ja-JP', gRate: 1, gPitch: 0, voiceLang: 'ja-JP', pitch: 1, rate: 1, voiceNames: [] } },
    IMMEDIATE_PIT_KINDS: new Set(), MAX_RADIO_QUEUE: 2, MAX_SPEAK_QUEUE: 20,
    currentSpeakPrio: 9, isSpeaking: false, draining: false,
    speakGateActive: false, speakWindowOk: true, speakGeneration: 0, autoMicActive: false, autoMicRec: null,
    shouldDeferSpeak: () => false, deferSpeakItem: () => false,
    currentGapAuthority: () => null, ttsAudio: null, speakFetchCtrl: null, speakWatchdog: null, ttsDisabledUntil: 0,
    phonetify: x => x, normalizeLunaSpeech: x => x, stripMarkdown: x => x, stripParens: x => x, stripEmoji: x => x,
    ttsFailLog(){}, ttsEventLog(){}, pwVolume: 1, getDeviceId: () => 'test',
    speechSynthesis: { cancel(){}, speak(){} }, irBridge: null,
    Audio: class { constructor(url) { this.src = url; this.volume = 1; this.onended = null; this.onerror = null; audioInstances.push(this); ctx.testAudio = this; } async play() {} pause() { this.paused = true; } },
    fetch: (url, init) => {
      if (String(url).endsWith('/api/tts')) return new Promise(r => { ttsResolve = r; });
      return fetch('http://localhost:' + port + url, init);
    },
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  WO017Scope.install(ctx); vm.createContext(ctx);
  vm.runInContext(liveSrc + '\n' + buildCtxSrc + '\n' + auxBlockSrc + '\n' + speechLatencyTraceSrc
    + '\n' + deriveSourceSrc + '\n' + textHashSrc + '\n' + uttTraceSrc + '\n' + uttTraceForSrc
    + '\n' + speakSrc + '\n' + drainQueueSrc + '\n' + finalizeSrc + '\n' + onDoneSrc + '\n' + stopSrc
    + '\n' + briefingSrc + '\nthis.scheduleAutoBriefing = scheduleAutoBriefing; this.speak = speak; this.drainQueue = drainQueue;', ctx);
  async function finishCurrentUtterance(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!ttsResolve && Date.now() < deadline) await sleep(5);
    if (ttsResolve) {
      ttsResolve({ ok: true, status: 200, json: async () => ({ audioContent: 'A' + audioInstances.length }) });
      ttsResolve = null;
      await sleep(15);
    }
    const audio = audioInstances[audioInstances.length - 1];
    if (audio && typeof audio.onended === 'function') { audio.onended(); await sleep(15); }
  }
  return { ctx, costs, audioInstances, finishCurrentUtterance };
}

async function main() {
  const port = 35300 + Math.floor(Math.random() * 500);
  const server = await spawnServer(port);
  try {
    // ── Case V1: 正当なGAP-only追記返信（前とのギャップ2.4秒）が**実canonical
    //    fuel更新**（tests-wo014-actual-vertical.js case5と同じ「ordinary
    //    next-poll-frame」mutation、cache.receive()で本当にfuel_level_lを
    //    5→4.2へ進める）では破棄されず、GAP自体driftでは破棄される正負対。
    //    独立指摘により訂正：以前はObject.assign({},{})で実際には何も変えて
    //    いなかった（正常control証拠としてのみ扱い、fuel-unrelated-drift
    //    免除の実証ではなかった）。────────────────────────────────────
    {
      const auxRaw0 = { gap_ahead: 2.4, gap_behind: 1.2, pos: 9, class_pos: 3 };
      const { cache, g, projection, auxSourceRef } = buildScenario(auxRaw0);
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo015av-v1-'));
      const { ctx, costs, finishCurrentUtterance } = makeAudioCallApiContext(cache, projection, port, auxSourceRef, auxRaw0);
      // pre-body gate: 空白chunk→hold0（GAP更新はこの間に行う）→本文。
      const scenario = Buffer.from(JSON.stringify({ chunks: [' ', '現在の前とのギャップは2.4秒。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: '状況を教えて ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'));
      // 実canonical cacheへ本当にordinary next-poll-frame mutationを適用する
      // （tests-wo014-actual-vertical.js case5と同じ形：frame+time+fuel+bf
      // stampsを揃えて現在fuel_level_lを実際に5→4.2へ動かす）。GAP/position
      // （lastTelemetry）は不変のまま——「GAP-onlyは無関係な実fuel driftで
      // 破棄されない」ことをObject.assign({},{})のような無changeではなく、
      // 本物のcanonical更新で証明する。
      const ordinary = JSON.parse(JSON.stringify(cache.current()));
      ordinary.snapshot_sequence++; ordinary.snapshot_id = ordinary.bridge_process_epoch + ':' + ordinary.snapshot_sequence;
      ordinary.source_frame.sequence += 1; ordinary.source_frame.session_time_s += 1;
      ordinary.race_facts.source_frame.sequence = ordinary.source_frame.sequence;
      ordinary.race_facts.source_frame.session_time_s = ordinary.source_frame.session_time_s;
      ordinary.race_facts.black_flag.observed_session_time = ordinary.source_frame.session_time_s;
      ordinary.race_facts.black_flag.source_frame_sequence = ordinary.source_frame.sequence;
      ordinary.current_facts.source_frame.sequence = ordinary.source_frame.sequence;
      ordinary.current_facts.source_frame.session_time_s = ordinary.source_frame.session_time_s;
      ordinary.current_facts.fuel_level_l = 4.2;
      ordinary.finish.source_frame_sequence = ordinary.source_frame.sequence;
      check('V1 setup: 実canonical fuel更新(5→4.2)がcache.receive()で受理される', cache.receive(ordinary, g));
      // 本物のBridgeは新しいcanonical frameと同じtickでtelemetry(aux)参照も
      // 一緒に進める——canonical frameだけ進めてlastTelemetryAuxRefを古い
      // frame識別子のまま放置すると、GAP値自体は不変でもauxCorrelatedが
      // 偽物のfalseになり(race-context-builder.jsのsource_frame_sequence
      // 等一致チェック)、テスト設計自体の欠陥で誤ってfail-closedする。
      // 同じGAP/position実値のまま、新frameへ正しく再相関させる。
      ctx.lastTelemetryAuxRef = { bridge_process_epoch: ordinary.bridge_process_epoch,
        canonical_snapshot_id: ordinary.snapshot_id, canonical_snapshot_sequence: ordinary.snapshot_sequence,
        race_instance_id: ordinary.race_instance_id, session_num: ordinary.session_num,
        source_frame_sequence: ordinary.source_frame.sequence };
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      await finishCurrentUtterance();
      check('V1 GREEN: GAP-only返信は**実**fuel drift(5→4.2)を生き残り、実音声completedに届く',
        costs.some(c => c.outcome === 'completed'), costs);
      check('V1: 実assistant historyにも本文が残る', ctx.messages.some(m => m.role === 'assistant' && /前とのギャップ/.test(m.content)), ctx.messages);
      // ★WO015残条件（item3/4「generated以外の中間stateがbounded traceへ
      //   残らない」）：speechLatencyTrace実体を配線した直接証明。noop stub
      //   のままならqueued/tts_start/play_startedは一切記録されず、
      //   completedはfinalizeUtterance直呼びの1件しか残らなかった。
      {
        const completedUid = [...ctx.utteranceTraceLog].reverse().find(e => e.state === 'completed')?.uid;
        check('V1: bounded utteranceTraceが同一uidでqueued/tts_start/play_started/completedを実記録する（speechLatencyTrace noop修復の直接証明）',
          !!completedUid && ['queued', 'tts_start', 'play_started', 'completed'].every(st =>
            ctx.utteranceTraceLog.some(e => e.uid === completedUid && e.state === st)),
          ctx.utteranceTraceLog);
      }
      void g;
    }

    // ── Case V2: 同じGAP-only返信、待機中にGAP自体が2.4→1.1へdrift（正当な
    //    新frame、canonical/fuel/lapは不変）——discard側。────────────────
    {
      const auxRaw0 = { gap_ahead: 2.4, gap_behind: 1.2, pos: 9, class_pos: 3 };
      const { cache, g, projection, auxSourceRef } = buildScenario(auxRaw0);
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo015av-v2-'));
      const { ctx, costs, finishCurrentUtterance } = makeAudioCallApiContext(cache, projection, port, auxSourceRef, auxRaw0);
      const scenario = Buffer.from(JSON.stringify({ chunks: [' ', '現在の前とのギャップは2.4秒。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: '状況を教えて ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'));
      // 正当な新telemetry frame: 同じcanonical(fuel/lap/plan)のまま、GAPだけ
      // 2.4→1.1へ動く（lastTelemetryAuxRefは同じ相関canonical snapshotを
      // 指したまま——Bridge telemetryが数秒ごとに更新するのと同じ形）。
      ctx.lastTelemetry = Object.assign({}, ctx.lastTelemetry, { gap_ahead: 1.1 });
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      await finishCurrentUtterance(600);
      check('V2 RED-condition（期待どおりの正常discard）: GAP自体のdrift後は旧2.4秒が実音声completedに届かない',
        !costs.some(c => c.outcome === 'completed'), costs);
      check('V2: 実precheckがdequeue時点でdiscardした（costs outcomeにdiscarded/queued、completedは無い）',
        costs.some(c => c.outcome === 'discarded' || c.outcome === 'queued'), costs);
      check('V2: 実assistant historyにも旧2.4秒本文は残らない', !ctx.messages.some(m => m.role === 'assistant' && /2\.4秒/.test(m.content)), ctx.messages);
      void g;
    }

    // ── Case V3: 同じ正負をposition（総合順位9→8）でも一対確認。──────────
    {
      const auxRaw0 = { gap_ahead: 2.4, gap_behind: 1.2, pos: 9, class_pos: 3 };
      const { cache, g, projection, auxSourceRef } = buildScenario(auxRaw0);
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo015av-v3-'));
      const { ctx, costs, finishCurrentUtterance } = makeAudioCallApiContext(cache, projection, port, auxSourceRef, auxRaw0);
      const scenario = Buffer.from(JSON.stringify({ chunks: [' ', '現在の総合順位は9番手。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: '状況を教えて ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'));
      ctx.lastTelemetry = Object.assign({}, ctx.lastTelemetry, { pos: 8 });
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      await finishCurrentUtterance(600);
      check('V3 position9→8: 旧総合順位9番手は実音声completedに届かない', !costs.some(c => c.outcome === 'completed'), costs);
      void g;
    }
    {
      const auxRaw0 = { gap_ahead: 2.4, gap_behind: 1.2, pos: 9, class_pos: 3 };
      const { cache, g, projection, auxSourceRef } = buildScenario(auxRaw0);
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo015av-v3c-'));
      const { ctx, costs, finishCurrentUtterance } = makeAudioCallApiContext(cache, projection, port, auxSourceRef, auxRaw0);
      const scenario = Buffer.from(JSON.stringify({ chunks: [' ', '現在の総合順位は9番手。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: '状況を教えて ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'));
      // control: classだけdrift（無関係）、position(総合)は不変——生き残る。
      ctx.lastTelemetry = Object.assign({}, ctx.lastTelemetry, { class_pos: 2 });
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      await finishCurrentUtterance();
      check('V3 control: explicit総合順位はclass順位driftだけでは破棄されず実音声completedに届く',
        costs.some(c => c.outcome === 'completed'), costs);
      void g;
    }

    // ── Case V4: guard RED/GREEN — V2/V3で実際にstale GAPを止めているのは
    //    mid-loop早期中断（lagが1chunk分あり、この2chunkシナリオでは発動
    //    しない——独立反証で確認）ではなく、この返信文自身をspeak()へ渡す
    //    precheckクロージャそのもの。この1箇所だけをneutralizeし（対象一個
    //    だけ隔離）、mid-loop/最終reply fence等の上流は無改変のまま、この
    //    precheckが実際にload-bearingであることを示す。───────────────────
    {
      const auxRaw0 = { gap_ahead: 2.4, gap_behind: 1.2, pos: 9, class_pos: 3 };
      const { cache, g, projection, auxSourceRef } = buildScenario(auxRaw0);
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo015av-v4-'));
      const callApiSrc = grabFn('callAPI', true);
      const mutatedCallApiSrc = callApiSrc.replace(
        "precheck:()=>strategyReplyBindingValid(_b,sentence,_replyAuxAtRequest)",
        "precheck:()=>true");
      check('V4 RED setup: 返信sentence speak()のprecheck line見つかり除去できる（対象一個だけ隔離、mid-loop/最終replyは無改変）',
        mutatedCallApiSrc !== callApiSrc);
      const { ctx, costs, finishCurrentUtterance } = makeAudioCallApiContext(cache, projection, port, auxSourceRef, auxRaw0);
      // 上流（_finalReplyBinding最終fence）はintactのまま維持し、mid-loop
      // 一箇所だけをRED対象として差し替える（Tunnel Completion Rule：対象
      // 一個だけ・上流intact control併記）。
      vm.runInContext(mutatedCallApiSrc + '\nthis.callAPI = callAPI;', ctx);
      const scenario = Buffer.from(JSON.stringify({ chunks: [' ', '現在の前とのギャップは2.4秒。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: '状況を教えて ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'));
      ctx.lastTelemetry = Object.assign({}, ctx.lastTelemetry, { gap_ahead: 1.1 });
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      await finishCurrentUtterance();
      check('V4 RED: 返信speak()のprecheck除去後は旧2.4秒が実音声completedへ届く（このguardがload-bearingの証明、製品は未改変）',
        costs.some(c => c.outcome === 'completed'), costs);
      void g;
    }

    // ── Case V5: 純過去・無関係一般論はGAP自体のdriftでも生き残る（既存
    //    ordinary sequence/pure-past契約の縦断版）。────────────────────────
    {
      const auxRaw0 = { gap_ahead: 2.4, gap_behind: 1.2, pos: 9, class_pos: 3 };
      const { cache, g, projection, auxSourceRef } = buildScenario(auxRaw0);
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo015av-v5-'));
      const { ctx, costs, finishCurrentUtterance } = makeAudioCallApiContext(cache, projection, port, auxSourceRef, auxRaw0);
      const scenario = Buffer.from(JSON.stringify({ chunks: [' ', '前回のギャップは2.4秒だった。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: '前回はどうだった？ ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'));
      ctx.lastTelemetry = Object.assign({}, ctx.lastTelemetry, { gap_ahead: 1.1 });
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      await finishCurrentUtterance();
      check('V5: 純過去のGAP主張は現在GAP driftでも実音声completedに届く（既存ordinary/pure-past契約を壊さない）',
        costs.some(c => c.outcome === 'completed'), costs);
      void g;
    }
    // ── Case V6（auto代表）: scheduleAutoBriefingも実speak/drainQueue/
    //    finalizeUtteranceへ通し、GAP-only briefingがGAP自体のdriftで
    //    discardされ、無関係driftでは生き残ることを確認する。────────────
    {
      const auxRaw0 = { gap_ahead: 2.4, gap_behind: 1.2, pos: 9, class_pos: 3 };
      const { cache, g, projection, auxSourceRef } = buildScenario(auxRaw0);
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo015av-v6-'));
      const { ctx, costs, finishCurrentUtterance } = makeAudioBriefingContext(cache, projection, port, auxSourceRef, auxRaw0);
      ctx.buildPreviousRaceBriefingNote = () => stub.MARKER
        + Buffer.from(JSON.stringify({ chunks: ['現在の前とのギャップは2.4秒。'], holdGateDir: gateDir, holdAfterChunk: null })).toString('base64');
      await ctx.scheduleAutoBriefing();
      await waitForFile(path.join(gateDir, 'arrived'));
      // 待機中にGAP自体が2.4->1.1へ正当にdrift（canonical/fuel/lapは不変）。
      ctx.lastTelemetry = Object.assign({}, ctx.lastTelemetry, { gap_ahead: 1.1 });
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await ctx._briefingDone;
      await finishCurrentUtterance(600);
      check('V6 auto代表: GAP自体のdrift後は旧2.4秒briefingが実音声completedに届かない',
        !costs.some(c => c.outcome === 'completed'), costs);
      void g;
    }
    {
      const auxRaw0 = { gap_ahead: 2.4, gap_behind: 1.2, pos: 9, class_pos: 3 };
      const { cache, g, projection, auxSourceRef } = buildScenario(auxRaw0);
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo015av-v6c-'));
      const { ctx, costs, finishCurrentUtterance } = makeAudioBriefingContext(cache, projection, port, auxSourceRef, auxRaw0);
      ctx.buildPreviousRaceBriefingNote = () => stub.MARKER
        + Buffer.from(JSON.stringify({ chunks: ['現在の前とのギャップは2.4秒。'], holdGateDir: gateDir, holdAfterChunk: null })).toString('base64');
      await ctx.scheduleAutoBriefing();
      await waitForFile(path.join(gateDir, 'arrived'));
      // control: 無関係なposition driftだけ——GAP(前)は不変、生き残る。
      ctx.lastTelemetry = Object.assign({}, ctx.lastTelemetry, { pos: 8 });
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await ctx._briefingDone;
      await finishCurrentUtterance();
      check('V6 control: 無関係なposition driftだけではGAP-only briefingは破棄されず実音声completedに届く',
        costs.some(c => c.outcome === 'completed'), costs);
      // ★独立review「auto代表はexact本文/sourceを未証明」修復：completedした
      // 終端entryが実際にこのbriefing本文そのもの（候補生成時と同一hash/
      // kind/role）を保持することを、trace経由で直接確認する——completed
      // outcomeのscalarだけで「本文も正しい」とは主張しない。
      {
        const completed = ctx.utteranceTraceLog.filter(e => e.state === 'completed');
        check('V6 control: auto代表のcompleted終端entryが実本文(前とのギャップ2.4秒)・kind・roleを保持する',
          completed.length === 1 && completed[0].text.includes('前とのギャップは2.4秒')
          && typeof completed[0].kind === 'string' && !!completed[0].role, completed);
        const generated = ctx.utteranceTraceLog.find(e => e.state === 'generated');
        check('V6 control: auto代表のgenerated(元候補)とcompleted(最終)は同一utteranceId・同一本文(GAP不変時は再構築されない)',
          generated && completed[0] && generated.uid === completed[0].uid && generated.text === completed[0].text,
          { generated, completed });
      }
      void g;
    }
    // ── Case V6b（auto代表、suppressed）: 同じauto経路でvoiceOn=falseの時、
    //    API呼出・queue投入は一切せずsuppressed_by_userとして確定し、本文/
    //    IDはそれでも実trace（generated→suppressed）へ残ることを確認する
    //    （既存V6正常/drift対とは別のoutcome分岐）。────────────────────
    {
      const auxRaw0 = { gap_ahead: 2.4, gap_behind: 1.2, pos: 9, class_pos: 3 };
      const { cache, g, projection, auxSourceRef } = buildScenario(auxRaw0);
      const { ctx, costs, finishCurrentUtterance } = makeAudioBriefingContext(cache, projection, port, auxSourceRef, auxRaw0);
      ctx.voiceOn = false;
      ctx.buildPreviousRaceBriefingNote = () => stub.MARKER
        + Buffer.from(JSON.stringify({ chunks: ['現在の前とのギャップは2.4秒。'] })).toString('base64');
      await ctx.scheduleAutoBriefing();
      await ctx._briefingDone;
      void finishCurrentUtterance;
      check('V6b auto代表suppressed: voiceOff時はAPI呼出/queue投入を一切発生させない',
        ctx.speakQueue.length === 0 && !costs.some(c => c.outcome === 'completed'), costs);
      const trace = ctx.utteranceTraceLog.filter(e => e.uid === (ctx.utteranceTraceLog.find(e => e.state === 'suppressed') || {}).uid);
      check('V6b auto代表suppressed: boundedtraceがgenerated→suppressedのみを記録し、本文/kind/roleはそれでも保持される（IDが無いまま消えない）',
        trace.length === 2 && trace.every(e => e.text && e.text.includes('前とのギャップは2.4秒') && e.role)
        && trace.map(e => e.state).join(',') === 'generated,suppressed', trace);
      void g;
    }

    // ── Case V7（独立追加反証「TTS fetch/json待ち中のdrift」）: ストリーム完了
    //    →history確定**後**、実TTS fetch/jsonの非同期待機中にGAP自体が
    //    drift。実pre-playguard（desktop/renderer.html ~4735、fetch/json待ちの
    //    非同期区間を再照合する既存の仕組み）が実音声を正しくdropし、かつ
    //    今回の修復（item.messageId事後配線→既存removeMessageById経路）で
    //    assistant historyからも正しく訂正されることを確認する——以前は
    //    speech側は正しくdropしてもhistory側に旧全文が残り続けていた
    //    （独立反証で実HTTP確認：item.messageId null）。──────────────────
    {
      const auxRaw0 = { gap_ahead: 2.4, gap_behind: 1.2, pos: 9, class_pos: 3 };
      const { cache, g, projection, auxSourceRef } = buildScenario(auxRaw0);
      const { ctx, costs, finishCurrentUtterance } = makeAudioCallApiContext(cache, projection, port, auxSourceRef, auxRaw0);
      // pre-body gateは使わない——ストリームを正常に完了させ、historyが
      // GAP有効なまま先に確定することを再現する。
      const scenario = Buffer.from(JSON.stringify({ chunks: ['現在の前とのギャップは2.4秒。'] })).toString('base64');
      ctx.messages = [{ role: 'user', content: '状況を教えて ' + stub.MARKER + scenario }];
      await ctx.callAPI('typed');
      check('V7: ストリーム完了直後、GAP有効のままassistant historyへ本文が残る（drift前のbaseline確認）',
        ctx.messages.some(m => m.role === 'assistant' && /前とのギャップ/.test(m.content)), ctx.messages);
      // 実TTS fetch/json待ちの非同期区間でGAPがdrift（history確定より後）。
      ctx.lastTelemetry = Object.assign({}, ctx.lastTelemetry, { gap_ahead: 1.1 });
      await finishCurrentUtterance();
      check('V7: 実pre-playguardがTTS fetch/json待ち中のdriftも実音声completedをdropする',
        !costs.some(c => c.outcome === 'completed'), costs);
      check('V7: history確定後に発覚したdriftも、事後配線されたmessageId経由でassistant historyから正しく訂正される',
        !ctx.messages.some(m => m.role === 'assistant' && /前とのギャップ/.test(m.content)), ctx.messages);
      void g;
    }
    // 対照：同じTTS fetch/json待ち窓でGAPが不変なら、historyも実音声
    // completedも両方生き残る（修復が正常系を壊していないことの確認）。
    {
      const auxRaw0 = { gap_ahead: 2.4, gap_behind: 1.2, pos: 9, class_pos: 3 };
      const { cache, g, projection, auxSourceRef } = buildScenario(auxRaw0);
      const { ctx, costs, finishCurrentUtterance } = makeAudioCallApiContext(cache, projection, port, auxSourceRef, auxRaw0);
      const scenario = Buffer.from(JSON.stringify({ chunks: ['現在の前とのギャップは2.4秒。'] })).toString('base64');
      ctx.messages = [{ role: 'user', content: '状況を教えて ' + stub.MARKER + scenario }];
      await ctx.callAPI('typed');
      await finishCurrentUtterance();
      check('V7 control: GAP不変ならTTS fetch/json待ち後も実音声completedに届く',
        costs.some(c => c.outcome === 'completed'), costs);
      check('V7 control: GAP不変ならassistant historyも維持される',
        ctx.messages.some(m => m.role === 'assistant' && /前とのギャップ/.test(m.content)), ctx.messages);
      void g;
    }

    // ── Case V8（独立追加反証「generic+specific同一domain混在」の縦断版）:
    //    「現在の前とのギャップは2.4秒で、ギャップは1.2秒です。」のgap_behind
    //    だけがTTS fetch/json待ち中にdrift（gap_aheadは不変）。修復後は
    //    2回目の無修飾「ギャップ」主張（gap_behind相当）も正しく評価され、
    //    実音声/historyとも破棄される。─────────────────────────────────
    {
      const auxRaw0 = { gap_ahead: 2.4, gap_behind: 1.2, pos: 9, class_pos: 3 };
      const { cache, g, projection, auxSourceRef } = buildScenario(auxRaw0);
      const { ctx, costs, finishCurrentUtterance } = makeAudioCallApiContext(cache, projection, port, auxSourceRef, auxRaw0);
      const scenario = Buffer.from(JSON.stringify({ chunks: ['現在の前とのギャップは2.4秒で、ギャップは1.2秒です。'] })).toString('base64');
      ctx.messages = [{ role: 'user', content: '状況を教えて ' + stub.MARKER + scenario }];
      await ctx.callAPI('typed');
      ctx.lastTelemetry = Object.assign({}, ctx.lastTelemetry, { gap_behind: 3 });
      await finishCurrentUtterance();
      check('V8: 混在文の2回目無修飾gap_behind主張もTTS fetch待ち中のdriftで実音声completedをdropする',
        !costs.some(c => c.outcome === 'completed'), costs);
      check('V8: 混在文のgap_behind driftもassistant historyから正しく訂正される',
        !ctx.messages.some(m => m.role === 'assistant' && /前とのギャップ/.test(m.content)), ctx.messages);
      void g;
    }

    // ── Case V9（独立review「main実streamed2文がspeak+speakReplyChunk実経路で
    //    distinctUID/bodytrace+auto representativeを持つか未証明」修復）：
    //    GAP/numeric言及の無いsetup相談2文を同一streamへ流し、1文目が実
    //    speak()、2文目が実speakReplyChunk()経路を通り、それぞれ別
    //    utteranceId・正しい本文・一致したfinal/original bodyを持つことを
    //    直接確認する。────────────────────────────────────────────────
    {
      const auxRaw0 = { gap_ahead: 2.4, gap_behind: 1.2, pos: 9, class_pos: 3 };
      const { cache, g, projection, auxSourceRef } = buildScenario(auxRaw0);
      const { ctx, costs, finishCurrentUtterance } = makeAudioCallApiContext(cache, projection, port, auxSourceRef, auxRaw0);
      const scenario = Buffer.from(JSON.stringify({ chunks: ['セットアップの空力を相談しよう。ブレーキバランスも確認しよう。'] })).toString('base64');
      ctx.messages = [{ role: 'user', content: '相談したい ' + stub.MARKER + scenario }];
      await ctx.callAPI('typed');
      // 2文とも実queueを別々に通るため、drainQueue直列処理の分だけ
      // finishCurrentUtterance()を2回呼ぶ（1回目=speak()分、2回目=
      // speakReplyChunk()分）。
      await finishCurrentUtterance();
      await finishCurrentUtterance();
      check('V9: 2文ストリームは実音声completedを2回記録する（speak()1回+speakReplyChunk()1回）',
        costs.filter(c => c.outcome === 'completed').length === 2, costs);
      const generated = ctx.utteranceTraceLog.filter(e => e.state === 'generated');
      check('V9: 2文は実speak/speakReplyChunk両方からそれぞれ別utteranceIdで記録される',
        generated.length === 2 && generated[0].uid !== generated[1].uid, generated);
      check('V9: 各文のbounded trace本文がそれぞれ正しい文に対応する（1文目kind=reply、2文目kind=reply_chunk、本文自体も保持）',
        generated.every(e => typeof e.text === 'string' && e.text.length > 0)
        && generated[0].kind === 'reply' && generated[1].kind === 'reply_chunk'
        && generated[0].text.includes('空力') && generated[1].text.includes('ブレーキ'), generated);
      const completed = ctx.utteranceTraceLog.filter(e => e.state === 'completed');
      check('V9: 両utteranceの終端entryも実本文を保持し、GAP rebuildしない通常文なので元候補(generated)と同一本文のまま',
        completed.length === 2 && completed.every(ce => {
          const g0 = generated.find(e => e.uid === ce.uid);
          return g0 && g0.text === ce.text && g0.textHash === ce.textHash;
        }), { generated, completed });
      check('V9: 実assistant historyに両文が残る',
        ctx.messages.some(m => m.role === 'assistant' && /空力/.test(m.content))
        && ctx.messages.some(m => m.role === 'assistant' && /ブレーキ/.test(m.content)), ctx.messages);
      void g;
    }
  } finally {
    server.kill('SIGTERM');
  }
  console.log(`\nWO015 aux full vertical (main+auto caller, real audio IO): ${pass}/${pass + fail}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
