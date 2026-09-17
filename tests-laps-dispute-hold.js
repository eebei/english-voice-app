#!/usr/bin/env node
'use strict';

// 2026-09-14 fixture e09（review/fixtures/race-conversation-fuel-pit-v1.json）
//
//   e09 driver: 「残り、一周少なく数えてない？　あと9周だよ。」（SDKは8周）
//   rubric: 訂正として受け取る／旧8周案を無条件に継続しない／9周という申告と
//           SDKの8周を区別して再評価し、解決まで条件付き判断を返す／
//           driver申告をSDK実測と偽らない
//
// GAP には gapHeld（gap-freshness.disputeGap / gapHoldStatus）という同型の保留が
// あるのに、laps_remaining には無かった（2026-09-14 grep確認）。無いと
//   (a) 申告を黙って採用＝申告を実測と偽る
//   (b) SDK 8周のまま継続＝訂正を無視
// の悪手しか残らない。この検査は実製品（session-strategy-state.js /
// local-intent-router.js）を実行して、保留・条件付き回答・再観測での解除を確認する。

const path = require('path');
let pass = 0;
const failures = [];
function check(group, name, ok, detail) {
  if (ok) { pass++; return true; }
  failures.push(`[${group}] ${name}` + (detail ? '\n       ' + detail : ''));
  return false;
}

const S = require(path.join(__dirname, 'desktop/session-strategy-state.js'));
const router = require(path.join(__dirname, 'desktop/local-intent-router.js'));

const liveAt = (laps, over) => Object.assign({
  fuel: 35.28, finish_crossings_authority: laps,
  fuel_strategy: { avg_fuel_per_lap: 4.6 },
  track: 'fixture-track', car_model: 'fixture-car', cust_id: 'c1', lap: 20,
}, over || {});

const ask = (st, text, live) => router.route({ text, lang: 'ja', live,
  strategy: { state: st, api: S } });

// ════════════════════════════════════════════════════════════════════
// ① state層：保留の契約（GAPの gapHoldStatus と同じ「観測でのみ解除」）
// ════════════════════════════════════════════════════════════════════
{
  const G = '①state';
  const st = S.create({ session_key: 'l1' });

  const d = S.disputeLapsRemaining(st, { driver_laps: 9, laps_remaining: 8, at: 1000 });
  check(G, '食い違いは保留として立つ', d && d.held === true && d.driver_laps === 9, JSON.stringify(d));
  check(G, 'driver申告はSDK値として保存しない（申告は申告のまま）',
    st.laps_dispute.driver_laps === 9 && st.laps_dispute.sdk_laps_at_dispute === 8,
    JSON.stringify(st.laps_dispute));

  const held = S.lapsRemainingStatus(st, { laps_remaining: 8, at: 2000 });
  check(G, '同じSDK値のままなら保留継続（時間経過では解けない）',
    held.held === true && held.laps_remaining === null, JSON.stringify(held));
  const heldLater = S.lapsRemainingStatus(st, { laps_remaining: 8, at: 999999 });
  check(G, '時間が経っても観測が変わらなければ保留のまま',
    heldLater.held === true, JSON.stringify(heldLater));

  const rel = S.lapsRemainingStatus(st, { laps_remaining: 9, at: 3000 });
  check(G, '新しい観測が来たら解除し、確定値はSDKの新値',
    rel.held === false && rel.released === true && rel.laps_remaining === 9, JSON.stringify(rel));
  check(G, '解除時にdriver申告と一致したかを区別して返す', rel.matched_driver === true, JSON.stringify(rel));
  check(G, '解除は履歴へ残る',
    st.history.some(h => h.kind === 'laps_dispute_released'), JSON.stringify(st.history));

  // driver申告と違う値で再観測された場合も、採用するのは新しいSDK値。
  const st2 = S.create({ session_key: 'l2' });
  S.disputeLapsRemaining(st2, { driver_laps: 9, laps_remaining: 8, at: 1000 });
  const rel2 = S.lapsRemainingStatus(st2, { laps_remaining: 7, at: 2000 });
  check(G, '再観測がdriver申告と違っても新SDK値を採用し、一致しなかったと記録する',
    rel2.released === true && rel2.laps_remaining === 7 && rel2.matched_driver === false,
    JSON.stringify(rel2));

  // 申告がSDKと同じなら争いが無い＝保留を立てない（解除条件が来ないため）。
  const st3 = S.create({ session_key: 'l3' });
  const agreed = S.disputeLapsRemaining(st3, { driver_laps: 8, laps_remaining: 8, at: 1000 });
  check(G, '申告とSDKが一致するなら保留を立てない',
    agreed && agreed.agreed === true && st3.laps_dispute === null, JSON.stringify(agreed));
}

