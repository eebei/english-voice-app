#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════════════════
// ★Codex差戻し残作業2（2026-09-10）：
//   「その質問の実replyを実speak/queueへ渡し、実表示・会話記録作成処理と
//    TTS送信境界を捕捉する。ネットワークTTSとDOM/IPCの境界だけstubでよい。
//    本文・utterance_id・採用raceの識別子を比較する。finalizerの一致判定
//    試験は保持するが、配線試験の代用にはしない。既存GAP系のqueue fixture
//    を参考にできる。」
//
// tests-gap-answer-queue.js と同じ抽出・sandbox構築方式を流用し、
// 「前回給油は？」質問について：
//   ドライバー発話 → 実sendMsg → 実router.route → 実speak → 実queue →
//   実drainQueue → TTS送信(fetch, stub) → 実finalizeUtterance →
//   Overlay・会話Box・LLM履歴
// を1本で通す。TTSネットワーク呼び出し(fetch)とDOM(document)だけをstub化し、
// それ以外（sendMsg/speak/drainQueue/finalizeUtterance/addMsg/pushMsg/
// 会話Box/saveSessionSummary/loadRaceHistory）は本番コードを実行する。
// ══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = __dirname;
const html = fs.readFileSync(path.join(ROOT, 'desktop/renderer.html'), 'utf8');
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

const productionCode = ['sendMsg', 'speak', 'speechMayStart', 'drainQueue',
  'stopCurrentAudio', 'onUtteranceDone', 'playWebSpeech',
  'nextUtteranceId', 'finalizeUtterance', 'discardQueuedUtterances',
  'pushMsg', 'amendMessageById', 'removeMessageById',
  'addMsg', 'convoLog', 'recordLunaTurn', 'amendLunaTurnById', 'dropLunaTurnById',
  'ensureConversationBox', 'saveConversationBox', 'conversationSessionKey',
  'handleLunaSelfMemoryInput', 'lunaSelfMemoryProposalLine',
  'pendingConfirmationKinds', 'bareConfirmationAnswer', 'confirmationClarification',
  // ★本テスト固有：previous_fuel の入口に必要な実関数
  'loadRaceHistory', 'saveSessionSummary', 'sanitizeSessionEvidence',
  'validFinishPosition', 'currentMemoryUserId']
  .map(extract).join('\n');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  (ok ? console.log : console.error)('  ' + (ok ? '✅ ' : '❌ ') + label + (ok ? '' : ' -> ' + (detail || '')));
  ok ? pass++ : fail++;
}

let fakeNow = 1_700_000_000_000;
let ttsResolve = null;
const played = [];
const audioInstances = [];
const traces = [];
const spokenTexts = [];

class FakeDate extends Date {
  constructor(...args) { if (!args.length) super(fakeNow); else super(...args); }
  static now() { return fakeNow; }
}

