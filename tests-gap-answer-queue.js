#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════════════════
// G5（2026-08-25）— PTT質問の GAP 回答が queue 待ちで陳腐化しないこと。
//
// Codex Build 284 独立レビュー P1:
//   「PTTの直接質問は `localIntent` から `speak()` する際に `gapIdentity` を
//     渡していない。質問時点では5秒以内でも、先行発話でqueue待ちになった後に
//     古い数値のまま再生され得る。回答生成時だけ5秒契約を満たしており、
//     回答→queue→TTS開始の出口まで満たしていない。
//     `tests-local-intent-router.js` もこのqueue経路を再現していない。」
//
// このテストは **写経しない**。`desktop/renderer.html` から本番の
// `sendMsg` / `speak` / `drainQueue` を抽出して実行し、本物の
// `local-intent-router.js` と `gap-freshness.js` を読み込む。
//
//   ドライバーの発話 → router → speak() → queue待ち6秒 → drainQueue → TTS開始
//
// 外部APIは呼ばない（fetch はスタブ）。
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

// ★2026-08-26：`sendMsg` の先頭に自己反省記憶の分岐が入った。
//   スタブで潰さず**本番の関数をそのまま抽出する**。潰すと、
//   「自己反省記憶が GAP の質問を飲み込む」回帰を検出できなくなる。
const productionCode = ['sendMsg', 'speak', 'speechMayStart', 'drainQueue',
  'stopCurrentAudio', 'onUtteranceDone', 'playWebSpeech',
  // ★2026-09-05 第4回 Gate 4：終端集約を**本物で**動かす。
  //   スタブに差し替えると「呼ばれた記録」しか取れず、Overlay・会話Boxまで到達しない。
  'nextUtteranceId', 'finalizeUtterance', 'discardQueuedUtterances',
  'pushMsg', 'amendMessageById', 'removeMessageById',
  'addMsg', 'convoLog', 'recordLunaTurn', 'amendLunaTurnById', 'dropLunaTurnById',
  'ensureConversationBox', 'saveConversationBox', 'conversationSessionKey',
  'handleLunaSelfMemoryInput', 'lunaSelfMemoryProposalLine',
  'pendingConfirmationKinds', 'bareConfirmationAnswer', 'confirmationClarification']
  .map(extract).join('\n');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  (ok ? console.log : console.error)('  ' + (ok ? '✅ ' : '❌ ') + label + (ok ? '' : ' -> ' + (detail || '')));
  ok ? pass++ : fail++;
}

const SK = "(2, 'Okayama', 'Audi R8 LMS GT3')";

// ── 本番と同じ telemetry snapshot の形（bridge.py:6460 の gap_authority）──
function snapshot(over) {
  const o = over || {};
  const auth = (dir, rec) => rec === null ? null : Object.assign({
    session_key: SK, generation: 3, direction: dir,
    target_car_idx: dir === 'ahead' ? 12 : 31,
    source_kind: 'same_class_battle_gap', gap_s: dir === 'ahead' ? 5.5 : 3.8,
  }, rec || {});
  return {
    gap_ahead: o.gap_ahead === undefined ? 5.5 : o.gap_ahead,
    gap_behind: o.gap_behind === undefined ? 3.8 : o.gap_behind,
    gap_authority: o.gap_authority === undefined
      ? { ahead: auth('ahead', o.ahead), behind: auth('behind', o.behind) }
      : o.gap_authority,
  };
}

// ══════════════════════════════════════════════════════════════════════
// 実行環境（本番コードだけを走らせ、ブラウザAPIはスタブ）
// ══════════════════════════════════════════════════════════════════════
let fakeNow = 1_700_000_000_000;
let ttsResolve = null;
const played = [];
const audioInstances = [];
const traces = [];

class FakeDate extends Date {
  constructor(...args) { if (!args.length) super(fakeNow); else super(...args); }
  static now() { return fakeNow; }
}

