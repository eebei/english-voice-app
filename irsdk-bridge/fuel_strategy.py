"""Deterministic endurance fuel-to-finish calculation.

The caller supplies the authoritative number of future S/F crossings.  For
timed multiclass races that value must come from the Final Lap wall-clock
model; this module never estimates race distance on its own.
"""

import math


RACING = 'RACING'
CHECKER_OUT = 'CHECKER_OUT'
PLAYER_FINISHED = 'PLAYER_FINISHED'
DEBRIEF = 'DEBRIEF'
KNOWN_LIFECYCLE_STATES = {
    RACING, CHECKER_OUT, PLAYER_FINISHED, DEBRIEF,
}

SAFE = 'safe'
TIGHT = 'tight'
CRITICAL = 'critical'
KNOWN_BANDS = {SAFE, TIGHT, CRITICAL}

RESERVE_L = 0.5
MIN_CLEAN_LAPS = 3
MAX_FUEL_L = 500.0
MAX_FUEL_PER_LAP_L = 50.0
MAX_CROSSINGS = 500
MIN_LAP_TIME_S = 20.0
MAX_LAP_TIME_S = 600.0


def _finite(value):
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _result(reason, available=False, required_fuel_l=None, margin_l=None,
            band=None, previous_band=None, transition=None,
            should_warn=False, warning_kind=None):
    return {
        'available': bool(available),
        'required_fuel_l': required_fuel_l,
        'margin_l': margin_l,
        'reserve_l': RESERVE_L,
        'band': band,
        'previous_band': previous_band,
        'transition': transition,
        'should_warn': bool(should_warn),
        'warning_kind': warning_kind,
        'reason': reason,
    }


def evaluate_fuel_to_finish(
        fuel_level_l,
        avg_fuel_per_lap_l,
        estimated_crossings_to_finish,
        clean_laps_sampled,
        lifecycle_state,
        previous_band):
    """Evaluate liters-to-finish and a deduplicated warning candidate.

    Bands:
      safe     margin >= 0.5 L
      tight    0.0 <= margin < 0.5 L
      critical margin < 0.0 L

    A first valid tight/critical observation is treated as entering that band,
    so attaching mid-race does not silently miss an urgent condition.
    """
    if lifecycle_state not in KNOWN_LIFECYCLE_STATES:
        return _result('unknown_lifecycle', previous_band=previous_band)
    if previous_band is not None and previous_band not in KNOWN_BANDS:
        return _result('invalid_previous_band', previous_band=previous_band)
    if not _finite(fuel_level_l):
        return _result('invalid_fuel_level', previous_band=previous_band)
    if not 0.0 <= fuel_level_l <= MAX_FUEL_L:
        return _result('fuel_level_out_of_range', previous_band=previous_band)
    if not _finite(avg_fuel_per_lap_l):
        return _result('invalid_average', previous_band=previous_band)
    if not 0.0 < avg_fuel_per_lap_l <= MAX_FUEL_PER_LAP_L:
        return _result('average_out_of_range', previous_band=previous_band)
    if (not isinstance(estimated_crossings_to_finish, int)
            or isinstance(estimated_crossings_to_finish, bool)
            or not 1 <= estimated_crossings_to_finish <= MAX_CROSSINGS):
        return _result('invalid_crossings', previous_band=previous_band)
    if (not isinstance(clean_laps_sampled, int)
            or isinstance(clean_laps_sampled, bool)
            or clean_laps_sampled < MIN_CLEAN_LAPS):
        return _result(
            'insufficient_clean_laps', previous_band=previous_band)

    required = avg_fuel_per_lap_l * estimated_crossings_to_finish
    margin = fuel_level_l - required
    if margin >= RESERVE_L:
        band = SAFE
    elif margin >= 0.0:
        band = TIGHT
    else:
        band = CRITICAL

    transition = (
        '%s_to_%s' % (previous_band, band)
        if previous_band is not None and previous_band != band
        else ('initial_to_%s' % band if previous_band is None else None)
    )

    lifecycle_allows_warning = lifecycle_state == RACING
    degraded = (
        band in (TIGHT, CRITICAL)
        and previous_band != band
        and not (previous_band == CRITICAL and band == TIGHT)
    )
    should_warn = lifecycle_allows_warning and degraded
    warning_kind = band if should_warn else None
    reason = (
        'warning_candidate'
        if should_warn
        else ('lifecycle_suppressed'
              if not lifecycle_allows_warning and band in (TIGHT, CRITICAL)
              else ('same_band' if previous_band == band
                    else 'no_warning_transition'))
    )

    return _result(
        reason,
        available=True,
        required_fuel_l=round(required, 3),
        margin_l=round(margin, 3),
        band=band,
        previous_band=previous_band,
        transition=transition,
        should_warn=should_warn,
        warning_kind=warning_kind)


