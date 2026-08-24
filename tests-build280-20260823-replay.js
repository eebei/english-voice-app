'use strict';

// 2026-08-23 Yuji IMSA Fixed / GT3 replay contract.  These are the exact
// speech-recognition forms that produced irrelevant or stale answers in
// Build 279.  Keep them together so a future intent edit cannot silently
// reopen one branch while the broader unit suites remain green.

const fs = require('fs');
const local = require('./desktop/local-intent-router.js');
const cards = require('./engineer-card.js');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.error(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const live = {
  session_type: 'Race',
  lap: 5,
  position: 13,
  gap_ahead: 4.8,
  gap_behind: 7.2,
  fuel: 18.4,
  race_plan: { kind: 'laps', configured_laps: 20 },
  strategy_options: {
    available: true,
    fuel_window_open_in_laps: 2,
    plan_b: { fuel_window_open: false, target_in_laps: 2 },
  },
  fuel_strategy: {
    avg_fuel_per_lap: 3.5,
    required_fuel_l: 31.5,
    margin_l: -13.1,
    estimated_crossings_to_finish: 9,
  },
};
const localRoute = text => local.route({ text, lang: 'ja', live });

for (const text of [
  'フューエル ウィンドウ 開いたら言ってピット 入るわ。',
  'フューエル ウィンドウがいたら教えてくれっっつーの？',
  'フューエル ウィンドウがいたらすぐ入るかもしんないよ。よろしく。台数多いからね。',
]) {
  const routed = localRoute(text);
  check(`fuel-window watch: ${text}`,
    routed.handled && routed.intent === 'fuel_window_watch'
      && routed.action?.type === 'arm_fuel_window_watch', routed.reply);
}

let routed = localRoute('フューエルウィンドウまだ？');
check('fuel-window status uses the current plan countdown',
  routed.handled && routed.reply === 'まだ。あと2周。', routed.reply);

routed = cards.route('次のしゅ ピット 入ろうかな？', live, 'ja', { race: true });
check('next-lap pit question reaches deterministic pit authority',
  routed && routed.card.topic === cards.TOPIC.PIT_DECISION
    && !/ここでは伝えられない/.test(routed.reply), routed && routed.reply);

routed = cards.route('ドライブする ペナルティ だったよ。', live, 'ja', { race: true });
check('drive-through report gets a relevant acknowledgement',
  routed && routed.card.topic === cards.TOPIC.PENALTY_REPORT
    && routed.reply === '了解。ドライブスルーだったな。', routed && routed.reply);

routed = localRoute('全くそうなやつばっかだな。ここ');
check('frustration cannot replay the Turn-1 briefing',
  routed.handled && routed.reply === '了解。落ち着いていこう。', routed.reply);

routed = localRoute('俺たちのピットはピットロード出口に近い。');
check('pit-location report is acknowledged in its own context',
  routed.handled && /出口寄り/.test(routed.reply), routed.reply);

const engineerSource = fs.readFileSync('./engineer-card.js', 'utf8');
check('production handler no longer emits the banned generic phrase',
  !engineerSource.includes("return ja(lang) ? '今、ここでは伝えられない。'"));

const renderer = fs.readFileSync('./desktop/renderer.html', 'utf8');
check('armed fuel-window watch has a one-shot telemetry delivery path',
  renderer.includes('maybeDeliverFuelWindowWatch(lastTelemetry)')
    && renderer.includes('fuelWindowWatch.announced=true')
    && renderer.includes('ウィンドウ開いた。今周から入れる。'));

console.log(`\n8/23 Build 279 failure replay: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
