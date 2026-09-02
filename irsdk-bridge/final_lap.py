"""PITWALL Final Lap prediction for timed multiclass races.

The overall leader controls when the timed race ends.  A lapped driver's
remaining crossings therefore cannot be derived by subtracting lap numbers.
This module compares the predicted wall-clock time of the leader's checkered
crossing with the driver's future start/finish crossings.

All functions are side-effect free.  Telemetry collection and radio dispatch
remain bridge responsibilities.
"""

import math


MIN_AVG_LAP_S = 20.0
MAX_AVG_LAP_S = 600.0
MIN_PACE_SAMPLES = 3
SAME_TIME_TOL_S = 0.5

RACING = 'RACING'
CHECKER_OUT = 'CHECKER_OUT'
PLAYER_FINISHED = 'PLAYER_FINISHED'
DEBRIEF = 'DEBRIEF'
KNOWN_LIFECYCLE_STATES = {RACING, CHECKER_OUT, PLAYER_FINISHED, DEBRIEF}

CONFIDENCE_MODEL_VALID = 'model_valid'
CONFIDENCE_MODEL_CARRIED = 'model_carried_forward'
CONFIDENCE_AMBIGUOUS = 'ambiguous'
CONFIDENCE_NONE = 'none'


def _result(reason, should_announce=False, crossings=None,
            leader_checkered_s=None, driver_next_sf_s=None,
            confidence=CONFIDENCE_NONE):
    return {
        'should_announce': bool(should_announce),
        'estimated_crossings_to_finish': crossings,
        'leader_time_to_checkered_s': leader_checkered_s,
        'driver_time_to_next_sf_s': driver_next_sf_s,
        'reason': reason,
        'confidence': confidence,
    }


def _finite_number(value):
    return (isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value))


def evaluate_final_lap_for_driver(
        driver_lap_dist_pct,
        leader_lap_dist_pct,
        driver_avg_lap_s,
        leader_avg_lap_s,
        session_time_remain_s,
        session_laps_remain_for_leader,
        is_time_race,
        lifecycle_state,
        final_lap_already_announced,
        is_driver_overall_leader,
        driver_pace_sample_count,
        leader_pace_sample_count,
        driver_in_pit_or_garage,
        leader_in_pit_or_garage,
        driver_lap=None,
        leader_lap=None):
    """Return a fail-closed Final Lap evaluation.

    ``driver_lap`` and ``leader_lap`` are accepted for diagnostics only.  They
    deliberately do not participate in the timed-race calculation.

    Lap-count races keep the already verified SessionLapsTotal bridge path.
    SessionLapsRemain is not used until its reference semantics are measured.
    """
    del driver_lap, leader_lap, session_laps_remain_for_leader

    if lifecycle_state not in KNOWN_LIFECYCLE_STATES:
        return _result('unknown_lifecycle')
    if lifecycle_state == CHECKER_OUT:
        return _result('checker_out_handles_it')
    if lifecycle_state == PLAYER_FINISHED:
        return _result('player_finished')
    if lifecycle_state == DEBRIEF:
        return _result('debrief')
    if final_lap_already_announced:
        return _result('already_announced')
    if not isinstance(is_time_race, bool):
        return _result('invalid_is_time_race')
    if not is_time_race:
        return _result('lap_race_uses_existing_path')

    for name, value in (
            ('driver', driver_avg_lap_s),
            ('leader', leader_avg_lap_s)):
        if not _finite_number(value):
            return _result('invalid_%s_pace' % name)
        if not MIN_AVG_LAP_S <= value <= MAX_AVG_LAP_S:
            return _result('%s_pace_out_of_range' % name)

    for name, value in (
            ('driver', driver_lap_dist_pct),
            ('leader', leader_lap_dist_pct)):
        if not _finite_number(value):
            return _result('invalid_%s_dist' % name)
        if not 0.0 <= value <= 1.0:
            return _result('%s_dist_out_of_range' % name)

    if not _finite_number(session_time_remain_s):
        return _result('invalid_time_remain')
    if session_time_remain_s < 0:
        return _result('negative_time_remain')
    if (not isinstance(driver_pace_sample_count, int)
            or driver_pace_sample_count < MIN_PACE_SAMPLES):
        return _result('insufficient_driver_pace_samples')
    if (not isinstance(leader_pace_sample_count, int)
            or leader_pace_sample_count < MIN_PACE_SAMPLES):
        return _result('insufficient_leader_pace_samples')
    if driver_in_pit_or_garage:
        return _result('driver_off_racing_line')
    if leader_in_pit_or_garage:
        return _result('leader_off_racing_line')

    leader_next_sf_s = (1.0 - leader_lap_dist_pct) * leader_avg_lap_s
    if leader_next_sf_s >= session_time_remain_s:
        leader_checkered_s = leader_next_sf_s
    else:
        extra_laps = math.ceil(
            (session_time_remain_s - leader_next_sf_s) / leader_avg_lap_s)
        leader_checkered_s = leader_next_sf_s + extra_laps * leader_avg_lap_s

    driver_next_sf_s = (1.0 - driver_lap_dist_pct) * driver_avg_lap_s

    if is_driver_overall_leader:
        should_announce = driver_next_sf_s >= leader_checkered_s
    else:
        delta = driver_next_sf_s - leader_checkered_s
        if abs(delta) <= SAME_TIME_TOL_S:
            return _result(
                'checker_order_ambiguous',
                leader_checkered_s=leader_checkered_s,
                driver_next_sf_s=driver_next_sf_s,
                confidence=CONFIDENCE_AMBIGUOUS)
        should_announce = delta > SAME_TIME_TOL_S

    if driver_next_sf_s >= leader_checkered_s:
        crossings = 1
    else:
        crossings = 1 + int(math.ceil(
            (leader_checkered_s - driver_next_sf_s) / driver_avg_lap_s))

    return _result(
        'final_lap' if should_announce else 'more_than_one_crossing',
        should_announce=should_announce,
        crossings=crossings,
        leader_checkered_s=leader_checkered_s,
        driver_next_sf_s=driver_next_sf_s,
        confidence=CONFIDENCE_MODEL_VALID)