// ════════════════════════════════════════════════════════════════════
// ② answerFuel：係争中は片方を事実として断定せず、両方の数で条件付きに答える
// ════════════════════════════════════════════════════════════════════
{
  const G = '②条件付き燃料';
  const st = S.create({ session_key: 'f1' });
  const a = S.answerFuel(st, { fuel_l: 35.28, per_lap_l: 4.6,
    laps_dispute: { driver_laps: 9, sdk_laps: 8 }, at: 1000 });
  check(G, '係争を明示する', a.laps_disputed === true, JSON.stringify(a));
  check(G, '両方の数それぞれの過不足を述べる',
    /8周なら/.test(a.reply) && /9周なら/.test(a.reply), a.reply);
  check(G, 'どちらの数がどちらの出所かを言う（申告を実測と偽らない）',
    /こちらの計測は8周/.test(a.reply) && /君の申告は9周/.test(a.reply), a.reply);
  check(G, '単一の過不足として断定しない', a.shortfall_l === null, JSON.stringify(a));
  check(G, '保守側（周回数が多い方）を暫定前提にすると明言する',
    /9周前提で動く/.test(a.reply), a.reply);
  check(G, '次の計測で言い直すと約束する', /次の計測/.test(a.reply), a.reply);

  // 履歴根拠の時は、条件付き回答でも出典を「前回実績」と明示する。
  const b = S.answerFuel(S.create({ session_key: 'f2' }), { fuel_l: 35.28, per_lap_l: null,
    history_per_lap_l: 4.28, laps_dispute: { driver_laps: 9, sdk_laps: 8 }, at: 1000 });
  check(G, '履歴根拠の条件付き回答は出典と推定であることを明示する',
    /前回実績4\.28L\/周（暫定）/.test(b.reply) && /前回実績ベースの推定/.test(b.reply), b.reply);
  check(G, '履歴根拠の条件付き回答は fuel_basis を memory_previous と返す',
    b.fuel_basis === 'memory_previous', JSON.stringify(b));

  // 係争していない（同じ値）なら従来どおりの断定回答へ戻る＝回帰。
  const c = S.answerFuel(S.create({ session_key: 'f3' }), { fuel_l: 35.28, per_lap_l: 4.6,
    laps_remaining: 8, laps_dispute: { driver_laps: 8, sdk_laps: 8 }, at: 1000 });
  check(G, '回帰：値が一致していれば条件付きにせず通常回答',
    c.laps_disputed !== true && c.shortfall_l !== null, JSON.stringify(c));
}

