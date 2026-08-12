#!/usr/bin/env python3
"""Build 266 — Codex差戻し#2 / #4 の挙動テスト。

#2：再計算は「既存Planを渡してtraceする」ことではない。実測された燃費・残り周回・
    リジョイン予測を入力して Plan A/B/C を組み直し、選び直すこと。
#4：Plan C（overcut / fuel-save）は条件が実測で揃った時だけ成立する。根拠が無ければ
    unavailable であり、常設の同格案として扱わない。

外部APIは呼ばない（内部シミュレーション正本 §Non-negotiable rules 1）。
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import strategy_options as so


def long_stint_options(**overrides):
    """Plan C が燃料的に届くだけの長いスティント。"""
    params = dict(
        snapshot_id='s:1:100.0', current_lap=5, fuel_level_l=35.0,
        avg_fuel_per_lap_l=3.5, clean_laps_sampled=4,
        crossings_to_finish=20, reserve_l=0.5, effective_capacity_l=60.0)
    params.update(overrides)
    return so.build_initial_plans(**params)


class PlanCFeasibility(unittest.TestCase):
    """#4 — ブリーフィング時点では燃料計算だけを答える。"""

    def test_plan_c_exists_in_the_snapshot(self):
        self.assertIn('plan_c', long_stint_options())

    def test_plan_c_extends_from_plan_a_not_plan_b(self):
        """★Plan B定義の判断：B はアンダーカット（Aより前）なので、その先を足しても
        延長にならない。C の基準は常に Plan A である。"""
        options = long_stint_options()
        self.assertEqual(options['plan_c']['target_in_laps'],
                         options['plan_a']['target_in_laps'] + 1)
        self.assertLess(options['plan_b']['target_in_laps'],
                        options['plan_a']['target_in_laps'],
                        'Plan B must be earlier than the baseline')

    def test_plan_c_is_never_available_at_briefing(self):
        """根拠が無い段階でオーバーカットを同格案として出さない。"""
        plan_c = long_stint_options()['plan_c']
        self.assertTrue(plan_c['fuel_feasible'])
        self.assertFalse(plan_c['available'])
        self.assertEqual(plan_c['reason'], 'conditions_unproven')

    def test_plan_c_reports_the_saving_required(self):
        plan_c = long_stint_options()['plan_c']
        self.assertLess(plan_c['required_fuel_per_lap_l'], 3.5)
        self.assertGreater(plan_c['fuel_save_per_lap_l'], 0.0)
        self.assertLessEqual(plan_c['fuel_save_fraction'], so.PLAN_C_MAX_SAVE_FRACTION)

    def test_unrealistic_saving_is_not_feasible(self):
        """8%を超える節約が必要なら「やれば届く」とは言わない。"""
        plan_c = so.build_initial_plans(
            snapshot_id='s:1:100.0', current_lap=3, fuel_level_l=18.0,
            avg_fuel_per_lap_l=3.5, clean_laps_sampled=3,
            crossings_to_finish=8, reserve_l=0.5,
            effective_capacity_l=40.0)['plan_c']
        self.assertFalse(plan_c['fuel_feasible'])
        self.assertEqual(plan_c['reason'], 'fuel_save_target_unrealistic')

    def test_no_room_to_extend_near_the_finish(self):
        plan_c = so.build_initial_plans(
            snapshot_id='s:1:100.0', current_lap=10, fuel_level_l=20.0,
            avg_fuel_per_lap_l=3.5, clean_laps_sampled=4,
            crossings_to_finish=6, reserve_l=0.5,
            effective_capacity_l=60.0)['plan_c']
        self.assertFalse(plan_c['fuel_feasible'])
        self.assertEqual(plan_c['reason'], 'no_room_to_extend')

    def test_conditions_are_declared(self):
        self.assertEqual(tuple(long_stint_options()['plan_c']['conditions_required']),
                         so.PLAN_C_CONDITIONS)