def carry_forward_finish_projection(previous_evaluation,
                                    elapsed_session_s,
                                    driver_lap_dist_pct,
                                    driver_avg_lap_s,
                                    max_age_s=150.0):
    """Keep a recent, previously-valid leader checker clock usable through
    a pit transition.

    iRacing reports the driver's pit-road state at the lap boundary, where the
    normal model deliberately fails closed.  The *leader* checker projection
    is still recent, and the driver's new progress is available immediately
    after refuelling.  Rebase that checker clock to the current frame instead
    of mixing a pre-pit fuel snapshot with ``crossings=None``.  This is a
    bounded continuity fallback: it never announces a Final Lap and expires
    rather than becoming a substitute for a fresh model.
    """
    if not isinstance(previous_evaluation, dict):
        return _result('no_previous_valid_projection')
    if previous_evaluation.get('confidence') not in (
            CONFIDENCE_MODEL_VALID, CONFIDENCE_MODEL_CARRIED):
        return _result('previous_projection_not_valid')
    prior_checker_s = previous_evaluation.get('leader_time_to_checkered_s')
    if (not _finite_number(prior_checker_s)
            or not _finite_number(elapsed_session_s)
            or elapsed_session_s < 0 or elapsed_session_s > max_age_s):
        return _result('previous_projection_expired')
    if (not _finite_number(driver_lap_dist_pct)
            or not 0.0 <= driver_lap_dist_pct <= 1.0
            or not _finite_number(driver_avg_lap_s)
            or not MIN_AVG_LAP_S <= driver_avg_lap_s <= MAX_AVG_LAP_S):
        return _result('carry_forward_inputs_invalid')
    leader_checkered_s = prior_checker_s - elapsed_session_s
    if leader_checkered_s <= 0:
        return _result('previous_projection_expired')
    driver_next_sf_s = (1.0 - driver_lap_dist_pct) * driver_avg_lap_s
    if driver_next_sf_s >= leader_checkered_s:
        crossings = 1
    else:
        crossings = 1 + int(math.ceil(
            (leader_checkered_s - driver_next_sf_s) / driver_avg_lap_s))
    return _result(
        'carried_forward_during_pit_transition',
        should_announce=False,
        crossings=crossings,
        leader_checkered_s=leader_checkered_s,
        driver_next_sf_s=driver_next_sf_s,
        confidence=CONFIDENCE_MODEL_CARRIED)


