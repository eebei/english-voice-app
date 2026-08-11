// Build 265 substrate: plan-aware fuel decision contract.
//
// The bridge's fuel-band warning is plan-agnostic; it compares the raw
// finish-fuel deficit against the reserve.  In a one-stop race that deficit is
// exactly the planned fuel to add at the coming stop, so the bridge alone
// cannot tell "we have a plan and it will work" from "we cannot reach the
// finish".  This module encodes the plan-aware decision that must run before
// any P0 pit-now speech reaches the driver.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallFuelPlanGuard = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RESERVE_L = 0.5;

  const finite = value => {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };

  // ★Build 265 fix (Codex 差戻し 2)：selected_plan を権威にする。
  //   Plan A 固定をやめ、driver が Plan B/C に切り替えた後もその選択を honor する。
  function activePlan(playbook) {
    if (!playbook || playbook.available !== true) return null;
    const id = playbook.selected_plan;
    if (typeof id !== 'string' || !id) return null;
    const plan = playbook.plans && playbook.plans[id];
    if (!plan || plan.available !== true) return null;
    return { id, plan };
  }

  // The one authoritative fuel decision.  It returns a structured verdict that
  // says whether the P0 pit-now speech is permitted, why it was suppressed or
  // allowed, and the numbers a trace or a driver-facing reply may quote.
  //
  // Inputs:
  //   fuelBand:           'safe' | 'tight' | 'critical' (bridge finding)
  //   currentFuelL:       telemetry FuelLevel now
  //   avgFuelPerLapL:     verified live burn (>=3 clean laps)
  //   currentLap:         driver's current lap number
  //   playbook:           active strategy playbook from strategy-playbook.js
  //   effectiveCapacityL: tank BoP cap
  //   safetyOverride:     boolean set by an unrelated P0 (crash, damage...)
  //
  // Output:
  //   {
  //     allow_p0_pit_now:      true | false
  //     override_reason:       string (why the P0 was allowed)
  //     suppression_reason:    string (why the P0 was suppressed)
  //     plan_id:               selected plan
  //     next_pit_lap:          integer or null
  //     laps_to_pit:           integer or null
  //     reach_pit_margin_l:    number or null   (positive = plan reachable)
  //     planned_add_l:         number or null   (playbook's set-fuel target)
  //     finish_margin_after_stop_l: number or null (planned service after stop finishes)
  //     capacity_fits_plan:    boolean or null  (plan add fits BoP capacity)
  //     driver_facing_update:  optional string frame for a "planned fuel to add" reply
  //   }
  function evaluatePlanFuelDecision(input) {
    const fuel = finite(input && input.currentFuelL);
    const burn = finite(input && input.avgFuelPerLapL);
    const lap = Math.trunc(finite(input && input.currentLap) || 0);
    const cap = finite(input && input.effectiveCapacityL);
    const band = String((input && input.fuelBand) || '').toLowerCase();
    const safety = !!(input && input.safetyOverride);

    const base = {
      allow_p0_pit_now: false,
      override_reason: null,
      suppression_reason: null,
      plan_id: null,
      next_pit_lap: null,
      laps_to_pit: null,
      reach_pit_margin_l: null,
      planned_add_l: null,
      finish_margin_after_stop_l: null,
      capacity_fits_plan: null,
    };

    // Safety override wins: fires the P0 without inspecting the plan at all.
    if (safety) return { ...base, allow_p0_pit_now: true, override_reason: 'safety_override' };

    // Anything that is not a plan-capable input falls back to the bridge's
    // decision.  A tight band was never a pit-now: the bridge speaks a save
    // message instead.  Critical without live plan data is the classic case
    // that must still fire.
    if (band !== 'critical') {
      return { ...base, allow_p0_pit_now: false, suppression_reason: 'not_critical' };
    }
    // Insufficient live-fuel evidence → safe side (allow P0).
    if (!(fuel > 0)) {
      return { ...base, allow_p0_pit_now: true,
        override_reason: 'insufficient_evidence_no_live_fuel' };
    }
    if (!(burn > 0)) {
      return { ...base, allow_p0_pit_now: true,
        override_reason: 'insufficient_evidence_no_live_burn' };
    }

    const active = activePlan(input && input.playbook);
    if (!active) {
      return { ...base, allow_p0_pit_now: true,
        override_reason: 'insufficient_evidence_no_active_plan' };
    }
    const plan = active.plan;
    const pitLap = Math.trunc(finite(plan.first_pit_lap) || 0);
    if (!(pitLap > 0)) {
      return {
        ...base,
        plan_id: active.id,
        allow_p0_pit_now: true,
        override_reason: 'insufficient_evidence_plan_has_no_first_pit_lap',
      };
    }
    const service = plan.first_service || {};
    const plannedAdd = finite(service.estimated_add_l);
    const capacityFits = plannedAdd != null && cap != null ? plannedAdd <= cap + 1e-6 : null;

    // ★Codex 差戻し 3：target-lap suppression は、選択 Plan の
    //   capacity・給油量・ピット後完走の 3 証明が揃った時だけ。
    //   証明が欠けたら strategy path も正確な box call を出せない → safe side (allow P0)。
    if (lap >= pitLap) {
      const remainingAfterAtTarget = (input && Number.isFinite(input.remainingCrossingsAfterStop))
        ? Math.max(0, Math.trunc(input.remainingCrossingsAfterStop))
        : null;
      // The renderer's strategy-playbook produces target_onboard_l (fuel we
      // leave the pit with, after service).  Use it directly when present;
      // otherwise reconstruct from entry_fuel + planned_add (bounded by cap).
      const targetOnboardStored = finite(service.target_onboard_l);
      const entryFuel = finite(service.entry_fuel_l);
      let finishMarginAtTarget = null;
      if (plannedAdd != null && remainingAfterAtTarget != null && cap != null) {
        const targetOnboard = targetOnboardStored != null
          ? Math.min(cap, targetOnboardStored)
          : Math.min(cap, Math.max(0, entryFuel != null ? entryFuel : 0) + plannedAdd);
        finishMarginAtTarget = targetOnboard - burn * remainingAfterAtTarget - 0.5;
      }
      const proofsOk = capacityFits === true
        && plannedAdd != null
        && finishMarginAtTarget !== null
        && finishMarginAtTarget >= 0;
      if (proofsOk) {
        return {
          ...base,
          plan_id: active.id, next_pit_lap: pitLap, laps_to_pit: 0,
          planned_add_l: plannedAdd, capacity_fits_plan: capacityFits,
          finish_margin_after_stop_l: Math.round(finishMarginAtTarget * 1000) / 1000,
          allow_p0_pit_now: false,
          suppression_reason: 'planned_pit_lap_speaks_via_strategy_decision',
        };
      }
      return {
        ...base,
        plan_id: active.id, next_pit_lap: pitLap, laps_to_pit: 0,
        planned_add_l: plannedAdd, capacity_fits_plan: capacityFits,
        finish_margin_after_stop_l: (finishMarginAtTarget != null
          ? Math.round(finishMarginAtTarget * 1000) / 1000 : null),
        allow_p0_pit_now: true,
        override_reason: 'planned_pit_lap_but_strategy_proof_incomplete',
      };
    }

    // Reach the planned stop with reserve to spare?  If not, this is a true
    // emergency: the plan cannot be executed at all.
    const lapsToPit = pitLap - lap;
    const reachMargin = fuel - burn * lapsToPit - RESERVE_L;
    if (!(reachMargin >= 0)) {
      return {
        ...base,
        plan_id: active.id,
        next_pit_lap: pitLap,
        laps_to_pit: lapsToPit,
        reach_pit_margin_l: reachMargin,
        planned_add_l: plannedAdd,
        capacity_fits_plan: capacityFits,
        allow_p0_pit_now: true,
        override_reason: 'cannot_reach_selected_pit_window',
      };
    }

    // Does the planned service actually let us finish?  crossings after the
    // pit approximate as (safe_stint_laps) with the same burn; if the
    // playbook offers a computed target_onboard we use it, otherwise capacity.
    const targetOnboardAfter = finite(service.target_onboard_l);
    const remainingCrossings = (input && Number.isFinite(input.remainingCrossingsAfterStop))
      ? Math.max(0, Math.trunc(input.remainingCrossingsAfterStop))
      : null;
    let finishMarginAfterStop = null;
    if (targetOnboardAfter != null && remainingCrossings != null) {
      finishMarginAfterStop = targetOnboardAfter - burn * remainingCrossings - RESERVE_L;
    }

    // Planned service will not fit in the tank → true emergency.  A different
    // action is required (extra stop, save target) and pit-now is the closest
    // truth we can utter until the plan is updated.
    if (capacityFits === false) {
      return {
        ...base,
        plan_id: active.id,
        next_pit_lap: pitLap,
        laps_to_pit: lapsToPit,
        reach_pit_margin_l: reachMargin,
        planned_add_l: plannedAdd,
        finish_margin_after_stop_l: finishMarginAfterStop,
        capacity_fits_plan: false,
        allow_p0_pit_now: true,
        override_reason: 'planned_service_exceeds_capacity',
      };
    }

    // Post-stop projection shows the plan will not finish → true emergency.
    if (finishMarginAfterStop != null && finishMarginAfterStop < 0) {
      return {
        ...base,
        plan_id: active.id,
        next_pit_lap: pitLap,
        laps_to_pit: lapsToPit,
        reach_pit_margin_l: reachMargin,
        planned_add_l: plannedAdd,
        finish_margin_after_stop_l: finishMarginAfterStop,
        capacity_fits_plan: capacityFits,
        allow_p0_pit_now: true,
        override_reason: 'planned_service_cannot_finish',
      };
    }

    // The plan is reachable and finishing: the total-race deficit is exactly
    // the planned fuel add.  A P0 "box this lap" would contradict the very
    // strategy we selected.  Suppress the speech; the same signal remains
    // usable for a driver-facing update ("planned fuel to add is N liters").
    return {
      ...base,
      plan_id: active.id,
      next_pit_lap: pitLap,
      laps_to_pit: lapsToPit,
      reach_pit_margin_l: reachMargin,
      planned_add_l: plannedAdd,
      finish_margin_after_stop_l: finishMarginAfterStop,
      capacity_fits_plan: capacityFits,
      allow_p0_pit_now: false,
      suppression_reason: 'plan_window_reachable',
      driver_facing_update: plannedAdd != null
        ? { planned_add_l: Math.round(plannedAdd * 10) / 10, next_pit_lap: pitLap, laps_to_pit: lapsToPit }
        : null,
    };
  }

  return { evaluatePlanFuelDecision };
}));