const sandbox = {
  console, setTimeout, clearTimeout, Date: FakeDate, JSON, Math, Number, String,
  Array, Object, Set, Map, Boolean, RegExp, Promise, Error, isNaN, parseFloat, parseInt,
  speakQueue: [], draining: false, isSpeaking: false, speakWatchdog: null,
  ttsAudio: null, currentSpeakPrio: 9, speakGeneration: 0, speakFetchCtrl: null,
  currentSpeakItem: null, voiceOn: true, pwVolume: 1, ttsDisabledUntil: 0,
  autoMicActive: false, autoMicRec: null, jamesAutoMicEnabled: false, jamesMuted: false,
  startAutoMic: () => {}, MAX_RADIO_QUEUE: 2,
  speakWindowOk: true, speakGateActive: false,
  IMMEDIATE_PIT_KINDS: new Set(['pit_entry', 'limiter_off', 'pit_box_here', 'pit_box_countdown']),
  SPEAK_DEFER_KINDS: new Set(['personal_best', 'session_best', 'first_lap']),
  SPEAK_DEFER_MAX: 1,
  SPEAK_PRIO: { P0_SAFETY: 0, P1_HAZARD: 1, P2_PROCEDURE: 2, P3_STRATEGY: 3, P4_INFO: 4, P5_CHAT: 5 },
  CHARS: { LunaJP: { gVoice: 'ja-JP-x', gLang: 'ja-JP', gRate: 1, gPitch: 0, voiceLang: 'ja-JP', pitch: 1, rate: 1, voiceNames: [] } },
  sel: 'LunaJP', API_BASE: 'http://x',
  isBusy: false, turns: 0, sessionMsgCount: 0, userName: '',
  selMode: 'race', iracingLive: true,
  // ★本テストの核心：lastTelemetry には Bridge の実 telemetry_live と同じ形で
  //   track/car_class/car_model を含めない（本セッションで発見した実バグの前提と同じ）。
  //   sendMsg 側の live 構築で lastTrack/lastCarClass/lastCarModel から補われることを検証する。
  lastTelemetry: { cust_id: 999999, laps_total: 20 },
  lastTelemetryAt: fakeNow,
  lastTrack: 'Spa-Francorchamps', lastCarModel: 'Mercedes-AMG GT3 2020', lastCarClass: 'GT3',
  lastSessionType: 'Race', lastSessionNum: 2, lastSessionAuthority: null,
  lastIrating: null, lastSr: null,
  fuelWindowWatch: null,
  document: { getElementById: () => ({ value: '', style: {} }) },
  messages: [], MAX_CLIENT_MESSAGES: 40, _msgSeq: 0,
  usageCount: () => {},
  prepareMemoryBrain: () => null,
  captureConfirmedFuelCapacity: () => {}, maybeQuietMode: () => {},
  answerHistoricalWeatherLocally: () => null,
  saveMemory: () => {},
  diagnosticLog: (tag, body) => traces.push(tag + ' ' + body),
  PitwallLunaSelfMemory: require('./desktop/luna-self-memory.js'),
  lunaSelfMemoryStore: () => [],
  saveLunaSelfMemoryStore: () => true,
  currentMemoryIdentity: () => ({ userId: null, custId: 999999, track: 'Spa-Francorchamps', car: 'Mercedes-AMG GT3 2020' }),
  confirmDecisionCorrection: () => null,
  isJapaneseEngineer: () => true,
  pendingLunaSelfMemoryConfirmation: null,
  pendingDecisionDispute: null,
  pendingDrivingStyleAdvice: null,
  evidenceDebrief: null,
  isManualReviewCommand: () => false,
  isExplicitMemoryRequest: () => false,
  memorySaveReceipt: '',
  callAPI: async () => {},
  speechLatencyTrace: () => {}, costRecord: () => {}, costReplyId: () => 'cost-1',
  ttsFailLog: () => {}, ttsEventLog: () => {},
  phonetify: t => t, normalizeLunaSpeech: t => t,
  stripMarkdown: t => t, stripParens: t => t, stripEmoji: t => t, pickVoice: () => null,
  irBridge: { readyState: 1, send: () => {} },
  usageSessionId: 'test-usage-session',
  AbortController: class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } },
  fetch: (url, init) => {
    try {
      const body = init && init.body ? JSON.parse(init.body) : null;
      if (body && typeof body.text === 'string') spokenTexts.push(body.text);
    } catch (_) {}
    return new Promise((res, rej) => { ttsResolve = { res, rej }; });
  },
  Audio: class {
    constructor(url) { this.src = url; this.volume = 1; this.onended = null; this.onerror = null; audioInstances.push(this); }
    async play() { played.push(this.src); }
    pause() { this.paused = true; }
  },
  speechSynthesis: { cancel() {}, speak(u) { played.push('webspeech:' + u.text); } },
  SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox._uttSeq = 0;