class PlanCConditions(unittest.TestCase):
    """#4 — ライブ条件が全部揃った時だけ available になる。"""

    def setUp(self):
        self.options = long_stint_options()
        self.target = self.options['plan_c']['required_fuel_per_lap_l']

    def all_proven(self, **overrides):
        params = dict(fuel_save_recent_l_per_lap=self.target - 0.05,
                      rival_pitted_first=True, clean_air=True,
                      rejoin_not_worse=True)
        params.update(overrides)
        return so.decide_plan_c(self.options, **params)

    def test_all_conditions_proven_makes_it_available(self):
        verdict = self.all_proven()
        self.assertTrue(verdict['available'])
        self.assertEqual(verdict['conditions_failed'], [])

    def test_each_condition_alone_blocks_it(self):
        for field in ('rival_pitted_first', 'clean_air', 'rejoin_not_worse'):
            verdict = self.all_proven(**{field: False})
            self.assertFalse(verdict['available'], field)
            self.assertIn(field, verdict['conditions_failed'])

    def test_unknown_is_not_satisfied(self):
        """None は「不明」であって「満たされている」ではない。"""
        for field in ('rival_pitted_first', 'clean_air', 'rejoin_not_worse'):
            verdict = self.all_proven(**{field: None})
            self.assertFalse(verdict['available'], field)
            self.assertIn(field, verdict['conditions_failed'])

    def test_missing_fuel_save_evidence_blocks_it(self):
        verdict = self.all_proven(fuel_save_recent_l_per_lap=None)
        self.assertFalse(verdict['available'])
        self.assertIn('fuel_save_on_target', verdict['conditions_failed'])

    def test_missing_the_fuel_target_blocks_it(self):
        verdict = self.all_proven(fuel_save_recent_l_per_lap=self.target + 0.2)
        self.assertFalse(verdict['available'])
        self.assertIn('fuel_save_on_target', verdict['conditions_failed'])

    def test_not_fuel_feasible_can_never_be_promoted(self):
        cramped = so.build_initial_plans(
            snapshot_id='s:1:100.0', current_lap=3, fuel_level_l=18.0,
            avg_fuel_per_lap_l=3.5, clean_laps_sampled=3,
            crossings_to_finish=8, reserve_l=0.5, effective_capacity_l=40.0)
        verdict = so.decide_plan_c(
            cramped, fuel_save_recent_l_per_lap=0.1, rival_pitted_first=True,
            clean_air=True, rejoin_not_worse=True)
        self.assertFalse(verdict['available'])


class PlanCTargetIsLatched(unittest.TestCase):
    """#4 — 目標値が測定と一緒に動くと、節約しても永久に達成できない。

    目標は「今の燃費なら latest_safe+1 まで届かせるのに必要な燃費」であり、
    計算に使った燃費より必ず小さい。組み直すたびに目標も下がるため、ラッチしない限り
    `fuel_save_on_target` は構造的に成立せず、Plan C は本番で死ぬ。
    """

    def base_kwargs(self, **overrides):
        params = dict(
            previous=None, snapshot_id='recalc:test:1',
            trigger_reason='fuel_deviation', current_lap=6,
            fuel_level_l=35.0, recent_fuel_per_lap_l=3.5, clean_laps_sampled=4,
            crossings_to_finish=20, reserve_l=0.5, effective_capacity_l=60.0)
        params.update(overrides)
        return params

    def test_target_moves_without_a_latch(self):
        """ラッチが無ければどうなるかを、build 単体で示す（回帰の理由の記録）。"""
        planned = so.build_initial_plans(
            snapshot_id='a', current_lap=5, fuel_level_l=35.0,
            avg_fuel_per_lap_l=3.5, clean_laps_sampled=4, crossings_to_finish=20,
            reserve_l=0.5, effective_capacity_l=60.0)['plan_c']
        saved = so.build_initial_plans(
            snapshot_id='b', current_lap=5, fuel_level_l=35.0,
            avg_fuel_per_lap_l=3.2, clean_laps_sampled=4, crossings_to_finish=20,
            reserve_l=0.5, effective_capacity_l=60.0)['plan_c']
        self.assertLess(saved['required_fuel_per_lap_l'],
                        planned['required_fuel_per_lap_l'],
                        'the unlatched target runs away from the driver')

    def test_reevaluation_keeps_the_first_target(self):
        first = so.reevaluate_plans(**self.base_kwargs())
        latched = first['options']['plan_c']['required_fuel_per_lap_l']
        later = so.reevaluate_plans(
            **self.base_kwargs(previous=first['options'], recent_fuel_per_lap_l=3.2))
        self.assertEqual(later['options']['plan_c']['required_fuel_per_lap_l'], latched)
        self.assertTrue(later['options']['plan_c']['fuel_save_target_latched'])

    def test_saving_against_the_latched_target_is_reachable(self):
        first = so.reevaluate_plans(**self.base_kwargs())
        latched = first['options']['plan_c']['required_fuel_per_lap_l']
        later = so.reevaluate_plans(
            **self.base_kwargs(previous=first['options'],
                               recent_fuel_per_lap_l=3.3,
                               fuel_save_recent_l_per_lap=latched - 0.05,
                               rival_pitted_first=True, clean_air=True,
                               rejoin_not_worse=True))
        self.assertTrue(later['plan_c_evidence']['available'])
        self.assertEqual(later['selected_plan'], 'C')

    def test_not_saving_still_fails_against_the_latched_target(self):
        first = so.reevaluate_plans(**self.base_kwargs())
        latched = first['options']['plan_c']['required_fuel_per_lap_l']
        later = so.reevaluate_plans(
            **self.base_kwargs(previous=first['options'],
                               fuel_save_recent_l_per_lap=latched + 0.1,
                               rival_pitted_first=True, clean_air=True,
                               rejoin_not_worse=True))
        self.assertFalse(later['plan_c_evidence']['available'])
        self.assertIn('fuel_save_on_target',
                      later['plan_c_evidence']['conditions_failed'])


