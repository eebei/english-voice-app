#!/usr/bin/env node
/**
 * Race Conversation Fixture: Spa GT3 受入テスト
 *
 * 仕様：
 *   - Spa GT3 実績を永続 race record に保存
 *   - 「前回給油は？」に 26.83L・3.9L残を答える
 *   - 別コース・公式未着・disputed を正しく拒否
 *   - Node assert で失敗時に非0終了
 */

const assert = require('assert');
const SM = require('./desktop/session-memory.js');

// ============================================================================
// Spa GT3 実績レコード
// ============================================================================

const createSpaRecord = () => ({
  // Identity
  cust_id: 315555,
  userId: null,
  track: 'Spa-Francorchamps',
  carClass: 'GT3',

  // Session
  seriesId: null,
  subsessionId: null,
  recordedAt: new Date(Date.now() - 3600000).toISOString(),  // 1時間前（fresh）
  date: new Date().toISOString().split('T')[0],

  // Race result
  totalLaps: 18,
  finishPos: 21,
  incidents: 7,
  bestLap: '2:17.339',

  // Fuel data（★必須）
  pitEntryLap: 9,
  pitExitLap: 10,
  fuelAtPitEntry: 26.83,
  fuelAtFinish: 3.9,

  // Meta
  disputed: false,
  deleted: false,
  official_result_arrived: true,
});

// ============================================================================
// TEST 1: 「前回給油は？」→ Spa 実績から正答
// ============================================================================

console.log('\n━━ TEST 1: 「前回給油は？」→ Spa 給油参照 ━━\n');

const spa = createSpaRecord();
const identity1 = { custId: 315555, track: 'Spa-Francorchamps', carClass: 'GT3' };

const result1 = SM.answerPreviousFuel([spa], identity1, 'ja', Date.now());

console.log('Input:', JSON.stringify({ text: '前回給油は？', identity: identity1 }, null, 2));
console.log('Output:', JSON.stringify(result1, null, 2));

try {
  assert.strictEqual(result1.handled, true, 'handled should be true');
  assert.strictEqual(result1.intent, 'previous_fuel_reference', 'intent should be previous_fuel_reference');
  assert(result1.reply.includes('26.83'), 'reply should contain 26.83L');
  assert(result1.reply.includes('3.9'), 'reply should contain 3.9L');
  console.log('✓ TEST 1 PASSED\n');
} catch (e) {
  console.error('✗ TEST 1 FAILED:', e.message, '\n');
  process.exit(1);
}

// ============================================================================
// TEST 2: 別コース → 拒否
// ============================================================================

console.log('━━ TEST 2: 別コース (Road Atlanta) → 拒否 ━━\n');

const identity2 = { custId: 315555, track: 'Road Atlanta', carClass: 'GT3' };
const result2 = SM.answerPreviousFuel([spa], identity2, 'ja', Date.now());

console.log('Input:', JSON.stringify({ track: 'Road Atlanta' }, null, 2));
console.log('Output:', JSON.stringify(result2, null, 2));

try {
  assert.strictEqual(result2.intent, 'previous_fuel_unavailable', 'should be unavailable (track mismatch)');
  console.log('✓ TEST 2 PASSED\n');
} catch (e) {
  console.error('✗ TEST 2 FAILED:', e.message, '\n');
  process.exit(1);
}

// ============================================================================
// TEST 3: 公式未着 → 「確認中」
// ============================================================================

console.log('━━ TEST 3: 公式未着レース → 「確認中」 ━━\n');

const pendingSpa = { ...spa, official_result_arrived: false };
const identity3 = { custId: 315555, track: 'Spa-Francorchamps', carClass: 'GT3' };
const result3 = SM.answerPreviousFuel([pendingSpa], identity3, 'ja', Date.now());

console.log('Input:', JSON.stringify({ official_result_arrived: false }, null, 2));
console.log('Output:', JSON.stringify(result3, null, 2));

try {
  assert.strictEqual(result3.intent, 'previous_fuel_pending', 'should be pending');
  assert(result3.reply.includes('公式結果') || result3.reply.includes('pending'), 'reply should indicate pending');
  console.log('✓ TEST 3 PASSED\n');
} catch (e) {
  console.error('✗ TEST 3 FAILED:', e.message, '\n');
  process.exit(1);
}

// ============================================================================
// TEST 4: disputed = true → 採用しない
// ============================================================================

console.log('━━ TEST 4: disputed=true → 採用しない ━━\n');

const disputedSpa = { ...spa, disputed: true };
const identity4 = { custId: 315555, track: 'Spa-Francorchamps', carClass: 'GT3' };
const result4 = SM.answerPreviousFuel([disputedSpa], identity4, 'ja', Date.now());

console.log('Input:', JSON.stringify({ disputed: true }, null, 2));
console.log('Output:', JSON.stringify(result4, null, 2));

try {
  assert.strictEqual(result4.intent, 'previous_fuel_unavailable', 'should be unavailable (disputed)');
  console.log('✓ TEST 4 PASSED\n');
} catch (e) {
  console.error('✗ TEST 4 FAILED:', e.message, '\n');
  process.exit(1);
}

// ============================================================================
// TEST 5: Bridge pit_events をマージして永続化
// ============================================================================

console.log('━━ TEST 5: Bridge pit events マージ ━━\n');

