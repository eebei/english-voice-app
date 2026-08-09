#!/usr/bin/env python3
from strategy_options import build_initial_plans, decide_at_plan_a, score_execution


options = build_initial_plans(
    snapshot_id='session:1:180.0', current_lap=3, fuel_level_l=18.0,
    avg_fuel_per_lap_l=3.5, clean_laps_sampled=3,
    crossings_to_finish=8, reserve_l=0.5, effective_capacity_l=40.0)
assert options['available'] is True
assert options['selected_plan'] == 'A'
assert options['plan_a']['target_lap'] == 7
assert options['plan_b']['target_lap'] == 8
assert options['plan_a']['set_fuel_l'] == 11
assert options['plan_b']['set_fuel_l'] == 11
assert len(options['switch_conditions']) == 3

too_early = build_initial_plans(
    snapshot_id='session:1:60.0', current_lap=1, fuel_level_l=30.0,
    avg_fuel_per_lap_l=3.5, clean_laps_sampled=2,
    crossings_to_finish=8)
assert too_early['available'] is False
assert too_early['reason'] == 'insufficient_clean_laps'

no_stop = build_initial_plans(
    snapshot_id='session:1:300.0', current_lap=4, fuel_level_l=30.0,
    avg_fuel_per_lap_l=3.0, clean_laps_sampled=4,
    crossings_to_finish=6)
assert no_stop['plan_a']['action'] == 'stay_out'
assert no_stop['plan_b']['available'] is False

outcome = score_execution(options, actual_entry_lap=8, actual_fuel_added_l=10.7)
assert outcome['available'] is True
assert outcome['executed_plan'] == 'B'
assert outcome['entry_lap_error'] == 0
assert outcome['fuel_add_error_l'] == 0.2

def forecast(likely, worst):
    return {'available': True, 'snapshot_id': 'live:1:500', 'model_version': 4,
            'likely': {'position': likely}, 'worst': {'position': worst}}

choose_b = decide_at_plan_a(
    options, current_lap=7, current_fuel_l=5.0, avg_fuel_per_lap_l=3.5,
    pit_now_forecast=forecast(8, 10), pit_next_lap_forecast=forecast(6, 9))
assert choose_b['selected_plan'] == 'B'
assert choose_b['reason'] == 'plan_b_physical_rejoin_better'
assert choose_b['pit_cycle_position_used'] is False

tie_stays_a = decide_at_plan_a(
    options, current_lap=7, current_fuel_l=5.0, avg_fuel_per_lap_l=3.5,
    pit_now_forecast=forecast(8, 10), pit_next_lap_forecast=forecast(8, 9))
assert tie_stays_a['selected_plan'] == 'A'

unsafe_stays_a = decide_at_plan_a(
    options, current_lap=7, current_fuel_l=3.8, avg_fuel_per_lap_l=3.5,
    pit_now_forecast=forecast(8, 10), pit_next_lap_forecast=forecast(6, 9))
assert unsafe_stays_a['selected_plan'] == 'A'
assert unsafe_stays_a['reason'] == 'plan_b_fuel_reserve_not_met'

missing_forecast_stays_a = decide_at_plan_a(
    options, current_lap=7, current_fuel_l=5.0, avg_fuel_per_lap_l=3.5,
    pit_now_forecast={'available': False}, pit_next_lap_forecast=forecast(6, 9))
assert missing_forecast_stays_a['selected_plan'] == 'A'
assert missing_forecast_stays_a['reason'] == 'physical_rejoin_comparison_unavailable'

print('✅ strategy options Plan A/B')
