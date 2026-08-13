"""Unit 1: timed Final Lap model and Last 5/3/1 state contract."""

import importlib.util
import math
import os


HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location(
    'final_lap', os.path.join(HERE, 'final_lap.py'))
fl = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fl)

passed = 0
failed = 0


def check(name, condition, actual=None):
    global passed, failed
    if condition:
        passed += 1
        print('  ✅ ' + name)
    else:
        failed += 1
        print('  ❌ ' + name + ((' -> ' + repr(actual)) if actual is not None else ''))


def evaluate(**overrides):
    args = dict(
        driver_lap_dist_pct=0.95,
        leader_lap_dist_pct=0.95,
        driver_avg_lap_s=120.0,
        leader_avg_lap_s=120.0,
        session_time_remain_s=5.0,
        session_laps_remain_for_leader=None,
        is_time_race=True,
        lifecycle_state=fl.RACING,
        final_lap_already_announced=False,
        is_driver_overall_leader=True,
        driver_pace_sample_count=3,
        leader_pace_sample_count=3,
        driver_in_pit_or_garage=False,
        leader_in_pit_or_garage=False,
        driver_lap=10,
        leader_lap=10,
    )
    args.update(overrides)
    return fl.evaluate_final_lap_for_driver(**args)


def test_timed_cases():
    print('\n══ timed-race model ══')
    r = evaluate(session_time_remain_s=10.0)
    check('time remains before leader SF: not final', not r['should_announce'], r)
    check('leader will make two crossings', r['estimated_crossings_to_finish'] == 2, r)
    check('leader checkered in 126s', abs(r['leader_time_to_checkered_s'] - 126.0) < 1e-9, r)

    r = evaluate(session_time_remain_s=5.0)
    check('leader reaches SF after expiry: final', r['should_announce'], r)
    check('one crossing', r['estimated_crossings_to_finish'] == 1, r)

    r = evaluate(
        is_driver_overall_leader=False,
        driver_lap_dist_pct=0.99,
        leader_lap_dist_pct=0.95,
        session_time_remain_s=5.0)
    check('lapped driver ahead of leader crossing has another lap',
          not r['should_announce'] and r['estimated_crossings_to_finish'] == 2, r)

    r = evaluate(
        is_driver_overall_leader=False,
        driver_lap_dist_pct=0.90,
        leader_lap_dist_pct=0.95,
        session_time_remain_s=5.0)
    check('driver clearly reaches SF after checker: final',
          r['should_announce'] and r['estimated_crossings_to_finish'] == 1, r)

    r = evaluate(
        is_driver_overall_leader=False,
        driver_lap_dist_pct=0.995,
        leader_lap_dist_pct=0.95,
        session_time_remain_s=5.0)
    check('driver clearly reaches SF before checker: not final',
          not r['should_announce'] and r['estimated_crossings_to_finish'] == 2, r)

    r = evaluate(
        is_driver_overall_leader=False,
        driver_lap_dist_pct=1.0 - 6.3 / 120.0,
        leader_lap_dist_pct=0.95,
        session_time_remain_s=5.0)
    check('within 0.5s is ambiguous', r['confidence'] == fl.CONFIDENCE_AMBIGUOUS, r)
    check('ambiguous has no crossings', r['estimated_crossings_to_finish'] is None, r)

    # 7/25 endurance regression: 82s remained, leader checker was roughly
    # 185s away, and the driver crossed S/F twice before finishing.
    r = evaluate(
        is_driver_overall_leader=False,
        # Observed timing: leader checker about 185s later, driver next S/F
        # about 120s later, then driver finish about 247s later.
        leader_lap_dist_pct=1.0 - 71.0 / 114.0,
        leader_avg_lap_s=114.0,
        driver_lap_dist_pct=1.0 - 120.0 / 127.0,
        driver_avg_lap_s=127.0,
        session_time_remain_s=82.0,
        driver_pace_sample_count=5,
        leader_pace_sample_count=5)
    check('7/25 regression predicts two crossings, not Final Lap',
          not r['should_announce'] and r['estimated_crossings_to_finish'] == 2, r)

    r = evaluate(
        driver_avg_lap_s=150.0,
        leader_avg_lap_s=120.0,
        driver_lap_dist_pct=0.5,
        leader_lap_dist_pct=0.5,
        session_time_remain_s=5.0,
        is_driver_overall_leader=False)
    check('different driver/leader pace uses each independently',
          r['should_announce'] and r['estimated_crossings_to_finish'] == 1, r)