def estimate_timed_fuel_provisional(
        fuel_level_l, avg_fuel_per_lap_l, time_remaining_s,
        avg_lap_time_s, clean_laps_sampled):
    """Conservative pre-checker fuel estimate for a timed race.

    This deliberately does *not* claim the authoritative checkered crossing.
    Before the Final Lap model can identify the leader/checker relationship,
    it gives the driver a safe planning number: enough whole laps to reach
    time zero plus one possible final lap after time expiry.
    """
    if not _finite(fuel_level_l) or not 0.0 <= fuel_level_l <= MAX_FUEL_L:
        return {'available': False, 'reason': 'invalid_fuel_level'}
    if (not _finite(avg_fuel_per_lap_l)
            or not 0.0 < avg_fuel_per_lap_l <= MAX_FUEL_PER_LAP_L):
        return {'available': False, 'reason': 'invalid_average'}
    if (not _finite(time_remaining_s) or not 0.0 <= time_remaining_s < 100000):
        return {'available': False, 'reason': 'invalid_time_remaining'}
    if (not _finite(avg_lap_time_s)
            or not MIN_LAP_TIME_S <= avg_lap_time_s <= MAX_LAP_TIME_S):
        return {'available': False, 'reason': 'invalid_lap_time'}
    if (not isinstance(clean_laps_sampled, int)
            or isinstance(clean_laps_sampled, bool)
            or clean_laps_sampled < MIN_CLEAN_LAPS):
        return {'available': False, 'reason': 'insufficient_clean_laps'}
    laps = max(1, int(math.ceil(time_remaining_s / avg_lap_time_s)) + 1)
    required = avg_fuel_per_lap_l * laps
    margin = fuel_level_l - required
    return {
        'available': True,
        'reason': 'timed_provisional',
        'estimated_laps': laps,
        'required_fuel_l': round(required, 3),
        'margin_l': round(margin, 3),
        'reserve_l': RESERVE_L,
        'basis': 'time_to_zero_plus_final_lap',
    }


def project_post_stop_fuel_to_finish(
        leader_time_to_checkered_s, driver_time_to_next_sf_s,
        driver_avg_lap_s, pit_loss_s, avg_fuel_per_lap_l,
        effective_capacity_l, reserve_l=RESERVE_L):
    """Project fuel after an imminent stop in a timed race.

    The next S/F is the pit-entry crossing, before service.  The full tank
    therefore covers only complete crossings after the measured pit loss.
    This is the correct contract for "will we need another splash?"; the
    ordinary no-stop crossing count is deliberately not reused.
    """
    values = (
        leader_time_to_checkered_s, driver_time_to_next_sf_s,
        driver_avg_lap_s, pit_loss_s, avg_fuel_per_lap_l,
        effective_capacity_l, reserve_l)
    if not all(_finite(v) for v in values):
        return {'available': False, 'reason': 'invalid_input'}
    if (leader_time_to_checkered_s < 0 or driver_time_to_next_sf_s < 0
            or not MIN_LAP_TIME_S <= driver_avg_lap_s <= MAX_LAP_TIME_S
            or pit_loss_s < 0
            or not 0 < avg_fuel_per_lap_l <= MAX_FUEL_PER_LAP_L
            or not 0 < effective_capacity_l <= MAX_FUEL_L
            or reserve_l < 0):
        return {'available': False, 'reason': 'input_out_of_range'}
    usable_clock = (
        leader_time_to_checkered_s
        - driver_time_to_next_sf_s
        - pit_loss_s)
    crossings = max(0, int(math.floor(
        usable_clock / driver_avg_lap_s + 1e-9)))
    required = crossings * avg_fuel_per_lap_l + reserve_l
    margin = effective_capacity_l - required
    return {
        'available': True,
        'reason': 'planned_stop_clock',
        'post_stop_crossings': crossings,
        'required_fuel_l': round(required, 3),
        'margin_l': round(margin, 3),
        'splash_required': margin < 0,
    }


def commit_band_after_dispatch(previous_band, evaluation, dispatch_result):
    """Advance dedup state without losing an undelivered warning.

    SAFE and non-warning recovery transitions are state facts and commit
    immediately.  A tight/critical warning candidate commits only after the
    event reaches the send queue.
    """
    if not isinstance(evaluation, dict) or not evaluation.get('available'):
        return previous_band
    band = evaluation.get('band')
    if band not in KNOWN_BANDS:
        return previous_band
    if not evaluation.get('should_warn'):
        return band
    if dispatch_result is True or dispatch_result == 'DISPATCHED':
        return band
    return previous_band
