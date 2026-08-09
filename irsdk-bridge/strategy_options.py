"""Deterministic initial Plan A / Plan B fuel strategy.

This module creates an early race contract once fuel consumption and finish
distance are authoritative.  It does not predict future traffic or tyre gain;
those remain unavailable until the Phase D comparator has measured evidence.
"""

import math


MIN_CLEAN_LAPS = 3
DEFAULT_RESERVE_L = 0.5


def _finite(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value))


def unavailable(reason):
    return {
        'available': False,
        'reason': reason,
        'selected_plan': None,
        'plan_a': None,
        'plan_b': None,
    }


def build_initial_plans(*, snapshot_id, current_lap, fuel_level_l,
                        avg_fuel_per_lap_l, clean_laps_sampled,
                        crossings_to_finish, reserve_l=DEFAULT_RESERVE_L,
                        effective_capacity_l=None):
    """Return a latched baseline and a one-lap extension alternative.

    Plan A stops one lap before the latest fuel-safe pit lap.  Plan B extends
    to that latest safe lap.  Both plans use the same finish-distance and fuel
    snapshot, so their comparison is auditable.  When no stop is required,
    Plan A is a no-stop finish and Plan B is explicitly unavailable.
    """
    if not isinstance(snapshot_id, str) or not snapshot_id:
        return unavailable('invalid_snapshot')
    if not isinstance(current_lap, int) or isinstance(current_lap, bool) or current_lap < 0:
        return unavailable('invalid_current_lap')
    if not _finite(fuel_level_l) or fuel_level_l < 0:
        return unavailable('invalid_fuel')
    if not _finite(avg_fuel_per_lap_l) or avg_fuel_per_lap_l <= 0:
        return unavailable('invalid_average')
    if (not isinstance(clean_laps_sampled, int)
            or isinstance(clean_laps_sampled, bool)
            or clean_laps_sampled < MIN_CLEAN_LAPS):
        return unavailable('insufficient_clean_laps')
    if (not isinstance(crossings_to_finish, int)
            or isinstance(crossings_to_finish, bool)
            or crossings_to_finish < 1):
        return unavailable('invalid_finish_distance')
    if not _finite(reserve_l) or reserve_l < 0:
        return unavailable('invalid_reserve')

    average = float(avg_fuel_per_lap_l)
    fuel = float(fuel_level_l)
    reserve = float(reserve_l)
    total_required = average * crossings_to_finish + reserve
    shortage = max(0.0, total_required - fuel)
    base = {
        'snapshot_id': snapshot_id,
        'current_lap': current_lap,
        'fuel_level_l': round(fuel, 3),
        'avg_fuel_per_lap_l': round(average, 3),
        'clean_laps_sampled': clean_laps_sampled,
        'crossings_to_finish': crossings_to_finish,
        'reserve_l': round(reserve, 3),
        'total_required_l': round(total_required, 3),
    }

    if shortage <= 0.001:
        margin = fuel - average * crossings_to_finish
        return {
            **base,
            'available': True,
            'reason': 'no_stop_required',
            'selected_plan': 'A',
            'plan_a': {
                'available': True, 'action': 'stay_out',
                'target_lap': None, 'target_in_laps': None,
                'add_fuel_l': 0.0, 'projected_finish_margin_l': round(margin, 3),
            },
            'plan_b': {
                'available': False, 'reason': 'no_viable_alternative_needed',
            },
            'switch_conditions': [],
        }

    latest_safe_in = int(math.floor(max(0.0, fuel - reserve) / average))
    latest_safe_in = min(latest_safe_in, max(0, crossings_to_finish - 1))
    plan_a_in = max(0, latest_safe_in - 1)
    plan_b_in = latest_safe_in

    def stop_plan(action, delay):
        fuel_at_stop = max(0.0, fuel - average * delay)
        remaining = max(1, crossings_to_finish - delay)
        needed_after = average * remaining + reserve
        add = max(0.0, needed_after - fuel_at_stop)
        capacity_ok = (not _finite(effective_capacity_l)
                       or needed_after <= float(effective_capacity_l) + 0.001)
        if not capacity_ok:
            return {
                'available': False,
                'reason': 'effective_capacity_insufficient',
                'target_lap': current_lap + delay,
                'target_in_laps': delay,
            }
        return {
            'available': True,
            'action': action,
            'target_lap': current_lap + delay,
            'target_in_laps': delay,
            'fuel_at_stop_l': round(fuel_at_stop, 3),
            'add_fuel_l': round(add, 3),
            'set_fuel_l': int(math.ceil(add)),
            'remaining_crossings_after_stop': remaining,
            'projected_finish_margin_l': round(reserve, 3),
        }

    plan_a = stop_plan('baseline_stop', plan_a_in)
    plan_b = (stop_plan('extend_one_lap', plan_b_in)
              if plan_b_in > plan_a_in else {
                  'available': False, 'reason': 'no_safe_extension',
                  'target_lap': current_lap + plan_b_in,
                  'target_in_laps': plan_b_in,
              })
    return {
        **base,
        'available': bool(plan_a.get('available')),
        'reason': 'initial_fuel_strategy' if plan_a.get('available') else plan_a.get('reason'),
        'selected_plan': 'A' if plan_a.get('available') else None,
        'plan_a': plan_a,
        'plan_b': plan_b,
        'switch_conditions': ([
            'fuel_projection_remains_above_reserve',
            'no_critical_traffic_or_safety_override',
            'phase_d_rejoin_comparison_supports_extension',
        ] if plan_b.get('available') else []),
    }