const sandbox = {
  console, setTimeout, clearTimeout, Date: FakeDate, JSON, Math, Number, String,
  Array, Object, Set, Map, Boolean, RegExp, Promise, Error, isNaN, parseFloat, parseInt,
  // ── speak / drainQueue の状態（本番と同じ初期値）──
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
  // ── sendMsg が触るもの ──
  isBusy: false, turns: 0, sessionMsgCount: 0,
  selMode: 'race', iracingLive: true,
  lastTelemetry: snapshot(), lastTelemetryAt: fakeNow,
  lastSessionNum: 2, fuelWindowWatch: null,
  document: { getElementById: () => ({ value: '', style: {} }) },
  // ★第4回：addMsg は本物を抽出して使う（スタブにすると Overlay・会話Boxへ到達しない）。
  //   messages / pushMsg は LLM会話履歴の契約を検査するため実体を持たせる。
  messages: [], MAX_CLIENT_MESSAGES: 40, _msgSeq: 0,
  usageCount: () => {},
  prepareMemoryBrain: () => null,
  captureConfirmedFuelCapacity: () => {}, maybeQuietMode: () => {},
  answerHistoricalWeatherLocally: () => null,
  // ── 計装 ──
  diagnosticLog: (tag, body) => traces.push(tag + ' ' + body),
  // 自己反省記憶の依存（本番の判定ロジックはそのまま動かす）
  PitwallLunaSelfMemory: require('./desktop/luna-self-memory.js'),
  lunaSelfMemoryStore: () => [],
  saveLunaSelfMemoryStore: () => true,
  currentMemoryIdentity: () => ({ userId: 'u1', track: 'Okayama', car: 'Audi R8 LMS GT3' }),
  confirmDecisionCorrection: () => null,
  isJapaneseEngineer: () => true,
  pendingLunaSelfMemoryConfirmation: null,
  pendingDecisionDispute: null,
  pendingDrivingStyleAdvice: null,
  speechLatencyTrace: () => {}, costRecord: () => {}, costReplyId: () => 'cost-1',
  ttsFailLog: () => {}, ttsEventLog: () => {},
  phonetify: t => t, normalizeLunaSpeech: t => t,
  stripMarkdown: t => t, stripParens: t => t, stripEmoji: t => t, pickVoice: () => null,
  irBridge: { readyState: 1, send: () => {} },
  localStorage: { getItem: () => null, setItem: () => {} },
  usageSessionId: 'test-usage-session',
  AbortController: class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } },
  fetch: () => new Promise((res, rej) => { ttsResolve = { res, rej }; }),
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
// ★2026-09-05 第4回：本物の finalizer / addMsg / 会話Box を動かすための最小環境。
//   Overlay 窓は別プロセスなので、push された行を配列で保持して本文を検査する。
sandbox._uttSeq = 0;
sandbox._convoBox = null;
sandbox.CONVO_BOX_KEY = 'pw_conversation_box_v1';
sandbox.lastTrack = 'Okayama'; sandbox.lastCarModel = 'Audi R8 LMS GT3';
sandbox.lastCarClass = 'GT3'; sandbox.lastSessionType = 'Race'; sandbox.lastSessionNum = 2;
sandbox.currentMemoryUserId = () => 'u1';
sandbox.__ovl = {};                       // id -> {text, removed}
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
{
  const _store = {};
  sandbox.localStorage = {
    getItem: k => (k in _store ? _store[k] : null),
    setItem: (k, v) => { _store[k] = String(v); },
  };
  sandbox.__store = _store;
}
sandbox.document = {
  getElementById: () => ({ appendChild(){}, scrollTop:0, scrollHeight:0, classList:{add(){},remove(){},toggle(){}} }),
  createElement: () => ({ textContent:'', className:'', parentNode:null }),
  querySelector: () => null,
};
vm.createContext(sandbox);

// 本物のモジュールを本番と同じ形（window.*）で読み込む
function loadModule(file) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
}
loadModule('desktop/local-intent-router.js');
loadModule('desktop/gap-freshness.js');
loadModule('desktop/conversation-memory-box.js');   // ★第4回：会話Boxを本物で動かす
vm.runInContext(productionCode, sandbox, { filename: 'renderer.html' });

check('本番の router が読めた', typeof sandbox.window.PitwallLocalIntentRouter.route === 'function');
check('本番の gap-freshness が読めた', typeof sandbox.window.PitwallGapFreshness.evaluateAnswer === 'function');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function reset() {
  sandbox.speakQueue = []; sandbox.draining = false; sandbox.isSpeaking = false;
  sandbox.ttsAudio = null; sandbox.currentSpeakPrio = 9; sandbox.speakGeneration = 0;
  sandbox.speakFetchCtrl = null; sandbox.currentSpeakItem = null;
  if (sandbox.speakWatchdog) { clearTimeout(sandbox.speakWatchdog); sandbox.speakWatchdog = null; }
  played.length = 0; audioInstances.length = 0; traces.length = 0; ttsResolve = null;
  fakeNow = 1_700_000_000_000;
  sandbox.messages = [];
  sandbox.lastTelemetry = snapshot(); sandbox.lastTelemetryAt = fakeNow;
  sandbox.pendingLunaSelfMemoryConfirmation = null;
  sandbox.pendingDecisionDispute = null;
  sandbox.pendingDrivingStyleAdvice = null;
}

/** ドライバーが喋る（本番 sendMsg を実行する）。 */
async function ask(text) {
  // ★2026-09-05：addMsg が本物になったので createElement も要る。
  sandbox.document = {
    getElementById: () => ({ value: text, style: {},
      appendChild(){}, scrollTop:0, scrollHeight:0, classList:{add(){},remove(){},toggle(){}} }),
    createElement: () => ({ textContent:'', className:'', parentNode:null }),
    querySelector: () => null,
  };
  await sandbox.sendMsg('ptt');
  await sleep(5);
}

/** 再生中の1本を完了させ、次の item を drainQueue に取り出させる。 */
async function finishCurrentUtterance() {
  if (ttsResolve) {
    ttsResolve.res({ status: 200, ok: true, json: async () => ({ audioContent: 'A' + audioInstances.length }) });
    ttsResolve = null;
    await sleep(10);
  }
  const audio = audioInstances[audioInstances.length - 1];
  if (audio && typeof audio.onended === 'function') { audio.onended(); await sleep(10); }
}

