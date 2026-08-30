#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════════════════
// 2026-08-30 Build 291 RB Ring 実走ログの固定再生（Codex着手指示 P0-1 / P0-2）
//
//   P0-1 未取得値が 0 として断定される
//        [09:38:05] 「…今は次のウインドウ。最終目安は0周目、あと0周。」
//        再現時にはより重い形も確認：GAP 未取得で「前0.0秒、後ろ0.0秒」
//   P0-2 交通／ブレンドの相談が pit 判断に化ける
//        [09:37:34] 「俺、この週に入ったら 後方の方の車とブレンドしちゃうか？」
//        [09:37:35] 「ピットを推奨。燃料不足が根拠。給油設定は22L。」
//
// 実物のモジュールを読み込み、当時の snapshot 形で再生する。
// ══════════════════════════════════════════════════════════════════════
const router = require('./desktop/local-intent-router.js');
const cards = require('./engineer-card.js');
const RP = require('./desktop/relative-pace.js');

let pass = 0, fail = 0;
function ck(label, ok, detail) {
  (ok ? console.log : console.error)((ok ? '  ✅ ' : '  ❌ ') + label + (ok ? '' : ' -> ' + (detail === undefined ? '' : String(detail))));
  ok ? pass++ : fail++;
}

// ── P0-1 欠損値を 0 と断定しない ──────────────────────────────────────
console.log('══ P0-1 null→0 の根絶 ══');
{
  // 当日の 09:38 と同じ形：range/shortfall はあるが window の周回は未確定
  const live = {
    session_num: 2, lap: 14, fuel: 15.4,
    fuel_strategy: {
      avg_fuel_per_lap: 2.69, clean_laps_sampled: 20,
      pit_timing_authority: {
        available: true, decision: 'pit_later', selected_plan: 'A',
        range_laps: 5.3, shortfall_to_finish_l: 23.5,
        latest_safe_pit_lap: null, laps_until_latest_safe_pit: null
      }
    }
  };
  const fuel = router.route({ text: '燃料どう？', lang: 'ja', live, snapshotAgeMs: 0 });
  ck('燃料回答に「0周目」「あと0周」が出ない',
    !/0周目/.test(fuel.reply) && !/あと0周/.test(fuel.reply), fuel.reply);
  ck('取れている実測（残り周・不足量）は捨てない',
    /5\.3周/.test(fuel.reply) && /23\.5L不足/.test(fuel.reply), fuel.reply);
  ck('欠損は柔らかい謝罪＋次にどうするかを返す',
    /ごめん/.test(fuel.reply) && /次のクリーン周/.test(fuel.reply), fuel.reply);

  // GAP が取れていない：0.0秒と断定してはならない（実走より重い潜在形）
  const blindGap = { session_num: 2, gap_ahead: null, gap_behind: null, gap_authority: {} };
  ['前後のギャップは？', '後ろとの差は？', 'ギャップどう？'].forEach(q => {
    const r = router.route({ text: q, lang: 'ja', live: blindGap, snapshotAgeMs: 0 });
    ck(`「${q}」で 0.0秒 と言わない`, !/0\.0秒/.test(r.reply), r.reply);
    ck(`「${q}」は取得できない事実を返す`, /取れていない/.test(r.reply), r.reply);
  });
  ck('GAP 欠損の回答に identity を積まない',
    !(router.route({ text: '前後のギャップは？', lang: 'ja', live: blindGap, snapshotAgeMs: 0 }).gapIdentities || []).length);

  // 残り周回・天候・順位・首位も同じ規律
  ck('残り周回が null なら 0周と言わない',
    !/0周/.test(router.route({ text: 'あと何周？', lang: 'ja',
      live: { session_num: 2, finish_crossings_authority: null, session_time_remaining_s: null },
      snapshotAgeMs: 0 }).reply));
  ck('路面温度が null なら 0.0℃と言わない',
    !/0\.0℃/.test(router.route({ text: '路面温度は？', lang: 'ja',
      live: { session_num: 2, weather: { track_temp_c: null } }, snapshotAgeMs: 0 }).reply));
  ck('順位が null なら P0 と言わない',
    !/P0/.test(router.route({ text: '今の順位は？', lang: 'ja',
      live: { session_num: 2, class_pos: null }, snapshotAgeMs: 0 }).reply));
  ck('首位GAPが null なら 0.0秒と言わない',
    !/0\.0秒/.test(router.route({ text: 'トップとの差は？', lang: 'ja',
      live: { session_num: 2, leaders: { player_class: { gap_s: null } } }, snapshotAgeMs: 0 }).reply));
  ck('首位周回が null なら 0周目と言わない',
    !/0周目/.test(router.route({ text: 'トップは何周？', lang: 'ja',
      live: { session_num: 2, leaders: { player_class: { lap: null } } }, snapshotAgeMs: 0 }).reply));

  // 0 が本物の時は 0 と言えること（過剰な沈黙にしない）
  const realZero = router.route({ text: '路面温度は？', lang: 'ja',
    live: { session_num: 2, weather: { track_temp_c: 0 } }, snapshotAgeMs: 0 });
  ck('実測 0℃ は 0 と答える（欠損と取り違えない）', /0\.0℃/.test(realZero.reply), realZero.reply);
  const realGap = router.route({ text: '前後のギャップは？', lang: 'ja',
    live: { session_num: 2, gap_ahead: 0.4, gap_behind: 1.6, gap_authority: {} }, snapshotAgeMs: 0 });
  ck('実測GAPは従来どおり答える', /前0\.4秒/.test(realGap.reply) && /後ろ1\.6秒/.test(realGap.reply), realGap.reply);
  ck('boolean を数値へ通さない',
    !/0\.0秒/.test(router.route({ text: '前後のギャップは？', lang: 'ja',
      live: { session_num: 2, gap_ahead: false, gap_behind: true, gap_authority: {} }, snapshotAgeMs: 0 }).reply));
  ck('空文字を 0 に変換しない',
    !/0\.0秒/.test(router.route({ text: '前後のギャップは？', lang: 'ja',
      live: { session_num: 2, gap_ahead: '', gap_behind: '', gap_authority: {} }, snapshotAgeMs: 0 }).reply));
}

