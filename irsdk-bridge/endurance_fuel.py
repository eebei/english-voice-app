"""Deterministic endurance fuel horizon.

The to-finish calculator owns the total fuel requirement.  That number may be
hundreds of litres in an endurance race and must never, by itself, become a
"box this lap" call.  This module translates the race horizon into the facts a
driver can act on: range in the current stint, projected future stops, and a
second-half splash-avoidance target.
"""

import math


DEFAULT_RESERVE_L = 0.5
MAX_PRACTICAL_SAVE_FRACTION = 0.08
SPLASH_SERVICE_FRACTION = 0.35


def _finite(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value))


def unavailable(reason):
    return {
        'available': False,
        'reason': reason,
        'multi_stop': False,
        'box_this_lap': False,
    }


def evaluate(*, fuel_level_l, avg_fuel_per_lap_l, crossings_to_finish,
             effective_capacity_l, reserve_l=DEFAULT_RESERVE_L,
             race_progress_fraction=None):
    """Return a driver-actionable endurance fuel projection.

    ``future_stop_count`` is a planning count, not an official sporting-rule
    prediction.  It assumes each ordinary stop can replenish approximately one
    usable tank (capacity minus reserve).  The bridge may use it for a concise
    strategy summary, but the current-stint range remains the sole fuel basis
    for an immediate pit call.
    """
    if not _finite(fuel_level_l) or fuel_level_l < 0:
        return unavailable('invalid_fuel')
    if not _finite(avg_fuel_per_lap_l) or avg_fuel_per_lap_l <= 0:
        return unavailable('invalid_average')
    if (not isinstance(crossings_to_finish, int)
            or isinstance(crossings_to_finish, bool)
            or crossings_to_finish < 1):
        return unavailable('invalid_finish_distance')
    if not _finite(effective_capacity_l) or effective_capacity_l <= 0:
        return unavailable('invalid_capacity')
    if not _finite(reserve_l) or reserve_l < 0:
        return unavailable('invalid_reserve')

    fuel = float(fuel_level_l)
    average = float(avg_fuel_per_lap_l)
    capacity = float(effective_capacity_l)
    reserve = float(reserve_l)
    usable_service = capacity - reserve
    if usable_service <= 0:
        return unavailable('capacity_not_above_reserve')

    total_required = average * crossings_to_finish + reserve
    total_to_add = max(0.0, total_required - fuel)
    future_stop_count = (int(math.ceil(total_to_add / usable_service - 1e-12))
                         if total_to_add > 0 else 0)
    current_stint_laps = max(0, int(math.floor(
        max(0.0, fuel - reserve) / average + 1e-12)))
    # If only one crossing remains in the tank, that crossing is the current
    # in-lap: call Box now, before the car passes pit entry.  "laps until
    # call" is therefore range minus one, not the raw tank range.
    laps_until_box_call = max(0, current_stint_laps - 1)
    box_this_lap = total_to_add > 0 and laps_until_box_call <= 0
    multi_stop = future_stop_count >= 2

    final_service = 0.0
    if future_stop_count > 0:
        final_service = max(0.0, total_to_add
                            - usable_service * (future_stop_count - 1))
    splash_candidate = (
        future_stop_count >= 1
        and final_service > 0.05
        and final_service <= capacity * SPLASH_SERVICE_FRACTION)

    progress = (float(race_progress_fraction)
                if _finite(race_progress_fraction) else None)
    second_half = progress is not None and progress >= 0.5
    save_per_lap = (final_service / crossings_to_finish
                    if splash_candidate and crossings_to_finish > 0 else 0.0)
    save_fraction = save_per_lap / average if average > 0 else 0.0
    splash_forecast = {
        'available': bool(second_half),
        'reason': ('second_half_projection'
                   if second_half else 'race_not_halfway'),
        'splash_candidate': bool(splash_candidate),
        'projected_final_service_l': round(final_service, 3),
        'avoid_splash_save_l_per_lap': round(save_per_lap, 3),
        'avoid_splash_save_fraction': round(save_fraction, 4),
        'avoid_splash_feasible': bool(
            splash_candidate and save_fraction <= MAX_PRACTICAL_SAVE_FRACTION),
    }

    return {
        'available': True,
        'reason': 'endurance_horizon',
        'multi_stop': multi_stop,
        'box_this_lap': box_this_lap,
        'current_stint_laps_remaining': current_stint_laps,
        'next_fuel_stop_in_laps': laps_until_box_call if total_to_add > 0 else None,
        'future_stop_count': future_stop_count,
        'total_fuel_to_finish_l': round(total_required, 3),
        'total_fuel_to_add_l': round(total_to_add, 3),
        'effective_capacity_l': round(capacity, 3),
        'reserve_l': round(reserve, 3),
        'race_progress_fraction': (round(progress, 4)
                                   if progress is not None else None),
        'splash_forecast': splash_forecast,
    }