sandbox._convoBox = null;
sandbox.CONVO_BOX_KEY = 'pw_conversation_box_v1';
{
  const _store = {};
  sandbox.localStorage = {
    getItem: k => (k in _store ? _store[k] : null),
    setItem: (k, v) => { _store[k] = String(v); },
    removeItem: (k) => { delete _store[k]; },
  };
  sandbox.__store = _store;
}
sandbox.document = {
  getElementById: () => ({ value: '', style: {}, appendChild(){}, scrollTop:0, scrollHeight:0, classList:{add(){},remove(){},toggle(){}} }),
  createElement: () => ({ textContent:'', className:'', parentNode:null }),
  querySelector: () => null,
};
sandbox.__ovl = {};
sandbox.__ovlSeq = 0;
sandbox.mirrorToOverlay = (type, text) => {
  const id = 'L' + (++sandbox.__ovlSeq);
  sandbox.__ovl[id] = { text, removed: false };
  return id;
};
sandbox.pitwall = {
  overlayPush: (line) => {
    if (!line) return;
    if (line.remove) { if (sandbox.__ovl[line.id]) sandbox.__ovl[line.id].removed = true; return; }
    if (line.update && sandbox.__ovl[line.id] && typeof line.text === 'string' && line.text) {
      sandbox.__ovl[line.id].text = line.text;
    }
  },
};

vm.createContext(sandbox);

function loadModule(file) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
}
loadModule('desktop/local-intent-router.js');
loadModule('desktop/conversation-memory-box.js');
loadModule('desktop/session-memory.js');
vm.runInContext(productionCode, sandbox, { filename: 'renderer.html' });
sandbox.PitwallSessionMemory = sandbox.window.PitwallSessionMemory;

check('本番の router が読めた', typeof sandbox.window.PitwallLocalIntentRouter.route === 'function');
check('本番の sessionMemory が読めた', typeof sandbox.window.PitwallSessionMemory.answerPreviousFuel === 'function');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ask(text) {
  sandbox.document = {
    getElementById: () => ({ value: text, style: {},
      appendChild(){}, scrollTop:0, scrollHeight:0, classList:{add(){},remove(){},toggle(){}} }),
    createElement: () => ({ textContent:'', className:'', parentNode:null }),
    querySelector: () => null,
  };
  await sandbox.sendMsg('ptt');
  await sleep(5);
}

async function finishCurrentUtterance() {
  if (ttsResolve) {
    ttsResolve.res({ status: 200, ok: true, json: async () => ({ audioContent: 'A' + audioInstances.length }) });
    ttsResolve = null;
    await sleep(10);
  }
  const audio = audioInstances[audioInstances.length - 1];
  if (audio && typeof audio.onended === 'function') { audio.onended(); await sleep(10); }
}

