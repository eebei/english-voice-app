#!/usr/bin/env node
'use strict';

// 2026-09-02 独立検証：`39a4386` が付けた source/confidence 契約を **実行して** 反証する。
//
// 検証方針（今回から変える点）：
//   これまでの検証は `renderer.includes('...')` のような静的検査が中心で、
//   「書いてある」ことしか確かめていなかった。ここでは router を実際に呼び、
//   返った reply が「データが無い」と言っているのに confidence が confirmed に
//   なる組み合わせを機械的に探す。仕様の写経ではなく実挙動で判定する。
//
// 対象契約: confidence は intent 名の正規表現から導出される
//   /(?:unavailable|stale|held|measuring)/ にマッチしなければ 'confirmed'。
//   つまり **データの有無ではなく名前** で決まる。ここが破れるかを見る。

const router = require('./desktop/local-intent-router.js');

let pass = 0, fail = 0, findings = [];
function check(label, ok, got) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label + (ok ? '' : '  → ' + JSON.stringify(got)));
  ok ? pass++ : fail++;
}

// 回答文が「無い・確定できない」と言っているかを判定する語彙。
// 発話そのものから判定するので、intent 名の付け方に依存しない。
const SAYS_UNAVAILABLE = /取得できない|確定できない|まだ.{0,6}(?:出て|無|な)い|受信していない|届いていない|わからない|分からない|不明|データが無い|データがない|ありません|not (?:available|confirmed|received)|no data|unknown|cannot|can't|unavailable|do not have|don't have/i;

function ask(text, live, extra = {}) {
  return router.route(Object.assign({ text, live, lang: 'ja' }, extra));
}

// ── 1. 空データで全質問を通し、confidence と発話内容の整合を見る ──────────
// live はキーだけある空の snapshot。実走の「まだ何も来ていない」状態に相当する。
const EMPTY = { class_pos: null, fuel: null, gap_ahead: null, gap_behind: null };

const QUESTIONS = [
  ['GAP前後', '前後のギャップは'],
  ['前のGAP', '前とのギャップ'],
  ['後ろのGAP', '後ろとのギャップ'],
  ['順位', '今何位'],
  ['ベストラップ', 'ベストラップは'],
  ['燃料', '燃料どれくらい'],
  ['燃料ウィンドウ', 'フューエルウィンドウは'],
  ['残り周回', 'あと何周'],
  ['残り時間', 'あと何分'],
  ['レース形式', 'このレースは何周'],
  ['トップのGAP', 'トップとの差は'],
  ['トップの周回', 'トップは何周目'],
  ['路面温度', '路面温度は'],
  ['天候', '天気どう'],
  ['速いクラス', '後ろから速いクラス来てる'],
];

console.log('=== 空データで質問した時、confidence と発話が食い違うか ===');
for (const [name, q] of QUESTIONS) {
  const r = ask(q, EMPTY);
  if (!r || !r.handled) { console.log(`  – ${name}: ローカル未処理（LLMへ）`); continue; }
  const saysNone = SAYS_UNAVAILABLE.test(String(r.reply));
  const conf = r.confidence;
  const mismatch = saysNone && conf === 'confirmed';
  if (mismatch) findings.push({ name, q, intent: r.intent, confidence: conf, reply: r.reply });
  console.log(`  ${mismatch ? '⚠️ ' : '   '}${name}: intent=${r.intent} confidence=${conf} reply="${r.reply}"`);
}

check('空データで「確定できない」と言いながら confidence=confirmed を返す分岐が無い',
  findings.length === 0, findings);

// ── 2. source が全ローカル回答に必ず付くか ─────────────────────────────
{
  const missing = [];
  for (const [name, q] of QUESTIONS) {
    const r = ask(q, EMPTY);
    if (r && r.handled && r.source !== 'local_authority') missing.push({ name, source: r.source });
  }
  check('ローカル回答すべてに source=local_authority が付く', missing.length === 0, missing);
}

// ── 3. 実データがある時に confirmed になること（過剰な unavailable の検出） ──
{
  const LIVE = {
    class_pos: 4, fuel: 24.2, gap_ahead: 1.2, gap_behind: 0.8,
    best: 90.423, session_type: 'Race',
  };
  const r = ask('今の順位は', LIVE);
  check('実データがあれば confidence=confirmed（過剰拒否していない）',
    r && r.handled && r.confidence === 'confirmed' && /P4/.test(String(r.reply)), r);
}

// ── 4. 契約が実際に使われているか（宣言と実装の乖離） ──────────────────
// 39a4386 のコメントは「renderer がこの契約を使って LLM 応答が権威ある
// ローカル回答を置き換えるのを防げる」と書いている。実際に使っているか。
{
  const fs = require('fs');
  const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');
  const uses = renderer.match(/localIntent\.(?:confidence|source)/g) || [];
  const onlyInLog = uses.length > 0 && !/if\s*\([^)]*localIntent\.(?:confidence|source)/.test(renderer);
  check('confidence が診断ログ以外の判断に使われている（宣言どおりか）',
    !onlyInLog, { 参照箇所: uses.length, 分岐での使用: !onlyInLog });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (findings.length) {
  console.log('\n【実行で見つかった不整合】');
  for (const f of findings) console.log(`  intent=${f.intent} confidence=${f.confidence}\n    "${f.reply}"`);
}
process.exit(fail ? 1 : 0);
