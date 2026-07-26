"""Production wiring checks for Unit 1 Final Lap.

These checks intentionally inspect the real bridge source.  The pure model
tests cannot prove that telemetry, lifecycle and dispatch state are connected
to it.
"""

import os


HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_PATH = os.path.join(HERE, 'bridge.py')

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


def production_contracts(source):
    return {
        'module_imported': 'import final_lap' in source,
        'priority_p2': "'final_lap': 2, 'final_lap_notice': 2" in source,
        'overall_position': (
            "read_int_array('CarIdxPosition', 64)" in source
            and 'overall_leader_idx' in source),
        'dist_pct': "read_float_array('CarIdxLapDistPct', 64)" in source,
        'pit_guard': "read_int_array('CarIdxOnPitRoad', 64)" in source,
        'surface_guard': "read_int_array('CarIdxTrackSurface', 64)" in source,
        'model_called': (
            'final_lap.evaluate_final_lap_for_driver(' in source),
        'timed_no_legacy_fallback': (
            'final_lap.select_milestone_laps(' in source),
        'dispatch_commit_contract': (
            'final_lap.commit_milestone_after_dispatch(' in source),
        'checker_edge': (
            'final_lap.should_dispatch_checker_notice(' in source),
        'legacy_milestone_not_called': (
            'check_final_lap_milestones(' not in source.replace(
                'def check_final_lap_milestones(', '', 1)),
        'not_gated_by_fuel': (
            'if lap_time_changed and onTrack and fuel is not None:'
            not in source),
        'fuel_independent_order': (
            source.find('final_lap.evaluate_final_lap_for_driver(')
            < source.find('if fuel_per_lap_hist',
                          source.find('if lap_time_changed and onTrack'))),
    }


def test_production_wiring():
    print('\n══ production wiring ══')
    source = open(BRIDGE_PATH, encoding='utf-8').read()
    contracts = production_contracts(source)
    for name, value in contracts.items():
        check(name, value)


def test_wiring_mutations():
    print('\n══ wiring mutation evidence ══')
    source = open(BRIDGE_PATH, encoding='utf-8').read()

    mutations = [
        (
            'remove model call',
            source.replace(
                'final_lap.evaluate_final_lap_for_driver(',
                'removed_final_lap_evaluator(', 1),
            'model_called',
        ),
        (
            'replace overall position with class position',
            source.replace(
                "read_int_array('CarIdxPosition', 64)",
                "read_int_array('CarIdxClassPosition', 64)", 1),
            'overall_position',
        ),
        (
            'remove dispatch-only commit',
            source.replace(
                'final_lap.commit_milestone_after_dispatch(',
                'final_lap.commit_milestone(', 1),
            'dispatch_commit_contract',
        ),
        (
            'restore legacy milestone call',
            source.replace(
                '# ── Final Lap / Last 5-3-1',
                'check_final_lap_milestones(None, None, {})\n'
                '            # ── Final Lap / Last 5-3-1', 1),
            'legacy_milestone_not_called',
        ),
        (
            'drop checker edge wiring',
            source.replace(
                'final_lap.should_dispatch_checker_notice(',
                'removed_checker_edge(', 1),
            'checker_edge',
        ),
        (
            'restore fuel prerequisite',
            source.replace(
                'if lap_time_changed and onTrack:',
                'if lap_time_changed and onTrack and fuel is not None:', 1),
            'not_gated_by_fuel',
        ),
    ]

    baseline = production_contracts(source)
    check('baseline contracts all true', all(baseline.values()), baseline)
    for label, mutated, expected_failure in mutations:
        result = production_contracts(mutated)
        check(label + ' is detected',
              result.get(expected_failure) is False, result)


def run_all():
    test_production_wiring()
    test_wiring_mutations()
    print('\n[final_lap_wiring] 合格 %d / 不合格 %d'
          % (passed, failed))
    raise SystemExit(1 if failed else 0)


if __name__ == '__main__':
    run_all()
