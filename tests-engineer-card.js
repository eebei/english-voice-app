'use strict';
const fs = require('fs');
const cards = require('./engineer-card');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  cond ? pass++ : fail++;
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}${cond ? '' : ' -> ' + detail}`);
}

const beforePit = {
  class_pos: 8,
  fuel: 14.5,
  gap_ahead: 0.3,
  standings_gaps: { '19': -20.0 },
  fuel_strategy: {
    avg_fuel_per_lap: 3.452,
    estimated_crossings_to_finish: 8,
    required_fuel_l: 27.617,
    margin_l: -10.642,
    pit_required: true,
    add_fuel_l: 10.642,
  },
  pit_exit_forecast: {
    available: true,
    likely: { position: 17 }, best: { position: 16 }, worst: { position: 18 },
    pit_cycle: {
      observed_pack: Array.from({ length: 10 }, (_, i) => ({ car_idx: i + 1 })),
      if_pack_stops: { likely: { position: 14, pack_car_count: 10 } },
    },
  },
};

const afterPit = {
  ...beforePit,
  class_pos: 20,
  fuel: 26.0,
  fuel_strategy: { ...beforePit.fuel_strategy, margin_l: 4.7, pit_required: false,
    required_fuel_l: 21.3, add_fuel_l: 0 },
  pit_cycle_status: {
    active: true, physical_exit_position: 20, conditional_cycle_position: 14,
    observed_pack_car_count: 10, observed_pack_pit_count: 0,
  },
};

console.log('══ 8/8 Build 253 failure replay -> Build 254 executable engineer cards ══');

let card = cards.classify('燃料の最初の搭載量だ。');
let reply = cards.build(card, { fuel: 31.8, fuel_strategy: {} }, 'ja');
check('initial fuel asks for current tank, not clean-lap strategy',
  card.topic === cards.TOPIC.CURRENT_FUEL && reply === '現在31.8L。', reply);
check('missing fuel is not converted to a fabricated 0.0L',
  cards.build(card, { fuel: null }, 'ja') === '現在燃料は取得できない。');

card = cards.classify('何リットル不足する？計算なの？ゴールまで。');
reply = cards.build(card, beforePit, 'ja');
check('fuel plan gives current/required/add/set',
  /現在14\.5L.*必要総量27\.6L.*13\.1L追加.*14Lセット/.test(reply), reply);
check('fuel plan never repeats invented 20L/26 laps', !/20L|26周/.test(reply), reply);

card = cards.classify('13l90だけど大丈夫？');
check('bare litre follow-up is still a fuel-plan card', card.topic === cards.TOPIC.FUEL_PLAN);

card = cards.classify('アンダーカット 狙えるよ。どうする？');
reply = cards.build(card, beforePit, 'ja');
check('undercut opinion produces an owned box recommendation',
  card.topic === cards.TOPIC.PIT_DECISION
  && /Boxを推奨.*燃料不足.*14Lセット.*ブレンド後P14/.test(reply), reply);

card = cards.classify('彼らが ピットイン 始めて、俺 何番手 ぐらいで復帰できそう？');
reply = cards.build(card, afterPit, 'ja');
check('active blend reports current position and observed stops',
  /現在順位P20.*0\/10台.*ブレンド予測P14/.test(reply), reply);
check('active cycle does not invent P5/P4', !/P5|P4/.test(reply), reply);

reply = cards.build(card, {
  class_pos: 8,
  pit_cycle_outcome: { condition_met: true, post_cycle_actual_position: 8,
    conditional_cycle_position: 14 },
}, 'ja');
check('completed cycle reports actual P8 and grades P14 forecast',
  /実績P8.*予測P14.*6ポジション差/.test(reply), reply);

card = cards.classify('タイムを上げた方がいいの？このままキープ どっちがいい？');
reply = cards.build(card, afterPit, 'ja');
check('pace card gives a decision without invented lap count or consumption',
  /4\.7L余裕.*ペースを上げていい/.test(reply) && !/26周|1L\/周/.test(reply), reply);

card = cards.classify('P19まで何秒？');
reply = cards.build(card, { class_pos: 20, standings_gaps: { '19': -20.0 } }, 'ja');
check('named position gap uses standings map, not nearest 0.2s', /P19まで20\.0秒/.test(reply), reply);

card = cards.classify('もう 計算 出ると思うんだけどな。', {
  race: true, recentText: '何リットル 不足する？ゴールまで。',
});
check('short fuel follow-up inherits the nearest operational card',
  card && card.topic === cards.TOPIC.FUEL_PLAN);

card = cards.classify('ルナの予測は何番手？');
check('prediction shorthand is rejoin card', card && card.topic === cards.TOPIC.REJOIN);

const build255Live = {
  ...afterPit,
  pos: 22, lap: 7, laps_total: null, session_time_remaining_s: 302,
  race_plan: { kind: 'timed', configured_duration_s: 1200, racing_started: true },
  finish_crossings_authority: 4,
  strategy_plan: { revision: 3, action: 'push', reason: 'fuel_margin', margin_l: 4.7 },
  last_pit_service: { lane_total_s: 42.8, stall_s: 18.1, fuel_added_l: 12.6 },
  pit_loss_calibration: { lane_total_median_s: 43.2, lane_total_q1_s: 42.4,
    lane_total_q3_s: 44.0, usable_sample_count: 6 },
  tires: { lf:{w:[91,90,89],t:[80,82,84]}, rf:{w:[88,87,86],t:[83,85,87]},
    lr:{w:[94,93,92],t:[77,79,81]}, rr:{w:[92,91,90],t:[79,81,83]} },
  damage_s: 0,
  weather: { track_temp_c: 41.2, air_temp_c: 28.4, humidity: 61, track_wetness_code: 1 },
  leaders: { player_class: { class_pos: 1, gap_s: -33.4 } },
};

const intentCases = [
  ['燃費は？', cards.TOPIC.FUEL_USE, /3\.45L\/周/],
  ['残り何周？', cards.TOPIC.RACE_DISTANCE, /残り5分2秒.*S\/Fあと4回/],
  ['ピットロス何秒？', cards.TOPIC.PIT_LOSS, /42\.8秒.*実測値/],
  ['今ボックスするべき？', cards.TOPIC.PIT_DECISION, /ステイアウトしてプッシュ/],
  ['直近のピットサービスは？', cards.TOPIC.PIT_SERVICE, /IN→OUT 42\.8秒.*給油12\.6L/],
  ['今何位？', cards.TOPIC.CURRENT_POSITION, /クラスP20、総合P22/],
  ['クラスリーダーまで？', cards.TOPIC.LEADER_GAP, /33\.4秒/],
  ['タイヤの状態は？', cards.TOPIC.TYRE_STATUS, /左前 残89\.0%/],
  ['ダメージは？', cards.TOPIC.DAMAGE_STATUS, /修理残り0\.0秒.*断定しない/],
  ['天候は？', cards.TOPIC.WEATHER_STATUS, /路面41\.2℃.*ドライ/],
  ['トラフィックは？', cards.TOPIC.TRAFFIC_STATUS, /直前車まで0\.3秒/],
  ['戦略プランは？', cards.TOPIC.PLAN_STATUS, /プラン改訂3.*プッシュ/],
];
for (const [utterance, topic, expected] of intentCases) {
  const routed = cards.route(utterance, build255Live, 'ja', { race:true });
  check(`Build 255 handler ${topic}`, routed && routed.card.topic===topic && expected.test(routed.reply), routed&&routed.reply);
}
const unknownRoute = cards.route('ピットの魔法を使える？', build255Live, 'ja', { race:true });
check('unhandled operational request fails closed before LLM',
  unknownRoute && unknownRoute.card.topic===cards.TOPIC.UNRESOLVED_OPERATIONAL
  && /専用handlerに未接続.*推測では答えない/.test(unknownRoute.reply));
check('all Build 255 operational topics have deterministic builders',
  Object.values(cards.TOPIC).length >= 18 && intentCases.every(([u])=>cards.route(u,build255Live,'ja',{race:true})?.reply));
const logReplayCases = [
  ['これでコントロールライン通過すれば燃料消費量わかるかな？', cards.TOPIC.FUEL_USE],
  ['平均消費量がわかるでしょ？1ラップあたりの？', cards.TOPIC.FUEL_USE],
  ['このラップの終わりまでに判断してくれないと困るよ。', cards.TOPIC.PIT_DECISION],
  ['13Lだ。', cards.TOPIC.FUEL_PLAN],
  ['前0.2じゃねえや19秒だよ。', cards.TOPIC.POSITION_GAP],
  ['しかも残り2周だろうよ。ホワイトフラッグ出てねえし。', cards.TOPIC.RACE_DISTANCE],
];
for (const [utterance, topic] of logReplayCases) {
  const replay=cards.route(utterance,build255Live,'ja',{race:true,recentText:'アンダーカット狙える。どうする？'});
  check(`8/8 real-log replay routes ${topic}`,replay&&replay.card.topic===topic,replay&&replay.card.topic);
}

const renderer = fs.readFileSync(__dirname + '/desktop/renderer.html', 'utf8');
check('renderer reads response authority header',
  renderer.includes("res.headers.get('X-Pitwall-Authority')"));
check('renderer records deterministic intent trace without overlay mirroring',
  renderer.includes("res.headers.get('X-Pitwall-Intent')")
  && renderer.includes("diagnosticLog('INTENT_ROUTE'"));
check('deterministic response bypasses generic LLM Truth Gate',
  renderer.includes("responseAuthority!=='deterministic' && selMode==='race'"));
check('critical fuel radio proactively includes physical and conditional pit positions',
  /今入ると物理P/.test(renderer) && /台が止まればP/.test(renderer));
check('safe post-stop fuel transition authorises a pace increase',
  /燃料OK[^\n]+ペースを上げていい/.test(renderer));

console.log('\n══ Build 255 11:23 real-run regression contract ══');
check('770 seconds is spoken as 12 minutes 50 seconds',
  cards.formatDuration(770, 'ja') === '12分50秒');
const outLapLive = {
  ...afterPit,
  class_pos: 3,
  pit_phase_state: 'out_lap',
  fuel: 25.8,
  fuel_strategy: {
    ...afterPit.fuel_strategy,
    required_fuel_l: 24.5,
    margin_l: -10.6,
    pit_required: true,
    add_fuel_l: 0,
  },
  strategy_plan: { revision: 104, action: 'box', reason: 'fuel_shortfall' },
  pit_cycle_status: {
    active: true, physical_exit_position: 20, conditional_cycle_position: 4,
    observed_pack_car_count: 14, observed_pack_pit_count: 4,
  },
};
reply = cards.build(cards.classify('どう、ペース上げて行った方がいいね。'), outLapLive, 'ja');
check('post-stop stale Box is suppressed on the out-lap',
  /アウトラップ.*ペースキープ/.test(reply) && !/ピット優先|Box/.test(reply), reply);
reply = cards.build(cards.classify('どう、ペース上げて行った方がいいね。'), {
  ...outLapLive, fuel: 20.0,
  fuel_strategy: { ...outLapLive.fuel_strategy, required_fuel_l: 24.5 },
}, 'ja');
check('a real post-stop fuel shortfall orders another stop instead of pace keep',
  /給油不足が4\.5L.*次周再ピット/.test(reply) && !/ペースキープ/.test(reply), reply);
reply = cards.build(cards.classify('ルナの予測通りじゃないか？この順位どう？'), outLapLive, 'ja');
check('current P3 supersedes conditional P4 without saying unconfirmed',
  /現在順位P3.*ブレンド予測P4.*1つ上/.test(reply) && !/未確定/.test(reply), reply);
reply = cards.build(cards.classify('ブレンド予測はどうだった？'), {
  class_pos: 3,
  pit_cycle_outcome: {
    condition_met: false, post_cycle_actual_position: 3,
    conditional_cycle_position: 4, observed_pack_pit_count: 4,
    observed_pack_car_count: 14,
  },
}, 'ja');
check('condition-unmet blend outcome still reports actual P3 versus predicted P4',
  /実績P3.*条件付き予測P4.*4\/14台/.test(reply), reply);
reply = cards.build(cards.classify('前との差は？'), {
  class_pos: 3, gap_ahead: 24.1, gap_behind: 22.2,
}, 'ja');
check('post-pit traffic uses current SDK gap, never pre-pit 0.6',
  /直前車まで24\.1秒/.test(reply) && !/0\.6/.test(reply), reply);
reply = cards.build(cards.classify('今ボックスするべき？'), {
  ...outLapLive, pit_phase_state: 'racing', lifecycle_state: 'PLAYER_FINISHED',
}, 'ja');
check('finished race cannot produce another Box plan',
  /レース終了/.test(reply) && !/Boxを推奨|ボックス/.test(reply), reply);
reply = cards.build(cards.classify('了解'), outLapLive, 'ja');
check('race acknowledgement is deterministic and number-free',
  reply === '了解。', reply);

console.log(`\n[Engineer cards] 合格 ${pass} / 不合格 ${fail}`);
process.exit(fail ? 1 : 0);
