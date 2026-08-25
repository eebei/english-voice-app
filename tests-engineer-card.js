'use strict';
const fs = require('fs');
const cards = require('./engineer-card');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  cond ? pass++ : fail++;
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}${cond ? '' : ' -> ' + detail}`);
}

const beforePit = {
  session_type: 'Race',
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
    required_fuel_l: 21.3, add_fuel_l: 0, push_allowed: true },
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

card = cards.classify('ピットまで持たないと思うよ。');
reply = cards.build(card, { fuel: 0.0, fuel_strategy: {} }, 'ja');
check('fuel starvation bypasses next-S/F deferral',
  card.topic === cards.TOPIC.FUEL_EMERGENCY && /燃料0\.0L.*ピット到達は保証できない.*次のS\/F待ちはしない/.test(reply), reply);

// ★Build 266 Codex 差戻し⑨：会話handler(buildFuelEmergency)は無線側が既に確定した
//   fuel_band を同じ権威として読む。band=safeなのに"保証できない"と矛盾させない。
card = cards.classify('ピットまで持たないと思うよ。');
reply = cards.build(card, { fuel: 20.0, fuel_strategy: { fuel_band: 'safe' } }, 'ja');
check('fuel emergency reply agrees with an already-confirmed safe fuel_band',
  card.topic === cards.TOPIC.FUEL_EMERGENCY
  && /燃料20\.0L.*安全域.*ガス欠の兆候はない/.test(reply)
  && !/保証できない/.test(reply), reply);
reply = cards.build(card, { fuel: 20.0, fuel_strategy: {} }, 'ja');
check('fuel emergency reply still hedges when fuel_band is unknown',
  /ピット到達は保証できない/.test(reply), reply);

card = cards.classify('何リットル不足する？計算なの？ゴールまで。');
reply = cards.build(card, beforePit, 'ja');
check('fuel plan gives current/required/add/set',
  /現在14\.5L.*ゴールまで27\.6L必要.*燃料は13\.1L不足.*給油設定14L/.test(reply), reply);
check('fuel plan never repeats invented 20L/26 laps', !/20L|26周/.test(reply), reply);

card = cards.classify('13l90だけど大丈夫？');
check('bare litre follow-up is still a fuel-plan card', card.topic === cards.TOPIC.FUEL_PLAN);

card = cards.classify('アンダーカット 狙えるよ。どうする？');
reply = cards.build(card, beforePit, 'ja');
check('undercut opinion refuses to turn a fuel-only call into strategy',
  card.topic === cards.TOPIC.STRATEGY_SWITCH
  && /ベース戦略がまだ成立していない.*推測では選ばない/.test(reply), reply);
reply = cards.build(card, {
  ...beforePit, gap_ahead:0.8,
  battle_context:{player_pace_advantage_s:0.7},
  strategy_playbook:{available:true,selected_plan:'A',plans:{
    A:{available:true,first_pit_lap:5,pit_laps:[5,10]},
    B:{available:true,first_pit_lap:4,pit_laps:[4,9]},
    C:{available:true,first_pit_lap:6,pit_laps:[6,11],required_fuel_saving_pct:6.4},
  }},
  pit_exit_forecast:{available:true,likely:{position:8,traffic_state:'clear_air'}},
}, 'ja');
check('verified traffic and pace make undercut root cause explicit',
  /Plan B、アンダーカットを推奨.*前走車まで0\.8秒.*こちらが0\.7秒速く詰まっている.*燃料不足ではなくトラフィック回避.*物理復帰P8/.test(reply), reply);

card = cards.classify('2リッター 足りないってこと？');
reply = cards.build(card, {
  session_type: 'Race',
  fuel: 12.83,
  fuel_strategy: { estimated_crossings_to_finish: 4, required_fuel_l: 13.613,
    margin_l: -0.783, pit_required: true },
}, 'ja');
check('spoken リッター shortage follow-up is deterministic and labels set amount',
  card.topic === cards.TOPIC.FUEL_PLAN
  && /2L不足という意味ではない.*燃料は0\.8L不足.*給油設定1L/.test(reply), reply);

card = cards.classify('ギリギリ足りそうだったらゆっくり行くけどどうする？', {
  race: true, recentText: 'ゴールまで燃料は足りる？',
});
reply = cards.build(card, {
  session_type: 'Race',
  fuel: 15.7,
  fuel_strategy: { estimated_crossings_to_finish: 5, required_fuel_l: 16.8,
    margin_l: -1.1, pit_required: true },
}, 'ja');
check('action follow-up leads with this-lap recommendation and separates quantities',
  /この周でピットを推奨.*現在15\.7L.*16\.8L必要.*1\.1L不足.*給油設定2L/.test(reply), reply);

card = cards.classify('彼らが ピットイン 始めて、俺 何番手 ぐらいで復帰できそう？');
reply = cards.build(card, afterPit, 'ja');
check('active blend reports current position and observed stops',
  /現在順位P20.*0\/10台で条件はまだ未成立.*P14は条件付き予測.*一致判定はまだしない/.test(reply), reply);
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
  session_type: 'Race',
  strategy_plan: { revision: 3, action: 'push', reason: 'fuel_margin', margin_l: 4.7 },
  strategy_options: { available:true, selected_plan:'A',
    plan_a:{available:true,target_in_laps:2,target_lap:9,set_fuel_l:11,add_fuel_l:10.5},
    plan_b:{available:true,target_in_laps:3,target_lap:10,set_fuel_l:11,add_fuel_l:10.5} },
  last_pit_service: { lane_total_s: 42.8, stall_s: 18.1, fuel_added_l: 12.6 },
  pit_loss_calibration: { lane_total_median_s: 43.2, lane_total_q1_s: 42.4,
    lane_total_q3_s: 44.0, usable_sample_count: 6 },
  tire_measurement: { available: true, source: 'pit_return', session_time_s: 500 },
  tires: { lf:{w:[91,90,89],t:[80,82,84]}, rf:{w:[88,87,86],t:[83,85,87]},
    lr:{w:[94,93,92],t:[77,79,81]}, rr:{w:[92,91,90],t:[79,81,83]} },
  damage_s: 0,
  weather: { track_temp_c: 41.2, air_temp_c: 28.4, humidity: 61, track_wetness_code: 1 },
  leaders: { player_class: { class_pos: 1, gap_s: -33.4 } },
};

let planRoute=cards.route('プランAは？',build255Live,'ja',{race:true});
check('Plan A can be recalled from deterministic working state',
  planRoute&&planRoute.card.planChoice==='A'&&/あと2周走ってピット、給油設定11L.*基準案/.test(planRoute.reply),planRoute&&planRoute.reply);
planRoute=cards.route('プランBは？',build255Live,'ja',{race:true});
check('Plan B includes a deterministic switch condition',
  planRoute&&planRoute.card.planChoice==='B'&&/あと3周走ってピット、給油設定11L.*復帰トラフィック/.test(planRoute.reply),planRoute&&planRoute.reply);

const intentCases = [
  ['燃費は？', cards.TOPIC.FUEL_USE, /3\.45L\/周/],
  ['残り何周？', cards.TOPIC.RACE_DISTANCE, /残り5分2秒.*残り4周/],
  ['ピットロス何秒？', cards.TOPIC.PIT_LOSS, /42\.8秒.*実測値/],
  ['今ボックスするべき？', cards.TOPIC.PIT_DECISION, /ステイアウトしてプッシュ/],
  ['直近のピットサービスは？', cards.TOPIC.PIT_SERVICE, /IN→OUT 42\.8秒.*給油12\.6L/],
  ['今何位？', cards.TOPIC.CURRENT_POSITION, /クラスP20、総合P22/],
  ['クラスリーダーまで？', cards.TOPIC.LEADER_GAP, /33\.4秒/],
  ['タイヤの状態は？', cards.TOPIC.TYRE_STATUS, /左前 残89\.0%/],
  ['ダメージは？', cards.TOPIC.DAMAGE_STATUS, /修理残り0\.0秒.*断定しない/],
  ['天候は？', cards.TOPIC.WEATHER_STATUS, /路面41\.2℃.*ドライ/],
  ['トラフィックは？', cards.TOPIC.TRAFFIC_STATUS, /直前車まで0\.3秒/],
  ['戦略プランは？', cards.TOPIC.PLAN_STATUS, /ステイアウトしてプッシュ.*燃料余裕/],
];
for (const [utterance, topic, expected] of intentCases) {
  const routed = cards.route(utterance, build255Live, 'ja', { race:true });
  check(`Build 255 handler ${topic}`, routed && routed.card.topic===topic && expected.test(routed.reply), routed&&routed.reply);
}

const practiceFuel = {
  session_type: 'Practice', fuel: 31.7,
  fuel_strategy: { avg_fuel_per_lap: 13.289, estimated_crossings_to_finish: 17,
    required_fuel_l: 225.9, add_fuel_l: 194.2, pit_required: true },
  strategy_plan: { action: 'box', reason: 'fuel_shortfall', set_fuel_l: 195 },
};
reply = cards.route('ゴールまで燃料足りる？', practiceFuel, 'ja', { race:true }).reply;
check('Practice without an authoritative finish target suppresses required/add/pit calls',
  /完走目標が確定していない.*必要燃料・給油量・ピット周は出さない/.test(reply)
  && !/225\.9|195L|ピットを推奨/.test(reply), reply);
reply = cards.route('今ボックスするべき？', practiceFuel, 'ja', { race:true }).reply;
check('stale Practice strategy_plan cannot order a stop',
  /ホールド.*ボックス指示は出さない/.test(reply) && !/195L/.test(reply), reply);

let routed = cards.route('路面温度は？', {
  weather:{track_temp_c:33.9,air_temp_c:19.9,humidity:94,track_wetness_code:1}
}, 'ja', {race:true});
check('路面温度 routes to weather before tyre status',
  routed.card.topic === cards.TOPIC.WEATHER_STATUS && /路面33\.9℃.*気温19\.9℃/.test(routed.reply), routed.reply);
routed = cards.route('昨日の路面温度は？', {
  weather:{track_temp_c:33.9,air_temp_c:19.9,humidity:94,track_wetness_code:1}
}, 'ja', {race:true});
check('historical weather never re-labels current telemetry as yesterday',
  routed.card.topic === cards.TOPIC.HISTORICAL_WEATHER
  && /現在値では代用しない/.test(routed.reply) && !/33\.9/.test(routed.reply), routed.reply);
routed = cards.route('昨日は雨だった？', {
  weather:{track_temp_c:33.9,air_temp_c:19.9,humidity:94,track_wetness_code:1}
}, 'ja', {race:true});
check('historical rain uses a subject-neutral unavailable reply',
  routed.card.topic === cards.TOPIC.HISTORICAL_WEATHER
  && /天候記録/.test(routed.reply) && !/路面温度/.test(routed.reply), routed.reply);
routed = cards.route('ルナ、タイヤ温度。', {
  tire_measurement:{available:false}, weather:{track_temp_c:33.9},
  tires:{lf:{w:[100,100,100],t:[34.6,34.6,34.6]}}
}, 'ja', {race:true});
check('running tyre-temperature query never returns stale 100% wear',
  routed.card.tyreQuery === 'temperature' && /車種によってダッシュ表示/.test(routed.reply)
  && !/100\.0%|34\.6℃/.test(routed.reply), routed.reply);
routed = cards.route('タイヤ摩耗は？', {
  tire_measurement:{available:false}, tires:{lf:{w:[100,100,100]}}
}, 'ja', {race:true});
check('running tyre-wear query waits for pit return',
  routed.card.tyreQuery === 'wear' && /ピット帰還後/.test(routed.reply) && !/100\.0%/.test(routed.reply), routed.reply);
const unknownRoute = cards.route('ピットの魔法を使える？', build255Live, 'ja', { race:true });
check('unhandled operational request names the subject without an internal stock phrase',
  unknownRoute && unknownRoute.card.topic===cards.TOPIC.UNRESOLVED_OPERATIONAL
  && unknownRoute.status==='deferred' && unknownRoute.reply==='そのピット操作は確認できない。'
  && !/今、ここでは伝えられない/.test(unknownRoute.reply), unknownRoute&&unknownRoute.reply);
for(const utterance of ['次の周ピット入ろうかな？','次のしゅ ピット 入ろうかな？']){
  routed = cards.route(utterance, build255Live, 'ja', {race:true});
  check(`8/23 next-lap pit question reaches the pit decision: ${utterance}`,
    routed && routed.card.topic===cards.TOPIC.PIT_DECISION
    && routed.reply!=='今、ここでは伝えられない。', routed&&routed.reply);
}
for(const utterance of ['ドライブスルーペナルティだった。','ドライブする ペナルティ だったよ。']){
  routed = cards.route(utterance, build255Live, 'ja', {race:true});
  check(`8/23 drive-through report receives a human acknowledgement: ${utterance}`,
    routed && routed.card.topic===cards.TOPIC.PENALTY_REPORT
    && routed.reply==='了解。ドライブスルーだったな。', routed&&routed.reply);
}
routed = cards.route('フロントが食わないな。', build255Live, 'ja', {race:true});
check('plain handling report is acknowledged without an unasked setup monologue',
  routed && routed.card.topic===cards.TOPIC.HANDLING_REPORT
  && /フロントの反応を比べよう/.test(routed.reply), routed&&routed.reply);
card = cards.classify('燃料 0になってるけど。', {race:true});
reply = cards.build(card, {...build255Live, fuel:0}, 'ja');
check('fuel-zero wording routes to an immediate measured emergency handler',
  card.topic===cards.TOPIC.FUEL_EMERGENCY && /燃料0\.0L.*次のS\/F待ちはしない/.test(reply), reply);
card = cards.classify('レースのフォーマットは知ってますか？', {race:true});
reply = cards.build(card, build255Live, 'ja');
check('session-format question has a deterministic SessionInfo answer',
  card.topic===cards.TOPIC.SESSION_FORMAT && /Race、20分のレース。残り5分2秒。/.test(reply), reply);
for (const utterance of ['ルナ 今日のレース フォーマットは？', 'レースフォーマーと どうなった？', '何分 製のレースなの？それ？']) {
  card = cards.classify(utterance, {race:true});
  reply = cards.build(card, build255Live, 'ja');
  check('8/9 real format wording is deterministic: '+utterance,
    card.topic===cards.TOPIC.SESSION_FORMAT && /Race、20分のレース。残り5分2秒。/.test(reply), reply);
}
for (const utterance of ['このセッションなんだっけ？', 'セッションどれ？', '練習、予選、決勝はどういう流れ？']) {
  card=cards.classify(utterance,{race:true});
  check('session identity wording is deterministic: '+utterance,
    card&&card.topic===cards.TOPIC.SESSION_FORMAT,card&&card.topic);
}
card=cards.classify('あと何週？',{race:true});
check('STT 周→週 variation remains race distance',card&&card.topic===cards.TOPIC.RACE_DISTANCE,card&&card.topic);

reply=cards.route('ゴールまで燃料は？',{
  ...build255Live,fuel:4.9,
  fuel_strategy:{avg_fuel_per_lap:3.613,clean_laps_sampled:3,
    estimated_crossings_to_finish:7,required_fuel_l:25.289,evaluated_fuel_l:4.9,
    add_fuel_l:20.389,set_fuel_l:20,effective_capacity_l:20.14,one_stop_shortfall_l:0.389,
    pit_required:true},
},'ja',{race:true}).reply;
check('20.14L effective tank never becomes an impossible 21L setting',
  /燃料は20\.4L不足.*設定上限20Lでも一度では0\.4L不足/.test(reply)&&!/設定21L/.test(reply),reply);

card=cards.classify('これチェッカー前にもう1回スプラッシュあるか？',{race:true});
reply=cards.build(card,{
  session_type:'Race',fuel:4.4,
  timed_finish_forecast:{confidence:'model_valid',leader_time_to_checkered_s:866,
    driver_time_to_next_sf_s:107,driver_avg_lap_s:108.24},
  pit_loss_calibration:{observed_loss_median_s:27.7},
  fuel_strategy:{avg_fuel_per_lap:3.678,estimated_crossings_to_finish:9,
    required_fuel_l:33.1,add_fuel_l:28.7,one_stop_shortfall_l:5.4,
    effective_capacity_l:23.32,reserve_l:0.5,pit_required:true},
},'ja');
check('splash question uses post-stop checker clock instead of stale 9-crossing reply',
  card.topic===cards.TOPIC.FUEL_PLAN&&card.splashQuestion===true
  &&/スプラッシュ不要.*約0\.8L余る/.test(reply)&&!/S\/F|9回/.test(reply),reply);

reply=cards.route('戦略プランは？',{
  ...build255Live,
  strategy_playbook:{available:true,selected_plan:'A',plans:{
    A:{available:true,pit_laps:[5,10]},B:{available:true,first_pit_lap:4,pit_laps:[4,9]},
    C:{available:true,first_pit_lap:6,pit_laps:[6,11],required_fuel_saving_pct:6.4},
  }},
},'ja',{race:true}).reply;
check('driver-facing Plan A/B/C meanings are stable',
  /Plan Aは基準.*Plan Bは燃料ウィンドウ成立時のアンダーカット.*Plan Cは節約燃費が成立した時のオーバーカット.*具体的なピット周は当日計算が揃ってから/.test(reply),reply);
card = cards.classify('今 16位だけど、なんか 戦略 ある？', {race:true});
reply = cards.build(card, {...build255Live, class_pos:16, fuel_strategy:{avg_fuel_per_lap:3.63,clean_laps_sampled:1}}, 'ja');
check('8/9 real strategy wording gives facts and a fuel-evidence condition',
  card.topic===cards.TOPIC.PLAN_STATUS && /現在P16。残り5分2秒。燃費はクリーン1周.*あと2周/.test(reply), reply);
card = cards.classify('ディスラップボックス。', {race:true});
check('STT this-lap-box variation routes to pit decision', card.topic===cards.TOPIC.PIT_DECISION, card&&card.topic);
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
const bridge = fs.readFileSync(__dirname + '/irsdk-bridge/bridge.py', 'utf8');
check('renderer reads response authority header',
  renderer.includes("res.headers.get('X-Pitwall-Authority')"));
check('renderer records deterministic intent trace without overlay mirroring',
  renderer.includes("res.headers.get('X-Pitwall-Intent')")
  && renderer.includes("diagnosticLog('INTENT_ROUTE'"));
check('deterministic response bypasses generic LLM Truth Gate',
  renderer.includes("responseAuthority!=='deterministic' && selMode==='race'"));
check('generic unresolved replies do not auto-repeat at the next S/F',
  renderer.includes("OPERATIONAL_FOLLOWUP_SUPPRESSED','reason=no_concrete_update_contract")
  && !renderer.includes("armOperationalFollowUp(responseIntent,latestUserText)"));
check('renderer promotes SessionInfo duration into Race live telemetry',
  renderer.includes('function applySessionFormatAuthority(snapshot)')
  && renderer.includes('configured_duration_s:duration')
  && renderer.includes('lastTelemetry=applySessionFormatAuthority(data)'));
check('critical fuel radio is a short driver action, not a telemetry dump',
  /この周ボックス。\$\{setting\}リットル/.test(renderer)
  && !/return `この周でピットを推奨。現在/.test(renderer));