(async () => {
  console.log('\n══ 前回給油質問：実sendMsg→実speak→実drainQueue→実finalizerの統合replay ══\n');

  // ★Codex差戻し：同一driverの「別レース」記録を2件保存し、識別子で取り違えないことを
  //   検証する。古い方(Monza)は無関係、新しい方(Spa)だけが採用されるべき。
  sandbox.saveSessionSummary({
    cust_id: 999999, track: 'Monza', car_class: 'GT3', car_model: 'Mercedes-AMG GT3 2020',
    pit_events: [{ entry_lap: 12, exit_lap: 13, fuel_added_l: 30.5 }],
    checker_fuel_l: 2.1, official_result_arrived: true,
  });
  fakeNow += 3600_000;  // recordedAt(ISO時刻・FakeDate基準)が2件で確実に異なるようにする
  sandbox.saveSessionSummary({
    cust_id: 999999, track: 'Spa-Francorchamps', car_class: 'GT3', car_model: 'Mercedes-AMG GT3 2020',
    pit_events: [{ entry_lap: 9, exit_lap: 10, fuel_added_l: 26.83 }],
    checker_fuel_l: 3.9, official_result_arrived: true,
  });

  const historyNow = JSON.parse(sandbox.localStorage.getItem('pw_raceHistory') || '[]');
  const spaRecord = historyNow.find(r => r.track === 'Spa-Francorchamps');
  const monzaRecord = historyNow.find(r => r.track === 'Monza');
  check('保存した2件の recordedAt が異なる（時刻としての参考情報）',
    !!spaRecord && !!monzaRecord && spaRecord.recordedAt !== monzaRecord.recordedAt,
    JSON.stringify({ spa: spaRecord && spaRecord.recordedAt, monza: monzaRecord && monzaRecord.recordedAt }));
  // ★Codex差戻し（残件1）：recordedAtはミリ秒精度で同時保存時に衝突しうるため、
  //   永続的な一意ID(raceRecordId)を別途持つ設計へ変更した。両record自体にも
  //   raceRecordIdが刻まれ、互いに異なることを確認する。
  check('保存した2件が raceRecordId フィールドを持つ（saveSessionSummaryが刻む一意ID）',
    !!spaRecord && !!spaRecord.raceRecordId && !!monzaRecord && !!monzaRecord.raceRecordId,
    JSON.stringify({ spa: spaRecord && spaRecord.raceRecordId, monza: monzaRecord && monzaRecord.raceRecordId }));
  check('保存した2件の raceRecordId が異なる', spaRecord.raceRecordId !== monzaRecord.raceRecordId);

  await ask('前回給油は？');
  const queued = sandbox.speakQueue.find(q => q.kind === 'local_previous_fuel_reference')
    || (sandbox.currentSpeakItem && sandbox.currentSpeakItem.kind === 'local_previous_fuel_reference' ? sandbox.currentSpeakItem : null);
  check('回答が queue に入った', !!queued, JSON.stringify(sandbox.speakQueue.map(q => q.kind)));

  const expectedText = '前回は9周終了後に入り、26.83L給油。チェッカー時3.9L残。';
  check('queue item の本文が Spa の記録と完全一致（Monzaの30.5L等が混入していない）',
    !!queued && queued.text === expectedText, queued && queued.text);

  check('★queue item が採用raceの識別子(raceRecordId)を持ち、現在track(Spa)の記録と一致する',
    !!queued && queued.raceRecordId === spaRecord.raceRecordId,
    `queued.raceRecordId=${queued && queued.raceRecordId} spaRecord.raceRecordId=${spaRecord && spaRecord.raceRecordId}`);
  check('採用raceの識別子はMonza(別レース)のものではない',
    !!queued && queued.raceRecordId !== monzaRecord.raceRecordId);

  await finishCurrentUtterance();
  await sleep(15);

  const finalTts = spokenTexts[spokenTexts.length - 1];
  check('実TTS(fetch)へ渡った本文が完全一致（前半一致だけでなく完全一致で検査）',
    finalTts === expectedText, String(finalTts));

  const ovlId = queued && queued.displayEl && queued.displayEl._ovlId;
  const turnId = queued && queued.displayEl && queued.displayEl._turnId;
  const boxNow = JSON.parse(sandbox.__store[sandbox.CONVO_BOX_KEY] || 'null');
  const turnNow = boxNow && (boxNow.turns.find(t => t.turn_id === turnId) || {}).text;
  const ovlNow = sandbox.__ovl[ovlId] && sandbox.__ovl[ovlId].text;

  check('★Overlay＝会話Box＝TTSへ渡った本文が同一（同一utterance・完全一致）',
    finalTts === expectedText && ovlNow === finalTts && turnNow === finalTts,
    `tts=${finalTts} ovl=${ovlNow} box=${turnNow}`);

  check('★utteranceId が queue item と表示要素で一致（同一発話の証明）',
    !!queued && !!queued.displayEl && queued.utteranceId === queued.displayEl._uid,
    `queued.utteranceId=${queued && queued.utteranceId} displayEl._uid=${queued && queued.displayEl && queued.displayEl._uid}`);

  const msgs = sandbox.messages || [];
  check('LLM会話履歴にも最終本文が完全一致で積まれる',
    msgs.some(m => m && m.role === 'assistant' && String(m.content) === expectedText),
    JSON.stringify(msgs.filter(m => m && m.role === 'assistant').map(m => m.content)));

  // ★UTTERANCE_FINAL trace に race_record_id が Spa の識別子（raceRecordId）で残ることを確認
  const finalTrace = traces.filter(t => /UTTERANCE_FINAL/.test(t)).pop();
  check('finalizer の trace にも Spa の race_record_id(raceRecordId基準)が残る（出口まで追跡可能）',
    !!finalTrace && finalTrace.includes('race_record_id=' + spaRecord.raceRecordId),
    finalTrace);

  console.log(`\nPrevious-fuel utterance fanout (実配線統合replay): ${pass}/${pass + fail}`);
  if (fail) process.exit(1);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
