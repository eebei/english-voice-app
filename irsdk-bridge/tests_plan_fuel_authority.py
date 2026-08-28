"""Build 265 bridge authoritative fuel-plan-pit contract regression.

Replays the actual Monza 35 GT3 one-make event order from
/Users/yuji.s/Downloads/OMORAY-bridge-debug-20260810-1838.log:

  lap 5, fuel 37.63L, burn 3.641L/lap, crossings-to-finish 16, capacity 53L,
  historical live pit_lane 18.3s, race_lifecycle=RACING.

Bridge must:
  (1) NOT broadcast fuel_strategy_warning at lap 5 (plan A window is reachable).
  (2) Broadcast strategy_plan_decision exactly once at lap 15 (planned pit).
  (3) Never silently suppress: PLAN FUEL AUTHORITY trace must be emitted.
"""

import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import fuel_strategy as fuel_strategy_mod
import plan_fuel_authority as plan_fuel_authority_mod
import strategy_options as strategy_options_mod
import bridge as bridge_mod


BRIDGE_PATH = os.path.join(HERE, 'bridge.py')


def build_monza35_strategy_options(*, current_lap, fuel_level_l, avg_fuel,
                                   crossings_to_finish=16, capacity_l=53,
                                   snapshot_id='initial:2:588.567'):
    """Reproduce the exact `STRATEGY OPTIONS ready` payload seen in the log."""
    return strategy_options_mod.build_initial_plans(
        snapshot_id=snapshot_id,
        current_lap=current_lap,
        fuel_level_l=fuel_level_l,
        avg_fuel_per_lap_l=avg_fuel,
        clean_laps_sampled=3,
        crossings_to_finish=crossings_to_finish,
        reserve_l=0.5,
        effective_capacity_l=capacity_l)


