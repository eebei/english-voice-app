#!/usr/bin/env node
/**
 * ★P1-1 実プロダクト試験（Codex差戻し対応版）
 *
 * Bridge → renderer (実 saveSessionSummary を VM 抽出) → localStorage
 *        → router (実 route) → sessionMemory (実 answerPreviousFuel)
 * の完全往復を実関数で検証。コピーコード禁止・実抽出/実import必須。
 *
 * ★Codex差戻し要点（2026-09-10）：
 * 1. session_summary の保存処理が「現在 driver identity」を上書きしてはならない。
 *    現在 identity の唯一の入口は telemetry_live。今回のテストはその分離を
 *    「別 driver の summary が到達しても現在 identity は不変」で直接 assert する。
 * 2. saveSessionSummary は renderer.html から VM 抽出した本物の関数本体を使う
 *    （テスト内の自作最小実装は使わない）。
 * 3. summary 未受信でも現在 telemetry の cust_id だけで質問が成立することを検証する。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

// ★実 session-memory.js を require（UMD factory 呼び出し済み）
const sessionMemory = require('./desktop/session-memory.js');

// ★実 local-intent-router.js を require（UMD factory 呼び出し済み）
const router = require('./desktop/local-intent-router.js');

// ========================================
// renderer.html から実関数をブレースカウント方式で抽出
// ========================================
const rendererSrc = fs.readFileSync(path.join(__dirname, 'desktop/renderer.html'), 'utf8');

function extractFunction(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found in renderer.html`);
  let i = src.indexOf('{', start);
  if (i === -1) throw new Error(`function ${name} body not found`);
  let depth = 0;
  let end = -1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error(`function ${name} unbalanced braces`);
  return src.slice(start, end);
}

const fnSaveSessionSummary = extractFunction(rendererSrc, 'saveSessionSummary');
const fnSanitizeSessionEvidence = extractFunction(rendererSrc, 'sanitizeSessionEvidence');
const fnValidFinishPosition = extractFunction(rendererSrc, 'validFinishPosition');
const fnCurrentMemoryUserId = extractFunction(rendererSrc, 'currentMemoryUserId');
// ★残件1続き：旧記録への永続ID付与マイグレーションを実装した実関数
const fnLoadRaceHistory = extractFunction(rendererSrc, 'loadRaceHistory');

console.log('★実 renderer.html から抽出した関数（コピー禁止・本文一致）:');
console.log(`  saveSessionSummary: ${fnSaveSessionSummary.length} chars`);
console.log(`  sanitizeSessionEvidence: ${fnSanitizeSessionEvidence.length} chars`);
console.log(`  validFinishPosition: ${fnValidFinishPosition.length} chars`);
console.log(`  currentMemoryUserId: ${fnCurrentMemoryUserId.length} chars`);
console.log(`  loadRaceHistory: ${fnLoadRaceHistory.length} chars`);

// ========================================
// VM コンテキスト構築（renderer.html の依存を stub 化）
// ========================================
// fixedNowMs を渡すと Date.now()/new Date() が常に同じ時刻を返す（recordedAt衝突の再現用）。
// crypto も渡さない（saveSessionSummaryのcrypto未定義フォールバックを使う）。
function makeRendererContext(fixedNowMs) {
  const store = {};
  const localStorage = {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
  };
  let EffectiveDate = Date;
  if (typeof fixedNowMs === 'number') {
    EffectiveDate = class extends Date {
      constructor(...args) { if (!args.length) super(fixedNowMs); else super(...args); }
      static now() { return fixedNowMs; }
    };
  }
  const sandbox = {
    localStorage,
    console,
    JSON,
    Number,
    String,
    Array,
    Object,
    Date: EffectiveDate,
    Math,
    isNaN,
    parseFloat,
    // ★本番のElectron環境と同じcrypto.randomUUID()経路を通す（未定義フォールバックだけでなく）
    crypto: { randomUUID: () => nodeCrypto.randomUUID() },
    // ★現在 driver identity の唯一の入口。renderer.html の本物の変数名と同じ。
    //   session_summary 処理からは絶対に書き換えられないことを、この fixture で証明する。
    lastTelemetry: null,
    lastTrack: '',
    lastCarModel: '',
    lastCarClass: '',
    lastSessionType: null,
    lastSessionAuthority: null,
    lastIrating: null,
    lastSr: null,
    lastSessionNum: null,
    currentSessionCustId: null,
    saveMemory: () => {},  // 会話メモリ保存は本テストの対象外（no-op stub）
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    ${fnValidFinishPosition}
    ${fnSanitizeSessionEvidence}
    ${fnCurrentMemoryUserId}
    ${fnSaveSessionSummary}
    ${fnLoadRaceHistory}
  `, sandbox);
  return sandbox;
}

// ========================================
// ★Codex差戻し対応：実 irBridge.onmessage ハンドラを抽出して実行
//
// 前回までの fixture は currentSessionCustId や router.live を試験内で直接
// 代入していた。これは「入口の証明」にならない（Codex指摘）。ここでは
// renderer.html の websocket onmessage ハンドラ本体を実際にVM実行し、
// telemetry_live / session_summary の実イベントを送って動作を確認する。
//
// onmessage は 247行・膨大な周辺関数（bridgeVoice/observePitState/…）に
// 依存するため、Proxy コンテキストで「未知の識別子＝呼べば第一引数を
// そのまま返す no-op」として動的に解決する。cust_id の配線に関わる
// 変数（lastTelemetry, currentSessionCustId 等）と saveSessionSummary
// 系の実関数、localStorage だけを本物として注入する。
// ========================================
function extractArrowAssignment(src, marker) {
  const idx = src.indexOf(marker);
  if (idx === -1) throw new Error(`marker not found: ${marker}`);
  const start = idx + marker.length;
  let i = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error(`unbalanced braces for marker: ${marker}`);
  return src.slice(start, end);  // '(e)=>{ ... }'
}

const fnOnMessage = extractArrowAssignment(rendererSrc, 'irBridge.onmessage=');
console.log(`  irBridge.onmessage (実 websocket ハンドラ): ${fnOnMessage.length} chars`);

function makeOnMessageContext() {
  const store = {};
  const localStorage = {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
  };
  const state = {
    console, JSON, Number, String, Array, Object, Date, Math, isNaN, parseFloat, RegExp, Boolean,
    localStorage,
    // ★現在 driver identity の唯一の入口。実 onmessage 内の telemetry_live 分岐だけが書ける。
    lastTelemetry: null, lastTrack: '', lastCarModel: '', lastCarClass: '',
    lastSessionType: null, lastSessionAuthority: null, lastIrating: null, lastSr: null,
    lastSessionNum: null, currentSessionCustId: null,
    iracingDetected: false, iracingLive: false, usageIracingLive: false,
    iracingConnectedAt: 0, lastTelemetryAt: 0, telemetryStaleNotified: false, iracingConnectionSeen: false,
    bridgeConnected: false, TELEMETRY_STALE_MS: 10000,
    saveMemory: () => {},
  };
  const handler = {
    has() { return true; },
    get(target, key) {
      if (typeof key === 'symbol') return undefined;
      if (key in target) return target[key];
      // 未知の識別子（周辺関数）は呼ばれても no-op・第一引数 pass-through
      return function (arg) { return arg; };
    },
    set(target, key, value) { target[key] = value; return true; },
  };
  const proxy = new Proxy(state, handler);
  vm.createContext(proxy);
  vm.runInContext(`
    ${fnValidFinishPosition}
    ${fnSanitizeSessionEvidence}
    ${fnCurrentMemoryUserId}
    ${fnSaveSessionSummary}
  `, proxy);
  const onmessage = vm.runInContext(fnOnMessage, proxy);
  return { state, localStorage, onmessage };
}

function sendWs(onmessage, payload) {
  onmessage({ data: JSON.stringify(payload) });
}

// ========================================
// テスト実行
// ========================================

console.log('\n━━ PROD TEST: 実プロダクト往復（実 renderer 関数使用）━━\n');

const ctx = makeRendererContext();

// Step 1: Bridge が Spa session_summary を送信
console.log('Step 1: Bridge session_summary');
const bridgeData = {
  cust_id: 315555,
  track: 'Spa-Francorchamps',
  car_class: 'GT3',
  car_model: 'Mercedes-AMG GT3 2020',
  pit_events: [
    { entry_lap: 9, exit_lap: 10, fuel_added_l: 26.83, lane_total_s: 35.2, stall_s: 8.5 },
  ],
  checker_fuel_l: 3.9,  // ★freeze 値
  official_result_arrived: true,
};
console.log(`  cust_id: ${bridgeData.cust_id}`);
console.log(`  pit_events[0].entry_lap: ${bridgeData.pit_events[0].entry_lap}`);
console.log(`  pit_events[0].exit_lap: ${bridgeData.pit_events[0].exit_lap}`);
console.log(`  pit_events[0].fuel_added_l: ${bridgeData.pit_events[0].fuel_added_l}`);
console.log(`  checker_fuel_l: ${bridgeData.checker_fuel_l}`);

// Step 2: 実 renderer.saveSessionSummary で localStorage に保存
console.log('\nStep 2: 実 renderer.saveSessionSummary（VM抽出・本物）');
ctx.saveSessionSummary(bridgeData);
const raceHistory1 = JSON.parse(ctx.localStorage.getItem('pw_raceHistory') || '[]');
const savedRecord = raceHistory1[raceHistory1.length - 1];
console.log(`  Saved record:`, JSON.stringify(savedRecord, null, 2));

assert.strictEqual(savedRecord.custId, 315555, 'custId mismatch');
assert.strictEqual(savedRecord.car, 'Mercedes-AMG GT3 2020', 'car mismatch');
assert.strictEqual(savedRecord.carClass, 'GT3', 'carClass mismatch');
assert.strictEqual(savedRecord.pitEntryLap, 9, 'pitEntryLap mismatch');
assert.strictEqual(savedRecord.pitExitLap, 10, 'pitExitLap mismatch');
assert.strictEqual(savedRecord.fuelAtPitEntry, 26.83, 'fuelAtPitEntry mismatch');
assert.strictEqual(savedRecord.fuelAtFinish, 3.9, 'fuelAtFinish mismatch');

// Step 3: localStorage から pw_raceHistory を再読込
console.log('\nStep 3: localStorage 再読込');
const raceHistory = JSON.parse(ctx.localStorage.getItem('pw_raceHistory') || '[]');
console.log(`  Loaded records count: ${raceHistory.length}`);
assert.strictEqual(raceHistory.length, 1, 'record count mismatch');

// Step 4: 実 router.route() で「前回給油は？」に回答
console.log('\nStep 4: 実 router.route() で前回給油質問');
const fuelAnswer = router.route({
  text: '前回給油は？',
  lang: 'ja',
  live: { cust_id: 315555, track: 'Spa-Francorchamps', car_class: 'GT3', car_model: 'Mercedes-AMG GT3 2020' },
  raceHistory: raceHistory,
  sessionMemory: sessionMemory,
});
console.log(`  Result:`, JSON.stringify(fuelAnswer, null, 2));

assert.strictEqual(fuelAnswer.handled, true, 'handled should be true');
assert.strictEqual(fuelAnswer.intent, 'previous_fuel_reference', 'intent mismatch');
assert.strictEqual(
  fuelAnswer.reply,
  '前回は9周終了後に入り、26.83L給油。チェッカー時3.9L残。',
  'reply mismatch'
);

console.log('\n✓ PROD TEST PASSED: 実プロダクト往復確認\n');

// ========================================
// ★Codex差戻し核心テスト：summary保存が現在identityを上書きしないこと
// ========================================
console.log('━━ ★核心テスト: summary保存は現在driver identityを変更しない ━━\n');

{
  const ctx2 = makeRendererContext();
  // 現在の driver は telemetry 経由で cust_id=999999 として identity 確立済み、とする
  ctx2.currentSessionCustId = 999999;
  ctx2.lastTelemetry = { cust_id: 999999, laps_total: 20 };

  // 別 driver（cust_id=315555）の過去レース summary が届く（チーム交代・観戦等で有り得る）
  ctx2.saveSessionSummary(bridgeData);  // bridgeData.cust_id === 315555

  assert.strictEqual(
    ctx2.currentSessionCustId, 999999,
    'FAIL: summary保存が現在driver identity(currentSessionCustId)を書き換えた'
  );
  assert.strictEqual(
    ctx2.lastTelemetry.cust_id, 999999,
    'FAIL: summary保存が lastTelemetry.cust_id を書き換えた'
  );
  console.log('  ✓ 別driverのsummary保存後も現在identity(999999)は不変');
}

// ========================================
// ★Codex差戻し核心テスト：summary未受信でも現在telemetryのcust_idだけで質問成立
// ========================================
console.log('\n━━ ★核心テスト: summary未受信でも現在telemetryのcust_idで質問成立 ━━\n');

{
  const ctx3 = makeRendererContext();
  // 今回セッションでは summary が一度も来ていない（走行中に質問された想定）。
  // 現在 driver identity は telemetry_live からのみ確立される。
  ctx3.currentSessionCustId = 315555;

  // ただし過去の別セッションの履歴（前回レース）は localStorage に既にあるとする
  ctx3.saveSessionSummary(bridgeData);
  const priorHistory = JSON.parse(ctx3.localStorage.getItem('pw_raceHistory') || '[]');

  const midRaceAnswer = router.route({
    text: '前回給油は？',
    lang: 'ja',
    live: { cust_id: ctx3.currentSessionCustId, track: 'Spa-Francorchamps', car_class: 'GT3', car_model: 'Mercedes-AMG GT3 2020' },
    raceHistory: priorHistory,
    sessionMemory: sessionMemory,
  });
  assert.strictEqual(midRaceAnswer.handled, true);
  assert.strictEqual(midRaceAnswer.intent, 'previous_fuel_reference', 'summary未受信中でも現在telemetryのcust_idで正答できるべき');
  console.log('  ✓ summary未受信でも現在telemetry cust_idのみで前回記録に正答');
}

// ========================================
// 追加テスト：別driver、別track、pending、本人不明、公式未確認
// ========================================

console.log('\n━━ Additional Tests（実 renderer 関数使用）━━\n');

// Test: 別driver（cust_id 不一致）
console.log('Test: 別driver拒否（cust_id=999999）');
{
  const ctx4 = makeRendererContext();
  ctx4.saveSessionSummary(bridgeData);
  const h = JSON.parse(ctx4.localStorage.getItem('pw_raceHistory') || '[]');
  const wrongDriverAnswer = router.route({
    text: '前回給油は？',
    lang: 'ja',
    live: { cust_id: 999999, track: 'Spa-Francorchamps', car_class: 'GT3', car_model: 'Mercedes-AMG GT3 2020' },
    raceHistory: h,
    sessionMemory: sessionMemory,
  });
  assert.strictEqual(wrongDriverAnswer.handled, true);
  assert.strictEqual(wrongDriverAnswer.intent, 'previous_fuel_unavailable', 'should reject different driver');
  console.log('  ✓ Rejected');
}

// Test: 別track
console.log('\nTest: 別track拒否');
{
  const ctx5 = makeRendererContext();
  const differentTrackData = { ...bridgeData, track: 'Monza' };
  ctx5.saveSessionSummary(differentTrackData);
  const h = JSON.parse(ctx5.localStorage.getItem('pw_raceHistory') || '[]');
  const wrongTrackAnswer = router.route({
    text: '前回給油は？',
    lang: 'ja',
    live: { cust_id: 315555, track: 'Spa-Francorchamps', car_class: 'GT3', car_model: 'Mercedes-AMG GT3 2020' },
    raceHistory: h,
    sessionMemory: sessionMemory,
  });
  assert.strictEqual(wrongTrackAnswer.handled, true);
  assert.strictEqual(wrongTrackAnswer.intent, 'previous_fuel_unavailable', 'should reject different track');
  console.log('  ✓ Rejected');
}

// Test: 別車種（同クラス・別モデル）
console.log('\nTest: 別車種拒否（同クラス・別モデル）');
{
  const ctx5b = makeRendererContext();
  ctx5b.saveSessionSummary(bridgeData);
  const h = JSON.parse(ctx5b.localStorage.getItem('pw_raceHistory') || '[]');
  const wrongCarAnswer = router.route({
    text: '前回給油は？',
    lang: 'ja',
    live: { cust_id: 315555, track: 'Spa-Francorchamps', car_class: 'GT3', car_model: 'BMW M4 GT3' },
    raceHistory: h,
    sessionMemory: sessionMemory,
  });
  assert.strictEqual(wrongCarAnswer.handled, true);
  assert.strictEqual(wrongCarAnswer.intent, 'previous_fuel_unavailable', 'should reject different car model');
  console.log('  ✓ Rejected');
}

// Test: official_result_arrived=false
console.log('\nTest: pending拒否（official_result_arrived=false）');
{
  const ctx6 = makeRendererContext();
  const pendingData = { ...bridgeData, official_result_arrived: false };
  ctx6.saveSessionSummary(pendingData);
  const h = JSON.parse(ctx6.localStorage.getItem('pw_raceHistory') || '[]');
  const pendingAnswer = router.route({
    text: '前回給油は？',
    lang: 'ja',
    live: { cust_id: 315555, track: 'Spa-Francorchamps', car_class: 'GT3', car_model: 'Mercedes-AMG GT3 2020' },
    raceHistory: h,
    sessionMemory: sessionMemory,
  });
  assert.strictEqual(pendingAnswer.handled, true);
  assert.strictEqual(pendingAnswer.intent, 'previous_fuel_pending', 'should reject pending result');
  console.log('  ✓ Rejected');
}

// Test: official_result_arrived 欠損（undefined）
console.log('\nTest: pending拒否（official_result_arrived 欠損）');
{
  const ctx6b = makeRendererContext();
  const { official_result_arrived, ...noFlagData } = bridgeData;
  ctx6b.saveSessionSummary(noFlagData);
  const h = JSON.parse(ctx6b.localStorage.getItem('pw_raceHistory') || '[]');
  const noFlagAnswer = router.route({
    text: '前回給油は？',
    lang: 'ja',
    live: { cust_id: 315555, track: 'Spa-Francorchamps', car_class: 'GT3', car_model: 'Mercedes-AMG GT3 2020' },
    raceHistory: h,
    sessionMemory: sessionMemory,
  });
  assert.strictEqual(noFlagAnswer.handled, true);
  assert.strictEqual(noFlagAnswer.intent, 'previous_fuel_pending', 'undefined official flag should not be treated as confirmed');
  console.log('  ✓ Rejected');
}

// Test: 本人不明（cust_id=null）
console.log('\nTest: 本人不明拒否（cust_id=null）');
{
  const ctx7 = makeRendererContext();
  ctx7.saveSessionSummary(bridgeData);
  const h = JSON.parse(ctx7.localStorage.getItem('pw_raceHistory') || '[]');
  const unknownPersonAnswer = router.route({
    text: '前回給油は？',
    lang: 'ja',
    live: { cust_id: null, track: 'Spa-Francorchamps', car_class: 'GT3', car_model: 'Mercedes-AMG GT3 2020' },
    raceHistory: h,
    sessionMemory: sessionMemory,
  });
  assert.strictEqual(unknownPersonAnswer.handled, true);
  assert.strictEqual(unknownPersonAnswer.intent, 'previous_fuel_unavailable', 'should reject unknown driver');
  console.log('  ✓ Rejected');
}

// Test: lastTelemetry=null での保存欠陥再現チェック（Codex前回指摘の回帰防止）
console.log('\nTest: lastTelemetry=null でも保存が成功する（回帰防止）');
{
  const ctx8 = makeRendererContext();
  ctx8.lastTelemetry = null;
  ctx8.saveSessionSummary(bridgeData);
  const h = JSON.parse(ctx8.localStorage.getItem('pw_raceHistory') || '[]');
  assert.strictEqual(h.length, 1, 'lastTelemetry=null でも履歴が保存されるべき');
  assert.strictEqual(h[0].custId, 315555);
  console.log('  ✓ lastTelemetry=null でも保存 1件（0件バグの回帰なし）');
}

// ========================================
// ★Codex差戻し核心テスト：実 websocket onmessage ハンドラを経由した入口証明
//   （currentSessionCustId / route.live を試験から直接代入するのではなく、
//    実際の telemetry_live / session_summary イベントを送って検証する）
// ========================================
console.log('\n━━ ★核心テスト: 実 onmessage イベント経由（試験からの直接代入なし）━━\n');

// Test: telemetry_live 受信で現在 driver identity が確立する
console.log('Test: 実telemetry_liveイベントで currentSessionCustId が確立');
{
  const { state, onmessage } = makeOnMessageContext();
  assert.strictEqual(state.currentSessionCustId, null, '受信前は未確立であるべき');
  sendWs(onmessage, { type: 'telemetry_live', cust_id: 999999, laps_total: 20 });
  assert.strictEqual(state.currentSessionCustId, 999999, '実telemetry_liveイベントでidentityが確立するべき');
  console.log('  ✓ telemetry_live受信 → currentSessionCustId=999999');
}

// Test: 別driverの実session_summaryイベント受信後も現在identityは不変
console.log('\nTest: 実session_summaryイベント（別driver）受信後も現在identity不変');
{
  const { state, localStorage, onmessage } = makeOnMessageContext();
  sendWs(onmessage, { type: 'telemetry_live', cust_id: 999999, laps_total: 20 });
  sendWs(onmessage, {
    type: 'session_summary', cust_id: 315555, track: 'Spa-Francorchamps',
    car_class: 'GT3', car_model: 'Mercedes-AMG GT3 2020',
    pit_events: [{ entry_lap: 9, exit_lap: 10, fuel_added_l: 26.83 }],
    checker_fuel_l: 3.9, official_result_arrived: true, is_race: true,
  });
  assert.strictEqual(state.currentSessionCustId, 999999,
    '別driver(315555)のsummary受信後も現在identity(999999)は不変であるべき');
  const h = JSON.parse(localStorage.getItem('pw_raceHistory') || '[]');
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].custId, 315555, '過去記録には別driverのcust_idがそのまま保存されるべき');
  console.log('  ✓ 実イベント経由でも: 現在identity=999999不変 かつ 履歴custId=315555で保存');
}

// Test: summary 未受信の状態でも、実 telemetry_live だけで前回記録に正答できる
console.log('\nTest: 実イベント経由 — summary未受信でも現在telemetryのcust_idで前回記録に正答');
{
  const { state, localStorage, onmessage } = makeOnMessageContext();
  // 過去の別セッションで既にrace historyがある状態を模す（今回セッションのsummaryではない）
  sendWs(onmessage, {
    type: 'session_summary', cust_id: 315555, track: 'Spa-Francorchamps',
    car_class: 'GT3', car_model: 'Mercedes-AMG GT3 2020',
    pit_events: [{ entry_lap: 9, exit_lap: 10, fuel_added_l: 26.83 }],
    checker_fuel_l: 3.9, official_result_arrived: true, is_race: true,
  });
  // 新しいコンテキスト（=新規起動）で、今回は summary を一度も受けず telemetry のみ
  const fresh = makeOnMessageContext();
  fresh.localStorage.setItem('pw_raceHistory', localStorage.getItem('pw_raceHistory'));
  sendWs(fresh.onmessage, { type: 'telemetry_live', cust_id: 315555, laps_total: 20 });
  assert.strictEqual(fresh.state.currentSessionCustId, 315555);

  const h = JSON.parse(fresh.localStorage.getItem('pw_raceHistory') || '[]');
  const midRaceAnswer = router.route({
    text: '前回給油は？',
    lang: 'ja',
    live: { cust_id: fresh.state.currentSessionCustId, track: 'Spa-Francorchamps', car_class: 'GT3', car_model: 'Mercedes-AMG GT3 2020' },
    raceHistory: h,
    sessionMemory: sessionMemory,
  });
  assert.strictEqual(midRaceAnswer.handled, true);
  assert.strictEqual(midRaceAnswer.intent, 'previous_fuel_reference');
  console.log('  ✓ 新規起動→summary未受信→telemetry_liveのみで前回記録に正答');
}

// Test: disputed拒否（ドライバーが「それ違う」と訂正した記録は使わない）
console.log('\nTest: disputed拒否（record.disputed=true）');
{
  const ctx9 = makeRendererContext();
  ctx9.saveSessionSummary(bridgeData);
  const h = JSON.parse(ctx9.localStorage.getItem('pw_raceHistory') || '[]');
  // 実運用ではドライバー訂正フローが history 上の record.disputed を true にする
  // （renderer側の訂正保存パス）。ここでは保存後の record にその状態を模して
  // 実 sessionMemory.answerPreviousFuel の disputed 除外ロジックを検証する。
  h[0].disputed = true;
  const disputedAnswer = router.route({
    text: '前回給油は？',
    lang: 'ja',
    live: { cust_id: 315555, track: 'Spa-Francorchamps', car_class: 'GT3', car_model: 'Mercedes-AMG GT3 2020' },
    raceHistory: h,
    sessionMemory: sessionMemory,
  });
  assert.strictEqual(disputedAnswer.handled, true);
  assert.strictEqual(disputedAnswer.intent, 'previous_fuel_unavailable', 'disputed record を正答に使ってはいけない');
  console.log('  ✓ disputed=true の記録は無視され、正答に使われない');
}

// ========================================
// ★Codex差戻し（残件1）核心テスト：recordedAt（ミリ秒精度）が衝突しても
//   raceRecordId で正しく区別できることを実処理で反証する。
//
//   Codexの独立反証：「同じrecordedAt・同driver/car、Monza/subsessionId=101と
//   Spa/subsessionId=202の2recordを渡す。各trackへの質問はそれぞれ
//   previous_fuel_referenceとなるが、action.raceRecordIdは両方同じISO時刻だった」
//   （旧実装：recordedAtをそのままraceRecordIdとして採用していたための衝突）
// ========================================
console.log('\n━━ ★核心テスト: recordedAt衝突でも raceRecordId は一意（残件1） ━━\n');

{
  // 固定時刻＝recordedAtを意図的に衝突させる。router側のisFreshRecord(90日以内)チェックに
  // 弾かれないよう、実際の「現在時刻」に近い値を使う。
  const FIXED_NOW = Date.now();
  const ctx10 = makeRendererContext(FIXED_NOW);
  // 同一driver・同一car、同一recordedAtになる条件でMonza→Spaの順に保存
  ctx10.saveSessionSummary({
    cust_id: 999999, track: 'Monza', car_class: 'GT3', car_model: 'Mercedes-AMG GT3 2020',
    subsession_id: 101,
    pit_events: [{ entry_lap: 12, exit_lap: 13, fuel_added_l: 30.5 }],
    checker_fuel_l: 2.1, official_result_arrived: true,
  });
  ctx10.saveSessionSummary({
    cust_id: 999999, track: 'Spa-Francorchamps', car_class: 'GT3', car_model: 'Mercedes-AMG GT3 2020',
    subsession_id: 202,
    pit_events: [{ entry_lap: 9, exit_lap: 10, fuel_added_l: 26.83 }],
    checker_fuel_l: 3.9, official_result_arrived: true,
  });
  const h10 = JSON.parse(ctx10.localStorage.getItem('pw_raceHistory') || '[]');
  const monza10 = h10.find(r => r.track === 'Monza');
  const spa10 = h10.find(r => r.track === 'Spa-Francorchamps');

  assert.strictEqual(monza10.recordedAt, spa10.recordedAt,
    '前提確認：recordedAtは意図通り衝突している（FIXED_NOW固定のため）');
  console.log('  前提確認：recordedAtは意図通り衝突（両方とも同一時刻）:', monza10.recordedAt);

  assert.notStrictEqual(monza10.raceRecordId, spa10.raceRecordId,
    'recordedAtが衝突していてもraceRecordIdは一意であるべき（crypto.randomUUID経由）');
  console.log('  ✓ raceRecordIdは衝突せず区別できる: Monza=' + monza10.raceRecordId + ' Spa=' + spa10.raceRecordId);

  // Spaで質問した時、action.raceRecordIdがSpaのraceRecordIdと一致し、Monzaとは異なること
  const spaAnswer = router.route({
    text: '前回給油は？', lang: 'ja',
    live: { cust_id: 999999, track: 'Spa-Francorchamps', car_class: 'GT3', car_model: 'Mercedes-AMG GT3 2020' },
    raceHistory: h10, sessionMemory: sessionMemory,
  });
  assert.strictEqual(spaAnswer.handled, true);
  assert.strictEqual(spaAnswer.intent, 'previous_fuel_reference');
  assert.strictEqual(spaAnswer.action.raceRecordId, spa10.raceRecordId,
    'Spa質問の回答action.raceRecordIdはSpaのraceRecordIdと一致すべき');
  assert.notStrictEqual(spaAnswer.action.raceRecordId, monza10.raceRecordId,
    'recordedAt衝突下でも、Spa質問の回答がMonzaのIDを指してはいけない');
  console.log('  ✓ Spa質問の action.raceRecordId が正しくSpaを指す（Monzaと衝突しない）:', spaAnswer.action.raceRecordId);

  // Monzaで質問した時も同様に検証（双方向で取り違えないことの確認）
  const monzaAnswer = router.route({
    text: '前回給油は？', lang: 'ja',
    live: { cust_id: 999999, track: 'Monza', car_class: 'GT3', car_model: 'Mercedes-AMG GT3 2020' },
    raceHistory: h10, sessionMemory: sessionMemory,
  });
  assert.strictEqual(monzaAnswer.handled, true);
  assert.strictEqual(monzaAnswer.intent, 'previous_fuel_reference');
  assert.strictEqual(monzaAnswer.action.raceRecordId, monza10.raceRecordId,
    'Monza質問の回答action.raceRecordIdはMonzaのraceRecordIdと一致すべき');
  assert.notStrictEqual(monzaAnswer.action.raceRecordId, spa10.raceRecordId);
  console.log('  ✓ Monza質問の action.raceRecordId が正しくMonzaを指す（Spaと衝突しない）:', monzaAnswer.action.raceRecordId);
}

// 再読込で raceRecordId が変わらないこと（保存時に一度だけ生成・以後は固定）
console.log('\nTest: 再読込しても raceRecordId は変わらない（保存時に一度だけ生成）');
{
  const ctx11 = makeRendererContext();
  ctx11.saveSessionSummary(bridgeData);
  const firstRead = JSON.parse(ctx11.localStorage.getItem('pw_raceHistory') || '[]');
  const idAfterFirstRead = firstRead[0].raceRecordId;
  // 「再読込」＝同じlocalStorageから再度JSON.parseするだけ（saveSessionSummaryは呼ばない）
  const secondRead = JSON.parse(ctx11.localStorage.getItem('pw_raceHistory') || '[]');
  const idAfterSecondRead = secondRead[0].raceRecordId;
  assert.strictEqual(idAfterFirstRead, idAfterSecondRead, '再読込でraceRecordIdが変化してはいけない');
  assert.ok(idAfterFirstRead, 'raceRecordIdは生成されているべき');
  console.log('  ✓ raceRecordId は再読込後も同一:', idAfterFirstRead);
}

// ========================================
// ★Codex差戻し（残件1続き）核心テスト：旧記録（raceRecordId未付与）への
//   読込時マイグレーション。既存本文・燃料値・既存raceRecordIdは変更しない。
//   旧2件の同recordedAt衝突がマイグレーション後に解消されること、
//   再読込後も不変であること、route→action.raceRecordIdの採用一致を検証する。
// ========================================
console.log('\n━━ ★核心テスト: loadRaceHistory() が旧記録へ永続IDを一度だけ付与（残件1続き） ━━\n');

{
  const ctx12 = makeRendererContext();
  const SAME_RECORDED_AT = new Date().toISOString();
  // 旧形式（raceRecordId無し）のMonza/Spa記録＋既存ID付きのRoad America記録を
  // localStorageへ直接注入する（本修正より前に保存されたデータを模す）。
  const existingId = 'existing-id-should-not-change-12345';
  const legacyHistory = [
    { // 旧形式：raceRecordIdフィールド自体が存在しない
      date: '2026-09-01', recordedAt: SAME_RECORDED_AT, userId: null, custId: 999999,
      subsessionId: 101, track: 'Monza', car: 'Mercedes-AMG GT3 2020', carClass: 'GT3',
      pitEntryLap: 12, pitExitLap: 13, fuelAtPitEntry: 30.5, fuelAtFinish: 2.1,
      official_result_arrived: true,
    },
    { // 旧形式：同じrecordedAt（衝突条件）
      date: '2026-09-01', recordedAt: SAME_RECORDED_AT, userId: null, custId: 999999,
      subsessionId: 202, track: 'Spa-Francorchamps', car: 'Mercedes-AMG GT3 2020', carClass: 'GT3',
      pitEntryLap: 9, pitExitLap: 10, fuelAtPitEntry: 26.83, fuelAtFinish: 3.9,
      official_result_arrived: true,
    },
    { // 既にraceRecordIdを持つ記録（マイグレーション対象外・上書き禁止）
      date: '2026-08-15', recordedAt: '2026-08-15T10:00:00.000Z', userId: null, custId: 999999,
      subsessionId: 303, track: 'Road America', car: 'Mercedes-AMG GT3 2020', carClass: 'GT3',
      raceRecordId: existingId,
      pitEntryLap: 5, pitExitLap: 6, fuelAtPitEntry: 40.0, fuelAtFinish: 1.5,
      official_result_arrived: true,
    },
  ];
  ctx12.localStorage.setItem('pw_raceHistory', JSON.stringify(legacyHistory));

  // 実 loadRaceHistory() を呼ぶ＝マイグレーション発火
  const migrated1 = ctx12.loadRaceHistory();
  const monzaM = migrated1.find(r => r.track === 'Monza');
  const spaM = migrated1.find(r => r.track === 'Spa-Francorchamps');
  const roadAmericaM = migrated1.find(r => r.track === 'Road America');

  check_assert('旧Monza記録にraceRecordIdが付与された', !!monzaM.raceRecordId);
  check_assert('旧Spa記録にraceRecordIdが付与された', !!spaM.raceRecordId);
  check_assert('旧2件（同recordedAt）のraceRecordIdは異なる（衝突解消）',
    monzaM.raceRecordId !== spaM.raceRecordId);
  check_assert('既存ID付きRoad America記録のIDは上書きされていない',
    roadAmericaM.raceRecordId === existingId);
  check_assert('本文・燃料値は変更されていない（Monza fuelAtPitEntry=30.5のまま）',
    monzaM.fuelAtPitEntry === 30.5 && monzaM.fuelAtFinish === 2.1);
  check_assert('本文・燃料値は変更されていない（Spa fuelAtPitEntry=26.83のまま）',
    spaM.fuelAtPitEntry === 26.83 && spaM.fuelAtFinish === 3.9);
  console.log('  ✓ マイグレーション成功: Monza=' + monzaM.raceRecordId + ' Spa=' + spaM.raceRecordId
    + ' RoadAmerica(既存維持)=' + roadAmericaM.raceRecordId);

  // 再読込（2回目の loadRaceHistory() 呼び出し）でIDが変わらないこと
  const migrated2 = ctx12.loadRaceHistory();
  const monzaM2 = migrated2.find(r => r.track === 'Monza');
  const spaM2 = migrated2.find(r => r.track === 'Spa-Francorchamps');
  check_assert('再読込後もMonzaのIDは不変', monzaM2.raceRecordId === monzaM.raceRecordId);
  check_assert('再読込後もSpaのIDは不変', spaM2.raceRecordId === spaM.raceRecordId);
  console.log('  ✓ 再読込後もID不変を確認');

  // localStorageへも永続化されていること（直接JSON.parseして確認、マイグレーション経由でない生読み）
  const rawAfterMigration = JSON.parse(ctx12.localStorage.getItem('pw_raceHistory'));
  const monzaRaw = rawAfterMigration.find(r => r.track === 'Monza');
  check_assert('localStorageへも永続化されている（生JSON読みでもIDが見える）',
    monzaRaw.raceRecordId === monzaM.raceRecordId);

  // route→action.raceRecordId の採用一致（マイグレーション後のhistoryをそのままrouteへ渡す）
  const spaQ = router.route({
    text: '前回給油は？', lang: 'ja',
    live: { cust_id: 999999, track: 'Spa-Francorchamps', car_class: 'GT3', car_model: 'Mercedes-AMG GT3 2020' },
    raceHistory: migrated2, sessionMemory: sessionMemory,
  });
  check_assert('マイグレーション後のSpa質問がprevious_fuel_referenceで正答',
    spaQ.handled === true && spaQ.intent === 'previous_fuel_reference');
  check_assert('route結果のaction.raceRecordIdがマイグレーション後のSpa IDと一致',
    spaQ.action.raceRecordId === spaM.raceRecordId);
  check_assert('route結果のaction.raceRecordIdはMonzaのIDと衝突しない',
    spaQ.action.raceRecordId !== monzaM.raceRecordId);
  console.log('  ✓ route→action.raceRecordId の採用一致を確認:', spaQ.action.raceRecordId);
}

function check_assert(label, ok) {
  assert.strictEqual(ok, true, label);
  console.log('  ✓ ' + label);
}

console.log('\n✓ All tests PASSED\n');
process.exit(0);
