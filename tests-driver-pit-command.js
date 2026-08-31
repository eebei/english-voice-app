#!/usr/bin/env node
'use strict';

// 2026-08-31 RBR実走：ドライバーの決定に「ステイアウト」を返した件。
//   19:31:37「いや、もうこの周で入るよ」→ 今はステイアウト。ピットウィンドウまで走れる。
//   19:32:36「ボックス。」          → 今はステイアウト。ピットウィンドウまで走れる。
// 前の集団の動きが見えているのはドライバー。決定は覆さない（質問なら従来どおり判断を返す）。

const card = require('./engineer-card.js');

let pass = 0, fail = 0;
function check(label, ok, got) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label + (ok ? '' : '  → ' + JSON.stringify(got)));
  ok ? pass++ : fail++;
}

// 8/31 実走時の live 相当：総燃料は不足だが timing authority は hold。
const liveHold = {
  class_pos: 9,
  fuel: 24.2,
  session_type: 'Race',
  fuel_strategy: {
    required_fuel_l: 47.1, evaluated_fuel_l: 24.2, add_fuel_l: 22.9, set_fuel_l: 23,
    pit_timing_authority: {
      available: true, decision: 'hold', selected_plan: 'A',
      latest_safe_pit_lap: 19, laps_until_latest_safe_pit: 7,
    },
  },
};

function reply(text, live = liveHold) {
  const r = card.route(text, live, 'ja');
  return r && r.reply;
}
function topicOf(text) {
  const c = card.classify(text);
  return c && { topic: c.topic, cmd: c.driverCommand === true };
}

// ── 決定として扱うべき発話 ─────────────────────────────────────────
for (const t of ['ボックス。', 'ボックス', 'この周で入るよ', 'いや、もうこの周で入るよ。',
                 'もう入る', 'ピットインして', 'box', 'box this lap', 'pitting']) {
  const c = topicOf(t);
  check(`決定と判定：「${t}」`, !!c && c.cmd === true, c);
}

// ── 質問として扱うべき発話（従来どおり判断を返す） ─────────────────
for (const t of ['ピットはいつ？', '入るべき？', '次のピットのタイミングは',
                 'ボックスするべきかな', 'should I pit', 'box or stay out']) {
  const c = topicOf(t);
  check(`質問と判定：「${t}」`, !!c && c.cmd !== true, c);
}

// 変異試験で判明：疑問語（いつ／べき／かな／should／or）を消しても全部通った。
// 疑問符しか手がかりが無い形＝「ボックス？」を、決定と取り違えないことを確かめる。
for (const t of ['ボックス？', 'この周で入る？', 'もう入る?', 'box?']) {
  const c = topicOf(t);
  check(`疑問符だけで質問と判定：「${t}」`, !!c && c.cmd !== true, c);
}
{
  const r = reply('ボックス？');
  check('「ボックス？」は相談として扱い、了解で確定させない',
    !/了解、ボックス/.test(String(r)), r);
}

// ── 返答：決定に「ステイアウト」を返さない ───────────────────────
{
  const r = reply('ボックス。');
  check('「ボックス。」にステイアウトを返さない', !/ステイアウト/.test(String(r)), r);
  check('「ボックス。」を了解し給油量を出す',
    /了解、ボックス。/.test(String(r)) && /22\.9L/.test(String(r)), r);
  check('反論はするが後置きで、判断はドライバーに残す',
    /Plan Aの目安は19周目/.test(String(r)) && /判断は任せる/.test(String(r)), r);
}
{
  const r = reply('いや、もうこの周で入るよ。');
  check('「この周で入るよ」にステイアウトを返さない', !/ステイアウト/.test(String(r)), r);
}
{
  const r = card.route('box', liveHold, 'en');
  check('EN: 決定に stay out を返さない',
    r && !/stay out/i.test(r.reply) && /Copy, box\./.test(r.reply) && /your call/.test(r.reply), r && r.reply);
}

// ── 質問には従来の判断を返す（過剰修正の検出） ───────────────────
{
  const r = reply('ピットはいつ？');
  check('質問は決定として扱わず、従来の判断経路を通る',
    !/了解、ボックス/.test(String(r)) && /ホールド|ステイアウト/.test(String(r)), r);
}

// ── 局面ガード ───────────────────────────────────────────────────
{
  const inLane = JSON.parse(JSON.stringify(liveHold));
  inLane.on_pit_road = true; inLane.driver_state = 'pit';
  const r = card.route('ボックス。', inLane, 'ja');
  check('ピットレーン内の「ボックス」は二重指示にしない',
    /ピットレーン内/.test(String(r && r.reply)), r && r.reply);
}
{
  const noPlan = { class_pos: 9, fuel_strategy: {} };
  const r = card.route('ボックス。', noPlan, 'ja');
  check('給油量が無い時も了解し、数字を捏造しない',
    /了解、ボックス。/.test(String(r && r.reply)) && !/L/.test(String(r && r.reply).replace('Plan','')),
    r && r.reply);
}

// ── 8/30 の回帰：ブレンド相談を決定に化けさせない ─────────────────
{
  const c = card.classify('俺、この週に入ったら後方の方の車とブレンドしちゃうか？');
  check('ブレンド相談は pit_decision にならない（8/30回帰）', !c || c.topic !== 'pit_decision', c);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