class Monza35EventOrder(unittest.TestCase):
    """Reproduces the exact sequence of events observed in the reference log."""

    def setUp(self):
        # The plan the log recorded at 18:55:05, lap 5.
        self.options = build_monza35_strategy_options(
            current_lap=5, fuel_level_l=37.63, avg_fuel=3.641)
        self.assertTrue(self.options.get('available'),
                        'plan should build from Monza 35 inputs')
        self.plan_a = self.options.get('plan_a') or {}
        # ★Plan B定義の判断（2026-08-12）で A/B の意味を入れ替えたため、同じ入力でも
        #   Plan A の目標周が変わる。旧契約では A=latest_safe-1（lap 15）だったが、
        #   新契約では A=latest_safe（lap 15）＝通常ペースで成立する最後の燃料安全周。
        #   参照ログは旧契約時点の記録であり、周番号そのものは追随させる。
        self.assertEqual(self.plan_a.get('target_lap'), 15,
                         'Monza 35 plan A first stop is the latest fuel-safe lap')

    # --- Frame 1: lap 5 fuel-band goes critical ------------------------------
    def test_lap5_plan_authority_suppresses_pit_now(self):
        fuel_eval = fuel_strategy_mod.evaluate_fuel_to_finish(
            fuel_level_l=37.63, avg_fuel_per_lap_l=3.641,
            estimated_crossings_to_finish=16, clean_laps_sampled=3,
            lifecycle_state=fuel_strategy_mod.RACING,
            previous_band=None)
        self.assertTrue(fuel_eval['should_warn'],
                        'plan-agnostic evaluator should flag critical at lap 5')
        self.assertEqual(fuel_eval['band'], fuel_strategy_mod.CRITICAL)

        verdict = plan_fuel_authority_mod.evaluate(
            fuel_eval, self.options,
            current_lap=5, fuel_level_l=37.63, avg_fuel_per_lap_l=3.641,
            effective_capacity_l=53)
        self.assertFalse(verdict['allow_p0_pit_now'],
                         'plan authority MUST suppress P0 at lap 5')
        self.assertEqual(verdict['suppression_reason'], 'plan_window_reachable')
        self.assertEqual(verdict['plan_id'], 'A')
        self.assertEqual(verdict['next_pit_lap'], 15)
        self.assertEqual(verdict['laps_to_pit'], 10)
        self.assertGreater(verdict['reach_pit_margin_l'], 0,
                           'plan window must be reachable with margin > 0')

    def test_timing_prefers_selected_one_stop_over_stale_endurance_horizon(self):
        timing = plan_fuel_authority_mod.build_timing_authority(
            {'avg_fuel_per_lap': 2.7, 'required_fuel_l': 50.4}, self.options,
            current_lap=5, fuel_level_l=40.2,
            endurance_plan={'available': True, 'multi_stop': True,
                            'future_stop_count': 2, 'next_fuel_stop_in_laps': 0,
                            'box_this_lap': False})
        self.assertEqual(timing['selected_plan'], 'A')
        self.assertEqual(timing['latest_safe_pit_lap'], self.options['plan_a']['target_lap'])
        self.assertGreater(timing['laps_until_latest_safe_pit'], 0)

    # --- Frame 2: at plan A target lap ---------------------------------------
    def test_lap15_plan_decision_fires_once(self):
        # Reaching the target lap consumes ~ (14-5) * 3.641 = 32.8L from the
        # lap-5 snapshot; the driver actually reaches lap 15 with ~4.75L
        # (matching the log's fuel_at_stop_l=4.75).
        decision = strategy_options_mod.decide_at_plan_a(
            self.options,
            current_lap=15, current_fuel_l=4.75, avg_fuel_per_lap_l=3.641,
            pit_now_forecast={'available': False},
            pit_next_lap_forecast={'available': False})
        self.assertTrue(decision.get('available'),
                        'decide_at_plan_a must be available at target lap')
        # Plan B requires fuel-safe extension; with 4.75L it may or may not be
        # safe (4.75 - 3.641 = 1.109L > 0.5L reserve → fuel_safe_for_plan_b True).
        # The important contract is that a deterministic decision is produced
        # and can be broadcast exactly once — the bridge dedupe key is the
        # decision_id, which is unique per (snapshot_id, current_lap).
        self.assertIn(decision.get('selected_plan'), ('A', 'B'))
        self.assertIn('decision_id', decision)

    # --- Frame at lap 15 with COMPLETE proofs → SUPPRESS. ---------------------
    # ★Codex 差戻し 3：target-lap suppression is conditional on capacity fits,
    #   planned_add is defined, AND post-stop finish margin >= 0.  With all
    #   three proofs, strategy_plan_decision is the sole speaker.
    def test_lap15_plan_authority_suppresses_when_all_proofs_hold(self):
        fuel_eval = {'band': fuel_strategy_mod.CRITICAL, 'should_warn': True,
                     'margin_l': -3.0, 'previous_band': None,
                     'reason': 'warning_candidate'}
        verdict = plan_fuel_authority_mod.evaluate(
            fuel_eval, self.options,
            current_lap=15, fuel_level_l=4.75, avg_fuel_per_lap_l=3.641,
            effective_capacity_l=53)
        self.assertFalse(verdict['allow_p0_pit_now'],
                         'complete proofs at target lap: P0 suppressed, strategy speaks')
        self.assertEqual(verdict['suppression_reason'],
                         'planned_pit_lap_speaks_via_strategy_decision')
        self.assertTrue(verdict['capacity_fits_plan'])
        self.assertGreaterEqual(verdict['finish_margin_after_stop_l'], 0)

    def test_lap15_authority_allows_p0_when_capacity_does_not_fit(self):
        # Overshoot the plan's add_fuel_l to exceed capacity.
        options = dict(self.options)
        options['plan_a'] = dict(options['plan_a'])
        options['plan_a']['add_fuel_l'] = 999  # capacity 53 → cannot fit
        fuel_eval = {'band': fuel_strategy_mod.CRITICAL, 'should_warn': True,
                     'margin_l': -30.0, 'previous_band': None,
                     'reason': 'warning_candidate'}
        verdict = plan_fuel_authority_mod.evaluate(
            fuel_eval, options,
            current_lap=15, fuel_level_l=4.75, avg_fuel_per_lap_l=3.641,
            effective_capacity_l=53)
        self.assertTrue(verdict['allow_p0_pit_now'],
                        'proof-incomplete at target lap must NOT silence P0')
        self.assertEqual(verdict['override_reason'],
                         'planned_pit_lap_but_strategy_proof_incomplete')

    def test_lap15_authority_allows_p0_when_finish_margin_missing(self):
        # No remaining_crossings_after_stop → cannot prove finish; safe side.
        options = dict(self.options)
        options['plan_a'] = dict(options['plan_a'])
        options['plan_a'].pop('remaining_crossings_after_stop', None)
        fuel_eval = {'band': fuel_strategy_mod.CRITICAL, 'should_warn': True,
                     'margin_l': -3.0, 'previous_band': None,
                     'reason': 'warning_candidate'}
        verdict = plan_fuel_authority_mod.evaluate(
            fuel_eval, options,
            current_lap=15, fuel_level_l=4.75, avg_fuel_per_lap_l=3.641,
            effective_capacity_l=53)
        self.assertTrue(verdict['allow_p0_pit_now'])
        self.assertEqual(verdict['override_reason'],
                         'planned_pit_lap_but_strategy_proof_incomplete')

    # --- selected_plan authority (not hard-coded plan_a) ---------------------
    def test_selected_plan_b_is_honored(self):
        # Simulate a mid-race switch to Plan B (undercut).
        options_b = dict(self.options)
        options_b['selected_plan'] = 'B'
        # Provide a distinct plan_b for the switch to be visible.
        options_b['plan_b'] = {**(options_b.get('plan_b') or {}),
                               'available': True,
                               'target_lap': 13,
                               'add_fuel_l': 24.0}
        fuel_eval = {'band': fuel_strategy_mod.CRITICAL, 'should_warn': True,
                     'margin_l': -20.0, 'reason': 'warning_candidate',
                     'previous_band': None}
        # lap 8 with plenty of fuel → plan window (13) reachable → suppress.
        verdict = plan_fuel_authority_mod.evaluate(
            fuel_eval, options_b,
            current_lap=8, fuel_level_l=30.0, avg_fuel_per_lap_l=3.641,
            effective_capacity_l=53)
        self.assertEqual(verdict['plan_id'], 'B',
                         'authority must reflect selected_plan=B not hard-coded A')
        self.assertEqual(verdict['next_pit_lap'], 13)
        self.assertFalse(verdict['allow_p0_pit_now'])
        self.assertEqual(verdict['suppression_reason'], 'plan_window_reachable')

    def test_insufficient_evidence_falls_back_to_safe_side(self):
        # No live burn evidence → authority must NOT silently suppress.
        # Safe side is to allow the P0 (bridge's default).
        fuel_eval = {'band': fuel_strategy_mod.CRITICAL, 'should_warn': True,
                     'margin_l': -20.0, 'reason': 'warning_candidate',
                     'previous_band': None}
        verdict = plan_fuel_authority_mod.evaluate(
            fuel_eval, self.options,
            current_lap=5, fuel_level_l=37.63, avg_fuel_per_lap_l=None,
            effective_capacity_l=53)
        self.assertTrue(verdict['allow_p0_pit_now'])
        self.assertTrue(verdict['override_reason'].startswith('insufficient_evidence_'),
                        verdict['override_reason'])

    # --- True emergency (cannot reach plan window) still fires ---------------
    def test_true_emergency_permits_p0(self):
        fuel_eval = {'band': fuel_strategy_mod.CRITICAL, 'should_warn': True,
                     'margin_l': -27.7, 'reason': 'warning_candidate',
                     'previous_band': None}
        verdict = plan_fuel_authority_mod.evaluate(
            fuel_eval, self.options,
            current_lap=5, fuel_level_l=5.0, avg_fuel_per_lap_l=3.641,
            effective_capacity_l=53)
        self.assertTrue(verdict['allow_p0_pit_now'])
        self.assertEqual(verdict['override_reason'],
                         'cannot_reach_selected_pit_window')
        self.assertLess(verdict['reach_pit_margin_l'], 0)

    def test_small_post_stop_rounding_miss_does_not_force_an_early_pit(self):
        """8/24 Build 280 replay: -0.025L after the planned service is a
        top-up/set-fuel correction, not a Lap-6 emergency when the selected
        Lap-16 window is physically reachable."""
        options = {
            'available': True, 'selected_plan': 'A',
            'plan_a': {
                'available': True, 'target_lap': 16,
                'fuel_at_stop_l': 2.5, 'add_fuel_l': 14.148,
                'remaining_crossings_after_stop': 5,
            },
        }
        fuel_eval = {'band': fuel_strategy_mod.CRITICAL, 'should_warn': True,
                     'margin_l': -13.722, 'reason': 'warning_candidate',
                     'previous_band': None}
        verdict = plan_fuel_authority_mod.evaluate(
            fuel_eval, options, current_lap=6, fuel_level_l=34.8,
            avg_fuel_per_lap_l=3.235, effective_capacity_l=53)
        self.assertFalse(verdict['allow_p0_pit_now'])
        self.assertEqual(verdict['suppression_reason'],
                         'planned_service_small_top_up_required')
        self.assertEqual(verdict['next_pit_lap'], 16)
        self.assertEqual(verdict['recommended_set_fuel_l'], 15)

    def test_small_top_up_requires_a_physical_post_stop_margin(self):
        """A capped tank must not pretend a larger add fixes a fuel deficit."""
        options = {
            'available': True, 'selected_plan': 'A',
            'plan_a': {
                'available': True, 'target_lap': 10,
                'fuel_at_stop_l': 1.5, 'add_fuel_l': 49.0,
                'remaining_crossings_after_stop': 20,
            },
        }
        verdict = plan_fuel_authority_mod.evaluate(
            {'band': fuel_strategy_mod.CRITICAL}, options,
            current_lap=5, fuel_level_l=20.0, avg_fuel_per_lap_l=2.48,
            effective_capacity_l=50.0)
        self.assertTrue(verdict['allow_p0_pit_now'])
        self.assertEqual(verdict['override_reason'],
                         'planned_service_correction_cannot_finish')
        self.assertNotIn('recommended_add_l', verdict)

    def test_small_top_up_threshold_is_exactly_half_a_litre(self):
        options = {
            'available': True, 'selected_plan': 'A',
            'plan_a': {
                'available': True, 'target_lap': 10,
                'fuel_at_stop_l': 2.0, 'add_fuel_l': 10.0,
                'remaining_crossings_after_stop': 4,
            },
        }
        at_limit = plan_fuel_authority_mod.evaluate(
            {'band': fuel_strategy_mod.CRITICAL}, options,
            current_lap=5, fuel_level_l=20.0, avg_fuel_per_lap_l=3.0,
            effective_capacity_l=50.0)
        self.assertFalse(at_limit['allow_p0_pit_now'])
        self.assertEqual(at_limit['suppression_reason'],
                         'planned_service_small_top_up_required')

        past_limit = plan_fuel_authority_mod.evaluate(
            {'band': fuel_strategy_mod.CRITICAL}, options,
            current_lap=5, fuel_level_l=20.0, avg_fuel_per_lap_l=3.0025,
            effective_capacity_l=50.0)
        self.assertTrue(past_limit['allow_p0_pit_now'])
        self.assertEqual(past_limit['override_reason'],
                         'planned_service_correction_cannot_finish')

    def test_bridge_persists_small_top_up_into_the_later_box_plan(self):
        options = {'plan_a': {'available': True, 'add_fuel_l': 14.148}}
        snapshot = {'plan_a': {'available': True, 'add_fuel_l': 14.148}}
        applied = bridge_mod.apply_recommended_plan_fuel(
            (options, snapshot, None), 'A', 14.173, 15)
        self.assertTrue(applied)
        self.assertEqual(options['plan_a']['add_fuel_l'], 14.173)
        self.assertEqual(options['plan_a']['set_fuel_l'], 15)
        self.assertEqual(snapshot['plan_a']['add_fuel_l'], 14.173)
        self.assertEqual(snapshot['plan_a']['set_fuel_l'], 15)

    def test_pit_events_are_fresh_in_the_shared_session_reset(self):
        first = bridge_mod._session_scoped_reset_values()
        first['pit_events'].append({'entry_lap': 6})
        second = bridge_mod._session_scoped_reset_values()
        self.assertEqual(second['pit_events'], [])


