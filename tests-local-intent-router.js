#!/usr/bin/env node
'use strict';

// V3 local intent router: all cases are pure fixtures. No network, LLM, STT
// or TTS is allowed in this test.
const router = require('./desktop/local-intent-router.js');
const fs = require('fs');
const renderer = fs.readFileSync('./desktop/renderer.html', 'utf8');
let pass = 0, fail = 0;
function check(label, condition) {
  (condition ? console.log : console.error)((condition ? '✅ ' : '❌ ') + label);
  condition ? pass++ : fail++;
}
function route(text, live) { return router.route({ text, lang:'ja', live }); }
const live = {
  fuel: 15.0,
  player_class_position: 8,
  session_time_remaining_s: 465 * 60,
  finish_crossings_authority: 4,
  leaders: { player_class: { gap_s: 12.8 }, overall: { gap_s: 44.1 } },
  race_plan: { kind:'timed', configured_duration_s: 7200 },
  fuel_strategy: { avg_fuel_per_lap:2.53, required_fuel_l:10.6, margin_l:4.4, estimated_crossings_to_finish:4 },
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
r = route('今ポジション何位？', live);
check('current class position is answered locally', r.handled && r.reply==='現在P8。');
r = route('了解', live);
check('acknowledgement bypasses cloud', r.handled && r.intent==='acknowledgement' && r.reply==='了解。');
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
check('local route returns before the cloud conversation route', localRoute >= 0 && cloudRoute > localRoute && /speak\(reply,[\s\S]{0,350}?return;/.test(renderer.slice(localRoute, cloudRoute)));
console.log(`\nLocal Intent Router: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