def test_fail_closed():
    print('\n══ fail-closed inputs ══')
    cases = [
        ('unknown lifecycle', {'lifecycle_state': 'RACE_OVER'}, 'unknown_lifecycle'),
        ('checker out', {'lifecycle_state': fl.CHECKER_OUT}, 'checker_out_handles_it'),
        ('player finished', {'lifecycle_state': fl.PLAYER_FINISHED}, 'player_finished'),
        ('debrief', {'lifecycle_state': fl.DEBRIEF}, 'debrief'),
        ('already announced', {'final_lap_already_announced': True}, 'already_announced'),
        ('invalid race type', {'is_time_race': 'true'}, 'invalid_is_time_race'),
        ('lap race stays legacy', {'is_time_race': False}, 'lap_race_uses_existing_path'),
        ('driver pace nan', {'driver_avg_lap_s': math.nan}, 'invalid_driver_pace'),
        ('leader pace inf', {'leader_avg_lap_s': math.inf}, 'invalid_leader_pace'),
        ('driver pace low', {'driver_avg_lap_s': 5.0}, 'driver_pace_out_of_range'),
        ('leader pace high', {'leader_avg_lap_s': 601.0}, 'leader_pace_out_of_range'),
        ('driver dist nan', {'driver_lap_dist_pct': math.nan}, 'invalid_driver_dist'),
        ('leader dist outside', {'leader_lap_dist_pct': 1.1}, 'leader_dist_out_of_range'),
        ('time missing', {'session_time_remain_s': None}, 'invalid_time_remain'),
        ('time negative', {'session_time_remain_s': -0.1}, 'negative_time_remain'),
        ('driver samples thin', {'driver_pace_sample_count': 2}, 'insufficient_driver_pace_samples'),
        ('leader samples thin', {'leader_pace_sample_count': 2}, 'insufficient_leader_pace_samples'),
        ('driver off line', {'driver_in_pit_or_garage': True}, 'driver_off_racing_line'),
        ('leader off line', {'leader_in_pit_or_garage': True}, 'leader_off_racing_line'),
    ]
    for name, kwargs, reason in cases:
        r = evaluate(**kwargs)
        check(name, not r['should_announce'] and r['reason'] == reason, r)
        check(name + ' confidence none',
              r['confidence'] == fl.CONFIDENCE_NONE, r)


def test_milestone_path():
    print('\n══ sole milestone path and dispatch commit ══')
    timed = {'estimated_crossings_to_finish': 1}
    check('time race takes new crossings',
          fl.select_milestone_laps(True, timed, 3) == 1)
    check('time race unavailable stays silent (no legacy fallback)',
          fl.select_milestone_laps(True, {}, 3) is None)
    check('lap race keeps legacy SessionLapsTotal path',
          fl.select_milestone_laps(False, timed, 5) == 5)

    sent = {5: False, 3: False, 1: False}
    milestone, crossed = fl.select_milestone(1, fl.RACING, sent)
    check('jump to one emits only Final Lap', milestone == 1, (milestone, crossed))
    check('jump marks all crossed only after commit', crossed == (5, 3, 1), crossed)
    check('selection does not mutate state', sent == {5: False, 3: False, 1: False}, sent)
    committed = fl.commit_milestone(sent, crossed)
    check('commit marks skipped thresholds', committed == {5: True, 3: True, 1: True}, committed)
    check('E0 DISPATCHED commits',
          fl.commit_milestone_after_dispatch(
              sent, crossed, 'DISPATCHED') == {5: True, 3: True, 1: True})
    check('isolated pre-E0 True commits',
          fl.commit_milestone_after_dispatch(
              sent, crossed, True) == {5: True, 3: True, 1: True})
    check('HELD does not consume',
          fl.commit_milestone_after_dispatch(sent, crossed, 'HELD') == sent)
    check('DROPPED does not consume',
          fl.commit_milestone_after_dispatch(sent, crossed, 'DROPPED') == sent)
    check('held/dropped can leave original unconsumed',
          sent == {5: False, 3: False, 1: False}, sent)
    check('non-racing does not emit',
          fl.select_milestone(1, fl.CHECKER_OUT, sent) == (None, ()))


def test_pit_transition_continuity():
    print('\n══ pit-transition checker continuity ══')
    prior = evaluate(
        is_driver_overall_leader=False,
        driver_lap_dist_pct=0.01, leader_lap_dist_pct=0.16,
        driver_avg_lap_s=110.0, leader_avg_lap_s=107.0,
        session_time_remain_s=647.0)
    check('prior checker projection is valid',
          prior['confidence'] == fl.CONFIDENCE_MODEL_VALID, prior)
    carried = fl.carry_forward_finish_projection(
        prior, elapsed_session_s=106.0, driver_lap_dist_pct=0.01,
        driver_avg_lap_s=110.0)
    check('pit transition retains a bounded checker projection',
          carried['confidence'] == fl.CONFIDENCE_MODEL_CARRIED
          and isinstance(carried['estimated_crossings_to_finish'], int)
          and carried['estimated_crossings_to_finish'] >= 1, carried)
    check('carried projection cannot auto-announce Final Lap in pit transition',
          carried['should_announce'] is False, carried)
    expired = fl.carry_forward_finish_projection(
        prior, elapsed_session_s=151.0, driver_lap_dist_pct=0.01,
        driver_avg_lap_s=110.0)
    check('old checker projection expires instead of becoming a false authority',
          expired['reason'] == 'previous_projection_expired'
          and expired['estimated_crossings_to_finish'] is None, expired)