class ReevaluationActuallyRecomputes(unittest.TestCase):
    """#2 — 再計算は記録ではなく計算であること。"""

    def base_kwargs(self, **overrides):
        params = dict(
            previous=None, snapshot_id='recalc:test:1',
            trigger_reason='driver_reported_damage', current_lap=6,
            fuel_level_l=35.0, recent_fuel_per_lap_l=3.5, clean_laps_sampled=4,
            crossings_to_finish=20, reserve_l=0.5, effective_capacity_l=60.0)
        params.update(overrides)
        return params

    def test_plans_are_rebuilt_from_the_supplied_numbers(self):
        result = so.reevaluate_plans(**self.base_kwargs())
        self.assertTrue(result['available'])
        self.assertEqual(result['options']['avg_fuel_per_lap_l'], 3.5)
        self.assertEqual(result['options']['fuel_level_l'], 35.0)

    def test_worse_fuel_moves_the_stop_earlier(self):
        """接触後に燃費が悪化したら、同じ入力でPlanが実際に変わること。
        これが「記録だけ」と「再計算」を分ける一点である。"""
        before = so.reevaluate_plans(
            **self.base_kwargs(recent_fuel_per_lap_l=3.5, effective_capacity_l=110.0))
        after = so.reevaluate_plans(
            **self.base_kwargs(recent_fuel_per_lap_l=4.4, effective_capacity_l=110.0))
        self.assertLess(after['options']['plan_a']['target_in_laps'],
                        before['options']['plan_a']['target_in_laps'],
                        'a thirstier car must stop sooner')
        self.assertGreater(after['options']['total_required_l'],
                           before['options']['total_required_l'])

    def test_recent_median_not_the_old_baseline_is_used(self):
        previous = long_stint_options()
        result = so.reevaluate_plans(
            **self.base_kwargs(previous=previous, recent_fuel_per_lap_l=4.4,
                               effective_capacity_l=110.0))
        self.assertEqual(result['options']['avg_fuel_per_lap_l'], 4.4,
                         'the rebuilt plan must use the post-damage number')

    def test_insufficient_evidence_keeps_the_previous_plan(self):
        previous = long_stint_options()
        previous['selected_plan'] = 'B'
        result = so.reevaluate_plans(
            **self.base_kwargs(previous=previous, recent_fuel_per_lap_l=None))
        self.assertFalse(result['available'])
        self.assertEqual(result['selected_plan'], 'B',
                         'no evidence is not a reason to switch plans')
        self.assertFalse(result['plan_changed'])

    def test_plan_change_is_reported(self):
        previous = long_stint_options()
        previous['selected_plan'] = 'A'
        result = so.reevaluate_plans(
            **self.base_kwargs(previous=previous,
                               recent_fuel_per_lap_l=3.5,
                               fuel_save_recent_l_per_lap=3.0,
                               rival_pitted_first=True, clean_air=True,
                               rejoin_not_worse=True))
        self.assertEqual(result['selected_plan'], 'C')
        self.assertTrue(result['plan_changed'])
        self.assertEqual(result['previous_plan'], 'A')

    def test_plan_c_selected_only_with_proven_conditions(self):
        without = so.reevaluate_plans(**self.base_kwargs(recent_fuel_per_lap_l=3.5))
        self.assertNotEqual(without['selected_plan'], 'C')
        self.assertFalse(without['plan_c_evidence']['available'])

    def test_selection_falls_back_to_a_without_rejoin_evidence(self):
        result = so.reevaluate_plans(**self.base_kwargs())
        self.assertEqual(result['selected_plan'], 'A')
        self.assertIn('unproven', result['reason'])

    def test_trigger_reason_is_carried_into_the_result(self):
        result = so.reevaluate_plans(**self.base_kwargs(trigger_reason='fuel_deviation'))
        self.assertEqual(result['trigger_reason'], 'fuel_deviation')

    def test_inputs_are_echoed_for_the_trace(self):
        result = so.reevaluate_plans(
            **self.base_kwargs(recent_pace_s=109.1, baseline_pace_s=108.4))
        self.assertEqual(result['inputs']['recent_pace_s'], 109.1)
        self.assertEqual(result['inputs']['baseline_pace_s'], 108.4)
        self.assertEqual(result['inputs']['crossings_to_finish'], 20)