def select_milestone_laps(is_time_race, timed_evaluation,
                          legacy_laps_remaining):
    """Select the sole Last 5/3/1 input.

    Timed races must never fall back to the legacy own-pace estimate.  An
    unavailable/ambiguous timed evaluation returns ``None`` and stays silent.
    Lap-count races retain the verified SessionLapsTotal estimate.
    """
    if not isinstance(is_time_race, bool):
        return None
    if is_time_race:
        if not isinstance(timed_evaluation, dict):
            return None
        return timed_evaluation.get('estimated_crossings_to_finish')
    return legacy_laps_remaining


def leader_is_inactive(*, on_pit_road, track_surface, lap,
                       lap_dist_pct, overall_position):
    """Classify the official leader without trusting TrackSurface alone.

    AI cars can report an unavailable TrackSurface while their authoritative
    position/lap progress continues to update.  A real pit-road flag remains
    decisive; otherwise position 1 plus valid lap progress is sufficient.
    """
    # The overall leader may legitimately be on pit road while still
    # controlling the timed-race finish.  Valid official P1 progress remains
    # authoritative even when AI pit/surface flags are unreliable.
    if track_surface in (2, 3) and not bool(on_pit_road):
        return False
    try:
        valid_progress = (int(overall_position) == 1 and int(lap) > 0
                          and 0.0 <= float(lap_dist_pct) <= 1.0)
    except (TypeError, ValueError):
        valid_progress = False
    return not valid_progress


def select_milestone(laps_remaining, lifecycle_state, sent):
    """Return ``(milestone, crossed)`` without consuming state.

    ``crossed`` includes skipped older thresholds so the caller can commit all
    of them after a successful dispatch.  No state is consumed for a held or
    dropped broadcast.
    """
    if laps_remaining is None or lifecycle_state != RACING:
        return None, ()
    if not isinstance(sent, dict):
        return None, ()
    # ★2026-09-02：`2` を追加。従来は (5, 3, 1) で **残り2周が存在しなかった**。
    #   9/2 Le Mans 実走の 5周=1 / 3周=1 / 2周=0 は不具合ではなく未実装だった。
    #   なお `1` は上位で「Final lap.」として発話されるため、
    #   「残り1周」と「ファイナルラップ」を別々に出すと依頼書が禁じる重複になる。
    #   実装するのは 5 → 3 → 2 → Final(=1) の4回である。
    crossed = tuple(
        m for m in (5, 3, 2, 1)
        if laps_remaining <= m and not bool(sent.get(m, False)))
    if not crossed:
        return None, ()
    return min(crossed), crossed


def commit_milestone(sent, crossed):
    updated = dict(sent)
    for milestone in crossed:
        updated[milestone] = True
    return updated


def commit_milestone_after_dispatch(sent, crossed, dispatch_result):
    """Consume milestones only after the event entered the send queue.

    ``True`` is accepted for the pre-E0 bridge used by the isolated Unit 1
    worktree.  ``DISPATCHED`` is the authoritative E0 three-state contract.
    HELD/DROPPED/None leave the original state untouched.
    """
    if dispatch_result is True or dispatch_result == 'DISPATCHED':
        return commit_milestone(sent, crossed)
    return dict(sent)


def should_dispatch_checker_notice(previous_state, new_state,
                                   final_lap_dispatched,
                                   checker_notice_dispatched=False):
    """Dispatch one checker notice on the path the driver actually takes.

    If the final-lap call was missed, the leader-checker edge remains the
    fallback.  If it was heard, wait for the player's own finish.  A leader
    who crosses in the same frame can move RACING -> PLAYER_FINISHED directly,
    so that edge must also be accepted.
    """
    if checker_notice_dispatched:
        return False
    if new_state == PLAYER_FINISHED and previous_state in (RACING, CHECKER_OUT):
        return True
    return (previous_state == RACING and new_state == CHECKER_OUT
            and not bool(final_lap_dispatched))
