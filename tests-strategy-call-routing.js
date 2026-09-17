#!/usr/bin/env node
'use strict';

const fs = require('fs');
const playbookEngine = require('./desktop/strategy-playbook');
const router = require('./desktop/local-intent-router');

let pass = 0;
function check(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}: ${detail}`);
  pass++;
}

const playbook = playbookEngine.buildPlaybook({
  durationS: 1200,
  historicalFuelPerLapL: 3.58,
  historicalFuelSamples: 10,
  historicalAverageLapS: 110,
  effectiveCapacityL: 20.14,
  qualifyingPosition: 15,
  classEntryCount: 20,
});

const baseLive = {
  session_type: 'Race', session_num: 7, lap: 4,
  on_track: true, on_pit_road: false,
  fuel: 12.0, gap_ahead: 0.8,
  fuel_strategy: { avg_fuel_per_lap: 3.58, estimated_crossings_to_finish: 8 },
  pit_exit_forecast: {
    available: true, snapshot_id: 's7:4',
    likely: { position: 8, traffic_state: 'clear_air' },
  },
  pit_next_lap_forecast: {
    available: true, snapshot_id: 's7:4',
    likely: { position: 7, traffic_state: 'clear_air' },
  },
  battle_context: {
    snapshot_id: 's7:4', gap_ahead_s: 0.8,
    player_pace_advantage_s: 0.7,
  },
};

const withAuthority = (selectedPlan, extra = {}) => ({
  ...baseLive, ...extra,
  strategy_options: {
    available: true, snapshot_id: 's7:4', selected_plan: selectedPlan,
    plan_a: { available: true, target_lap: 5, target_in_laps: 1 },
    plan_b: { available: true, fuel_window_open: true, target_lap: 4, target_in_laps: 0 },
    plan_c: { available: true, target_lap: 6, target_in_laps: 2 },
  },
});

const evaluationB = playbookEngine.evaluateStrategies(playbook, withAuthority('B'));
check('A/B/C are evaluated in one snapshot',
  evaluationB.available && Object.keys(evaluationB.candidates).join(',') === 'A,B,C');
check('coordinator returns exactly one recommendation',
  evaluationB.recommendation && evaluationB.recommendation.selected_plan === 'B'
  && Object.values(evaluationB.candidates).filter(p => p.status === 'recommended').length === 1,
  JSON.stringify(evaluationB));

function ask(text, live) {
  return router.route({
    text, lang: 'ja', live,
    strategyEvaluation: { api: playbookEngine, playbook },
  });
}

let result = ask('アンダーカット行ける？', withAuthority('B'));
check('Driver undercut call uses the shared recommendation without LLM',
  result.handled && result.intent === 'strategy_undercut'
  && result.action.selectedPlan === 'B'
  && /今周ピットを推す/.test(result.reply)
  && /復帰予測P8/.test(result.reply), JSON.stringify(result));

result = ask('オーバーカットはどう？', withAuthority('C', {
  battle_context: { snapshot_id:'s7:4', gap_ahead_s:0.8, player_pace_advantage_s:0.1 },
}));
check('Driver overcut call reads the same coordinator',
  result.handled && result.intent === 'strategy_overcut'
  && result.action.selectedPlan === 'C'
  && /もう1周走る案を推す/.test(result.reply)
  && /今入るとP8、次周ならP7/.test(result.reply), JSON.stringify(result));

result = ask('今ピット入る？', withAuthority('A'));
check('broad pit question returns the single normal recommendation',
  result.handled && result.intent === 'strategy_recommendation'
  && result.action.selectedPlan === 'A'
  && /通常プラン継続/.test(result.reply)
  && /5周を終えて/.test(result.reply), JSON.stringify(result));

result = ask('アンダーカットする？', withAuthority('A'));
check('specific undercut question explains that its conditions are not met',
  result.handled && result.intent === 'strategy_undercut'
  && result.action.selectedPlan === 'A'
  && /アンダーカット条件未成立/.test(result.reply)
  && /通常プラン継続/.test(result.reply), JSON.stringify(result));

const held = withAuthority('B', { battle_context: { player_pace_advantage_s:null } });
result = ask('作戦どうする？', held);
check('alternate selected without same-frame evidence is held, never replaced by a conflicting plan',
  result.handled && result.intent === 'strategy_consultation_held'
  && result.action.selectedPlan === null
  && /最新のペースと復帰位置を確認中/.test(result.reply), JSON.stringify(result));

result = router.route({ text:'アンダーカットする？', lang:'ja', live:withAuthority('B') });
check('missing strategy wiring fails closed to the existing conversation route', !result.handled);

const renderer = fs.readFileSync('./desktop/renderer.html', 'utf8');
check('product route injects the active playbook and tested strategy engine',
  /strategyEvaluation:\(typeof activeStrategyPlaybook!==['"]undefined['"][\s\S]{0,160}\{playbook:activeStrategyPlaybook,api:window\.PitwallStrategyPlaybook\}/.test(renderer));
check('proactive radio consumes evaluateStrategies instead of deciding independently',
  /function evaluateLiveStrategySwitch[\s\S]{0,350}engine\.evaluateStrategies/.test(renderer));

console.log(`✅ Strategy Call Routing: ${pass} checks`);