class BridgeRecalculationExecution(unittest.TestCase):
    """#2 — bridge の `execute_recalculation` そのものを、写経ではなく本番モジュールを
    import して動かす。ソース文字列の存在確認では、中身を空にする改変を検出できない。
    """

    @classmethod
    def setUpClass(cls):
        import bridge as bridge_mod
        import session_race_state as srs
        cls.bridge = bridge_mod
        cls.srs = srs

    def live_inputs(self, **overrides):
        params = dict(
            session_num=1, current_lap=6, session_time_s=700.0,
            fuel_level_l=35.0, recent_fuel_per_lap_l=3.5, recent_pace_s=108.6,
            clean_laps_sampled=4, crossings_to_finish=20, reserve_l=0.5,
            effective_capacity_l=60.0, pit_now_forecast=None,
            pit_next_lap_forecast=None, rival_pitted_first=None,
            clean_air=None, rejoin_not_worse=None,
            fuel_save_recent_l_per_lap=None,
            baseline_fuel_override=None, baseline_pace_override=None)
        params.update(overrides)
        return params

    def run_one(self, state, reason='driver_reported_damage', **input_overrides):
        return self.bridge.execute_recalculation(
            state, {'reason': reason, 'dedupe_key': 'k1', 'driver_message': None},
            inputs=self.live_inputs(**input_overrides),
            srs_mod=self.srs, options_mod=so)

    def test_active_plan_is_actually_updated(self):
        state = self.srs.init_state()
        self.assertIsNone(state['active_plan'])
        state, verdict = self.run_one(state)
        self.assertTrue(verdict['available'])
        self.assertEqual(state['active_plan'], verdict['selected_plan'])
        self.assertIsNotNone(state['active_plan_snapshot'],
                             'the rebuilt plan must become the active plan')

    def test_the_snapshot_stored_is_the_rebuilt_one(self):
        state = self.srs.init_state()
        state, _ = self.run_one(state, recent_fuel_per_lap_l=4.0,
                                effective_capacity_l=110.0)
        self.assertEqual(state['active_plan_snapshot']['avg_fuel_per_lap_l'], 4.0)

    def test_a_worse_fuel_number_moves_the_stored_plan(self):
        clean = self.srs.init_state()
        clean, _ = self.run_one(clean, recent_fuel_per_lap_l=3.5,
                                effective_capacity_l=110.0)
        damaged = self.srs.init_state()
        damaged, _ = self.run_one(damaged, recent_fuel_per_lap_l=4.4,
                                  effective_capacity_l=110.0)
        self.assertLess(
            damaged['active_plan_snapshot']['plan_a']['target_in_laps'],
            clean['active_plan_snapshot']['plan_a']['target_in_laps'],
            'the recalculation must change the plan, not just log it')

    def test_recalculation_record_is_written(self):
        state = self.srs.init_state()
        state, _ = self.run_one(state, recent_pace_s=109.4)
        record = state['last_recalculation']
        self.assertEqual(record['reason'], 'driver_reported_damage')
        self.assertEqual(record['recent_fuel_l_per_lap'], 3.5)
        self.assertEqual(record['recent_pace_s'], 109.4)

    def test_trigger_is_consumed_so_it_fires_once(self):
        state = self.srs.init_state()
        state, _ = self.run_one(state)
        self.assertFalse(self.srs.should_recalculate(
            state, 'driver_reported_damage', dedupe_key='k1'))

    def test_baseline_override_only_applies_when_given(self):
        state = self.srs.init_state()
        state, _ = self.run_one(state, reason='clean_3_laps_established',
                                baseline_fuel_override=3.55,
                                baseline_pace_override=108.4)
        self.assertEqual(state['baseline_fuel_l_per_lap'], 3.55)
        self.assertEqual(state['baseline_pace_s'], 108.4)

    def test_insufficient_inputs_keep_the_previous_active_plan(self):
        state = self.srs.init_state()
        state, _ = self.run_one(state)
        before = state['active_plan_snapshot']
        state, verdict = self.bridge.execute_recalculation(
            state, {'reason': 'fuel_deviation', 'dedupe_key': 'k2',
                    'driver_message': None},
            inputs=self.live_inputs(recent_fuel_per_lap_l=None),
            srs_mod=self.srs, options_mod=so)
        self.assertFalse(verdict['available'])
        self.assertIs(state['active_plan_snapshot'], before,
                      'a failed rebuild must not wipe the standing plan')

    def test_plan_c_needs_every_condition_here_too(self):
        state = self.srs.init_state()
        _, without = self.run_one(state, fuel_save_recent_l_per_lap=3.0,
                                  rival_pitted_first=True, clean_air=True)
        self.assertNotEqual(without['selected_plan'], 'C')
        _, with_all = self.run_one(state, fuel_save_recent_l_per_lap=3.0,
                                   rival_pitted_first=True, clean_air=True,
                                   rejoin_not_worse=True)
        self.assertEqual(with_all['selected_plan'], 'C')