// ── P0-2 交通／ブレンドの相談を pit 判断にしない ─────────────────────
console.log('══ P0-2 質問分類の誤爆 ══');
{
  const asked = '俺、この週に入ったら 後方の方の車とブレンドしちゃうか？';
  ck('実走の一文が pit_decision にならない',
    cards.classify(asked).topic !== cards.TOPIC.PIT_DECISION, JSON.stringify(cards.classify(asked)));
  ck('実走の一文は復帰位置（rejoin）へ届く',
    cards.classify(asked).topic === cards.TOPIC.REJOIN, JSON.stringify(cards.classify(asked)));
  [['後方の集団にハマる？', cards.TOPIC.TRAFFIC_STATUS],
   ['トラフィックどう？', cards.TOPIC.TRAFFIC_STATUS],
   ['この周でピットしたらブレンドする？', cards.TOPIC.REJOIN],
   ['ピット後は集団の中？', cards.TOPIC.TRAFFIC_STATUS]].forEach(([text, want]) => {
    ck(`「${text}」→ ${want}`, cards.classify(text).topic === want, JSON.stringify(cards.classify(text)));
  });

  // 正当な pit 判断は従来どおり pit_decision のまま（過剰修正の検出）
  ['ピット 入る？', 'どうするのはこの州 入るのか？次の週なのか？', 'この周でボックス？',
   'ステイアウト？', '次のピットいつ？'].forEach(text => {
    ck(`「${text}」は pit_decision のまま`,
      cards.classify(text).topic === cards.TOPIC.PIT_DECISION, JSON.stringify(cards.classify(text)));
  });

  // 相対ペースの語彙（8/30 は F1 が一度も発火しなかった）
  ['後ろの方がペース速い？', '前の速さどう？', '後ろとのタイム差は？',
   '後方に離されてる？', 'どっちが速い？', 'is the car behind faster?'].forEach(text => {
    ck(`「${text}」は相対ペースが受ける`, RP.isRelativePaceQuestion(text) === true);
  });
  ck('ブレンドの相談は相対ペースが横取りしない',
    RP.isRelativePaceQuestion('後方の車とブレンドしちゃうか？') === false);
  ck('燃料の質問は相対ペースが横取りしない',
    RP.isRelativePaceQuestion('燃料足りる？') === false);
}

// ── 総燃料不足だけで「今周ピット」と言わない ─────────────────────────
console.log('══ pit_timing_authority が hold/pit_later の時 ══');
{
  const shortfallLive = {
    session_type: 'Race', lap: 14, fuel: 16.1,
    race_plan: { kind: 'timed', configured_duration_s: 2400 },
    fuel_strategy: {
      required_fuel_l: 37.96, margin_l: -21.8, add_fuel_l: 22.3,
      estimated_crossings_to_finish: 14, pit_required: true,
      pit_timing_authority: {
        available: true, decision: 'hold', selected_plan: 'A',
        latest_safe_pit_lap: 19, laps_until_latest_safe_pit: 5
      }
    },
    strategy_plan: { action: 'box', reason: 'fuel_shortfall', set_fuel_l: 23 }
  };
  const reply = cards.build(cards.classify('ピット 入る？'), shortfallLive, 'ja');
  ck('総燃料不足だけで今周ピットと言わない',
    /ステイアウト/.test(reply) && !/ピットを推奨/.test(reply) && !/この周でピット/.test(reply), reply);
  ck('代わりに権威側の窓を引用する', /19周目/.test(reply) && /あと5周/.test(reply), reply);

  const pitNow = JSON.parse(JSON.stringify(shortfallLive));
  pitNow.fuel_strategy.pit_timing_authority.decision = 'pit_now';
  const nowReply = cards.build(cards.classify('ピット 入る？'), pitNow, 'ja');
  ck('pit_now の時は従来どおりピット指示を出す',
    !/ステイアウト/.test(nowReply), nowReply);
}

console.log(`\n[build291 8/30 replay] 合格 ${pass} / 不合格 ${fail}`);
process.exit(fail ? 1 : 0);
