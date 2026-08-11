'use strict';
// Build 265 fix A regression tests.  The bridge fuel-band warning must not
// tell the driver to pit when the active plan window is still reachable and
// the planned service finishes.  It must still fire when the plan truly
// breaks (cannot reach the window, or the planned service exceeds capacity /
// cannot finish).

const guard = require('./desktop/fuel-plan-guard');
const fs = require('fs');

let pass = 0;
function check(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}: ${detail}`);
  pass++;
}

// Shared playbook shape identical to what strategy-playbook.js produces for
// Monza 35 / GT3 one-make at lap 5.
function monzaPlaybook(overrides = {}) {
  const plans = {
    A: {
      id: 'A', kind: 'baseline', available: true,
      first_pit_lap: 14, pit_laps: [14], stop_count: 1,
      first_service: { estimated_add_l: 24.6, target_onboard_l: 26.2, entry_fuel_l: 1.6 },
    },
    B: {
      id: 'B', kind: 'undercut', available: true,
      first_pit_lap: 13, pit_laps: [13], stop_count: 1,
      first_service: { estimated_add_l: 24.6, target_onboard_l: 29.9, entry_fuel_l: 5.3 },
    },
    C: {
      id: 'C', kind: 'overcut', available: true,
      first_pit_lap: 15, pit_laps: [15], stop_count: 1,
      first_service: { estimated_add_l: 22, target_onboard_l: 22.5, entry_fuel_l: 0.5 },
      required_first_stint_burn_l_per_lap: 3.5,
      required_fuel_saving_pct: 4.6,
    },
  };
  return {
    available: true, source: 'live_clean_laps', selected_plan: 'A',
    evidence: { effective_capacity_l: 53, live_fuel_l_per_lap: 3.641, live_fuel_samples: 3 },
    format: { kind: 'timed', total_laps: null, duration_s: 2100, estimated_race_laps: 21 },
    safe_stint_laps: 14,
    plans: { ...plans, ...(overrides.plans || {}) },
    ...overrides,
  };
}

// --- Test 1: Monza 35 regression. ------------------------------------------
// Lap 5, fuel 37.63, burn 3.641, plan A pit lap 14 → 9 laps to pit.
// Required to plan window: 9 * 3.641 + reserve = 33.269L. Fuel 37.63L is
// sufficient. The bridge tags this as critical because 21 * 3.641 = 76L
// finish requirement; the plan's 24.6L stop fixes that. Guard MUST suppress.
const monza35 = guard.evaluatePlanFuelDecision({
  fuelBand: 'critical', currentFuelL: 37.63, avgFuelPerLapL: 3.641,
  currentLap: 5, playbook: monzaPlaybook(), effectiveCapacityL: 53,
});
check('Monza 35 regression: pit-now speech is suppressed', monza35.allow_p0_pit_now === false,
  JSON.stringify(monza35));
check('Monza 35 regression: suppression_reason names the reachable window',
  monza35.suppression_reason === 'plan_window_reachable', JSON.stringify(monza35));
check('Monza 35 regression: reach-pit margin is positive', monza35.reach_pit_margin_l > 0,
  String(monza35.reach_pit_margin_l));
check('Monza 35 regression: exposes planned fuel add to the driver',
  monza35.planned_add_l === 24.6, JSON.stringify(monza35.driver_facing_update));
check('Monza 35 regression: laps to pit is 9', monza35.laps_to_pit === 9);
check('Monza 35 regression: driver-facing update carries the planned add',
  monza35.driver_facing_update && monza35.driver_facing_update.planned_add_l === 24.6);

// --- Test 2: True fuel emergency. ------------------------------------------
// Plan A pit lap 14, current lap 5 (9 laps to pit), burn 3.641, but only 5L
// of fuel: cannot reach the plan window (5 - 9*3.641 = -27.7L).  Must fire.
const emergency = guard.evaluatePlanFuelDecision({
  fuelBand: 'critical', currentFuelL: 5.0, avgFuelPerLapL: 3.641,
  currentLap: 5, playbook: monzaPlaybook(), effectiveCapacityL: 53,
});
check('True emergency: pit-now speech is allowed', emergency.allow_p0_pit_now === true,
  JSON.stringify(emergency));
check('True emergency: override_reason names the failure',
  emergency.override_reason === 'cannot_reach_selected_pit_window', JSON.stringify(emergency));
check('True emergency: reach-pit margin is negative', emergency.reach_pit_margin_l < 0);

// --- Test 3: Planned service exceeds capacity. ------------------------------
// Playbook says add 60L but capacity is 53L → the planned stop cannot
// actually execute; a new decision is needed.  Guard MUST fire.
const overshoot = guard.evaluatePlanFuelDecision({
  fuelBand: 'critical', currentFuelL: 37.63, avgFuelPerLapL: 3.641,
  currentLap: 5, effectiveCapacityL: 53,
  playbook: monzaPlaybook({ plans: {
    A: {
      id: 'A', kind: 'baseline', available: true,
      first_pit_lap: 14, pit_laps: [14], stop_count: 1,
      first_service: { estimated_add_l: 60, target_onboard_l: 60, entry_fuel_l: 0 },
    },
  }}),
});
check('Planned service exceeds capacity: pit-now speech is allowed',
  overshoot.allow_p0_pit_now === true, JSON.stringify(overshoot));
check('Planned service exceeds capacity: override_reason is capacity',
  overshoot.override_reason === 'planned_service_exceeds_capacity', JSON.stringify(overshoot));
check('Planned service exceeds capacity: capacity_fits_plan is false',
  overshoot.capacity_fits_plan === false);

// --- Extra: tight band is never a pit-now. ---------------------------------
const tight = guard.evaluatePlanFuelDecision({
  fuelBand: 'tight', currentFuelL: 37.63, avgFuelPerLapL: 3.641,
  currentLap: 5, playbook: monzaPlaybook(), effectiveCapacityL: 53,
});
check('tight band never triggers pit-now', tight.allow_p0_pit_now === false
  && tight.suppression_reason === 'not_critical', JSON.stringify(tight));

// --- Extra: at planned pit lap WITH complete proofs → SUPPRESS. -------------
// ★Codex 差戻し 3：capacity fits + planned_add defined + post-stop finish ≥ 0
//   の 3 証明が揃った時だけ P0 を silence。
const atWindow = guard.evaluatePlanFuelDecision({
  fuelBand: 'critical', currentFuelL: 6.0, avgFuelPerLapL: 3.641,
  currentLap: 14, playbook: monzaPlaybook(), effectiveCapacityL: 53,
  remainingCrossingsAfterStop: 7,
});
check('at planned pit lap with complete proofs, P0 is suppressed',
  atWindow.allow_p0_pit_now === false
  && atWindow.suppression_reason === 'planned_pit_lap_speaks_via_strategy_decision',
  JSON.stringify(atWindow));
check('at planned pit lap, finish_margin_after_stop_l is proven',
  Number.isFinite(atWindow.finish_margin_after_stop_l)
  && atWindow.finish_margin_after_stop_l >= 0, JSON.stringify(atWindow));

// --- Extra: at planned pit lap WITHOUT finish proof → ALLOW P0 (safe). ------
const atWindowNoProof = guard.evaluatePlanFuelDecision({
  fuelBand: 'critical', currentFuelL: 6.0, avgFuelPerLapL: 3.641,
  currentLap: 14, playbook: monzaPlaybook(), effectiveCapacityL: 53,
  // remainingCrossingsAfterStop omitted → finish margin cannot be proven
});
check('at planned pit lap without finish proof, P0 is allowed (safe side)',
  atWindowNoProof.allow_p0_pit_now === true
  && atWindowNoProof.override_reason === 'planned_pit_lap_but_strategy_proof_incomplete',
  JSON.stringify(atWindowNoProof));

// --- Extra: at planned pit lap when capacity does not fit → ALLOW P0. -------
const atWindowOversized = guard.evaluatePlanFuelDecision({
  fuelBand: 'critical', currentFuelL: 6.0, avgFuelPerLapL: 3.641,
  currentLap: 14, effectiveCapacityL: 53, remainingCrossingsAfterStop: 7,
  playbook: monzaPlaybook({ plans: {
    A: {
      id: 'A', kind: 'baseline', available: true,
      first_pit_lap: 14, pit_laps: [14], stop_count: 1,
      first_service: { estimated_add_l: 999, target_onboard_l: 999, entry_fuel_l: 0 },
    },
  }}),
});
check('at planned pit lap with capacity overflow, P0 is allowed (safe side)',
  atWindowOversized.allow_p0_pit_now === true
  && atWindowOversized.override_reason === 'planned_pit_lap_but_strategy_proof_incomplete',
  JSON.stringify(atWindowOversized));

// --- Extra: selected_plan authority (not hard-coded plan_a) ----------------
const planBPlaybook = monzaPlaybook();
planBPlaybook.selected_plan = 'B';
const planB = guard.evaluatePlanFuelDecision({
  fuelBand: 'critical', currentFuelL: 30.0, avgFuelPerLapL: 3.641,
  currentLap: 8, playbook: planBPlaybook, effectiveCapacityL: 53,
});
check('authority honors selected_plan=B not hard-coded A',
  planB.plan_id === 'B' && planB.next_pit_lap === 13, JSON.stringify(planB));

// --- Extra: no plan means safe side (allow) with insufficient_evidence. -----
const noPlan = guard.evaluatePlanFuelDecision({
  fuelBand: 'critical', currentFuelL: 37.63, avgFuelPerLapL: 3.641,
  currentLap: 5, playbook: null, effectiveCapacityL: 53,
});
check('no active plan falls back to safe side', noPlan.allow_p0_pit_now === true
  && noPlan.override_reason === 'insufficient_evidence_no_active_plan',
  JSON.stringify(noPlan));

// --- Extra: safety override always wins. -----------------------------------
const safety = guard.evaluatePlanFuelDecision({
  fuelBand: 'critical', currentFuelL: 37.63, avgFuelPerLapL: 3.641,
  currentLap: 5, playbook: monzaPlaybook(), effectiveCapacityL: 53,
  safetyOverride: true,
});
check('safety override bypasses plan check', safety.allow_p0_pit_now === true
  && safety.override_reason === 'safety_override');

// --- Wiring: renderer must call the guard before speaking. -----------------
const renderer = fs.readFileSync(__dirname + '/desktop/renderer.html', 'utf8');
check('renderer loads the fuel-plan-guard module', renderer.includes('fuel-plan-guard.js'));
check('renderer intercepts fuel_strategy_warning through the guard',
  renderer.includes("data.trigger==='fuel_strategy_warning' && window.PitwallFuelPlanGuard")
  && renderer.includes('evaluateFuelPlanGuard'));
check('renderer emits FUEL_PLAN_GUARD trace',
  renderer.includes("diagnosticLog('FUEL_PLAN_GUARD'"));
check('renderer suppresses speech when guard denies P0',
  renderer.includes('guardVerdict.allow_p0_pit_now === false'));

console.log(`✅ fuel plan authority: ${pass} checks`);
