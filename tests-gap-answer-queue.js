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
  addMsg: () => {}, pushMsg: () => {}, usageCount: () => {},
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
vm.createContext(sandbox);

// 本物のモジュールを本番と同じ形（window.*）で読み込む
function loadModule(file) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
}
loadModule('desktop/local-intent-router.js');
loadModule('desktop/gap-freshness.js');
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
  sandbox.lastTelemetry = snapshot(); sandbox.lastTelemetryAt = fakeNow;
  sandbox.pendingLunaSelfMemoryConfirmation = null;
  sandbox.pendingDecisionDispute = null;
  sandbox.pendingDrivingStyleAdvice = null;
}

/** ドライバーが喋る（本番 sendMsg を実行する）。 */
async function ask(text) {
  sandbox.document = { getElementById: () => ({ value: text, style: {} }) };
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

  console.log(`\nGap answer queue: ${pass}/${pass + fail}`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
