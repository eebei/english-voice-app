"""E0 tri-state integration with Final Lap, fuel and Session Authority."""

import os
import sys


HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import final_lap  # noqa: E402
import fuel_strategy  # noqa: E402


BRIDGE_PATH = os.path.join(HERE, 'bridge.py')
RENDERER_PATH = os.path.join(ROOT, 'desktop', 'renderer.html')

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


def test_tri_state_consumption():
    print('\n══ tri-state dispatch consumption ══')
    sent = {5: False, 3: False, 1: False}
    milestone, crossed = final_lap.select_milestone(
        1, final_lap.RACING, sent)
    check('Final Lap candidate exists', milestone == 1, milestone)
    check('DROPPED does not consume Final Lap',
          final_lap.commit_milestone_after_dispatch(
              sent, crossed, 'DROPPED') == sent)
    check('HELD does not consume Final Lap',
          final_lap.commit_milestone_after_dispatch(
              sent, crossed, 'HELD') == sent)
    check('DISPATCHED alone consumes Final Lap',
          final_lap.commit_milestone_after_dispatch(
              sent, crossed, 'DISPATCHED')[1] is True)

    fuel_eval = fuel_strategy.evaluate_fuel_to_finish(
        fuel_level_l=3.0,
        avg_fuel_per_lap_l=2.0,
        estimated_crossings_to_finish=2,
        clean_laps_sampled=3,
        lifecycle_state=fuel_strategy.RACING,
        previous_band=fuel_strategy.SAFE)
    check('fuel warning candidate exists',
          fuel_eval['should_warn'] is True, fuel_eval)
    check('DROPPED does not consume fuel band',
          fuel_strategy.commit_band_after_dispatch(
              fuel_strategy.SAFE, fuel_eval, 'DROPPED')
          == fuel_strategy.SAFE)
    check('DISPATCHED alone consumes fuel band',
          fuel_strategy.commit_band_after_dispatch(
              fuel_strategy.SAFE, fuel_eval, 'DISPATCHED')
          == fuel_strategy.CRITICAL)


def test_production_contract():
    print('\n══ merged production wiring ══')
    bridge = open(BRIDGE_PATH, encoding='utf-8').read()
    renderer = open(RENDERER_PATH, encoding='utf-8').read()
    checks = {
        'E0 tri-state constants retained':
            all(x in bridge for x in (
                "BROADCAST_DISPATCHED = 'DISPATCHED'",
                "BROADCAST_HELD = 'HELD'",
                "BROADCAST_DROPPED = 'DROPPED'")),
        'Final Lap commits broadcast result':
            '_final_result = broadcast({' in bridge
            and 'final_lap.commit_milestone_after_dispatch(' in bridge,
        'fuel commits broadcast result':
            '_fuel_dispatch_result = broadcast({' in bridge
            and 'fuel_strategy_mod.commit_band_after_dispatch(' in bridge,
        'checker notice commits only DISPATCHED':
            'if _checker_result == BROADCAST_DISPATCHED:' in bridge,
        'checker notice retries through own finish':
            '_pending_checker_notice is not None' in bridge
            and 'race_lifecycle.CHECKER_OUT,' in bridge
            and 'race_lifecycle.PLAYER_FINISHED' in bridge,
        'non-race transition summary has independent retry':
            '_pending_non_race_summary = _transition_summary' in bridge
            and '_non_race_result == BROADCAST_DISPATCHED' in bridge,
        'fuel P0 cannot enter radio hold gate':
            "'rolling_gap', 'fuel_strategy_warning'" not in bridge,
        'activity deny-by-default remains first':
            bridge.find('if not _activity_allows_broadcast(event):')
            < bridge.find('if not director_gate(event):',
                          bridge.find('def broadcast(event):')),
        'session_info remains allowed meta':
            "'session_info'," in bridge[
                bridge.find('ACTIVITY_ALLOWED_META_TYPES'):
                bridge.find('def _activity_allows_broadcast')],
        'pending race summary carries exact model':
            "'car_model': session_car_model" in bridge[
                bridge.find("if _pending_summary is None"):
                bridge.find("if _pending_summary is not None")],
        'all SessionNum reset paths carry fuel band':
            "fuel_warning_band = _sig_reset['fuel_warning_band']" in bridge
            and "fuel_warning_band = _reset['fuel_warning_band']" in bridge,
        'all reset paths carry new pending states':
            "_pending_checker_notice = _sig_reset['_pending_checker_notice']"
            in bridge
            and "_pending_checker_notice = _reset['_pending_checker_notice']"
            in bridge
            and "_pending_non_race_summary = _sig_reset['_pending_non_race_summary']"
            in bridge
            and "_pending_non_race_summary = _reset['_pending_non_race_summary']"
            in bridge,
        # ★2026-09-02：旧版は `session_laps[-1].get('lap') == lap` を契約文字列として
        #   固定していたが、**この等号こそが不具合**だった。完了周と走行中周を比べており、
        #   完走時は必ず1ずれるため条件が永遠に開かず、レース summary が
        #   4走行連続で発行されなかった（9/2 Le Mans 実走で RACE SUMMARY GATE 35サンプル、
        #   may=True 0回を実測）。バグを契約として固定していたので、契約側を正す。
        #   守るべき契約は「最終ラップが記録されるまで待つ」であって、特定の等号ではない。
        'race summary requires final lap recorded before dispatch':
            'and _latest_lap_recorded)' in bridge
            and '_rec_lap in (lap, lap - 1)' in bridge
            and "_last_rec.get('time') > 0" in bridge,
        'teammate laps excluded from user summary':
            'if _driver_activity_local == driver_activity_mod.ACTIVE:'
            in bridge[bridge.find('lap_record = {'):
                      bridge.find('pass  # summary はループが処理')],
        'renderer carries authority with model memory':
            'sessionAuthority:lastSessionAuthority' in renderer
            and 'findCarTrackMemory(' in renderer,
    }
    for name, result in checks.items():
        check(name, result)