// ════════════════════════════════════════════════════════════════════
// ③ 実router：e09の発話→保留→保留中の回答→e10の観測で解除
// ════════════════════════════════════════════════════════════════════
{
  const G = '③router e2e';
  const st = S.create({ session_key: 'r1' });

  const e09 = ask(st, '残り、一周少なく数えてない？　あと9周だよ。', liveAt(8));
  check(G, 'e09：訂正として扱う（laps_remaining_disputed）',
    e09 && e09.handled === true && e09.intent === 'laps_remaining_disputed', JSON.stringify(e09));
  check(G, 'e09：旧8周案を無条件に継続しない（両方の数で条件付き）',
    e09 && /8周なら/.test(e09.reply) && /9周なら/.test(e09.reply), e09 && e09.reply);
  check(G, 'e09：機械契約の確度は confirmed ではなく held',
    e09 && e09.confidence === 'held', JSON.stringify(e09));
  check(G, 'e09：stateにも保留が立つ', st.laps_dispute && st.laps_dispute.driver_laps === 9,
    JSON.stringify(st.laps_dispute));

  // 保留中：残り周回の質問にSDK値を断定で返さない。
  const q = ask(st, 'あと何周？', liveAt(8));
  check(G, '保留中の「あと何周？」に「残り8周。」と断定しない',
    q && q.reply !== '残り8周。' && /確定していない/.test(q.reply), JSON.stringify(q));
  check(G, '保留中の回答も held', q && q.confidence === 'held', JSON.stringify(q));

  // 保留中：燃料の質問も条件付きになる。
  const f = ask(st, '燃料足りる？', liveAt(8));
  check(G, '保留中の燃料質問も両方の数で条件付きに答える',
    f && f.intent === 'fuel_status_laps_disputed' && /8周なら/.test(f.reply) && /9周なら/.test(f.reply),
    JSON.stringify(f));

  // e10：新しい観測（9周）で解除され、確定値で答える。
  const e10 = ask(st, 'あと何周？', liveAt(9));
  check(G, 'e10：新観測で解除し確定値を答える',
    e10 && e10.intent === 'laps_remaining' && /残り9周で確定/.test(e10.reply), JSON.stringify(e10));
  check(G, 'e10：解除後は保留が消えている', st.laps_dispute === null, JSON.stringify(st.laps_dispute));
  const after = ask(st, 'あと何周？', liveAt(9));
  check(G, '解除後は通常の回答へ戻る', after && after.reply === '残り9周。', JSON.stringify(after));
}

// ════════════════════════════════════════════════════════════════════
// ④ 誤検知しない：周回数を含む普通の指示・質問を訂正にしない
// ════════════════════════════════════════════════════════════════════
{
  const G = '④誤検知';

  const cases = [
    ['あと5周でピットインしよう。', 'pit指示'],
    ['あと3周で給油に入る。', '給油指示'],
    ['あと何周？', '周回数の質問（数字なし）'],
    ['残り時間は？', '時間の質問'],
  ];
  for (const [text, label] of cases) {
    const st = S.create({ session_key: 'n' + text.length });
    const r = ask(st, text, liveAt(8));
    check(G, `${label}は訂正として扱わない`,
      !(r && r.intent === 'laps_remaining_disputed') && st.laps_dispute === null,
      JSON.stringify({ intent: r && r.intent, dispute: st.laps_dispute }));
  }

  // 訂正の言い方でも、申告がSDKと一致するなら保留は立てない（解除条件が来ないため）。
  {
    const st = S.create({ session_key: 'n-agree' });
    const r = ask(st, '数え間違えてない？　あと8周でしょ。', liveAt(8));
    check(G, '訂正表現でも値が一致するなら保留を立てず合っていると答える',
      r && r.intent === 'laps_remaining_confirmed' && st.laps_dispute === null, JSON.stringify(r));
  }

  // 訂正表現のない一致確認は、従来どおり普通の残り周回回答でよい。
  {
    const st = S.create({ session_key: 'n-plain' });
    const r = ask(st, 'あと8周だよね？', liveAt(8));
    check(G, '一致する確認質問は通常の残り周回回答のまま（保留を立てない）',
      r && r.reply === '残り8周。' && st.laps_dispute === null, JSON.stringify(r));
  }

  // strategy state が渡されない（旧呼び出し）時は従来どおり素通りする＝回帰。
  {
    const r = router.route({ text: 'あと9周だよ。', lang: 'ja', live: liveAt(8) });
    check(G, '回帰：strategy未接続の呼び出しでは訂正機構を作動させない',
      !(r && r.intent === 'laps_remaining_disputed'), JSON.stringify(r));
  }
}

