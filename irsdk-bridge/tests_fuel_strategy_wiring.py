"""Production wiring and Final Lap authority integration for endurance fuel."""

import os
import sys


HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import final_lap  # noqa: E402
import fuel_strategy  # noqa: E402


BRIDGE_PATH = os.path.join(HERE, 'bridge.py')
RENDERER_PATH = os.path.join(ROOT, 'desktop', 'renderer.html')
PROMPTS_PATH = os.path.join(ROOT, 'prompts.js')

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


def contracts(bridge, renderer, prompts):
    return {
        'module_imported': (
            'import fuel_strategy as fuel_strategy_mod' in bridge),
        'priority_p0': (
            "'fuel_warning': 0, 'fuel_strategy_warning': 0" in bridge),
        'not_gateable': (
            "'rolling_gap', 'gap_trend',\n})" in bridge
            and "'fuel_strategy_warning'" not in bridge[bridge.index('GATEABLE_TRIGGERS'):bridge.index('_gate_state', bridge.index('GATEABLE_TRIGGERS'))]),
        'band_reset_source': "'fuel_warning_band': None" in bridge,
        'band_reset_sig': (
            "fuel_warning_band = _sig_reset['fuel_warning_band']"
            in bridge),
        'band_reset_session_num': (
            "fuel_warning_band = _reset['fuel_warning_band']"
            in bridge),
        'shared_crossings': (
            'estimated_crossings_to_finish=_milestone_laps' in bridge),
        'lifecycle_wired': (
            'lifecycle_state=lifecycle_state' in bridge),
        'dispatch_commit': (
            'fuel_strategy_mod.commit_band_after_dispatch(' in bridge),
        'pit_suppression': (
            "if _fuel_eval.get('should_warn') and not onPit:" in bridge),
        'old_extra_lap_removed': (
            'avg_fuel_lap * (laps_remaining_est + 1)' not in bridge),
        'old_margin_laps_removed': (
            'margin_laps < -0.5' not in bridge),
        'renderer_uses_band': (
            "d.fuel_band === 'tight'" in renderer
            and 'd.margin_l' in renderer),
        'prompt_uses_liters': (
            'if (fs.margin_l != null)' in prompts
            and 'fs.required_fuel_l' in prompts
            and 'fs.estimated_crossings_to_finish' in prompts),
        'prompt_old_margin_removed': (
            'if (fs.margin_laps != null)' not in prompts),
    }


def test_production_wiring():
    print('\n══ production wiring ══')
    bridge = open(BRIDGE_PATH, encoding='utf-8').read()
    renderer = open(RENDERER_PATH, encoding='utf-8').read()
    prompts = open(PROMPTS_PATH, encoding='utf-8').read()
    result = contracts(bridge, renderer, prompts)
    for name, value in result.items():
        check(name, value)


def test_final_lap_to_fuel_integration():
    print('\n══ 7/25 Final Lap authority -> fuel integration ══')
    final_eval = final_lap.evaluate_final_lap_for_driver(
        driver_lap_dist_pct=1.0 - 120.0 / 127.0,
        leader_lap_dist_pct=1.0 - 71.0 / 114.0,
        driver_avg_lap_s=127.0,
        leader_avg_lap_s=114.0,
        session_time_remain_s=82.0,
        session_laps_remain_for_leader=None,
        is_time_race=True,
        lifecycle_state=final_lap.RACING,
        final_lap_already_announced=False,
        is_driver_overall_leader=False,
        driver_pace_sample_count=5,
        leader_pace_sample_count=5,
        driver_in_pit_or_garage=False,
        leader_in_pit_or_garage=False)
    crossings = final_lap.select_milestone_laps(
        True, final_eval, legacy_laps_remaining=1)
    check('7/25 authority says two crossings, never legacy one',
          crossings == 2, (final_eval, crossings))

    fuel_eval = fuel_strategy.evaluate_fuel_to_finish(
        fuel_level_l=4.0,
        avg_fuel_per_lap_l=2.0,
        estimated_crossings_to_finish=crossings,
        clean_laps_sampled=5,
        lifecycle_state=fuel_strategy.RACING,
        previous_band=fuel_strategy.SAFE)
    check('same two crossings require exactly 4.0L',
          fuel_eval['required_fuel_l'] == 4.0, fuel_eval)
    check('zero margin is tight and warns',
          fuel_eval['margin_l'] == 0.0
          and fuel_eval['band'] == fuel_strategy.TIGHT
          and fuel_eval['should_warn'], fuel_eval)

    unavailable = final_lap.select_milestone_laps(
        True, {'estimated_crossings_to_finish': None}, 1)
    no_guess = fuel_strategy.evaluate_fuel_to_finish(
        fuel_level_l=4.0,
        avg_fuel_per_lap_l=2.0,
        estimated_crossings_to_finish=unavailable,
        clean_laps_sampled=5,
        lifecycle_state=fuel_strategy.RACING,
        previous_band=fuel_strategy.SAFE)
    check('Final Lap unavailable means fuel-to-finish unavailable',
          not no_guess['available']
          and no_guess['reason'] == 'invalid_crossings', no_guess)


def test_wiring_mutations():
    print('\n══ deterministic wiring mutations ══')
    bridge = open(BRIDGE_PATH, encoding='utf-8').read()
    renderer = open(RENDERER_PATH, encoding='utf-8').read()
    prompts = open(PROMPTS_PATH, encoding='utf-8').read()
    baseline = contracts(bridge, renderer, prompts)
    check('baseline all true', all(baseline.values()), baseline)

    mutations = [
        (
            'replace authority crossings with legacy estimate',
            bridge.replace(
                'estimated_crossings_to_finish=_milestone_laps',
                'estimated_crossings_to_finish=laps_remaining_est', 1),
            renderer, prompts, 'shared_crossings',
        ),
        (
            'restore extra safety lap',
            bridge.replace(
                '# ── ② to-finish authority',
                'fuel_needed = avg_fuel_lap * '
                '(laps_remaining_est + 1)\n'
                '                # ── ② to-finish authority', 1),
            renderer, prompts, 'old_extra_lap_removed',
        ),
        (
            'remove dispatch-only commit',
            bridge.replace(
                'fuel_strategy_mod.commit_band_after_dispatch(',
                'fuel_strategy_mod.commit_band(', 1),
            renderer, prompts, 'dispatch_commit',
        ),
        (
            'remove SessionNum reset unpack',
            bridge.replace(
                "fuel_warning_band = _reset['fuel_warning_band']",
                'fuel_warning_band = fuel_warning_band', 1),
            renderer, prompts, 'band_reset_session_num',
        ),
        (
            'restore old prompt margin',
            bridge, renderer,
            prompts.replace(
                'if (fs.margin_l != null)',
                'if (fs.margin_laps != null)', 1),
            'prompt_uses_liters',
        ),
    ]
    for label, bsrc, rsrc, psrc, failed_key in mutations:
        result = contracts(bsrc, rsrc, psrc)
        check(label + ' detected',
              result.get(failed_key) is False, result)


def run_all():
    test_production_wiring()
    test_final_lap_to_fuel_integration()
    test_wiring_mutations()
    print('\n[fuel_strategy_wiring] 合格 %d / 不合格 %d'
          % (passed, failed))
    raise SystemExit(1 if failed else 0)


if __name__ == '__main__':
    run_all()
