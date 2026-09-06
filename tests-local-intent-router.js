#!/usr/bin/env node
'use strict';

// V3 local intent router: all cases are pure fixtures. No network, LLM, STT
// or TTS is allowed in this test.
const router = require('./desktop/local-intent-router.js');
const fs = require('fs');
const renderer = fs.readFileSync('./desktop/renderer.html', 'utf8');
const bridge = fs.readFileSync('./irsdk-bridge/bridge.py', 'utf8');
let pass = 0, fail = 0;
function check(label, condition) {
  (condition ? console.log : console.error)((condition ? '✅ ' : '❌ ') + label);
  condition ? pass++ : fail++;
}
function route(text, live) { return router.route({ text, lang:'ja', live }); }
function routeWithAuthority(text, live) {
  return router.route({text,lang:'ja',live,sessionAuthority:{track:'Nurburgring',car_model:'BMW M4 GT3 EVO',session_type:'Practice'}});
}
const live = {
  fuel: 15.0,
  player_class_position: 8,
  session_time_remaining_s: 465 * 60,
  finish_crossings_authority: 4,
  leaders: { player_class: { gap_s: 12.8, lap:22 }, overall: { gap_s: 44.1, lap:23 } },
  gap_ahead: 4.6,
  gap_behind: 5.8,
  race_plan: { kind:'timed', configured_duration_s: 7200 },
  strategy_options: { available:true, fuel_window_open_in_laps:2,
    plan_b:{ fuel_window_open:false, target_in_laps:2 } },
  fuel_strategy: { avg_fuel_per_lap:2.53, required_fuel_l:10.6, margin_l:4.4, estimated_crossings_to_finish:4 },
  weather: { track_temp_c:23.3, air_temp_c:22.5, humidity:92, track_wetness_code:1 },
};
let r = route('燃料は？', live);
check('fuel is answered locally from exact live facts', r.handled && r.intent==='fuel_status' && r.reply.includes('必要10.6L'));
r = route('このレースのフォーマットは？', live);
check('race format is answered locally', r.handled && r.intent==='race_format' && r.reply==='2時間のタイムレース。');
r = route('残り何周？', live);
check('authoritative short finish crossings are answered locally', r.handled && r.intent==='laps_remaining' && r.reply==='残り4周。');
r = route('残り時間は？', live);
check('long remaining time is spoken in hours and minutes', r.handled && r.reply==='残り7時間45分。');
r = route('トップとの差は？', live);
check('class leader gap is not substituted with a nearest-car gap', r.handled && r.reply==='クラス首位まで12.8秒。');
r = route('トップは今何周目？', live);
check('leader-lap question is answered before the broad leader-gap route',
  r.handled && r.intent==='leader_lap' && r.reply==='クラス首位は22周目。');
r = route('後ろとの差は？', live);
check('behind gap is answered locally from the current Bridge snapshot', r.handled && r.intent==='nearest_gap' && r.reply==='後ろ5.8秒。');
r = route('パンで後ろとの差。', live);
check('a noisy transcript that still contains rear-gap words does not fall through to no-data', r.handled && r.reply==='後ろ5.8秒。');
r = route('前後のギャップは？', live);
check('an explicitly paired gap request returns both authoritative nearest gaps', r.handled && r.reply==='前4.6秒、後ろ5.8秒。');
r = route('後ろとのギャップはどう？', live);
check('8/24 exact rear-gap field phrase returns the live rear value', r.handled && r.reply==='後ろ5.8秒。');
r = route('むしろ ギャップ どう？', live);
check('8/24 directionless noisy gap question returns both nearest values', r.handled && r.reply==='前4.6秒、後ろ5.8秒。');
r = route('出ました。前は？', live);
check('a short follow-up asking for the front gap is still deterministic', r.handled && r.reply==='前4.6秒。');
r = route('後ろとの差は？', {...live,gap_authority:{behind:{target_class:'GT3',target_car_idx:22,gap_s:5.8}}});
check('structured rear gap names the measured class and cannot be relabelled GTP',
  r.handled && r.reply==='後ろのGT3 5.8秒。' && !/GTP/.test(r.reply));