def test_mutations():
    print('\n══ merged-contract mutation evidence ══')
    bridge = open(BRIDGE_PATH, encoding='utf-8').read()
    changed = bridge.replace(
        'if _checker_result == BROADCAST_DISPATCHED:',
        'if _checker_result:', 1)
    check('truthy tri-state checker mutation detected',
          'if _checker_result == BROADCAST_DISPATCHED:' not in changed)
    changed2 = bridge.replace(
        "fuel_warning_band = _reset['fuel_warning_band']", '', 1)
    check('SessionNum fuel-band reset deletion detected',
          "fuel_warning_band = _reset['fuel_warning_band']" not in changed2)
    pending_start = bridge.find("if _pending_summary is None")
    pending_end = bridge.find("if _pending_summary is not None", pending_start)
    pending = bridge[pending_start:pending_end].replace(
        "'car_model': session_car_model", '', 1)
    check('pending summary model deletion detected',
          "'car_model': session_car_model" not in pending)
    changed4 = bridge.replace(
        'if _non_race_result == BROADCAST_DISPATCHED:',
        'if _non_race_result:', 1)
    check('truthy non-race pending mutation detected',
          'if _non_race_result == BROADCAST_DISPATCHED:' not in changed4)
    changed5 = bridge.replace('and _latest_lap_recorded)', ')', 1)
    check('final-lap-record readiness deletion detected',
          'and _latest_lap_recorded)' not in changed5)
    lap_start = bridge.find('lap_record = {')
    lap_end = bridge.find('pass  # summary はループが処理', lap_start)
    lap_block = bridge[lap_start:lap_end].replace(
        'if _driver_activity_local == driver_activity_mod.ACTIVE:',
        'if True:', 1)
    check('teammate lap guard deletion detected',
          'if _driver_activity_local == driver_activity_mod.ACTIVE:'
          not in lap_block)


def run_all():
    test_tri_state_consumption()
    test_production_contract()
    test_mutations()
    print('\n[phase_ab_integration] 合格 %d / 不合格 %d'
          % (passed, failed))
    raise SystemExit(1 if failed else 0)


if __name__ == '__main__':
    run_all()
