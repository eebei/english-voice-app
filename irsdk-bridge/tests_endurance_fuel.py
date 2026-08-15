#!/usr/bin/env python3
"""Build 272 deterministic endurance fuel horizon tests (no external APIs)."""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import endurance_fuel as ef
import plan_fuel_authority as pfa


checks = 0


def check(name, condition, detail=''):
    global checks
    checks += 1
    if not condition:
        raise AssertionError('%s: %s' % (name, detail))


def run():
    # 八木さん12時間速報の再生条件。429Lはレース総量として保持するが、
    # 92Lを積んだ4〜5周目に「この周Box」は絶対に出さない。
    plan = ef.evaluate(
        fuel_level_l=92.0, avg_fuel_per_lap_l=4.12,
        crossings_to_finish=104, effective_capacity_l=100.0,
        reserve_l=0.5, race_progress_fraction=0.35)
    check('12h plan available', plan['available'], plan)
    check('12h is multi-stop', plan['multi_stop'], plan)
    check('429L total retained internally',
          428.0 < plan['total_fuel_to_finish_l'] < 430.0, plan)
    check('full current stint is not box-now', not plan['box_this_lap'], plan)
    check('current tank has useful range',
          plan['next_fuel_stop_in_laps'] >= 20, plan)
    check('multiple services projected', plan['future_stop_count'] >= 4, plan)
    check('first half withholds splash forecast',
          plan['splash_forecast']['available'] is False, plan)

    verdict = pfa.evaluate(
        {'band': 'critical'}, None, current_lap=5, fuel_level_l=92.0,
        avg_fuel_per_lap_l=4.12, effective_capacity_l=100.0,
        endurance_plan=plan)
    check('total deficit cannot emit P0 box',
          verdict['allow_p0_pit_now'] is False, verdict)
    check('suppression reason is auditable',
          verdict['suppression_reason'] == 'multi_stop_total_is_not_pit_now', verdict)

    monza = ef.evaluate(
        fuel_level_l=4.8, avg_fuel_per_lap_l=3.6,
        crossings_to_finish=8, effective_capacity_l=20.14,
        reserve_l=0.5, race_progress_fraction=0.4)
    check('Monza final in-lap is box-now', monza['box_this_lap'], monza)
    check('Monza still identifies multi-stop total', monza['multi_stop'], monza)

    due = ef.evaluate(
        fuel_level_l=3.9, avg_fuel_per_lap_l=4.12,
        crossings_to_finish=80, effective_capacity_l=100.0,
        reserve_l=0.5, race_progress_fraction=0.4)
    due_verdict = pfa.evaluate(
        {'band': 'critical'}, None, current_lap=25, fuel_level_l=3.9,
        avg_fuel_per_lap_l=4.12, effective_capacity_l=100.0,
        endurance_plan=due)
    check('current stint due allows P0', due['box_this_lap'], due)
    check('due reason is current stint',
          due_verdict['override_reason'] == 'current_stint_fuel_window_due', due_verdict)

    second_half = ef.evaluate(
        fuel_level_l=55.0, avg_fuel_per_lap_l=4.0,
        crossings_to_finish=58, effective_capacity_l=100.0,
        reserve_l=0.5, race_progress_fraction=0.55)
    splash = second_half['splash_forecast']
    check('second half enables final-service projection', splash['available'], splash)
    check('splash projection never changes pit-now horizon',
          not second_half['box_this_lap'], second_half)
    check('save target is numeric',
          isinstance(splash['avoid_splash_save_l_per_lap'], float), splash)

    invalid = ef.evaluate(
        fuel_level_l=92.0, avg_fuel_per_lap_l=4.12,
        crossings_to_finish=104, effective_capacity_l=None)
    check('missing capacity fails closed', not invalid['available'], invalid)

    print('tests_endurance_fuel: %d checks passed' % checks)


if __name__ == '__main__':
    run()