class RecalculationQueue(unittest.TestCase):
    """#2 — トリガー検出とPlan再計算の実行を分けた待ち行列の挙動。"""

    @classmethod
    def setUpClass(cls):
        import bridge as bridge_mod
        cls.bridge = bridge_mod

    def test_items_are_queued_in_order(self):
        q = self.bridge.queue_recalculation([], reason='a', dedupe_key='1')
        q = self.bridge.queue_recalculation(q, reason='b', dedupe_key='2')
        self.assertEqual([i['reason'] for i in q], ['a', 'b'])

    def test_same_trigger_is_not_queued_twice(self):
        q = self.bridge.queue_recalculation([], reason='a', dedupe_key='1')
        q = self.bridge.queue_recalculation(q, reason='a', dedupe_key='1')
        self.assertEqual(len(q), 1)

    def test_same_reason_different_instance_is_queued(self):
        q = self.bridge.queue_recalculation([], reason='a', dedupe_key='1')
        q = self.bridge.queue_recalculation(q, reason='a', dedupe_key='2')
        self.assertEqual(len(q), 2)

    def test_queue_is_not_mutated_in_place(self):
        original = []
        self.bridge.queue_recalculation(original, reason='a', dedupe_key='1')
        self.assertEqual(original, [])

    def test_message_and_payload_are_carried(self):
        q = self.bridge.queue_recalculation(
            [], reason='driver_reported_damage', dedupe_key='1',
            driver_message='msg', broadcast_payload={'trigger': 'x'})
        self.assertEqual(q[0]['driver_message'], 'msg')
        self.assertEqual(q[0]['broadcast_payload'], {'trigger': 'x'})


if __name__ == '__main__':
    unittest.main(verbosity=2)


