'use strict';
const playbook = require('./desktop/strategy-playbook');

let pass = 0;
function check(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}: ${detail}`);
  pass++;
}

const monza = playbook.buildPlaybook({
  track: 'monza full', car: 'Mercedes-AMG GT3 2020',
  raceDetail: { session_type: 'Race', session_time: '1200 sec' },
  historicalFuelPerLapL: 3.582, historicalFuelSamples: 20,
  historicalAverageLapS: 110.0, effectiveCapacityL: 20.14,
  pitLaneS: 28.5, qualifyingPosition: 15, classEntryCount: 20,
});
check('Monza playbook is available', monza.available === true);
check('20-minute format becomes estimated 12 laps', monza.format.estimated_race_laps === 12, JSON.stringify(monza.format));
check('baseline is two stops', monza.plans.A.stop_count === 2, JSON.stringify(monza.plans.A));
check('baseline pit laps are 5 and 10', monza.plans.A.pit_laps.join(',') === '5,10');
check('undercut first stop is lap 4', monza.plans.B.first_pit_lap === 4);
check('undercut does not add a stop', monza.plans.B.available === true);
check('overcut first stop is lap 6', monza.plans.C.first_pit_lap === 6);
check('overcut labels required saving', monza.plans.C.required_fuel_saving_pct > 0);
check('rear-half qualifying prioritises undercut review', monza.opening_priority[0] === 'B');
check('grid briefing is a one-sentence historical handoff',
  /^(?:履歴\d+セッション。)?Plan Aで開始、クリーン3周で更新。$/.test(playbook.briefing(monza, 'ja')));
check('grid briefing defers all alternate-plan detail',
  !/Plan B|Plan C|周目|給油設定/.test(playbook.briefing(monza, 'ja')));
check('planned first add never exceeds tank', monza.plans.A.first_service.estimated_add_l <= 20.14);
check('historical start-fuel assumption stays internal until bridge authority exists',
  !/スタート燃料は.*前提|給油設定.*L/.test(playbook.briefing(monza,'ja')));

const selfCorrected = playbook.buildPlaybook({
  track: 'monza full', car: 'Mercedes-AMG GT3 2020',
  raceDetail: { session_type: 'Race', session_time: '1200 sec' },
  historicalFuelPerLapL: 3.582, historicalFuelSamples: 20,
  historicalAverageLapS: 110.0, effectiveCapacityL: 20.14,
  selfMemory: { memoryId: 'luna-self|rbr|1', tags: ['gap_accuracy', 'fuel_window_proactive'] },
});
check('Luna self-memory tags become explicit Plan B/C conditions',
  selfCorrected.plans.B.conditions.includes('latest_gap_same_frame_required')
  && selfCorrected.plans.C.conditions.includes('latest_gap_same_frame_required')
  && selfCorrected.plans.C.conditions.includes('fuel_window_authority_required'));
check('self-memory provenance is retained in the playbook evidence',
  selfCorrected.evidence.luna_self_memory_id === 'luna-self|rbr|1'
  && selfCorrected.evidence.luna_self_memory_tags.includes('gap_accuracy'));

const live = playbook.updateWithLive(monza, { fuel_strategy: { clean_laps_sampled: 3, avg_fuel_per_lap: 3.7 } });
check('three clean laps replace historical source', live.source === 'live_clean_laps');
check('live sample count is retained', live.evidence.live_fuel_samples === 3);
check('live briefing stays one short measured update',
  playbook.briefing(live, 'ja') === '実測3.70L/周でPlan Aを更新。');
check('two live laps do not replace history', playbook.updateWithLive(monza, {
  fuel_strategy: { clean_laps_sampled: 2, avg_fuel_per_lap: 3.7 },
}) === monza);

const baseLive = {
  session_type: 'Race', session_num: 2, lap: 4, on_track: true, on_pit_road: false,
  gap_ahead: 0.8, fuel: 8.0,
  fuel_strategy: { avg_fuel_per_lap: 3.58 },
  pit_exit_forecast: { available: true, likely: { position: 8, traffic_state: 'clear_air' } },
  pit_next_lap_forecast: { available: true, likely: { position: 7, traffic_state: 'clear_air' } },
};
const sameFrame = {
  snapshot_id: 'live:2:42.5', available: true,
  likely: { position: 8, traffic_state: 'clear_air' },
};
let decision = playbook.evaluateSwitch(monza, {
  ...baseLive, battle_context: { player_pace_advantage_s: 0.7 },
});
check('historical playbook never selects a race plan without bridge authority', decision === null, JSON.stringify(decision));

decision = playbook.evaluateSwitch(monza, {
  ...baseLive,
  fuel_strategy: { avg_fuel_per_lap: 3.58, estimated_crossings_to_finish: 8 },
  strategy_options: { available:true, selected_plan:'B', plan_b:{fuel_window_open:true} },
  battle_context: { player_pace_advantage_s: 0.7 },
});
check('bridge-authoritative fuel window allows undercut candidate', decision && decision.selected_plan === 'B', JSON.stringify(decision));
decision = playbook.evaluateSwitch(monza, {
  ...baseLive, fuel: 12.0,
  fuel_strategy: { avg_fuel_per_lap: 3.58, estimated_crossings_to_finish: 8 },
  strategy_options: { available:true, selected_plan:'C', plan_b:{} },
  battle_context: { player_pace_advantage_s: 0.1 },
});
check('bridge-authoritative evidence allows overcut candidate', decision && decision.selected_plan === 'C', JSON.stringify(decision));
check('missing pace evidence never switches plan', playbook.evaluateSwitch(monza, baseLive) === null);
const selfGuardedDecision = playbook.evaluateSwitch(selfCorrected, {
  ...baseLive,
  fuel_strategy: { avg_fuel_per_lap: 3.58, estimated_crossings_to_finish: 8 },
  strategy_options: { available:true, selected_plan:'B', plan_b:{fuel_window_open:true} },
  pit_exit_forecast: sameFrame,
  pit_next_lap_forecast: {...sameFrame, likely:{position:7,traffic_state:'clear_air'}},
  battle_context: { snapshot_id:sameFrame.snapshot_id, gap_ahead_s:0.8, player_pace_advantage_s:0.7 },
});
check('self-memory guarded switch records same-frame latest-gap proof',
  selfGuardedDecision && selfGuardedDecision.evidence.self_memory_guards.includes('latest_gap_same_frame_verified'),
  JSON.stringify(selfGuardedDecision));
check('gap correction fails closed without same-frame proof', playbook.evaluateSwitch(selfCorrected, {
  ...baseLive,
  fuel_strategy: { avg_fuel_per_lap:3.58, estimated_crossings_to_finish:8 },
  strategy_options: { available:true, selected_plan:'B', plan_b:{fuel_window_open:true} },
  battle_context: { player_pace_advantage_s:0.7 },
}) === null);
check('gap correction rejects a mismatched top-level GAP', playbook.evaluateSwitch(selfCorrected, {
  ...baseLive, gap_ahead:0.9,
  fuel_strategy: { avg_fuel_per_lap:3.58, estimated_crossings_to_finish:8 },
  strategy_options: { available:true, selected_plan:'B', plan_b:{fuel_window_open:true} },
  pit_exit_forecast:sameFrame, pit_next_lap_forecast:sameFrame,
  battle_context:{snapshot_id:sameFrame.snapshot_id,gap_ahead_s:0.8,player_pace_advantage_s:0.7},
}) === null);
check('blend-risk rejoin blocks undercut', playbook.evaluateSwitch(monza, {
  ...baseLive, battle_context: { player_pace_advantage_s: 0.7 },
  pit_exit_forecast: { available: true, likely: { position: 8, traffic_state: 'blend_risk' } },
}) === null);
check('race switch never fires in Practice', playbook.evaluateSwitch(monza, {
  ...baseLive, session_type:'Practice', battle_context:{player_pace_advantage_s:0.7},
}) === null);

const endurance = playbook.buildPlaybook({
  durationS: 10800, historicalFuelPerLapL: 3.0, historicalFuelSamples: 12,
  historicalAverageLapS: 120, effectiveCapacityL: 90,
});
check('three-hour race creates endurance variant', endurance.endurance !== null);
check('endurance no-splash target is calculated', endurance.endurance.no_splash_target_burn_l_per_lap > 0);
check('tyre reduction remains practice-gated', endurance.endurance.tyre_plan_status === 'practice_validation_required');

check('unknown format fails closed', playbook.buildPlaybook({ historicalFuelPerLapL: 3, effectiveCapacityL: 90 }).available === false);
check('missing history fails closed', playbook.buildPlaybook({ durationS: 1200, historicalAverageLapS: 110, effectiveCapacityL: 20 }).reason === 'historical_fuel_unavailable');
check('timed race without average lap fails closed', playbook.buildPlaybook({ durationS: 1200, historicalFuelPerLapL: 3.5, effectiveCapacityL: 20 }).reason === 'historical_average_lap_unavailable');

const fs=require('fs');
const renderer=fs.readFileSync(__dirname+'/desktop/renderer.html','utf8');
check('renderer builds playbook from SessionInfo and exact stored evidence',
  renderer.includes('refreshStrategyPlaybook({announce:true})')
  && renderer.includes('matchingHistoricalAverageLap()'));
check('a new driver can build the first playbook from three live laps',
  renderer.includes("const becameAvailable=!activeStrategyPlaybook?.available")
  && renderer.includes('driver_pace_sample_count)>=3')
  && renderer.includes('refreshStrategyPlaybook({announce:false})'));
check('renderer updates after live clean laps before evaluating a switch',
  renderer.indexOf('updateStrategyPlaybookFromLive(lastTelemetry)')
    < renderer.indexOf('evaluateLiveStrategySwitch(lastTelemetry)'));
check('live decision has trace and speech path',
  renderer.includes("diagnosticLog('STRATEGY_PLAYBOOK_DECISION'")
  && renderer.includes("kind:'strategy_playbook_switch'"));
check('playbook switch refuses to speak before bridge strategy authority exists',
  fs.readFileSync(__dirname+'/desktop/strategy-playbook.js','utf8').includes('authority.available !== true'));

console.log(`✅ strategy playbook: ${pass} checks`);