/** 実際に TTS へ渡された文（本番が fetch body へ載せたもの）を読む。 */
const spokenTexts = [];
sandbox.fetch = (url, init) => {
  try {
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (body && typeof body.text === 'string') spokenTexts.push(body.text);
  } catch (_) {}
  return new Promise((res, rej) => { ttsResolve = { res, rej }; });
};
const resetSpoken = () => { spokenTexts.length = 0; };

(async () => {

  console.log('\n══ ⓪ 共通確認arbiter：裸の「はい」を横取りしない ══');
  reset(); resetSpoken();
  sandbox.pendingDrivingStyleAdvice={available:true,point:{feature:'minimum_speed_mps'}};
  sandbox.pendingDecisionDispute='decision-1';
  await ask('はい');
  check('運転スタイル＋Decisionは対象を聞き返す',traces.some(t=>/CONFIRMATION_ARBITER/.test(t)));
  check('運転スタイルを勝手に確定しない',sandbox.pendingDrivingStyleAdvice!==null);
  check('Decision訂正を保留したままにする',sandbox.pendingDecisionDispute==='decision-1');

  reset(); resetSpoken();
  sandbox.pendingDrivingStyleAdvice={available:true,point:{feature:'minimum_speed_mps'}};
  sandbox.pendingLunaSelfMemoryConfirmation='self-1';
  await ask('yes');
  check('運転スタイル＋自己反省も対象を聞き返す',traces.some(t=>/CONFIRMATION_ARBITER/.test(t)));
  check('自己反省を保留したままにする',sandbox.pendingLunaSelfMemoryConfirmation==='self-1');

  // ════════════════════════════════════════════════════════════════
  console.log('\n══ ① 回答が identity を持って queue へ入る（Codex 受入条件1）══');
  // ════════════════════════════════════════════════════════════════
  reset(); resetSpoken();
  sandbox.speak('先行発話。', { prio: 2, kind: 'reply' });
  await sleep(5);
  await ask('後ろとの差は？');
  const queued = sandbox.speakQueue.find(q => q.kind === 'local_nearest_gap');
  check('GAP回答が queue に入った', !!queued, JSON.stringify(sandbox.speakQueue.map(q => q.kind)));
  check('★queue item が gapIdentities を持つ（P1 の核心）',
    !!(queued && Array.isArray(queued.gapIdentities) && queued.gapIdentities.length === 1));
  check('方向が入っている', !!(queued && queued.gapIdentities[0].direction === 'behind'));
  check('述べた値が入っている', !!(queued && queued.gapIdentities[0].gap_s === 3.8));
  check('対象車が入っている（Bridge の gap_authority 由来）',
    !!(queued && queued.gapIdentities[0].target_car_idx === 31));
  check('session_key が入っている', !!(queued && queued.gapIdentities[0].session_key === SK));
  check('generation が入っている', !!(queued && queued.gapIdentities[0].generation === 3));

  // ════════════════════════════════════════════════════════════════
  console.log('\n══ ② 質問→先行発話で6秒待機→TTS開始（Codex 受入条件4・実走欠陥そのもの）══');
  // ════════════════════════════════════════════════════════════════
  reset(); resetSpoken();
  sandbox.speak('先に喋っている無線。', { prio: 2, kind: 'reply' });
  await sleep(5);
  await ask('後ろとの差は？');            // この時点の実測は 3.8 秒
  check('回答はまだ再生されていない（先行発話が占有）',
    !spokenTexts.some(t => t.includes('後ろ')));

  fakeNow += 6000;                        // ★6秒待たされる
  sandbox.lastTelemetry = snapshot({ gap_behind: 0.6, behind: { gap_s: 0.6 } });
  sandbox.lastTelemetryAt = fakeNow;      // 現在値は新しい（古いのは queue の候補）
  await finishCurrentUtterance();

  const answerText = spokenTexts.find(t => t.includes('後ろ'));
  check('★6秒後でも回答は再生される（沈黙しない）', !!answerText, JSON.stringify(spokenTexts));
  check('★古い「後ろ3.8秒」は絶対に再生されない', !!answerText && !answerText.includes('3.8'), answerText);
  check('★最新値「後ろ0.6秒。」へ作り直される', answerText === '後ろ0.6秒。', answerText);
  check('作り直しが trace に残る', traces.some(t => /GAP_ANSWER_FRESHNESS fate=rebuild/.test(t)),
    traces.join(' | '));

  // ════════════════════════════════════════════════════════════════
  console.log('\n══ ③ 値が動いていなければそのまま再生する（過剰な破棄をしない）══');
  // ════════════════════════════════════════════════════════════════
  reset(); resetSpoken();
  sandbox.speak('先行発話。', { prio: 2, kind: 'reply' });
  await sleep(5);
  await ask('後ろとの差は？');
  fakeNow += 3000;
  sandbox.lastTelemetryAt = fakeNow;      // 値は同じ・snapshot は新しい
  await finishCurrentUtterance();
  check('値が変わっていなければ元の文をそのまま再生',
    spokenTexts.includes('後ろ3.8秒。'), JSON.stringify(spokenTexts));
  check('play が trace に残る', traces.some(t => /GAP_ANSWER_FRESHNESS fate=play/.test(t)));

  // ════════════════════════════════════════════════════════════════
  console.log('\n══ ④ 前後同時質問：片側の旧値を残さない（Codex 受入条件3）══');
  // ════════════════════════════════════════════════════════════════
  reset(); resetSpoken();
  sandbox.speak('先行発話。', { prio: 2, kind: 'reply' });
  await sleep(5);
  await ask('前後のギャップは？');        // 前5.5 / 後ろ3.8
  const both = sandbox.speakQueue.find(q => q.kind === 'local_nearest_gap');
  check('前後2つの identity を持つ', !!(both && both.gapIdentities.length === 2));

  fakeNow += 6000;
  // 前だけ 0.7 へ動き、後ろは 3.8 のまま
  sandbox.lastTelemetry = snapshot({ gap_ahead: 0.7, ahead: { gap_s: 0.7 } });
  sandbox.lastTelemetryAt = fakeNow;
  await finishCurrentUtterance();
  const bothText = spokenTexts.find(t => t.includes('前') || t.includes('後ろ'));
  check('★動いた前は旧値5.5を残さない', !!bothText && !bothText.includes('5.5'), bothText);
  check('★動いていない後ろも巻き込んで消さない', !!bothText && bothText.includes('3.8'), bothText);
  check('両方そろった文へ作り直す', bothText === '前0.7秒、後ろ3.8秒。', bothText);

  // ════════════════════════════════════════════════════════════════
  console.log('\n══ ⑤ 片方向の値が消えたら、その方向だけ落とす ══');
  // ════════════════════════════════════════════════════════════════
  reset(); resetSpoken();
  sandbox.speak('先行発話。', { prio: 2, kind: 'reply' });
  await sleep(5);
  await ask('前後のギャップは？');
  fakeNow += 4000;
  sandbox.lastTelemetry = snapshot({ gap_ahead: null, ahead: null });   // 前が取れなくなった
  sandbox.lastTelemetryAt = fakeNow;
  await finishCurrentUtterance();
  const droppedText = spokenTexts.find(t => t.includes('後ろ'));
  check('★消えた前の旧値は言わない', !!droppedText && !droppedText.includes('前'), droppedText);
  check('残った後ろは答える（全面沈黙にしない）', droppedText === '後ろ3.8秒。', droppedText);
  check('理由が trace に残る', traces.some(t => /reason=direction_dropped/.test(t)));

  // ════════════════════════════════════════════════════════════════
  console.log('\n══ ⑥ 現在値そのものが古ければ破棄する（Bridge が止まった）══');
  // ════════════════════════════════════════════════════════════════
  reset(); resetSpoken();
  sandbox.speak('先行発話。', { prio: 2, kind: 'reply' });
  await sleep(5);
  await ask('後ろとの差は？');
  fakeNow += 9000;
  // lastTelemetryAt を更新しない＝現在値も9秒前のもの
  await finishCurrentUtterance();
  check('★snapshot が古ければ古い数字を喋らない',
    !spokenTexts.some(t => /秒/.test(t) && t.includes('後ろ')), JSON.stringify(spokenTexts));
  check('破棄理由が trace に残る', traces.some(t => /fate=discard reason=live_snapshot_stale/.test(t)));
  check('破棄しても queue は止まらない（以後全部黙る事故を作らない）',
    sandbox.draining === false || sandbox.speakQueue.length === 0);

  // ════════════════════════════════════════════════════════════════
  console.log('\n══ ⑦ セッションが変わったら引き継がない ══');
  // ════════════════════════════════════════════════════════════════
  reset(); resetSpoken();
  sandbox.speak('先行発話。', { prio: 2, kind: 'reply' });
  await sleep(5);
  await ask('後ろとの差は？');
  fakeNow += 2000;
  sandbox.lastTelemetry = snapshot({ behind: { session_key: "(3, 'Monza', 'Audi R8 LMS GT3')" } });
  sandbox.lastTelemetryAt = fakeNow;
  await finishCurrentUtterance();
  check('★別セッションの数字として読まない',
    !spokenTexts.some(t => t.includes('後ろ3.8')), JSON.stringify(spokenTexts));
  check('破棄理由が trace に残る', traces.some(t => /reason=session_changed/.test(t)));

  // ════════════════════════════════════════════════════════════════
  console.log('\n══ ⑧ 対象車が入れ替わったら最新値へ（自発コールとは契約が違う）══');
  // ════════════════════════════════════════════════════════════════
  reset(); resetSpoken();
  sandbox.speak('先行発話。', { prio: 2, kind: 'reply' });
  await sleep(5);
  await ask('後ろとの差は？');
  fakeNow += 2000;
  // 追い越されて後ろの車が入れ替わった。いま後ろにいる車は 1.2 秒差。
  sandbox.lastTelemetry = snapshot({ gap_behind: 1.2, behind: { target_car_idx: 44, generation: 4, gap_s: 1.2 } });
  sandbox.lastTelemetryAt = fakeNow;
  await finishCurrentUtterance();
  const swapped = spokenTexts.find(t => t.includes('後ろ'));
  check('★旧対象車の3.8は言わない', !!swapped && !swapped.includes('3.8'), swapped);
  check('★いま後ろにいる車の秒数を答える（質問は時点の事実）',
    swapped === '後ろ1.2秒。', swapped);

  // ════════════════════════════════════════════════════════════════
  console.log('\n══ ⑨ Practice：権威レコードが無くても全面沈黙にしない ══');
  // ════════════════════════════════════════════════════════════════
  reset(); resetSpoken();
  sandbox.lastTelemetry = { gap_ahead: 5.5, gap_behind: 3.8 };   // gap_authority 無し
  sandbox.lastTelemetryAt = fakeNow;
  sandbox.speak('先行発話。', { prio: 2, kind: 'reply' });
  await sleep(5);
  await ask('後ろとの差は？');
  fakeNow += 2000;
  sandbox.lastTelemetry = { gap_ahead: 5.5, gap_behind: 3.8 };
  sandbox.lastTelemetryAt = fakeNow;
  await finishCurrentUtterance();
  check('★Practice でも答える（G4 の authoritative=False 経路を殺さない）',
    spokenTexts.includes('後ろ3.8秒。'), JSON.stringify(spokenTexts));

  reset(); resetSpoken();
  sandbox.lastTelemetry = { gap_ahead: 5.5, gap_behind: 3.8 };
  sandbox.lastTelemetryAt = fakeNow;
  sandbox.speak('先行発話。', { prio: 2, kind: 'reply' });
  await sleep(5);
  await ask('後ろとの差は？');
  fakeNow += 3000;
  sandbox.lastTelemetry = { gap_ahead: 5.5, gap_behind: 0.9 };   // 権威なしでも値は動く
  sandbox.lastTelemetryAt = fakeNow;
  await finishCurrentUtterance();
  check('Practice でも動いた値は作り直す',
    spokenTexts.includes('後ろ0.9秒。'), JSON.stringify(spokenTexts));

  // ════════════════════════════════════════════════════════════════
  console.log('\n══ ⑩ module 欠落は素通りさせない（Build 281 の package 漏れ）══');
  // ════════════════════════════════════════════════════════════════
  reset(); resetSpoken();
  const realModule = sandbox.window.PitwallGapFreshness;
  sandbox.speak('先行発話。', { prio: 2, kind: 'reply' });
  await sleep(5);
  await ask('後ろとの差は？');
  sandbox.window.PitwallGapFreshness = undefined;                // package から抜けた状態
  fakeNow += 6000;
  sandbox.lastTelemetry = snapshot({ gap_behind: 0.6, behind: { gap_s: 0.6 } });
  sandbox.lastTelemetryAt = fakeNow;
  await finishCurrentUtterance();
  sandbox.window.PitwallGapFreshness = realModule;
  check('★module が無ければ古い数字を再生しない',
    !spokenTexts.some(t => t.includes('3.8')), JSON.stringify(spokenTexts));
  check('module 欠落が trace に残る', traces.some(t => /reason=module_missing/.test(t)));

  // ════════════════════════════════════════════════════════════════
  console.log('\n══ ⑪ GAP以外の発話には触れない ══');
  // ════════════════════════════════════════════════════════════════
  reset(); resetSpoken();
  sandbox.speak('先行発話。', { prio: 2, kind: 'reply' });
  await sleep(5);
  await ask('燃料は？');
  fakeNow += 9000;
  await finishCurrentUtterance();
  check('燃料の回答は鮮度判定に巻き込まれない',
    spokenTexts.length >= 2 && !traces.some(t => /GAP_ANSWER_FRESHNESS fate=discard/.test(t)),
    JSON.stringify(spokenTexts));

  // ════════════════════════════════════════════════════════════════
  console.log('\n══ ⑫ 自発コールの契約は変えていない（回帰）══');
  // ════════════════════════════════════════════════════════════════
  {
    const F = sandbox.window.PitwallGapFreshness;
    const live = snapshot();
    const identity = {
      session_key: SK, generation: 3, source_kind: 'same_class_battle_gap',
      direction: 'behind', target_car_idx: 31, gap_s: 3.8, sampled_at: 1_700_000_000,
    };
    const swap = snapshot({ behind: { target_car_idx: 44 } });
    check('自発：対象車が変われば破棄（回答側と違う）',
      F.evaluate(identity, swap, fakeNow).fate === F.FATE_DISCARD);
    check('回答：同じ状況では最新値へ作り直す',
      F.evaluateAnswer([identity], swap, fakeNow, { liveAgeMs: 0 }).fate === F.FATE_REBUILD);
    check('自発：候補の年齢で破棄する',
      F.evaluate(identity, live, 1_700_000_000_000 + 6000).fate === F.FATE_DISCARD);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n══ ⑬ 出口の配線が外されたら落ちること（変異試験の受け皿）══');
  // ════════════════════════════════════════════════════════════════
  {
    const rendererSrc = fs.readFileSync(path.join(ROOT, 'desktop/renderer.html'), 'utf8');
    check('sendMsg が router の gapIdentities を speak へ渡す',
      /gapIdentities:\(Array\.isArray\(localIntent\.gapIdentities\)/.test(rendererSrc));
    check('speak が gapIdentities を queue item へ載せる',
      /gapIdentities:\(Array\.isArray\(o\.gapIdentities\)/.test(rendererSrc));
    check('drainQueue が evaluateAnswer を呼ぶ',
      /PitwallGapFreshness\.evaluateAnswer\(_it\.gapIdentities/.test(rendererSrc));
    check('drainQueue が現在 snapshot の年齢を渡す',
      /liveAgeMs:_liveAge/.test(rendererSrc));
    const routerSrc = fs.readFileSync(path.join(ROOT, 'desktop/local-intent-router.js'), 'utf8');
    check('router の両方の GAP 分岐が identity を返す（片方に抜け道を残さない）',
      (routerSrc.match(/gapAnswer\('nearest_gap'/g) || []).length >= 2);
    const F = sandbox.window.PitwallGapFreshness;
    check('回答側と再生側が同じ closed constant',
      F.MAX_AGE_MS === 5000 && /GAP_ANSWER_MAX_AGE_MS = 5000;/.test(routerSrc));
  }

  // ══ ★2026-09-05 第4回 Gate 4：実 drainQueue の統合replay ══
  //   Codex 指定：9/4 実走ログに最終TTS本文が無い代わりの必須証拠。
  //   local router → addMsg → speak → **実 drainQueue** →
  //   evaluateAnswer → rebuildAnswerText → finalizer → _it.text → TTS raw
  //   の順序が保たれ、Overlay・会話Box・実際にTTSへ渡った文が一致することを1本で通す。
  {
    console.log('\n══ 統合replay：実 drainQueue で回答が rebuild される ══');
    reset(); spokenTexts.length = 0;
    sandbox.__ovl = {}; sandbox.__ovlSeq = 0; sandbox._convoBox = null;
    Object.keys(sandbox.__store).forEach(k => delete sandbox.__store[k]);

    // 先行発話でキューを塞ぎ、回答を待たせる（実走の「queue待ちで陳腐化」を再現）
    sandbox.speak('先行発話。', { prio: sandbox.SPEAK_PRIO ? sandbox.SPEAK_PRIO.P1_HAZARD : 1,
      kind: 'reflex' });
    await sleep(5);

    await ask('後ろとのギャップは？');
    const answered = sandbox.speakQueue.filter(q => /local_/.test(q.kind || ''));
    // ★2026-09-06 ② 構造置換（Founder指示）：契約が変わった。
    //   旧「候補を先に表示 → TTS直前に作り替える」→
    //   新「authority確定 → 最終本文を1回生成 → Overlay・会話Box・TTS へ fan-out」。
    //   したがって **enqueue 時点では表示要素も Overlay 行も会話turnも存在しない**。
    check('統合① 回答が queue に入り uid を持つ（表示はまだ作らない）',
      answered.length === 1 && !!answered[0].utteranceId
      && answered[0].deferredRender === true && !answered[0].displayEl,
      JSON.stringify(answered.map(q => ({ k: q.kind, uid: q.utteranceId, el: !!q.displayEl,
        deferred: q.deferredRender }))));

    const it = answered[0];
    const candidateText = it.text;
    check('統合② 候補は Overlay にも会話Boxにも出ていない',
      Object.keys(sandbox.__ovl || {}).every(k => sandbox.__ovl[k].text !== candidateText)
      && !(JSON.parse(sandbox.__store[sandbox.CONVO_BOX_KEY] || 'null') || { turns: [] })
        .turns.some(t => t && t.text === candidateText),
      `cand=${candidateText} ovl=${JSON.stringify(sandbox.__ovl)}`);

    // 同じ車で値だけ動かして rebuild を起こす（既存テストと同じ作法）。
    fakeNow += 6000;
    sandbox.lastTelemetry = snapshot({ gap_behind: 0.6, behind: { gap_s: 0.6 } });
    sandbox.lastTelemetryAt = fakeNow;

    await finishCurrentUtterance();     // 先行発話を終わらせ、回答を実 drainQueue で処理させる
    await sleep(15);

    const finalTts = spokenTexts[spokenTexts.length - 1];
    // 表示要素・Overlay行・会話turn は **確定後にここで初めて**作られている。
    const ovlId = it.displayEl && it.displayEl._ovlId;
    const turnId = it.displayEl && it.displayEl._turnId;
    const boxNow = JSON.parse(sandbox.__store[sandbox.CONVO_BOX_KEY] || 'null');
    const turnNow = boxNow && (boxNow.turns.find(t => t.turn_id === turnId) || {}).text;
    const ovlNow = sandbox.__ovl[ovlId] && sandbox.__ovl[ovlId].text;
    check('統合③-d 確定後に表示要素・Overlay行・会話turnが作られる',
      !!it.displayEl && !!ovlId && !!turnId, `el=${!!it.displayEl} ovl=${ovlId} turn=${turnId}`);

    // ★rebuild が本当に起きたことを先に確かめる。起きていなければ ④ は
    //   「候補のまま一致した」だけで、rebuild 配線を何も証明しない。
    const rebuiltTrace = traces.filter(t => /GAP_ANSWER_FRESHNESS fate=rebuild/.test(t));
    check('統合③ 実 drainQueue で fate=rebuild が起きた', rebuiltTrace.length === 1,
      JSON.stringify(traces.filter(t => /GAP_ANSWER_FRESHNESS/.test(t))));
    check('統合③-b 最終本文は候補と別物', finalTts !== candidateText,
      `cand=${candidateText} final=${finalTts}`);
    check('統合③-c 実 drainQueue が TTS へ本文を渡した', typeof finalTts === 'string' && !!finalTts,
      String(finalTts));
    check('統合④ **Overlay＝会話Box＝TTSへ渡った本文**（同一uid）',
      !!finalTts && ovlNow === finalTts && turnNow === finalTts,
      `tts=${finalTts} ovl=${ovlNow} box=${turnNow}`);
    check('統合⑤ uid が queue item と表示要素で一致',
      it.utteranceId === it.displayEl._uid, `${it.utteranceId} / ${it.displayEl._uid}`);
    // ★第4回P1-4：LLM会話履歴に**古いGAP本文**が残ると、次のターンで Luna が
    //   自分の発言として古い数字を根拠に使う。
    const msgs = sandbox.messages || [];
    check('統合⑨ LLM会話履歴に古い候補本文が残らない',
      !msgs.some(m => m && m.role === 'assistant' && String(m.content) === candidateText),
      JSON.stringify(msgs.filter(m => m && m.role === 'assistant').map(m => m.content)));
    check('統合⑩ LLM会話履歴も最終本文になっている',
      msgs.some(m => m && m.role === 'assistant' && String(m.content) === finalTts),
      JSON.stringify(msgs.filter(m => m && m.role === 'assistant').map(m => m.content)));
  }

  // ══ 統合replay：stale discard で消え、次のqueueが進む ══
  {
    console.log('\n══ 統合replay：実 drainQueue の stale discard ══');
    reset(); spokenTexts.length = 0;
    sandbox.__ovl = {}; sandbox.__ovlSeq = 0; sandbox._convoBox = null;
    Object.keys(sandbox.__store).forEach(k => delete sandbox.__store[k]);

    sandbox.speak('先行発話。', { prio: 1, kind: 'reflex' });
    await sleep(5);
    await ask('後ろとのギャップは？');
    const it = sandbox.speakQueue.filter(q => /local_/.test(q.kind || ''))[0];
    const ovlId = it && it.displayEl && it.displayEl._ovlId;
    const turnId = it && it.displayEl && it.displayEl._turnId;

    // 対象車を入れ替えて discard を起こす（module 側の契約で fate=discard になる）
    // Date.now() は fakeNow に固定されている。live snapshot を契約(5秒)より古くする。
    sandbox.lastTelemetryAt = fakeNow - 60000;

    // 後続の発話を1本積んで「次が進む」ことを見る
    sandbox.speak('後続発話。', { prio: 4, kind: 'info' });

    await finishCurrentUtterance();
    await sleep(15);

    const boxNow = JSON.parse(sandbox.__store[sandbox.CONVO_BOX_KEY] || 'null');
    const turnGone = !boxNow || !boxNow.turns.some(t => t.turn_id === turnId);
    // ★2026-09-06 ② 構造置換：候補は**そもそも表示していない**ので「消える」ではなく
    //   「一度も出ていない」が新しい正解。旧契約（出してから removed:true にする）は
    //   一瞬だけ画面に出てから消える挙動そのものであり、置換の対象だった。
    check('統合⑥ stale discard では Overlay に一度も出ない',
      !ovlId && Object.keys(sandbox.__ovl || {}).every(
        k => !/後ろ[\d.]+秒/.test(String(sandbox.__ovl[k].text || ''))),   // ドライバーの質問文は対象外
      `ovlId=${ovlId} ovl=${JSON.stringify(sandbox.__ovl)}`);
    check('統合⑦ stale discard で会話Boxからも消える', turnGone,
      JSON.stringify(boxNow && boxNow.turns.map(t => t.turn_id)));
    const msgsD = sandbox.messages || [];
    check('統合⑧-b discard された回答は LLM会話履歴からも消える',
      !msgsD.some(m => m && m.role === 'assistant' && /後ろ/.test(String(m.content))),
      JSON.stringify(msgsD.filter(m => m && m.role === 'assistant').map(m => m.content)));
    check('統合⑧ discard 後も次のqueueが進む',
      spokenTexts.some(t => /後続発話/.test(t)) || sandbox.speakQueue.length === 0,
      JSON.stringify(spokenTexts));
  }

  // ══ ★第5回P1：LLM履歴を本文一致で触らない（別発話を巻き込まない）══
  //   Codex 反例：無線は pushMsg しない。それが drop された時、同文の
  //   **既存 assistant 発話**を消してはならない。
  {
    console.log('\n══ 第5回P1：同文の別発話を巻き込まない ══');
    reset(); resetSpoken();

    // ① 既存の assistant 履歴（別経路で積まれたもの）
    sandbox.pushMsg({ role: 'assistant', content: '右に車。' });
    const beforeLen = sandbox.messages.length;

    // ② 無線（injectRadio 相当）は履歴へ積まない。同じ本文で queue 化して drop する。
    const el = sandbox.addMsg('ai', '右に車。', { uid: sandbox.nextUtteranceId() });
    const radioItem = { text: '右に車。', kind: 'reflex', displayEl: el };   // messageId 無し
    sandbox.finalizeUtterance(radioItem, 'dropped', null, 'voice_off');

    check('P1① 履歴を積んでいない無線の drop で既存履歴が消えない',
      sandbox.messages.length === beforeLen
      && sandbox.messages.some(m => m.role === 'assistant' && m.content === '右に車。'),
      JSON.stringify(sandbox.messages.map(m => m.content)));

    // ③ queue待ち中に同文の assistant 発話が後から入っても、
    //    古い local GAP item は**自分の履歴だけ**を直す。
    reset(); resetSpoken();
    const elG = sandbox.addMsg('ai', '後ろ3.8秒。', { uid: sandbox.nextUtteranceId() });
    const midG = sandbox.pushMsg({ role: 'assistant', content: '後ろ3.8秒。' });
    const laterMid = sandbox.pushMsg({ role: 'assistant', content: '後ろ3.8秒。' });  // 同文の別発話
    // ★2026-09-06 ② 構造置換：`rebuilt` は**廃止**した（表示してから直す構造をやめた）。
    //   代わりに「終端が来るまで履歴に候補を積まない」ことと、
    //   drop が**自分の1件だけ**を消すことを検査する。同文の別発話は触らない、は不変。
    const gapItem = { text: '後ろ3.8秒。', kind: 'local_nearest_gap',
                      displayEl: elG, messageId: midG };
    sandbox.finalizeUtterance(gapItem, 'spoken', '後ろ3.8秒。');
    const own = sandbox.messages.find(m => m._mid === midG);
    const other = sandbox.messages.find(m => m._mid === laterMid);
    check('P1② spoken は履歴を書き換えない（確定本文が既に入っている）',
      own && own.content === '後ろ3.8秒。', JSON.stringify(own));
    check('P1②-b rebuilt 分岐が製品から消えている',
      !/outcome === 'rebuilt'/.test(fs.readFileSync(path.join(ROOT, 'desktop/renderer.html'), 'utf8')),
      '表示後に本文を差し替える分岐が残っている');
    check('P1③ 同文の別発話は触らない',
      other && other.content === '後ろ3.8秒。', JSON.stringify(other));

    // ④ drop も同じ
    const gapItem2 = { text: '後ろ0.6秒。', kind: 'local_nearest_gap',
                       displayEl: elG, messageId: midG };
    sandbox.finalizeUtterance(gapItem2, 'dropped', null, 'gap_answer_stale');
    check('P1④ drop も自分の履歴だけを消す',
      !sandbox.messages.some(m => m._mid === midG)
      && sandbox.messages.some(m => m._mid === laterMid),
      JSON.stringify(sandbox.messages.map(m => ({ id: m._mid, c: m.content }))));

    // ⑤ local intent 出口が実際に messageId を渡しているか（配線）
    const _rsrc = fs.readFileSync(path.join(ROOT, 'desktop/renderer.html'), 'utf8');
    // ★構造置換後：GAP を含む回答は enqueue 時に履歴へ積まない（`_ansIsGap ? null : pushMsg`）。
    //   確定後の materialize で `_it.messageId = pushMsg(...)` を割り当てる。
    //   非GAPの回答は従来どおり enqueue 時に積む。両方を名指しで検査する。
    check('P1⑤ 非GAP回答は enqueue 時に messageId を speak へ渡す',
      /const _ansMsgId = _ansIsGap \? null : pushMsg\(\{role:'assistant',content:reply\}\);/.test(_rsrc)
      && /messageId:_ansMsgId,/.test(_rsrc));
    check('P1⑤-b GAP回答は確定後に履歴へ積む',
      /_it\.messageId = pushMsg\(\{role:'assistant',content:_ansFinal\}\);/.test(_rsrc));
    check('P1⑥ finalizer は messageId が無ければ messages を触らない',
      /if\(item\.messageId\) removeMessageById\(item\.messageId\);/.test(_rsrc)
      && !/amendMessageById\(item\.messageId, finalText\)/.test(_rsrc));
  }

  console.log(`\nGap answer queue: ${pass}/${pass + fail}`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
