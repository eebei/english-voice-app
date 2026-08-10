"""Endurance fuel liters/band/dedup contract."""

import importlib.util
import math
import os


HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location(
    'fuel_strategy', os.path.join(HERE, 'fuel_strategy.py'))
fs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fs)

passed = 0
failed = 0


def check(name, condition, actual=None):
    global passed, failed
    if condition:
        passed += 1
        print('  ✅ ' + name)
    else:
        failed += 1
        print('  ❌ ' + name + (
            (' -> ' + repr(actual)) if actual is not None else ''))


def evaluate(**overrides):
    args = dict(
        fuel_level_l=10.5,
        avg_fuel_per_lap_l=2.0,
        estimated_crossings_to_finish=5,
        clean_laps_sampled=3,
        lifecycle_state=fs.RACING,
        previous_band=fs.SAFE,
    )
    args.update(overrides)
    return fs.evaluate_fuel_to_finish(**args)


def test_boundaries():
    print('\n══ liter boundaries ══')
    r = evaluate(fuel_level_l=10.5)
    check('margin exactly +0.5L is safe', r['band'] == fs.SAFE, r)
    check('required fuel excludes reserve double-count',
          r['required_fuel_l'] == 10.0, r)
    check('margin is fuel minus required', r['margin_l'] == 0.5, r)
    check('same safe band does not warn', not r['should_warn'], r)

    r = evaluate(fuel_level_l=10.499)
    check('+0.499L is tight', r['band'] == fs.TIGHT, r)
    check('safe -> tight warns', r['should_warn'], r)
    check('tight warning kind', r['warning_kind'] == fs.TIGHT, r)

    r = evaluate(fuel_level_l=10.0)
    check('zero margin is tight', r['band'] == fs.TIGHT, r)

    r = evaluate(fuel_level_l=9.999)
    check('negative margin is critical', r['band'] == fs.CRITICAL, r)
    check('safe -> critical direct jump warns', r['should_warn'], r)
    check('critical warning kind', r['warning_kind'] == fs.CRITICAL, r)


def test_transitions_and_rearm():
    print('\n══ band transition dedup/rearm ══')
    same_tight = evaluate(fuel_level_l=10.2, previous_band=fs.TIGHT)
    check('same tight band is deduplicated',
          not same_tight['should_warn']
          and same_tight['reason'] == 'same_band', same_tight)

    tight_to_critical = evaluate(
        fuel_level_l=9.9, previous_band=fs.TIGHT)
    check('tight -> critical warns separately',
          tight_to_critical['should_warn']
          and tight_to_critical['transition'] == 'tight_to_critical',
          tight_to_critical)

    initial_tight = evaluate(
        fuel_level_l=10.2, previous_band=None)
    check('attach mid-race in tight does not stay silent',
          initial_tight['should_warn']
          and initial_tight['transition'] == 'initial_to_tight',
          initial_tight)

    initial_safe = evaluate(
        fuel_level_l=10.5, previous_band=None)
    check('initial safe is not a warning',
          not initial_safe['should_warn'], initial_safe)

    critical_to_tight = evaluate(
        fuel_level_l=10.2, previous_band=fs.CRITICAL)
    check('critical -> tight recovery is silent',
          not critical_to_tight['should_warn'], critical_to_tight)
    recovered = fs.commit_band_after_dispatch(
        fs.CRITICAL, critical_to_tight, None)
    check('silent recovery commits tight for future rearm',
          recovered == fs.TIGHT, recovered)
    again_critical = evaluate(
        fuel_level_l=9.9, previous_band=recovered)
    check('after recovery, tight -> critical warns again',
          again_critical['should_warn'], again_critical)

    refueled = evaluate(
        fuel_level_l=12.0, previous_band=fs.CRITICAL)
    check('refuel returns to safe without warning',
          refueled['band'] == fs.SAFE and not refueled['should_warn'],
          refueled)
    check('safe rearm commits without dispatch',
          fs.commit_band_after_dispatch(
              fs.CRITICAL, refueled, None) == fs.SAFE)