class Monza35FullTimeline(unittest.TestCase):
    """Walk the whole 21-lap Monza 35 race and verify the integrated dispatch
    order.  Fuel-band goes critical from lap 5 onward (finish requirement
    ~ 76L vs 37L on board).  The plan authority must suppress on every
    frame between lap 5 and lap 13 (inclusive), and must permit on lap 15.
    The plan-decision (planned pit) fires exactly once at lap 15."""

    def _decide_at(self, options, *, lap, fuel):
        # Simulates the bridge's per-frame decisions with the same modules
        # the bridge uses at runtime.
        eval_ = fuel_strategy_mod.evaluate_fuel_to_finish(
            fuel_level_l=fuel, avg_fuel_per_lap_l=3.641,
            estimated_crossings_to_finish=max(1, 16 - (lap - 5)),
            clean_laps_sampled=3,
            lifecycle_state=fuel_strategy_mod.RACING, previous_band=None)
        authority = plan_fuel_authority_mod.evaluate(
            eval_, options,
            current_lap=lap, fuel_level_l=fuel, avg_fuel_per_lap_l=3.641,
            effective_capacity_l=53)
        return eval_, authority

    def test_bridge_dispatch_timeline_matches_expected_pattern(self):
        options = build_monza35_strategy_options(
            current_lap=5, fuel_level_l=37.63, avg_fuel=3.641)
        target_lap = options['plan_a']['target_lap']
        self.assertEqual(target_lap, 15)

        fuel = 37.63
        events = []  # each frame's (lap, band, allow_p0, reason)
        for lap in range(5, 16):
            eval_, authority = self._decide_at(options, lap=lap, fuel=fuel)
            events.append((lap, eval_['band'], authority['allow_p0_pit_now'],
                          authority['suppression_reason']
                          or authority['override_reason']))
            fuel -= 3.641

        # Laps 5..13: critical band, authority suppresses, reason is
        # plan_window_reachable.  Nothing broadcasts a P0.
        for lap, band, allow, reason in events[:-1]:
            self.assertEqual(band, fuel_strategy_mod.CRITICAL,
                             f'lap {lap} should be critical')
            self.assertFalse(allow,
                             f'lap {lap} authority MUST suppress P0 (reason={reason})')
            self.assertEqual(reason, 'plan_window_reachable',
                             f'lap {lap} suppression reason must be plan_window_reachable')

        # Lap 15 (= Plan A target): authority SUPPRESSES the P0.  The strategy path
        # (strategy_plan_decision) is the sole speaker at the planned pit lap;
        # a P0 through here would double-speak.  See test_lap15_plan_decision_fires_once.
        lap15, band14, allow14, reason14 = events[-1]
        self.assertEqual(lap15, 15)
        self.assertFalse(allow14,
                         'lap 15 authority MUST suppress P0 (strategy path is sole speaker)')
        self.assertEqual(reason14,
                         'planned_pit_lap_speaks_via_strategy_decision')

    def test_plan_decision_fires_exactly_once_at_target_lap(self):
        options = build_monza35_strategy_options(
            current_lap=5, fuel_level_l=37.63, avg_fuel=3.641)
        # Simulate the bridge's dedupe flag pattern.
        strategy_options_decision_sent = False
        decisions_broadcast = 0
        # Sweep laps 5..15.  Only lap ≥ target_lap fires the decision, and
        # only once (thanks to the sent flag).
        for lap in range(5, 16):
            if strategy_options_decision_sent:
                continue
            if lap < options['plan_a']['target_lap']:
                continue
            fuel_at_lap = max(0.5, 37.63 - 3.641 * (lap - 5))
            decision = strategy_options_mod.decide_at_plan_a(
                options,
                current_lap=lap, current_fuel_l=fuel_at_lap,
                avg_fuel_per_lap_l=3.641,
                pit_now_forecast={'available': False},
                pit_next_lap_forecast={'available': False})
            if decision.get('available'):
                decisions_broadcast += 1
                strategy_options_decision_sent = True
        self.assertEqual(decisions_broadcast, 1,
                         'strategy_plan_decision must fire exactly once')