r = route('ちゃんとギャップ答えたよ。', live);
check('a statement about a prior gap answer is acknowledged, not misread as a new query', r.handled && r.intent==='gap_reply_acknowledgement');
r = route('走り始めたらギャップちゃんと教えてね。', live);
check('a future gap-reporting request is acknowledged without a false no-data answer', r.handled && r.intent==='gap_reporting_acknowledgement');
r = route('後ろとの差は？', { gap_ahead:4.6 });
check('missing rear-gap evidence names the unavailable fact instead of generic refusal', r.handled && r.intent==='nearest_gap_unavailable' && r.reply==='後ろのGAPはまだ取れていない。');
r = route('今ポジション何位？', live);
check('current class position is answered locally', r.handled && r.reply==='現在P8。');
r = route('今ポジション何位？', {class_pos:15});
check('Bridge class_pos field is accepted as the authoritative current position',
  r.handled && r.reply==='現在P15。');
const personalHistory=[1,0,2,4,3].map((incidents,index)=>({userId:77,incidents,date:`2026-08-${20+index}`}));
r = router.route({text:'俺のここ5レースでのインシデント平均教えて',lang:'ja',live,
  raceHistory:personalHistory,currentUserId:77});
check('8/28 personal five-race incident average is computed locally from matching records',
  r.handled && r.intent==='incident_average' && r.reply==='直近5レースは合計10、平均2.0インシデント。');
r = router.route({text:'直近5レースのインシデント平均は？',lang:'ja',live,
  raceHistory:personalHistory.slice(0,3),currentUserId:77});
check('personal average fails closed when fewer than the requested races exist',
  r.handled && r.intent==='incident_average_unavailable' && /3レース分/.test(r.reply));
r = router.route({text:'直近5レースのインシデント平均は？',lang:'ja',live,
  raceHistory:personalHistory,currentUserId:null});
check('personal average never crosses an unknown driver identity',
  r.handled && r.intent==='incident_average_unavailable' && /ログイン状態/.test(r.reply));
r = route('了解', live);
check('acknowledgement bypasses cloud', r.handled && r.intent==='acknowledgement' && r.reply==='了解。');
r = route('ベストラップ いくつ？', {...live,best:470.356});
check('8/27 exact best-lap question is answered from Bridge authority',
  r.handled && r.intent==='best_lap' && r.reply==='ベスト7分50秒356。');
r = route('ベストラップ わかります。', {...live,best:470.356});
check('8/27 punctuation-shifted best-lap question remains deterministic',
  r.handled && r.intent==='best_lap' && r.reply==='ベスト7分50秒356。');
r = route('ベストラップいくつ？', {...live,best:null});
check('missing best-lap authority is stated without guessing',
  r.handled && r.intent==='best_lap' && /まだ確定していない/.test(r.reply));
r = routeWithAuthority('ルナ データいってる？', live);
check('8/27 colloquial data-status question is answered locally',
  r.handled && r.intent==='telemetry_status' && /データは来ている/.test(r.reply));
r = routeWithAuthority('コースデータは空いてる？', live);
check('8/27 STT 入ってる→空いてる variant keeps the intended data-status route',
  r.handled && r.intent==='telemetry_status' && /コースと車両も確認済み/.test(r.reply));
r = routeWithAuthority('コースは空いてる？', live);
check('ordinary course-clear question is not overmatched as data status', !r.handled);
r = routeWithAuthority('このデータを解析して', live);
check('a data-analysis request remains a conversation, not a connection check', !r.handled);
r = route('than。', live);
check('unintelligible short transcript is not guessed into an operational intent', !r.handled);
r = route('路面温度は何度？', live);
check('current track temperature is answered locally and briefly', r.handled && r.intent==='track_temperature' && r.reply==='路面23.3℃。');
r = route('昨日の路面温度は？', live);
check('historical track temperature never substitutes the current reading',
  r.handled && r.intent==='historical_weather_unavailable' && /現在値では代用しない/.test(r.reply) && !/23\.3/.test(r.reply));
r = route('昨日は雨だった？', live);
check('historical rain question gets a subject-neutral answer',
  r.handled && r.intent==='historical_weather_unavailable' && /天候記録/.test(r.reply) && !/路面温度/.test(r.reply));
r = route('フューエルウィンドウが開いたら言って', live);
check('future fuel-window instruction arms a local monitor instead of reading generic fuel',
  r.handled && r.intent==='fuel_window_watch'
  && r.action?.type==='arm_fuel_window_watch' && !/15\.0|10\.6/.test(r.reply));
