"""Bridge-side authoritative fuel decision that folds the plan into the P0 gate.

The fuel-band evaluator (fuel_strategy.evaluate_fuel_to_finish) is intentionally
plan-agnostic: it compares the finish-fuel deficit against a reserve.  In a
1-stop plan the entire deficit is exactly the fuel we will add at the coming
stop, so the plan-agnostic warning cannot tell "we have a plan and it will
work" from "we cannot reach the finish".

This module is the single owner of the pit-now decision that includes plan
context.  The bridge calls evaluate() before broadcasting the P0
`fuel_strategy_warning`.  When suppressed, no P0 speech, no P0 budget charge,
no downstream character speaks it.  The bridge dispatches the ordinary
plan-timed pit call at the planned lap (already handled by strategy_options).

The decision only ever *suppresses* the plan-agnostic warning.  A true fuel
emergency (cannot reach the plan window, planned service exceeds capacity,
planned service cannot finish, other P0 safety condition) always passes.
"""

import math

RESERVE_L = 0.5
# A sub-half-litre post-stop miss is not evidence that the car must pit ten
# laps early.  It is normally a stale burn snapshot / whole-litre pit-setting
# rounding issue.  Keep the selected window, request a deterministic top-up,
# and reserve P0 for the only true emergency: cannot physically reach it.
SMALL_SERVICE_CORRECTION_L = 0.5


def build_timing_authority(fuel_strategy, strategy_options, *, current_lap,
                           fuel_level_l, endurance_plan=None):
    """Build the single driver-facing fuel timing contract.

    Total fuel shortfall answers *whether* a stop is required.  This contract
    separately answers *when* the selected deterministic window requires it.
    Conversation, proactive radio and Plan A/B/C must consume this object
    instead of turning ``add_fuel_l > 0`` into an early box call.
    """
    fs = fuel_strategy if isinstance(fuel_strategy, dict) else {}
    current = float(fuel_level_l) if _finite(fuel_level_l) else None
    burn = fs.get('avg_fuel_per_lap')
    range_laps = (current / float(burn)
                  if current is not None and _finite(burn) and burn > 0 else None)
    required = fs.get('required_fuel_l')
    shortfall = (max(0.0, float(required) - current)
                 if current is not None and _finite(required) else None)
    base = {
        'available': range_laps is not None,
        'source': 'bridge_deterministic_fuel_timing_v1',
        'range_laps': round(range_laps, 2) if range_laps is not None else None,
        'required_fuel_to_finish_l': round(float(required), 3) if _finite(required) else None,
        'shortfall_to_finish_l': round(shortfall, 3) if shortfall is not None else None,
        'stop_required_to_finish': bool(shortfall is not None and shortfall > 0),
        'decision': 'unknown',
        'latest_safe_pit_lap': None,
        'laps_until_latest_safe_pit': None,
        'selected_plan': None,
        'plan_windows': {},
        'reason': 'insufficient_evidence',
    }
    lap_int = int(current_lap) if _finite(current_lap) and current_lap >= 0 else None
    ep = endurance_plan if isinstance(endurance_plan, dict) else {}
    # A selected A/B/C one-stop plan is more specific than the generic
    # endurance horizon.  Do not let a stale/misclassified horizon replace a
    # concrete target lap with “lap 0 / now”.  True multi-stop authority has
    # at least two projected future services and is used only when no
    # executable selected plan owns the current stint.
    plan_id, plan = _selected_plan(strategy_options)
    has_selected_window = (plan is not None
                           and isinstance(plan.get('target_lap'), int)
                           and plan.get('target_lap') > 0)
    if (not has_selected_window and ep.get('available') is True
            and ep.get('multi_stop') is True
            and isinstance(ep.get('future_stop_count'), int)
            and ep.get('future_stop_count') >= 2):
        until = ep.get('next_fuel_stop_in_laps')
        if isinstance(until, int) and until >= 0 and lap_int is not None:
            latest = lap_int + until
            return {**base, 'decision': 'pit_now' if ep.get('box_this_lap') else
                    ('hold' if until > 1 else 'pit_later'),
                    'latest_safe_pit_lap': latest,
                    'laps_until_latest_safe_pit': until,
                    'reason': ('current_stint_window_due' if ep.get('box_this_lap')
                               else 'current_stint_window_reachable')}
    windows = {}
    if isinstance(strategy_options, dict):
        for pid in ('A', 'B', 'C'):
            p = strategy_options.get('plan_' + pid.lower())
            if isinstance(p, dict) and p.get('available'):
                windows[pid] = {'target_lap': p.get('target_lap'),
                                'target_in_laps': p.get('target_in_laps'),
                                'set_fuel_l': p.get('set_fuel_l')}
    base['plan_windows'] = windows
    base['selected_plan'] = plan_id
    if plan is not None and isinstance(plan.get('target_lap'), int) and lap_int is not None:
        latest = plan['target_lap']
        until = max(0, latest - lap_int)
        reach_margin = (current - float(burn) * until - RESERVE_L
                        if current is not None and _finite(burn) and burn > 0 else None)
        due = until == 0 or (reach_margin is not None and reach_margin < 0)
        decision = 'pit_now' if due else ('hold' if until > 1 else 'pit_later')
        return {**base, 'decision': decision, 'latest_safe_pit_lap': latest,
                'laps_until_latest_safe_pit': until,
                'reach_window_margin_l': round(reach_margin, 3) if reach_margin is not None else None,
                'reason': ('selected_window_due' if due else 'selected_window_reachable')}
    if base['available'] and not base['stop_required_to_finish']:
        return {**base, 'decision': 'hold', 'reason': 'fuel_sufficient_to_finish'}
    return base