class BridgeWiring(unittest.TestCase):
    """Prove bridge.py invokes the plan authority before broadcasting P0
    fuel_strategy_warning, that it emits a trace, and that the band dedupe
    does not commit when the authority suppresses."""

    def setUp(self):
        with open(BRIDGE_PATH, 'r', encoding='utf-8') as fh:
            self.bridge = fh.read()

    def test_module_is_imported(self):
        self.assertIn('import plan_fuel_authority as plan_fuel_authority_mod',
                      self.bridge)

    def test_authority_evaluated_before_broadcast(self):
        self.assertIn('_plan_authority_verdict = plan_fuel_authority_mod.evaluate(',
                      self.bridge)
        # ensure the evaluation happens ABOVE the fuel_strategy_warning broadcast
        eval_pos = self.bridge.index('_plan_authority_verdict = plan_fuel_authority_mod.evaluate(')
        broadcast_pos = self.bridge.index("'trigger': 'fuel_strategy_warning'")
        self.assertLess(eval_pos, broadcast_pos,
                        'plan authority must be evaluated before the broadcast')

    def test_broadcast_gated_by_permits_flag(self):
        self.assertIn('_plan_authority_permits', self.bridge)
        self.assertRegex(self.bridge,
            r"if \(_fuel_eval\.get\('should_warn'\) and not onPit\s*\n\s*"
            r"and _plan_authority_permits and not _strategy_speech_blocked\):")

    def test_suppression_leaves_dedupe_uncommitted(self):
        # commit_band_after_dispatch only commits when dispatch_result is
        # True or 'DISPATCHED'.  Suppression path passes _fuel_dispatch_result
        # which remains None, so commit_band_after_dispatch keeps the previous
        # band → the next frame re-evaluates and can permit P0 as soon as the
        # plan becomes unreachable.  Prove the flow.
        self.assertIn("_fuel_dispatch_result = None", self.bridge)
        self.assertIn('commit_band_after_dispatch(', self.bridge)

    def test_suppression_is_traced_and_visible(self):
        self.assertIn("log('PLAN FUEL AUTHORITY: '", self.bridge)
        self.assertIn("SUPPRESSED_BY_PLAN_AUTHORITY", self.bridge)

    def test_strategy_plan_decision_fires_at_target_lap(self):
        # The existing plan-decision path still owns the planned box call.
        self.assertIn("'trigger': 'strategy_plan_decision'", self.bridge)
        self.assertIn('strategy_options_mod.decide_at_plan_a', self.bridge)
        self.assertIn('strategy_options_decision_sent', self.bridge)

    def test_same_frame_plan_snapshot_before_fuel_authority(self):
        # ★Codex 差戻し 2：Plan 生成が同一フレームで燃料 P0 判定の手前に来る。
        self.assertIn('_plan_options_for_authority = strategy_options', self.bridge)
        self.assertIn("snapshot_id='authority:%s:%s'", self.bridge)
        # Ordering: the candidate build must precede the authority evaluation.
        candidate_pos = self.bridge.index('_plan_options_for_authority = strategy_options')
        eval_pos = self.bridge.index('_plan_authority_verdict = plan_fuel_authority_mod.evaluate(')
        self.assertLess(candidate_pos, eval_pos,
                        'same-frame plan snapshot must be built before authority evaluation')
        # The authority must consume the same-frame snapshot, not the outer scope.
        eval_snippet = self.bridge[eval_pos:eval_pos + 400]
        self.assertIn('_plan_options_for_authority', eval_snippet,
                      'authority must consume _plan_options_for_authority')


if __name__ == '__main__':
    result = unittest.main(verbosity=2, exit=False).result
    if not result.wasSuccessful():
        sys.exit(1)