check('both fuel reflex paths become Luna working state',
  renderer.includes("data.trigger==='fuel_warning'||data.trigger==='fuel_strategy_warning'")
  && renderer.includes('buildActiveRaceFactsNote(_isJP_pre)'));
check('initial Plan A/B radio becomes Luna working state',
  renderer.includes("case 'initial_strategy_plans'")
  && renderer.includes("data.trigger==='initial_strategy_plans'")
  && renderer.includes('strategyOptions:data.strategy_options'));
// ★Plan B定義の判断（2026-08-12）：B は「1周延長」ではなく条件付きアンダーカット。
// 旧文言（1周延長／延長案）が残っていないことも併せて確認する。
check('Fuel Window T-1 has a proactive measured A/B decision path',
  renderer.includes("case 'strategy_plan_decision'")
  && renderer.includes("data.trigger==='strategy_plan_decision'")
  && /アンダーカットで決定/.test(renderer)
  && /int\(lap\) >= max\(0, _decision_target - 1\)/.test(bridge));
check('selected Plan B has a separate next-lap box call',
  renderer.includes("case 'strategy_plan_box_call'")
  && renderer.includes("予定どおりこの周でピット"));
check('Plan Bの無線に「延長」が混ざらない',
  !/アンダーカットで決定[^`]*延長/.test(renderer));
check('executed Plan A/B outcome is persisted and traceable',
  renderer.includes('recordStrategyOptionOutcome(data)')
  && renderer.includes("'pw_strategy_option_outcomes'")
  && renderer.includes("diagnosticLog('STRATEGY_OPTIONS_OUTCOME'"));
check('session transition resets working state under the incoming SessionNum',
  renderer.includes('resetSessionScopedReviewState(nextSessionNum)')
  && renderer.includes('sessionKey:String(nextSessionNum??lastSessionNum'));
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
check('out-lap pace answer does not pretend the fuel-save quantity is final',
  /燃費セーブ量は次の有効周で更新する/.test(reply) && !/ピット完了/.test(reply), reply);
reply = cards.build(cards.classify('どう、ペース上げて行った方がいいね。'), {
  ...outLapLive, fuel: 20.0,
  fuel_strategy: { ...outLapLive.fuel_strategy, required_fuel_l: 24.5 },
}, 'ja');
check('a real post-stop fuel shortfall orders another stop instead of pace keep',
  /給油不足が4\.5L.*次の周で再ピット/.test(reply) && !/ペースキープ/.test(reply), reply);
reply = cards.build(cards.classify('プッシュしていい？大丈夫？'), {
  session_type:'Race', fuel:7.4,
  fuel_strategy:{required_fuel_l:7.26, margin_l:1.465, push_allowed:false,
    estimated_crossings_to_finish:2, pit_required:false, add_fuel_l:0},
}, 'ja');
check('8/14 live replay never double-counts current-lap burn into a false push call',
  reply === '燃料は1.5L余裕。ペースキープ。', reply);
reply = cards.build(cards.classify('プッシュしていい？大丈夫？'), {
  session_type:'Race', fuel:8.8,
  fuel_strategy:{required_fuel_l:7.26, margin_l:1.5, push_allowed:true,
    estimated_crossings_to_finish:2, pit_required:false, add_fuel_l:0},
}, 'ja');
check('explicit Bridge push permission is required before a push call',
  reply === '燃料は1.5L余裕。ペースを上げていい。', reply);
check('8/14 spoken pit wording routes to the pit-decision handler',
  cards.classify('ピット 入る？').topic === cards.TOPIC.PIT_DECISION);
check('8/14 STT 周/州 wording routes to the pit-decision handler',
  cards.classify('どうするのはこの州 入るのか？次の週なのか？').topic === cards.TOPIC.PIT_DECISION);
check('8/14 provisional-position wording routes to the rejoin handler',
  cards.classify('暫定 何番手 ぐらい？').topic === cards.TOPIC.REJOIN);
check('8/14 bare box acknowledgement routes to the pit-decision handler',
  cards.classify('ボックス。').topic === cards.TOPIC.PIT_DECISION);
check('8/14 missed-pit report routes to the pit-decision handler',
  cards.classify('今ピットに入れなかった。').topic === cards.TOPIC.PIT_DECISION);
reply = cards.build(cards.classify('これどう？燃料を最後まで持つ どんな感じ？'), {
  session_type: 'Race', fuel: 20.124,
  fuel_strategy: {
    avg_fuel_per_lap: 3.47, estimated_crossings_to_finish: 6,
    required_fuel_l: 20.82, evaluated_fuel_l: 22.252,
    margin_l: 1.432, add_fuel_l: 0, pit_required: false,
    post_pit_margin_hold: true, post_pit_margin_l: 1.432,
  },
}, 'ja');
check('8/14 post-pit replay keeps the 1.43L margin through the same lap',
  reply === '燃料は足りる。ピット後の完走余裕は1.4L。次のS/Fで更新する。', reply);
reply = cards.build(cards.classify('ルナの予測通りじゃないか？この順位どう？'), outLapLive, 'ja');
check('current P3 does not grade conditional P4 before the stop condition is met',
  /現在順位P3.*4\/14台で条件はまだ未成立.*P4は条件付き予測.*一致判定はまだしない/.test(reply), reply);
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
reply = cards.build(cards.classify('ファイナルラップ', { race: true }), outLapLive, 'ja');
check('8/14 final-lap acknowledgement bypasses generic truth gate',
  reply === '了解。ファイナルラップ。', reply);

const mixedPitSnapshot = {
  session_type: 'Race', fuel: 22.2,
  fuel_strategy: { avg_fuel_per_lap: 3.51, laps_of_fuel_left: 0.4,
    evaluated_fuel_l: 1.5 },
};
reply = cards.build(cards.classify('燃料消費は？'), mixedPitSnapshot, 'ja');
check('post-pit fuel-use recomputes range from current fuel, never the pre-pit snapshot',
  /平均3\.51L\/周.*約6\.3周/.test(reply) && !/約0\.4周/.test(reply), reply);
reply = cards.build(cards.classify('ゴールまで燃料は？'), {
  ...mixedPitSnapshot,
  fuel_strategy: { ...mixedPitSnapshot.fuel_strategy, estimated_crossings_to_finish: 3,
    required_fuel_l: 10.6, margin_l: 11.6, pit_required:false },
}, 'ja');
check('finish-crossing wording states that the current lap is included',
  /現在周を含めて、チェッカーまでS\/Fあと3回/.test(reply), reply);

check('465 minutes is spoken as hours and minutes',
  cards.formatDuration(465*60,'ja') === '7時間45分', cards.formatDuration(465*60,'ja'));
check('driver position report is an acknowledgement, not unresolved',
  cards.classify('Luna 今ポジション8位', {race:true}).topic === cards.TOPIC.ACKNOWLEDGEMENT);
reply=cards.build(cards.classify('Luna 今ポジション8位',{race:true}),{class_pos:8,pos:8},'ja');
check('matching position report is acknowledged with team truth',
  reply === '了解、現在P8。',reply);
reply=cards.build(cards.classify('今8位',{race:true}),{class_pos:7,pos:7},'ja');
check('mismatching position report is corrected from telemetry',
  reply === '確認、現在P7。',reply);
reply=cards.build(cards.classify('はい、ピットイン！',{race:true}),{on_pit_road:true},'ja');
check('pit-entry report gets a short acknowledgement',
  reply === '了解、ピットイン。',reply);
check('STT ビット timing normalizes to pit decision',
  cards.classify('次のビット タイミングはいつ？',{race:true}).topic === cards.TOPIC.PIT_DECISION);

const enduranceLive={
  session_type:'Race',fuel:92,
  fuel_strategy:{avg_fuel_per_lap:4.12,estimated_crossings_to_finish:104,
    required_fuel_l:429,evaluated_fuel_l:92,margin_l:-337,add_fuel_l:337,
    endurance_plan:{available:true,multi_stop:true,box_this_lap:false,
      next_fuel_stop_in_laps:22,future_stop_count:4,
      splash_forecast:{available:false,reason:'race_not_halfway'}}}
};
reply=cards.build(cards.classify('ゴールまで燃料は？'),enduranceLive,'ja');
check('endurance reply never reads the 429L total as a pit-now shortage',
  /次の給油目安はあと22周.*残り給油は4回/.test(reply)&&!/429|この周/.test(reply),reply);
reply=cards.build(cards.classify('次のビット タイミングはいつ？',{race:true}),enduranceLive,'ja');
check('endurance pit timing answers current-stint horizon',
  reply === 'ステイアウト。次の給油目安はあと22周。',reply);

reply=cards.build(cards.classify('燃料不足は？'),{
  session_type:'Race',fuel:10.4,
  fuel_strategy:{estimated_crossings_to_finish:4,required_fuel_l:14.5,
    evaluated_fuel_l:12.8,add_fuel_l:1.7,margin_l:-1.7}
},'ja');
check('same-lap fuel answer uses one time basis',
  /現在10\.4L.*ゴールまで12\.1L必要.*燃料は1\.7L不足/.test(reply),reply);
reply=cards.build(cards.classify('燃料不足は？'),{
  session_type:'Race',lap:9,fuel:10.4,
  fuel_strategy:{evaluated_lap:8,estimated_crossings_to_finish:4,
    required_fuel_l:14.5,evaluated_fuel_l:12.8,add_fuel_l:1.7,margin_l:-1.7}
},'ja');
check('continuous no-refuel fuel answer keeps one time basis across a crossing',
  /現在10\.4L.*ゴールまで12\.1L必要.*燃料は1\.7L不足/.test(reply),reply);

const changedQuantityCard=cards.classify('ゴールまでの数量が増えちゃってるぞ。',{race:true});
reply=cards.build(changedQuantityCard,{
  session_type:'Race',fuel:9.6,
  fuel_strategy:{estimated_crossings_to_finish:4,required_fuel_l:14.5,
    evaluated_fuel_l:12.8,add_fuel_l:1.7,margin_l:-1.7}
},'ja');
check('8/15 exact changing-quantity report reaches fuel authority',
  changedQuantityCard.topic===cards.TOPIC.FUEL_PLAN&&/現在9\.6L.*ゴールまで11\.3L必要.*1\.7L不足/.test(reply),reply);

console.log(`\n[Engineer cards] 合格 ${pass} / 不合格 ${fail}`);
process.exit(fail ? 1 : 0);