// ════════════════════════════════════════════════════════════════════
// ⑤ 2026-09-14 Codex MD#6 P1：解除条件は「値の変化」ではなく「新しい観測」。
//    旧実装は訂正開始時にSDKが欠損（null）だと永久保留になり、また同じ値の
//    新観測（8→新観測8）でdriver申告9を否定できなかった。Codexが指定した
//    4ケースを**実router**で確認する（state単体ではなく製品経路）。
// ════════════════════════════════════════════════════════════════════
{
  const G = '⑤観測ID';
  // snapshotId を明示して route する（renderer は lastTelemetryAt を渡す）。
  const askAt = (st, text, live, snapshotId) => router.route({ text, lang: 'ja', live,
    strategy: { state: st, api: S }, snapshotId });
  const liveNoLaps = over => Object.assign(liveAt(8), { finish_crossings_authority: null }, over || {});

  // ① null → 9：欠損から復旧した観測は必ず採用する。
  {
    const st = S.create({ session_key: 'o1' });
    askAt(st, 'あと9周だよ。数え間違えてない？', liveNoLaps(), 'snap-1');
    check(G, '①訂正時にSDK欠損でも保留は立つ', st.laps_dispute !== null, JSON.stringify(st.laps_dispute));
    const r = askAt(st, 'あと何周？', liveAt(9), 'snap-2');
    check(G, '①null→9：復旧した観測で解除し9周で確定',
      r && r.intent === 'laps_remaining' && /残り9周で確定/.test(r.reply) && st.laps_dispute === null,
      JSON.stringify(r));
  }

  // ② null → 8：driver申告(9)と違う値でも、観測が戻れば解除してSDK値を採用する。
  {
    const st = S.create({ session_key: 'o2' });
    askAt(st, 'あと9周だよ。数え間違えてない？', liveNoLaps(), 'snap-1');
    const r = askAt(st, 'あと何周？', liveAt(8), 'snap-2');
    check(G, '②null→8：解除し、driver申告ではなくSDKの8周を採用する',
      r && r.intent === 'laps_remaining' && /残り8周で確定/.test(r.reply)
        && /申告とは違う/.test(r.reply) && st.laps_dispute === null, JSON.stringify(r));
  }

  // ③ 8 → 新観測8：値が同じでも、新しい観測なら解除する（申告9は否定された）。
  {
    const st = S.create({ session_key: 'o3' });
    askAt(st, 'あと9周だよ。数え間違えてない？', liveAt(8), 'snap-1');
    const r = askAt(st, 'あと何周？', liveAt(8), 'snap-2');
    check(G, '③8→新観測8：同じ値でも新観測なら解除する',
      r && r.intent === 'laps_remaining' && st.laps_dispute === null, JSON.stringify(r));
    check(G, '③解除時、driver申告と一致しなかったことを伝える',
      r && /申告とは違う/.test(r.reply), r && r.reply);
  }

  // ④ 8 → 同一snapshot 8：同じ観測の再質問では保持する。
  {
    const st = S.create({ session_key: 'o4' });
    askAt(st, 'あと9周だよ。数え間違えてない？', liveAt(8), 'snap-1');
    const r = askAt(st, 'あと何周？', liveAt(8), 'snap-1');
    check(G, '④同一snapshotの再質問では保留を保持する',
      r && r.intent === 'laps_remaining_disputed' && st.laps_dispute !== null, JSON.stringify(r));
  }

  // 観測IDが渡らない旧呼び出しでも、欠損→復旧は必ず解除する（永久保留を作らない）。
  {
    const st = S.create({ session_key: 'o5' });
    S.disputeLapsRemaining(st, { driver_laps: 9, laps_remaining: null, at: 1000 });
    const a = S.lapsRemainingStatus(st, { laps_remaining: 9, at: 2000 });
    check(G, '観測IDなしでもnull→finiteは解除する',
      a.released === true && a.laps_remaining === 9 && a.release_reason === 'sdk_recovered',
      JSON.stringify(a));
  }

  // 観測IDが渡らない旧呼び出しは従来の値変化規則で動く（回帰）。
  {
    const st = S.create({ session_key: 'o6' });
    S.disputeLapsRemaining(st, { driver_laps: 9, laps_remaining: 8, at: 1000 });
    check(G, '回帰：観測IDなしで同値なら保持',
      S.lapsRemainingStatus(st, { laps_remaining: 8, at: 2000 }).held === true);
    const b = S.lapsRemainingStatus(st, { laps_remaining: 7, at: 3000 });
    check(G, '回帰：観測IDなしで値が変われば解除',
      b.released === true && b.release_reason === 'value_changed', JSON.stringify(b));
  }

}

console.log(`\n${pass} checks passed, ${failures.length} failed.`);
if (failures.length) {
  console.error('\nFAILURES:\n' + failures.join('\n\n'));
  process.exit(1);
}