def test_dispatch_commit():
    print('\n══ dispatch-only consumption ══')
    candidate = evaluate(fuel_level_l=10.2, previous_band=fs.SAFE)
    check('fixture is warning candidate', candidate['should_warn'], candidate)
    check('DROPPED leaves safe state for retry',
          fs.commit_band_after_dispatch(
              fs.SAFE, candidate, 'DROPPED') == fs.SAFE)
    check('HELD leaves safe state for retry',
          fs.commit_band_after_dispatch(
              fs.SAFE, candidate, 'HELD') == fs.SAFE)
    check('None leaves safe state for retry',
          fs.commit_band_after_dispatch(
              fs.SAFE, candidate, None) == fs.SAFE)
    check('E0 DISPATCHED consumes tight band',
          fs.commit_band_after_dispatch(
              fs.SAFE, candidate, 'DISPATCHED') == fs.TIGHT)
    check('isolated pre-E0 True consumes tight band',
          fs.commit_band_after_dispatch(
              fs.SAFE, candidate, True) == fs.TIGHT)


def test_lifecycle():
    print('\n══ lifecycle suppression ══')
    for state in (fs.CHECKER_OUT, fs.PLAYER_FINISHED, fs.DEBRIEF):
        r = evaluate(
            fuel_level_l=9.9,
            lifecycle_state=state,
            previous_band=fs.SAFE)
        check(state + ' never warns',
              r['available'] and not r['should_warn']
              and r['reason'] == 'lifecycle_suppressed', r)
    r = evaluate(
        fuel_level_l=9.9, lifecycle_state='COOLDOWN',
        previous_band=fs.SAFE)
    check('unknown lifecycle fails closed',
          not r['available'] and r['reason'] == 'unknown_lifecycle', r)


def test_invalid_inputs():
    print('\n══ fail-closed inputs ══')
    cases = [
        ('fuel None', {'fuel_level_l': None}, 'invalid_fuel_level'),
        ('fuel NaN', {'fuel_level_l': math.nan}, 'invalid_fuel_level'),
        ('fuel negative', {'fuel_level_l': -0.1}, 'fuel_level_out_of_range'),
        ('fuel huge', {'fuel_level_l': 501.0}, 'fuel_level_out_of_range'),
        ('average None', {'avg_fuel_per_lap_l': None}, 'invalid_average'),
        ('average zero', {'avg_fuel_per_lap_l': 0.0}, 'average_out_of_range'),
        ('average huge', {'avg_fuel_per_lap_l': 51.0}, 'average_out_of_range'),
        ('crossings None', {
            'estimated_crossings_to_finish': None}, 'invalid_crossings'),
        ('crossings float', {
            'estimated_crossings_to_finish': 2.0}, 'invalid_crossings'),
        ('crossings zero', {
            'estimated_crossings_to_finish': 0}, 'invalid_crossings'),
        ('clean laps two', {
            'clean_laps_sampled': 2}, 'insufficient_clean_laps'),
        ('clean laps bool', {
            'clean_laps_sampled': True}, 'insufficient_clean_laps'),
        ('bad previous band', {
            'previous_band': 'warning'}, 'invalid_previous_band'),
    ]
    for name, kwargs, reason in cases:
        r = evaluate(**kwargs)
        check(name, not r['available'] and r['reason'] == reason, r)


def test_timed_provisional():
    print('\n══ timed-race provisional fuel plan ══')
    r = fs.estimate_timed_fuel_provisional(
        fuel_level_l=20.0, avg_fuel_per_lap_l=3.65,
        time_remaining_s=594.0, avg_lap_time_s=108.0,
        clean_laps_sampled=3)
    check('9:54 at 1:48 plans six laps to time zero plus final lap',
          r['available'] and r['estimated_laps'] == 7, r)
    check('provisional required fuel is deterministic',
          r['required_fuel_l'] == 25.55 and r['margin_l'] == -5.55, r)
    short = fs.estimate_timed_fuel_provisional(
        fuel_level_l=20.0, avg_fuel_per_lap_l=3.65,
        time_remaining_s=594.0, avg_lap_time_s=108.0,
        clean_laps_sampled=2)
    check('two clean laps do not unlock provisional plan',
          not short['available'] and short['reason'] == 'insufficient_clean_laps', short)


