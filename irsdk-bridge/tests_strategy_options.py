#!/usr/bin/env python3
"""Plan A / B / C の契約テスト。

★Plan B定義の判断（2026-08-12）で意味を入れ替えた：
  A = 基準（通常ペースで成立する最後の燃料安全周）
  B = 条件付きアンダーカット（Fuel Window が開いた最初の周・A より前）
  C = 条件付きオーバーカット／fuel-save（A を基準に延長）

旧契約（A=latest_safe-1 / B=A の1周後 = 延長）の期待値はここで全て置き換えている。
"""
from strategy_options import (build_initial_plans, decide_at_plan_a,
                              decide_plan_b, score_execution,
                              PLAN_B_CONDITIONS, PLAN_B_MIN_PACE_ADVANTAGE_S)


options = build_initial_plans(
    snapshot_id='session:1:180.0', current_lap=3, fuel_level_l=18.0,
    avg_fuel_per_lap_l=3.5, clean_laps_sampled=3,
    crossings_to_finish=8, reserve_l=0.5, effective_capacity_l=40.0)
assert options['available'] is True
assert options['selected_plan'] == 'A'
# A は latest fuel-safe lap。B はウインドウが開いた最初の周＝A より前。
assert options['plan_a']['target_lap'] == 8
assert options['plan_b']['target_lap'] == 3
assert options['plan_b']['target_in_laps'] < options['plan_a']['target_in_laps']
assert options['plan_a']['set_fuel_l'] == 11
assert options['plan_b']['action'] == 'undercut'
# B は燃料だけでは available にならない（相対ペースと復帰が要る）。
assert options['plan_b']['available'] is False
assert options['plan_b']['fuel_window_open'] is True
assert options['plan_b']['reason'] == 'conditions_unproven'
assert tuple(options['switch_conditions']) == PLAN_B_CONDITIONS
# C は A を基準に1周延長。
assert options['plan_c']['target_in_laps'] == options['plan_a']['target_in_laps'] + 1

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
assert no_stop['plan_c']['available'] is False

outcome = score_execution(options, actual_entry_lap=8, actual_fuel_added_l=10.7)
assert outcome['available'] is True
assert outcome['executed_plan'] == 'A'
assert outcome['entry_lap_error'] == 0
assert outcome['fuel_add_error_l'] == 0.2


def forecast(likely, worst):
    return {'available': True, 'snapshot_id': 'live:1:500', 'model_version': 4,
            'likely': {'position': likely}, 'worst': {'position': worst}}


# 全条件が揃った時だけ B。早入れ側(now)の復帰が基準側(next)より良いこと。
choose_b = decide_at_plan_a(
    options, current_lap=7, current_fuel_l=5.0, avg_fuel_per_lap_l=3.5,
    pit_now_forecast=forecast(6, 9), pit_next_lap_forecast=forecast(8, 10),
    relative_pace_advantage_s=0.8)
assert choose_b['selected_plan'] == 'B'
assert choose_b['reason'] == 'plan_b_undercut_conditions_proven'
assert choose_b['pit_cycle_position_used'] is False

# ペース優位が無ければアンダーカットしない。
no_pace_stays_a = decide_at_plan_a(
    options, current_lap=7, current_fuel_l=5.0, avg_fuel_per_lap_l=3.5,
    pit_now_forecast=forecast(6, 9), pit_next_lap_forecast=forecast(8, 10),
    relative_pace_advantage_s=0.0)
assert no_pace_stays_a['selected_plan'] == 'A'
assert 'relative_pace_advantage' in no_pace_stays_a['plan_b_evidence']['conditions_failed']

# 早入れすると遅い集団へ沈む場合もしない。
blend_stays_a = decide_at_plan_a(
    options, current_lap=7, current_fuel_l=5.0, avg_fuel_per_lap_l=3.5,
    pit_now_forecast=forecast(9, 11), pit_next_lap_forecast=forecast(6, 9),
    relative_pace_advantage_s=0.8)
assert blend_stays_a['selected_plan'] == 'A'
assert 'rejoin_clear' in blend_stays_a['plan_b_evidence']['conditions_failed']

# 復帰予測が取れない＝未証明。未証明は満たされたと扱わない。
missing_forecast_stays_a = decide_at_plan_a(
    options, current_lap=7, current_fuel_l=5.0, avg_fuel_per_lap_l=3.5,
    pit_now_forecast={'available': False}, pit_next_lap_forecast=forecast(6, 9),
    relative_pace_advantage_s=0.8)
assert missing_forecast_stays_a['selected_plan'] == 'A'
assert 'rejoin_clear' in missing_forecast_stays_a['plan_b_evidence']['conditions_failed']

# しきい値未満の優位は「速い」と言わない。
marginal = decide_plan_b(
    options, relative_pace_advantage_s=PLAN_B_MIN_PACE_ADVANTAGE_S - 0.01,
    rejoin_clear=True)
assert marginal['available'] is False

print('✅ strategy options Plan A/B/C')