def test_ai_leader_activity_fallback():
    print('\n══ AI leader activity fallback ══')
    check('missing surface with advancing P1 remains active',
          not fl.leader_is_inactive(
              on_pit_road=False, track_surface=-1, lap=30,
              lap_dist_pct=.488, overall_position=1))
    check('official P1 progress remains authoritative on pit road',
          not fl.leader_is_inactive(
              on_pit_road=True, track_surface=3, lap=30,
              lap_dist_pct=.488, overall_position=1))
    check('missing surface and invalid progress fails closed',
          fl.leader_is_inactive(
              on_pit_road=False, track_surface=-1, lap=-1,
              lap_dist_pct=None, overall_position=1))


def test_checker_edge():
    print('\n══ CHECKER_OUT edge ══')
    check('RACING -> CHECKER_OUT dispatches',
          fl.should_dispatch_checker_notice(fl.RACING, fl.CHECKER_OUT, False))
    check('already Final dispatched suppresses',
          not fl.should_dispatch_checker_notice(fl.RACING, fl.CHECKER_OUT, True))
    check('same-frame PLAYER_FINISHED suppresses',
          not fl.should_dispatch_checker_notice(fl.RACING, fl.PLAYER_FINISHED, False))
    check('CHECKER_OUT stay suppresses',
          not fl.should_dispatch_checker_notice(fl.CHECKER_OUT, fl.CHECKER_OUT, False))
    check('CHECKER_OUT -> PLAYER_FINISHED suppresses',
          not fl.should_dispatch_checker_notice(fl.CHECKER_OUT, fl.PLAYER_FINISHED, False))


def test_mutations():
    print('\n══ deterministic mutation evidence ══')
    src = open(os.path.join(HERE, 'final_lap.py'), encoding='utf-8').read()

    mutated = src.replace(
        'extra_laps = math.ceil(',
        'extra_laps = 0 * math.ceil(', 1)
    check('M1 source changed', mutated != src)
    ns = {}
    exec(mutated, ns)
    kwargs = dict(
        driver_lap_dist_pct=.95, leader_lap_dist_pct=.95,
        driver_avg_lap_s=120., leader_avg_lap_s=120.,
        session_time_remain_s=10., session_laps_remain_for_leader=None,
        is_time_race=True, lifecycle_state='RACING',
        final_lap_already_announced=False, is_driver_overall_leader=True,
        driver_pace_sample_count=3, leader_pace_sample_count=3,
        driver_in_pit_or_garage=False, leader_in_pit_or_garage=False)
    orig = fl.evaluate_final_lap_for_driver(**kwargs)
    mut = ns['evaluate_final_lap_for_driver'](**kwargs)
    check('M1 extra-lap mutation changes result',
          orig['estimated_crossings_to_finish'] == 2
          and mut['estimated_crossings_to_finish'] == 1, (orig, mut))

    mutated2 = src.replace(
        "return timed_evaluation.get('estimated_crossings_to_finish')",
        'return legacy_laps_remaining', 1)
    ns2 = {}
    exec(mutated2, ns2)
    check('M13 legacy timed wiring mutation detected',
          fl.select_milestone_laps(True, {'estimated_crossings_to_finish': 1}, 3) == 1
          and ns2['select_milestone_laps'](
              True, {'estimated_crossings_to_finish': 1}, 3) == 3)

    mutated3 = src.replace(
        'and not bool(final_lap_dispatched)',
        'and True', 1)
    ns3 = {}
    exec(mutated3, ns3)
    check('M16 sent guard mutation detected',
          not fl.should_dispatch_checker_notice(fl.RACING, fl.CHECKER_OUT, True)
          and ns3['should_dispatch_checker_notice']('RACING', 'CHECKER_OUT', True))


def run_all():
    test_timed_cases()
    test_fail_closed()
    test_milestone_path()
    test_pit_transition_continuity()
    test_ai_leader_activity_fallback()
    test_checker_edge()
    test_mutations()
    print('\n[final_lap] 合格 %d / 不合格 %d' % (passed, failed))
    raise SystemExit(1 if failed else 0)


if __name__ == '__main__':
    run_all()