for(const utterance of [
  'フューエル ウィンドウ 開いたら言ってピット 入るわ。',
  'フューエル ウィンドウがいたら教えてくれっっつーの？',
  'フューエル ウィンドウがいたらすぐ入るかもしんないよ。よろしく。台数多いからね。',
]){
  r=route(utterance,live);
  check(`8/23 STT replay arms fuel-window monitor: ${utterance}`,
    r.handled&&r.intent==='fuel_window_watch'&&r.action?.type==='arm_fuel_window_watch');
}
r = route('フューエルウィンドウ空いてない？まだ', live);
check('fuel-window status names the authoritative remaining laps',
  r.handled && r.intent==='fuel_window_status' && r.reply==='まだ。あと2周。');
r = route('フューエルウィンドウ空いてる？', {...live,
  strategy_options:{available:true,plan_b:{fuel_window_open:true,target_in_laps:0}}});
check('open fuel window is answered from Plan B authority',
  r.handled && r.reply==='ウィンドウは開いている。今周から入れる。');
r = route('全くそうなやつばっかだな。', live);
check('race frustration gets a current short acknowledgement, never an old briefing',
  r.handled && r.intent==='race_comment_ack' && r.reply==='了解。落ち着いていこう。');
r = route('無事完走を目指す。', live);
check('race goal gets a considerate local acknowledgement',
  r.handled && r.intent==='race_goal_ack' && r.reply==='了解。完走を優先しよう。');
r = route('俺たちのピットはピットロード 出口に近いところだから。', live);
check('8/23 pit-location report gets a relevant acknowledgement rather than a refusal',
  r.handled&&r.intent==='pit_location_ack'&&/出口寄り/.test(r.reply));
r = route('アンダーカットする？', live);
check('strategy judgement remains with Luna, not local router', !r.handled);
r = route('ピット入る？', live);
check('ambiguous pit decision remains with Luna, not local router', !r.handled);
r = route('燃料は？', { fuel_strategy:{ avg_fuel_per_lap:2.5 } });
check('insufficient fuel evidence is stated without guessing', r.handled && r.reply.includes('クリーン3周'));
r = route('今ポジション何位？', { fuel:10 });
check('unknown position fails closed', r.handled && r.reply.includes('権威データがない'));
r = router.route({ text:'fuel?', lang:'en', live:{ fuel_strategy:{ avg_fuel_per_lap:2.5 } } });
check('English local route preserves the same no-guess contract', r.handled && /clean laps/i.test(r.reply));
const routerScript = renderer.indexOf('<script src="local-intent-router.js"></script>');
const runtimeScript = renderer.indexOf('// API/TTS/STT の宛先');
const localRoute = renderer.indexOf("diagnosticLog('LOCAL_INTENT_ROUTE'");
const cloudRoute = renderer.indexOf("await callAPI(inputSource==='ptt'?'ptt':'typed', memoryStatus);");
check('renderer loads the tested router before its inline runtime', routerScript >= 0 && runtimeScript > routerScript);
// 2026-09-06 ② 構造置換で speak() の引数が増えたため窓を 350→700 へ広げた。
// 契約（local route が callAPI より前に speak+return で終わる）は変えていない。
check('local route returns before the cloud conversation route', localRoute >= 0 && cloudRoute > localRoute && /speak\(reply,[\s\S]{0,700}?return;/.test(renderer.slice(localRoute, cloudRoute)));
const debriefGate = renderer.indexOf('if(evidenceDebrief && evidenceDebrief.active){');
check('8/24 GAP replay: live local facts run before an active debrief can intercept PTT',
  localRoute >= 0 && debriefGate > localRoute
  && renderer.includes("diagnosticLog('LOCAL_INTENT_BYPASS'"));
check('renderer arms and delivers the one-shot fuel-window monitor from telemetry',
  renderer.includes("type==='arm_fuel_window_watch'")
  && renderer.includes('maybeDeliverFuelWindowWatch(lastTelemetry)')
  && renderer.includes('ウィンドウ開いた。今周から入れる。'));
check('renderer supplies personal history and identity to the deterministic router',
  renderer.includes("raceHistory:(typeof loadRaceHistory==='function'?loadRaceHistory():[])")
  && renderer.includes("currentUserId:(typeof currentMemoryUserId==='function'?currentMemoryUserId():null)"));
check('Bridge exports an authoritative lap with both leader records',
  bridge.includes("'lap': (car_laps_all[overall_leader_idx]")
  && bridge.includes("'lap': c.get('lap')"));
check('Bridge gap-trend event has a Japanese radio template', renderer.includes("case 'gap_trend':") && renderer.includes("const side=d.direction==='behind' ? '後ろ' : '前';"));
console.log(`\nLocal Intent Router: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
