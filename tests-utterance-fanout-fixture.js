#!/usr/bin/env node
/**
 * ★発話出口一貫性試験（Codex差戻し残作業：既定の発話出口検証）
 *
 * TTS / Overlay / 会話Box / Chat の4箇所が同一本文で揃っているかを
 * renderer.html の実 finalizeUtterance() を VM 抽出して検証する。
 *
 * 実際の音声合成・画面描画（Windows/iRacing実機のみ確認できる部分）は対象外。
 * ここで検証するのはローカルで再現できる配線：finalizeUtterance が
 * 生成する診断ログ fanout_match の判定ロジックそのものが実関数として
 * 正しく「一致／不一致／検証不能」を区別することの証明。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rendererSrc = fs.readFileSync(path.join(__dirname, 'desktop/renderer.html'), 'utf8');

function extractFunction(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found`);
  let i = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

const fnFinalizeUtterance = extractFunction(rendererSrc, 'finalizeUtterance');
const fnLunaTurnTextById = extractFunction(rendererSrc, 'lunaTurnTextById');
const fnDropLunaTurnById = extractFunction(rendererSrc, 'dropLunaTurnById');
const fnRemoveMessageById = extractFunction(rendererSrc, 'removeMessageById');

console.log('★実 renderer.html から抽出（コピー禁止・本文一致）:');
console.log(`  finalizeUtterance: ${fnFinalizeUtterance.length} chars`);
console.log(`  lunaTurnTextById: ${fnLunaTurnTextById.length} chars`);

function makeUtteranceContext(turns) {
  const logs = [];
  const sandbox = {
    console,
    JSON,
    String,
    Array,
    window: { PitwallConversationMemoryBox: { dropTurn: () => true } },
    messages: [],
    ensureConversationBox: () => ({ turns }),
    diagnosticLog: (tag, text) => { logs.push({ tag, text }); },
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    ${fnLunaTurnTextById}
    ${fnDropLunaTurnById}
    ${fnRemoveMessageById}
    ${fnFinalizeUtterance}
  `, sandbox);
  return { sandbox, logs };
}

function lastFanout(logs) {
  const row = logs.filter(l => l.tag === 'UTTERANCE_FINAL').pop();
  if (!row) return null;
  const m = /fanout_match=(\w+)/.exec(row.text);
  return m ? m[1] : null;
}

console.log('\n━━ 実 finalizeUtterance() による fanout 一貫性試験 ━━\n');

// Test 1: TTS/Overlay/会話Box/Chatが全て同一本文 → fanout_match=true
console.log('Test 1: 4箇所すべて同一本文 → fanout_match=true');
{
  const text = '前回は9周終了後に入り、26.83L給油。チェッカー時3.9L残。';
  const { sandbox, logs } = makeUtteranceContext([{ turn_id: 't1', text }]);
  const el = { textContent: text, _ovlText: text, _turnId: 't1', _ovlId: 'L1' };
  const item = { text, kind: 'reply', displayEl: el, utteranceId: 'u1', messageId: null };
  sandbox.finalizeUtterance(item, 'spoken', text, null);
  assert.strictEqual(lastFanout(logs), 'true', '4箇所同一本文なら fanout_match=true であるべき');
  console.log('  ✓ fanout_match=true（TTS本文とOverlay/会話Box/Chatが一致）');
}

// Test 2: 会話Boxだけ本文がずれている（rebuild事故の再現）→ fanout_match=false
console.log('\nTest 2: 会話Boxの本文だけ食い違う → fanout_match=false（Build 298型の事故を検出）');
{
  const ttsText = '後ろ3.7秒。1.6秒縮んだ。';
  const staleBoxText = '後ろ4.8秒。';  // 音声直前に作り替わって会話Boxだけ古いまま、を模す
  const { sandbox, logs } = makeUtteranceContext([{ turn_id: 't2', text: staleBoxText }]);
  const el = { textContent: ttsText, _ovlText: ttsText, _turnId: 't2', _ovlId: 'L2' };
  const item = { text: ttsText, kind: 'reply', displayEl: el, utteranceId: 'u2', messageId: null };
  sandbox.finalizeUtterance(item, 'spoken', ttsText, null);
  assert.strictEqual(lastFanout(logs), 'false', '本文不一致は fanout_match=false で検出されるべき');
  console.log('  ✓ fanout_match=false（会話Boxの不一致を実関数が検出）');
}

// Test 3: 表示要素なし（無線・履歴に積んでいない）→ unverifiable（falseへ偽装しない）
console.log('\nTest 3: 表示要素なし（無線等）→ fanout_match=unverifiable（false偽装なし）');
{
  const { sandbox, logs } = makeUtteranceContext([]);
  const item = { text: '前方に停止車両。', kind: 'radio', displayEl: null, utteranceId: 'u3', messageId: null };
  sandbox.finalizeUtterance(item, 'spoken', null, null);
  assert.strictEqual(lastFanout(logs), 'unverifiable', '検証不能ケースは false ではなく unverifiable であるべき');
  console.log('  ✓ fanout_match=unverifiable（false を偽装しない）');
}

// Test 4: dropped_before_audible は fanout チェック自体を行わない（一度も耳に届いていない）
console.log('\nTest 4: dropped_before_audible は fanout_match を出さない（未再生は対象外）');
{
  const { sandbox, logs } = makeUtteranceContext([]);
  const item = { text: 'discarded text', kind: 'radio', displayEl: null, utteranceId: 'u4', messageId: null };
  sandbox.finalizeUtterance(item, 'dropped', null, 'duplicate_dedupe_key');
  const row = logs.filter(l => l.tag === 'UTTERANCE_FINAL').pop();
  assert.ok(row.text.includes('outcome=dropped_before_audible'));
  assert.ok(!row.text.includes('fanout_match'), 'dropped_before_audible では fanout_match を出さない');
  console.log('  ✓ dropped_before_audible は fanout チェック対象外として記録');
}

console.log('\n✓ All utterance fanout tests PASSED\n');
process.exit(0);