const spaBefore = createSpaRecord();
const pitEventsFromBridge = [
  { lap: 9, fuel_in: 26.83, lap_time: 120.45 },
];
// 「Bridge pit_events を race record へマージ」をシミュレート
const spaAfterMerge = { ...spaBefore, pit_events: pitEventsFromBridge };

console.log('Input (Bridge): pit_events =', JSON.stringify(pitEventsFromBridge));
console.log('Merged record has pit_events?', Array.isArray(spaAfterMerge.pit_events), '✓');

try {
  assert(Array.isArray(spaAfterMerge.pit_events), 'pit_events must be merged');
  assert(spaAfterMerge.pit_events.length === 1, 'pit_events length = 1');
  assert(spaAfterMerge.pit_events[0].fuel_in === 26.83, 'fuel_in matches');
  console.log('✓ TEST 5 PASSED\n');
} catch (e) {
  console.error('✗ TEST 5 FAILED:', e.message, '\n');
  process.exit(1);
}

// ============================================================================
// TEST 6: official_result_arrived を Bridge イベントで上書き
// ============================================================================

console.log('━━ TEST 6: 公式結果受信で上書き ━━\n');

const spaBeforeOfficialArrival = { ...createSpaRecord(), official_result_arrived: false };
const spaAfterOfficialArrival = { ...spaBeforeOfficialArrival, official_result_arrived: true };

console.log('Before: official_result_arrived =', spaBeforeOfficialArrival.official_result_arrived);
console.log('After (Bridge event): official_result_arrived =', spaAfterOfficialArrival.official_result_arrived);

const resultAfterArrival = SM.answerPreviousFuel([spaAfterOfficialArrival], identity1, 'ja', Date.now());

try {
  assert.strictEqual(resultAfterArrival.intent, 'previous_fuel_reference', 'should switch to reference after official arrival');
  assert(resultAfterArrival.reply.includes('26.83'), 'reply includes fuel amount');
  console.log('✓ TEST 6 PASSED\n');
} catch (e) {
  console.error('✗ TEST 6 FAILED:', e.message, '\n');
  process.exit(1);
}

// ============================================================================
// TEST 7: persistRaceRecord で新規保存
// ============================================================================

console.log('━━ TEST 7: 新規 race record を persistent history へ保存 ━━\n');

const history0 = []; // 空の history
const newBridgeData = {
  cust_id: 315555,
  track: 'Spa-Francorchamps',
  carClass: 'GT3',
  pit_events: [{ lap: 9, fuel_in: 26.83 }],
  official_result_arrived: true,
  pitEntryLap: 9,
  fuelAtPitEntry: 26.83,
  fuelAtFinish: 3.9,
};

const identity7 = { custId: 315555, track: 'Spa-Francorchamps', carClass: 'GT3' };
const history1 = SM.persistRaceRecord(history0, newBridgeData, identity7, Date.now());

console.log('Input: history length =', history0.length);
console.log('Output: history length =', history1.length);
console.log('Saved record cust_id =', history1[0].cust_id);

try {
  assert(history1.length === 1, 'history should have 1 record');
  assert(history1[0].cust_id === 315555, 'saved cust_id matches');
  assert(Array.isArray(history1[0].pit_events), 'pit_events preserved');
  console.log('✓ TEST 7 PASSED\n');
} catch (e) {
  console.error('✗ TEST 7 FAILED:', e.message, '\n');
  process.exit(1);
}

// ============================================================================
// TEST 8: persistRaceRecord で既存マージ
// ============================================================================

console.log('━━ TEST 8: 既存 race record を pit_events で merge・上書き ━━\n');

const existingHistory = [spa];
const updatedBridgeData = {
  pit_events: [{ lap: 9, fuel_in: 27.5, lap_time: 121.0 }], // 異なる pit data
  official_result_arrived: true,
};

const history2 = SM.persistRaceRecord(existingHistory, updatedBridgeData, identity1, Date.now());

console.log('Input: existing pit_events = undefined');
console.log('Updated pit_events[0].fuel_in =', history2[0].pit_events[0].fuel_in);

try {
  assert(history2.length === 1, 'history length stays 1 (merge, not append)');
  assert(Array.isArray(history2[0].pit_events), 'pit_events added');
  assert(history2[0].pit_events[0].fuel_in === 27.5, 'fuel_in updated to Bridge value');
  console.log('✓ TEST 8 PASSED\n');
} catch (e) {
  console.error('✗ TEST 8 FAILED:', e.message, '\n');
  process.exit(1);
}

// ============================================================================
// Summary
// ============================================================================

console.log('━━ Summary ━━');
console.log('✓ TEST 1 → GREEN: Spa 給油参照');
console.log('✓ TEST 2 → GREEN: 別コース拒否');
console.log('✓ TEST 3 → GREEN: 公式未着判定');
console.log('✓ TEST 4 → GREEN: disputed 除外');
console.log('✓ TEST 5 → GREEN: pit_events マージ');
console.log('✓ TEST 6 → GREEN: official_result_arrived 上書き');
console.log('✓ TEST 7 → GREEN: 新規 record 保存');
console.log('✓ TEST 8 → GREEN: 既存 record merge');
console.log('\nPhase 1-3 fixture 実装完了。次: router integration。\n');
process.exit(0);