class PlanBUndercutContract(unittest.TestCase):
    """★Plan B定義の判断（2026-08-12）が要求する再生テスト。

    B は「単なる -1 lap」ではない。Fuel Window が開いた周を起点に、
    相対ペース優位と復帰の見通しが揃った時だけ成立する。
    """

    def options(self, **overrides):
        return long_stint_options(**overrides)

    def forecast(self, likely, worst):
        return {'available': True,
                'likely': {'position': likely},
                'worst': {'position': worst}}

    def decide(self, *, pace=None, now=None, ahead=None, options=None):
        return so.decide_at_plan_a(
            options or self.options(), current_lap=5, current_fuel_l=35.0,
            avg_fuel_per_lap_l=3.5,
            pit_now_forecast=now, pit_next_lap_forecast=ahead,
            relative_pace_advantage_s=pace)

    def test_fuel_window_is_earlier_than_the_baseline(self):
        options = self.options()
        self.assertTrue(options['plan_b']['fuel_window_open'])
        self.assertLess(options['plan_b']['target_in_laps'],
                        options['plan_a']['target_in_laps'])
        self.assertEqual(options['plan_b']['action'], 'undercut')

    def test_window_is_shut_while_the_tank_cannot_hold_the_finish(self):
        """早すぎる周は、必要給油が容量に収まらないのでUndercut候補ではない。"""
        tight = so.build_initial_plans(
            snapshot_id='s', current_lap=5, fuel_level_l=35.0,
            avg_fuel_per_lap_l=3.5, clean_laps_sampled=4,
            crossings_to_finish=20, reserve_l=0.5, effective_capacity_l=52.0)
        self.assertGreater(tight['fuel_window_open_in_laps'], 0,
                           'the window must not open before the tank can hold the finish')

    def test_early_window_without_pace_advantage_is_unavailable(self):
        verdict = self.decide(pace=0.0, now=self.forecast(4, 5),
                              ahead=self.forecast(4, 5))
        self.assertEqual(verdict['selected_plan'], 'A')
        self.assertIn('relative_pace_advantage',
                      verdict['plan_b_evidence']['conditions_failed'])

    def test_pace_advantage_but_blending_into_a_slow_pack_is_unavailable(self):
        # 早入れすると likely も worst も悪化する＝遅い集団へ沈む。
        verdict = self.decide(pace=0.8, now=self.forecast(8, 10),
                              ahead=self.forecast(4, 5))
        self.assertEqual(verdict['selected_plan'], 'A')
        self.assertIn('rejoin_clear',
                      verdict['plan_b_evidence']['conditions_failed'])

    def test_all_conditions_proven_selects_b_at_the_early_lap(self):
        options = self.options()
        verdict = self.decide(pace=0.8, now=self.forecast(3, 4),
                              ahead=self.forecast(4, 5), options=options)
        self.assertEqual(verdict['selected_plan'], 'B')
        self.assertTrue(verdict['plan_b_evidence']['available'])
        self.assertEqual(verdict['plan_b_evidence']['conditions_failed'], [])
        self.assertLess(options['plan_b']['target_in_laps'],
                        options['plan_a']['target_in_laps'],
                        'the selected undercut must be the earlier stop')

    def test_unknown_pace_or_rejoin_is_not_satisfied(self):
        verdict = self.decide(pace=None, now=None, ahead=None)
        self.assertEqual(verdict['selected_plan'], 'A')
        failed = verdict['plan_b_evidence']['conditions_failed']
        self.assertIn('relative_pace_advantage', failed)
        self.assertIn('rejoin_clear', failed)

    def test_marginal_pace_advantage_does_not_qualify(self):
        verdict = self.decide(pace=so.PLAN_B_MIN_PACE_ADVANTAGE_S - 0.01,
                              now=self.forecast(3, 4), ahead=self.forecast(4, 5))
        self.assertEqual(verdict['selected_plan'], 'A')

    def test_no_undercut_room_is_reported(self):
        """ウインドウが基準以降にしか開かないなら、そもそも早入れできない。"""
        cramped = so.build_initial_plans(
            snapshot_id='s', current_lap=3, fuel_level_l=18.0,
            avg_fuel_per_lap_l=3.5, clean_laps_sampled=3,
            crossings_to_finish=8, reserve_l=0.5, effective_capacity_l=24.0)
        self.assertFalse(cramped['plan_b']['fuel_window_open'])
        verdict = so.decide_at_plan_a(
            cramped, current_lap=3, current_fuel_l=18.0, avg_fuel_per_lap_l=3.5,
            pit_now_forecast=None, pit_next_lap_forecast=None,
            relative_pace_advantage_s=2.0)
        self.assertEqual(verdict['selected_plan'], 'A')

    def test_reevaluation_selects_b_with_full_evidence(self):
        result = so.reevaluate_plans(
            previous=None, snapshot_id='recalc:b', trigger_reason='fuel_deviation',
            current_lap=5, fuel_level_l=35.0, recent_fuel_per_lap_l=3.5,
            clean_laps_sampled=4, crossings_to_finish=20, reserve_l=0.5,
            effective_capacity_l=60.0,
            pit_now_forecast=self.forecast(3, 4),
            pit_next_lap_forecast=self.forecast(4, 5),
            relative_pace_advantage_s=0.8)
        self.assertEqual(result['selected_plan'], 'B')
        self.assertTrue(result['options']['plan_b']['available'])