def _finite(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value))


def _selected_plan(strategy_options):
    """Return (plan_id, plan_dict) for the currently-selected plan, or (None, None)."""
    if not isinstance(strategy_options, dict) or not strategy_options.get('available'):
        return None, None
    plan_id = strategy_options.get('selected_plan')
    if not isinstance(plan_id, str):
        return None, None
    plan = strategy_options.get('plan_' + plan_id.lower())
    if not isinstance(plan, dict) or not plan.get('available'):
        return None, None
    return plan_id, plan


def evaluate(fuel_eval, strategy_options, *, current_lap, fuel_level_l,
             avg_fuel_per_lap_l, effective_capacity_l, safety_override=False,
             endurance_plan=None):
    """Return a verdict on whether the bridge may broadcast fuel_strategy_warning.

    Inputs are the exact objects the bridge already holds at the dispatch site.
    The decision is based on the STRATEGY_OPTIONS-owned `selected_plan`, not on
    a hard-coded Plan A: the driver may have already been switched to B or C.

    Insufficient evidence (no plan yet, plan lacks target lap, no capacity, no
    live fuel) is NEVER used to suppress silently.  It falls back to "safe
    side": allow the P0.  Suppression only happens when we can PROVE the plan
    reaches its window and its service finishes.

    At the planned pit lap the strategy path (`strategy_plan_decision` /
    `strategy_plan_box_call`) is the SOLE speaker.  The plan authority
    therefore SUPPRESSES the P0 at and beyond the target lap — otherwise the
    driver hears both "この周ボックス" (P0) AND "Baseline fuel timing selected"
    (P2) simultaneously.

    Verdict shape:
        allow_p0_pit_now:            bool
        override_reason:             optional str (why P0 was allowed)
        suppression_reason:          optional str (why P0 was suppressed)
        plan_id / next_pit_lap / laps_to_pit / reach_pit_margin_l /
        planned_add_l / capacity_fits_plan /
        finish_margin_after_stop_l:  numbers or nulls a trace or driver-facing
                                     reply may quote.
    """
    base = {
        'allow_p0_pit_now': False,
        'override_reason': None,
        'suppression_reason': None,
        'plan_id': None,
        'next_pit_lap': None,
        'laps_to_pit': None,
        'reach_pit_margin_l': None,
        'planned_add_l': None,
        'capacity_fits_plan': None,
        'finish_margin_after_stop_l': None,
    }

    # Safety override — a separate P0 (crash/damage) always wins.
    if safety_override:
        return {**base, 'allow_p0_pit_now': True,
                'override_reason': 'safety_override'}

    # A tight band never asks for a pit-now.  Even the bridge speaks a save
    # message rather than a box call — mirror that here.
    band = None
    if isinstance(fuel_eval, dict):
        band = fuel_eval.get('band')
    if band != 'critical':
        return {**base, 'allow_p0_pit_now': False,
                'suppression_reason': 'not_critical'}

    # Insufficient live fuel evidence → safe side (allow P0).
    if not _finite(fuel_level_l) or fuel_level_l <= 0:
        return {**base, 'allow_p0_pit_now': True,
                'override_reason': 'insufficient_evidence_no_live_fuel'}
    if not _finite(avg_fuel_per_lap_l) or avg_fuel_per_lap_l <= 0:
        return {**base, 'allow_p0_pit_now': True,
                'override_reason': 'insufficient_evidence_no_live_burn'}

    # A multi-stop endurance deficit is not an immediate fuel emergency.  The
    # total-to-finish evaluator can legitimately report hundreds of litres,
    # but the driver only needs to box when the *current stint* reaches its
    # window.  This gate runs before the opening A/B/C plan because that short
    # race planner intentionally cannot represent multiple future services.
    if (isinstance(endurance_plan, dict)
            and endurance_plan.get('available') is True
            and endurance_plan.get('multi_stop') is True):
        if endurance_plan.get('box_this_lap') is True:
            return {**base, 'allow_p0_pit_now': True,
                    'override_reason': 'current_stint_fuel_window_due'}
        return {
            **base,
            'allow_p0_pit_now': False,
            'suppression_reason': 'multi_stop_total_is_not_pit_now',
            'laps_to_pit': endurance_plan.get('next_fuel_stop_in_laps'),
        }

    # No plan (options not yet built OR unavailable) → safe side.
    plan_id, plan = _selected_plan(strategy_options)
    if plan is None:
        return {**base, 'allow_p0_pit_now': True,
                'override_reason': 'insufficient_evidence_no_active_plan'}

    pit_lap = plan.get('target_lap')
    if not isinstance(pit_lap, int) or pit_lap <= 0:
        return {**base, 'plan_id': plan_id, 'allow_p0_pit_now': True,
                'override_reason': 'insufficient_evidence_plan_has_no_first_pit_lap'}

    planned_add = plan.get('add_fuel_l')
    if not _finite(planned_add):
        planned_add = None
    capacity_fits = None
    if planned_add is not None and _finite(effective_capacity_l) and effective_capacity_l > 0:
        capacity_fits = planned_add <= float(effective_capacity_l) + 1e-6

    lap_int = int(current_lap) if isinstance(current_lap, (int, float)) else None
    if lap_int is None or lap_int < 0:
        return {**base, 'plan_id': plan_id, 'next_pit_lap': pit_lap,
                'planned_add_l': planned_add, 'capacity_fits_plan': capacity_fits,
                'allow_p0_pit_now': True,
                'override_reason': 'insufficient_evidence_invalid_current_lap'}

    # Plan window reached or passed → SUPPRESS ONLY when the strategy path
    # has enough proof to speak the box call itself.  If capacity does not fit,
    # planned service is unknown, OR the post-stop finish cannot be proven,
    # the strategy path cannot reliably issue "box this lap, set N liters" —
    # so the plan authority must NOT silence the fuel P0 (safe side = allow).
    # ★Codex 差戻し 3：target-lap suppression is conditional on the three proofs.
    if lap_int >= pit_lap:
        # Compute post-stop finish margin for the proof, mirroring the
        # not-yet-reached-window branch below.
        _remaining_after = plan.get('remaining_crossings_after_stop')
        _finish_margin_at_target = None
        if (isinstance(_remaining_after, int) and _remaining_after >= 0
                and _finite(planned_add) and _finite(effective_capacity_l)):
            _target_onboard = min(float(effective_capacity_l),
                                  max(0.0, plan.get('fuel_at_stop_l') or 0.0)
                                  + float(planned_add))
            _finish_margin_at_target = (_target_onboard
                                        - float(avg_fuel_per_lap_l) * _remaining_after
                                        - RESERVE_L)
        proofs_ok = (
            capacity_fits is True
            and planned_add is not None
            and _finish_margin_at_target is not None
            and _finish_margin_at_target >= 0)
        if proofs_ok:
            return {**base, 'plan_id': plan_id, 'next_pit_lap': pit_lap, 'laps_to_pit': 0,
                    'planned_add_l': planned_add, 'capacity_fits_plan': capacity_fits,
                    'finish_margin_after_stop_l': round(_finish_margin_at_target, 3),
                    'allow_p0_pit_now': False,
                    'suppression_reason': 'planned_pit_lap_speaks_via_strategy_decision'}
        # Proofs missing at target lap → safe side (allow P0).  The strategy
        # path lacks the numbers it needs to speak reliably; better to let the
        # bridge's plan-agnostic warning through than to silence everything.
        return {**base, 'plan_id': plan_id, 'next_pit_lap': pit_lap, 'laps_to_pit': 0,
                'planned_add_l': planned_add, 'capacity_fits_plan': capacity_fits,
                'finish_margin_after_stop_l': (round(_finish_margin_at_target, 3)
                                               if _finish_margin_at_target is not None else None),
                'allow_p0_pit_now': True,
                'override_reason': 'planned_pit_lap_but_strategy_proof_incomplete'}

    laps_to_pit = pit_lap - lap_int
    reach_margin = float(fuel_level_l) - float(avg_fuel_per_lap_l) * laps_to_pit - RESERVE_L
    if reach_margin < 0:
        return {**base, 'plan_id': plan_id, 'next_pit_lap': pit_lap,
                'laps_to_pit': laps_to_pit,
                'reach_pit_margin_l': round(reach_margin, 3),
                'planned_add_l': planned_add, 'capacity_fits_plan': capacity_fits,
                'allow_p0_pit_now': True,
                'override_reason': 'cannot_reach_selected_pit_window'}

    # Planned service exceeds capacity — plan cannot execute even if reached.
    if capacity_fits is False:
        return {**base, 'plan_id': plan_id, 'next_pit_lap': pit_lap,
                'laps_to_pit': laps_to_pit,
                'reach_pit_margin_l': round(reach_margin, 3),
                'planned_add_l': planned_add, 'capacity_fits_plan': False,
                'allow_p0_pit_now': True,
                'override_reason': 'planned_service_exceeds_capacity'}

    # Planned service post-stop finish check.
    remaining_after = plan.get('remaining_crossings_after_stop')
    finish_margin = None
    if (isinstance(remaining_after, int) and remaining_after >= 0
            and _finite(planned_add) and _finite(effective_capacity_l)):
        target_onboard = min(float(effective_capacity_l),
                             max(0.0, plan.get('fuel_at_stop_l') or 0.0) + float(planned_add))
        finish_margin = target_onboard - float(avg_fuel_per_lap_l) * remaining_after - RESERVE_L
        if finish_margin < 0:
            if finish_margin >= -SMALL_SERVICE_CORRECTION_L:
                corrected_add = float(planned_add) + abs(finish_margin)
                fuel_at_stop = max(0.0, plan.get('fuel_at_stop_l') or 0.0)
                corrected_onboard = min(float(effective_capacity_l),
                                        fuel_at_stop + corrected_add)
                corrected_finish_margin = (corrected_onboard
                                           - float(avg_fuel_per_lap_l) * remaining_after
                                           - RESERVE_L)
                # A tank already capped at capacity cannot be fixed by asking
                # for more fuel.  Suppress P0 only when the correction really
                # removes the post-stop deficit in the physical fuel model.
                if corrected_finish_margin >= -1e-6:
                    return {**base, 'plan_id': plan_id, 'next_pit_lap': pit_lap,
                            'laps_to_pit': laps_to_pit,
                            'reach_pit_margin_l': round(reach_margin, 3),
                            'planned_add_l': planned_add,
                            'recommended_add_l': round(corrected_add, 3),
                            'recommended_set_fuel_l': int(math.ceil(corrected_add)),
                            'capacity_fits_plan': capacity_fits,
                            'finish_margin_after_stop_l': round(finish_margin, 3),
                            'corrected_finish_margin_after_stop_l': round(corrected_finish_margin, 3),
                            'allow_p0_pit_now': False,
                            'suppression_reason': 'planned_service_small_top_up_required'}
            return {**base, 'plan_id': plan_id, 'next_pit_lap': pit_lap,
                    'laps_to_pit': laps_to_pit,
                    'reach_pit_margin_l': round(reach_margin, 3),
                    'planned_add_l': planned_add,
                    'capacity_fits_plan': capacity_fits,
                    'finish_margin_after_stop_l': round(finish_margin, 3),
                    'allow_p0_pit_now': True,
                    'override_reason': 'planned_service_correction_cannot_finish'}

    # The plan reaches its window and its service finishes.  The total-race
    # deficit is exactly the planned fuel add — a P0 "box this lap" would
    # contradict the very strategy the engine selected.  Suppress the P0.
    return {**base, 'plan_id': plan_id, 'next_pit_lap': pit_lap,
            'laps_to_pit': laps_to_pit,
            'reach_pit_margin_l': round(reach_margin, 3),
            'planned_add_l': planned_add,
            'capacity_fits_plan': capacity_fits,
            'finish_margin_after_stop_l': (round(finish_margin, 3)
                                           if finish_margin is not None else None),
            'allow_p0_pit_now': False,
            'suppression_reason': 'plan_window_reachable'}