def score_execution(options, *, actual_entry_lap, actual_fuel_added_l):
    """Grade which announced plan the driver executed and its fuel error."""
    if not isinstance(options, dict) or not options.get('available'):
        return {'available': False, 'reason': 'options_unavailable'}
    if not isinstance(actual_entry_lap, int) or actual_entry_lap < 0:
        return {'available': False, 'reason': 'invalid_entry_lap'}
    candidates = []
    for label in ('A', 'B'):
        plan = options.get('plan_' + label.lower()) or {}
        target = plan.get('target_lap')
        if plan.get('available') and isinstance(target, int):
            candidates.append((abs(actual_entry_lap - target), label, plan))
    if not candidates:
        return {'available': False, 'reason': 'no_pit_plan_to_score'}
    _, label, plan = sorted(candidates, key=lambda item: (item[0], item[1]))[0]
    planned_add = plan.get('add_fuel_l')
    fuel_error = (float(actual_fuel_added_l) - float(planned_add)
                  if _finite(actual_fuel_added_l) and _finite(planned_add) else None)
    return {
        'available': True,
        'snapshot_id': options.get('snapshot_id'),
        'executed_plan': label,
        'planned_entry_lap': plan.get('target_lap'),
        'actual_entry_lap': actual_entry_lap,
        'entry_lap_error': actual_entry_lap - plan.get('target_lap'),
        'planned_add_fuel_l': planned_add,
        'actual_fuel_added_l': (round(float(actual_fuel_added_l), 3)
                                if _finite(actual_fuel_added_l) else None),
        'fuel_add_error_l': round(fuel_error, 3) if fuel_error is not None else None,
    }


def decide_at_plan_a(options, *, current_lap, current_fuel_l,
                     avg_fuel_per_lap_l, pit_now_forecast,
                     pit_next_lap_forecast):
    """Choose A or B from fuel safety and physical rejoin evidence only.

    Historical Monza outcomes show that conditional post-cycle position can
    move in either direction depending on rival stops.  It is therefore
    retained for scoring, but deliberately excluded from this choice.
    """
    if not isinstance(options, dict) or not options.get('available'):
        return {'available': False, 'reason': 'options_unavailable'}
    plan_a = options.get('plan_a') or {}
    plan_b = options.get('plan_b') or {}
    if not plan_a.get('available') or not plan_b.get('available'):
        return {'available': False, 'reason': 'both_plans_not_available'}
    if not isinstance(current_lap, int) or isinstance(current_lap, bool):
        return {'available': False, 'reason': 'invalid_current_lap'}
    if not _finite(current_fuel_l) or not _finite(avg_fuel_per_lap_l):
        return {'available': False, 'reason': 'live_fuel_evidence_missing'}

    reserve = options.get('reserve_l')
    reserve = float(reserve) if _finite(reserve) else DEFAULT_RESERVE_L
    fuel_after_extension = float(current_fuel_l) - float(avg_fuel_per_lap_l)
    fuel_safe = fuel_after_extension >= reserve
    decision_id = '%s:decision-lap:%s' % (options.get('snapshot_id'), current_lap)
    evidence = {
        'decision_id': decision_id,
        'current_lap': current_lap,
        'current_fuel_l': round(float(current_fuel_l), 3),
        'avg_fuel_per_lap_l': round(float(avg_fuel_per_lap_l), 3),
        'fuel_after_extension_l': round(fuel_after_extension, 3),
        'required_reserve_l': round(reserve, 3),
        'fuel_safe_for_plan_b': fuel_safe,
        'pit_cycle_position_used': False,
    }
    if not fuel_safe:
        return {**evidence, 'available': True, 'selected_plan': 'A',
                'reason': 'plan_b_fuel_reserve_not_met'}

    def positions(forecast):
        if not isinstance(forecast, dict) or not forecast.get('available'):
            return None
        try:
            likely = int(forecast['likely']['position'])
            worst = int(forecast['worst']['position'])
        except (KeyError, TypeError, ValueError):
            return None
        if likely < 1 or worst < likely:
            return None
        return {'likely': likely, 'worst': worst,
                'snapshot_id': forecast.get('snapshot_id'),
                'model_version': forecast.get('model_version')}

    now = positions(pit_now_forecast)
    next_lap = positions(pit_next_lap_forecast)
    evidence['physical_rejoin'] = {'plan_a': now, 'plan_b': next_lap}
    if now is None or next_lap is None:
        return {**evidence, 'available': True, 'selected_plan': 'A',
                'reason': 'physical_rejoin_comparison_unavailable'}

    # Lower position number is better.  B must improve the likely result and
    # may not worsen the measured worst case.  A wins every tie.
    b_better = (next_lap['likely'] < now['likely']
                and next_lap['worst'] <= now['worst'])
    return {
        **evidence,
        'available': True,
        'selected_plan': 'B' if b_better else 'A',
        'reason': ('plan_b_physical_rejoin_better'
                   if b_better else 'plan_a_equal_or_safer_rejoin'),
    }