def test_planned_stop_splash_projection():
    print('\n══ planned-stop splash projection ══')
    r = fs.project_post_stop_fuel_to_finish(
        leader_time_to_checkered_s=866.0,
        driver_time_to_next_sf_s=107.0,
        driver_avg_lap_s=108.24,
        pit_loss_s=27.7,
        avg_fuel_per_lap_l=3.678,
        effective_capacity_l=23.32,
        reserve_l=0.5)
    check('8/10 Monza stop leaves six complete crossings, not stale nine',
          r['available'] and r['post_stop_crossings'] == 6, r)
    check('8/10 Monza full tank needs no extra splash',
          not r['splash_required'] and r['margin_l'] == 0.752, r)
    short = fs.project_post_stop_fuel_to_finish(
        leader_time_to_checkered_s=866.0,
        driver_time_to_next_sf_s=107.0,
        driver_avg_lap_s=108.24,
        pit_loss_s=27.7,
        avg_fuel_per_lap_l=3.9,
        effective_capacity_l=23.0,
        reserve_l=0.5)
    check('real post-stop shortfall requests a splash',
          short['splash_required'] and short['margin_l'] < 0, short)


def test_mutations():
    print('\n══ deterministic mutation evidence ══')
    source = open(
        os.path.join(HERE, 'fuel_strategy.py'), encoding='utf-8').read()

    mutated = source.replace(
        'if margin >= RESERVE_L:',
        'if margin > RESERVE_L:', 1)
    ns = {}
    exec(mutated, ns)
    args = dict(
        fuel_level_l=10.5, avg_fuel_per_lap_l=2.0,
        estimated_crossings_to_finish=5, clean_laps_sampled=3,
        lifecycle_state='RACING', previous_band='safe')
    original = fs.evaluate_fuel_to_finish(**args)
    changed = ns['evaluate_fuel_to_finish'](**args)
    check('M1 +0.5L boundary mutation detected',
          original['band'] == fs.SAFE and changed['band'] == fs.TIGHT,
          (original, changed))

    mutated2 = source.replace(
        'required = avg_fuel_per_lap_l * estimated_crossings_to_finish',
        'required = avg_fuel_per_lap_l * '
        '(estimated_crossings_to_finish + 1)', 1)
    ns2 = {}
    exec(mutated2, ns2)
    changed2 = ns2['evaluate_fuel_to_finish'](**args)
    check('M2 extra-lap reserve mutation detected',
          original['required_fuel_l'] == 10.0
          and changed2['required_fuel_l'] == 12.0,
          (original, changed2))

    mutated3 = source.replace(
        "if dispatch_result is True or dispatch_result == 'DISPATCHED':",
        'if True:', 1)
    ns3 = {}
    exec(mutated3, ns3)
    candidate = fs.evaluate_fuel_to_finish(
        **dict(args, fuel_level_l=10.2))
    check('M3 dispatch guard deletion detected',
          fs.commit_band_after_dispatch(
              fs.SAFE, candidate, 'DROPPED') == fs.SAFE
          and ns3['commit_band_after_dispatch'](
              fs.SAFE, candidate, 'DROPPED') == fs.TIGHT)

    mutated4 = source.replace(
        'lifecycle_allows_warning = lifecycle_state == RACING',
        'lifecycle_allows_warning = True', 1)
    ns4 = {}
    exec(mutated4, ns4)
    checker_args = dict(
        args, fuel_level_l=9.9, lifecycle_state='CHECKER_OUT')
    check('M4 CHECKER_OUT suppression mutation detected',
          not fs.evaluate_fuel_to_finish(**checker_args)['should_warn']
          and ns4['evaluate_fuel_to_finish'](
              **checker_args)['should_warn'])


def run_all():
    test_boundaries()
    test_transitions_and_rearm()
    test_dispatch_commit()
    test_lifecycle()
    test_invalid_inputs()
    test_timed_provisional()
    test_planned_stop_splash_projection()
    test_mutations()
    print('\n[fuel_strategy] 合格 %d / 不合格 %d'
          % (passed, failed))
    raise SystemExit(1 if failed else 0)


if __name__ == '__main__':
    run_all()
